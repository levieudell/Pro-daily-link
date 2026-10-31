(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PDLPermissions = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  // permissionGrants is the role-ready set. The existing permissions object
  // stays the time and safety flags. 'payroll' is the only key used today.
  const FIELD_ROLES = new Set(['field', 'foreman']);
  let exportDenied = false;
  function grants(user) {
    return Array.isArray(user?.permissionGrants) ? user.permissionGrants.filter(item => typeof item === 'string') : [];
  }
  function can(user, permission) {
    if (!user || typeof permission !== 'string' || !permission) return false;
    if (FIELD_ROLES.has(user.role)) return false;
    if (user.role === 'owner') return true;
    return grants(user).includes(permission);
  }
  function withPayrollGrant(user, granted) {
    const next = grants(user).filter(item => item !== 'payroll');
    if (granted) next.push('payroll');
    return next;
  }
  function migratePermissionGrants(db) {
    let changed = false;
    for (const user of db?.users || []) {
      if (!Array.isArray(user.permissionGrants)) {
        user.permissionGrants = [];
        changed = true;
      }
    }
    return changed;
  }
  function payrollPageAllowed() {
    const role = typeof currentRole === 'undefined' ? '' : currentRole;
    const user = typeof currentUser === 'undefined' ? null : currentUser;
    const record = typeof company === 'undefined' ? null : company;
    if (exportDenied || role !== 'office' || record?.features?.timeCards !== true) return false;
    return can(user, 'payroll');
  }
  function refreshCurrentUser(user) {
    if (typeof currentUser === 'undefined' || !currentUser) return;
    const sameUser = user && String(user.id) === String(currentUser.id);
    currentUser.permissionGrants = sameUser ? grants(user) : [];
    exportDenied = !sameUser;
  }
  function denyExport() { exportDenied = true; }
  return { can, grants, withPayrollGrant, migratePermissionGrants, payrollPageAllowed, refreshCurrentUser, denyExport };
});
