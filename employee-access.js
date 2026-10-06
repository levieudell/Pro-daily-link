'use strict';
const normalizeEmail = value => String(value || '').trim().toLowerCase();
function accessRoles(actor) {
  return actor?.role === 'owner' ? ['admin', 'project_manager', 'foreman', 'field'] : actor?.role === 'admin' ? ['project_manager', 'foreman', 'field'] : [];
}
function linkedAccount(db, member) {
  return (db.users || []).find(user => (!user.companyId || user.companyId === db.company.id) && (Number(user.employeeId) === Number(member.id) || Number(user.memberId) === Number(member.id)));
}
function prepareEmployeeAccount(db, actor, member, input, plan) {
  const fail = (status, error) => ({ status, error });
  if (!accessRoles(actor).includes(input.role)) return fail(403, 'Choose an app role you are permitted to grant');
  if (db.company.emailVerificationRequiredAt && !actor.emailVerifiedAt) return fail(403, 'Confirm your email before creating user access');
  if (linkedAccount(db, member)) return fail(409, 'This employee already has an account. Manage the existing account instead.');
  const email = normalizeEmail(input.email || member.email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail(400, 'Enter a valid email address for app access');
  if ((db.users || []).some(user => normalizeEmail(user.email) === email)) return fail(409, 'A user with that email already exists. No account was linked or changed.');
  if (plan.maxUsers != null && (db.users || []).filter(user => user.status === 'Active').length >= plan.maxUsers) return fail(409, `Your ${plan.name} plan includes ${plan.maxUsers} active users. Manage your plan to add more.`);
  const projectIds = Array.isArray(input.projectIds) ? [...new Set(input.projectIds.map(Number))] : [];
  const assignedCrews = Array.isArray(input.assignedCrews) ? [...new Set(input.assignedCrews.map(String))] : [];
  if (input.role === 'project_manager' && (projectIds.some(id => !(db.projects || []).some(project => Number(project.id) === id && !project.archived)) || assignedCrews.some(crew => !(db.team || []).some(person => person.crew === crew)))) return fail(400, 'Choose current projects and crews');
  return { row: { companyId: db.company.id, name: member.name, email, role: input.role, preferredLanguage: 'en', employeeId: member.id, memberId: member.id, projectIds: input.role === 'project_manager' ? projectIds : [], assignedCrews: input.role === 'project_manager' ? assignedCrews : [], permissions: input.role === 'project_manager' ? { scheduleCrews: false, viewTime: false, manageTime: false, viewDailies: true, approveDailies: false } : {}, status: 'Active', mustSetPassword: true } };
}
module.exports = { accessRoles, linkedAccount, prepareEmployeeAccount };
