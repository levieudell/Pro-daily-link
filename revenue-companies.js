'use strict';
// Company-only reconciliation; never request notes, users, or full tenant snapshots.
const PAGE_SIZE = 500, MAX_PAGES = 40, REQUEST_TIMEOUT_MS = 5000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
class RevenueCompaniesError extends Error { constructor(code) { super(code); this.name = 'RevenueCompaniesError'; this.code = code; } }
const fail = code => { throw new RevenueCompaniesError(code); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
function checkSignal(signal) { if (signal?.aborted) fail('aborted'); }
function companyRecord(company) {
  if (!object(company) || typeof company.id !== 'string' || !company.id || company.id.trim() !== company.id) fail('invalid_data');
  if (company.name != null && typeof company.name !== 'string') fail('invalid_data');
  const persistence = company.persistence == null ? {} : company.persistence; if (!object(persistence)) fail('invalid_data');
  const revisionValue = persistence.revision ?? 0;
  if (typeof revisionValue !== 'number' && (typeof revisionValue !== 'string' || !/^\d+$/.test(revisionValue))) fail('invalid_data');
  const revision = Number(revisionValue); if (!Number.isSafeInteger(revision) || revision < 0) fail('invalid_data');
  const updatedAt = persistence.updatedAt ?? null, timestamp = updatedAt === null ? 0 : typeof updatedAt === 'string' ? Date.parse(updatedAt) : NaN;
  if (!Number.isFinite(timestamp)) fail('invalid_data');
  const link = value => { if (value == null || value === '') return null; if (typeof value !== 'string' || value.trim() !== value) fail('invalid_data'); return value; };
  return { company: { id: company.id, name: company.name || 'Company', stripeCustomerId: link(company.stripeCustomerId), stripeSubscriptionId: link(company.stripeSubscriptionId), persistence: { revision, updatedAt } }, revision, timestamp };
}
async function fetchPage(supabase, path, signal) {
  checkSignal(signal); const controller = new AbortController(); let timer, onAbort;
  const stop = new Promise((resolve, reject) => {
    onAbort = () => { controller.abort(); reject(new RevenueCompaniesError('aborted')); };
    signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => { controller.abort(); reject(new RevenueCompaniesError('incomplete')); }, REQUEST_TIMEOUT_MS);
  });
  const read = Promise.resolve().then(async () => { checkSignal(signal); const response = await supabase.request(path, { method: 'GET', signal: controller.signal }); if (!response || response.ok === false || typeof response.json !== 'function') fail('invalid_data'); return response.json(); });
  try { const rows = await Promise.race([read, stop]); checkSignal(signal); return rows; }
  catch (error) { controller.abort(); throw error instanceof RevenueCompaniesError ? error : new RevenueCompaniesError('unavailable'); }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); }
}
async function loadRevenueCompanies({ localCompanies = [], supabase, signal, excludeCompanyId } = {}) {
  checkSignal(signal); if (!Array.isArray(localCompanies) || !supabase || typeof supabase.configured !== 'function') fail('invalid_data');
  const companies = new Map();
  function merge(company) {
    const record = companyRecord(company); if (record.company.id === excludeCompanyId) return;
    const previous = companies.get(record.company.id); if (!previous) { companies.set(record.company.id, record); return; }
    const order = record.revision - previous.revision || record.timestamp - previous.timestamp;
    if (order > 0) companies.set(record.company.id, record);
    else if (order === 0 && (record.company.stripeCustomerId !== previous.company.stripeCustomerId || record.company.stripeSubscriptionId !== previous.company.stripeSubscriptionId)) fail('mapping_conflict');
  }
  for (const company of localCompanies) merge(company);
  if (supabase.configured()) {
    if (typeof supabase.request !== 'function') fail('invalid_data'); let cursor = null, complete = false;
    for (let page = 0; page < MAX_PAGES; page++) {
      checkSignal(signal);
      const url = `/rest/v1/companies?select=id,company:data->company&order=id.asc&limit=${PAGE_SIZE}` + (cursor ? `&id=gt.${cursor}` : '');
      const rows = await fetchPage(supabase, url, signal); if (!Array.isArray(rows) || rows.length > PAGE_SIZE) fail('invalid_data');
      if (!rows.length) { complete = true; break; }
      for (const row of rows) {
        if (!object(row) || typeof row.id !== 'string' || !UUID.test(row.id)) fail('invalid_data');
        const id = row.id.toLowerCase(); if (cursor && id <= cursor) fail('invalid_data'); cursor = id; merge(row.company);
      }
      // Continue until empty: provider row caps can be smaller than PAGE_SIZE.
    }
    if (!complete) fail('incomplete');
  }
  checkSignal(signal); return [...companies.values()].map(record => record.company);
}
module.exports = { loadRevenueCompanies };
