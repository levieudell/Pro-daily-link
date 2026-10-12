'use strict';
// A customer token authorizes one explicit change document and its linked bytes.
// It never supplies an account role or an editable capability.
const crypto = require('node:crypto');
const { canonicalHash } = require('./database/transactional-repository');
const assets = require('./protected-assets-admission');
const fail = (statusCode, message) => { throw Object.assign(Error(message), { statusCode }); };
const equal = (a, b) => canonicalHash(a ?? null) === canonicalHash(b ?? null);
const positive = value => Number.isSafeInteger(value) && value > 0;
const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const statuses = ['Potential', 'Pricing', 'Submitted', 'Approved', 'Rejected', 'Void', 'T&M'];
function route(url) {
  const path = typeof url === 'string' ? url : url.pathname;
  return /^\/api\/change-order\/([A-Za-z0-9_-]{32})(?:\/(decision)|\/photos\/([1-9]\d*))?$/.exec(path);
}
function rows(db, name) {
  const values = db[name] === undefined ? [] : db[name];
  if (!Array.isArray(values) || values.length > 50000 || values.some(row => !object(row) || !positive(row.id) || row.companyId !== undefined && row.companyId !== db.company.id) || new Set(values.map(row => row.id)).size !== values.length) fail(409, 'Change document source needs reconciliation.');
  return values;
}
function one(db, name, id) {
  const row = rows(db, name).find(value => value.id === id);
  if (!row) fail(404, 'Change order link not found or revoked');
  return row;
}
function resolve(db, url) {
  const match = route(url);
  if (!match) {
    if ((typeof url === 'string' ? url : url.pathname).startsWith('/api/change-order/')) fail(404, 'Change order link not found or revoked');
    return null;
  }
  if (typeof url !== 'string' && url.search) fail(400, 'Use the original change document URL.');
  const tokenHash = crypto.createHash('sha256').update(match[1]).digest('hex');
  const matches = rows(db, 'changes').filter(row => row.customerTokenHash === tokenHash);
  if (matches.length !== 1) fail(matches.length ? 409 : 404, 'Change order link not found or revoked');
  const change = matches[0];
  if (!positive(change.projectId) || !statuses.includes(change.status)) fail(409, 'Change document source needs reconciliation.');
  one(db, 'projects', change.projectId);
  const result = { companyId: db.company.id, changeId: change.id, projectId: change.projectId, tokenHash };
  if (Object.hasOwn(change, 'customerTokenExpiresAt')) {
    if (!iso(change.customerTokenExpiresAt)) fail(409, 'Change token expiry needs reconciliation.');
    if (Date.parse(change.customerTokenExpiresAt) <= Date.now()) fail(404, 'Change order link not found or revoked');
    result.expiresAt = change.customerTokenExpiresAt;
  }
  return result;
}
function assertSame(db, url, original) {
  const current = resolve(db, url);
  if (!original || !current || !equal(current, original)) fail(409, 'Change order access changed. Refresh the original document.');
  return current;
}
function parseDecision(value) {
  if (!object(value) || Object.keys(value).some(key => !['decision', 'name', 'note'].includes(key)) || !['approved', 'declined'].includes(value.decision) || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 120 || Object.hasOwn(value, 'note') && (typeof value.note !== 'string' || value.note.length > 500)) fail(400, 'Choose approve or decline and provide a name of at most 120 characters.');
  return { decision: value.decision, name: value.name.trim(), note: (value.note || '').trim() };
}
function validateDelta(before, after, url, body, binding) {
  assertSame(before, url, binding); assertSame(after, url, binding);
  const clean = db => Object.fromEntries(Object.entries(db).filter(([name]) => name !== 'rolesProviderAttempts'));
  const match = route(url);
  if (!match[2]) { if (!equal(clean(before), clean(after))) fail(409, 'A document read cannot change company records.'); return; }
  const input = parseDecision(body), old = one(before, 'changes', binding.changeId), current = one(after, 'changes', binding.changeId);
  if (!['Potential', 'Pricing', 'Submitted'].includes(old.status)) { if (!equal(clean(before), clean(after))) fail(409, 'A completed decision cannot be rewritten.'); return; }
  const status = input.decision === 'approved' ? 'Approved' : 'Rejected', at = current.decidedAt;
  if (!iso(at) || !Array.isArray(old.history || []) || !Array.isArray(before.auditLog || [])) fail(409, 'Change decision evidence needs reconciliation.');
  const expected = { ...old, status, decidedAt: at, decidedBy: input.name, decisionNote: input.note || null, updatedAt: at, history: [...(old.history || []), { action: `${status} by customer signature (${input.name})${input.note ? ` — ${input.note}` : ''}`, by: input.name, at }] };
  const audit = after.auditLog?.at(-1), auditFields = { type: 'project_change_decided', projectId: old.projectId, changeId: old.id, actor: input.name, detail: `${old.number} ${status.toLowerCase()} via change order link`, at };
  if (!audit || typeof audit.id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(audit.id) || (before.auditLog || []).some(row => row.id === audit.id) || !equal(audit, { id: audit.id, ...auditFields })) fail(409, 'Change decision audit needs reconciliation.');
  const expectedDb = { ...clean(before), changes: before.changes.map(row => row.id === old.id ? expected : row), auditLog: [...(before.auditLog || []), audit] };
  if (!equal(current, expected) || !equal(clean(after), expectedDb)) fail(409, 'A customer decision changes only its original change and audit.');
}
function text(value, limit = 1000, fallback = '') { if (value === undefined || value === null) return fallback; if (typeof value !== 'string' || value.length > limit) fail(409, 'Change document text needs reconciliation.'); return value; }
function amount(value, fallback = 0) { if (value == null) return fallback; if (!['number', 'string'].includes(typeof value) || String(value).trim() === '' || !Number.isFinite(Number(value)) || Number(value) < 0 || Number(value) > 1e12) fail(409, 'Change document numbers need reconciliation.'); return Number(value); }
function document(db, binding, { photoUrl } = {}) {
  const change = one(db, 'changes', binding.changeId), project = one(db, 'projects', binding.projectId);
  if (db.company.id !== binding.companyId || change.customerTokenHash !== binding.tokenHash || change.projectId !== project.id) fail(404, 'Change order link not found or revoked');
  const customer = typeof project.customer === 'number' ? one(db, 'customers', project.customerId).name : project.customer;
  const lines = change.lines || [];
  if (!Array.isArray(lines) || lines.length > 30 || lines.some(row => !object(row) || row.companyId !== undefined && row.companyId !== db.company.id)) fail(409, 'Change line items need reconciliation.');
  const photos = rows(db, 'photos').filter(row => Number(row.changeId) === change.id).filter(row => {
    try { photoReference(db, row, binding); return true; } catch (error) { if (error.statusCode === 404) return false; throw error; }
  });
  return { number: text(change.number, 80), title: text(change.title, 300), reason: text(change.reason), detail: text(change.detail), status: change.status, amount: amount(change.amount), lines: lines.map(row => ({ description: text(row.description, 300), quantity: amount(row.quantity), unit: text(row.unit, 20), laborHours: amount(row.laborHours), materialCost: amount(row.materialCost) })), photos: photos.map(row => ({ url: photoUrl ? photoUrl(row) : text(row.url, 2048), caption: text(row.caption, 500), capturedAt: text(row.capturedAt || row.createdAt, 40) })), createdAt: text(change.createdAt, 40), createdBy: text(change.createdBy, 120), submittedAt: text(change.submittedAt, 40, null), decidedAt: text(change.decidedAt, 40, null), decidedBy: text(change.decidedBy, 120, null), decisionNote: text(change.decisionNote, 500, null), company: { name: text(db.company.name, 500) }, project: { name: text(project.name, 500), customer: text(customer, 500), site: text(project.site, 1000) } };
}
function photo(db, url, binding) {
  assertSame(db, url, binding); const match = route(url), id = Number(match[3]);
  if (!positive(id)) fail(404, 'Change photo not found.');
  return photoReference(db, one(db, 'photos', id), binding);
}
function photoReference(db, selected, binding) {
  if (db.company.id !== binding.companyId) fail(404, 'Change photo not found.');
  const valid = row => {
    const projectId = db.projects?.[row.project]?.id ?? row.projectId;
    if (Number(row.changeId) !== binding.changeId || projectId !== binding.projectId || row.projectId != null && Number(row.projectId) !== binding.projectId) return false;
    if (row.reportId != null) { const report = one(db, 'reports', Number(row.reportId)); if (db.projects?.[report.project]?.id !== binding.projectId) return false; }
    if (row.workdayId != null) { const day = one(db, 'workdays', Number(row.workdayId)); if (day.projectId !== binding.projectId || row.reportId != null && (day.reportId != null && Number(day.reportId) !== Number(row.reportId) || one(db, 'reports', Number(row.reportId)).workdayId != null && Number(one(db, 'reports', Number(row.reportId)).workdayId) !== Number(day.id))) return false; }
    return true;
  };
  if (!valid(selected)) fail(404, 'Change photo not found.');
  const where = { url: selected.url, bucket: selected.storageBucket || selected.bucket, key: selected.storageKey || selected.objectKey };
  if (typeof where.url !== 'string' || where.bucket && (typeof where.key !== 'string' || !where.key.startsWith(db.company.id + '/'))) fail(409, 'Change photo storage needs reconciliation.');
  const refs = assets.references(db, where);
  if (!refs.length || refs.some(ref => ref.kind !== 'photo' || !valid(ref.row))) fail(404, 'Change photo not found.');
  return { id: selected.id, projectId: binding.projectId, changeId: binding.changeId, url: text(selected.url, 2048), ...(where.bucket ? { bucket: text(where.bucket, 100), key: text(where.key, 2048) } : {}) };
}
module.exports = { route, resolve, assertSame, parseDecision, validateDelta, document, photo };
