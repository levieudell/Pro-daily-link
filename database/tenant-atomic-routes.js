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
  if (pathname === '/api/time-off-requests') return ['GET', 'POST'].includes(method);
  if (pathname === '/api/schedule-availability') return method === 'GET';
  if (pathname === '/api/assignments') return ['GET', 'POST'].includes(method);
  if (/^\/api\/assignments\/\d+$/.test(pathname)) return ['PATCH', 'DELETE'].includes(method);
  if (/^\/api\/assignments\/\d+\/acknowledge$/.test(pathname)) return method === 'POST';
  return false;
}

module.exports = { supportedRoute };
