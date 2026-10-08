'use strict';

// Draft admission coverage, not a configurable authorization dictionary.
// A route is added only after its writes/effects and response path are audited.
function supportedRoute(method, pathname) {
  if (method === 'GET' && ['/api/auth/me', '/api/users', '/api/account-access'].includes(pathname)) return true;
  if (method === 'POST' && ['/api/auth/login', '/api/auth/logout'].includes(pathname)) return true;
  if (method === 'PATCH' && /^\/api\/users\/\d+$/.test(pathname)) return true;
  if (/^\/api\/projects\/\d+\/notes-todos(?:\/[^/]+)?$/.test(pathname)) return ['GET', 'POST', 'PATCH'].includes(method);
  if (/^\/api\/projects\/\d+\/assistant\/context$/.test(pathname)) return method === 'GET';
  if (/^\/api\/projects\/\d+\/assistant\/(preview|confirm)$/.test(pathname)) return method === 'POST';
  if (/^\/api\/time-off-requests\/[^/]+\/(review-preview|approve|decline)$/.test(pathname)) return method === 'POST';
  if (['/api/time-cards/action-preview', '/api/pay-periods/action-preview', '/api/time-cards/company-clock'].includes(pathname)) return method === 'POST';
  if (pathname === '/api/daily-actions/preview') return method === 'POST';
  if (pathname === '/api/reports') return ['GET', 'POST'].includes(method);
  if (/^\/api\/reports\/\d+$/.test(pathname)) return ['GET', 'PATCH'].includes(method);
  if (/^\/api\/reports\/\d+\/approve$/.test(pathname)) return method === 'PATCH';
  if (pathname === '/api/workdays' || /^\/api\/workdays\/\d+$/.test(pathname)) return method === 'GET';
  if (pathname === '/api/workdays/start' || /^\/api\/workdays\/\d+\/end$/.test(pathname)) return method === 'POST';
  if (pathname === '/api/reporting-exports') return ['GET', 'POST'].includes(method);
  if (/^\/api\/reporting-exports\/[0-9a-f-]{36}(?:\.csv)?$/.test(pathname)) return method === 'GET';
  if (pathname === '/api/time-cards') return ['GET', 'POST'].includes(method);
  if (/^\/api\/time-cards\/\d+$/.test(pathname)) return ['PATCH', 'DELETE'].includes(method);
  if (/^\/api\/time-cards\/\d+\/(submit|clock-out)$/.test(pathname)) return method === 'POST';
  if (['/api/time-cards.csv', '/api/report-labor-suggestions', '/api/company-activities'].includes(pathname)) return method === 'GET';
  if (pathname === '/api/pay-periods') return ['GET', 'POST'].includes(method);
  if (/^\/api\/pay-periods\/[0-9a-f-]{36}$/.test(pathname)) return method === 'PATCH';
  if (/^\/api\/pay-periods\/[0-9a-f-]{36}\/(summary|exports(?:\/[0-9a-f-]{36}(?:\.csv)?)?)$/.test(pathname)) return method === 'GET' || method === 'POST' && pathname.endsWith('/exports');
  if (['/api/time-cards/review-preview', '/api/time-cards/approve'].includes(pathname) || /^\/api\/time-cards\/\d+\/(approve|unapprove)$/.test(pathname)) return method === 'POST';
  if (pathname === '/api/time-off-requests') return ['GET', 'POST'].includes(method);
  if (pathname === '/api/schedule-availability') return method === 'GET';
  if (pathname === '/api/assignments') return ['GET', 'POST'].includes(method);
  if (/^\/api\/assignments\/\d+$/.test(pathname)) return ['PATCH', 'DELETE'].includes(method);
  if (/^\/api\/assignments\/\d+\/acknowledge$/.test(pathname)) return method === 'POST';
  return false;
}

module.exports = { supportedRoute };
