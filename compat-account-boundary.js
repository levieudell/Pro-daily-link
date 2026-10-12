'use strict';
// Source-only cohort fence shared by ordinary server, adapters and known scripts.
// A request/header cannot configure this boundary. Production cannot activate it.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const fail = () => Object.assign(Error('Selected account authority requires its current service.'), { statusCode: 503, code: 'PDL_COMPAT_LEGACY_FENCED' });
function boundary() {
  const file = process.env.PDL_COMPAT_GLOBAL_FENCE_FILE;
  if (file === undefined || file === '') return null;
  if (process.env.NODE_ENV !== 'test' || process.env.PDL_COMPAT_ACCOUNT_SYNTHETIC !== '1' || process.env.PDL_REQUIRE_AUTH !== '1') throw fail();
  const resolved = path.resolve(file), temp = path.resolve(os.tmpdir());
  if (!resolved.startsWith(temp + path.sep) || !path.basename(path.dirname(resolved)).startsWith('pdl-compat-lifecycle-')) throw fail();
  let value; try { value = JSON.parse(fs.readFileSync(resolved, 'utf8')); } catch { throw fail(); }
  if (!value || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'companyId,globalOrigin,origin,version' || value.version !== 1 || typeof value.companyId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value.companyId)) throw fail();
  for (const name of ['origin', 'globalOrigin']) { let url; try { url = new URL(value[name]); } catch { throw fail(); } if (url.origin !== value[name] || url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw fail(); }
  return value;
}
function fenced(id) { const value = boundary(); return Boolean(value && String(id).toLowerCase() === value.companyId); }
function assertLegacy(id) { if (fenced(id)) throw fail(); }
function assertLegacySnapshot(snapshot) { assertLegacy(snapshot?.company?.id); return snapshot; }
function legacySnapshot(snapshot) { return snapshot && !fenced(snapshot.company?.id); }
function adapterRequest(relativePath, options) {
  if (!boundary()) return;
  const url = new URL(relativePath, 'http://synthetic.invalid'), method = String(options.method || 'GET').toUpperCase();
  const table = /\/rest\/v1\/(companies|tenant_records|tenant_revisions)$/.exec(url.pathname);
  if (table) {
    const key = table[1] === 'companies' ? 'id' : 'company_id', where = url.searchParams.get(key);
    if (table[1] !== 'companies' && !where) throw fail();
    if (where) { if (!/^eq\.[0-9a-f-]{36}$/i.test(where)) throw fail(); assertLegacy(where.slice(3)); }
    if (!['GET', 'HEAD'].includes(method)) {
      if (method === 'POST') {
        let rows; try { rows = JSON.parse(options.body); } catch { throw fail(); }
        if (!Array.isArray(rows) || !rows.length) throw fail();
        for (const row of rows) { if (!row || typeof row[key] !== 'string') throw fail(); assertLegacy(row[key]); if (row.data) assertLegacySnapshot(row.data); }
      } else { if (!where) throw fail(); if (method === 'PATCH') { let row; try { row = JSON.parse(options.body); } catch { throw fail(); } if (row?.data) assertLegacySnapshot(row.data); if (row?.company_id) assertLegacy(row.company_id); if (row?.id) assertLegacy(row.id); } }
    }
  }
  if (url.pathname === '/rest/v1/rpc/replace_tenant_records') {
    let value; try { value = JSON.parse(options.body); } catch { throw fail(); }
    if (!value || typeof value.p_company_id !== 'string') throw fail(); assertLegacy(value.p_company_id);
  }
}
async function adapterResponse(relativePath, response, options = {}) {
  if (!boundary()) return response;
  if (!['GET', 'HEAD'].includes(String(options.method || 'GET').toUpperCase())) return response;
  const url = new URL(relativePath, 'http://synthetic.invalid');
  if (url.pathname !== '/rest/v1/companies') return response;
  const rows = await response.json(); if (!Array.isArray(rows)) throw fail();
  const safe = rows.filter(row => { const id = row?.id || row?.data?.company?.id; if (!id) throw fail(); return !fenced(id) && (!row.data || legacySnapshot(row.data)); });
  return new Response(JSON.stringify(safe), { status: response.status, headers: response.headers });
}
async function discoverEmail(email) {
  const value = boundary(); if (!value) return null;
  const response = await fetch(new URL('/api/auth/company', value.origin), { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-PDL-Company': value.companyId }, body: JSON.stringify({ email }), signal: AbortSignal.timeout(3000) });
  if (!response.ok) throw fail(); const data = await response.json();
  if (!data || Object.keys(data).join(',') !== 'companyId' || data.companyId !== null && data.companyId !== value.companyId) throw fail();
  return data.companyId;
}
function publicEntry(req, res, url) {
  const value = boundary(); if (!value) return false;
  const tenant = url.searchParams.get('tenant');
  if (req.method !== 'GET' || !fenced(tenant) || !['/login.html', '/forgot-password.html', '/reset-password.html', '/verify-email.html', '/app'].includes(url.pathname)) return false;
  if (url.searchParams.getAll('tenant').length !== 1 || url.searchParams.getAll('token').length > 1) throw fail();
  // Existing links keep their synthetic credential; redirect only to configured
  // origin, never an email/client-supplied destination. No bearer is logged.
  const target = new URL(url.pathname, value.origin); for (const [name, item] of url.searchParams) { if (!['tenant', 'token'].includes(name)) throw fail(); target.searchParams.set(name, item); }
  res.writeHead(302, { Location: target.href, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }); res.end(); return true;
}
module.exports = { boundary, fenced, assertLegacy, assertLegacySnapshot, legacySnapshot, publicEntry, adapterRequest, adapterResponse, discoverEmail };
