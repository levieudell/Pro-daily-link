'use strict';
// Exact additional G2 operations. Unsupported business writers remain fenced;
// none of these route identifiers can be supplied as a permission flag.
const read = new Set(['/api/state', '/api/workspace-identity', '/api/action-center', '/api/production', '/api/insights', '/api/exceptions', '/api/audit-log', '/api/catalog', '/api/company-activities', '/api/daily-templates', '/api/schedule-availability', '/api/time-cards', '/api/time-cards.csv', '/api/time-off-requests', '/api/pay-periods', '/api/reporting-exports', '/api/billing', '/api/assignments', '/api/reports', '/api/workdays', '/api/report-labor-suggestions']);
const post = new Set(['/api/assignments', '/api/time-off-requests', '/api/time-cards/action-preview', '/api/time-cards/review-preview', '/api/time-cards/approve', '/api/time-cards', '/api/time-cards/company-clock', '/api/pay-periods/action-preview', '/api/pay-periods', '/api/daily-actions/preview', '/api/reports', '/api/workdays/start', '/api/reporting-exports']);
function supported(method, path) {
  if(method==='GET'&&['/api/company/role-capabilities','/api/company/role-policy','/api/company/role-policy/audit','/api/company/role-policy/profiles'].includes(path))return true;
  if(method==='POST'&&['/api/company/role-policy/preview','/api/company/role-policy/profiles/preview','/api/company/role-policy/confirm'].includes(path))return true;
  if(method==='POST'&&path==='/api/workspace-direct-preview')return true;
  if(method==='POST'&&path==='/api/billing/recover')return true;
  if(method==='POST'&&path==='/api/ai/extract')return true;
  if(method==='GET'&&path==='/api/changes')return true;
  if(method==='GET'&&path==='/api/weather')return true;
  if(method==='GET'&&path==='/api/workspace-prepare')return true;
  if (method === 'GET') return read.has(path) || /^\/api\/(?:reports|workdays)\/[1-9]\d*$/.test(path) || /^\/api\/pay-periods\/[^/]+\/(?:summary|exports(?:\/[^/]+(?:\.csv)?)?)$/.test(path) || /^\/api\/reporting-exports\/[0-9a-f-]{36}(?:\.csv)?$/.test(path) || /^\/api\/projects\/[1-9]\d*\/(?:notes-todos|plans)$/.test(path);
  if (method === 'POST') return /^\/api\/assignments\/[1-9]\d*\/acknowledge$/.test(path) || post.has(path) || /^\/api\/time-off-requests\/[^/]+\/(?:review-preview|approve|decline)$/.test(path) || /^\/api\/time-cards\/[1-9]\d*\/(?:submit|approve|unapprove|clock-out)$/.test(path) || /^\/api\/workdays\/[1-9]\d*\/end$/.test(path) || /^\/api\/pay-periods\/[^/]+\/exports$/.test(path) || /^\/api\/projects\/[1-9]\d*\/notes-todos$/.test(path);
  if (method === 'PATCH') return /^\/api\/reports\/[1-9]\d*\/approve$/.test(path) || /^\/api\/(?:assignments|reports|time-cards)\/[1-9]\d*$/.test(path) || /^\/api\/pay-periods\/[^/]+$/.test(path) || /^\/api\/projects\/[1-9]\d*\/notes-todos\/[^/]+$/.test(path);
  if (method === 'DELETE') return /^\/api\/(?:assignments|time-cards)\/[1-9]\d*$/.test(path);
  return false;
}
module.exports = { read, post, supported };
