'use strict';
// Read-only authority assembly over the exact reviewed six typed controllers.
// Policy editing/activation and operation admission remain separate integrations.
const { permittedCompany } = require('./project-assistant-access');
const families = Object.freeze([
  ['scheduling', 'Scheduling', 'scheduling', 'schedulingAccess', require('./scheduling-access')],
  ['timeOff', 'Private time off', 'timeOff', 'timeOffAccess', require('./time-off-access')],
  ['timeReview', 'Time review', 'timeReview', 'timeReviewAccess', require('./time-review-access')],
  ['timeWrite', 'Time cards and payroll', 'timeWrite', 'timeWriteAccess', require('./time-write-access')],
  ['daily', 'Dailies and workdays', 'daily', 'dailyAccess', require('./daily-access')],
  ['notes', 'Project notes and to-dos', 'notes', 'notesPermissions', require('./notes-access')]
].map(row => Object.freeze(row)));
const roles = Object.freeze(['admin', 'project_manager', 'foreman', 'field']);
const normalize = user => user?.role === 'office' ? { ...user, role: 'admin' } : user;
function actor(db, user) { return require('./role-profiles').evaluate(db, () => { for (const [, , , , controller] of families) user = controller.actor(db, user, true); return user; }); }
function effective(db, user) { return require('./role-profiles').evaluate(db, () => Object.fromEntries(families.map(([id, , , , controller]) => [id, controller.access(db, normalize(user))]))); }
function baseline(db, user) {
  const clean = { ...db, company: { ...db.company }, users: (db.users || []).map(row => { const copy = { ...row }; delete copy.notesCustomRoleId; delete copy.notesPolicyRequired; return copy; }) };
  delete clean.company.roleProfiles; delete clean.company.roleProfilesRequired;
  for (const [, , prefix] of families) { delete clean.company[prefix + 'RolePolicy']; delete clean.company[prefix + 'PolicyRequired']; }
  const copy = { ...user }; delete copy.notesCustomRoleId; delete copy.notesPolicyRequired;
  return effective(clean, copy);
}
function policyState(db) {
  return Object.fromEntries(families.map(([id, , prefix, , module]) => {
    const required = module.required(db), present = Object.hasOwn(db.company || {}, prefix + 'RolePolicy');
    let state = required ? present ? 'invalid' : 'required-missing' : 'default', revision = 0;
    if (present) { try { revision = module.validatePolicy(db.company[prefix + 'RolePolicy']).revision; state = 'valid'; } catch {} }
    return [id, { state, revision, required }];
  }));
}
function validatePolicySet(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== families.length || Object.keys(value).some(key => !families.some(row => row[0] === key))) throw Error('Use exactly the supported typed policy families');
  for (const [id, , , , module] of families) module.validatePolicy(value[id]);
  return value;
}
function immutable(db, user) {
  user = normalize(user); const active = user?.status === 'Active';
  return { ownerManagement: active && user.role === 'owner', assistantEligible: active && permittedCompany(db.company?.id) && ['owner', 'admin', 'project_manager'].includes(user.role), financialPolicy: 'existing-pricing-policy', scope: 'existing-company-project-member-scope' };
}
function describe(db) {
  return { version: 1, roles: [...roles], ownerImmutable: true,
    domains: families.map(([id, label, prefix, property, module]) => ({ id, label, policyProperty: prefix + 'RolePolicy', actorProperty: property, actions: [...module.actions], ceilings: Object.fromEntries(['owner', ...roles].map(role => [role, module.ceiling(role)])) })),
    policyState: policyState(db), operations: families.flatMap(([id,,,,controller]) => controller.actions.map(action => ({ capability: id + '.' + action, configurable: true }))),
    previews: [...Object.entries(require('./daily-admission').definitions).map(([action, [permission, method, path]]) => ({ endpoint: '/api/daily-actions/preview', action, control: permission === 'ownerExport' ? null : 'daily.' + permission, immutable: permission === 'ownerExport' ? 'owner' : null, method, target: typeof path === 'function' ? path('{id}') : path })), ...Object.entries(require('./time-write-admission').definitions).map(([action, [group, permission, method, path]]) => ({ endpoint: group === 'cards' ? '/api/time-cards/action-preview' : '/api/pay-periods/action-preview', action, control: 'timeWrite.' + permission, method, target: typeof path === 'function' ? path('{id}') : path }))],
    immutable: ['owner/tenant/security/user management', 'billing', 'existing pricing policy', 'fixed Forged-only owner/admin/PM assistant eligibility', 'company/project/member/crew scope', 'feature/account locks'],
    unavailable: ['projects/customers/team/subcontractor writers', 'company settings/templates/catalog', 'report flags/rates/deletes and broader changes/tickets/aggregates', 'remaining attachment/public/provider effects and complete backup'],
    namedProfilesAvailable: true, profileWorkflow: { read: '/api/company/role-policy/profiles', preview: '/api/company/role-policy/profiles/preview', confirm: '/api/company/role-policy/confirm', ownerOnly: true, scopeInheritance: require('./role-profiles').SCOPE }, policyWorkflowAvailable: true, policyWorkflow: { read: '/api/company/role-policy', preview: '/api/company/role-policy/preview', confirm: '/api/company/role-policy/confirm', audit: '/api/company/role-policy/audit', ownerOnly: true }, policyEditingAvailable: true };
}
module.exports = { profilesRequired: require('./role-profiles').required, families, roles, normalize, actor, effective, baseline, policyState, validatePolicySet, immutable, describe };
