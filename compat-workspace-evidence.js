'use strict';
// Validate tenant and resource identities before deriving scope or dropping
// private fields. Projection cannot legitimize an ambiguous foreign record.
const fail = () => { throw Object.assign(Error('Workspace identity bindings need reconciliation.'), { statusCode: 409 }); };
const id = value => ['number', 'string'].includes(typeof value) && /^[1-9]\d*$/.test(String(value)) && Number.isSafeInteger(Number(value));
function rows(db, name) { const value = db[name]; if (value === undefined) return []; if (!Array.isArray(value) || value.some(row => !row || typeof row !== 'object' || Array.isArray(row) || row.companyId !== undefined && row.companyId !== db.company.id)) fail(); return value; }
function identities(db, name, numeric = true) { const items = rows(db, name), seen = new Set(); for (const row of items) { if (numeric ? !id(row.id) : !['string', 'number'].includes(typeof row.id) || !String(row.id)) fail(); const key = String(numeric ? Number(row.id) : row.id); if (seen.has(key)) fail(); seen.add(key); } return new Map(items.map(row => [String(numeric ? Number(row.id) : row.id), row])); }
function validateWorkspace(db) {
  const text = (row, keys) => { for(const key of keys)if(Object.hasOwn(row,key)&&row[key]!==null&&typeof row[key]!=='string')fail(); };
  if(typeof db.company?.name!=='string')fail(); text(db.company,['timezone','status','subscriptionStatus','plan']);
  const projects = identities(db, 'projects'), team = identities(db, 'team'), customers = identities(db, 'customers'), reports = identities(db, 'reports'), days = identities(db, 'workdays'), assignments = identities(db, 'assignments');
  for(const row of team.values())text(row,['name','crew','role','status','archivedAt']);
  for(const row of projects.values())text(row,['name','code','crew','status','archivedAt','site','address']);
  const project = value => { if (!id(value) || !projects.has(String(Number(value)))) fail(); };
  const member = value => { if (!id(value) || !team.has(String(Number(value)))) fail(); };
  const members = value => { if (!Array.isArray(value) || !value.length || new Set(value.map(Number)).size !== value.length) fail(); value.forEach(member); };
  for (const row of projects.values()) { if (row.customerId !== undefined && row.customerId !== null && !customers.has(String(Number(row.customerId)))) fail(); }
  for (const row of reports.values()) { if (!Number.isSafeInteger(row.project) || !db.projects[row.project]) fail(); if (row.laborEntries !== undefined && !Array.isArray(row.laborEntries)) fail(); for (const entry of row.laborEntries || []) { if (!entry || typeof entry !== 'object') fail(); member(entry.memberId); } if (row.workdayId != null && (!days.has(String(Number(row.workdayId))) || Number(days.get(String(Number(row.workdayId))).projectId) !== Number(db.projects[row.project].id))) fail(); }
  for (const row of days.values()) { project(row.projectId); members(row.memberIds); if (row.reportId != null && (!reports.has(String(Number(row.reportId))) || Number(db.projects[reports.get(String(Number(row.reportId))).project]?.id) !== Number(row.projectId))) fail(); }
  for (const row of assignments.values()) { project(row.projectId); members(row.memberIds); }
  for (const row of rows(db, 'timeCards')) { if (!id(row.id)) fail(); member(row.memberId); if (row.projectId != null) project(row.projectId); if (row.workdayId != null && (!days.has(String(Number(row.workdayId))) || Number(days.get(String(Number(row.workdayId))).projectId) !== Number(row.projectId))) fail(); if(row.history!==undefined){if(!Array.isArray(row.history))fail();for(const entry of row.history){if(!entry||typeof entry!=='object'||Array.isArray(entry))fail();text(entry,['action','by','at','reason']);}} }
  for (const row of rows(db, 'timeOffRequests')) member(row.memberId);
  for (const name of ['projectPlans', 'projectTickets', 'subcontractorLinks', 'projectNotesTodos']) for (const row of identities(db, name, !['projectNotesTodos', 'subcontractorLinks'].includes(name)).values()) { project(row.projectId); if (row.reportId != null && (!reports.has(String(Number(row.reportId))) || Number(db.projects[reports.get(String(Number(row.reportId))).project]?.id) !== Number(row.projectId))) fail(); }
  for (const row of identities(db, 'photos').values()) { if (row.project != null && (!Number.isSafeInteger(row.project) || !db.projects[row.project])) fail(); if (row.projectId != null) project(row.projectId); if (row.project != null && row.projectId != null && Number(db.projects[row.project].id) !== Number(row.projectId)) fail(); if (row.reportId != null && (!reports.has(String(Number(row.reportId))) || row.project != null && reports.get(String(Number(row.reportId))).project !== row.project)) fail(); if (row.workdayId != null && !days.has(String(Number(row.workdayId)))) fail(); }
  for (const name of ['subcontractors', 'auditLog', 'dailyTemplates', 'catalog', 'activityCodes', 'payPeriods', 'payPeriodExports', 'reportingExports']) rows(db, name);
  return db;
}
module.exports = { validateWorkspace, rows, identities };
