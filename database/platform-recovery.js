'use strict';

const fs = require('node:fs');
const path = require('node:path');
const supabase = require('./supabase');
const { PlatformRepository, PLATFORM_NAMESPACE_ID, canonicalHash, requireRevision } = require('./platform-repository');
const {
  createPlatformPortableBackup,
  verifyPlatformPortableBackup,
  readVerifiedPlatformObjects,
  isMissingStorageObjectError,
  digest
} = require('./platform-portable-backup');

function option(argv, name) {
  const index = argv.indexOf(name);
  if (index < 0) return '';
  const value = String(argv[index + 1] || '').trim();
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value.`);
  return value;
}

function parseArgs(argv = process.argv.slice(2)) {
  const command = String(argv[0] || '').trim();
  if (!['export', 'verify', 'restore-preview', 'restore'].includes(command)) {
    throw new Error('Choose one command: export, verify, restore-preview, or restore.');
  }
  const output = option(argv, '--output');
  const backup = option(argv, '--backup');
  const preRestoreOutput = option(argv, '--pre-restore-output');
  const expectedRaw = option(argv, '--expected-revision');
  const expectedManifestSha256 = option(argv, '--expected-manifest-sha256').toLowerCase();
  const apply = argv.includes('--apply');
  if (command === 'export' && !output) throw new Error('export requires --output <independent-directory>.');
  if (command !== 'export' && !backup) throw new Error(`${command} requires --backup <backup-directory>.`);
  if (command === 'restore' && !apply) throw new Error('Refusing a restore without --apply. Use restore-preview first.');
  if (command === 'restore' && !expectedRaw) throw new Error('restore requires --expected-revision <current-revision>.');
  if (command === 'restore' && !preRestoreOutput) throw new Error('restore requires --pre-restore-output <independent-directory> for rollback evidence.');
  if (['restore-preview', 'restore'].includes(command) && !/^[a-f0-9]{64}$/.test(expectedManifestSha256)) {
    throw new Error(`${command} requires --expected-manifest-sha256 <independently-recorded-sha256>.`);
  }
  if (apply && command !== 'restore') throw new Error('--apply is only valid with restore.');
  return {
    command,
    output,
    backup,
    preRestoreOutput,
    apply,
    expectedManifestSha256,
    expectedRevision: expectedRaw ? requireRevision(expectedRaw) : null
  };
}

function assertExpectedManifest(verified, expectedManifestSha256) {
  if (!/^[a-f0-9]{64}$/.test(String(expectedManifestSha256 || '')) ||
      verified?.manifestSha256 !== expectedManifestSha256) {
    throw new Error('Platform backup manifest does not match the independently recorded SHA-256.');
  }
}

function repository() {
  if (!supabase.configured()) throw new Error('Server-side Supabase configuration is missing.');
  return new PlatformRepository({ request: supabase.request, namespaceId: PLATFORM_NAMESPACE_ID });
}

function preparePlatformRestore(snapshot, restoredAt = new Date().toISOString()) {
  const restored = structuredClone(snapshot);
  // Recovery must never resurrect an old bearer session, password-reset/setup
  // token, or temporary customer-support grant from the backup window.
  restored.sessions = [];
  restored.users = (restored.users || []).map(user => {
    const clean = { ...user };
    for (const field of [
      'resetTokenHash', 'resetExpiresAt', 'resetRequestedAt',
      'setupHash', 'setupSalt', 'setupExpiresAt'
    ]) delete clean[field];
    return clean;
  });
  restored.supportGrants = (restored.supportGrants || []).map(grant => {
    const clean = { ...grant, status: 'Revoked', revokedAt: restoredAt, revokeReason: 'Platform recovery safety revocation' };
    delete clean.tokenHash;
    return clean;
  });
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

async function restorePlatformStorageObjects({
  backupDirectory,
  verification,
  rollbackBackup,
  download,
  upload,
  journal = []
}) {
  const sourceObjects = readVerifiedPlatformObjects(backupDirectory, verification);
  if (!sourceObjects.length) return { total: 0, created: 0, overwritten: 0, unchanged: 0, verified: 0, objects: [], journal };
  if (typeof download !== 'function' || typeof upload !== 'function') {
    throw new Error('Storage restore requires server-side download and upload adapters.');
  }
  const rollbackObjects = readVerifiedPlatformObjects(
    rollbackBackup.directory,
    rollbackBackup.verification,
    { allowMissing: true }
  );
  const rollbackById = new Map(rollbackObjects.map(object => [storageObjectId(object), object]));
  const plan = [];

  // Finish every read-only preflight before the first destination write.
  for (const source of sourceObjects) {
    const id = storageObjectId(source);
    const current = await readStorageObject(download, source);
    if (matchesObject(current, source)) {
      plan.push({ id, action: 'unchanged', source, prior: current });
      continue;
    }
    if (!current.exists) {
      plan.push({ id, action: 'create', source, prior: current });
      continue;
    }
    const rollback = rollbackById.get(id);
    if (!rollback || rollback.missing || !matchesObject(current, rollback)) {
      throw new Error(`Refusing to overwrite ${id}: its current bytes are not preserved in the verified pre-restore backup.`);
    }
    plan.push({ id, action: 'overwrite', source, prior: current, rollback });
  }

  for (const item of plan) {
    if (item.action === 'unchanged') continue;
    const immediatelyBefore = await readStorageObject(download, item.source);
    if (item.action === 'create' && immediatelyBefore.exists) {
      throw Object.assign(new Error(`Storage object changed during restore preflight: ${item.id}`), { storageJournal: journal });
    }
    if (item.action === 'overwrite' && !matchesObject(immediatelyBefore, item.prior)) {
      throw Object.assign(new Error(`Storage object changed during restore preflight: ${item.id}`), { storageJournal: journal });
    }
    try {
      await upload(
        item.source.bucket,
        item.source.objectKey,
        item.source.data,
        item.source.contentType,
        item.action === 'overwrite'
      );
      journal.push(item);
    } catch (error) {
      if (item.action === 'create' && isStorageConflictError(error)) {
        throw Object.assign(error, { storageJournal: journal });
      }
      // Provider timeouts can be ambiguous. Inspect the destination so a write
      // that actually landed is still included in the rollback journal.
      try {
        const afterFailure = await readStorageObject(download, item.source);
        const changed = item.action === 'create'
          ? afterFailure.exists
          : !matchesObject(afterFailure, item.prior);
        if (changed) journal.push(item);
      } catch (inspectionError) {
        error.storageOutcomeUnknown = item.id;
        error.storageInspectionError = inspectionError.message;
      }
      throw Object.assign(error, { storageJournal: journal });
    }
    const restored = await readStorageObject(download, item.source);
    if (!matchesObject(restored, item.source)) {
      throw Object.assign(new Error(`Storage restore verification failed for ${item.id}.`), { storageJournal: journal });
    }
  }

  return {
    total: plan.length,
    created: plan.filter(item => item.action === 'create').length,
    overwritten: plan.filter(item => item.action === 'overwrite').length,
    unchanged: plan.filter(item => item.action === 'unchanged').length,
    verified: plan.length,
    objects: plan.map(item => ({
      bucket: item.source.bucket,
      objectKey: item.source.objectKey,
      action: item.action,
      bytes: item.source.bytes,
      sha256: item.source.sha256
    })),
    journal
  };
}

async function rollbackPlatformStorageObjects(journal, { download, upload, remove }) {
  const failures = [];
  for (const item of [...journal].reverse()) {
    try {
      if (item.action === 'create') {
        if (typeof remove !== 'function') throw new Error('Storage remove adapter is unavailable.');
        await remove(item.source.bucket, item.source.objectKey);
        const state = await readStorageObject(download, item.source);
        if (state.exists) throw new Error('new object still exists after removal');
      } else if (item.action === 'overwrite') {
        await upload(item.rollback.bucket, item.rollback.objectKey, item.rollback.data, item.rollback.contentType, true);
        const state = await readStorageObject(download, item.rollback);
        if (!matchesObject(state, item.rollback)) throw new Error('prior object bytes did not reconcile');
      }
    } catch (error) {
      failures.push({ object: item.id, error: error.message });
    }
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
  if (args.command === 'restore' && !args.apply) throw new Error('Refusing a restore without explicit apply authorization.');
  if (args.command === 'verify' || args.command === 'restore-preview') {
    const verified = verifyPlatformPortableBackup(path.resolve(args.backup));
    if (args.command === 'restore-preview') assertExpectedManifest(verified, args.expectedManifestSha256);
    if (args.command === 'restore-preview') readVerifiedPlatformObjects(path.resolve(args.backup), verified);
    return {
      mode: args.command,
      verified: true,
      namespaceId: verified.namespaceId,
      sourceRevision: verified.sourceRevision,
      contentHash: verified.contentHash,
      objects: verified.objects,
      missingObjects: verified.missingObjects,
      complete: verified.missingObjects === 0,
      ...(args.command === 'restore-preview' ? {
        nextStep: 'Run restore with --apply and the current repository revision after change approval.',
        writesPerformed: false
      } : {})
    };
  }

  const store = repo || repository();
  if (args.command === 'export') {
    const current = await store.load();
    if (!current) throw new Error('Platform repository has not been initialized.');
    const backup = await createPlatformPortableBackup({
      snapshot: current.snapshot,
      revision: current.revision,
      destination: path.resolve(args.output),
      namespaceId: current.namespaceId,
      download,
      now
    });
    return {
      mode: 'export',
      directory: backup.directory,
      namespaceId: current.namespaceId,
      revision: current.revision,
      contentHash: current.contentHash,
      manifestSha256: backup.manifestSha256,
      objects: backup.manifest.objects.length,
      verified: backup.verification.ok
    };
  }

  const verified = verifyPlatformPortableBackup(path.resolve(args.backup));
  assertExpectedManifest(verified, args.expectedManifestSha256);
  // A source recovery set must contain bytes for every reference. Only a
  // pre-restore evidence set may explicitly record already-missing live data.
  readVerifiedPlatformObjects(path.resolve(args.backup), verified);
  const before = await store.load();
  const currentRevision = before?.revision ?? 0;
  if (currentRevision !== args.expectedRevision) {
    throw new Error(`Restore precondition failed: expected current revision ${args.expectedRevision}, found ${currentRevision}.`);
  }
  if (!args.preRestoreOutput) throw new Error('Restore requires an independent pre-restore backup destination.');
  // Even an uninitialized repository gets a revision-0 empty rollback set so
  // the attempted restore always leaves an independently verifiable record.
  const preRestoreBackup = await createPlatformPortableBackup({
    snapshot: before?.snapshot || {},
    revision: before?.revision || 0,
    destination: path.resolve(args.preRestoreOutput),
    namespaceId: before?.namespaceId || PLATFORM_NAMESPACE_ID,
    download,
    allowMissingObjects: true,
    now
  });
  const restoredSnapshot = preparePlatformRestore(verified.snapshot, now.toISOString());
  const expectedHash = canonicalHash(restoredSnapshot);
  const storageJournal = [];
  let storage = null;
  let saved = null;
  let after = null;
  let repositoryCommitted = false;
  let repositoryOutcomeUnknown = false;
  let evidenceFile = null;
  try {
    storage = await restorePlatformStorageObjects({
      backupDirectory: path.resolve(args.backup),
      verification: verified,
      rollbackBackup: preRestoreBackup,
      download,
      upload,
      journal: storageJournal
    });
    try {
      saved = await store.save(restoredSnapshot, {
        expectedRevision: args.expectedRevision,
        changedBy: `verified-restore:${verified.manifestSha256.slice(0, 16)}`
      });
      repositoryCommitted = true;
    } catch (saveError) {
      // A lost response after a committed CAS write is possible. Read back
      // before deciding whether storage must be rolled back.
      let observed = null;
      let observedError = null;
      for (let attempt = 0; attempt < 3 && !observed; attempt += 1) {
        try { observed = await store.load(); } catch (error) { observedError = error; }
      }
      if (observed && observed.revision > args.expectedRevision && observed.contentHash === expectedHash && canonicalHash(observed.snapshot) === expectedHash) {
        saved = observed;
        repositoryCommitted = true;
      } else if (!observed) {
        repositoryOutcomeUnknown = true;
        const uncertain = new Error(`Platform repository commit outcome could not be verified; storage was retained for manual reconciliation. ${observedError?.message || saveError.message}`);
        uncertain.cause = saveError;
        uncertain.repositoryOutcomeUnknown = true;
        throw uncertain;
      } else {
        throw saveError;
      }
    }
    after = await store.load();
    if (!after || after.revision !== saved.revision || after.contentHash !== expectedHash || canonicalHash(after.snapshot) !== expectedHash) {
      throw new Error('Platform restore reconciliation failed after the transactional write.');
    }
    if (preRestoreBackup) {
      evidenceFile = writeRestoreEvidence(preRestoreBackup.directory, {
        version: 1,
        status: 'verified',
        completedAt: now.toISOString(),
        namespaceId: after.namespaceId,
        sourceManifestSha256: verified.manifestSha256,
        sourceRevision: verified.sourceRevision,
        priorRevision: currentRevision,
        restoredRevision: after.revision,
        restoredContentHash: after.contentHash,
        storage: {
          total: storage.total,
          created: storage.created,
          overwritten: storage.overwritten,
          unchanged: storage.unchanged,
          verified: storage.verified,
          objects: storage.objects
        },
        preRestoreManifestSha256: preRestoreBackup.manifestSha256,
        preRestoreMissingObjects: preRestoreBackup.verification.missingObjects
      });
    }
  } catch (error) {
    let rollback = { ok: true, attempted: 0, failures: [] };
    const unknownStorage = error.storageOutcomeUnknown
      ? [{ object: error.storageOutcomeUnknown, error: `upload outcome could not be inspected: ${error.storageInspectionError || 'provider unavailable'}` }]
      : [];
    if (!repositoryCommitted && !repositoryOutcomeUnknown && storageJournal.length) {
      rollback = await rollbackPlatformStorageObjects(storageJournal, { download, upload, remove });
    }
    if (repositoryOutcomeUnknown) {
      rollback = { ok: false, attempted: 0, failures: [{ object: 'platform-repository', error: 'commit outcome is unknown; storage intentionally retained' }] };
    } else if (unknownStorage.length) {
      rollback = { ...rollback, ok: false, failures: [...rollback.failures, ...unknownStorage] };
    }
    if (preRestoreBackup) {
      try {
        evidenceFile = writeRestoreEvidence(preRestoreBackup.directory, {
          version: 1,
          status: repositoryCommitted
            ? 'repository-committed-reconciliation-failed'
            : repositoryOutcomeUnknown
              ? 'repository-outcome-unknown'
              : 'failed-before-repository-commit',
          completedAt: now.toISOString(),
          namespaceId: before?.namespaceId || PLATFORM_NAMESPACE_ID,
          sourceManifestSha256: verified.manifestSha256,
          sourceRevision: verified.sourceRevision,
          priorRevision: currentRevision,
          repositoryCommitted,
          repositoryOutcomeUnknown,
          storageWritesAttempted: storageJournal.length,
          storageWrites: storageJournal.map(item => ({
            bucket: item.source.bucket,
            objectKey: item.source.objectKey,
            action: item.action,
            bytes: item.source.bytes,
            sha256: item.source.sha256
          })),
          storageRollback: rollback,
          error: String(error.message || error).slice(0, 1000),
          preRestoreManifestSha256: preRestoreBackup.manifestSha256,
          preRestoreMissingObjects: preRestoreBackup.verification.missingObjects
        });
      } catch (evidenceError) {
        error.message += ` Recovery evidence write also failed: ${evidenceError.message}`;
      }
    }
    if (!rollback.ok) {
      const rollbackError = new Error(`Platform restore failed and storage rollback was incomplete: ${rollback.failures.map(item => `${item.object}: ${item.error}`).join('; ')}`);
      rollbackError.cause = error;
      rollbackError.evidenceFile = evidenceFile;
      throw rollbackError;
    }
    throw error;
  }
  return {
    mode: 'restore',
    restored: true,
    namespaceId: after.namespaceId,
    priorRevision: currentRevision,
    revision: after.revision,
    contentHash: after.contentHash,
    sourceContentHash: verified.contentHash,
    manifestSha256: verified.manifestSha256,
    sourceObjectsVerified: verified.objects,
    objectsVerified: storage.verified,
    storage: {
      total: storage.total,
      created: storage.created,
      overwritten: storage.overwritten,
      unchanged: storage.unchanged,
      verified: storage.verified
    },
    credentialsSafety: 'sessions-cleared-temporary-tokens-cleared-support-grants-revoked',
    evidenceFile,
    preRestoreBackup: preRestoreBackup ? {
      directory: preRestoreBackup.directory,
      manifestSha256: preRestoreBackup.manifestSha256,
      verified: preRestoreBackup.verification.ok,
      complete: preRestoreBackup.verification.missingObjects === 0,
      missingObjects: preRestoreBackup.verification.missingObjects
    } : null
  };
}

async function main() {
  supabase.loadLocalEnv(path.resolve(__dirname, '..'));
  const args = parseArgs();
  const result = await execute(args);
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) main().catch(error => {
  console.error(`Platform recovery failed: ${error.message}`);
  process.exitCode = 1;
});

module.exports = {
  parseArgs,
  assertExpectedManifest,
  execute,
  preparePlatformRestore,
  readStorageObject,
  restorePlatformStorageObjects,
  rollbackPlatformStorageObjects
};
