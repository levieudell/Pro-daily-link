'use strict';
// Policy-on protection for scope-producing legacy paths. This is not a source
// of new grants. Unknown identities and protected input cannot mint scope.
async function guard({ req, url, db, user, body, projectAllowed, memberAllowed }) {
  if (db.company.notesRolePolicy === undefined) return;
  const method = req.method, path = url.pathname, mutation = ['POST', 'PATCH', 'PUT', 'DELETE'].includes(method);
  const office = ['owner', 'admin'].includes(user?.role), supported = ['owner', 'admin', 'project_manager', 'field', 'foreman'].includes(user?.role);
  const fail = message => { throw Object.assign(new Error(message), { statusCode: 403 }); };
  if (mutation && !supported && !path.startsWith('/api/auth/') && !path.startsWith('/api/guest/')) fail('Active supported tenant account required.');
  const directory = /^\/api\/(?:customers|projects|team)(?:\/\d+)?$/.test(path);
  if (mutation && directory) {
    if (!office) fail('Directory and membership administration requires Owner or Admin.');
    const input = await body(req);
    if (['id', 'companyId', 'role', 'permissions', 'notesCustomRoleId', 'notesRolePolicy', 'ownerId', 'userId'].some(key => Object.hasOwn(input, key))) fail('Protected identity fields cannot be supplied.');
  }
  const scopedPath = path.match(/^\/api\/projects\/(\d+)\/(?:plans|estimate-proposals|tm-summary)/);
  if (scopedPath && !projectAllowed(db, user, Number(scopedPath[1]))) fail('Assigned project access required.');
  if (!mutation || office) return;
  let projectId, members = [], input;
  if (path === '/api/workdays/start' || path === '/api/reports' || path === '/api/photos') {
    input = await body(req);
    projectId = input.projectId == null ? db.projects?.[Number(input.project)]?.id : Number(input.projectId);
    members = path === '/api/workdays/start' ? input.memberIds || [] : input.laborEntries?.map(row => row.memberId) || [];
  }
  const workday = path.match(/^\/api\/workdays\/(\d+)\/end$/);
  if (workday) { const row = (db.workdays || []).find(item => Number(item.id) === Number(workday[1])); projectId = row?.projectId; members = row?.memberIds || []; }
  const report = path.match(/^\/api\/reports\/(\d+)(?:\/.*)?$/);
  if (report) {
    const row = (db.reports || []).find(item => Number(item.id) === Number(report[1]));
    if (row && !projectAllowed(db, user, db.projects?.[Number(row.project)]?.id)) fail('Assigned report project required.');
    if (row && user.role !== 'project_manager' && !memberAllowed(db, user, user.memberId)) fail('Linked field identity required.');
    input = await body(req); projectId = input.projectId == null ? db.projects?.[Number(input.project ?? row?.project)]?.id : Number(input.projectId); members = (input.laborEntries || row?.laborEntries || []).map(item => item.memberId);
    if (user.role !== 'project_manager' && row && !((row.laborEntries || []).some(item => Number(item.memberId) === Number(user.memberId)) || row.foreman === user.name)) fail('Own field report required.');
  }
  if (projectId != null && (!projectAllowed(db, user, Number(projectId)) || members.some(id => !memberAllowed(db, user, Number(id))))) fail('Assigned project and crew scope required.');
  if (path === '/api/photos' && input?.reportId) {
    const row = (db.reports || []).find(item => Number(item.id) === Number(input.reportId));
    if (!row || Number(db.projects?.[Number(row.project)]?.id) !== Number(projectId) || !projectAllowed(db, user, Number(projectId))) fail('Scoped linked report required.');
    if (user.role !== 'project_manager' && !((row.laborEntries || []).some(item => Number(item.memberId) === Number(user.memberId)) || row.foreman === user.name)) fail('Own linked report required.');
  }
  if (path === '/api/photos' && input?.workdayId) {
    const row = (db.workdays || []).find(item => Number(item.id) === Number(input.workdayId));
    if (!row || Number(row.projectId) !== Number(projectId) || (row.memberIds || []).some(id => !memberAllowed(db, user, Number(id)))) fail('Scoped linked workday required.');
  }
}
module.exports = { guard };
