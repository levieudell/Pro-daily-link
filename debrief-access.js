(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PDLDebriefAccess = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const EDIT_GRANT = 'debrief_edit';
  const VIEW_GRANT = 'debrief_view';
  function role(user) { return user?.accessRole || user?.role || ''; }
  function grants(user) { return Array.isArray(user?.permissionGrants) ? user.permissionGrants.filter(item => typeof item === 'string') : []; }
  function grantFor(user) {
    const durableRole = role(user);
    if (durableRole === 'project_manager') return 'edit';
    if (durableRole === 'foreman') return 'view';
    return '';
  }
  function canViewDebrief(user) {
    const durableRole = role(user);
    if (['owner', 'admin', 'project_manager'].includes(durableRole)) return true;
    return durableRole === 'foreman' && grants(user).includes(VIEW_GRANT);
  }
  function canEditDebrief(user) {
    const durableRole = role(user);
    if (['owner', 'admin'].includes(durableRole)) return true;
    return durableRole === 'project_manager' && grants(user).includes(EDIT_GRANT);
  }
  function withDebriefGrants(user, updates = {}) {
    const grant = grantFor(user), current = grants(user), next = current.filter(item => item !== EDIT_GRANT && item !== VIEW_GRANT);
    if (grant === 'edit' && (Object.hasOwn(updates, grant) ? updates[grant] === true : current.includes(EDIT_GRANT))) next.push(EDIT_GRANT);
    if (grant === 'view' && (Object.hasOwn(updates, grant) ? updates[grant] === true : current.includes(VIEW_GRANT))) next.push(VIEW_GRANT);
    return next;
  }
  return { canViewDebrief, canEditDebrief, grants, role, grantFor, withDebriefGrants, EDIT_GRANT, VIEW_GRANT };
});
