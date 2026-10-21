'use strict';

const fs = require('node:fs');
const path = require('node:path');
const supabase = require('./supabase');
const { canonicalHash, databaseCompanyId } = require('./transactional-repository');
const {
  createPortableBackup,
  verifyPortableBackup,
  readVerifiedTenantObjects,
  loadAuthoritativeTenantSnapshot,
  isMissingStorageObjectError,
  digest
} = require('./portable-backup');

function option(argv, name) {
  const index = argv.indexOf(name);
  if (index < 0) return '';
  const value = String(argv[index + 1] || '').trim();
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value.`);
  return value;
}

function revision(value, label = 'revision') {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`${label} must be a non-negative integer.`);
  return number;
}

function parseArgs(argv = process.argv.slice(2)) {
  const command = String(argv[0] || '').trim();
  if (!['export', 'verify', 'restore-preview', 'restore'].includes(command)) throw new Error('Choose one command: export, verify, restore-preview, or restore.');
  const rawCompanyId = option(argv, '--company-id');
  if (!rawCompanyId) throw new Error(`${command} requires --company-id <tenant-uuid>.`);
  const companyId = databaseCompanyId(rawCompanyId);
  if (companyId !== rawCompanyId.toLowerCase()) throw new Error('Recovery requires the tenant database UUID, not a legacy alias.');
  const output = option(argv, '--output');
  const backup = option(argv, '--backup');
  const preRestoreOutput = option(argv, '--pre-restore-output');
  const expectedRaw = option(argv, '--expected-revision');
  const confirmation = option(argv, '--confirm-company-id');
  const expectedManifestSha256 = option(argv, '--expected-manifest-sha256').toLowerCase();
  const apply = argv.includes('--apply');
  if (command === 'export' && !output) throw new Error('export requires --output <independent-directory>.');
  if (command !== 'export' && !backup) throw new Error(`${command} requires --backup <backup-directory>.`);
  if (['restore-preview', 'restore'].includes(command) && !/^[a-f0-9]{64}$/.test(expectedManifestSha256)) {
    throw new Error(`${command} requires --expected-manifest-sha256 <independently-recorded-sha256>.`);
  }
  if (command === 'restore') {
    if (!apply) throw new Error('Refusing a tenant restore without --apply. Use restore-preview first.');
    if (!expectedRaw) throw new Error('restore requires --expected-revision <current-revision>.');
    if (!preRestoreOutput) throw new Error('restore requires --pre-restore-output <independent-directory> for rollback evidence.');
    if (confirmation.toLowerCase() !== companyId) throw new Error('restore requires --confirm-company-id matching the exact tenant UUID.');
  }
  if (apply && command !== 'restore') throw new Error('--apply is only valid with restore.');
  return { command, companyId, output, backup, preRestoreOutput, apply, expectedRevision: expectedRaw ? revision(expectedRaw, 'expected revision') : null, expectedManifestSha256 };
}

function assertRestorableSource(verified, expectedManifestSha256) {
  if (verified.manifestSha256 !== String(expectedManifestSha256 || '').toLowerCase()) {
    throw new Error('Tenant backup manifest does not match the independently recorded SHA-256.');
  }
  if (verified.authority?.mode !== 'transactional-primary' || !Number.isSafeInteger(Number(verified.authority?.repositoryRevision))) {
    throw new Error('Tenant restore source is not an authoritative transactional-primary export.');
  }
}

function repository() {
  if (!supabase.configured()) throw new Error('Server-side Supabase configuration is missing.');
  return {
    load: companyId => supabase.loadTransactionalSnapshot(companyId),
    save: (snapshot, { expectedRevision }) => supabase.saveTransactionalSnapshot(snapshot, expectedRevision)
  };
}

function prepareTenantRestore(snapshot, restoredAt) {
  const restored = structuredClone(snapshot);
  restored.sessions = [];
  restored.users = (restored.users || []).map(user => {
    const clean = { ...user };
    for (const key of [
      'resetTokenHash', 'resetExpiresAt', 'resetRequestedAt',
      'setupHash', 'setupSalt', 'setupExpiresAt',
      'emailVerificationTokenHash', 'emailVerificationExpiresAt'
    ]) delete clean[key];
    return clean;
  });
  restored.subcontractorLinks = (restored.subcontractorLinks || []).map(link => {
    const clean = { ...link, status: 'Revoked', revokedAt: restoredAt, revokeReason: 'Tenant recovery safety revocation' };
    delete clean.tokenHash;
    return clean;
  });
  restored.changes = (restored.changes || []).map(change => {
    const clean = { ...change };
    if (clean.customerTokenHash || clean.customerLinkExpiresAt) clean.customerLinkRevokedAt = restoredAt;
    delete clean.customerTokenHash;
    delete clean.customerLinkExpiresAt;
    return clean;
  });
  if (restored.company) delete restored.company.pendingCheckout;
  return restored;
}

const storageObjectId = object => `${object.bucket}/${object.objectKey}`;
const isStorageConflictError = error => /(?:\b409\b|already exists|duplicate)/i.test(String(error?.message || error || ''));

async function readStorageObject(download, object) {
  try {
    const response = await download(object.bucket, object.objectKey);
    const data = Buffer.from(await response.arrayBuffer());
    return { exists: true, data, bytes: data.length, sha256: digest(data) };
  } catch (error) {
    if (isMissingStorageObjectError(error)) return { exists: false, data: null, bytes: 0, sha256: null };
    throw error;
  }
}

function matchesObject(state, object) {
  return Boolean(state?.exists && state.bytes === object.bytes && state.sha256 === object.sha256);
}

async function restoreTenantStorageObjects({ backupDirectory, verification, rollbackBackup, download, upload, journal = [] }) {
  const sourceObjects = readVerifiedTenantObjects(backupDirectory, verification);
  if (!sourceObjects.length) return { total: 0, created: 0, overwritten: 0, unchanged: 0, verified: 0, objects: [], journal };
  if (typeof download !== 'function' || typeof upload !== 'function') throw new Error('Tenant storage restore requires server-side download and upload adapters.');
  const rollbackObjects = readVerifiedTenantObjects(rollbackBackup.directory, rollbackBackup.verification, { allowMissing: true });
  const rollbackById = new Map(rollbackObjects.map(object => [storageObjectId(object), object]));
  const plan = [];
  for (const source of sourceObjects) {
    const id = storageObjectId(source), current = await readStorageObject(download, source);
    if (matchesObject(current, source)) plan.push({ id, action: 'unchanged', source, prior: current });
    else if (!current.exists) plan.push({ id, action: 'create', source, prior: current });
    else {
      const rollback = rollbackById.get(id);
      if (!rollback || rollback.missing || !matchesObject(current, rollback)) throw new Error(`Refusing to overwrite ${id}: its current bytes are not preserved in the verified pre-restore backup.`);
      plan.push({ id, action: 'overwrite', source, prior: current, rollback });
    }
  }
  for (const item of plan) {
    if (item.action === 'unchanged') continue;
    const immediatelyBefore = await readStorageObject(download, item.source);
    if (item.action === 'create' && immediatelyBefore.exists || item.action === 'overwrite' && !matchesObject(immediatelyBefore, item.prior)) {
      throw Object.assign(new Error(`Storage object changed during restore preflight: ${item.id}`), { storageJournal: journal });
    }
    try {
      await upload(item.source.bucket, item.source.objectKey, item.source.data, item.source.contentType, item.action === 'overwrite');
      journal.push(item);
    } catch (error) {
      if (item.action === 'create' && isStorageConflictError(error)) throw Object.assign(error, { storageJournal: journal });
      try {
        const afterFailure = await readStorageObject(download, item.source);
        const changed = item.action === 'create' ? afterFailure.exists : !matchesObject(afterFailure, item.prior);
        if (changed) journal.push(item);
      } catch (inspectionError) {
        error.storageOutcomeUnknown = item.id;
        error.storageInspectionError = inspectionError.message;
      }
      throw Object.assign(error, { storageJournal: journal });
    }
    if (!matchesObject(await readStorageObject(download, item.source), item.source)) throw Object.assign(new Error(`Storage restore verification failed for ${item.id}.`), { storageJournal: journal });
  }
  return {
    total: plan.length,
    created: plan.filter(item => item.action === 'create').length,
    overwritten: plan.filter(item => item.action === 'overwrite').length,
    unchanged: plan.filter(item => item.action === 'unchanged').length,
    verified: plan.length,
    objects: plan.map(item => ({ bucket: item.source.bucket, objectKey: item.source.objectKey, action: item.action, bytes: item.source.bytes, sha256: item.source.sha256 })),
    journal
  };
}

async function rollbackTenantStorageObjects(journal, { download, upload, remove }) {
  const failures = [];
  for (const item of [...journal].reverse()) {
    try {
      if (item.action === 'create') {
        if (typeof remove !== 'function') throw new Error('Storage remove adapter is unavailable.');
        await remove(item.source.bucket, item.source.objectKey);
        if ((await readStorageObject(download, item.source)).exists) throw new Error('new object still exists after removal');
      } else if (item.action === 'overwrite') {
        await upload(item.rollback.bucket, item.rollback.objectKey, item.rollback.data, item.rollback.contentType, true);
        if (!matchesObject(await readStorageObject(download, item.rollback), item.rollback)) throw new Error('prior object bytes did not reconcile');
      }
    } catch (error) { failures.push({ object: item.id, error: error.message }); }
  }
  return { ok: failures.length === 0, attempted: journal.length, failures };
}

function writeRestoreEvidence(directory, evidence) {
  const file = path.join(path.resolve(directory), 'restore-evidence.json');
  fs.writeFileSync(file, JSON.stringify(evidence, null, 2), { flag: 'wx', mode: 0o600 });
  return file;
}

async function execute(args, {
  repo = null,
  download = supabase.download,
  upload = supabase.upload,
  remove = supabase.remove,
  now = new Date()
} = {}) {
  const companyId = databaseCompanyId(args.companyId);
  if (args.command === 'restore' && !args.apply) throw new Error('Refusing a tenant restore without explicit apply authorization.');
  if (args.command === 'verify' || args.command === 'restore-preview') {
    const verified = verifyPortableBackup(path.resolve(args.backup), { expectedCompanyId: companyId });
    if (args.command === 'restore-preview') {
      assertRestorableSource(verified, args.expectedManifestSha256);
      readVerifiedTenantObjects(path.resolve(args.backup), verified);
    }
    return {
      mode: args.command,
      verified: true,
      companyId,
      sourceAuthority: verified.authority,
      manifestSha256: verified.manifestSha256,
      contentHash: verified.contentHash,
      objects: verified.objects,
      missingObjects: verified.missingObjects,
      complete: verified.missingObjects === 0,
      ...(args.command === 'restore-preview' ? { nextStep: 'Run restore with --apply, exact company confirmation, and the current transactional revision after change approval.', writesPerformed: false } : {})
    };
  }
  const store = repo || repository();
  if (args.command === 'export') {
    const current = repo ? await store.load(companyId) : await loadAuthoritativeTenantSnapshot(companyId);
    const snapshot = current?.snapshot;
    if (!snapshot) throw new Error(`Authoritative tenant not found: ${companyId}`);
    const authority = current.authority || { mode: 'transactional-primary', repositoryRevision: current.revision, contentHash: current.contentHash || canonicalHash(snapshot) };
    const backup = await createPortableBackup({ snapshot, authority, destination: path.resolve(args.output), download, now });
    return { mode: 'export', directory: backup.directory, companyId, authority: backup.manifest.authority, manifestSha256: backup.manifestSha256, objects: backup.manifest.objects.length, verified: backup.verification.ok };
  }

  const verified = verifyPortableBackup(path.resolve(args.backup), { expectedCompanyId: companyId });
  assertRestorableSource(verified, args.expectedManifestSha256);
  readVerifiedTenantObjects(path.resolve(args.backup), verified);
  const before = await store.load(companyId);
  const currentRevision = before?.revision ?? 0;
  if (currentRevision !== args.expectedRevision) throw new Error(`Restore precondition failed: expected current revision ${args.expectedRevision}, found ${currentRevision}.`);
  if (before?.snapshot && databaseCompanyId(before.snapshot.company?.id) !== companyId) throw new Error('Transactional repository returned the wrong tenant.');
  const rollbackSnapshot = before?.snapshot || { company: { id: companyId, name: 'Uninitialized restore target' } };
  const rollbackAuthority = before
    ? { mode: 'transactional-primary', repositoryRevision: before.revision, contentHash: canonicalHash(before.snapshot) }
    : { mode: 'pre-restore-uninitialized', repositoryRevision: 0, contentHash: canonicalHash(rollbackSnapshot) };
  const preRestoreBackup = await createPortableBackup({ snapshot: rollbackSnapshot, authority: rollbackAuthority, destination: path.resolve(args.preRestoreOutput), download, allowMissingObjects: true, now });
  const restoredSnapshot = prepareTenantRestore(verified.snapshot, verified.createdAt);
  const expectedHash = canonicalHash(restoredSnapshot);
  const alreadyRestored = Boolean(before && before.contentHash === expectedHash && canonicalHash(before.snapshot) === expectedHash);
  const storageJournal = [];
  let storage = null, saved = null, after = null, repositoryCommitted = alreadyRestored, repositoryOutcomeUnknown = false, evidenceFile = null;
  try {
    storage = await restoreTenantStorageObjects({ backupDirectory: path.resolve(args.backup), verification: verified, rollbackBackup: preRestoreBackup, download, upload, journal: storageJournal });
    if (alreadyRestored) saved = before;
    else {
      try {
        saved = await store.save(restoredSnapshot, { expectedRevision: args.expectedRevision });
        repositoryCommitted = true;
      } catch (saveError) {
        let observed = null, observedError = null;
        for (let attempt = 0; attempt < 3 && !observed; attempt += 1) {
          try { observed = await store.load(companyId); } catch (error) { observedError = error; }
        }
        if (observed && observed.revision > args.expectedRevision && observed.contentHash === expectedHash && canonicalHash(observed.snapshot) === expectedHash) {
          saved = observed;
          repositoryCommitted = true;
        } else if (!observed) {
          repositoryOutcomeUnknown = true;
          const uncertain = new Error(`Tenant repository commit outcome could not be verified; storage was retained for manual reconciliation. ${observedError?.message || saveError.message}`);
          uncertain.cause = saveError;
          throw uncertain;
        } else throw saveError;
      }
    }
    after = await store.load(companyId);
    if (!after || after.revision !== saved.revision || after.contentHash !== expectedHash || canonicalHash(after.snapshot) !== expectedHash) throw new Error('Tenant restore reconciliation failed after the transactional write.');
    evidenceFile = writeRestoreEvidence(preRestoreBackup.directory, {
      version: 1,
      status: 'verified',
      completedAt: now.toISOString(),
      companyId,
      sourceManifestSha256: verified.manifestSha256,
      sourceAuthority: verified.authority,
      priorRevision: currentRevision,
      restoredRevision: after.revision,
      restoredContentHash: after.contentHash,
      alreadyRestored,
      storage: { total: storage.total, created: storage.created, overwritten: storage.overwritten, unchanged: storage.unchanged, verified: storage.verified, objects: storage.objects },
      preRestoreManifestSha256: preRestoreBackup.manifestSha256,
      preRestoreMissingObjects: preRestoreBackup.verification.missingObjects
    });
  } catch (error) {
    let rollback = { ok: true, attempted: 0, failures: [] };
    const unknownStorage = error.storageOutcomeUnknown ? [{ object: error.storageOutcomeUnknown, error: `upload outcome could not be inspected: ${error.storageInspectionError || 'provider unavailable'}` }] : [];
    if (!repositoryCommitted && !repositoryOutcomeUnknown && storageJournal.length) rollback = await rollbackTenantStorageObjects(storageJournal, { download, upload, remove });
    if (repositoryOutcomeUnknown) rollback = { ok: false, attempted: 0, failures: [{ object: 'tenant-repository', error: 'commit outcome is unknown; storage intentionally retained' }] };
    else if (unknownStorage.length) rollback = { ...rollback, ok: false, failures: [...rollback.failures, ...unknownStorage] };
    try {
      evidenceFile = writeRestoreEvidence(preRestoreBackup.directory, {
        version: 1,
        status: repositoryCommitted ? 'repository-committed-reconciliation-failed' : repositoryOutcomeUnknown ? 'repository-outcome-unknown' : 'failed-before-repository-commit',
        completedAt: now.toISOString(),
        companyId,
        sourceManifestSha256: verified.manifestSha256,
        priorRevision: currentRevision,
        repositoryCommitted,
        repositoryOutcomeUnknown,
        storageWrites: storageJournal.map(item => ({ bucket: item.source.bucket, objectKey: item.source.objectKey, action: item.action, bytes: item.source.bytes, sha256: item.source.sha256 })),
        storageRollback: rollback,
        error: String(error.message || error).slice(0, 1000),
        preRestoreManifestSha256: preRestoreBackup.manifestSha256
      });
    } catch (evidenceError) { error.message += ` Recovery evidence write also failed: ${evidenceError.message}`; }
    if (!rollback.ok) {
      const rollbackError = new Error(`Tenant restore failed and storage rollback was incomplete: ${rollback.failures.map(item => `${item.object}: ${item.error}`).join('; ')}`);
      rollbackError.cause = error;
      rollbackError.evidenceFile = evidenceFile;
      throw rollbackError;
    }
    throw error;
  }
  return {
    mode: 'restore',
    restored: true,
    alreadyRestored,
    companyId,
    priorRevision: currentRevision,
    revision: after.revision,
    contentHash: after.contentHash,
    sourceContentHash: verified.contentHash,
    sourceAuthority: verified.authority,
    manifestSha256: verified.manifestSha256,
    storage: { total: storage.total, created: storage.created, overwritten: storage.overwritten, unchanged: storage.unchanged, verified: storage.verified },
    credentialsSafety: 'sessions-cleared-temporary-tokens-cleared-external-links-revoked',
    evidenceFile,
    preRestoreBackup: { directory: preRestoreBackup.directory, manifestSha256: preRestoreBackup.manifestSha256, verified: preRestoreBackup.verification.ok, complete: preRestoreBackup.verification.missingObjects === 0, missingObjects: preRestoreBackup.verification.missingObjects }
  };
}

async function main() {
  supabase.loadLocalEnv(path.resolve(__dirname, '..'));
  const args = parseArgs();
  if (String(process.env.PDL_TRANSACTIONAL_DB || '').toLowerCase() !== 'primary') throw new Error('Tenant recovery requires PDL_TRANSACTIONAL_DB=primary.');
  const result = await execute(args);
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) main().catch(error => { console.error(`Tenant recovery failed: ${error.message}`); process.exitCode = 1; });

module.exports = {
  parseArgs,
  execute,
  prepareTenantRestore,
  readStorageObject,
  restoreTenantStorageObjects,
  rollbackTenantStorageObjects,
  assertRestorableSource
};
