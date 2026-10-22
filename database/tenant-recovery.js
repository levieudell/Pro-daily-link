'use strict';

const fs = require('node:fs');
const path = require('node:path');
const supabase = require('./supabase');
const maintenanceFence = require('./maintenance-fence');
const { canonicalHash, databaseCompanyId } = require('./transactional-repository');
const {
  createPortableBackup,
  verifyPortableBackup,
  readVerifiedTenantObjects,
  validateTenantRestoreSnapshot,
  validateTenantFinalRestoreSnapshot,
  normalizeRecoveredCompanyLogo,
  isMissingStorageObjectError,
  digest
} = require('./portable-backup');

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
  const expectedContentHash = option(argv, '--expected-content-hash').toLowerCase();
  const expectedServiceId = option(argv, '--expected-service-id');
  const expectedInstanceId = option(argv, '--expected-instance-id');
  const productionTarget = option(argv, '--production-target').toLowerCase();
  const disposableTarget = option(argv, '--disposable-target').toLowerCase();
  const apply = argv.includes('--apply');
  const valueFlags = new Set([
    '--company-id', '--output', '--backup', '--pre-restore-output', '--expected-revision',
    '--confirm-company-id', '--expected-manifest-sha256', '--expected-content-hash',
    '--expected-service-id', '--expected-instance-id', '--production-target', '--disposable-target'
  ]);
  const booleanFlags = new Set(['--apply']);
  for (let index = 1; index < argv.length; index += 1) {
    const token = String(argv[index]);
    if (valueFlags.has(token)) {
      index += 1;
      continue;
    }
    if (!booleanFlags.has(token)) throw new Error(`Unsupported tenant recovery argument: ${token.startsWith('--') ? token : '(value)'}.`);
  }
  if (argv.filter(value => value === '--apply').length > 1) throw new Error('--apply may only be provided once.');
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
    if (!SHA256.test(expectedContentHash)) throw new Error('restore requires --expected-content-hash <current-tenant-canonical-sha256>.');
    assertLexicallyDisjointRecoveryPaths(backup, preRestoreOutput);
  }
  if (expectedServiceId && !RENDER_SERVICE_ID.test(expectedServiceId)) throw new Error('--expected-service-id must be an exact Render service ID.');
  if (expectedInstanceId && !RENDER_INSTANCE_ID.test(expectedInstanceId)) throw new Error('--expected-instance-id must be an exact Render instance ID.');
  if (Boolean(expectedServiceId) !== Boolean(expectedInstanceId)) throw new Error('--expected-service-id and --expected-instance-id must be provided together.');
  if (productionTarget && !SUPABASE_PROJECT_REF.test(productionTarget)) throw new Error('--production-target must be an exact Supabase project reference.');
  if (disposableTarget && !SUPABASE_PROJECT_REF.test(disposableTarget)) throw new Error('--disposable-target must be an exact Supabase project reference.');
  if (['export', 'restore'].includes(command) && Boolean(productionTarget) === Boolean(disposableTarget)) {
    throw new Error(`${command} requires exactly one of --production-target <project-ref> or --disposable-target <project-ref>.`);
  }
  if (!['export', 'restore'].includes(command) && (productionTarget || disposableTarget)) throw new Error('Target flags are only valid with export or restore.');
  if (productionTarget && (!expectedServiceId || !expectedInstanceId)) throw new Error('--production-target requires exact --expected-service-id and --expected-instance-id values.');
  if (!productionTarget && (expectedServiceId || expectedInstanceId)) throw new Error('Render identity flags are only valid with --production-target.');
  if (apply && command !== 'restore') throw new Error('--apply is only valid with restore.');
  return {
    command, companyId, output, backup, preRestoreOutput, apply,
    expectedRevision: expectedRaw ? revision(expectedRaw, 'expected revision') : null,
    expectedManifestSha256, expectedContentHash, expectedServiceId, expectedInstanceId,
    productionTarget, disposableTarget, confirmCompanyId: confirmation.toLowerCase()
  };
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

function assertLexicallyDisjointRecoveryPaths(backup, preRestoreOutput) {
  const normalize = value => process.platform === 'win32' ? value.toLowerCase() : value;
  const source = normalize(path.resolve(String(backup || '')));
  const rollback = normalize(path.resolve(String(preRestoreOutput || '')));
  const relativeSourceToRollback = path.relative(source, rollback);
  const relativeRollbackToSource = path.relative(rollback, source);
  const contains = relative => relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
  if (contains(relativeSourceToRollback) || contains(relativeRollbackToSource)) {
    throw new Error('Restore source and pre-restore output must be filesystem-disjoint directories.');
  }
  return true;
}

function assertDisjointRecoveryPaths(backup, preRestoreOutput) {
  if (pathContains(backup, preRestoreOutput) || pathContains(preRestoreOutput, backup)) {
    throw new Error('Restore source and pre-restore output must be filesystem-disjoint directories.');
  }
  return true;
}

function assertRestorableSource(verified, expectedManifestSha256) {
  if (verified.manifestSha256 !== String(expectedManifestSha256 || '').toLowerCase()) {
    throw new Error('Tenant backup manifest does not match the independently recorded SHA-256.');
  }
  if (verified.authority?.mode !== 'transactional-primary' || !Number.isSafeInteger(Number(verified.authority?.repositoryRevision))) {
    throw new Error('Tenant restore source is not an authoritative transactional-primary export.');
  }
}

function configuredSupabaseProjectRef(env = process.env) {
  if (env.PDL_SUPABASE_ENABLED !== '1' || !String(env.SUPABASE_URL || '').trim()) throw new Error('TENANT_RECOVERY_TARGET_CONFIGURATION_MISSING');
  let url;
  try { url = new URL(String(env.SUPABASE_URL)); } catch {
    throw new Error('TENANT_RECOVERY_TARGET_CONFIGURATION_INVALID');
  }
  const match = /^([a-z0-9]{20})\.supabase\.co$/.exec(url.hostname.toLowerCase());
  if (url.protocol !== 'https:' || !match || url.username || url.password || url.port ||
      (url.pathname && url.pathname !== '/') || url.search || url.hash) {
    throw new Error('TENANT_RECOVERY_TARGET_CONFIGURATION_INVALID');
  }
  return match[1];
}

function validateRecoveryTarget(args, env = process.env) {
  const actualProjectRef = configuredSupabaseProjectRef(env);
  if (String(env.PDL_TRANSACTIONAL_DB || '').toLowerCase() !== 'primary') throw new Error('TENANT_RECOVERY_REPOSITORY_MODE_MISMATCH');
  const productionRef = String(env.PDL_PRODUCTION_SUPABASE_PROJECT_REF || '').trim().toLowerCase();
  if (args.productionTarget) {
    if (!SUPABASE_PROJECT_REF.test(productionRef) || productionRef !== args.productionTarget || actualProjectRef !== args.productionTarget) {
      throw new Error('TENANT_RECOVERY_PRODUCTION_TARGET_MISMATCH');
    }
    if (env.NODE_ENV !== 'production' || env.RENDER !== 'true' || env.RENDER_SERVICE_TYPE !== 'web' ||
        env.IS_PULL_REQUEST === 'true' || env.RENDER_SERVICE_ID !== args.expectedServiceId ||
        env.RENDER_INSTANCE_ID !== args.expectedInstanceId) {
      throw new Error('TENANT_RECOVERY_PRODUCTION_RUNTIME_MISMATCH');
    }
    return { mode: 'production', projectRef: actualProjectRef };
  }
  if (args.disposableTarget) {
    const disposableRef = String(env.PDL_DISPOSABLE_SUPABASE_PROJECT_REF || '').trim().toLowerCase();
    if (!SUPABASE_PROJECT_REF.test(productionRef) || !SUPABASE_PROJECT_REF.test(disposableRef) ||
        productionRef === disposableRef || disposableRef !== args.disposableTarget || actualProjectRef !== args.disposableTarget) {
      throw new Error('TENANT_RECOVERY_DISPOSABLE_TARGET_MISMATCH');
    }
    if (env.NODE_ENV === 'production' || env.RENDER === 'true' || actualProjectRef === productionRef) {
      throw new Error('TENANT_RECOVERY_DISPOSABLE_TARGET_FORBIDDEN');
    }
    return { mode: 'disposable', projectRef: actualProjectRef };
  }
  throw new Error('TENANT_RECOVERY_TARGET_REQUIRED');
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
  if (path.dirname(directory) !== root) throw new Error('Refusing to invalidate a recovery set outside its requested output directory.');
  const checksum = path.join(directory, 'manifest.sha256');
  try { fs.unlinkSync(checksum); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  try { fs.rmSync(directory, { recursive: true, force: true }); } catch {}
}

function repository() {
  if (!supabase.configured()) throw new Error('Server-side Supabase configuration is missing.');
  return {
    load: companyId => supabase.loadTransactionalSnapshot(companyId),
    save: (snapshot, { expectedRevision }) => supabase.saveTransactionalSnapshot(snapshot, expectedRevision)
  };
}

const TRANSIENT_IDENTITY_FIELDS = Object.freeze([
  'resetTokenHash', 'resetExpiresAt', 'resetRequestedAt',
  'setupHash', 'setupSalt', 'setupExpiresAt', 'setupCode',
  'emailVerificationTokenHash', 'emailVerificationExpiresAt',
  'temporaryPassword', 'temporaryPasswordHash', 'temporaryPasswordExpiresAt'
]);
const TENANT_SCOPED_ROLES = new Set(['project_manager', 'foreman', 'field']);
const TENANT_SCOPE_FIELDS = Object.freeze([
  'memberId', 'projectIds', 'assignedCrews', 'permissions', 'crew', 'crewId',
  'crewIds', 'assignedCrewIds', 'allowedProjectIds'
]);

// These fields are the live commercial/access and account-lifecycle
// envelope. Restoring business records must not revive a cancelled
// subscription, repeat a trial, reattach retired Stripe state, unlock an
// archived/closing company, or roll back the pricing-visibility policy.
const TENANT_COMPANY_FORWARD_ONLY_FIELDS = Object.freeze([
  'plan', 'billingCycle', 'planPrice', 'billingExempt', 'accountType',
  'subscriptionStatus', 'trialEndsAt', 'nextBillingAt', 'stripeCustomerId',
  'stripeSubscriptionId', 'stripeCheckoutSessionId', 'stripeTrialUsed',
  'stripeFreePeriod', 'retiredStripeSubscriptionIds', 'stripeWebhookEvents',
  'pendingCheckout', 'founder', 'cohort', 'discountPercent', 'commercialNote',
  'platformAssistedSetupSync', 'features', 'demo', 'mcpConnector',
  'platformGrowthSync', 'legalAcceptance', 'emailVerificationRequiredAt',
  'pricingAccess', 'archivedDuplicate',
  'archivedAt', 'archivedReason', 'closureHold', 'deletionRequest'
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
      throw new Error(`TENANT_RECOVERY_IDENTITY_AMBIGUOUS:${label}`);
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

function disableBackupOnlyTenantIdentity(user, restoredAt, reason = 'backup-only-identity') {
  const clean = { ...user };
  // Backup-only accounts are historical records, not restored login
  // principals. Scrub both today's credential fields and conservatively named
  // future credential material before requiring a controlled re-enrollment.
  for (const key of Object.keys(clean)) {
    if (/(?:password|passcode|credential|token|secret|session|setup|verification|mfa|totp|webauthn)/i.test(key)) delete clean[key];
  }
  for (const key of TENANT_SCOPE_FIELDS) delete clean[key];
  clean.status = 'Deactivated';
  clean.mustSetPassword = true;
  clean.recoveryAccessState = 'reenrollment-required';
  clean.recoveryDeactivationReason = reason;
  clean.recoveryDeactivatedAt = restoredAt;
  return clean;
}

function mergeSafeCurrentTenantIdentity(user, restoredAt) {
  const clean = stripTransientIdentityArtifacts(structuredClone(user));
  if (!TENANT_SCOPED_ROLES.has(clean.role)) return clean;
  // Numeric project/member IDs and crew names are not stable across a
  // historical restore. Quarantine scoped accounts until an owner explicitly
  // binds them to the restored people/projects/crews and re-enrolls access.
  return disableBackupOnlyTenantIdentity(clean, restoredAt, 'historical-scope-reconciliation-required');
}

function mergeForwardTenantIdentities(sourceUsers, currentUsers, restoredAt) {
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
    if (candidates.size > 1) throw new Error('TENANT_RECOVERY_IDENTITY_AMBIGUOUS:cross-key');
    if (!candidates.size) return disableBackupOnlyTenantIdentity(user, restoredAt);
    const index = [...candidates][0];
    if (used.has(index)) throw new Error('TENANT_RECOVERY_IDENTITY_AMBIGUOUS:duplicate-match');
    used.add(index);
    // The live account row is the identity authority. Scoped authorization is
    // handled more conservatively below because historical project/member IDs
    // and crew names are not durable identities across a restore.
    return mergeSafeCurrentTenantIdentity(current[index], restoredAt);
  });
  current.forEach((user, index) => {
    if (!used.has(index)) merged.push(mergeSafeCurrentTenantIdentity(user, restoredAt));
  });
  return merged;
}

function preserveCurrentTenantCompanyEnvelope(restoredCompany, currentCompany) {
  if (!restoredCompany || !currentCompany) return;
  for (const key of TENANT_COMPANY_FORWARD_ONLY_FIELDS) {
    if (Object.hasOwn(currentCompany, key)) restoredCompany[key] = structuredClone(currentCompany[key]);
    else delete restoredCompany[key];
  }
}

function requireInitializedTenantRestoreTarget(before, companyId) {
  if (!before?.snapshot) {
    throw new Error('TENANT_RECOVERY_TARGET_OWNER_REQUIRED: initialize the exact target tenant with an active break-glass owner before restore.');
  }
  try {
    validateTenantRestoreSnapshot(before.snapshot);
  } catch (cause) {
    const error = new Error('TENANT_RECOVERY_TARGET_OWNER_REQUIRED: the exact target tenant must be a valid initialized snapshot with at least one active owner before restore.');
    error.cause = cause;
    throw error;
  }
  if (databaseCompanyId(before.snapshot.company?.id) !== companyId) {
    throw new Error('Transactional repository returned the wrong tenant.');
  }
  const breakGlassOwner = before.snapshot.users.find(user => user.role === 'owner' && user.status === 'Active' &&
    user.mustSetPassword !== true && identityPart(user.passwordHash) && identityPart(user.passwordSalt));
  if (!breakGlassOwner) {
    throw new Error('TENANT_RECOVERY_TARGET_OWNER_REQUIRED: the exact target tenant needs an active break-glass owner with a current permanent credential before restore.');
  }
  return before.snapshot;
}

function prepareTenantRestore(snapshot, currentSnapshot = {}, restoredAt = new Date().toISOString()) {
  const restored = structuredClone(snapshot);
  normalizeRecoveredCompanyLogo(restored);
  restored.sessions = [];
  restored.users = mergeForwardTenantIdentities(restored.users, currentSnapshot?.users, restoredAt);
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
  if (restored.company) {
    preserveCurrentTenantCompanyEnvelope(restored.company, currentSnapshot?.company);
  }
  // Keep the pure preparation helper fail closed as well as the command path.
  // That prevents future callers from persisting a merge without enforcing the
  // post-merge authorization invariant.
  return validateTenantFinalRestoreSnapshot(restored);
}

const storageObjectId = object => `${object.bucket}/${object.objectKey}`;
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

async function verifyExpectedTenantStorageObjects(expectedObjects, download) {
  if (!expectedObjects.length) return 0;
  if (typeof download !== 'function') throw new Error('Tenant storage verification requires a server-side download adapter.');
  for (const object of expectedObjects) {
    const current = await readStorageObject(download, object);
    if (!matchesObject(current, object)) {
      const error = new Error(`Tenant storage object changed before repository commit: ${storageObjectId(object)}`);
      error.code = 'PDL_TENANT_STORAGE_CONCURRENT_CHANGE';
      throw error;
    }
  }
  return expectedObjects.length;
}

async function restoreTenantStorageObjects({ backupDirectory, verification, rollbackBackup, download, upload, journal = [], beforeWrite = null }) {
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
      if (beforeWrite) beforeWrite(item);
      await upload(item.source.bucket, item.source.objectKey, item.source.data, item.source.contentType, item.action === 'overwrite');
      journal.push(item);
    } catch (error) {
      try {
        const afterFailure = await readStorageObject(download, item.source);
        if (matchesObject(afterFailure, item.source)) {
          journal.push(item);
        } else {
          const unchanged = item.action === 'create' ? !afterFailure.exists : matchesObject(afterFailure, item.prior);
          if (!unchanged) {
            error.storageOutcomeUnknown = item.id;
            error.storageInspectionError = 'destination contains bytes that belong to neither the pre-restore state nor this restore target';
          }
        }
      } catch (inspectionError) {
        error.storageOutcomeUnknown = item.id;
        error.storageInspectionError = inspectionError.message;
      }
      throw Object.assign(error, { storageJournal: journal });
    }
    if (!matchesObject(await readStorageObject(download, item.source), item.source)) throw Object.assign(new Error(`Storage restore verification failed for ${item.id}.`), { storageJournal: journal });
  }
  const verified = await verifyExpectedTenantStorageObjects(sourceObjects, download);
  return {
    total: plan.length,
    created: plan.filter(item => item.action === 'create').length,
    overwritten: plan.filter(item => item.action === 'overwrite').length,
    unchanged: plan.filter(item => item.action === 'unchanged').length,
    verified,
    objects: plan.map(item => ({ bucket: item.source.bucket, objectKey: item.source.objectKey, action: item.action, bytes: item.source.bytes, sha256: item.source.sha256 })),
    journal
  };
}

function maintenanceFenceFailure(error) {
  return error?.code === 'MAINTENANCE_FENCE_CHANGED' || /^MAINTENANCE_(?:FENCE|ENVIRONMENT|RUNTIME|PATH|EXPECTED)/.test(String(error?.message || error || ''));
}

async function rollbackTenantStorageObjects(journal, { download, upload, remove, beforeWrite = null }) {
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
          conflict.code = 'PDL_TENANT_RESTORE_ROLLBACK_CONFLICT';
          throw conflict;
        }
        if (typeof remove !== 'function') throw new Error('Storage remove adapter is unavailable.');
        if (beforeWrite) beforeWrite(item, 'remove-created-object');
        await remove(item.source.bucket, item.source.objectKey);
        if ((await readStorageObject(download, item.source)).exists) throw new Error('new object still exists after removal');
      } else if (item.action === 'overwrite') {
        const current = await readStorageObject(download, item.source);
        if (matchesObject(current, item.rollback)) continue;
        if (!matchesObject(current, item.source)) {
          const conflict = new Error('rollback conflict: current bytes no longer match this restore target');
          conflict.code = 'PDL_TENANT_RESTORE_ROLLBACK_CONFLICT';
          throw conflict;
        }
        if (beforeWrite) beforeWrite(item, 'restore-prior-object');
        await upload(item.rollback.bucket, item.rollback.objectKey, item.rollback.data, item.rollback.contentType, true);
        if (!matchesObject(await readStorageObject(download, item.rollback), item.rollback)) throw new Error('prior object bytes did not reconcile');
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
  const companyId = databaseCompanyId(args.companyId);
  if (String(args.companyId || '').toLowerCase() !== companyId) throw new Error('Recovery requires the exact tenant database UUID.');
  if (args.command === 'restore') {
    if (!args.apply) throw new Error('Refusing a tenant restore without explicit apply authorization.');
    if (String(args.confirmCompanyId || '').toLowerCase() !== companyId) throw new Error('Restore requires exact tenant UUID confirmation.');
    revision(args.expectedRevision, 'expected revision');
    if (!SHA256.test(String(args.expectedContentHash || ''))) throw new Error('Restore requires the exact current tenant content hash.');
    assertLexicallyDisjointRecoveryPaths(args.backup, args.preRestoreOutput);
  }
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
      ...(args.command === 'restore-preview' ? {
        nextStep: 'Run restore with --apply, the exact target project, company UUID, current revision, and current content hash after approval.',
        writesPerformed: false
      } : {})
    };
  }

  // This is deliberately the first runtime operation for export/restore. A
  // wrong project or runtime must fail before repository or Storage I/O.
  const target = validateRecoveryTarget(args, env);
  if (args.command === 'restore') assertDisjointRecoveryPaths(args.backup, args.preRestoreOutput);
  const fenceOptions = {
    root: maintenanceRoot,
    expectedServiceId: args.expectedServiceId || '',
    expectedInstanceId: args.expectedInstanceId || ''
  };
  const initialFence = (args.command === 'restore' || target.mode === 'production')
    ? fenceApi.requireVerifiedFence(env, fenceOptions)
    : null;
  const store = repo || repository();

  if (args.command === 'export') {
    let backup = null;
    try {
      const current = await store.load(companyId);
      const snapshot = current?.snapshot;
      if (!snapshot) throw new Error(`Authoritative tenant not found: ${companyId}`);
      if (databaseCompanyId(snapshot.company?.id) !== companyId) throw new Error('Transactional repository returned the wrong tenant.');
      const currentRevision = revision(current.revision, 'tenant repository revision');
      const contentHash = canonicalHash(snapshot);
      if (current.contentHash !== contentHash) throw new Error('Authoritative tenant content hash does not match the exported snapshot.');
      const authority = { mode: 'transactional-primary', repositoryRevision: currentRevision, contentHash };
      backup = await createPortableBackup({
        snapshot,
        authority,
        destination: path.resolve(args.output),
        download,
        now,
        beforeComplete: async ({ manifest }) => {
          const capturedObjects = (manifest.objects || []).filter(object => object.missing !== true);
          await verifyExpectedTenantStorageObjects(capturedObjects, download);
          const afterCapture = await store.load(companyId);
          if (!afterCapture || afterCapture.revision !== currentRevision ||
              afterCapture.contentHash !== contentHash || canonicalHash(afterCapture.snapshot) !== contentHash ||
              databaseCompanyId(afterCapture.snapshot?.company?.id) !== companyId) {
            throw new Error('Tenant export source changed during capture; the recovery set was not accepted.');
          }
          if (initialFence) requireSameMaintenanceFence(fenceApi, env, fenceOptions, initialFence);
        }
      });
      if (initialFence) requireSameMaintenanceFence(fenceApi, env, fenceOptions, initialFence);
      return {
        mode: 'export',
        directory: backup.directory,
        companyId,
        authority: backup.manifest.authority,
        contentHash,
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

  const verified = verifyPortableBackup(path.resolve(args.backup), { expectedCompanyId: companyId });
  assertRestorableSource(verified, args.expectedManifestSha256);
  const sourceObjects = readVerifiedTenantObjects(path.resolve(args.backup), verified);
  const before = await store.load(companyId);
  const currentRevision = before?.revision ?? 0;
  if (currentRevision !== args.expectedRevision) throw new Error(`Restore precondition failed: expected current revision ${args.expectedRevision}, found ${currentRevision}.`);
  // A disposable target is still a security boundary. It must be deliberately
  // seeded with a valid active owner so recovery can merge a live access
  // envelope forward and so the rollback set is itself restorable. This check
  // occurs before creating a directory or touching Storage.
  const rollbackSnapshot = requireInitializedTenantRestoreTarget(before, companyId);
  const currentContentHash = canonicalHash(rollbackSnapshot);
  if (before.contentHash !== currentContentHash) throw new Error('Current tenant repository content hash does not match its snapshot.');
  if (currentContentHash !== args.expectedContentHash) throw new Error('Restore precondition failed: current tenant content hash does not match the independently recorded value.');
  const restoredSnapshot = prepareTenantRestore(verified.snapshot, rollbackSnapshot, now.toISOString());
  // Validate the actual merge result, not only the source set. A malformed
  // live envelope or merge can never get as far as filesystem/Storage writes.
  validateTenantFinalRestoreSnapshot(restoredSnapshot);
  const expectedHash = canonicalHash(restoredSnapshot);
  const alreadyRestored = before.contentHash === expectedHash && canonicalHash(before.snapshot) === expectedHash;
  const rollbackAuthority = { mode: 'transactional-primary', repositoryRevision: currentRevision, contentHash: currentContentHash };
  const preRestoreBackup = await createPortableBackup({
    snapshot: rollbackSnapshot,
    authority: rollbackAuthority,
    destination: path.resolve(args.preRestoreOutput),
    download,
    allowMissingObjects: true,
    now
  });
  const afterPreRestoreCapture = await store.load(companyId);
  if (!afterPreRestoreCapture || afterPreRestoreCapture.revision !== currentRevision ||
      afterPreRestoreCapture.contentHash !== currentContentHash || canonicalHash(afterPreRestoreCapture.snapshot) !== currentContentHash) {
    throw new Error('Tenant changed while the pre-restore recovery set was captured. No restore writes were attempted.');
  }
  const storageJournal = [];
  let storage = null;
  let saved = null;
  let after = null;
  let repositoryCommitted = alreadyRestored;
  let repositoryOutcomeUnknown = false;
  let evidenceFile = null;
  try {
    if (initialFence) requireSameMaintenanceFence(fenceApi, env, fenceOptions, initialFence);
    storage = await restoreTenantStorageObjects({
      backupDirectory: path.resolve(args.backup),
      verification: verified,
      rollbackBackup: preRestoreBackup,
      download,
      upload,
      journal: storageJournal,
      beforeWrite: initialFence ? () => requireSameMaintenanceFence(fenceApi, env, fenceOptions, initialFence) : null
    });
    // This is the final read of every destination object, including objects
    // that were already identical. No asynchronous work occurs between this
    // verification, the synchronous fence check, and the repository CAS.
    storage.verified = await verifyExpectedTenantStorageObjects(sourceObjects, download);
    if (initialFence) requireSameMaintenanceFence(fenceApi, env, fenceOptions, initialFence);
    if (alreadyRestored) {
      saved = before;
    } else {
      try {
        saved = await store.save(restoredSnapshot, {
          expectedRevision: args.expectedRevision,
          changedBy: `verified-restore:${verified.manifestSha256.slice(0, 16)}`
        });
        repositoryCommitted = true;
      } catch (saveError) {
        let observed = null;
        let observedError = null;
        for (let attempt = 0; attempt < 3 && !observed; attempt += 1) {
          try { observed = await store.load(companyId); } catch (error) { observedError = error; }
        }
        if (observed && observed.revision > args.expectedRevision && observed.contentHash === expectedHash &&
            canonicalHash(observed.snapshot) === expectedHash && databaseCompanyId(observed.snapshot?.company?.id) === companyId) {
          saved = observed;
          repositoryCommitted = true;
        } else if (!observed || observed.revision > args.expectedRevision) {
          repositoryOutcomeUnknown = true;
          const uncertain = new Error(`Tenant repository commit outcome could not be verified; storage was retained for manual reconciliation. ${observedError?.message || saveError.message}`);
          uncertain.cause = saveError;
          uncertain.repositoryOutcomeUnknown = true;
          throw uncertain;
        } else {
          throw saveError;
        }
      }
    }
    after = await store.load(companyId);
    if (!after || after.revision !== saved.revision || after.contentHash !== expectedHash ||
        canonicalHash(after.snapshot) !== expectedHash || databaseCompanyId(after.snapshot?.company?.id) !== companyId) {
      throw new Error('Tenant restore reconciliation failed after the transactional write.');
    }
    if (initialFence) requireSameMaintenanceFence(fenceApi, env, fenceOptions, initialFence);
    evidenceFile = writeRestoreEvidence(preRestoreBackup.directory, {
      version: 1,
      status: 'verified',
      completedAt: now.toISOString(),
      companyId,
      sourceManifestSha256: verified.manifestSha256,
      sourceAuthority: verified.authority,
      priorRevision: currentRevision,
      priorContentHash: currentContentHash,
      restoredRevision: after.revision,
      restoredContentHash: after.contentHash,
      alreadyRestored,
      target: { mode: target.mode, projectRefSha256: digest(Buffer.from(target.projectRef)) },
      maintenanceFence: initialFence ? {
        digest: initialFence.digest,
        openedAt: initialFence.openedAt,
        mode: initialFence.mode,
        source: initialFence.source,
        identity: initialFence.identity
      } : null,
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
  } catch (error) {
    let rollback = { ok: true, attempted: 0, failures: [] };
    const unknownStorage = error.storageOutcomeUnknown
      ? [{ object: error.storageOutcomeUnknown, error: `provider outcome is unknown: ${error.storageInspectionError || 'destination could not be reconciled'}` }]
      : [];
    if (!repositoryCommitted && !repositoryOutcomeUnknown && storageJournal.length) {
      rollback = await rollbackTenantStorageObjects(storageJournal, {
        download,
        upload,
        remove,
        beforeWrite: () => requireSameMaintenanceFence(fenceApi, env, fenceOptions, initialFence)
      });
    }
    if (repositoryOutcomeUnknown) {
      rollback = { ok: false, attempted: 0, failures: [{ object: 'tenant-repository', error: 'commit outcome is unknown; storage intentionally retained' }] };
    } else if (unknownStorage.length) {
      rollback = { ...rollback, ok: false, failures: [...rollback.failures, ...unknownStorage] };
    }
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
        companyId,
        sourceManifestSha256: verified.manifestSha256,
        priorRevision: currentRevision,
        priorContentHash: currentContentHash,
        repositoryCommitted,
        repositoryOutcomeUnknown,
        target: { mode: target.mode, projectRefSha256: digest(Buffer.from(target.projectRef)) },
        maintenanceFenceDigest: initialFence?.digest || null,
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
    if (repositoryCommitted) {
      const postCommitError = new Error('Tenant restore repository state was committed, but final reconciliation did not complete. The outcome requires manual reconciliation; do not retry this restore automatically.');
      postCommitError.code = 'PDL_TENANT_RECOVERY_POST_COMMIT_RECONCILIATION_REQUIRED';
      postCommitError.cause = error;
      postCommitError.evidenceFile = evidenceFile;
      postCommitError.recoveryOutcomeUnknown = true;
      postCommitError.repositoryCommitted = true;
      throw postCommitError;
    }
    if (!rollback.ok) {
      const rollbackError = new Error(`Tenant restore outcome is unknown and manual reconciliation is required: ${rollback.failures.map(item => `${item.object}: ${item.error}`).join('; ')}`);
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
    alreadyRestored,
    companyId,
    priorRevision: currentRevision,
    priorContentHash: currentContentHash,
    revision: after.revision,
    contentHash: after.contentHash,
    sourceContentHash: verified.contentHash,
    sourceAuthority: verified.authority,
    manifestSha256: verified.manifestSha256,
    targetMode: target.mode,
    maintenanceFenceDigest: initialFence?.digest || null,
    storage: {
      total: storage.total,
      created: storage.created,
      overwritten: storage.overwritten,
      unchanged: storage.unchanged,
      verified: storage.verified
    },
    credentialsSafety: 'live-identities-merge-forward-backup-only-identities-deactivated-sessions-and-temporary-tokens-cleared-external-links-revoked',
    evidenceFile,
    preRestoreBackup: {
      directory: preRestoreBackup.directory,
      manifestSha256: preRestoreBackup.manifestSha256,
      verified: preRestoreBackup.verification.ok,
      complete: preRestoreBackup.verification.missingObjects === 0,
      missingObjects: preRestoreBackup.verification.missingObjects
    }
  };
}

function sanitizedCliResult(result) {
  const common = { ok: true, mode: result.mode, companyId: result.companyId };
  if (result.mode === 'export') {
    return {
      ...common,
      backupSet: path.basename(result.directory),
      authority: result.authority?.mode,
      repositoryRevision: result.authority?.repositoryRevision,
      contentHash: result.contentHash,
      manifestSha256: result.manifestSha256,
      objects: result.objects,
      verified: result.verified === true
    };
  }
  if (result.mode === 'verify' || result.mode === 'restore-preview') {
    return {
      ...common,
      sourceAuthority: result.sourceAuthority?.mode,
      repositoryRevision: result.sourceAuthority?.repositoryRevision,
      contentHash: result.contentHash,
      manifestSha256: result.manifestSha256,
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
    priorContentHash: result.priorContentHash,
    revision: result.revision,
    contentHash: result.contentHash,
    sourceContentHash: result.sourceContentHash,
    manifestSha256: result.manifestSha256,
    objectsVerified: result.storage?.verified,
    credentialsSafety: result.credentialsSafety,
    evidenceSet: result.preRestoreBackup?.directory ? path.basename(result.preRestoreBackup.directory) : null,
    preRestoreManifestSha256: result.preRestoreBackup?.manifestSha256 || null,
    preRestoreVerified: result.preRestoreBackup?.verified === true
  };
}

function sanitizedCliFailure(error) {
  const message = String(error?.message || error || '');
  let code = 'PDL_TENANT_RECOVERY_FAILED';
  if (error?.code === 'PDL_TENANT_RECOVERY_POST_COMMIT_RECONCILIATION_REQUIRED') code = error.code;
  else if (/argument|requires|choose one command|only valid|may only be provided|refusing a tenant restore|filesystem-disjoint/i.test(message)) code = 'PDL_TENANT_RECOVERY_USAGE';
  else if (/TENANT_RECOVERY_(?:PRODUCTION|DISPOSABLE|TARGET|REPOSITORY)/i.test(message)) code = 'PDL_TENANT_RECOVERY_TARGET';
  else if (/MAINTENANCE_(?:FENCE|ENVIRONMENT|RUNTIME|PATH|EXPECTED)/i.test(message)) code = 'PDL_TENANT_RECOVERY_FENCE';
  else if (/outcome is unknown|rollback conflict|manual reconciliation/i.test(message)) code = 'PDL_TENANT_RECOVERY_OUTCOME_UNKNOWN';
  else if (/manifest|SHA-256|canonical|inventory|byte count|integrity|snapshot filename|invalid entry|backup changed/i.test(message)) code = 'PDL_TENANT_RECOVERY_INTEGRITY';
  else if (/revision conflict|precondition|PDL_REVISION_CONFLICT/i.test(message)) code = 'PDL_TENANT_RECOVERY_CONFLICT';
  else if (/storage|object|download|upload|provider/i.test(message)) code = 'PDL_TENANT_RECOVERY_STORAGE';
  else if (/Supabase configuration|Authoritative tenant not found/i.test(message)) code = 'PDL_TENANT_RECOVERY_CONFIGURATION';
  return {
    ok: false,
    code,
    message: code === 'PDL_TENANT_RECOVERY_POST_COMMIT_RECONCILIATION_REQUIRED'
      ? 'Tenant recovery committed repository state, but final verification did not complete. Do not retry automatically; use the retained evidence for manual reconciliation.'
      : code === 'PDL_TENANT_RECOVERY_USAGE'
        ? 'The tenant recovery command arguments are invalid. Review the documented command and retry.'
      : code === 'PDL_TENANT_RECOVERY_TARGET'
        ? 'The explicit recovery target does not match this runtime. No recovery write was attempted.'
        : code === 'PDL_TENANT_RECOVERY_FENCE'
          ? 'The exact verified maintenance fence is missing or changed. Recovery stopped without claiming success.'
          : code === 'PDL_TENANT_RECOVERY_OUTCOME_UNKNOWN'
            ? 'Recovery stopped without changing newer data. Human reconciliation is required before any retry.'
            : 'Tenant recovery did not complete. No tenant data, storage keys, paths, or provider details were printed.'
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
  execute,
  prepareTenantRestore,
  readStorageObject,
  restoreTenantStorageObjects,
  rollbackTenantStorageObjects,
  verifyExpectedTenantStorageObjects,
  assertRestorableSource,
  assertDisjointRecoveryPaths,
  validateRecoveryTarget,
  sanitizedCliResult,
  sanitizedCliFailure
};
