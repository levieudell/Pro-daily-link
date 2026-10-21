'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SCHEMA = 'pdl-maintenance-fence/v1';
const MODE = 'read_only';
const DIGEST = /^[a-f0-9]{64}$/;
const SERVICE_ID = /^srv-[a-z0-9]{20,64}$/;
const INSTANCE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/;
const RELEASE_SHA = /^[a-f0-9]{40}$/;
const MAX_LOCK_BYTES = 4096;
const DEFAULT_PRODUCTION_QUIESCENCE_MS = 35_000;
const PUBLIC_MESSAGE = 'Pro Daily Link is temporarily read-only while a data safety check finishes. Please try again shortly.';

class MaintenanceFenceError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'MaintenanceFenceError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new MaintenanceFenceError(code, message);
}

function maintenanceLockFile(env = process.env, { root = path.resolve(__dirname, '..'), lockFile = '' } = {}) {
  const configured = String(lockFile || env.PDL_MAINTENANCE_LOCK_FILE || '').trim();
  if (configured && !path.isAbsolute(configured)) fail('MAINTENANCE_PATH_INVALID');
  const dbFile = path.resolve(String(env.PDL_DB_FILE || path.join(root, 'data', 'db.json')));
  const resolved = configured ? path.resolve(configured) : path.join(path.dirname(dbFile), '.pdl-maintenance-read-only.json');
  if (!path.isAbsolute(resolved)) fail('MAINTENANCE_PATH_INVALID');
  return resolved;
}

function sidecarFile(lockFile) {
  return `${lockFile}.sha256`;
}

function fsyncDirectory(directory) {
  if (process.platform === 'win32') return;
  const handle = fs.openSync(directory, 'r');
  try { fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
}

function writeExclusive(file, bytes) {
  const handle = fs.openSync(file, 'wx', 0o600);
  try {
    fs.writeFileSync(handle, bytes);
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  try { fs.chmodSync(file, 0o600); } catch {}
}

function productionIdentity(env = process.env, {
  expectedServiceId = '',
  expectedInstanceId = '',
  expectedReleaseSha = '',
  requireExpected = false,
  requireExpectedRelease = false
} = {}) {
  const production = env.NODE_ENV === 'production';
  if (!production) {
    return {
      provider: 'local',
      serviceId: null,
      instanceId: null,
      releaseSha: 'local'
    };
  }
  const serviceId = String(env.RENDER_SERVICE_ID || '');
  const instanceId = String(env.RENDER_INSTANCE_ID || '');
  const releaseSha = String(env.RENDER_GIT_COMMIT || '').toLowerCase();
  if (env.RENDER !== 'true' || env.RENDER_SERVICE_TYPE !== 'web' || env.IS_PULL_REQUEST === 'true' ||
      !SERVICE_ID.test(serviceId) || !INSTANCE_ID.test(instanceId) || !RELEASE_SHA.test(releaseSha)) {
    fail('MAINTENANCE_RUNTIME_IDENTITY_MISSING');
  }
  if (requireExpected && (!expectedServiceId || !expectedInstanceId)) fail('MAINTENANCE_RUNTIME_IDENTITY_MISMATCH');
  if (requireExpectedRelease && !expectedReleaseSha) fail('MAINTENANCE_RUNTIME_IDENTITY_MISMATCH');
  if ((expectedServiceId && expectedServiceId !== serviceId) || (expectedInstanceId && expectedInstanceId !== instanceId)) {
    fail('MAINTENANCE_RUNTIME_IDENTITY_MISMATCH');
  }
  if (expectedReleaseSha && String(expectedReleaseSha).toLowerCase() !== releaseSha) fail('MAINTENANCE_RUNTIME_IDENTITY_MISMATCH');
  return { provider: 'render', serviceId, instanceId, releaseSha };
}

function environmentMode(env = process.env) {
  const raw = String(env.PDL_MAINTENANCE_MODE || '').trim().toLowerCase();
  if (!raw || raw === '0' || raw === 'off') return { enabled: false, valid: true };
  if (raw === '1') return { enabled: true, valid: true };
  return { enabled: false, valid: false };
}

function validPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const keys = Object.keys(payload).sort();
  const expected = ['instanceId', 'mode', 'nonce', 'openedAt', 'provider', 'releaseSha', 'schema', 'serviceId'].sort();
  if (keys.join(',') !== expected.join(',')) return false;
  if (payload.schema !== SCHEMA || payload.mode !== MODE || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(String(payload.openedAt || '')) ||
      !/^[a-f0-9]{32}$/.test(String(payload.nonce || ''))) return false;
  if (payload.provider === 'local') return payload.serviceId === null && payload.instanceId === null && payload.releaseSha === 'local';
  return payload.provider === 'render' && SERVICE_ID.test(String(payload.serviceId || '')) &&
    INSTANCE_ID.test(String(payload.instanceId || '')) && RELEASE_SHA.test(String(payload.releaseSha || ''));
}

function readRegularFile(file, maximum) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > maximum) fail('MAINTENANCE_FENCE_CORRUPT');
  return fs.readFileSync(file);
}

function sameText(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function inspectMaintenanceFence(env = process.env, options = {}) {
  const lockFile = maintenanceLockFile(env, options);
  const sidecar = sidecarFile(lockFile);
  const envMode = environmentMode(env);
  const lockPresent = fs.existsSync(lockFile);
  const sidecarPresent = fs.existsSync(sidecar);
  const partialArtifact = lockPresent !== sidecarPresent;
  const enforced = envMode.enabled || !envMode.valid || lockPresent || sidecarPresent;
  const base = {
    active: enforced,
    enforced,
    environmentEnabled: envMode.enabled,
    environmentValid: envMode.valid,
    lockPresent,
    sidecarPresent,
    verified: false,
    mode: enforced ? MODE : 'off',
    source: envMode.enabled ? 'environment' : partialArtifact ? 'corrupt_artifact' : lockPresent ? 'lock' : 'off',
    digest: null,
    openedAt: null,
    identity: null,
    reason: null,
    lockFile
  };
  if (!envMode.valid) return { ...base, reason: 'MAINTENANCE_MODE_INVALID' };
  if (!lockPresent && !sidecarPresent) return base;
  if (!lockPresent || !sidecarPresent) return { ...base, source: 'corrupt_artifact', reason: 'MAINTENANCE_FENCE_CORRUPT' };
  try {
    const bytes = readRegularFile(lockFile, MAX_LOCK_BYTES);
    const sidecarBytes = readRegularFile(sidecar, 65);
    const sidecarText = sidecarBytes.toString('utf8');
    if (!/^[a-f0-9]{64}\n$/.test(sidecarText)) fail('MAINTENANCE_FENCE_CORRUPT');
    const digest = crypto.createHash('sha256').update(bytes).digest('hex');
    if (!sameText(`${digest}\n`, sidecarText)) fail('MAINTENANCE_FENCE_CORRUPT');
    const payload = JSON.parse(bytes.toString('utf8'));
    if (!validPayload(payload)) fail('MAINTENANCE_FENCE_CORRUPT');
    const current = productionIdentity(env, options);
    if (payload.provider !== current.provider || payload.serviceId !== current.serviceId ||
        payload.instanceId !== current.instanceId || payload.releaseSha !== current.releaseSha) {
      fail('MAINTENANCE_FENCE_IDENTITY_MISMATCH');
    }
    return {
      ...base,
      active: true,
      enforced: true,
      verified: true,
      source: envMode.enabled ? 'environment_and_lock' : 'lock',
      digest,
      openedAt: payload.openedAt,
      identity: current
    };
  } catch (error) {
    const code = error instanceof MaintenanceFenceError ? error.code : 'MAINTENANCE_FENCE_CORRUPT';
    return { ...base, active: true, enforced: true, source: 'corrupt_artifact', reason: code };
  }
}

function publicFenceState(state) {
  return {
    active: Boolean(state.active),
    enforced: Boolean(state.enforced),
    environmentEnabled: Boolean(state.environmentEnabled),
    verified: Boolean(state.verified),
    mode: state.mode,
    source: state.source,
    digest: state.digest,
    openedAt: state.openedAt,
    reason: state.reason,
    identity: state.identity ? {
      provider: state.identity.provider,
      serviceId: state.identity.serviceId,
      instanceId: state.identity.instanceId,
      releaseSha: state.identity.releaseSha
    } : null
  };
}

function openMaintenanceFence(env = process.env, options = {}) {
  if (options.apply !== true) fail('MAINTENANCE_APPLY_REQUIRED');
  const envMode = environmentMode(env);
  if (!envMode.valid) fail('MAINTENANCE_ENVIRONMENT_FENCE_REQUIRED');
  const transition = options.transition === true;
  if (transition && env.NODE_ENV !== 'production') fail('MAINTENANCE_TRANSITION_PRODUCTION_ONLY');
  if (transition && envMode.enabled) fail('MAINTENANCE_TRANSITION_REQUIRES_ENVIRONMENT_OFF');
  if (!transition && !envMode.enabled) fail('MAINTENANCE_ENVIRONMENT_FENCE_REQUIRED');
  const identity = productionIdentity(env, {
    ...options,
    requireExpected: env.NODE_ENV === 'production',
    requireExpectedRelease: transition
  });
  const lockFile = maintenanceLockFile(env, options);
  const sidecar = sidecarFile(lockFile);
  if (fs.existsSync(lockFile) || fs.existsSync(sidecar)) fail('MAINTENANCE_FENCE_EXISTS');
  const directory = path.dirname(lockFile);
  if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) fail('MAINTENANCE_DIRECTORY_MISSING');
  const payload = {
    schema: SCHEMA,
    mode: MODE,
    provider: identity.provider,
    serviceId: identity.serviceId,
    instanceId: identity.instanceId,
    releaseSha: identity.releaseSha,
    openedAt: new Date().toISOString(),
    nonce: crypto.randomBytes(16).toString('hex')
  };
  const bytes = Buffer.from(`${JSON.stringify(payload, null, 2)}\n`);
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  let createdLock = false;
  let createdSidecar = false;
  try {
    writeExclusive(lockFile, bytes);
    createdLock = true;
    writeExclusive(sidecar, Buffer.from(`${digest}\n`));
    createdSidecar = true;
    fsyncDirectory(directory);
    const state = inspectMaintenanceFence(env, { ...options, lockFile });
    if (!state.verified || state.digest !== digest) fail('MAINTENANCE_FENCE_VERIFICATION_FAILED');
    return publicFenceState(state);
  } catch (error) {
    if (createdLock) try { fs.unlinkSync(lockFile); } catch {}
    if (createdSidecar) try { fs.unlinkSync(sidecar); } catch {}
    try { fsyncDirectory(directory); } catch {}
    throw error;
  }
}

function closeMaintenanceFence(env = process.env, options = {}) {
  if (options.apply !== true) fail('MAINTENANCE_APPLY_REQUIRED');
  const expectedDigest = String(options.expectedDigest || '').toLowerCase();
  if (!DIGEST.test(expectedDigest)) fail('MAINTENANCE_EXPECTED_DIGEST_REQUIRED');
  const envMode = environmentMode(env);
  if (env.NODE_ENV === 'production' && (!envMode.valid || !envMode.enabled)) {
    fail('MAINTENANCE_CLOSE_REQUIRES_ENVIRONMENT_FENCE');
  }
  productionIdentity(env, { ...options, requireExpected: env.NODE_ENV === 'production' });
  const lockFile = maintenanceLockFile(env, options);
  const sidecar = sidecarFile(lockFile);
  const state = inspectMaintenanceFence(env, { ...options, lockFile });
  if (!state.verified) fail(state.reason || 'MAINTENANCE_FENCE_NOT_VERIFIED');
  if (!sameText(state.digest, expectedDigest)) fail('MAINTENANCE_EXPECTED_DIGEST_MISMATCH');
  // Remove the lock first. The sidecar intentionally remains as a fail-closed
  // artifact until the final unlink succeeds, so no write can slip through.
  fs.unlinkSync(lockFile);
  try {
    fs.unlinkSync(sidecar);
  } catch (error) {
    // A stranded sidecar keeps every writer blocked and makes the failure
    // visible to status; never pretend the fence closed.
    throw error;
  }
  fsyncDirectory(path.dirname(lockFile));
  return publicFenceState(inspectMaintenanceFence(env, { ...options, lockFile }));
}

function requireVerifiedFence(env = process.env, options = {}) {
  const state = inspectMaintenanceFence(env, options);
  if (!state.environmentEnabled) fail('MAINTENANCE_ENVIRONMENT_FENCE_REQUIRED');
  if (!state.verified) fail(state.reason || 'MAINTENANCE_FENCE_NOT_VERIFIED');
  const minimumAgeMs = Number.isFinite(Number(options.minimumAgeMs))
    ? Math.max(0, Number(options.minimumAgeMs))
    : env.NODE_ENV === 'production' ? DEFAULT_PRODUCTION_QUIESCENCE_MS : 0;
  if (Date.now() - Date.parse(state.openedAt) < minimumAgeMs) fail('MAINTENANCE_FENCE_NOT_QUIESCENT');
  const identity = productionIdentity(env, { ...options, requireExpected: env.NODE_ENV === 'production' });
  if (!state.identity || state.identity.serviceId !== identity.serviceId || state.identity.instanceId !== identity.instanceId) {
    fail('MAINTENANCE_FENCE_IDENTITY_MISMATCH');
  }
  return publicFenceState(state);
}

function maintenanceWriteError(state = null) {
  const error = new MaintenanceFenceError('MAINTENANCE_READ_ONLY', PUBLIC_MESSAGE);
  error.statusCode = 503;
  error.publicMessage = PUBLIC_MESSAGE;
  error.fence = state ? publicFenceState(state) : null;
  return error;
}

function assertWritesAllowed(env = process.env, options = {}) {
  const state = inspectMaintenanceFence(env, options);
  if (state.enforced) throw maintenanceWriteError(state);
  return true;
}

function guardHttpMutation(req, res, json, env = process.env, options = {}) {
  const method = String(req?.method || 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD') return false;
  const state = inspectMaintenanceFence(env, options);
  if (!state.enforced) return false;
  json(res, 503, { error: PUBLIC_MESSAGE, code: 'MAINTENANCE_READ_ONLY' });
  return true;
}

module.exports = {
  SCHEMA,
  MODE,
  DEFAULT_PRODUCTION_QUIESCENCE_MS,
  PUBLIC_MESSAGE,
  MaintenanceFenceError,
  maintenanceLockFile,
  productionIdentity,
  inspectMaintenanceFence,
  publicFenceState,
  openMaintenanceFence,
  closeMaintenanceFence,
  requireVerifiedFence,
  assertWritesAllowed,
  guardHttpMutation
};
