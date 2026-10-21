'use strict';

const fs = require('node:fs');
const path = require('node:path');
const supabase = require('./supabase');
const maintenanceFence = require('./maintenance-fence');
const { PlatformRepository, PLATFORM_NAMESPACE_ID, canonicalHash, requireRevision } = require('./platform-repository');
const {
  createPlatformPortableBackup,
  verifyPlatformPortableBackup,
  readVerifiedPlatformObjects,
  validatePlatformRestoreSnapshot,
  isMissingStorageObjectError,
  digest
} = require('./platform-portable-backup');

const SUPABASE_PROJECT_REF = /^[a-z0-9]{20}$/;
const RENDER_SERVICE_ID = /^srv-[a-z0-9]{20,64}$/;
const RENDER_INSTANCE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;

function option(argv, name) {
  if (argv.filter(value => value === name).length > 1) throw new Error(`${name} may only be provided once.`);
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
  const expectedCurrentContentHash = option(argv, '--expected-current-content-hash').toLowerCase();
  const expectedServiceId = option(argv, '--expected-service-id');
  const expectedInstanceId = option(argv, '--expected-instance-id');
  const productionTarget = option(argv, '--production-target').toLowerCase();
  const disposableTarget = option(argv, '--disposable-target').toLowerCase();
  const apply = argv.includes('--apply');
  const valueFlags = new Set([
    '--output', '--backup', '--pre-restore-output', '--expected-revision', '--expected-manifest-sha256',
    '--expected-current-content-hash',
    '--expected-service-id', '--expected-instance-id', '--production-target', '--disposable-target'
  ]);
  const booleanFlags = new Set(['--apply']);
  for (let index = 1; index < argv.length; index += 1) {
    const token = String(argv[index]);
    if (valueFlags.has(token)) {
      index += 1;
      continue;
    }
    if (!booleanFlags.has(token)) throw new Error(`Unsupported platform recovery argument: ${token.startsWith('--') ? token : '(value)'}.`);
  }
  if (argv.filter(value => value === '--apply').length > 1) throw new Error('--apply may only be provided once.');
  if (command === 'export' && !output) throw new Error('export requires --output <independent-directory>.');
  if (command !== 'export' && !backup) throw new Error(`${command} requires --backup <backup-directory>.`);
  if (command === 'restore' && !apply) throw new Error('Refusing a restore without --apply. Use restore-preview first.');
  if (command === 'restore' && !expectedRaw) throw new Error('restore requires --expected-revision <current-revision>.');
  if (command === 'restore' && !preRestoreOutput) throw new Error('restore requires --pre-restore-output <independent-directory> for rollback evidence.');
  if (['restore-preview', 'restore'].includes(command) && !/^[a-f0-9]{64}$/.test(expectedManifestSha256)) {
    throw new Error(`${command} requires --expected-manifest-sha256 <independently-recorded-sha256>.`);
  }
  if (command === 'restore' && !SHA256.test(expectedCurrentContentHash)) {
    throw new Error('restore requires --expected-current-content-hash <independently-recorded-current-platform-sha256>.');
  }
  if (expectedServiceId && !RENDER_SERVICE_ID.test(expectedServiceId)) {
    throw new Error('--expected-service-id must be an exact Render service ID.');
  }
  if (expectedInstanceId && !RENDER_INSTANCE_ID.test(expectedInstanceId)) {
    throw new Error('--expected-instance-id must be an exact Render instance ID.');
  }
  if (Boolean(expectedServiceId) !== Boolean(expectedInstanceId)) {
    throw new Error('--expected-service-id and --expected-instance-id must be provided together.');
  }
  if (productionTarget && !SUPABASE_PROJECT_REF.test(productionTarget)) {
    throw new Error('--production-target must be an exact Supabase project reference.');
  }
  if (disposableTarget && !SUPABASE_PROJECT_REF.test(disposableTarget)) {
    throw new Error('--disposable-target must be an exact Supabase project reference.');
  }
  if (['export', 'restore'].includes(command) && (Boolean(productionTarget) === Boolean(disposableTarget))) {
    throw new Error(`${command} requires exactly one of --production-target <project-ref> or --disposable-target <project-ref>.`);
  }
  if (!['export', 'restore'].includes(command) && (productionTarget || disposableTarget)) {
    throw new Error('Target flags are only valid with export or restore.');
  }
  if (productionTarget && (!expectedServiceId || !expectedInstanceId)) {
    throw new Error('--production-target requires exact --expected-service-id and --expected-instance-id values.');
  }
  if (disposableTarget && (expectedServiceId || expectedInstanceId)) {
    throw new Error('Render identity flags are only valid with --production-target.');
  }
  if (apply && command !== 'restore') throw new Error('--apply is only valid with restore.');
  return {
    command,
    output,
    backup,
    preRestoreOutput,
    apply,
    expectedManifestSha256,
    expectedCurrentContentHash,
    expectedRevision: expectedRaw ? requireRevision(expectedRaw) : null,
    expectedServiceId,
    expectedInstanceId,
    productionTarget,
    disposableTarget
  };
}

function assertExpectedManifest(verified, expectedManifestSha256) {
  if (!/^[a-f0-9]{64}$/.test(String(expectedManifestSha256 || '')) ||
      verified?.manifestSha256 !== expectedManifestSha256) {
    throw new Error('Platform backup manifest does not match the independently recorded SHA-256.');
  }
}

function canonicalBoundaryPath(value) {
  const unresolved = [];
  let cursor = path.resolve(String(value || ''));
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    unresolved.unshift(path.basename(cursor));
    cursor = parent;
  }
  const realBase = fs.realpathSync.native ? fs.realpathSync.native(cursor) : fs.realpathSync(cursor);
  const canonical = path.resolve(realBase, ...unresolved);
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
}

function pathContains(parent, child) {
  const relative = path.relative(canonicalBoundaryPath(parent), canonicalBoundaryPath(child));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function assertIndependentRestorePaths(backup, preRestoreOutput) {
  if (pathContains(backup, preRestoreOutput) || pathContains(preRestoreOutput, backup)) {
    throw new Error('Restore source and pre-restore output must be separate, non-overlapping directories.');
  }
}

function configuredSupabaseProjectRef(env = process.env) {
  if (env.PDL_SUPABASE_ENABLED !== '1' || !String(env.SUPABASE_URL || '').trim()) {
    throw new Error('PLATFORM_RECOVERY_TARGET_CONFIGURATION_MISSING');
  }
  let url;
  try { url = new URL(String(env.SUPABASE_URL)); } catch {
    throw new Error('PLATFORM_RECOVERY_TARGET_CONFIGURATION_INVALID');
  }
  const match = /^([a-z0-9]{20})\.supabase\.co$/.exec(url.hostname.toLowerCase());
  if (url.protocol !== 'https:' || !match || url.username || url.password || url.port ||
      (url.pathname && url.pathname !== '/') || url.search || url.hash) {
    throw new Error('PLATFORM_RECOVERY_TARGET_CONFIGURATION_INVALID');
  }
  return match[1];
}

function validateRecoveryTarget(args, env = process.env) {
  const actualProjectRef = configuredSupabaseProjectRef(env);
  if (args.productionTarget) {
    const configuredProductionRef = String(env.PDL_PRODUCTION_SUPABASE_PROJECT_REF || '').trim().toLowerCase();
    if (!SUPABASE_PROJECT_REF.test(configuredProductionRef) ||
        configuredProductionRef !== args.productionTarget || actualProjectRef !== args.productionTarget) {
      throw new Error('PLATFORM_RECOVERY_PRODUCTION_TARGET_MISMATCH');
    }
    if (env.NODE_ENV !== 'production' || env.RENDER !== 'true' || env.RENDER_SERVICE_TYPE !== 'web' ||
        env.IS_PULL_REQUEST === 'true' || env.RENDER_SERVICE_ID !== args.expectedServiceId ||
        env.RENDER_INSTANCE_ID !== args.expectedInstanceId) {
      throw new Error('PLATFORM_RECOVERY_PRODUCTION_RUNTIME_MISMATCH');
    }
    return { mode: 'production', projectRef: actualProjectRef };
  }
  if (args.disposableTarget) {
    const configuredDisposableRef = String(env.PDL_DISPOSABLE_SUPABASE_PROJECT_REF || '').trim().toLowerCase();
    const configuredProductionRef = String(env.PDL_PRODUCTION_SUPABASE_PROJECT_REF || '').trim().toLowerCase();
    if (!SUPABASE_PROJECT_REF.test(configuredProductionRef)) {
      throw new Error('PLATFORM_RECOVERY_DISPOSABLE_PRODUCTION_GUARD_MISSING');
    }
    if (!SUPABASE_PROJECT_REF.test(configuredDisposableRef) ||
        configuredDisposableRef !== args.disposableTarget || actualProjectRef !== args.disposableTarget) {
      throw new Error('PLATFORM_RECOVERY_DISPOSABLE_TARGET_MISMATCH');
    }
    if (env.NODE_ENV === 'production' || env.RENDER === 'true' ||
        configuredProductionRef === actualProjectRef) {
      throw new Error('PLATFORM_RECOVERY_DISPOSABLE_TARGET_FORBIDDEN');
    }
    return { mode: 'disposable', projectRef: actualProjectRef };
  }
  throw new Error('PLATFORM_RECOVERY_TARGET_REQUIRED');
}

function repository() {
  if (!supabase.configured()) throw new Error('Server-side Supabase configuration is missing.');
  return new PlatformRepository({ request: supabase.request, namespaceId: PLATFORM_NAMESPACE_ID });
}

const TRANSIENT_IDENTITY_FIELDS = Object.freeze([
  'resetTokenHash', 'resetExpiresAt', 'resetRequestedAt',
  'setupHash', 'setupSalt', 'setupExpiresAt', 'setupCode',
  'temporaryPassword', 'temporaryPasswordHash', 'temporaryPasswordExpiresAt'
]);

function identityPart(value) {
  return value === undefined || value === null || value === '' ? '' : String(value).trim();
}

function identityEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function assertUnambiguousIdentities(rows, label) {
  const ids = new Set(), emails = new Set();
  for (const row of rows) {
    const id = identityPart(row?.id), email = identityEmail(row?.email);
    if (id && ids.has(id) || email && emails.has(email)) {
      throw new Error(`PLATFORM_RECOVERY_IDENTITY_AMBIGUOUS:${label}`);
    }
    if (id) ids.add(id);
    if (email) emails.add(email);
  }
}

function stripTransientIdentityArtifacts(user) {
  const clean = { ...user };
  for (const key of TRANSIENT_IDENTITY_FIELDS) delete clean[key];
  return clean;
}

function disableBackupOnlyPlatformIdentity(user, restoredAt) {
  const clean = { ...user };
  for (const key of Object.keys(clean)) {
    if (/(?:password|passcode|credential|token|secret|session|setup|verification|mfa|totp|webauthn)/i.test(key)) delete clean[key];
  }
  clean.status = 'Inactive';
  clean.mustSetPassword = true;
  clean.recoveryAccessState = 'reenrollment-required';
  clean.recoveryDeactivatedAt = restoredAt;
  return clean;
}

function mergeForwardPlatformIdentities(sourceUsers, currentUsers, restoredAt) {
  const source = Array.isArray(sourceUsers) ? sourceUsers : [];
  const current = Array.isArray(currentUsers) ? currentUsers : [];
  assertUnambiguousIdentities(source, 'source');
  assertUnambiguousIdentities(current, 'current');
  const byId = new Map(), byEmail = new Map();
  current.forEach((user, index) => {
    const id = identityPart(user?.id), email = identityEmail(user?.email);
    if (id) byId.set(id, index);
    if (email) byEmail.set(email, index);
  });
  const used = new Set();
  const merged = source.map(user => {
    const candidates = new Set();
    const id = identityPart(user?.id), email = identityEmail(user?.email);
    if (id && byId.has(id)) candidates.add(byId.get(id));
    if (email && byEmail.has(email)) candidates.add(byEmail.get(email));
    if (candidates.size > 1) throw new Error('PLATFORM_RECOVERY_IDENTITY_AMBIGUOUS:cross-key');
    if (!candidates.size) return disableBackupOnlyPlatformIdentity(user, restoredAt);
    const index = [...candidates][0];
    if (used.has(index)) throw new Error('PLATFORM_RECOVERY_IDENTITY_AMBIGUOUS:duplicate-match');
    used.add(index);
    return stripTransientIdentityArtifacts(structuredClone(current[index]));
  });
  current.forEach((user, index) => {
    if (!used.has(index)) merged.push(stripTransientIdentityArtifacts(structuredClone(user)));
  });
  return merged;
}

function preparePlatformRestore(snapshot, currentSnapshot = {}, restoredAt = new Date().toISOString()) {
  const restored = structuredClone(snapshot);
  // Recovery must never resurrect an old bearer session, password-reset/setup
  // token, or temporary customer-support grant from the backup window.
  restored.sessions = [];
  restored.users = mergeForwardPlatformIdentities(restored.users, currentSnapshot?.users, restoredAt);
  restored.supportGrants = (restored.supportGrants || []).map(grant => {
    const clean = { ...grant, status: 'Revoked', revokedAt: restoredAt, revokeReason: 'Platform recovery safety revocation' };
    delete clean.tokenHash;
    return clean;
  });
  return restored;
}

function requireInitializedPlatformRestoreTarget(before) {
  if (!before?.snapshot) {
    throw new Error('PLATFORM_RECOVERY_TARGET_OWNER_REQUIRED: initialize the exact target platform namespace with an active break-glass platform_owner before restore.');
  }
  try {
    validatePlatformRestoreSnapshot(before.snapshot);
  } catch (cause) {
    const error = new Error('PLATFORM_RECOVERY_TARGET_OWNER_REQUIRED: the exact target platform namespace must be a valid initialized snapshot with at least one active platform_owner before restore.');
    error.cause = cause;
    throw error;
  }
  const breakGlassOwner = before.snapshot.users.find(user => user.role === 'platform_owner' && user.status === 'Active' &&
    user.mustSetPassword !== true && identityPart(user.passwordHash) && identityPart(user.passwordSalt));
  if (!breakGlassOwner) {
    throw new Error('PLATFORM_RECOVERY_TARGET_OWNER_REQUIRED: the exact target platform namespace needs an active break-glass platform_owner with a current permanent credential before restore.');
  }
  return before.snapshot;
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

function sameMaintenanceFence(left, right) {
  return Boolean(left && right &&
    left.digest === right.digest &&
    left.openedAt === right.openedAt &&
    left.mode === right.mode &&
    left.source === right.source &&
    JSON.stringify(left.identity) === JSON.stringify(right.identity));
}

function requireSameMaintenanceFence(fenceApi, env, options, expected) {
  const current = fenceApi.requireVerifiedFence(env, options);
  if (!sameMaintenanceFence(current, expected)) {
    const error = new Error('MAINTENANCE_FENCE_CHANGED');
    error.code = 'MAINTENANCE_FENCE_CHANGED';
    throw error;
  }
  return current;
}

function invalidateGeneratedBackup(backup, outputRoot) {
  if (!backup?.directory) return;
  const root = path.resolve(outputRoot);
  const directory = path.resolve(backup.directory);
  if (path.dirname(directory) !== root) throw new Error('Refusing to invalidate a platform recovery set outside its requested output directory.');
  const checksum = path.join(directory, 'manifest.sha256');
  try { fs.unlinkSync(checksum); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  try { fs.rmSync(directory, { recursive: true, force: true }); } catch {}
}

async function verifyExpectedPlatformStorageObjects(expectedObjects, download) {
  if (!expectedObjects.length) return 0;
  if (typeof download !== 'function') throw new Error('Storage verification requires a server-side download adapter.');
  for (const object of expectedObjects) {
    const current = await readStorageObject(download, object);
    if (!matchesObject(current, object)) {
      const error = new Error(`Storage object changed before repository commit: ${storageObjectId(object)}`);
      error.code = 'PDL_PLATFORM_STORAGE_CONCURRENT_CHANGE';
      throw error;
    }
  }
  return expectedObjects.length;
}

async function restorePlatformStorageObjects({
  backupDirectory,
  verification,
  rollbackBackup,
  download,
  upload,
  journal = [],
  beforeWrite = null
}) {
  const sourceObjects = readVerifiedPlatformObjects(backupDirectory, verification);
  if (!sourceObjects.length) return {
    total: 0, created: 0, overwritten: 0, unchanged: 0, verified: 0,
    objects: [], journal
  };
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
      if (beforeWrite) beforeWrite(item);
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

  const verified = await verifyExpectedPlatformStorageObjects(sourceObjects, download);

  return {
    total: plan.length,
    created: plan.filter(item => item.action === 'create').length,
    overwritten: plan.filter(item => item.action === 'overwrite').length,
    unchanged: plan.filter(item => item.action === 'unchanged').length,
    verified,
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

function maintenanceFenceFailure(error) {
  return error?.code === 'MAINTENANCE_FENCE_CHANGED' || /^MAINTENANCE_(?:FENCE|ENVIRONMENT|RUNTIME|PATH|EXPECTED)/.test(String(error?.message || error || ''));
}

async function rollbackPlatformStorageObjects(journal, { download, upload, remove, beforeWrite = null }) {
  const failures = [];
  let processed = 0;
  let haltedForFence = false;
  for (const item of [...journal].reverse()) {
    try {
      if (item.action === 'create') {
        const current = await readStorageObject(download, item.source);
        if (!current.exists) continue;
        if (!matchesObject(current, item.source)) {
          const conflict = new Error('rollback conflict: current bytes no longer match this restore target');
          conflict.code = 'PDL_PLATFORM_RESTORE_ROLLBACK_CONFLICT';
          throw conflict;
        }
        if (typeof remove !== 'function') throw new Error('Storage remove adapter is unavailable.');
        if (beforeWrite) beforeWrite(item, 'remove-created-object');
        await remove(item.source.bucket, item.source.objectKey);
        const state = await readStorageObject(download, item.source);
        if (state.exists) throw new Error('new object still exists after removal');
      } else if (item.action === 'overwrite') {
        const current = await readStorageObject(download, item.source);
        if (matchesObject(current, item.rollback)) continue;
        if (!matchesObject(current, item.source)) {
          const conflict = new Error('rollback conflict: current bytes no longer match this restore target');
          conflict.code = 'PDL_PLATFORM_RESTORE_ROLLBACK_CONFLICT';
          throw conflict;
        }
        if (beforeWrite) beforeWrite(item, 'restore-prior-object');
        await upload(item.rollback.bucket, item.rollback.objectKey, item.rollback.data, item.rollback.contentType, true);
        const state = await readStorageObject(download, item.rollback);
        if (!matchesObject(state, item.rollback)) throw new Error('prior object bytes did not reconcile');
      }
      processed += 1;
    } catch (error) {
      failures.push({ object: item.id, error: error.message });
      if (maintenanceFenceFailure(error)) {
        haltedForFence = true;
        break;
      }
    }
  }
  return { ok: failures.length === 0, attempted: journal.length, processed, haltedForFence, failures };
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
  now = new Date(),
  env = process.env,
  fenceApi = maintenanceFence,
  maintenanceRoot = path.resolve(__dirname, '..')
} = {}) {
  if (args.command === 'restore' && !args.apply) throw new Error('Refusing a restore without explicit apply authorization.');
  if (args.command === 'restore') assertIndependentRestorePaths(args.backup, args.preRestoreOutput);
  if (args.command === 'verify' || args.command === 'restore-preview') {
    const verified = verifyPlatformPortableBackup(path.resolve(args.backup));
    if (args.command === 'restore-preview') assertExpectedManifest(verified, args.expectedManifestSha256);
    if (args.command === 'restore-preview') readVerifiedPlatformObjects(path.resolve(args.backup), verified);
    return {
      mode: args.command,
      verified: true,
      namespaceId: verified.namespaceId,
      sourceRevision: verified.sourceRevision,
      createdAt: verified.createdAt,
      contentHash: verified.contentHash,
      objects: verified.objects,
      missingObjects: verified.missingObjects,
      complete: verified.missingObjects === 0,
      ...(args.command === 'restore-preview' ? {
        nextStep: 'Run restore with --apply and the independently recorded current repository revision and content hash after change approval.',
        writesPerformed: false
      } : {})
    };
  }

  const target = validateRecoveryTarget(args, env);
  const fenceOptions = {
    root: maintenanceRoot,
    expectedServiceId: args.expectedServiceId || '',
    expectedInstanceId: args.expectedInstanceId || ''
  };
  const requiresFence = args.command === 'restore' || target.mode === 'production';
  const initialFence = requiresFence
    ? fenceApi.requireVerifiedFence(env, fenceOptions)
    : null;
  const store = repo || repository();
  if (args.command === 'export') {
    let backup = null;
    try {
      const current = await store.load();
      if (!current) throw new Error('Platform repository has not been initialized.');
      if (String(current.namespaceId || '').toLowerCase() !== PLATFORM_NAMESPACE_ID) {
        throw new Error('Platform repository namespace does not match this installation.');
      }
      const actualContentHash = canonicalHash(current.snapshot);
      if (current.contentHash !== actualContentHash) {
        throw new Error('Platform repository content hash does not match the export snapshot.');
      }
      requireRevision(current.revision, 'platform repository revision');
      backup = await createPlatformPortableBackup({
        snapshot: current.snapshot,
        revision: current.revision,
        destination: path.resolve(args.output),
        namespaceId: PLATFORM_NAMESPACE_ID,
        download,
        now,
        beforeComplete: async ({ manifest }) => {
          await verifyExpectedPlatformStorageObjects(manifest.objects, download);
          const afterCapture = await store.load();
          if (!afterCapture || afterCapture.revision !== current.revision ||
              afterCapture.namespaceId !== PLATFORM_NAMESPACE_ID ||
              afterCapture.contentHash !== current.contentHash ||
              canonicalHash(afterCapture.snapshot) !== current.contentHash) {
            throw new Error('Platform export source changed during capture; the recovery set was not accepted.');
          }
          if (initialFence) requireSameMaintenanceFence(fenceApi, env, fenceOptions, initialFence);
        }
      });
      // createPlatformPortableBackup writes its completion marker after the
      // callback. Recheck the identical fence once more so a replacement in
      // that final window cannot leave an accepted-looking production set.
      if (initialFence) requireSameMaintenanceFence(fenceApi, env, fenceOptions, initialFence);
      return {
        mode: 'export',
        directory: backup.directory,
        namespaceId: PLATFORM_NAMESPACE_ID,
        revision: current.revision,
        contentHash: current.contentHash,
        manifestSha256: backup.manifestSha256,
        objects: backup.manifest.objects.length,
        verified: backup.verification.ok,
        targetMode: target.mode,
        maintenanceFenceDigest: initialFence?.digest || null
      };
    } catch (error) {
      if (backup) invalidateGeneratedBackup(backup, args.output);
      throw error;
    }
  }

  const verified = verifyPlatformPortableBackup(path.resolve(args.backup));
  assertExpectedManifest(verified, args.expectedManifestSha256);
  // A source recovery set must contain bytes for every reference. Only a
  // pre-restore evidence set may explicitly record already-missing live data.
  const sourceObjects = readVerifiedPlatformObjects(path.resolve(args.backup), verified);
  const before = await store.load();
  const currentRevision = before?.revision ?? 0;
  if (currentRevision !== args.expectedRevision) {
    throw new Error(`Restore precondition failed: expected current revision ${args.expectedRevision}, found ${currentRevision}.`);
  }
  if (!args.preRestoreOutput) throw new Error('Restore requires an independent pre-restore backup destination.');
  // Disposable drills and production restores both require a deliberately
  // initialized target. The active break-glass owner is the live access
  // envelope that recovery merges forward. Fail before creating any evidence
  // directory or touching Storage if that target is absent or malformed.
  const rollbackSnapshot = requireInitializedPlatformRestoreTarget(before);
  if (before.namespaceId !== PLATFORM_NAMESPACE_ID) throw new Error('Platform recovery target namespace does not match the configured platform namespace.');
  const currentContentHash = canonicalHash(rollbackSnapshot);
  if (before.contentHash !== currentContentHash) throw new Error('Current platform repository content hash does not match its snapshot.');
  const expectedCurrentContentHash = String(args.expectedCurrentContentHash || '').trim().toLowerCase();
  if (!SHA256.test(expectedCurrentContentHash)) {
    throw new Error('Restore requires an independently recorded current platform content hash.');
  }
  if (currentContentHash !== expectedCurrentContentHash) {
    throw new Error('Restore precondition failed: current platform content hash does not match the independently recorded value.');
  }
  const restoredSnapshot = preparePlatformRestore(verified.snapshot, rollbackSnapshot, now.toISOString());
  validatePlatformRestoreSnapshot(restoredSnapshot);
  const expectedHash = canonicalHash(restoredSnapshot);
  const preRestoreBackup = await createPlatformPortableBackup({
    snapshot: rollbackSnapshot,
    revision: before.revision,
    destination: path.resolve(args.preRestoreOutput),
    namespaceId: before.namespaceId,
    download,
    allowMissingObjects: true,
    now
  });
  const storageJournal = [];
  let storage = null;
  let saved = null;
  let after = null;
  let repositoryCommitted = false;
  let repositoryOutcomeUnknown = false;
  let evidenceFile = null;
  try {
    requireSameMaintenanceFence(fenceApi, env, fenceOptions, initialFence);
    storage = await restorePlatformStorageObjects({
      backupDirectory: path.resolve(args.backup),
      verification: verified,
      rollbackBackup: preRestoreBackup,
      download,
      upload,
      journal: storageJournal,
      beforeWrite: () => requireSameMaintenanceFence(fenceApi, env, fenceOptions, initialFence)
    });
    storage.verified = await verifyExpectedPlatformStorageObjects(sourceObjects, download);
    // This synchronous identity/digest check is deliberately the last action
    // before the repository CAS. A replaced or removed fence must never be
    // accepted merely because it was valid at the beginning of the restore.
    requireSameMaintenanceFence(fenceApi, env, fenceOptions, initialFence);
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
      } else if (!observed || observed.revision > args.expectedRevision) {
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
      // Bind success evidence to the same fence that authorized every write.
      // A fence removed immediately after commit is an operator-visible
      // incomplete cutover, never a falsely successful restore.
      requireSameMaintenanceFence(fenceApi, env, fenceOptions, initialFence);
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
        target: {
          mode: target.mode,
          projectRefSha256: digest(Buffer.from(target.projectRef))
        },
        maintenanceFence: {
          digest: initialFence.digest,
          openedAt: initialFence.openedAt,
          mode: initialFence.mode,
          source: initialFence.source,
          identity: initialFence.identity
        },
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
      rollback = await rollbackPlatformStorageObjects(storageJournal, {
        download,
        upload,
        remove,
        beforeWrite: () => requireSameMaintenanceFence(fenceApi, env, fenceOptions, initialFence)
      });
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
              : rollback.ok
                ? 'failed-before-repository-commit'
                : 'storage-outcome-unknown-manual-reconciliation-required',
          completedAt: now.toISOString(),
          namespaceId: before?.namespaceId || PLATFORM_NAMESPACE_ID,
          sourceManifestSha256: verified.manifestSha256,
          sourceRevision: verified.sourceRevision,
          priorRevision: currentRevision,
          repositoryCommitted,
          repositoryOutcomeUnknown,
          target: {
            mode: target.mode,
            projectRefSha256: digest(Buffer.from(target.projectRef))
          },
          maintenanceFenceDigest: initialFence?.digest || null,
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
    if (repositoryCommitted) {
      const postCommitError = new Error('Platform restore repository state was committed, but final reconciliation did not complete. The outcome requires manual reconciliation; do not retry this restore automatically.');
      postCommitError.code = 'PDL_PLATFORM_RECOVERY_POST_COMMIT_RECONCILIATION_REQUIRED';
      postCommitError.cause = error;
      postCommitError.evidenceFile = evidenceFile;
      postCommitError.recoveryOutcomeUnknown = true;
      postCommitError.repositoryCommitted = true;
      throw postCommitError;
    }
    if (!rollback.ok) {
      const rollbackError = new Error(`Platform restore outcome is unknown and manual reconciliation is required: ${rollback.failures.map(item => `${item.object}: ${item.error}`).join('; ')}`);
      rollbackError.cause = error;
      rollbackError.evidenceFile = evidenceFile;
      rollbackError.recoveryOutcomeUnknown = true;
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
    credentialsSafety: 'live-identities-merge-forward-backup-only-identities-inactive-sessions-and-temporary-tokens-cleared-support-grants-revoked',
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

function sanitizedCliResult(result) {
  const common = { ok: true, mode: result.mode };
  if (result.mode === 'export') {
    return {
      ...common,
      backupSet: path.basename(result.directory),
      revision: result.revision,
      contentHash: result.contentHash,
      manifestSha256: result.manifestSha256,
      objects: result.objects,
      verified: result.verified === true,
      targetMode: result.targetMode,
      maintenanceFenceDigest: result.maintenanceFenceDigest || null
    };
  }
  if (result.mode === 'verify' || result.mode === 'restore-preview') {
    return {
      ...common,
      createdAt: result.createdAt,
      sourceRevision: result.sourceRevision,
      contentHash: result.contentHash,
      objects: result.objects,
      missingObjects: result.missingObjects,
      complete: result.complete,
      ...(result.mode === 'restore-preview' ? { writesPerformed: false, nextStep: result.nextStep } : {})
    };
  }
  return {
    ...common,
    restored: result.restored === true,
    priorRevision: result.priorRevision,
    revision: result.revision,
    contentHash: result.contentHash,
    sourceContentHash: result.sourceContentHash,
    manifestSha256: result.manifestSha256,
    objectsVerified: result.objectsVerified,
    credentialsSafety: result.credentialsSafety,
    evidenceSet: result.preRestoreBackup?.directory ? path.basename(result.preRestoreBackup.directory) : null,
    preRestoreManifestSha256: result.preRestoreBackup?.manifestSha256 || null,
    preRestoreVerified: result.preRestoreBackup?.verified === true
  };
}

function sanitizedCliFailure(error) {
  const message = String(error?.message || error || '');
  let code = 'PDL_PLATFORM_RECOVERY_FAILED';
  if (error?.code === 'PDL_PLATFORM_RECOVERY_POST_COMMIT_RECONCILIATION_REQUIRED') code = error.code;
  else if (/argument|requires|choose one command|only valid|may only be provided|refusing a restore/i.test(message)) code = 'PDL_PLATFORM_RECOVERY_USAGE';
  else if (/PLATFORM_RECOVERY_(?:PRODUCTION|DISPOSABLE|TARGET)/i.test(message)) code = 'PDL_PLATFORM_RECOVERY_TARGET';
  else if (/MAINTENANCE_(?:FENCE|ENVIRONMENT|RUNTIME|PATH|EXPECTED)/i.test(message)) code = 'PDL_PLATFORM_RECOVERY_FENCE';
  else if (/outcome is unknown|manual reconciliation|rollback was incomplete|rollback conflict/i.test(message)) code = 'PDL_PLATFORM_RECOVERY_ROLLBACK_CONFLICT';
  else if (/manifest|SHA-256|canonical|inventory|byte count|integrity|namespace|snapshot filename|invalid entry/i.test(message)) code = 'PDL_PLATFORM_RECOVERY_INTEGRITY';
  else if (/revision conflict|precondition|PDL_PLATFORM_REVISION_CONFLICT/i.test(message)) code = 'PDL_PLATFORM_RECOVERY_CONFLICT';
  else if (/storage|object|download|upload|provider/i.test(message)) code = 'PDL_PLATFORM_RECOVERY_STORAGE';
  else if (/Supabase configuration|repository has not been initialized/i.test(message)) code = 'PDL_PLATFORM_RECOVERY_CONFIGURATION';
  return {
    ok: false,
    code,
    message: code === 'PDL_PLATFORM_RECOVERY_POST_COMMIT_RECONCILIATION_REQUIRED'
      ? 'Platform recovery committed repository state, but final verification did not complete. Do not retry automatically; use the retained evidence for manual reconciliation.'
      : code === 'PDL_PLATFORM_RECOVERY_USAGE'
        ? 'The platform recovery command arguments are invalid. Review the documented command and retry.'
      : code === 'PDL_PLATFORM_RECOVERY_TARGET'
        ? 'The explicit recovery target does not match this runtime. No recovery write was attempted.'
      : code === 'PDL_PLATFORM_RECOVERY_FENCE'
        ? 'The exact verified maintenance fence is missing or changed. Restore stopped without claiming success.'
        : code === 'PDL_PLATFORM_RECOVERY_ROLLBACK_CONFLICT'
          ? 'Restore stopped and rollback preserved a newer storage value. Human reconciliation is required.'
      : 'Platform recovery did not complete. No platform data, storage keys, paths, or provider details were printed.'
  };
}

async function main() {
  supabase.loadLocalEnv(path.resolve(__dirname, '..'));
  const args = parseArgs();
  const result = await execute(args);
  console.log(JSON.stringify(sanitizedCliResult(result), null, 2));
}

if (require.main === module) main().catch(error => {
  console.error(JSON.stringify(sanitizedCliFailure(error)));
  process.exitCode = 1;
});

module.exports = {
  parseArgs,
  assertExpectedManifest,
  execute,
  preparePlatformRestore,
  readStorageObject,
  restorePlatformStorageObjects,
  rollbackPlatformStorageObjects,
  sanitizedCliResult,
  sanitizedCliFailure
};
