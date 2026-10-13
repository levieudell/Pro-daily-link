'use strict';
(function (root, factory) {
  const value = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = value;
  else root.OriginalOperationRecovery = value;
})(typeof window === 'undefined' ? globalThis : window, function () {
  // These entries select an original GET. They cannot authorize a request or prove
  // its outcome. Each operation has its own key, so one tab cannot overwrite
  // another tab's original handle when appending an unrelated operation.
  const PREFIX = 'pdl-original-operation-v1:', FAMILY = 'pdl-original-operation-', LIMIT = 32, BYTES = 32768;
  const PLATFORM_ID = '5a7f362f-e399-56e3-9458-e34b794a389d';
  const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
  const company = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
  const id = value => Number.isSafeInteger(value) && value > 0;
  const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  const closed = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
  const copy = value => JSON.parse(JSON.stringify(value));
  const fail = () => { throw Object.assign(Error('Original operation storage needs review. No replacement will be submitted.'), { code: 'PDL_ORIGINAL_OPERATION_STORAGE' }); };
  const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
  function group(row) { return row.purpose.startsWith('platform-') ? 'manual' : 'report'; }
  function valid(row) {
    if (!closed(row, ['version', 'operationId', 'purpose', 'route', 'target', 'identityDigest', 'intentDigest', 'createdAt']) || row.version !== 1 || !uuid(row.operationId) || !hex(row.identityDigest) || !hex(row.intentDigest) || !iso(row.createdAt) || !closed(row.target, ['companyId', 'projectId', 'resourceId']) || !company(row.target.companyId)) return false;
    const target = row.target;
    if (row.purpose === 'platform-staff-create') return row.route === '/api/platform/users' && target.companyId === PLATFORM_ID && target.projectId === null && target.resourceId === null;
    if (row.purpose === 'platform-owner-reset') return row.route === '/api/platform/companies/' + target.companyId + '/owner-reset' && target.companyId !== PLATFORM_ID && target.projectId === null && target.resourceId === null;
    if (row.purpose === 'report-create') return row.route === '/api/reports' && id(target.projectId) && target.resourceId === null;
    if (row.purpose === 'report-edit') return id(target.projectId) && id(target.resourceId) && row.route === '/api/reports/' + target.resourceId;
    return false;
  }
  function create(storage, options = {}) {
    const target = () => typeof storage === 'function' ? storage() : storage;
    const cryptoObject = options.crypto || globalThis.crypto;
    const observed = new Map();
    async function digest(value) {
      if (!cryptoObject?.subtle || typeof value !== 'string') fail();
      const bytes = new TextEncoder().encode(value), result = await cryptoObject.subtle.digest('SHA-256', bytes);
      return Array.from(new Uint8Array(result), value => value.toString(16).padStart(2, '0')).join('');
    }
    async function identityDigest(value) {
      if (!closed(value, ['companyId', 'actorId', 'role', 'sessionBinding']) || !company(value.companyId) || !id(value.actorId) || !['platform_owner', 'owner', 'admin', 'project_manager', 'foreman', 'field'].includes(value.role) || !hex(value.sessionBinding)) fail();
      if ((value.role === 'platform_owner') !== (value.companyId === PLATFORM_ID)) fail();
      return digest(JSON.stringify([value.companyId, value.actorId, value.role, value.sessionBinding]));
    }
    function entries(selectedGroup) {
      if (selectedGroup !== undefined && !['manual', 'report'].includes(selectedGroup)) fail();
      try {
        const store = target(), keys = [], rows = []; let bytes = 0;
        if (!store || !Number.isSafeInteger(store.length) || store.length < 0) fail();
        for (let index = 0; index < store.length; index++) {
          const key = store.key(index);
          if (typeof key !== 'string') fail();
          if (key.startsWith(FAMILY)) keys.push(key);
        }
        if (keys.length > LIMIT || new Set(keys).size !== keys.length) fail();
        for (const key of keys) {
          if (!key.startsWith(PREFIX) || !uuid(key.slice(PREFIX.length))) fail();
          const raw = store.getItem(key);
          if (typeof raw !== 'string' || raw.length > BYTES) fail();
          bytes += new TextEncoder().encode(raw).byteLength;
          if (bytes > BYTES) fail();
          const row = JSON.parse(raw);
          if (!valid(row) || key !== PREFIX + row.operationId || JSON.stringify(row) !== raw) fail();
          rows.push(row);
        }
        if (new Set([...observed.keys(), ...rows.map(row => row.operationId)]).size > LIMIT) fail();
        for (const row of rows) {
          const prior = observed.get(row.operationId);
          if (prior && JSON.stringify(prior) !== JSON.stringify(row)) fail();
          observed.set(row.operationId, copy(row));
        }
        // Erasure in a live page never authorizes a replacement. Keep the
        // original opaque reference for a read-only, server-authorized GET.
        return copy([...observed.values()].filter(row => !selectedGroup || group(row) === selectedGroup));
      } catch { fail(); }
    }
    function assertOriginal(row, options = {}) {
      if (!valid(row)) fail();
      const stored = entries().find(value => value.operationId === row.operationId);
      if (!stored || JSON.stringify(stored) !== JSON.stringify(row)) fail();
      try { if (options.readOnly !== true && target().getItem(PREFIX + row.operationId) !== JSON.stringify(row)) fail(); } catch { fail(); }
      return copy(stored);
    }
    function remember(row) {
      if (!valid(row)) fail();
      const rows = entries(), existing = rows.find(value => value.operationId === row.operationId);
      if (existing) return assertOriginal(row);
      if (rows.length >= LIMIT) fail();
      const raw = JSON.stringify(row), size = rows.reduce((sum, value) => sum + new TextEncoder().encode(JSON.stringify(value)).byteLength, 0) + new TextEncoder().encode(raw).byteLength;
      if (size > BYTES) fail();
      try { const store = target(); store.setItem(PREFIX + row.operationId, raw); if (store.getItem(PREFIX + row.operationId) !== raw) fail(); } catch { fail(); }
      return assertOriginal(row);
    }
    // Call only after an explicit review and a fresh authorized original-result
    // GET. There is intentionally no expiry pruning, clear-all, or 404 cleanup.
    function reviewed(row) {
      assertOriginal(row, { readOnly: true });
      try { const store = target(); store.removeItem(PREFIX + row.operationId); if (store.getItem(PREFIX + row.operationId) !== null) fail(); } catch { fail(); }
      observed.delete(row.operationId);
    }
    return { entries, remember, assertOriginal, reviewed, identityDigest, intentDigest: digest };
  }
  return { create, valid, group, PREFIX, LIMIT, BYTES, PLATFORM_ID };
});
