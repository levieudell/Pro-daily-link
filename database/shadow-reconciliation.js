'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  assembleSnapshot,
  canonicalHash: tenantCanonicalHash,
  databaseCompanyId
} = require('./transactional-repository');
const {
  PLATFORM_NAMESPACE_ID,
  assemblePlatformSnapshot,
  canonicalHash: platformCanonicalHash
} = require('./platform-repository');

const SCHEMA = 'pdl-shadow-reconciliation/v1';
const EXPECTED_POPULATION_SCHEMA = 'pdl-shadow-expected-population/v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;
const OPAQUE_TENANT_REF = /^[a-f0-9]{24}$/;
const SAFE_COLLECTION_NAMES = new Set([
  'assignments',
  'auditEvents',
  'auditLog',
  'blogPosts',
  'catalog',
  'changes',
  'crews',
  'customers',
  'dailyTemplates',
  'demoRequests',
  'estimateImports',
  'followUps',
  'growthOpportunities',
  'helpItems',
  'notes',
  'onboardingOrders',
  'photos',
  'platformAuditOutbox',
  'projectNotesTodos',
  'projectSiteVisits',
  'projectEvents',
  'projectMessages',
  'projectPlans',
  'projectTasks',
  'projectTickets',
  'projects',
  'reportingExports',
  'reports',
  'safetyDays',
  'sessions',
  'subcontractorLinks',
  'subcontractors',
  'supportGrants',
  'supportTickets',
  'team',
  'tenantDeletionCleanupJobs',
  'timeCards',
  'timeOffRequests',
  'payPeriods',
  'payPeriodExports',
  'assistantConfirmations',
  'companyActivityCodes',
  'users',
  'workdays'
]);
const DEFAULTS = Object.freeze({
  maxSamples: 8,
  stableSamples: 3,
  intervalMs: 750,
  requestTimeoutMs: 10_000,
  captureTimeoutMs: 120_000
});
const FULL_CATALOG_PAGE_SIZE = 10;
const MAX_CATALOG_PAGES = 10_000;
const MAX_CATALOG_TENANTS = 10_000;
const MAX_EVIDENCE_BYTES = 50 * 1024 * 1024;
const MAX_EXPECTED_POPULATION_BYTES = 2 * 1024 * 1024;

class ShadowReconciliationError extends Error {
  constructor(code) {
    super(code);
    this.name = 'ShadowReconciliationError';
    this.code = code;
  }
}

function fail(code) {
  throw new ShadowReconciliationError(code);
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  if (signal.reason instanceof ShadowReconciliationError) throw signal.reason;
  fail('INTERRUPTED');
}

function abortableAwait(value, signal) {
  throwIfAborted(signal);
  const promise = Promise.resolve(value);
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = callback => {
      if (settled) return;
      settled = true;
      signal.removeEventListener?.('abort', onAbort);
      callback();
    };
    const onAbort = () => finish(() => {
      try { throwIfAborted(signal); } catch (error) { reject(error); }
    });
    signal.addEventListener?.('abort', onAbort, { once: true });
    promise.then(
      result => finish(() => resolve(result)),
      error => finish(() => reject(error))
    );
    if (signal.aborted) onAbort();
  });
}

function abortableSleep(milliseconds, signal) {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = callback => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(new ShadowReconciliationError('INTERRUPTED')));
    const timer = setTimeout(() => finish(resolve), milliseconds);
    timer.unref?.();
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function integerOption(value, label, minimum, maximum) {
  if (!/^\d+$/.test(String(value ?? ''))) throw new Error(`${label} must be an integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

function parseArgs(argv = process.argv.slice(2)) {
  const output = {
    scope: '',
    companyId: '',
    evidence: '',
    expectedServiceId: '',
    expectedInstanceId: '',
    expectedPopulationManifest: '',
    expectedPopulationSha256: '',
    ...DEFAULTS
  };
  const scopes = [];
  const seen = new Set();
  const readValue = (index, flag) => {
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value.`);
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (seen.has(argument)) throw new Error(`Duplicate argument: ${argument}`);
    seen.add(argument);
    if (argument === '--all') { scopes.push('all'); continue; }
    if (argument === '--platform-only') { scopes.push('platform'); continue; }
    if (argument === '--company-id') {
      const value = readValue(index, argument).toLowerCase();
      index += 1;
      if (!UUID.test(value)) throw new Error('--company-id must be an exact database UUID.');
      if (value === PLATFORM_NAMESPACE_ID) throw new Error('--company-id cannot target the reserved platform namespace; use --platform-only.');
      output.companyId = value;
      scopes.push('tenant');
      continue;
    }
    if (argument === '--evidence') {
      output.evidence = readValue(index, argument);
      index += 1;
      if (!path.isAbsolute(output.evidence)) throw new Error('--evidence must be an absolute, unused JSON path.');
      continue;
    }
    if (argument === '--expected-service-id') {
      output.expectedServiceId = readValue(index, argument);
      index += 1;
      if (!/^srv-[a-z0-9]{20,64}$/.test(output.expectedServiceId)) throw new Error('--expected-service-id must be an exact Render service ID.');
      continue;
    }
    if (argument === '--expected-instance-id') {
      output.expectedInstanceId = readValue(index, argument);
      index += 1;
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/.test(output.expectedInstanceId)) throw new Error('--expected-instance-id must be an exact Render instance ID.');
      continue;
    }
    if (argument === '--expected-population-manifest') {
      output.expectedPopulationManifest = readValue(index, argument);
      index += 1;
      if (!path.isAbsolute(output.expectedPopulationManifest)) {
        throw new Error('--expected-population-manifest must be an absolute JSON path.');
      }
      continue;
    }
    if (argument === '--expected-population-sha256') {
      output.expectedPopulationSha256 = readValue(index, argument).toLowerCase();
      index += 1;
      if (!SHA256.test(output.expectedPopulationSha256)) {
        throw new Error('--expected-population-sha256 must be an exact lowercase SHA-256 digest.');
      }
      continue;
    }
    const numeric = {
      '--max-samples': ['maxSamples', 2, 20],
      '--stable-samples': ['stableSamples', 2, 10],
      '--interval-ms': ['intervalMs', 0, 10_000],
      '--request-timeout-ms': ['requestTimeoutMs', 250, 60_000],
      '--capture-timeout-ms': ['captureTimeoutMs', 1_000, 900_000]
    }[argument];
    if (numeric) {
      output[numeric[0]] = integerOption(readValue(index, argument), argument, numeric[1], numeric[2]);
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  if (scopes.length !== 1) throw new Error('Choose exactly one reconciliation scope: --all, --company-id, or --platform-only.');
  output.scope = scopes[0];
  if (output.stableSamples > output.maxSamples) throw new Error('--max-samples must be at least --stable-samples.');
  if (Boolean(output.expectedPopulationManifest) !== Boolean(output.expectedPopulationSha256)) {
    throw new Error('--expected-population-manifest and --expected-population-sha256 must be provided together.');
  }
  if (output.expectedPopulationManifest && output.scope !== 'all') {
    throw new Error('--expected-population-manifest is valid only with --all.');
  }
  return output;
}

function loadExpectedPopulationManifest(file, expectedSha256) {
  if (!path.isAbsolute(String(file || '')) || !SHA256.test(String(expectedSha256 || ''))) {
    fail('EXPECTED_POPULATION_INVALID');
  }
  let stat;
  let linkStat;
  let bytes;
  try {
    linkStat = fs.lstatSync(file);
    stat = fs.statSync(file);
    if (linkStat.isSymbolicLink() || !stat.isFile() || stat.size < 2 || stat.size > MAX_EXPECTED_POPULATION_BYTES) {
      fail('EXPECTED_POPULATION_INVALID');
    }
    bytes = fs.readFileSync(file);
  } catch (error) {
    if (error instanceof ShadowReconciliationError) throw error;
    fail('EXPECTED_POPULATION_INVALID');
  }
  const actualSha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  const expectedBuffer = Buffer.from(expectedSha256, 'hex');
  const actualBuffer = Buffer.from(actualSha256, 'hex');
  if (expectedBuffer.length !== actualBuffer.length || !crypto.timingSafeEqual(expectedBuffer, actualBuffer)) {
    fail('EXPECTED_POPULATION_SHA_MISMATCH');
  }
  let manifest;
  try { manifest = JSON.parse(bytes.toString('utf8')); } catch { fail('EXPECTED_POPULATION_INVALID'); }
  if (!plainObject(manifest) || Object.keys(manifest).sort().join(',') !== 'schema,tenantCount,tenantRefs' ||
      manifest.schema !== EXPECTED_POPULATION_SCHEMA || !Number.isSafeInteger(manifest.tenantCount) ||
      manifest.tenantCount < 1 || manifest.tenantCount > MAX_CATALOG_TENANTS || !Array.isArray(manifest.tenantRefs) ||
      manifest.tenantRefs.length !== manifest.tenantCount) {
    fail('EXPECTED_POPULATION_INVALID');
  }
  const tenantRefs = manifest.tenantRefs.map(value => String(value));
  if (tenantRefs.some(value => !OPAQUE_TENANT_REF.test(value)) ||
      new Set(tenantRefs).size !== tenantRefs.length ||
      tenantRefs.some((value, index) => index > 0 && tenantRefs[index - 1] >= value)) {
    fail('EXPECTED_POPULATION_INVALID');
  }
  return Object.freeze({
    schema: EXPECTED_POPULATION_SCHEMA,
    sha256: actualSha256,
    tenantCount: tenantRefs.length,
    tenantRefs: Object.freeze(tenantRefs)
  });
}

function canonicalSnapshotState(snapshot, { kind = 'tenant' } = {}) {
  if (!plainObject(snapshot)) fail('PROVIDER_PAYLOAD_INVALID');
  const collectionCounts = {};
  let records = 0;
  for (const key of Object.keys(snapshot).sort()) {
    if (!Array.isArray(snapshot[key])) continue;
    const evidenceKey = SAFE_COLLECTION_NAMES.has(key)
      ? key
      : `unknown_${crypto.createHash('sha256').update(`pdl-shadow-collection:v1:${key}`).digest('hex').slice(0, 24)}`;
    collectionCounts[evidenceKey] = snapshot[key].length;
    records += snapshot[key].length;
  }
  return {
    canonicalSha256: kind === 'platform' ? platformCanonicalHash(snapshot) : tenantCanonicalHash(snapshot),
    records,
    collectionCounts,
    topLevelKeys: Object.keys(snapshot).sort().length,
    persistenceRevision: kind === 'tenant' && Number.isSafeInteger(Number(snapshot.company?.persistence?.revision))
      ? Number(snapshot.company.persistence.revision)
      : null
  };
}

function opaqueTenantRef(companyId) {
  return crypto.createHash('sha256').update(`pdl-shadow-reconciliation:v1:${String(companyId).toLowerCase()}`).digest('hex').slice(0, 24);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (!plainObject(value)) return JSON.stringify(value);
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

async function collectPages(loadPage, { pageSize = 250, maxPages = 10_000, rowKey = null } = {}) {
  if (typeof loadPage !== 'function') throw new TypeError('loadPage must be a function.');
  const rows = [];
  const cursors = new Set();
  const identities = new Set();
  let cursor = null;
  for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
    const page = await loadPage({ cursor, limit: pageSize });
    if (!plainObject(page) || !Array.isArray(page.rows) || page.rows.length > pageSize) fail('PROVIDER_PAYLOAD_INVALID');
    for (const row of page.rows) {
      if (rowKey) {
        const identity = String(rowKey(row) ?? '');
        if (!identity || identities.has(identity)) fail('PROVIDER_PAYLOAD_INVALID');
        identities.add(identity);
      }
      rows.push(row);
    }
    const next = page.nextCursor == null || page.nextCursor === '' ? null : String(page.nextCursor);
    if (next === null) return rows;
    if (next === cursor || cursors.has(next)) fail('PAGINATION_CURSOR_REPEATED');
    cursors.add(next);
    cursor = next;
  }
  fail('PAGINATION_INCOMPLETE');
}

function normalizedTransactional(value, companyId) {
  if (value == null) return null;
  if (!plainObject(value) || !plainObject(value.snapshot)) fail('PROVIDER_PAYLOAD_INVALID');
  const actualDatabaseId = String(value.databaseCompanyId || databaseCompanyId(value.snapshot)).toLowerCase();
  if (!UUID.test(actualDatabaseId) || (companyId && actualDatabaseId !== companyId)) fail('WRONG_TENANT');
  const state = canonicalSnapshotState(value.snapshot);
  const storedHash = String(value.contentHash || '').toLowerCase();
  const revision = Number(value.revision);
  if (!SHA256.test(storedHash) || !Number.isSafeInteger(revision) || revision < 0) fail('PROVIDER_PAYLOAD_INVALID');
  return { ...state, repositoryRevision: revision, storedSha256: storedHash, integrity: storedHash === state.canonicalSha256 };
}

function normalizedTenantSource(value, companyId) {
  if (value == null) return null;
  const actualDatabaseId = String(databaseCompanyId(value)).toLowerCase();
  if (!UUID.test(actualDatabaseId) || (companyId && actualDatabaseId !== companyId)) fail('WRONG_TENANT');
  return canonicalSnapshotState(value);
}

function normalizeSingleCapture(capture, companyId) {
  if (!plainObject(capture)) fail('PROVIDER_PAYLOAD_INVALID');
  return {
    local: normalizedTenantSource(capture.local, companyId),
    legacy: normalizedTenantSource(capture.legacy, companyId),
    transactional: normalizedTransactional(capture.transactional, companyId)
  };
}

function sourceComparable(source) {
  if (!source) return null;
  return {
    records: source.records,
    collectionCounts: source.collectionCounts
  };
}

function compareSingleCapture(capture, { requiredSources = ['legacy', 'transactional'], companyId = '' } = {}) {
  const missing = requiredSources.filter(source => !capture[source]);
  const available = ['local', 'legacy', 'transactional'].filter(source => capture[source]);
  const hashes = new Set(available.map(source => capture[source].canonicalSha256));
  const countShapes = new Set(available.map(source => stableJson(sourceComparable(capture[source]))));
  const integrity = capture.transactional?.integrity !== false;
  const status = missing.length ? 'missing_source' : integrity && hashes.size === 1 && countShapes.size === 1 ? 'reconciled' : 'drift';
  return {
    schema: SCHEMA,
    status,
    writesPerformed: false,
    stable: true,
    scope: { kind: 'tenant', tenantRef: opaqueTenantRef(companyId) },
    sources: {
      local: capture.local ? { present: true, ...capture.local } : { present: false },
      legacy: capture.legacy ? { present: true, ...capture.legacy } : { present: false },
      transactional: capture.transactional ? { present: true, ...capture.transactional } : { present: false }
    },
    comparison: {
      missingSources: missing,
      allCanonicalHashesEqual: hashes.size === 1,
      allCollectionCountsEqual: countShapes.size === 1,
      transactionalIntegrity: integrity
    }
  };
}

async function reconcileShadow({
  scope,
  capture,
  requiredSources = ['legacy', 'transactional'],
  stableSamples = DEFAULTS.stableSamples,
  maxSamples = DEFAULTS.maxSamples,
  intervalMs = DEFAULTS.intervalMs,
  signal = null,
  sleep = milliseconds => abortableSleep(milliseconds, signal),
  now = () => new Date().toISOString(),
  normalize = value => normalizeSingleCapture(value, scope?.companyId),
  signature = value => stableJson(value),
  compare = value => compareSingleCapture(value, { requiredSources, companyId: scope?.companyId })
} = {}) {
  if (typeof capture !== 'function') throw new TypeError('capture must be a function.');
  let previousSignature = '';
  let consecutive = 0;
  let observed = 0;
  let last = null;
  let lastError = null;
  const startedAt = now();
  for (let sample = 0; sample < maxSamples; sample += 1) {
    throwIfAborted(signal);
    observed += 1;
    try {
      const normalized = normalize(await capture());
      throwIfAborted(signal);
      const currentSignature = signature(normalized);
      consecutive = currentSignature === previousSignature ? consecutive + 1 : 1;
      previousSignature = currentSignature;
      last = normalized;
      lastError = null;
      if (consecutive >= stableSamples) {
        const result = compare(last);
        return {
          ...result,
          observedAt: now(),
          startedAt,
          stable: true,
          observedSamples: observed,
          stability: { requiredSamples: stableSamples, observedSamples: observed, intervalMs }
        };
      }
    } catch (error) {
      if (error instanceof ShadowReconciliationError && error.code === 'INTERRUPTED') throw error;
      consecutive = 0;
      previousSignature = '';
      last = null;
      lastError = error instanceof ShadowReconciliationError ? error.code : 'PROVIDER_UNREACHABLE';
    }
    if (sample + 1 < maxSamples) {
      throwIfAborted(signal);
      await sleep(intervalMs);
    }
  }
  return {
    schema: SCHEMA,
    status: 'inconclusive',
    writesPerformed: false,
    stable: false,
    observedAt: now(),
    startedAt,
    observedSamples: observed,
    stability: { requiredSamples: stableSamples, observedSamples: observed, intervalMs },
    reason: lastError || 'UNSTABLE_READ'
  };
}

function safeReadJson(file, required = false) {
  if (!fs.existsSync(file)) {
    if (required) fail('LOCAL_SOURCE_MISSING');
    return null;
  }
  try {
    const linkStat = fs.lstatSync(file);
    const stat = fs.statSync(file);
    if (linkStat.isSymbolicLink() || !stat.isFile() || stat.size > 100 * 1024 * 1024) fail('LOCAL_SOURCE_INVALID');
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!plainObject(parsed)) fail('LOCAL_SOURCE_INVALID');
    return parsed;
  } catch (error) {
    if (error instanceof ShadowReconciliationError) throw error;
    fail('LOCAL_SOURCE_INVALID');
  }
}

function tenantSnapshotDisposition(snapshot) {
  if (!plainObject(snapshot) || !plainObject(snapshot.company) ||
      (typeof snapshot.company.id !== 'string' && typeof snapshot.company.id !== 'number') ||
      !String(snapshot.company.id).trim()) {
    return 'malformed';
  }
  if (snapshot.platform) return 'platform';
  if (snapshot.mcpOauth || snapshot.company.mcpConnector === true) return 'connector';
  if (snapshot.company.archivedDuplicate === true) return 'archived';
  if (snapshot.company.deletedAt) return 'deleted';
  return 'eligible';
}

function eligibleTenantSnapshot(snapshot) {
  return tenantSnapshotDisposition(snapshot) === 'eligible';
}

function tenantEntry(snapshot, expectedDatabaseId = '', { invalidCode = 'PROVIDER_PAYLOAD_INVALID' } = {}) {
  const disposition = tenantSnapshotDisposition(snapshot);
  if (disposition !== 'eligible') {
    if (disposition === 'malformed') fail(invalidCode);
    return null;
  }
  let id;
  try { id = String(databaseCompanyId(snapshot)).toLowerCase(); } catch { fail(invalidCode); }
  if (!UUID.test(id) || (expectedDatabaseId && id !== expectedDatabaseId)) fail('WRONG_TENANT');
  return { id, state: canonicalSnapshotState(snapshot) };
}

function addUnique(map, entry) {
  if (!entry) return;
  if (map.has(entry.id)) fail('DUPLICATE_TENANT');
  if (map.size >= MAX_CATALOG_TENANTS) fail('CATALOG_LIMIT_EXCEEDED');
  map.set(entry.id, entry);
}

function listLocalTenantEntries({ dbFile, scope = 'all', companyId = '' }) {
  const result = new Map();
  const primary = safeReadJson(dbFile, scope === 'all');
  if (primary) {
    const entry = tenantEntry(primary, '', { invalidCode: 'LOCAL_SOURCE_INVALID' });
    if (!entry) fail('LOCAL_SOURCE_INVALID');
    if (entry && (scope === 'all' || entry.id === companyId)) addUnique(result, entry);
  }
  const directory = path.join(path.dirname(dbFile), 'tenants');
  if (!fs.existsSync(directory)) return result;
  let files;
  try {
    files = fs.readdirSync(directory).filter(file => file.endsWith('.json')).sort();
  } catch {
    fail('LOCAL_SOURCE_UNAVAILABLE');
  }
  if (files.length > MAX_CATALOG_TENANTS) fail('CATALOG_LIMIT_EXCEEDED');
  for (const file of files) {
    const snapshot = safeReadJson(path.join(directory, file), false);
    if (!snapshot) continue;
    const disposition = tenantSnapshotDisposition(snapshot);
    if (disposition === 'malformed' || disposition === 'platform') fail('LOCAL_SOURCE_INVALID');
    let shardDatabaseId;
    try { shardDatabaseId = String(databaseCompanyId(snapshot)).toLowerCase(); } catch { fail('LOCAL_SOURCE_INVALID'); }
    if (!UUID.test(shardDatabaseId)) fail('LOCAL_SOURCE_INVALID');
    if (path.basename(file, '.json').toLowerCase() !== shardDatabaseId) fail('LOCAL_SOURCE_ID_MISMATCH');
    if (disposition !== 'eligible') continue;
    const entry = tenantEntry(snapshot, '', { invalidCode: 'LOCAL_SOURCE_INVALID' });
    if (entry && (scope === 'all' || entry.id === companyId)) addUnique(result, entry);
  }
  return result;
}

function readOnlyTransport(baseRequest, requestTimeoutMs, { signal = null } = {}) {
  if (typeof baseRequest !== 'function') throw new TypeError('A Supabase request function is required.');
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1) throw new TypeError('requestTimeoutMs must be a positive integer.');
  const guarded = async (relativePath, options = {}) => {
    throwIfAborted(signal);
    let parsed;
    if (typeof relativePath !== 'string' || !relativePath.startsWith('/rest/v1/') || relativePath.startsWith('//')) fail('PROVIDER_REQUEST_BLOCKED');
    try { parsed = new URL(relativePath, 'https://read-only.invalid'); } catch { fail('PROVIDER_REQUEST_BLOCKED'); }
    if (parsed.origin !== 'https://read-only.invalid' || parsed.hash) fail('PROVIDER_REQUEST_BLOCKED');
    const method = String(options.method || 'GET').toUpperCase();
    const rpc = parsed.pathname.match(/^\/rest\/v1\/rpc\/([a-z_]+)$/)?.[1] || '';
    const queryKeys = [...parsed.searchParams.keys()].sort();
    if (new Set(queryKeys).size !== queryKeys.length) fail('PROVIDER_REQUEST_BLOCKED');
    const isPagedCompanyRead = parsed.searchParams.get('select') === 'id,data' &&
      parsed.searchParams.get('order') === 'id.asc' &&
      /^\d{1,4}$/.test(parsed.searchParams.get('limit') || '') &&
      (!parsed.searchParams.has('id') || /^gt\.[0-9a-f-]{36}$/i.test(parsed.searchParams.get('id'))) &&
      queryKeys.every(key => ['id', 'limit', 'order', 'select'].includes(key));
    const isExactCompanyRead = parsed.searchParams.get('select') === 'id,data' &&
      parsed.searchParams.get('limit') === '1' &&
      /^eq\.[0-9a-f-]{36}$/i.test(parsed.searchParams.get('id') || '') &&
      queryKeys.every(key => ['id', 'limit', 'select'].includes(key));
    const allowedCompanyRead = method === 'GET' && options.body == null && parsed.pathname === '/rest/v1/companies' && (isPagedCompanyRead || isExactCompanyRead);
    const allowedRpc = method === 'POST' && !parsed.search && ['list_tenant_repository_page', 'load_tenant_repository', 'load_platform_repository'].includes(rpc);
    if (!allowedCompanyRead && !allowedRpc) fail('PROVIDER_REQUEST_BLOCKED');
    if (['PUT', 'PATCH', 'DELETE'].includes(method) || /(?:replace|save|upload|delete|purge)/i.test(rpc)) fail('PROVIDER_REQUEST_BLOCKED');
    if (allowedRpc) {
      let body;
      try { body = JSON.parse(String(options.body || '{}')); } catch { fail('PROVIDER_REQUEST_BLOCKED'); }
      if (!plainObject(body)) fail('PROVIDER_REQUEST_BLOCKED');
      const keys = Object.keys(body).sort();
      const valid = rpc === 'load_platform_repository'
        ? keys.join(',') === 'p_namespace_id' && body.p_namespace_id === PLATFORM_NAMESPACE_ID
        : rpc === 'load_tenant_repository'
          ? keys.join(',') === 'p_company_id' && UUID.test(String(body.p_company_id || ''))
          : keys.join(',') === 'p_after_company_id,p_limit' &&
            (body.p_after_company_id == null || UUID.test(String(body.p_after_company_id))) &&
            Number.isSafeInteger(Number(body.p_limit)) && Number(body.p_limit) >= 1 && Number(body.p_limit) <= 250;
      if (!valid) fail('PROVIDER_REQUEST_BLOCKED');
    }
    const controller = new AbortController();
    const abortFromCaller = () => controller.abort(
      signal.reason instanceof ShadowReconciliationError ? signal.reason : new ShadowReconciliationError('INTERRUPTED')
    );
    signal?.addEventListener?.('abort', abortFromCaller, { once: true });
    if (signal?.aborted) abortFromCaller();
    const timer = setTimeout(
      () => controller.abort(new ShadowReconciliationError('PROVIDER_TIMEOUT')),
      requestTimeoutMs
    );
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', abortFromCaller);
    };
    try {
      const response = await abortableAwait(
        baseRequest(relativePath, { ...options, method, signal: controller.signal }),
        controller.signal
      );
      if (!response || typeof response.json !== 'function') {
        cleanup();
        fail('PROVIDER_PAYLOAD_INVALID');
      }
      return {
        ok: response.ok,
        status: response.status,
        release: cleanup,
        async json() {
          try {
            return await abortableAwait(response.json(), controller.signal);
          } catch (error) {
            if (error instanceof ShadowReconciliationError) throw error;
            throwIfAborted(controller.signal);
            fail('PROVIDER_UNREACHABLE');
          } finally {
            cleanup();
          }
        }
      };
    } catch (error) {
      cleanup();
      if (error instanceof ShadowReconciliationError) throw error;
      throwIfAborted(controller.signal);
      fail('PROVIDER_UNREACHABLE');
    }
  };
  Object.defineProperty(guarded, 'withSignal', {
    value: nextSignal => readOnlyTransport(baseRequest, requestTimeoutMs, { signal: nextSignal }),
    enumerable: false
  });
  return guarded;
}

async function jsonResponse(response) {
  if (!response || typeof response.json !== 'function' || response.ok === false) {
    response?.release?.();
    fail('PROVIDER_PAYLOAD_INVALID');
  }
  try { return await response.json(); } catch (error) {
    if (error instanceof ShadowReconciliationError) throw error;
    fail('PROVIDER_PAYLOAD_INVALID');
  }
}

async function listLegacyRows(request) {
  return collectPages(async ({ cursor, limit }) => {
    const query = `/rest/v1/companies?select=id,data&order=id.asc&limit=${limit}${cursor ? `&id=gt.${encodeURIComponent(cursor)}` : ''}`;
    const payload = await jsonResponse(await request(query, { method: 'GET' }));
    if (!Array.isArray(payload)) fail('PROVIDER_PAYLOAD_INVALID');
    const rows = payload.map(row => {
      const id = String(row?.id || '').toLowerCase();
      if (!UUID.test(id) || !plainObject(row.data)) fail('PROVIDER_PAYLOAD_INVALID');
      return { id, data: row.data };
    });
    const nextCursor = rows.length ? rows.at(-1).id : null;
    return { rows, nextCursor };
  }, { pageSize: 250, maxPages: 10_000, rowKey: row => row.id });
}

async function loadLegacyRow(request, companyId) {
  const payload = await jsonResponse(await request(`/rest/v1/companies?id=eq.${encodeURIComponent(companyId)}&select=id,data&limit=1`, { method: 'GET' }));
  if (!Array.isArray(payload) || payload.length > 1) fail('PROVIDER_PAYLOAD_INVALID');
  if (!payload.length) return null;
  const row = payload[0];
  const id = String(row?.id || '').toLowerCase();
  if (id !== companyId || !plainObject(row.data)) fail('PROVIDER_PAYLOAD_INVALID');
  return { id, data: row.data };
}

function parseTransactionalRow(row) {
  if (!plainObject(row)) fail('PROVIDER_PAYLOAD_INVALID');
  const id = String(row.companyId ?? row.company_id ?? '').toLowerCase();
  const revision = Number(row.revision);
  const scalarData = row.scalarData ?? row.scalar_data;
  const records = row.records;
  const storedSha256 = String(row.contentHash ?? row.content_hash ?? '').toLowerCase();
  if (!UUID.test(id) || !Number.isSafeInteger(revision) || revision < 0 || !plainObject(scalarData) || !Array.isArray(records) || !SHA256.test(storedSha256)) {
    fail('PROVIDER_PAYLOAD_INVALID');
  }
  for (const record of records) {
    if (!plainObject(record) || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(String(record.collection || '')) ||
        !Object.hasOwn(record, 'data')) fail('PROVIDER_PAYLOAD_INVALID');
  }
  let snapshot;
  try { snapshot = assembleSnapshot(scalarData, records); } catch { fail('PROVIDER_PAYLOAD_INVALID'); }
  const disposition = tenantSnapshotDisposition(snapshot);
  if (disposition === 'malformed' || disposition === 'platform') fail('PROVIDER_PAYLOAD_INVALID');
  let actualDatabaseId;
  try { actualDatabaseId = String(databaseCompanyId(snapshot)).toLowerCase(); } catch { fail('PROVIDER_PAYLOAD_INVALID'); }
  if (actualDatabaseId !== id) fail('WRONG_TENANT');
  const state = canonicalSnapshotState(snapshot);
  if (disposition !== 'eligible') {
    if (storedSha256 !== state.canonicalSha256) fail('PROVIDER_PAYLOAD_INVALID');
    return { id, excludedReason: disposition };
  }
  return { id, state: { ...state, repositoryRevision: revision, storedSha256, integrity: storedSha256 === state.canonicalSha256 } };
}

async function listTransactionalRows(request) {
  return collectPages(async ({ cursor, limit }) => {
    const payload = await jsonResponse(await request('/rest/v1/rpc/list_tenant_repository_page', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_after_company_id: cursor, p_limit: limit })
    }));
    if (!plainObject(payload) || !Array.isArray(payload.rows)) fail('PROVIDER_PAYLOAD_INVALID');
    return { rows: payload.rows.map(parseTransactionalRow), nextCursor: payload.nextCompanyId ?? payload.next_company_id ?? null };
  }, { pageSize: 100, maxPages: 10_000, rowKey: row => row.id });
}

async function loadTransactionalRow(request, companyId) {
  const payload = await jsonResponse(await request('/rest/v1/rpc/load_tenant_repository', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_company_id: companyId })
  }));
  if (payload == null) return null;
  if (Array.isArray(payload) && payload.length > 1) fail('PROVIDER_PAYLOAD_INVALID');
  const row = Array.isArray(payload) ? payload[0] : payload;
  return row ? parseTransactionalRow(row) : null;
}

function legacyTenantDisposition(row) {
  if (Object.hasOwn(row.data, 'platform')) fail('PROVIDER_PAYLOAD_INVALID');
  const disposition = tenantSnapshotDisposition(row.data);
  if (disposition === 'malformed' || disposition === 'platform') fail('PROVIDER_PAYLOAD_INVALID');
  let actualDatabaseId;
  try { actualDatabaseId = String(databaseCompanyId(row.data)).toLowerCase(); } catch { fail('PROVIDER_PAYLOAD_INVALID'); }
  if (actualDatabaseId !== row.id) fail('WRONG_TENANT');
  return disposition;
}

function legacyPlatformState(row) {
  if (row == null) return null;
  if (row.id !== PLATFORM_NAMESPACE_ID || !plainObject(row.data) ||
      Object.keys(row.data).join(',') !== 'platform' || !plainObject(row.data.platform)) {
    fail('PROVIDER_PAYLOAD_INVALID');
  }
  return canonicalSnapshotState(row.data.platform, { kind: 'platform' });
}

function legacyTenantEntries(rows, scope, companyId) {
  const map = new Map();
  const excluded = { platform: 0, connector: 0, archived: 0, deleted: 0 };
  for (const row of rows) {
    if (row.id === PLATFORM_NAMESPACE_ID) {
      legacyPlatformState(row);
      excluded.platform += 1;
      continue;
    }
    const disposition = legacyTenantDisposition(row);
    if (disposition !== 'eligible') { excluded[disposition] += 1; continue; }
    const entry = tenantEntry(row.data, row.id);
    if (!entry) fail('PROVIDER_PAYLOAD_INVALID');
    if (scope === 'all' || entry.id === companyId) addUnique(map, entry);
  }
  return { map, excluded };
}

function transactionalTenantEntries(rows, scope, companyId) {
  const map = new Map();
  const excludedMap = new Map();
  const excluded = emptyTransactionalExclusions();
  for (const entry of rows) {
    if (entry.excludedReason) {
      if (!Object.hasOwn(excluded, entry.excludedReason)) fail('PROVIDER_PAYLOAD_INVALID');
      if (map.has(entry.id) || excludedMap.has(entry.id)) fail('DUPLICATE_TENANT');
      excluded[entry.excludedReason] += 1;
      excludedMap.set(entry.id, entry.excludedReason);
      continue;
    }
    if (excludedMap.has(entry.id)) fail('DUPLICATE_TENANT');
    if (scope === 'all' || entry.id === companyId) addUnique(map, entry);
  }
  return { map, excluded, excludedMap };
}

function emptyLegacyExclusions() {
  return { platform: 0, connector: 0, archived: 0, deleted: 0 };
}

function emptyTransactionalExclusions() {
  return { connector: 0, archived: 0, deleted: 0 };
}

function normalizeLegacyRow(row) {
  const id = String(row?.id || '').toLowerCase();
  if (!UUID.test(id) || !plainObject(row?.data)) fail('PROVIDER_PAYLOAD_INVALID');
  return { id, data: row.data };
}

function assertStrictKeysetId(id, previousId) {
  if (previousId && id <= previousId) fail('PROVIDER_PAYLOAD_INVALID');
}

async function streamLegacyCatalog(request, {
  pageSize = FULL_CATALOG_PAGE_SIZE,
  maxPages = MAX_CATALOG_PAGES
} = {}) {
  const map = new Map();
  const excluded = emptyLegacyExclusions();
  let platform = null;
  let cursor = null;
  for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
    const query = `/rest/v1/companies?select=id,data&order=id.asc&limit=${pageSize}${cursor ? `&id=gt.${encodeURIComponent(cursor)}` : ''}`;
    const payload = await jsonResponse(await request(query, { method: 'GET' }));
    if (!Array.isArray(payload) || payload.length > pageSize) fail('PROVIDER_PAYLOAD_INVALID');
    let previousId = cursor;
    for (const rawRow of payload) {
      const row = normalizeLegacyRow(rawRow);
      assertStrictKeysetId(row.id, previousId);
      previousId = row.id;
      if (row.id === PLATFORM_NAMESPACE_ID) {
        excluded.platform += 1;
        if (platform) fail('PROVIDER_PAYLOAD_INVALID');
        platform = legacyPlatformState(row);
        continue;
      }
      const disposition = legacyTenantDisposition(row);
      if (disposition !== 'eligible') { excluded[disposition] += 1; continue; }
      const entry = tenantEntry(row.data, row.id);
      if (!entry) fail('PROVIDER_PAYLOAD_INVALID');
      addUnique(map, entry);
    }
    if (payload.length < pageSize) return { map, excluded, platform };
    if (!previousId || previousId === cursor) fail('PAGINATION_CURSOR_REPEATED');
    cursor = previousId;
  }
  fail('PAGINATION_INCOMPLETE');
}

async function streamTransactionalCatalog(request, {
  pageSize = FULL_CATALOG_PAGE_SIZE,
  maxPages = MAX_CATALOG_PAGES
} = {}) {
  const map = new Map();
  const excludedMap = new Map();
  const excluded = emptyTransactionalExclusions();
  const cursors = new Set();
  let cursor = null;
  for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
    const payload = await jsonResponse(await request('/rest/v1/rpc/list_tenant_repository_page', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_after_company_id: cursor, p_limit: pageSize })
    }));
    if (!plainObject(payload) || !Array.isArray(payload.rows) || payload.rows.length > pageSize) fail('PROVIDER_PAYLOAD_INVALID');
    let previousId = cursor;
    for (const rawRow of payload.rows) {
      const entry = parseTransactionalRow(rawRow);
      assertStrictKeysetId(entry.id, previousId);
      previousId = entry.id;
      if (entry.excludedReason) {
        if (!Object.hasOwn(excluded, entry.excludedReason)) fail('PROVIDER_PAYLOAD_INVALID');
        if (map.has(entry.id) || excludedMap.has(entry.id)) fail('DUPLICATE_TENANT');
        excluded[entry.excludedReason] += 1;
        excludedMap.set(entry.id, entry.excludedReason);
      } else {
        if (excludedMap.has(entry.id)) fail('DUPLICATE_TENANT');
        addUnique(map, entry);
      }
    }
    const rawNext = payload.nextCompanyId ?? payload.next_company_id ?? null;
    const next = rawNext == null || rawNext === '' ? null : String(rawNext).toLowerCase();
    if (next === null) {
      if (payload.rows.length === pageSize) fail('PROVIDER_PAYLOAD_INVALID');
      return { map, excluded, excludedMap };
    }
    if (!UUID.test(next) || payload.rows.length !== pageSize || next !== previousId) fail('PROVIDER_PAYLOAD_INVALID');
    if (next === cursor || cursors.has(next)) fail('PAGINATION_CURSOR_REPEATED');
    cursors.add(next);
    cursor = next;
  }
  fail('PAGINATION_INCOMPLETE');
}

function parsePlatformRow(row) {
  if (row == null) return null;
  if (Array.isArray(row) && row.length > 1) fail('PROVIDER_PAYLOAD_INVALID');
  const value = Array.isArray(row) ? row[0] : row;
  if (!plainObject(value)) fail('PROVIDER_PAYLOAD_INVALID');
  const namespaceId = String(value.namespaceId ?? value.namespace_id ?? '').toLowerCase();
  const revision = Number(value.revision);
  const scalarData = value.scalarData ?? value.scalar_data;
  const records = value.records;
  const storedSha256 = String(value.contentHash ?? value.content_hash ?? '').toLowerCase();
  if (namespaceId !== PLATFORM_NAMESPACE_ID || !Number.isSafeInteger(revision) || revision < 0 || !plainObject(scalarData) || !Array.isArray(records) || !SHA256.test(storedSha256)) fail('PROVIDER_PAYLOAD_INVALID');
  let snapshot;
  try { snapshot = assemblePlatformSnapshot(scalarData, records); } catch { fail('PROVIDER_PAYLOAD_INVALID'); }
  const state = canonicalSnapshotState(snapshot, { kind: 'platform' });
  return { ...state, repositoryRevision: revision, storedSha256, integrity: storedSha256 === state.canonicalSha256 };
}

async function loadPlatformRepository(request) {
  const payload = await jsonResponse(await request('/rest/v1/rpc/load_platform_repository', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_namespace_id: PLATFORM_NAMESPACE_ID })
  }));
  return parsePlatformRow(payload);
}

function mapSignature(map) {
  return [...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([id, entry]) => [id, entry.state]);
}

function catalogSignature(catalog) {
  return stableJson({
    tenants: {
      local: mapSignature(catalog.tenants.local),
      legacy: mapSignature(catalog.tenants.legacy),
      transactional: mapSignature(catalog.tenants.transactional)
    },
    platform: catalog.platform,
    excludedLegacyRows: catalog.excludedLegacyRows,
    excludedTransactionalRows: catalog.excludedTransactionalRows
  });
}

function compareStateSet(states) {
  const available = states.filter(Boolean);
  const hashes = new Set(available.map(state => state.canonicalSha256));
  const counts = new Set(available.map(state => stableJson({ records: state.records, collectionCounts: state.collectionCounts })));
  return { hashesEqual: hashes.size === 1, countsEqual: counts.size === 1 };
}

function compareCatalog(catalog, { scope, companyId, releaseSha, runtime = null, expectedPopulation = null }) {
  const keys = new Set([
    ...catalog.tenants.local.keys(),
    ...catalog.tenants.legacy.keys(),
    ...catalog.tenants.transactional.keys()
  ]);
  if (scope === 'tenant') keys.add(companyId);
  if (keys.size > MAX_CATALOG_TENANTS) fail('CATALOG_LIMIT_EXCEEDED');
  let population = null;
  let populationMismatch = false;
  if (scope === 'all' && expectedPopulation) {
    if (expectedPopulation.schema !== EXPECTED_POPULATION_SCHEMA || !SHA256.test(String(expectedPopulation.sha256 || '')) ||
        !Number.isSafeInteger(expectedPopulation.tenantCount) || expectedPopulation.tenantCount < 1 ||
        expectedPopulation.tenantCount > MAX_CATALOG_TENANTS || !Array.isArray(expectedPopulation.tenantRefs) ||
        expectedPopulation.tenantRefs.length !== expectedPopulation.tenantCount ||
        expectedPopulation.tenantRefs.some(ref => !OPAQUE_TENANT_REF.test(String(ref))) ||
        new Set(expectedPopulation.tenantRefs).size !== expectedPopulation.tenantRefs.length ||
        expectedPopulation.tenantRefs.some((ref, index) => index > 0 && expectedPopulation.tenantRefs[index - 1] >= ref)) {
      fail('EXPECTED_POPULATION_INVALID');
    }
    const expectedRefs = new Set(expectedPopulation.tenantRefs);
    const observedRefs = new Set([...keys].map(opaqueTenantRef));
    const missingTenantRefs = [...expectedRefs].filter(ref => !observedRefs.has(ref)).sort();
    const unexpectedTenantRefs = [...observedRefs].filter(ref => !expectedRefs.has(ref)).sort();
    populationMismatch = Boolean(missingTenantRefs.length || unexpectedTenantRefs.length);
    population = {
      status: populationMismatch ? 'drift' : 'reconciled',
      manifestSchema: expectedPopulation.schema,
      manifestSha256: expectedPopulation.sha256,
      expectedTenantCount: expectedPopulation.tenantCount,
      observedTenantCount: observedRefs.size,
      missingTenantRefs,
      unexpectedTenantRefs
    };
  }
  const tenants = [];
  let mismatches = 0;
  for (const id of [...keys].sort()) {
    const local = catalog.tenants.local.get(id)?.state || null;
    const legacy = catalog.tenants.legacy.get(id)?.state || null;
    const transactional = catalog.tenants.transactional.get(id)?.state || null;
    const comparison = compareStateSet([local, legacy, transactional]);
    const issues = [];
    if (!legacy) issues.push('missing_legacy');
    if (!transactional) issues.push('missing_transactional');
    if (transactional?.integrity === false) issues.push('transactional_integrity');
    if (!comparison.hashesEqual) issues.push('hash_mismatch');
    if (!comparison.countsEqual) issues.push('count_mismatch');
    if (issues.length) mismatches += 1;
    tenants.push({
      tenantRef: opaqueTenantRef(id),
      status: issues.length ? 'drift' : 'reconciled',
      issues,
      local: local ? { present: true, ...local } : { present: false },
      legacy: legacy ? { present: true, ...legacy } : { present: false },
      transactional: transactional ? { present: true, ...transactional } : { present: false }
    });
  }
  let platform = null;
  let platformMismatch = false;
  if (scope !== 'tenant') {
    const local = catalog.platform.local;
    const legacy = catalog.platform.legacy;
    const transactional = catalog.platform.transactional;
    const comparison = compareStateSet([local, legacy, transactional]);
    const issues = [];
    if (!local) issues.push('missing_local');
    if (!legacy) issues.push('missing_legacy');
    if (!transactional) issues.push('missing_transactional');
    if (transactional?.integrity === false) issues.push('transactional_integrity');
    if (!comparison.hashesEqual) issues.push('hash_mismatch');
    if (!comparison.countsEqual) issues.push('count_mismatch');
    platformMismatch = Boolean(issues.length);
    platform = {
      status: platformMismatch ? 'drift' : 'reconciled',
      issues,
      local: local ? { present: true, ...local } : { present: false },
      legacy: legacy ? { present: true, ...legacy } : { present: false },
      transactional: transactional ? { present: true, ...transactional } : { present: false }
    };
  }
  const status = mismatches || platformMismatch || populationMismatch ? 'drift' : 'reconciled';
  return {
    schema: SCHEMA,
    releaseSha,
    runtime,
    status,
    writesPerformed: false,
    scope: { kind: scope, tenantRef: scope === 'tenant' ? opaqueTenantRef(companyId) : null },
    aggregate: {
      tenantCount: tenants.length,
      reconciledTenants: tenants.length - mismatches,
      mismatchedTenants: mismatches,
      runtimeLocalTenantFiles: catalog.tenants.local.size,
      legacyTenantRows: catalog.tenants.legacy.size,
      transactionalTenantRows: catalog.tenants.transactional.size,
      platformReconciled: scope === 'tenant' ? null : !platformMismatch,
      expectedPopulationReconciled: population ? !populationMismatch : null,
      excludedLegacyRows: catalog.excludedLegacyRows,
      excludedTransactionalRows: catalog.excludedTransactionalRows
    },
    tenants,
    platform,
    population
  };
}

async function settleCaptureReads(controller, factories) {
  const pending = factories.map(factory => Promise.resolve().then(factory));
  try {
    return await Promise.all(pending);
  } catch (error) {
    const originalAbortReason = controller.signal.aborted ? controller.signal.reason : null;
    if (!controller.signal.aborted) controller.abort(new ShadowReconciliationError('CAPTURE_CANCELLED'));
    await Promise.allSettled(pending);
    if (originalAbortReason instanceof ShadowReconciliationError) throw originalAbortReason;
    throw error;
  }
}

async function captureCatalog({
  request,
  dbFile,
  platformFile,
  scope,
  companyId,
  captureTimeoutMs = DEFAULTS.captureTimeoutMs,
  signal = null
}) {
  if (typeof request?.withSignal !== 'function') fail('READ_ONLY_TRANSPORT_REQUIRED');
  if (!Number.isSafeInteger(captureTimeoutMs) || captureTimeoutMs < 1) fail('CAPTURE_TIMEOUT_INVALID');
  throwIfAborted(signal);
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(
    signal.reason instanceof ShadowReconciliationError ? signal.reason : new ShadowReconciliationError('INTERRUPTED')
  );
  signal?.addEventListener?.('abort', abortFromCaller, { once: true });
  if (signal?.aborted) abortFromCaller();
  const timer = setTimeout(
    () => controller.abort(new ShadowReconciliationError('CAPTURE_TIMEOUT')),
    captureTimeoutMs
  );
  const deadlineAt = Date.now() + captureTimeoutMs;
  const enforceDeadline = () => {
    if (!controller.signal.aborted && Date.now() >= deadlineAt) {
      controller.abort(new ShadowReconciliationError('CAPTURE_TIMEOUT'));
    }
    throwIfAborted(controller.signal);
  };
  const scopedRequest = request.withSignal(controller.signal);
  try {
    enforceDeadline();
    const local = scope === 'platform' ? new Map() : listLocalTenantEntries({ dbFile, scope, companyId });
    enforceDeadline();
    if (scope === 'all') {
      const localPlatform = safeReadJson(platformFile, true);
      const [legacy, transactional, transactionalPlatform] = await settleCaptureReads(controller, [
        () => streamLegacyCatalog(scopedRequest),
        () => streamTransactionalCatalog(scopedRequest),
        () => loadPlatformRepository(scopedRequest)
      ]);
      enforceDeadline();
      return {
        tenants: { local, legacy: legacy.map, transactional: transactional.map },
        excludedLegacyRows: legacy.excluded,
        excludedTransactionalRows: transactional.excluded,
        platform: {
          local: canonicalSnapshotState(localPlatform, { kind: 'platform' }),
          legacy: legacy.platform,
          transactional: transactionalPlatform
        }
      };
    }
    let legacyRows = [];
    let transactionalRows = [];
    if (scope === 'tenant') {
      const [legacy, transactional] = await settleCaptureReads(controller, [
        () => loadLegacyRow(scopedRequest, companyId),
        () => loadTransactionalRow(scopedRequest, companyId)
      ]);
      legacyRows = legacy ? [legacy] : [];
      transactionalRows = transactional ? [transactional] : [];
    }
    const legacy = legacyTenantEntries(legacyRows, scope, companyId);
    const transactional = transactionalTenantEntries(transactionalRows, scope, companyId);
    let platform = { local: null, legacy: null, transactional: null };
    if (scope !== 'tenant') {
      const localPlatform = safeReadJson(platformFile, true);
      const [legacyPlatformRow, transactionalPlatform] = await settleCaptureReads(controller, [
        () => loadLegacyRow(scopedRequest, PLATFORM_NAMESPACE_ID),
        () => loadPlatformRepository(scopedRequest)
      ]);
      platform = {
        local: canonicalSnapshotState(localPlatform, { kind: 'platform' }),
        legacy: legacyPlatformState(legacyPlatformRow),
        transactional: transactionalPlatform
      };
    }
    enforceDeadline();
    return {
      tenants: { local, legacy: legacy.map, transactional: transactional.map },
      excludedLegacyRows: legacy.excluded,
      excludedTransactionalRows: transactional.excluded,
      platform
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', abortFromCaller);
  }
}

function validateRuntime({ scope, env = process.env, expectedServiceId = '', expectedInstanceId = '' }) {
  if (env.PDL_SUPABASE_ENABLED !== '1' || !env.SUPABASE_URL || !env.SUPABASE_SECRET_KEY) fail('CONFIG_MISSING');
  let url;
  try { url = new URL(env.SUPABASE_URL); } catch { fail('CONFIG_INVALID'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || (url.pathname && url.pathname !== '/')) fail('CONFIG_INVALID');
  if ((scope === 'all' || scope === 'tenant') && env.PDL_TRANSACTIONAL_DB !== 'shadow') fail('TENANT_MODE_NOT_SHADOW');
  if ((scope === 'all' || scope === 'platform') && env.PDL_PLATFORM_TRANSACTIONAL_DB !== 'shadow') fail('PLATFORM_MODE_NOT_SHADOW');
  const renderSignalsPresent = env.RENDER === 'true' || Boolean(env.RENDER_SERVICE_ID) || Boolean(env.RENDER_INSTANCE_ID) ||
    Boolean(env.RENDER_EXTERNAL_URL) || Boolean(env.RENDER_SERVICE_TYPE);
  if (renderSignalsPresent && env.NODE_ENV !== 'production') fail('RUNTIME_IDENTITY_MISSING');
  const production = env.NODE_ENV === 'production';
  if (production) {
    // A valid credential is not proof that the reconciler is reading the
    // intended database. Bind every production scan to the exact project ref
    // configured independently in Render before any provider request is made.
    // Only the digest below is emitted in reconciliation evidence.
    const target = /^([a-z0-9]{20})\.supabase\.co$/.exec(url.hostname.toLowerCase());
    const configuredTarget = String(env.PDL_PRODUCTION_SUPABASE_PROJECT_REF || '').trim().toLowerCase();
    if (!target || url.port || !/^[a-z0-9]{20}$/.test(configuredTarget)) fail('PRODUCTION_TARGET_INVALID');
    if (target[1] !== configuredTarget) fail('PRODUCTION_TARGET_MISMATCH');
    let externalUrl;
    try { externalUrl = new URL(env.RENDER_EXTERNAL_URL); } catch { fail('RUNTIME_IDENTITY_MISSING'); }
    if (env.RENDER !== 'true' || env.RENDER_SERVICE_TYPE !== 'web' || env.IS_PULL_REQUEST === 'true' ||
        !/^srv-[a-z0-9]{20,64}$/.test(String(env.RENDER_SERVICE_ID || '')) ||
        !/^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/.test(String(env.RENDER_INSTANCE_ID || '')) ||
        externalUrl.protocol !== 'https:' || !externalUrl.hostname.endsWith('.onrender.com') ||
        externalUrl.username || externalUrl.password || externalUrl.search || externalUrl.hash ||
        (externalUrl.pathname && externalUrl.pathname !== '/')) {
      fail('RUNTIME_IDENTITY_MISSING');
    }
    if (!expectedServiceId || !expectedInstanceId || expectedServiceId !== env.RENDER_SERVICE_ID || expectedInstanceId !== env.RENDER_INSTANCE_ID) {
      fail('RUNTIME_IDENTITY_MISMATCH');
    }
  }
  return {
    provider: production ? 'render' : 'local',
    serviceId: production ? String(env.RENDER_SERVICE_ID) : null,
    serviceType: production ? String(env.RENDER_SERVICE_TYPE) : null,
    instanceId: production ? String(env.RENDER_INSTANCE_ID) : null,
    externalHostname: production ? new URL(env.RENDER_EXTERNAL_URL).hostname.toLowerCase() : null,
    supabaseTargetSha256: crypto.createHash('sha256').update(`pdl-shadow-supabase:v1:${url.origin.toLowerCase()}`).digest('hex').slice(0, 24),
    tenantRepositoryMode: String(env.PDL_TRANSACTIONAL_DB || ''),
    platformRepositoryMode: String(env.PDL_PLATFORM_TRANSACTIONAL_DB || '')
  };
}

function releaseSha(env = process.env) {
  const value = String(env.RENDER_GIT_COMMIT || env.GIT_COMMIT_SHA || '').toLowerCase();
  if (/^[a-f0-9]{40}$/.test(value)) return value;
  if (env.NODE_ENV === 'production') fail('RELEASE_SHA_MISSING');
  return 'local';
}

function writeEvidenceExclusive(file, result) {
  if (!path.isAbsolute(file)) throw new Error('Evidence path must be absolute.');
  const sidecar = `${file}.sha256`;
  if (fs.existsSync(file) || fs.existsSync(sidecar)) throw new Error('Evidence path already exists.');
  const directory = path.dirname(file);
  if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) throw new Error('Evidence directory does not exist.');
  const bytes = Buffer.from(`${JSON.stringify(result, null, 2)}\n`);
  if (bytes.length > MAX_EVIDENCE_BYTES) fail('EVIDENCE_TOO_LARGE');
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  let createdEvidence = false;
  let createdSidecar = false;
  try {
    const handle = fs.openSync(file, 'wx', 0o600);
    createdEvidence = true;
    try { fs.writeFileSync(handle, bytes); fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
    const hashHandle = fs.openSync(sidecar, 'wx', 0o600);
    createdSidecar = true;
    try { fs.writeFileSync(hashHandle, `${digest}\n`); fs.fsyncSync(hashHandle); } finally { fs.closeSync(hashHandle); }
    const persistedBytes = fs.readFileSync(file);
    const persistedSidecar = fs.readFileSync(sidecar, 'utf8');
    const persistedDigest = crypto.createHash('sha256').update(persistedBytes).digest('hex');
    if (!persistedBytes.equals(bytes) || persistedDigest !== digest || persistedSidecar !== `${digest}\n`) {
      throw new Error('Evidence verification failed.');
    }
    if (process.platform !== 'win32') {
      const directoryHandle = fs.openSync(directory, 'r');
      try { fs.fsyncSync(directoryHandle); } finally { fs.closeSync(directoryHandle); }
    }
  } catch (error) {
    if (createdEvidence) try { fs.unlinkSync(file); } catch {}
    if (createdSidecar) try { fs.unlinkSync(sidecar); } catch {}
    throw error;
  }
  return digest;
}

module.exports = {
  SCHEMA,
  EXPECTED_POPULATION_SCHEMA,
  DEFAULTS,
  ShadowReconciliationError,
  parseArgs,
  loadExpectedPopulationManifest,
  canonicalSnapshotState,
  opaqueTenantRef,
  collectPages,
  reconcileShadow,
  listLocalTenantEntries,
  readOnlyTransport,
  listLegacyRows,
  listTransactionalRows,
  loadLegacyRow,
  loadTransactionalRow,
  legacyTenantDisposition,
  legacyTenantEntries,
  transactionalTenantEntries,
  tenantSnapshotDisposition,
  streamLegacyCatalog,
  streamTransactionalCatalog,
  captureCatalog,
  catalogSignature,
  compareCatalog,
  validateRuntime,
  releaseSha,
  writeEvidenceExclusive
};
