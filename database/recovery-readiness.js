'use strict';

const crypto = require('node:crypto');
const { opaqueTenantRef, tenantSnapshotDisposition } = require('./shadow-reconciliation');

const SCHEMA = 'pdl-recovery-readiness/v1';
const POINTER_SCHEMA = 'pdl-recovery-readiness-pointer/v1';
const POPULATION_SCHEMA = 'pdl-recovery-population/v1';
const EVIDENCE_BUCKET = 'tenant-backups';
const POINTER_OBJECT_KEY = 'recovery-readiness/current.json';
const SHA256 = /^[a-f0-9]{64}$/;
const OPAQUE_TENANT_REF = /^[a-f0-9]{24}$/;
const PROJECT_REF = /^[a-z0-9]{20}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_EVIDENCE_BYTES = 2 * 1024 * 1024;
const DEFAULT_ATTESTATION_FRESHNESS_MS = 36 * 60 * 60 * 1000;
const DEFAULT_BACKUP_FRESHNESS_MS = 36 * 60 * 60 * 1000;
const DEFAULT_RESTORE_FRESHNESS_MS = 35 * 24 * 60 * 60 * 1000;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
const MAX_TENANTS = 10_000;

class RecoveryReadinessError extends Error {
  constructor(code) {
    super(code);
    this.name = 'RecoveryReadinessError';
    this.code = code;
  }
}

function fail(code) {
  throw new RecoveryReadinessError(code);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function productionTargetSha256(projectRef) {
  const normalized = String(projectRef || '').trim().toLowerCase();
  if (!PROJECT_REF.test(normalized)) fail('target_unverified');
  return sha256(`pdl-recovery-target:v1:${normalized}`);
}

function populationSha256(tenantRefs) {
  if (!Array.isArray(tenantRefs) || tenantRefs.length > MAX_TENANTS ||
      tenantRefs.some(ref => !OPAQUE_TENANT_REF.test(String(ref)))) fail('evidence_invalid');
  return sha256(JSON.stringify({ schema: POPULATION_SCHEMA, tenantRefs: [...tenantRefs].sort() }));
}

function exactKeys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('evidence_invalid');
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) fail('evidence_invalid');
}

function timestamp(value, now, freshnessMs, code) {
  const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value ||
      parsed > now + MAX_FUTURE_SKEW_MS || now - parsed > freshnessMs) fail(code);
  return parsed;
}

function validatePortable(value, now) {
  exactKeys(value, ['manifestSha256', 'verifiedAt', 'complete', 'missingObjects']);
  if (!SHA256.test(String(value.manifestSha256)) || value.complete !== true || value.missingObjects !== 0) {
    fail('backup_incomplete');
  }
  return timestamp(value.verifiedAt, now, DEFAULT_BACKUP_FRESHNESS_MS, 'backup_stale');
}

function validateIndependentCopy(value, manifestSha256, now) {
  exactKeys(value, ['manifestSha256', 'verifiedAt', 'destinationEvidenceSha256']);
  if (value.manifestSha256 !== manifestSha256 || !SHA256.test(String(value.destinationEvidenceSha256))) {
    fail('independent_copy_unverified');
  }
  return timestamp(value.verifiedAt, now, DEFAULT_BACKUP_FRESHNESS_MS, 'independent_copy_stale');
}

function validateRestoreDrill(value, now) {
  exactKeys(value, ['verifiedAt', 'evidenceSha256', 'targetDestroyedAt']);
  if (!SHA256.test(String(value.evidenceSha256))) fail('restore_unverified');
  const verifiedAt = timestamp(value.verifiedAt, now, DEFAULT_RESTORE_FRESHNESS_MS, 'restore_stale');
  const destroyedAt = timestamp(value.targetDestroyedAt, now, DEFAULT_RESTORE_FRESHNESS_MS, 'restore_stale');
  if (destroyedAt < verifiedAt) fail('restore_unverified');
  return destroyedAt;
}

function validateRecoveryEntry(value, { tenant = false, now, attestedAt }) {
  const keys = tenant
    ? ['tenantRef', 'revision', 'contentHash', 'portable', 'independentCopy', 'restoreDrill']
    : ['revision', 'contentHash', 'portable', 'independentCopy', 'restoreDrill'];
  exactKeys(value, keys);
  if (tenant && !OPAQUE_TENANT_REF.test(String(value.tenantRef))) fail('evidence_invalid');
  if (!Number.isSafeInteger(value.revision) || value.revision < 0 || !SHA256.test(String(value.contentHash))) {
    fail('evidence_invalid');
  }
  const backupAt = validatePortable(value.portable, now);
  const copiedAt = validateIndependentCopy(value.independentCopy, value.portable.manifestSha256, now);
  const destroyedAt = validateRestoreDrill(value.restoreDrill, now);
  if (copiedAt < backupAt || attestedAt < copiedAt || attestedAt < destroyedAt) fail('evidence_invalid');
}

function validateAttestation(attestation, { targetSha256, now = Date.now() } = {}) {
  exactKeys(attestation, ['schema', 'attestedAt', 'productionTargetSha256', 'populationSha256', 'tenants', 'platform']);
  if (attestation.schema !== SCHEMA || !SHA256.test(String(attestation.productionTargetSha256)) ||
      attestation.productionTargetSha256 !== targetSha256 || !SHA256.test(String(attestation.populationSha256)) ||
      !Array.isArray(attestation.tenants) || attestation.tenants.length > MAX_TENANTS) {
    fail('evidence_invalid');
  }
  const attestedAt = timestamp(attestation.attestedAt, now, DEFAULT_ATTESTATION_FRESHNESS_MS, 'attestation_stale');
  const refs = [];
  let previous = '';
  for (const tenant of attestation.tenants) {
    validateRecoveryEntry(tenant, { tenant: true, now, attestedAt });
    if (tenant.tenantRef <= previous) fail('evidence_invalid');
    previous = tenant.tenantRef;
    refs.push(tenant.tenantRef);
  }
  validateRecoveryEntry(attestation.platform, { now, attestedAt });
  if (attestation.populationSha256 !== populationSha256(refs)) fail('population_mismatch');
  return attestation;
}

async function responseBytes(response, maxBytes) {
  if (!response || typeof response.arrayBuffer !== 'function') fail('evidence_unavailable');
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && (declared < 1 || declared > maxBytes)) fail('evidence_unavailable');
  let bytes;
  try { bytes = Buffer.from(await response.arrayBuffer()); } catch { fail('evidence_unavailable'); }
  if (bytes.length < 1 || bytes.length > maxBytes) fail('evidence_unavailable');
  return bytes;
}

async function loadRemoteAttestation(download, { now = Date.now(), targetSha256, publicKey } = {}) {
  if (typeof download !== 'function') fail('evidence_unavailable');
  let pointerResponse;
  try { pointerResponse = await download(EVIDENCE_BUCKET, POINTER_OBJECT_KEY); } catch { fail('evidence_unavailable'); }
  const pointerBytes = await responseBytes(pointerResponse, 2048);
  let pointer;
  try { pointer = JSON.parse(pointerBytes.toString('utf8')); } catch { fail('evidence_invalid'); }
  exactKeys(pointer, ['schema', 'attestationObjectKey', 'attestationSha256', 'attestationSignature', 'updatedAt']);
  const match = /^recovery-readiness\/attestations\/([a-f0-9]{64})\.json$/.exec(String(pointer.attestationObjectKey || ''));
  if (pointer.schema !== POINTER_SCHEMA || !match || !SHA256.test(String(pointer.attestationSha256)) ||
      match[1] !== pointer.attestationSha256) fail('evidence_invalid');
  const pointerUpdatedAt = timestamp(pointer.updatedAt, now, DEFAULT_ATTESTATION_FRESHNESS_MS, 'attestation_stale');
  let attestationResponse;
  try { attestationResponse = await download(EVIDENCE_BUCKET, pointer.attestationObjectKey); } catch { fail('evidence_unavailable'); }
  const bytes = await responseBytes(attestationResponse, MAX_EVIDENCE_BYTES);
  if (sha256(bytes) !== pointer.attestationSha256) fail('evidence_checksum_mismatch');
  let signature;
  try { signature = Buffer.from(String(pointer.attestationSignature || ''), 'base64'); } catch { fail('signature_unverified'); }
  if (signature.length !== 64 || !publicKey || !crypto.verify(null, bytes, publicKey, signature)) fail('signature_unverified');
  let parsed;
  try { parsed = JSON.parse(bytes.toString('utf8')); } catch { fail('evidence_invalid'); }
  const attestation = validateAttestation(parsed, { now, targetSha256 });
  if (pointerUpdatedAt < Date.parse(attestation.attestedAt)) fail('evidence_invalid');
  return attestation;
}

function attestationPublicKey(env = process.env) {
  const encoded = String(env.PDL_RECOVERY_ATTESTATION_PUBLIC_KEY || '').trim();
  if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length > 2048) fail('signature_unverified');
  try {
    const key = crypto.createPublicKey({ key: Buffer.from(encoded, 'base64'), format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'ed25519') fail('signature_unverified');
    return key;
  } catch (error) {
    if (error instanceof RecoveryReadinessError) throw error;
    fail('signature_unverified');
  }
}

function configuredProductionTarget(env = process.env) {
  if (env.PDL_SUPABASE_ENABLED !== '1') fail('target_unverified');
  let url;
  try { url = new URL(String(env.SUPABASE_URL || '')); } catch { fail('target_unverified'); }
  const match = /^([a-z0-9]{20})\.supabase\.co$/.exec(url.hostname.toLowerCase());
  const configured = String(env.PDL_PRODUCTION_SUPABASE_PROJECT_REF || '').trim().toLowerCase();
  if (url.protocol !== 'https:' || !match || url.username || url.password || url.port ||
      (url.pathname && url.pathname !== '/') || url.search || url.hash || !PROJECT_REF.test(configured) ||
      match[1] !== configured) fail('target_unverified');
  return { projectRef: configured, sha256: productionTargetSha256(configured) };
}

function currentTenantAuthorities(rows) {
  if (!Array.isArray(rows) || rows.length > MAX_TENANTS * 2) fail('authority_unavailable');
  const authorities = [];
  const refs = new Set();
  for (const row of rows) {
    const disposition = tenantSnapshotDisposition(row?.snapshot);
    if (disposition === 'malformed') fail('authority_unavailable');
    if (disposition !== 'eligible') continue;
    const databaseId = String(row.databaseCompanyId || '').toLowerCase();
    if (!UUID.test(databaseId)) fail('authority_unavailable');
    const ref = opaqueTenantRef(databaseId);
    if (refs.has(ref) || !Number.isSafeInteger(row.revision) || row.revision < 0 ||
        !SHA256.test(String(row.contentHash))) fail('authority_unavailable');
    refs.add(ref);
    authorities.push({ tenantRef: ref, revision: row.revision, contentHash: row.contentHash });
  }
  return authorities.sort((a, b) => a.tenantRef.localeCompare(b.tenantRef));
}

function compareAuthority(attestation, tenantRows, platformAuthority) {
  const tenants = currentTenantAuthorities(tenantRows);
  if (!platformAuthority || !Number.isSafeInteger(platformAuthority.revision) || platformAuthority.revision < 0 ||
      !SHA256.test(String(platformAuthority.contentHash))) fail('authority_unavailable');
  if (attestation.tenants.length !== tenants.length) fail('population_mismatch');
  for (let index = 0; index < tenants.length; index += 1) {
    const expected = attestation.tenants[index];
    const actual = tenants[index];
    if (expected.tenantRef !== actual.tenantRef) fail('population_mismatch');
    if (expected.revision !== actual.revision || expected.contentHash !== actual.contentHash) fail('authority_mismatch');
  }
  if (attestation.platform.revision !== platformAuthority.revision ||
      attestation.platform.contentHash !== platformAuthority.contentHash) fail('platform_authority_mismatch');
  return { tenantCount: tenants.length };
}

function status({ configured = false, ready = false, reason = null, tenantCount = null, attestedAt = null } = {}) {
  return {
    scope: 'all-eligible-tenants-and-platform',
    configured,
    ready,
    tenantCount,
    tenantBackupsVerified: ready ? tenantCount : 0,
    platformBackupVerified: ready,
    independentCopy: ready ? 'verified' : 'not-verified',
    restore: ready ? 'verified' : 'not-verified',
    lastVerifiedAt: ready ? attestedAt : null,
    reason: ready ? null : reason
  };
}

async function publicStatus({
  env = process.env,
  now = () => Date.now(),
  download,
  loadTenantAuthorities,
  loadPlatformAuthority
} = {}) {
  if (env.PDL_TRANSACTIONAL_DB !== 'primary' || env.PDL_PLATFORM_TRANSACTIONAL_DB !== 'primary') {
    return status({ configured: true, reason: 'repositories_not_primary' });
  }
  try {
    const target = configuredProductionTarget(env);
    const currentTime = now();
    if (typeof download !== 'function') return status({ reason: 'not_configured' });
    const publicKey = attestationPublicKey(env);
    const attestation = await loadRemoteAttestation(download, { now: currentTime, targetSha256: target.sha256, publicKey });
    if (typeof loadTenantAuthorities !== 'function' || typeof loadPlatformAuthority !== 'function') fail('authority_unavailable');
    // Provider reads happen only after target binding and local evidence
    // integrity/schema checks have succeeded.
    const [tenants, platform] = await Promise.all([loadTenantAuthorities(), loadPlatformAuthority()]);
    const compared = compareAuthority(attestation, tenants, platform);
    return status({
      configured: true,
      ready: true,
      tenantCount: compared.tenantCount,
      attestedAt: attestation.attestedAt
    });
  } catch (error) {
    const allowed = new Set([
      'target_unverified', 'evidence_unavailable', 'evidence_checksum_mismatch', 'evidence_invalid',
      'signature_unverified',
      'attestation_stale', 'backup_incomplete', 'backup_stale', 'independent_copy_unverified',
      'independent_copy_stale', 'restore_unverified', 'restore_stale', 'population_mismatch',
      'authority_mismatch', 'platform_authority_mismatch', 'authority_unavailable'
    ]);
    return status({ configured: true, reason: allowed.has(error?.code) ? error.code : 'authority_unavailable' });
  }
}

module.exports = {
  SCHEMA,
  POINTER_SCHEMA,
  POPULATION_SCHEMA,
  EVIDENCE_BUCKET,
  POINTER_OBJECT_KEY,
  DEFAULT_ATTESTATION_FRESHNESS_MS,
  DEFAULT_BACKUP_FRESHNESS_MS,
  DEFAULT_RESTORE_FRESHNESS_MS,
  RecoveryReadinessError,
  productionTargetSha256,
  populationSha256,
  configuredProductionTarget,
  attestationPublicKey,
  validateAttestation,
  loadRemoteAttestation,
  currentTenantAuthorities,
  compareAuthority,
  publicStatus
};
