'use strict';

const assert = require('node:assert/strict');
const { canonicalHash, PlatformRevisionConflictError, PLATFORM_NAMESPACE_ID } = require('./database/platform-repository');
const { PlatformStateStore } = require('./database/platform-state-store');

function repository(initial = null) {
  let state = initial ? { snapshot: structuredClone(initial), revision: 1, contentHash: canonicalHash(initial), namespaceId: PLATFORM_NAMESPACE_ID } : null;
  return {
    load: async () => state ? structuredClone(state) : null,
    save: async (snapshot, { expectedRevision }) => {
      const actual = state?.revision ?? 0;
      if (expectedRevision !== actual) throw new PlatformRevisionConflictError(expectedRevision, actual);
      state = { snapshot: structuredClone(snapshot), revision: actual + 1, contentHash: canonicalHash(snapshot), namespaceId: PLATFORM_NAMESPACE_ID };
      return structuredClone(state);
    },
    externalWrite(snapshot) {
      const actual = state?.revision ?? 0;
      state = { snapshot: structuredClone(snapshot), revision: actual + 1, contentHash: canonicalHash(snapshot), namespaceId: PLATFORM_NAMESPACE_ID };
    },
    state: () => structuredClone(state)
  };
}

(async () => {
  const repo = repository();
  const store = new PlatformStateStore(repo);
  await store.initialize({ notes: [], counters: { demos: 0 } });
  assert.equal(store.readState().revision, 1);

  await Promise.all([
    store.update(draft => { draft.notes.push({ id: 'a' }); }, { changedBy: 'owner-a' }),
    store.update(draft => { draft.notes.push({ id: 'b' }); }, { changedBy: 'owner-b' })
  ]);
  assert.deepEqual(store.read().notes.map(row => row.id), ['a', 'b']);
  assert.equal(store.readState().revision, 3);

  const userCopy = store.read();
  userCopy.notes.push({ id: 'not-committed' });
  assert.equal(store.read().notes.length, 2, 'read must not expose the mutable cache');

  repo.externalWrite({ notes: [{ id: 'external' }], counters: { demos: 9 } });
  await assert.rejects(
    () => store.update(draft => { draft.counters.demos += 1; }),
    error => error instanceof PlatformRevisionConflictError && error.actual === 4
  );
  assert.deepEqual(store.read().notes, [{ id: 'external' }], 'a conflict must refresh instead of replaying a stale mutation');
  assert.equal(store.readState().revision, 4);

  console.log('Platform state store serialization and conflict tests passed.');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
