'use strict';
(function (root) {
  const routes = new Set(['projects', 'team', 'customers', 'schedule', 'notes', 'leave', 'cards', 'dailies', 'workdays', 'payroll', 'roles', 'role-profiles']);
  const aliases = { timecards: 'cards', 'time-cards': 'cards', timeoff: 'leave', 'time-off': 'leave', timeoverview: 'cards', myday: 'workdays', 'my-day': 'workdays' };
  function route(hash, role) {
    const requested = String(hash || '').replace(/^#/, '');
    return routes.has(requested) ? requested : Object.hasOwn(aliases, requested) ? aliases[requested] : (role === 'owner' ? 'roles' : 'projects');
  }
  function workspace(user, hash) {
    return '/workspace.html?tenant=' + encodeURIComponent(user.companyId) + '#' + route(hash, user.accessRole);
  }
  function login(companyId, hash) {
    return '/login.html' + (companyId ? '?tenant=' + encodeURIComponent(companyId) : '') + '#' + route(hash);
  }
  const api = { route, workspace, login };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.WorkspaceEntry = api;
})(typeof window === 'undefined' ? globalThis : window);
