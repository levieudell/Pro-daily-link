'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const {
  parseArgs,
  canonicalSnapshotState,
  opaqueTenantRef,
  collectPages,
  reconcileShadow
} = require('./shadow-reconciliation');
const { canonicalHash } = require('./transactional-repository');
const { PLATFORM_NAMESPACE_ID } = require('./platform-repository');

const TENANT_ID = '7176abe8-07e4-4336-a372-1163d2f21ff9';
const OTHER_TENANT_ID = '11111111-1111-4111-8111-111111111111';
const FIXED_NOW = '2026-10-20T18:00:00.000Z';

function snapshot({
  companyId = TENANT_ID,
  revision = 14,
  marker = 'same',
  reportCount = 2
} = {}) {
  return {
    company: {
      id: companyId,
      name: 'Sensitive Contractor Name',
      persistence: { revision, updatedAt: '2026-10-20T17:59:00.000Z' }
    },
    users: [{
      id: 1,
      name: 'Private Owner',
      email: 'private-owner@example.test',
      status: 'Active',
      passwordHash: 'must-never-appear'
    }],
    reports: Array.from({ length: reportCount }, (_, index) => ({
      id: index + 1,
      notes: `confidential-note-${marker}-${index + 1}`
    })),
    sessions: [{ tokenHash: 'secret-session-token-hash', expiresAt: '2030-01-01T00:00:00.000Z' }],
    settings: { marker }
  };
}

function transactional(value, repositoryRevision = 8) {
  return {
    snapshot: structuredClone(value),
    revision: repositoryRevision,
    contentHash: canonicalHash(value),
    databaseCompanyId: TENANT_ID
  };
}

function captureSequence(captures, calls = { count: 0 }) {
  return Object.assign(async () => {
    const index = Math.min(calls.count, captures.length - 1);
    calls.count += 1;
    return structuredClone(captures[index]);
  }, { calls });
}

function run(capture, overrides = {}) {
  return reconcileShadow({
    scope: { kind: 'tenant', companyId: TENANT_ID },
    capture,
    requiredSources: ['legacy', 'transactional'],
    stableSamples: 3,
    maxSamples: 8,
    intervalMs: 0,
    requestTimeoutMs: 1000,
    sleep: async () => {},
    now: () => FIXED_NOW,
    ...overrides
  });
}

function status(result) {
  return String(result?.status || '').toLowerCase();
}

function observedSamples(result) {
  return Number(result?.observedSamples ?? result?.samplesObserved ?? result?.stability?.observedSamples ?? 0);
}

function assertSanitized(value) {
  const encoded = JSON.stringify(value);
  for (const secret of [
    'Sensitive Contractor Name',
    'Private Owner',
    'private-owner@example.test',
    'must-never-appear',
    'secret-session-token-hash',
    'confidential-note'
  ]) assert.doesNotMatch(encoded, new RegExp(secret, 'i'), `reconciliation output leaked ${secret}`);
}

(async () => {
  // CLI selection is explicit. There is deliberately no implicit tenant,
  // email/name lookup, or combination of broad and narrow scopes.
  const evidence = path.resolve('shadow-reconciliation-evidence.json');
  const populationManifest = path.resolve('shadow-expected-population.json');
  const populationSha = 'a'.repeat(64);
  const tenantArgs = parseArgs([
    '--company-id', TENANT_ID,
    '--evidence', evidence,
    '--max-samples', '9',
    '--stable-samples', '3',
    '--interval-ms', '250',
    '--request-timeout-ms', '3000',
    '--capture-timeout-ms', '90000'
  ]);
  assert.equal(tenantArgs.companyId, TENANT_ID);
  assert.equal(tenantArgs.scope, 'tenant');
  assert.equal(tenantArgs.evidence, evidence);
  assert.equal(tenantArgs.maxSamples, 9);
  assert.equal(tenantArgs.stableSamples, 3);
  assert.equal(tenantArgs.intervalMs, 250);
  assert.equal(tenantArgs.requestTimeoutMs, 3000);
  assert.equal(tenantArgs.captureTimeoutMs, 90000);
  assert.equal(parseArgs(['--all']).scope, 'all');
  assert.equal(parseArgs(['--platform-only']).scope, 'platform');
  const boundArgs = parseArgs(['--all', '--expected-service-id', 'srv-dal9vt5bedkc73bpru30', '--expected-instance-id', 'abc12']);
  assert.equal(boundArgs.expectedServiceId, 'srv-dal9vt5bedkc73bpru30');
  assert.equal(boundArgs.expectedInstanceId, 'abc12');
  const populationArgs = parseArgs([
    '--all',
    '--expected-population-manifest', populationManifest,
    '--expected-population-sha256', populationSha
  ]);
  assert.equal(populationArgs.expectedPopulationManifest, populationManifest);
  assert.equal(populationArgs.expectedPopulationSha256, populationSha);
  assert.throws(() => parseArgs([]), /exactly one|scope|required/i);
  assert.throws(() => parseArgs(['--all', '--platform-only']), /exactly one|choose/i);
  assert.throws(() => parseArgs(['--all', '--company-id', TENANT_ID]), /exactly one|choose/i);
  assert.throws(() => parseArgs(['--company-id', 'not-a-uuid']), /uuid|company/i);
  assert.throws(() => parseArgs(['--company-id', PLATFORM_NAMESPACE_ID]), /platform-only|reserved/i);
  assert.throws(() => parseArgs(['--company-id', TENANT_ID, '--wat']), /unknown|argument/i);
  assert.throws(() => parseArgs(['--all', '--stable-samples', '1']), /stable|sample/i);
  assert.throws(() => parseArgs(['--all', '--max-samples', '2', '--stable-samples', '3']), /max|stable|sample/i);
  assert.throws(() => parseArgs(['--all', '--interval-ms', '-1']), /interval/i);
  assert.throws(() => parseArgs(['--all', '--request-timeout-ms', '0']), /timeout/i);
  assert.throws(() => parseArgs(['--all', '--capture-timeout-ms', '999']), /timeout/i);
  assert.throws(() => parseArgs(['--all', '--expected-population-manifest', populationManifest]), /provided together/i);
  assert.throws(() => parseArgs(['--platform-only', '--expected-population-manifest', populationManifest, '--expected-population-sha256', populationSha]), /only with --all/i);

  // Fingerprints are deterministic over object-key order, preserve array
  // order, contain useful count evidence, and never expose snapshot values.
  const base = snapshot();
  const reordered = {
    settings: { marker: 'same' },
    sessions: structuredClone(base.sessions),
    reports: base.reports.map(row => ({ notes: row.notes, id: row.id })),
    users: base.users.map(row => ({ status: row.status, passwordHash: row.passwordHash, email: row.email, name: row.name, id: row.id })),
    company: {
      persistence: { updatedAt: base.company.persistence.updatedAt, revision: 14 },
      name: base.company.name,
      id: TENANT_ID
    }
  };
  const baseState = canonicalSnapshotState(base);
  const reorderedState = canonicalSnapshotState(reordered);
  const stateHash = value => value.canonicalSha256 || value.hash || value.contentHash;
  assert.match(stateHash(baseState), /^[a-f0-9]{64}$/);
  assert.equal(stateHash(baseState), stateHash(reorderedState));
  assert.notEqual(
    stateHash(baseState),
    stateHash(canonicalSnapshotState({ ...base, reports: [...base.reports].reverse() })),
    'array order is part of the snapshot contract'
  );
  assert.ok(Number(baseState.records ?? baseState.recordCount) >= 4);
  assertSanitized(baseState);

  const tenantRef = opaqueTenantRef(TENANT_ID);
  assert.equal(tenantRef, opaqueTenantRef(TENANT_ID));
  assert.notEqual(tenantRef, opaqueTenantRef(OTHER_TENANT_ID));
  assert.doesNotMatch(tenantRef, new RegExp(TENANT_ID, 'i'));

  // Stable exact three-way equality is the only success state.
  const exactCalls = { count: 0 };
  const exact = await run(captureSequence([{
    local: base,
    legacy: base,
    transactional: transactional(base)
  }], exactCalls));
  assert.equal(status(exact), 'reconciled');
  assert.equal(exact.writesPerformed, false);
  assert.equal(exact.stable, true);
  assert.ok(observedSamples(exact) >= 3);
  assert.ok(exactCalls.count >= 3);
  assertSanitized(exact);

  // Each possible lagging/divergent source independently blocks cutover.
  const newer = snapshot({ revision: 15, marker: 'newer' });
  for (const [label, capture] of [
    ['local', { local: newer, legacy: base, transactional: transactional(base) }],
    ['legacy', { local: base, legacy: newer, transactional: transactional(base) }],
    ['transactional', { local: base, legacy: base, transactional: transactional(newer, 9) }]
  ]) {
    const result = await run(captureSequence([capture]));
    assert.equal(status(result), 'drift', `${label} drift must block cutover`);
    assert.equal(result.writesPerformed, false);
    assert.equal(result.stable, true);
    assertSanitized(result);
  }

  // A tenant legitimately absent from this runtime's local disk can still be
  // reconciled from the two required remote stores. Missing either required
  // remote is a hard failure rather than an empty-equals-empty success.
  const remoteOnly = await run(captureSequence([{
    local: null,
    legacy: base,
    transactional: transactional(base)
  }]));
  assert.equal(status(remoteOnly), 'reconciled');
  assert.equal(remoteOnly.writesPerformed, false);

  for (const missing of ['legacy', 'transactional']) {
    const sources = { local: base, legacy: base, transactional: transactional(base) };
    sources[missing] = null;
    const result = await run(captureSequence([sources]));
    assert.equal(status(result), 'missing_source', `missing ${missing} must block cutover`);
    assert.equal(result.writesPerformed, false);
    assertSanitized(result);
  }

  // In-flight shadow writes may temporarily expose three different versions.
  // The gate waits for a quiet sequence and succeeds only after convergence.
  const middle = snapshot({ revision: 15, marker: 'middle' });
  const converged = snapshot({ revision: 16, marker: 'converged' });
  const convergenceCalls = { count: 0 };
  const convergence = await run(captureSequence([
    { local: middle, legacy: base, transactional: transactional(base, 8) },
    { local: converged, legacy: middle, transactional: transactional(middle, 9) },
    { local: converged, legacy: converged, transactional: transactional(converged, 10) },
    { local: converged, legacy: converged, transactional: transactional(converged, 10) },
    { local: converged, legacy: converged, transactional: transactional(converged, 10) }
  ], convergenceCalls));
  assert.equal(status(convergence), 'reconciled');
  assert.equal(convergence.stable, true);
  assert.ok(convergenceCalls.count >= 5, 'stability resets when any source advances');

  // Matching but continuously changing snapshots are not stable evidence.
  let movingRevision = 20;
  const movingCalls = { count: 0 };
  const moving = await run(Object.assign(async () => {
    movingCalls.count += 1;
    const value = snapshot({ revision: movingRevision, marker: `moving-${movingRevision}` });
    movingRevision += 1;
    return { local: value, legacy: value, transactional: transactional(value, movingRevision) };
  }, { calls: movingCalls }), { maxSamples: 5 });
  assert.equal(status(moving), 'inconclusive');
  assert.equal(moving.stable, false);
  assert.equal(moving.writesPerformed, false);
  assert.equal(movingCalls.count, 5);
  assertSanitized(moving);

  // An operator interrupt cancels the stability wait immediately and is not
  // downgraded to a provider failure or an inconclusive result.
  const abortController = new AbortController();
  let interruptCaptures = 0;
  const interruptedRun = reconcileShadow({
    scope: { kind: 'tenant', companyId: TENANT_ID },
    capture: async () => {
      interruptCaptures += 1;
      return { local: base, legacy: base, transactional: transactional(base) };
    },
    stableSamples: 3,
    maxSamples: 8,
    intervalMs: 60_000,
    signal: abortController.signal,
    now: () => FIXED_NOW
  });
  await new Promise(resolve => setImmediate(resolve));
  abortController.abort();
  await assert.rejects(interruptedRun, error => error?.code === 'INTERRUPTED');
  assert.equal(interruptCaptures, 1);

  // Pagination must not truncate at the common PostgREST 1,000-row boundary.
  const rows = Array.from({ length: 1005 }, (_, index) => ({ id: `tenant-${String(index + 1).padStart(4, '0')}` }));
  const pageCalls = [];
  const paged = await collectPages(async ({ cursor, limit }) => {
    const start = cursor == null ? 0 : Number(cursor);
    pageCalls.push({ cursor, limit });
    const pageRows = rows.slice(start, start + limit);
    const nextCursor = start + pageRows.length < rows.length ? String(start + pageRows.length) : null;
    return { rows: pageRows, nextCursor };
  }, { pageSize: 250, maxPages: 10, rowKey: row => row.id });
  assert.equal(paged.length, 1005);
  assert.deepEqual(paged[0], rows[0]);
  assert.deepEqual(paged.at(-1), rows.at(-1));
  assert.equal(pageCalls.length, 5);
  assert.ok(pageCalls.every(call => call.limit === 250));
  let repeatedCursorPage = 0;
  await assert.rejects(
    () => collectPages(async () => ({ rows: [{ id: `row-${++repeatedCursorPage}` }], nextCursor: 'repeat' }), {
      pageSize: 1,
      maxPages: 3,
      rowKey: row => row.id
    }),
    /cursor|repeat|pagination/i
  );

  // The injected boundary is intentionally read-only: reconciliation gets a
  // capture function, not a repository with mutation methods. This also
  // verifies that repeated observation never calls a tempting write helper.
  const operations = [];
  const transport = {
    async readLocal() { operations.push('read:local'); return structuredClone(base); },
    async readLegacy() { operations.push('read:legacy'); return structuredClone(base); },
    async readTransactional() { operations.push('read:transactional'); return transactional(base); },
    async saveLegacy() { operations.push('write:legacy'); throw new Error('write attempted'); },
    async saveTransactional() { operations.push('write:transactional'); throw new Error('write attempted'); },
    async remove() { operations.push('write:remove'); throw new Error('write attempted'); }
  };
  const readOnly = await run(async () => ({
    local: await transport.readLocal(),
    legacy: await transport.readLegacy(),
    transactional: await transport.readTransactional()
  }));
  assert.equal(status(readOnly), 'reconciled');
  assert.ok(operations.length >= 9);
  assert.ok(operations.every(operation => operation.startsWith('read:')), `mutation attempted: ${operations.join(', ')}`);

  // Provider errors can contain customer data. They remain bounded and must
  // not be reflected into logs/evidence returned by the reconciler.
  const providerFailure = await run(async () => {
    throw new Error('provider failed for private-owner@example.test using secret-session-token-hash');
  }, { maxSamples: 3 });
  assert.equal(status(providerFailure), 'inconclusive');
  assert.equal(providerFailure.writesPerformed, false);
  assertSanitized(providerFailure);

  console.log('Shadow reconciliation safety, stability, pagination, privacy, and read-only tests passed.');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
