'use strict';
const accounts = require('./account-projections'), registry = require('./capability-registry'), ids = require('./notes-access');
const crypto = require('node:crypto');
const schedule = require('./scheduling-access'), daily = require('./daily-access'), time = require('./time-review-access');
const fail = message => { throw Object.assign(Error(message), { statusCode: 409 }); };
function label(value) { if (typeof value !== 'string' || value.length > 5000 || /[\u0000-\u001f\u007f]/.test(value)) fail('Navigation labels need reconciliation'); return value; }
function rows(db, key) {
  const value = Object.hasOwn(db, key) ? db[key] : []; if (!Array.isArray(value) || value.length > 10000) fail('Navigation identities need reconciliation');
  for (const row of value) { ids.uniqueNumeric(value, row?.id, 'Navigation record', db.company.id); label(row.name); }
  return value;
}
function resource(db, row, collection, memberIds, projectId) {
  ids.uniqueNumeric(db[collection] || [], row.id, 'Navigation source', db.company.id);
  try { if (projectId != null) ids.uniqueNumeric(db.projects, projectId, 'Source project', db.company.id); }
  catch (error) { if (error.statusCode === 404) fail('Navigation source project needs reconciliation'); throw error; }
  if (!Array.isArray(memberIds) || new Set(memberIds.map(Number)).size !== memberIds.length) fail('Navigation source scope needs reconciliation');
  try { for (const id of memberIds) ids.uniqueNumeric(db.team, id, 'Source member', db.company.id); }
  catch (error) { if (error.statusCode === 404) fail('Navigation source member needs reconciliation'); throw error; }
}
function validateScopeRecords(db, projects) {
  for (const key of ['assignments', 'workdays', 'reports', 'timeCards']) if (Object.hasOwn(db, key) && (!Array.isArray(db[key]) || db[key].length > 10000)) fail('Navigation source collection needs reconciliation');
  for (const row of db.assignments || []) resource(db, row, 'assignments', row.memberIds, row.projectId);
  for (const row of db.workdays || []) resource(db, row, 'workdays', row.memberIds, row.projectId);
  for (const row of db.reports || []) {
    if (!Number.isSafeInteger(row.project) || row.project < 0 || row.project >= projects.length || !Array.isArray(row.laborEntries)) fail('Report navigation scope needs reconciliation');
    if (row.foreman != null) label(row.foreman);
    resource(db, row, 'reports', row.laborEntries.map(entry => entry.memberId), projects[row.project].id);
  }
  for (const row of db.timeCards || []) resource(db, row, 'timeCards', [row.memberId], row.projectId);
}
function projectViews(db, actor, project, baselineProjectAllowed) {
  const notes = ids.access(db, actor).view && ids.projectAllowed(db, actor, project.id, baselineProjectAllowed);
  const assignments = (db.assignments || []).filter(row => Number(row.projectId) === Number(project.id) && schedule.inScope(db, actor, row, 'view'));
  const reports = (db.reports || []).filter(row => Number(db.projects[row.project]?.id) === Number(project.id) && daily.reportInScope(db, actor, row));
  const workdays = (db.workdays || []).filter(row => Number(row.projectId) === Number(project.id) && daily.workdayInScope(db, actor, row));
  const cards = (db.timeCards || []).filter(row => Number(row.projectId) === Number(project.id) && time.cardInScope(db, actor, row));
  return { notes: Boolean(notes), scheduling: assignments.length > 0, reports: reports.length > 0, workdays: workdays.length > 0, timeCards: cards.length > 0 };
}
function projection(db, stored, baselineProjectAllowed, revision) {
  const actor = registry.normalize(stored), account = accounts.dto(db, actor, { current: true, directory: true });
  if (!['owner', ...registry.roles].includes(actor.role)) throw Object.assign(Error('Workspace role is unavailable'), { statusCode: 403 });
  if (!Array.isArray(db.users) || db.users.length > 1000) fail('Navigation account directory needs reconciliation');
  const projects = rows(db, 'projects'), team = rows(db, 'team'), customers = rows(db, 'customers');
  label(db.company.name);
  for (const project of projects) if (project.customerId != null && !ids.numericId(project.customerId)) fail('Project customer link needs reconciliation');
  validateScopeRecords(db, projects);
  const office = ['owner', 'admin'].includes(actor.role), projectRows = projects.map(project => ({ project, views: projectViews(db, actor, project, baselineProjectAllowed) })).filter(row => office || Object.values(row.views).some(Boolean));
  const visibleMembers = new Set();
  for (const row of schedule.visibleAssignments(db, actor)) for (const id of row.memberIds) visibleMembers.add(Number(id));
  for (const row of db.reports || []) if (daily.reportInScope(db, actor, row)) for (const entry of row.laborEntries) visibleMembers.add(Number(entry.memberId));
  for (const row of db.workdays || []) if (daily.workdayInScope(db, actor, row)) for (const id of row.memberIds) visibleMembers.add(Number(id));
  for (const row of db.timeCards || []) if (time.cardInScope(db, actor, row)) visibleMembers.add(Number(row.memberId));
  if (['field', 'foreman'].includes(actor.role) && (account.effectiveCapabilities.timeOff.viewRequests || account.effectiveCapabilities.notes.view) && ids.numericId(actor.memberId)) visibleMembers.add(Number(actor.memberId));
  const customerLinks = new Set(projectRows.map(row => row.project.customerId));
  const customerRows = office ? customers : actor.role === 'project_manager' ? customers.filter(row => customerLinks.has(row.id)) : [];
  return { version: 1, tenantRevision: revision, company: { id: db.company.id, name: db.company.name }, actor: account,
    settings: { roles: actor.role === 'owner' }, immutableMetadataDirectory: office,
    accounts: actor.role === 'owner' ? accounts.directory(db).map(row => ({ id: row.id, name: row.name, role: row.accessRole, status: row.status, scopeState: row.scopeState })) : [],
    projects: projectRows.map(({ project, views }) => ({ id: Number(project.id), name: project.name, views })),
    team: team.filter(row => office || visibleMembers.has(Number(row.id))).map(row => ({ id: Number(row.id), name: row.name })),
    customers: customerRows.map(row => ({ id: Number(row.id), name: row.name })),
    missingCustomerLinks: ['owner', 'admin', 'project_manager'].includes(actor.role) ? projectRows.filter(row => row.project.customerId != null && !customers.some(customer => customer.id === row.project.customerId)).length : 0 };
}
function createHandler({ readDb, json, revision, assertCurrent, accountAccess, baselineProjectAllowed }) {
  return async (req, res, url) => {
    if (req.method !== 'GET' || url.pathname !== '/api/navigation') return false;
    try {
      const db = readDb(); if (accountAccess(db.company).locked) throw Object.assign(Error('Company account is locked'), { statusCode: 402 });
      const result = projection(db, req.auth.user, baselineProjectAllowed, revision());
      // Public comparison token, never an auth credential or stored session hash.
      result.sessionBinding = crypto.createHash('sha256').update('pdl-navigation-session-v1\0' + db.company.id + '\0' + req.auth.session.tokenHash).digest('hex');
      await assertCurrent(req, false); json(res, 200, result);
    } catch (error) { if (![401, 402, 403, 404, 409].includes(error.statusCode)) throw error; json(res, error.statusCode, { error: error.message }); }
    return true;
  };
}
module.exports = { projection, createHandler, validateScopeRecords };
