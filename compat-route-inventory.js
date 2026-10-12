'use strict';
// Finite compatibility inventory, not editable permission flags.
const privateBoot = Object.freeze([
  ['action-center', 'G2/G4', 'daily/time aggregates, repairs, compliance delivery'],
  ['billing', 'G7', 'immutable financial status/provider refresh'],
  ['catalog', 'G3/G5', 'pricing and destination project scope'],
  ['company-activities', 'G3', 'activity metadata and protected writer'],
  ['daily-templates', 'G3/G4', 'template metadata and existing report fields'],
  ['health', 'G1/G7', 'normal mutation wake-up; public monitoring'],
  ['insights', 'G2/G4', 'scoped daily/time/financial aggregate'],
  ['pay-periods', 'G2/G9', 'immutable financial ceiling and saved history'],
  ['production', 'G2/G4', 'scoped approved daily/time aggregate'],
  ['reporting-exports', 'G2/G6/G9', 'owner exports and historical labels'],
  ['time-cards', 'G2/G4/G9', 'role/grant/member/project/crew scope'],
  ['time-off-requests', 'G2/G9', 'private own or review scope']
].map(([stem, gates, dependency]) => Object.freeze({ method: 'GET', path: '/api/' + stem, gates, dependency })));
function accountOperation(method, path) {
  if (method === 'POST' && path === '/api/users') return { action: 'createUser', targetId: null };
  if (method === 'POST' && path === '/api/team-with-account') return { action: 'createMemberAccount', targetId: null };
  const match = /^\/api\/users\/([1-9]\d*)(?:\/(reset-code|time-access|preferences))?$/.exec(path);
  if (!match || !Number.isSafeInteger(Number(match[1]))) return null;
  const action = !match[2] && method === 'PATCH' ? 'editUser' : match[2] === 'reset-code' && method === 'POST' ? 'resetCode' : match[2] === 'time-access' && method === 'PATCH' ? 'timeAccess' : match[2] === 'preferences' && method === 'PATCH' ? 'preferences' : null;
  return action ? { action, targetId: Number(match[1]) } : null;
}
const lifecycleRoutes = Object.freeze([
  ['POST', '/api/auth/claim'], ['POST', '/api/auth/email-verification/confirm'], ['POST', '/api/auth/email-verification/resend'],
  ['GET', '/api/users'], ['GET', '/api/account-identity'], ['GET', '/api/health'], ['POST', '/api/account-actions/preview'], ['POST', '/api/account-actions/confirm'], ['POST', '/api/account-actions/recover'], ['POST', '/api/account-actions/status'], ['POST', '/api/account-actions/reconcile']
].map(([method, path]) => Object.freeze({ method, path })));
function lifecycleRoute(method, path) { return lifecycleRoutes.some(row => row.method === method && row.path === path) || Boolean(accountOperation(method, path)); }
module.exports = { privateBoot, lifecycleRoutes, lifecycleRoute, accountOperation };
