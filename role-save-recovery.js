'use strict';
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.RoleSaveRecovery = factory().create(() => root.sessionStorage);
})(typeof window === 'undefined' ? globalThis : window, function () {
  // Technical retry identity only: never persist policies, people, reason, proof,
  // session tokens, confirmation state or arbitrary endpoints. Storage is not authority.
  const KEY = 'pdl-role-save-recovery-v1', LIMIT = 16, BYTES = 32768;
  const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
  const hex = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
  const closed = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
  const fail = () => { throw Error('This tab cannot read or preserve the original save identity. Review current permissions and activity before retrying.'); };
  function validIdentity(value) {
    if (typeof value !== 'string' || value.length > 1024) return false;
    try { const row = JSON.parse(value); return Array.isArray(row) && row.length === 4 && typeof row[0] === 'string' && row[0].length > 0 && row[0].length <= 100 && Number.isSafeInteger(row[1]) && row[1] > 0 && row[2] === 'owner' && hex(row[3]) && JSON.stringify(row) === value; } catch { return false; }
  }
  function valid(row) {
    return closed(row, ['identity', 'route', 'previewId', 'version', 'requestId', 'state']) && validIdentity(row.identity) && ['roles', 'role-profiles'].includes(row.route) && uuid(row.previewId) && hex(row.version) && uuid(row.requestId) && ['pending', 'unresolved', 'retired-unknown'].includes(row.state);
  }
  function create(storage) {
    const target = () => typeof storage === 'function' ? storage() : storage;
    function read() {
      try {
        const raw = target().getItem(KEY); if (raw === null) return [];
        if (typeof raw !== 'string' || raw.length > BYTES) fail();
        const rows = JSON.parse(raw);
        if (!Array.isArray(rows) || rows.length > LIMIT || !rows.every(valid) || new Set(rows.filter(row=>row.state!=='retired-unknown').map(row => JSON.stringify([row.identity, row.route]))).size !== rows.filter(row=>row.state!=='retired-unknown').length || new Set(rows.map(row => row.requestId)).size !== rows.length) fail();
        return rows;
      } catch { fail(); }
    }
    function write(rows) {
      try { const raw = JSON.stringify(rows); if (raw.length > BYTES) fail(); target().setItem(KEY, raw); if (target().getItem(KEY) !== raw) fail(); } catch { fail(); }
    }
    function get(route, identity) {
      const row = read().find(row => row.route === route && row.identity === identity && row.state!=='retired-unknown');
      return row ? { identity, kind: 'confirm', path: '/api/company/role-policy/confirm', hadUncertain: true, unresolved: row.state === 'unresolved', body: { previewId: row.previewId, version: row.version, requestId: row.requestId, confirmed: true } } : null;
    }
    function remember(route, record) {
      const row = { identity: record.identity, route, previewId: record.body.previewId, version: record.body.version, requestId: record.body.requestId, state: 'pending' };
      if (!valid(row) || !closed(record.body, ['previewId', 'version', 'requestId', 'confirmed']) || record.body.confirmed !== true || record.kind !== 'confirm') fail();
      const rows = read(), existing = rows.find(value => value.route === route && value.identity === row.identity && value.state!=='retired-unknown');
      if (existing) { if (JSON.stringify(existing) !== JSON.stringify(row)) fail(); return; }
      if (rows.length >= LIMIT || rows.some(value => value.requestId === row.requestId)) fail();
      write([...rows, row]);
    }
    function unresolved(route, record) {
      const rows = read(), row = rows.find(value => value.route === route && value.identity === record.identity && value.requestId === record.body.requestId);
      if (!row) fail(); row.state = 'unresolved'; write(rows);
    }
    function forget(route, record) {
      const rows = read(); write(rows.filter(value => !(value.route === route && value.identity === record.identity && value.requestId === record.body.requestId)));
    }
    function retire(row) { const rows=read(),stored=rows.find(value=>value.route===row.route&&value.identity===row.identity&&value.requestId===row.requestId);if(!stored||stored.state==='retired-unknown')fail();stored.state='retired-unknown';write(rows); }
    return { get, remember, unresolved, forget, entries:()=>structuredClone(read()), retire };
  }
  return { create, KEY, LIMIT };
});
