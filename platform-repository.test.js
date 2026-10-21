'use strict';

const assert = require('node:assert/strict');
const {
  PlatformRepository,
  PlatformRevisionConflictError,
  PLATFORM_NAMESPACE_ID,
  splitPlatformSnapshot,
  assemblePlatformSnapshot,
  canonicalHash,
  parseConflict
} = require('./database/platform-repository');

const first = {
  users: [{ id: 'owner', email: 'owner@example.com' }],
  demoRequests: [{ id: 'lead-1', company: 'Northstar Concrete' }],
  notes: [],
  weeklyDigest: { lastSentAt: null },
  featureFlags: { growth: true }
};

const split = splitPlatformSnapshot(first);
assert.deepEqual(Object.keys(split.scalarData).sort(), ['featureFlags', 'notes', 'weeklyDigest']);
assert.equal(split.records.length, 2);
assert.deepEqual(assemblePlatformSnapshot(split.scalarData, split.records), first);
assert.equal(canonicalHash({ b: 2, a: 1 }), canonicalHash({ a: 1, b: 2 }));
assert.notEqual(canonicalHash({ a: [1, 2] }), canonicalHash({ a: [2, 1] }));

function response(payload) {
  return { json: async () => structuredClone(payload) };
}

function mockTransport() {
  let state = null;
  const calls = [];
  return {
    calls,
    request: async (url, options) => {
      calls.push({ url, options: structuredClone(options) });
      const input = JSON.parse(options.body);
      if (url.endsWith('/load_platform_repository')) {
        if (!state) return response(null);
        return response({
          namespaceId: input.p_namespace_id,
          revision: state.revision,
          scalarData: state.scalarData,
          contentHash: state.contentHash,
          records: state.records,
          updatedAt: '2026-10-20T12:00:00.000Z',
          updatedBy: state.changedBy
        });
      }
      if (!url.endsWith('/replace_platform_repository')) throw new Error(`Unexpected URL: ${url}`);
      const actual = state?.revision ?? 0;
      if (input.p_expected_revision !== actual) {
        const error = new Error(`Supabase request failed (409): PDL_PLATFORM_REVISION_CONFLICT expected=${input.p_expected_revision} actual=${actual}`);
        error.code = 'PT409';
        error.statusCode = 409;
        throw error;
      }
      state = {
        revision: actual + 1,
        scalarData: input.p_scalar_data,
        records: input.p_records.map(row => ({
          collection: row.collection,
          recordKey: row.record_key,
          position: row.position,
          data: row.data
        })),
        contentHash: input.p_content_hash,
        changedBy: input.p_changed_by
      };
      return response({
        revision: state.revision,
        recordCount: state.records.length,
        contentHash: state.contentHash,
        updatedAt: '2026-10-20T12:00:00.000Z'
      });
    }
  };
}

(async () => {
  const transport = mockTransport();
  const repository = new PlatformRepository({ request: transport.request });
  assert.equal(await repository.load(), null);
  await assert.rejects(() => repository.save(first), /expectedRevision must be/);

  const saved = await repository.save(first, { expectedRevision: 0, changedBy: 'owner-1' });
  assert.equal(saved.revision, 1);
  assert.equal(saved.namespaceId, PLATFORM_NAMESPACE_ID);
  assert.equal(saved.contentHash, canonicalHash(first));

  const loaded = await repository.load();
  assert.deepEqual(loaded.snapshot, first);
  assert.equal(loaded.revision, 1);
  assert.equal(loaded.updatedBy, 'owner-1');
  assert.deepEqual(await repository.verify(first, 1), {
    ok: true,
    revision: 1,
    expectedHash: canonicalHash(first),
    actualHash: canonicalHash(first),
    revisionMatches: true
  });

  const second = { ...first, notes: [{ id: 'note-1', body: 'Call customer' }] };
  const stale = { ...first, notes: [{ id: 'note-2', body: 'Stale update' }] };
  const outcomes = await Promise.allSettled([
    repository.save(second, { expectedRevision: 1, changedBy: 'owner-1' }),
    repository.save(stale, { expectedRevision: 1, changedBy: 'owner-2' })
  ]);
  assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
  const rejection = outcomes.find(result => result.status === 'rejected').reason;
  assert.ok(rejection instanceof PlatformRevisionConflictError);
  assert.equal(rejection.expected, 1);
  assert.equal(rejection.actual, 2);
  assert.deepEqual((await repository.load()).snapshot, second);
  assert.equal(transport.calls.filter(call => call.url.endsWith('/replace_platform_repository')).length, 3,
    'a terminal PT409 conflict must make exactly one outbound save attempt');

  const legacyConflict = Object.assign(new Error('PDL_PLATFORM_REVISION_CONFLICT expected=4 actual=5'), { code: '40001' });
  assert.ok(parseConflict(legacyConflict, 4) instanceof PlatformRevisionConflictError,
    'legacy 40001 responses remain recognizable during a rolling deployment');

  const unrelatedConflict = Object.assign(new Error('A different application conflict'), { code: 'PT409', statusCode: 409 });
  assert.equal(parseConflict(unrelatedConflict, 4), unrelatedConflict,
    'an unrelated PT409 must not be mislabeled as a platform revision conflict');

  assert.ok(transport.calls.every(call => call.url.includes('/rest/v1/rpc/')));
  assert.ok(transport.calls.filter(call => call.url.endsWith('/replace_platform_repository')).every(call => {
    const body = JSON.parse(call.options.body);
    return Number.isSafeInteger(body.p_expected_revision) && /^[a-f0-9]{64}$/.test(body.p_content_hash);
  }));

  console.log('Platform transactional repository tests passed.');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
