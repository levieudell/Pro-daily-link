'use strict';
const registry = require('./capability-registry'), ids = require('./notes-access'), daily = require('./daily-access'), schedule = require('./scheduling-access'), review = require('./time-review-access');
const fail = (statusCode, message) => { throw Object.assign(Error(message), { statusCode }); };
const label = value => { if (typeof value !== 'string' || value.length > 5000 || /[\u0000-\u001f\u007f]/.test(value)) fail(409, 'Workspace options need reconciliation'); return value; };
function projection(db, storedUser, workflow, baselineProjectAllowed) {
  const user = registry.normalize(storedUser), gates = registry.effective(db, user);
  if (!['owner', ...registry.roles].includes(user.role)) fail(403, 'Workspace role unavailable');
  const controls = { schedule: gates.scheduling.create || gates.scheduling.edit, dailies: gates.daily.createReports || gates.daily.editReports, workdays: gates.daily.runWorkdays, cards: gates.timeWrite.createCards, notes: gates.notes.view };
  if (!Object.hasOwn(controls, workflow)) fail(400, 'Choose a supported workflow');
  if (!controls[workflow]) fail(403, 'Workflow options are unavailable');
  const projects = Object.hasOwn(db, 'projects') ? db.projects : [], team = Object.hasOwn(db, 'team') ? db.team : [];
  for (const rows of [projects, team]) { if (!Array.isArray(rows) || rows.length > 10000) fail(409, 'Workspace options need reconciliation'); for (const row of rows) { ids.uniqueNumeric(rows, row?.id, 'Workspace option', db.company.id); label(row.name); } }
  require('./scoped-navigation').validateScopeRecords(db, projects);
  const projectAllowed = project => workflow === 'notes' ? ids.projectAllowed(db, user, project.id, baselineProjectAllowed) : workflow === 'schedule' ? ['owner', 'admin'].includes(user.role) || (user.projectIds || []).map(Number).includes(Number(project.id)) : workflow === 'cards' ? ['owner', 'admin'].includes(user.role) || (user.projectIds || []).map(Number).includes(Number(project.id)) : daily.projectAllowed(db, user, project.id);
  const memberAllowed = member => workflow === 'notes' ? false : workflow === 'schedule' ? projects.some(project => projectAllowed(project) && schedule.inScope(db, user, { projectId: Number(project.id), memberIds: [Number(member.id)] }, gates.scheduling.create ? 'create' : 'edit')) : workflow === 'cards' ? projects.some(project => projectAllowed(project) && review.cardInScope(db, user, { projectId: Number(project.id), memberId: Number(member.id) })) : daily.memberAllowed(db, user, member.id);
  const selected = projects.filter(projectAllowed);
  const itemsFor = project => {
    const items = Object.hasOwn(project, 'estimateItems') ? project.estimateItems : [];
    if (!Array.isArray(items) || items.length > 10000) fail(409, 'Daily scope options need reconciliation');
    return items.map(item => { ids.uniqueNumeric(items, item.id, 'Estimate item', db.company.id); return { id: Number(item.id), name: label(item.name), unit: label(item.unit) }; });
  };
  return { workflow, projects: selected.map(project => ({ id: Number(project.id), name: project.name, ...(workflow === 'dailies' ? { items: itemsFor(project) } : {}) })), team: team.filter(memberAllowed).map(member => ({ id: Number(member.id), name: member.name })), linkedMemberId: user.memberId == null ? null : Number(user.memberId) };
}
function createHandler({ readDb, json, assertCurrent, accountAccess, baselineProjectAllowed }) {
  return async (req, res, url) => {
    if (req.method !== 'GET' || url.pathname !== '/api/workspace/options') return false;
    try { const db = readDb(); if (accountAccess(db.company).locked) fail(402, 'Company account is locked'); if ([...url.searchParams.keys()].some(key => key !== 'workflow') || url.searchParams.getAll('workflow').length !== 1) fail(400, 'Choose one workflow'); const result = projection(db, req.auth.user, url.searchParams.get('workflow'), baselineProjectAllowed); await assertCurrent(req, false); json(res, 200, result); }
    catch (error) { if (![400, 401, 402, 403, 404, 409].includes(error.statusCode)) throw error; json(res, error.statusCode, { error: error.message }); }
    return true;
  };
}
module.exports = { projection, createHandler };
