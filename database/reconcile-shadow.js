'use strict';

const path = require('node:path');
const supabase = require('./supabase');
const maintenanceFence = require('./maintenance-fence');
const {
  parseArgs,
  loadExpectedPopulationManifest,
  reconcileShadow,
  readOnlyTransport,
  captureCatalog,
  catalogSignature,
  compareCatalog,
  validateRuntime,
  releaseSha,
  writeEvidenceExclusive
} = require('./shadow-reconciliation');

function interruptedError() {
  return Object.assign(new Error('INTERRUPTED'), { code: 'INTERRUPTED' });
}

function awaitRuntimeResponse(value, signal) {
  if (signal.aborted) return Promise.reject(new Error('runtime request aborted'));
  const promise = Promise.resolve(value);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = callback => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(new Error('runtime request aborted')));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      result => finish(() => resolve(result)),
      error => finish(() => reject(error))
    );
    if (signal.aborted) onAbort();
  });
}

async function verifyAttachedRuntime(env, { fetchImpl = globalThis.fetch, signal = null, timeoutMs = 5_000 } = {}) {
  if (env.NODE_ENV !== 'production') return false;
  if (typeof fetchImpl !== 'function') throw Object.assign(new Error('ATTACHED_RUNTIME_UNVERIFIED'), { code: 'ATTACHED_RUNTIME_UNVERIFIED' });
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
    throw Object.assign(new Error('ATTACHED_RUNTIME_UNVERIFIED'), { code: 'ATTACHED_RUNTIME_UNVERIFIED' });
  }
  const port = Number(env.PORT || 10000);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw Object.assign(new Error('ATTACHED_RUNTIME_UNVERIFIED'), { code: 'ATTACHED_RUNTIME_UNVERIFIED' });
  }
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort();
  signal?.addEventListener?.('abort', abortFromCaller, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await awaitRuntimeResponse(
      fetchImpl(`http://127.0.0.1:${port}/api/health/live`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: controller.signal
      }),
      controller.signal
    );
    if (!response?.ok) throw new Error('liveness failed');
    const payload = await awaitRuntimeResponse(response.json(), controller.signal);
    if (payload?.ok !== true || payload?.kind !== 'liveness') throw new Error('liveness payload failed');
    return true;
  } catch {
    if (signal?.aborted) throw interruptedError();
    throw Object.assign(new Error('ATTACHED_RUNTIME_UNVERIFIED'), { code: 'ATTACHED_RUNTIME_UNVERIFIED' });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', abortFromCaller);
  }
}

async function main(argv = process.argv.slice(2), env = process.env, dependencies = {}) {
  const signal = dependencies.signal || processAbortController.signal;
  if (signal.aborted) throw interruptedError();
  const options = parseArgs(argv);
  if (env !== process.env && !dependencies.request) {
    throw Object.assign(new Error('REQUEST_ENV_MISMATCH'), { code: 'REQUEST_ENV_MISMATCH' });
  }
  const runtime = validateRuntime({
    scope: options.scope,
    env,
    expectedServiceId: options.expectedServiceId,
    expectedInstanceId: options.expectedInstanceId
  });
  if (runtime.provider === 'render' && options.scope === 'all' && !options.evidence) {
    throw Object.assign(new Error('EVIDENCE_REQUIRED'), { code: 'EVIDENCE_REQUIRED' });
  }
  if (runtime.provider === 'render' && options.scope === 'all' &&
      (!options.expectedPopulationManifest || !options.expectedPopulationSha256)) {
    throw Object.assign(new Error('EXPECTED_POPULATION_REQUIRED'), { code: 'EXPECTED_POPULATION_REQUIRED' });
  }
  const expectedPopulation = options.expectedPopulationManifest
    ? loadExpectedPopulationManifest(options.expectedPopulationManifest, options.expectedPopulationSha256)
    : null;
  runtime.attachedLiveness = await verifyAttachedRuntime(env, { fetchImpl: dependencies.fetch, signal });
  const fenceApi = dependencies.maintenanceFence || maintenanceFence;
  let initialFence = null;
  if (runtime.provider === 'render' && options.scope === 'all') {
    runtime.maintenanceFence = fenceApi.requireVerifiedFence(env, {
      root: path.resolve(__dirname, '..'),
      expectedServiceId: options.expectedServiceId,
      expectedInstanceId: options.expectedInstanceId
    });
    initialFence = runtime.maintenanceFence;
  }
  const commit = releaseSha(env);
  const root = path.resolve(__dirname, '..');
  const dbFile = env.PDL_DB_FILE || path.join(root, 'data', 'db.json');
  const platformFile = env.PDL_PLATFORM_FILE || path.join(path.dirname(dbFile), 'platform.json');
  const baseRequest = dependencies.request || supabase.request;
  const request = readOnlyTransport(baseRequest, options.requestTimeoutMs, { signal });
  const result = await reconcileShadow({
    scope: { kind: options.scope, companyId: options.companyId },
    capture: () => captureCatalog({
      request,
      dbFile,
      platformFile,
      scope: options.scope,
      companyId: options.companyId,
      captureTimeoutMs: options.captureTimeoutMs,
      signal
    }),
    stableSamples: options.stableSamples,
    maxSamples: options.maxSamples,
    intervalMs: options.intervalMs,
    signal,
    normalize: value => value,
    signature: catalogSignature,
    compare: value => compareCatalog(value, {
      scope: options.scope,
      companyId: options.companyId,
      releaseSha: commit,
      runtime,
      expectedPopulation
    })
  });
  if (signal.aborted) throw interruptedError();
  if (initialFence) {
    const finalFence = fenceApi.requireVerifiedFence(env, {
      root,
      expectedServiceId: options.expectedServiceId,
      expectedInstanceId: options.expectedInstanceId
    });
    if (finalFence.digest !== initialFence.digest || finalFence.openedAt !== initialFence.openedAt ||
        JSON.stringify(finalFence.identity) !== JSON.stringify(initialFence.identity) ||
        finalFence.mode !== initialFence.mode || finalFence.source !== initialFence.source) {
      throw Object.assign(new Error('MAINTENANCE_FENCE_CHANGED'), { code: 'MAINTENANCE_FENCE_CHANGED' });
    }
  }
  const output = { ...result };
  if (options.evidence) {
    const sha256 = writeEvidenceExclusive(options.evidence, result);
    output.evidence = { written: true, sha256 };
  }
  (dependencies.stdout || process.stdout).write(`${JSON.stringify(output, null, 2)}\n`);
  if (dependencies.setExitCode) dependencies.setExitCode(result.status === 'reconciled' ? 0 : result.status === 'drift' || result.status === 'missing_source' ? 1 : 2);
  else process.exitCode = result.status === 'reconciled' ? 0 : result.status === 'drift' || result.status === 'missing_source' ? 1 : 2;
  return result;
}

const processAbortController = new AbortController();
function interrupt() {
  if (processAbortController.signal.aborted) return;
  processAbortController.abort();
  process.exitCode = 130;
}

if (require.main === module) {
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  supabase.loadLocalEnv(path.resolve(__dirname, '..'));
  main().catch(error => {
    if (error?.code === 'INTERRUPTED') {
      process.exitCode = 130;
      return;
    }
    const code = error && typeof error.code === 'string' && /^[A-Z0-9_]+$/.test(error.code)
      ? error.code
      : error instanceof Error && /^(?:Choose exactly|Unknown argument|--)/.test(error.message)
        ? 'INVALID_ARGUMENT'
        : 'RECONCILIATION_FAILED';
    process.stderr.write(`${JSON.stringify({ schema: 'pdl-shadow-reconciliation/v1', status: 'inconclusive', writesPerformed: false, reason: code })}\n`);
    process.exitCode = 2;
  });
}

module.exports = { main, verifyAttachedRuntime };
