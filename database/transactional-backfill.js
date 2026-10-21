'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const maintenanceFence = require('./maintenance-fence');
const supabase = require('./supabase');
const { splitSnapshot, canonicalHash, databaseCompanyId } = require('./transactional-repository');
const {
  EXPECTED_POPULATION_SCHEMA,
  loadExpectedPopulationManifest,
  canonicalSnapshotState,
  opaqueTenantRef,
  readOnlyTransport,
  streamLegacyCatalog,
  streamTransactionalCatalog,
  loadLegacyRow,
  loadTransactionalRow,
  legacyTenantDisposition,
  validateRuntime,
  releaseSha,
  writeEvidenceExclusive
} = require('./shadow-reconciliation');
const { verifyAttachedRuntime } = require('./reconcile-shadow');

const SCHEMA = 'pdl-transactional-backfill/v1';
const SUPABASE_PROJECT_REF = /^[a-z0-9]{20}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONFIRMATION = 'INITIALIZE ONLY MISSING TRANSACTIONAL TENANTS';
const DEFAULTS = Object.freeze({ requestTimeoutMs: 10_000, captureTimeoutMs: 120_000 });

class TransactionalBackfillError extends Error {
  constructor(code, details = null) {
    super(code);
    this.name = 'TransactionalBackfillError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, details = null) {
  throw new TransactionalBackfillError(code, details);
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  fail('INTERRUPTED');
}

function preflightEvidenceDestination(file) {
  const sidecar = `${file}.sha256`;
  if (fs.existsSync(file) || fs.existsSync(sidecar)) fail('EVIDENCE_PATH_EXISTS');
  const directory = path.dirname(file);
  try {
    const directoryLink = fs.lstatSync(directory);
    const directoryStat = fs.statSync(directory);
    if (directoryLink.isSymbolicLink() || !directoryStat.isDirectory()) fail('EVIDENCE_DESTINATION_INVALID');
    const probe = path.join(directory, `.pdl-backfill-evidence-probe-${process.pid}-${crypto.randomBytes(8).toString('hex')}`);
    let handle = null;
    try {
      handle = fs.openSync(probe, 'wx', 0o600);
      fs.writeFileSync(handle, 'pdl-transactional-backfill-evidence-preflight\n');
      fs.fsyncSync(handle);
    } finally {
      if (handle !== null) fs.closeSync(handle);
      try { fs.unlinkSync(probe); } catch {}
    }
    if (process.platform !== 'win32') {
      const directoryHandle = fs.openSync(directory, 'r');
      try { fs.fsyncSync(directoryHandle); } finally { fs.closeSync(directoryHandle); }
    }
  } catch (error) {
    if (error instanceof TransactionalBackfillError) throw error;
    fail('EVIDENCE_DESTINATION_UNAVAILABLE');
  }
}

function option(argv, name) {
  if (argv.filter(value => value === name).length > 1) throw new Error(`${name} may only be provided once.`);
  const index = argv.indexOf(name);
  if (index < 0) return '';
  const value = String(argv[index + 1] || '').trim();
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value.`);
  return value;
}

function boundedInteger(value, label, minimum, maximum) {
  if (!/^\d+$/.test(String(value || ''))) throw new Error(`${label} must be an integer.`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}.`);
  }
  return number;
}

function parseArgs(argv = process.argv.slice(2)) {
  const apply = argv.includes('--apply');
  const all = argv.includes('--all');
  const evidence = option(argv, '--evidence');
  const productionTarget = option(argv, '--production-target').toLowerCase();
  const expectedServiceId = option(argv, '--expected-service-id');
  const expectedInstanceId = option(argv, '--expected-instance-id');
  const expectedPopulationManifest = option(argv, '--expected-population-manifest');
  const expectedPopulationSha256 = option(argv, '--expected-population-sha256').toLowerCase();
  const confirmPopulationSha256 = option(argv, '--confirm-population-sha256').toLowerCase();
  const confirmAction = option(argv, '--confirm-action');
  const requestTimeoutRaw = option(argv, '--request-timeout-ms');
  const captureTimeoutRaw = option(argv, '--capture-timeout-ms');
  const valueFlags = new Set([
    '--evidence', '--production-target', '--expected-service-id', '--expected-instance-id',
    '--expected-population-manifest', '--expected-population-sha256', '--confirm-population-sha256',
    '--confirm-action', '--request-timeout-ms', '--capture-timeout-ms'
  ]);
  const booleanFlags = new Set(['--apply', '--all']);
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index]);
    if (valueFlags.has(token)) { index += 1; continue; }
    if (!booleanFlags.has(token)) throw new Error(`Unsupported transactional backfill argument: ${token.startsWith('--') ? token : '(value)'}.`);
  }
  if (argv.filter(value => value === '--apply').length > 1 || argv.filter(value => value === '--all').length > 1) {
    throw new Error('Boolean flags may only be provided once.');
  }
  if (!all) throw new Error('Transactional backfill requires --all so population completeness can be proved.');
  if (!path.isAbsolute(evidence)) throw new Error('--evidence must be an absolute, unused JSON path.');
  if (!SUPABASE_PROJECT_REF.test(productionTarget)) throw new Error('--production-target must be an exact Supabase project reference.');
  if (!/^srv-[a-z0-9]{20,64}$/.test(expectedServiceId)) throw new Error('--expected-service-id must be an exact Render service ID.');
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/.test(expectedInstanceId)) throw new Error('--expected-instance-id must be an exact Render instance ID.');
  if (!path.isAbsolute(expectedPopulationManifest)) throw new Error('--expected-population-manifest must be an absolute JSON path.');
  if (!SHA256.test(expectedPopulationSha256)) throw new Error('--expected-population-sha256 must be an exact lowercase SHA-256 digest.');
  if (apply && confirmPopulationSha256 !== expectedPopulationSha256) {
    throw new Error('--apply requires --confirm-population-sha256 matching the independently recorded manifest digest.');
  }
  if (apply && confirmAction !== CONFIRMATION) {
    throw new Error(`--apply requires --confirm-action "${CONFIRMATION}".`);
  }
  return {
    apply,
    all,
    evidence,
    productionTarget,
    expectedServiceId,
    expectedInstanceId,
    expectedPopulationManifest,
    expectedPopulationSha256,
    confirmPopulationSha256,
    confirmAction,
    requestTimeoutMs: requestTimeoutRaw
      ? boundedInteger(requestTimeoutRaw, '--request-timeout-ms', 250, 60_000)
      : DEFAULTS.requestTimeoutMs,
    captureTimeoutMs: captureTimeoutRaw
      ? boundedInteger(captureTimeoutRaw, '--capture-timeout-ms', 1_000, 900_000)
      : DEFAULTS.captureTimeoutMs
  };
}

function configuredSupabaseProjectRef(env = process.env) {
  let url;
  try { url = new URL(String(env.SUPABASE_URL || '')); } catch { fail('TARGET_CONFIGURATION_INVALID'); }
  const match = /^([a-z0-9]{20})\.supabase\.co$/.exec(url.hostname.toLowerCase());
  if (url.protocol !== 'https:' || !match || url.username || url.password || url.port ||
      (url.pathname && url.pathname !== '/') || url.search || url.hash) {
    fail('TARGET_CONFIGURATION_INVALID');
  }
  return match[1];
}

function validateBackfillRuntime(args, env = process.env) {
  const runtime = validateRuntime({
    scope: 'all',
    env,
    expectedServiceId: args.expectedServiceId,
    expectedInstanceId: args.expectedInstanceId
  });
  const actualProjectRef = configuredSupabaseProjectRef(env);
  const configuredProductionRef = String(env.PDL_PRODUCTION_SUPABASE_PROJECT_REF || '').trim().toLowerCase();
  if (runtime.provider !== 'render' || env.NODE_ENV !== 'production' ||
      !SUPABASE_PROJECT_REF.test(configuredProductionRef) ||
      configuredProductionRef !== args.productionTarget || actualProjectRef !== args.productionTarget) {
    fail('PRODUCTION_TARGET_MISMATCH');
  }
  return {
    ...runtime,
    projectRefSha256: crypto.createHash('sha256').update(`pdl-backfill-target:v1:${actualProjectRef}`).digest('hex')
  };
}

function sameFence(left, right) {
  return Boolean(left && right && left.digest === right.digest && left.openedAt === right.openedAt &&
    left.mode === right.mode && left.source === right.source &&
    JSON.stringify(left.identity) === JSON.stringify(right.identity));
}

function requireSameFence(fenceApi, env, options, expected) {
  const current = fenceApi.requireVerifiedFence(env, options);
  if (!sameFence(current, expected)) fail('MAINTENANCE_FENCE_CHANGED');
  return current;
}

function stablePlanShape(catalog) {
  const map = source => [...source.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([id, entry]) => [
    id,
    entry.state.canonicalSha256,
    entry.state.records,
    entry.state.collectionCounts,
    entry.state.repositoryRevision ?? null,
    entry.state.integrity ?? null
  ]);
  return {
    legacy: map(catalog.legacy.map),
    transactional: map(catalog.transactional.map),
    excludedLegacy: catalog.legacy.excluded,
    excludedTransactional: catalog.transactional.excluded,
    excludedTransactionalTenants: [...(catalog.transactional.excludedMap || new Map()).entries()]
      .sort(([left], [right]) => left.localeCompare(right))
  };
}

function catalogDigest(catalog) {
  return crypto.createHash('sha256').update(JSON.stringify(stablePlanShape(catalog))).digest('hex');
}

function buildPlan(catalog, expectedPopulation) {
  if (!expectedPopulation || expectedPopulation.schema !== EXPECTED_POPULATION_SCHEMA) fail('EXPECTED_POPULATION_INVALID');
  const expectedRefs = new Set(expectedPopulation.tenantRefs);
  const legacyByRef = new Map();
  for (const [id, entry] of catalog.legacy.map) {
    const ref = opaqueTenantRef(id);
    if (legacyByRef.has(ref)) fail('OPAQUE_TENANT_COLLISION');
    legacyByRef.set(ref, { id, entry });
  }
  const transactionalByRef = new Map();
  for (const [id, entry] of catalog.transactional.map) {
    const ref = opaqueTenantRef(id);
    if (transactionalByRef.has(ref)) fail('OPAQUE_TENANT_COLLISION');
    transactionalByRef.set(ref, { id, entry });
  }
  const missingLegacy = [...expectedRefs].filter(ref => !legacyByRef.has(ref)).sort();
  const unexpectedLegacy = [...legacyByRef.keys()].filter(ref => !expectedRefs.has(ref)).sort();
  const unexpectedTransactional = [...transactionalByRef.keys()].filter(ref => !expectedRefs.has(ref)).sort();
  const tenants = [];
  for (const ref of [...expectedRefs].sort()) {
    const legacy = legacyByRef.get(ref);
    const transactional = transactionalByRef.get(ref);
    const excludedTransactionalReason = legacy
      ? catalog.transactional.excludedMap?.get(legacy.id) || null
      : null;
    if (!legacy) continue;
    let action = 'initialize';
    const issues = [];
    if (excludedTransactionalReason) {
      action = 'refuse-drift';
      issues.push(`transactional_${excludedTransactionalReason}`);
    } else if (transactional) {
      action = 'skip-exact';
      if (transactional.id !== legacy.id) issues.push('tenant_identity_mismatch');
      if (transactional.entry.state.integrity !== true) issues.push('transactional_integrity');
      if (transactional.entry.state.canonicalSha256 !== legacy.entry.state.canonicalSha256) issues.push('content_hash_mismatch');
      if (transactional.entry.state.records !== legacy.entry.state.records ||
          JSON.stringify(transactional.entry.state.collectionCounts) !== JSON.stringify(legacy.entry.state.collectionCounts)) {
        issues.push('record_count_mismatch');
      }
      if (issues.length) action = 'refuse-drift';
    }
    tenants.push({
      id: legacy.id,
      tenantRef: ref,
      action,
      issues,
      canonicalSha256: legacy.entry.state.canonicalSha256,
      records: legacy.entry.state.records,
      transactionalRevision: transactional?.entry.state.repositoryRevision ?? null
    });
  }
  const drift = Boolean(missingLegacy.length || unexpectedLegacy.length || unexpectedTransactional.length ||
    tenants.some(tenant => tenant.action === 'refuse-drift'));
  return {
    status: drift ? 'drift' : 'ready',
    expectedTenantCount: expectedPopulation.tenantCount,
    eligibleLegacyTenants: legacyByRef.size,
    eligibleTransactionalTenants: transactionalByRef.size,
    initializeTenants: tenants.filter(tenant => tenant.action === 'initialize').length,
    exactTenants: tenants.filter(tenant => tenant.action === 'skip-exact').length,
    driftTenants: tenants.filter(tenant => tenant.action === 'refuse-drift').length,
    missingLegacyTenantRefs: missingLegacy,
    unexpectedLegacyTenantRefs: unexpectedLegacy,
    unexpectedTransactionalTenantRefs: unexpectedTransactional,
    excludedLegacyRows: catalog.legacy.excluded,
    excludedTransactionalRows: catalog.transactional.excluded,
    tenants
  };
}

function publicPlan(plan) {
  return {
    status: plan.status,
    expectedTenantCount: plan.expectedTenantCount,
    eligibleLegacyTenants: plan.eligibleLegacyTenants,
    eligibleTransactionalTenants: plan.eligibleTransactionalTenants,
    initializeTenants: plan.initializeTenants,
    exactTenants: plan.exactTenants,
    driftTenants: plan.driftTenants,
    missingLegacyTenantRefs: plan.missingLegacyTenantRefs,
    unexpectedLegacyTenantRefs: plan.unexpectedLegacyTenantRefs,
    unexpectedTransactionalTenantRefs: plan.unexpectedTransactionalTenantRefs,
    excludedLegacyRows: plan.excludedLegacyRows,
    excludedTransactionalRows: plan.excludedTransactionalRows,
    tenants: plan.tenants.map(tenant => ({
      tenantRef: tenant.tenantRef,
      action: tenant.action,
      issues: tenant.issues,
      canonicalSha256: tenant.canonicalSha256,
      records: tenant.records,
      transactionalRevision: tenant.transactionalRevision
    }))
  };
}

async function captureCatalog({ request, requestTimeoutMs, captureTimeoutMs, signal }) {
  throwIfAborted(signal);
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort();
  signal?.addEventListener?.('abort', abortFromCaller, { once: true });
  const timer = setTimeout(() => controller.abort(), captureTimeoutMs);
  try {
    const transport = readOnlyTransport(request, requestTimeoutMs, { signal: controller.signal });
    const [legacy, transactional] = await Promise.all([
      streamLegacyCatalog(transport),
      streamTransactionalCatalog(transport)
    ]);
    throwIfAborted(signal);
    if (controller.signal.aborted) fail('CAPTURE_TIMEOUT');
    return { legacy, transactional };
  } catch (error) {
    if (signal?.aborted) fail('INTERRUPTED');
    if (controller.signal.aborted) fail('CAPTURE_TIMEOUT');
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', abortFromCaller);
  }
}

async function stableCatalog(options) {
  const first = await captureCatalog(options);
  const second = await captureCatalog(options);
  if (catalogDigest(first) !== catalogDigest(second)) fail('UNSTABLE_CATALOG');
  return second;
}

function timeoutRequest(request, relativePath, options, timeoutMs, signal) {
  throwIfAborted(signal);
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort();
  signal?.addEventListener?.('abort', abortFromCaller, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return Promise.resolve().then(() => request(relativePath, { ...options, signal: controller.signal })).finally(() => {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', abortFromCaller);
  }).catch(error => {
    if (signal?.aborted) fail('INTERRUPTED');
    if (controller.signal.aborted) fail('PROVIDER_TIMEOUT');
    throw error;
  });
}

function ambiguousWriteError(error) {
  const status = Number(error?.statusCode);
  return error?.code === 'PROVIDER_TIMEOUT' || error instanceof TypeError ||
    status === 408 || status === 425 || status === 429 || status >= 500 ||
    /\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|fetch failed|network error)\b/i.test(String(error?.message || ''));
}

async function readTenantPair(request, companyId, requestTimeoutMs, signal) {
  const transport = readOnlyTransport(request, requestTimeoutMs, { signal });
  const [legacy, transactional] = await Promise.all([
    loadLegacyRow(transport, companyId),
    loadTransactionalRow(transport, companyId)
  ]);
  return { legacy, transactional };
}

function verifyTenantPair(pair, planned, { requireRevisionZero }) {
  if (!pair.legacy || legacyTenantDisposition(pair.legacy) !== 'eligible') fail('LEGACY_SOURCE_CHANGED');
  if (String(databaseCompanyId(pair.legacy.data)).toLowerCase() !== planned.id) fail('LEGACY_SOURCE_CHANGED');
  const legacyState = canonicalSnapshotState(pair.legacy.data);
  if (legacyState.canonicalSha256 !== planned.canonicalSha256 || legacyState.records !== planned.records) {
    fail('LEGACY_SOURCE_CHANGED');
  }
  const state = pair.transactional?.state;
  if (!state || state.integrity !== true || state.canonicalSha256 !== planned.canonicalSha256 ||
      state.records !== planned.records || (requireRevisionZero && state.repositoryRevision !== 0)) {
    fail('TRANSACTIONAL_VERIFICATION_FAILED');
  }
  return {
    tenantRef: planned.tenantRef,
    revision: state.repositoryRevision,
    contentHash: state.canonicalSha256,
    records: state.records
  };
}

async function verifyTenantTwice(request, planned, requestTimeoutMs, signal, options = {}) {
  const first = await readTenantPair(request, planned.id, requestTimeoutMs, signal);
  const second = await readTenantPair(request, planned.id, requestTimeoutMs, signal);
  const verifiedFirst = verifyTenantPair(first, planned, options);
  const verifiedSecond = verifyTenantPair(second, planned, options);
  if (JSON.stringify(verifiedFirst) !== JSON.stringify(verifiedSecond)) fail('UNSTABLE_TENANT_READ');
  return verifiedSecond;
}

function normalizeMutationResponse(payload, planned) {
  const result = Array.isArray(payload) ? (payload.length === 1 ? payload[0] : null) : payload;
  const companyId = String(result?.companyId ?? result?.company_id ?? '').toLowerCase();
  const revision = Number(result?.revision);
  const records = Number(result?.recordCount ?? result?.record_count);
  const contentHash = String(result?.contentHash ?? result?.content_hash ?? '').toLowerCase();
  const status = String(result?.status || '');
  if (!result || !['initialized', 'exact'].includes(status) || companyId !== planned.id ||
      !Number.isSafeInteger(revision) || revision < 0 || !Number.isSafeInteger(records) || records < 0 ||
      !SHA256.test(contentHash) || contentHash !== planned.canonicalSha256 || records !== planned.records) {
    fail('PROVIDER_PAYLOAD_INVALID');
  }
  return { status, revision, records, contentHash };
}

async function initializeTenant({ request, planned, requestTimeoutMs, signal, beforeWrite, afterWrite, onDispatch = () => {} }) {
  const before = await readTenantPair(request, planned.id, requestTimeoutMs, signal);
  if (!before.legacy || legacyTenantDisposition(before.legacy) !== 'eligible' ||
      canonicalHash(before.legacy.data) !== planned.canonicalSha256) fail('LEGACY_SOURCE_CHANGED');
  if (before.transactional) fail('TRANSACTIONAL_APPEARED_AFTER_PLAN');
  const { scalarData, records } = splitSnapshot(before.legacy.data);
  const payload = records.map(row => ({
    collection: row.collection,
    record_key: row.recordKey,
    position: row.position,
    data: row.data
  }));
  const body = JSON.stringify({
    p_company_id: planned.id,
    p_source_snapshot: before.legacy.data,
    p_scalar_data: scalarData,
    p_content_hash: planned.canonicalSha256,
    p_records: payload
  });
  let response = null;
  let firstError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    throwIfAborted(signal);
    await beforeWrite();
    try {
      onDispatch({ tenantRef: planned.tenantRef, attempt: attempt + 1 });
      const raw = await timeoutRequest(request, '/rest/v1/rpc/initialize_tenant_repository_from_legacy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body
      }, requestTimeoutMs, signal);
      if (!raw || typeof raw.json !== 'function') fail('PROVIDER_PAYLOAD_INVALID');
      if (raw.ok === false) {
        const providerError = new TransactionalBackfillError('PROVIDER_HTTP_ERROR');
        providerError.statusCode = Number(raw.status) || 0;
        throw providerError;
      }
      response = normalizeMutationResponse(await raw.json(), planned);
      if (attempt === 0 && (response.status !== 'initialized' || response.revision !== 0)) {
        fail('TRANSACTIONAL_APPEARED_DURING_WRITE');
      }
      if (attempt === 1 && response.revision !== 0) fail('TRANSACTIONAL_APPEARED_DURING_WRITE');
      break;
    } catch (error) {
      if (error?.code === 'INTERRUPTED') throw error;
      if (!ambiguousWriteError(error)) throw error;
      firstError ||= error;
      await afterWrite();
      try {
        const verified = await verifyTenantTwice(request, planned, requestTimeoutMs, signal, { requireRevisionZero: true });
        return { ...verified, result: 'initialized', outcomeRecoveredAfterError: true };
      } catch (verificationError) {
        if (verificationError?.code !== 'TRANSACTIONAL_VERIFICATION_FAILED' || attempt === 1) {
          const unknown = new TransactionalBackfillError('WRITE_OUTCOME_UNKNOWN');
          unknown.cause = firstError;
          throw unknown;
        }
      }
    }
  }
  if (!response) fail('WRITE_OUTCOME_UNKNOWN');
  await afterWrite();
  const verified = await verifyTenantTwice(request, planned, requestTimeoutMs, signal, { requireRevisionZero: true });
  return { ...verified, result: 'initialized', outcomeRecoveredAfterError: false };
}

function evidenceBase({ args, runtime, manifest, release, fence = null }) {
  return {
    schema: SCHEMA,
    operation: args.apply ? 'apply' : 'preview',
    releaseSha: release,
    target: {
      mode: 'production',
      projectRefSha256: runtime.projectRefSha256,
      serviceId: runtime.serviceId,
      instanceId: runtime.instanceId,
      attachedLiveness: runtime.attachedLiveness === true,
      tenantRepositoryMode: runtime.tenantRepositoryMode,
      platformRepositoryMode: runtime.platformRepositoryMode
    },
    expectedPopulation: {
      schema: manifest.schema,
      manifestSha256: manifest.sha256,
      tenantCount: manifest.tenantCount
    },
    maintenanceFence: fence ? {
      digest: fence.digest,
      openedAt: fence.openedAt,
      mode: fence.mode,
      source: fence.source
    } : null
  };
}

async function execute(args, env = process.env, dependencies = {}) {
  const signal = dependencies.signal || null;
  throwIfAborted(signal);
  if (env !== process.env && !dependencies.request) fail('REQUEST_ENV_MISMATCH');
  const manifest = loadExpectedPopulationManifest(args.expectedPopulationManifest, args.expectedPopulationSha256);
  const runtime = validateBackfillRuntime(args, env);
  const release = releaseSha(env);
  runtime.attachedLiveness = await (dependencies.verifyAttachedRuntime || verifyAttachedRuntime)(env, {
    fetchImpl: dependencies.fetch,
    signal
  });
  preflightEvidenceDestination(args.evidence);
  const request = dependencies.request || supabase.request;
  const fenceApi = dependencies.maintenanceFence || maintenanceFence;
  const fenceOptions = {
    root: path.resolve(__dirname, '..'),
    expectedServiceId: args.expectedServiceId,
    expectedInstanceId: args.expectedInstanceId
  };
  let initialFence = null;
  let beforePlan = null;
  const journal = [];
  const mutationAttempts = [];
  let mutationDispatched = false;
  const startedAt = new Date().toISOString();
  let base = evidenceBase({ args, runtime, manifest, release });
  try {
    if (args.apply) {
      initialFence = fenceApi.requireVerifiedFence(env, fenceOptions);
      base = evidenceBase({ args, runtime, manifest, release, fence: initialFence });
    }
    const initialCatalog = await stableCatalog({
      request,
      requestTimeoutMs: args.requestTimeoutMs,
      captureTimeoutMs: args.captureTimeoutMs,
      signal
    });
    beforePlan = buildPlan(initialCatalog, manifest);
    if (beforePlan.status !== 'ready') fail('BACKFILL_DRIFT', publicPlan(beforePlan));
    if (!args.apply) {
      const result = {
        ...base,
        status: 'ready',
        writesPerformed: false,
        startedAt,
        completedAt: new Date().toISOString(),
        plan: publicPlan(beforePlan)
      };
      const sha256 = writeEvidenceExclusive(args.evidence, result);
      return { ...result, evidence: { written: true, sha256 } };
    }
    const fenceCheck = () => Promise.resolve(requireSameFence(fenceApi, env, fenceOptions, initialFence));
    for (const tenant of beforePlan.tenants.filter(item => item.action === 'initialize')) {
      throwIfAborted(signal);
      await fenceCheck();
      const attemptState = { tenantRef: tenant.tenantRef, status: 'pending', dispatches: 0 };
      mutationAttempts.push(attemptState);
      const initialized = await initializeTenant({
        request,
        planned: tenant,
        requestTimeoutMs: args.requestTimeoutMs,
        signal,
        beforeWrite: fenceCheck,
        afterWrite: fenceCheck,
        onDispatch: () => {
          mutationDispatched = true;
          attemptState.dispatches += 1;
          attemptState.status = 'dispatched-outcome-unverified';
        }
      });
      attemptState.status = 'verified';
      journal.push(initialized);
    }
    await fenceCheck();
    const finalCatalog = await stableCatalog({
      request,
      requestTimeoutMs: args.requestTimeoutMs,
      captureTimeoutMs: args.captureTimeoutMs,
      signal
    });
    const finalPlan = buildPlan(finalCatalog, manifest);
    if (finalPlan.status !== 'ready' || finalPlan.initializeTenants !== 0 ||
        finalPlan.exactTenants !== manifest.tenantCount) fail('FINAL_RECONCILIATION_FAILED', publicPlan(finalPlan));
    await fenceCheck();
    const result = {
      ...base,
      status: 'verified',
      writesPerformed: journal.length > 0,
      startedAt,
      completedAt: new Date().toISOString(),
      before: publicPlan(beforePlan),
      initialized: journal.map(item => ({
        tenantRef: item.tenantRef,
        revision: item.revision,
        contentHash: item.contentHash,
        records: item.records,
        outcomeRecoveredAfterError: item.outcomeRecoveredAfterError
      })),
      mutationAttempts,
      after: publicPlan(finalPlan),
      verification: 'two-stable-full-catalog-captures-and-two-exact-tenant-reads'
    };
    const sha256 = writeEvidenceExclusive(args.evidence, result);
    return { ...result, evidence: { written: true, sha256 } };
  } catch (error) {
    if (args.apply && base && !fs.existsSync(args.evidence) && !fs.existsSync(`${args.evidence}.sha256`)) {
      const failure = {
        ...base,
        status: 'inconclusive',
        writesPerformed: journal.length > 0 ? true : mutationDispatched ? null : false,
        writeOutcome: journal.length > 0
          ? mutationAttempts.every(item => item.status === 'verified') ? 'partially-or-fully-verified' : 'outcome-unknown'
          : mutationDispatched ? 'outcome-unknown' : 'no-mutation-dispatched',
        startedAt,
        completedAt: new Date().toISOString(),
        reason: error?.code && /^[A-Z0-9_]+$/.test(error.code) ? error.code : 'BACKFILL_FAILED',
        before: beforePlan ? publicPlan(beforePlan) : null,
        initialized: journal.map(item => ({
          tenantRef: item.tenantRef,
          revision: item.revision,
          contentHash: item.contentHash,
          records: item.records,
          outcomeRecoveredAfterError: item.outcomeRecoveredAfterError
        })),
        mutationAttempts,
        nextStep: 'Keep writes fenced. Re-run preview and reconcile the evidence before any retry.'
      };
      try { error.evidenceSha256 = writeEvidenceExclusive(args.evidence, failure); } catch {}
    }
    throw error;
  }
}

function sanitizedResult(result) {
  return {
    ok: true,
    schema: result.schema,
    operation: result.operation,
    status: result.status,
    writesPerformed: result.writesPerformed,
    expectedTenants: result.expectedPopulation.tenantCount,
    initializeTenants: result.plan?.initializeTenants ?? result.before?.initializeTenants ?? 0,
    exactTenants: result.plan?.exactTenants ?? result.after?.exactTenants ?? 0,
    initializedTenants: result.initialized?.length ?? 0,
    evidenceSha256: result.evidence.sha256
  };
}

function sanitizedFailure(error) {
  const code = error?.code && /^[A-Z0-9_]+$/.test(error.code) ? error.code :
    /argument|requires|provided|unsupported|absolute|unused/i.test(String(error?.message || '')) ? 'INVALID_ARGUMENT' : 'BACKFILL_FAILED';
  return {
    ok: false,
    schema: SCHEMA,
    status: 'inconclusive',
    reason: code,
    writesPerformed: null,
    evidenceSha256: SHA256.test(String(error?.evidenceSha256 || '')) ? error.evidenceSha256 : null,
    message: code === 'INVALID_ARGUMENT'
      ? 'The transactional backfill command arguments are invalid. Review the runbook and retry.'
      : code === 'BACKFILL_DRIFT'
        ? 'The legacy, transactional, or independent tenant population is not an exact match. No backfill write was attempted.'
        : code === 'WRITE_OUTCOME_UNKNOWN'
          ? 'A backfill write outcome could not be proven. Keep writes fenced and reconcile before retrying.'
          : 'The transactional backfill did not complete. Keep writes fenced and review the immutable evidence.'
  };
}

module.exports = {
  SCHEMA,
  CONFIRMATION,
  TransactionalBackfillError,
  parseArgs,
  configuredSupabaseProjectRef,
  validateBackfillRuntime,
  buildPlan,
  publicPlan,
  captureCatalog,
  stableCatalog,
  execute,
  sanitizedResult,
  sanitizedFailure
};
