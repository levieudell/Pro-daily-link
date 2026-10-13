'use strict';
const { canonicalHash } = require('./database/transactional-repository');
const registry = require('./capability-registry');
function authority(db, auth, revision, lifecycle, accountAccess) {
  const user = registry.actor(db, auth.user), effectiveCapabilities = registry.effective(db, user);
  const identity = { companyId: db.company.id, actorId: user.id, role: user.role, sessionBinding: lifecycle.sessionBinding({ ...auth, user }), revision, expiresAt: auth.session.expiresAt, locked: Boolean(accountAccess(db.company).locked), effectiveCapabilities, scheduleWorkflows: require('./schedule-workflow-access').eligible(db,user), features: {timeCards:db.company.features?.timeCards===true,templates:db.company.features?.templates===true} };
  identity.authority = canonicalHash({ companyId: identity.companyId, actorId: user.id, role: user.role, sessionBinding: identity.sessionBinding, memberId: user.memberId ?? null, projectIds: user.projectIds || [], assignedCrews: user.assignedCrews || [], permissions: user.permissions || {}, effectiveCapabilities, scheduleWorkflows: identity.scheduleWorkflows, features: db.company.features || {}, pricingAccess: db.company.pricingAccess || null, team: (db.team || []).map(row => ({ id: row.id, crew: row.crew, status: row.status, archivedAt: row.archivedAt })), projects: (db.projects || []).map(row => ({ id: row.id, archived: row.archived, archivedAt: row.archivedAt })), profiles: db.company.roleProfiles || null, ...Object.fromEntries(registry.families.map(([id, , , , module]) => [id, { policy: db.company[{ scheduling: 'schedulingRolePolicy', timeOff: 'timeOffRolePolicy', timeReview: 'timeReviewRolePolicy', timeWrite: 'timeWriteRolePolicy', daily: 'dailyRolePolicy', notes: 'notesRolePolicy' }[id]] || null, required: module.required(db) }])) });
  return identity;
}
module.exports = { authority };
