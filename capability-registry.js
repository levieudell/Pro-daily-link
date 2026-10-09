'use strict';
// Read-only authority assembly over the exact reviewed six typed controllers.
// Policy editing/activation and operation admission remain separate integrations.
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
module.exports = { families, roles, normalize, actor, effective };
