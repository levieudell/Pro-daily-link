'use strict';
const { assembleSnapshot, canonicalHash, databaseCompanyId } = require('./transactional-repository');
const unavailable = () => Object.assign(new Error('Tenant snapshot integrity unavailable'), { code: 'PDL_TENANT_INTEGRITY', statusCode: 503 });
async function loadConsistentSnapshot(companyId, request, { attempts = 3, pageSize = 500, maxPages = 200 } = {}) {
  if (![attempts, pageSize, maxPages].every(Number.isSafeInteger) || attempts < 1 || attempts > 5 || pageSize < 1 || pageSize > 1000 || maxPages < 1 || maxPages > 200) throw unavailable();
  const id = databaseCompanyId(companyId), prefix = '/rest/v1/tenant_revisions?company_id=eq.' + encodeURIComponent(id) + '&select=revision,scalar_data,content_hash&limit=1';
  const state = async () => {
    const rows = await (await request(prefix)).json();
    if (!Array.isArray(rows) || rows.length > 1) throw unavailable();
    const row = rows[0]; if (!row) return null;
    if (typeof row.revision !== 'number' && (typeof row.revision !== 'string' || !/^(0|[1-9][0-9]*)$/.test(row.revision))) throw unavailable();
    if (!Number.isSafeInteger(Number(row.revision)) || Number(row.revision) < 0 || !row.scalar_data || Array.isArray(row.scalar_data) || typeof row.scalar_data !== 'object' || !/^[0-9a-f]{64}$/.test(row.content_hash)) throw unavailable();
    return row;
  };
  for (let attempt = 0; attempt < attempts; attempt++) {
    const before = await state(); if (!before) return null;
    const records = [], seen = new Set(); let complete = false, previous;
    for (let page = 0; page < maxPages; page++) {
      const rows = await (await request('/rest/v1/tenant_records?company_id=eq.' + encodeURIComponent(id) + '&select=collection,position,data&order=collection.asc,position.asc&limit=' + pageSize + '&offset=' + page * pageSize)).json();
      if (!Array.isArray(rows) || rows.length > pageSize) throw unavailable();
      for (const row of rows) {
        if (!row || typeof row.collection !== 'string' || !Number.isSafeInteger(row.position) || row.position < 0 || !Object.hasOwn(row, 'data')) throw unavailable();
        const key = row.collection + ':' + row.position;
        if (previous && row.collection === previous.collection && row.position !== previous.position + 1) throw unavailable();
        if ((!previous || previous.collection !== row.collection) && row.position !== 0) throw unavailable();
        if (seen.has(key)) throw unavailable(); seen.add(key); records.push(row);
        previous = row;
      }
      if (rows.length < pageSize) { complete = true; break; }
    }
    if (!complete) throw unavailable();
    const after = await state();
    if (!after || Number(before.revision) !== Number(after.revision) || before.content_hash !== after.content_hash || canonicalHash(before.scalar_data) !== canonicalHash(after.scalar_data)) continue;
    let snapshot;
    try { snapshot = assembleSnapshot(before.scalar_data, records); } catch { throw unavailable(); }
    if (databaseCompanyId(snapshot) !== id || canonicalHash(snapshot) !== before.content_hash) continue;
    return { snapshot, revision: Number(before.revision), contentHash: before.content_hash };
  }
  throw unavailable();
}
module.exports = { loadConsistentSnapshot };
