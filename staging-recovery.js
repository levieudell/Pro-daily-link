const MESSAGE = 'Password recovery is disabled on this staging demo. No reset email is sent and no password is changed. Contact the staging administrator for access.';
const API_ROUTES = new Set(['/api/auth/forgot', '/api/auth/reset', '/api/platform/auth/forgot', '/api/platform/auth/reset']);
const PAGES = new Set(['/forgot-password.html', '/reset-password.html', '/platform-forgot-password.html', '/platform-reset-password.html']);

// Run before body parsing, tenant resolution, or any database reads/repairs.
function blockStagingRecovery(req, res, url, json) {
  if (process.env.PDL_STAGING !== '1') return false;
  if (API_ROUTES.has(url.pathname)) {
    res.setHeader('Cache-Control', 'no-store');
    json(res, 403, { error: MESSAGE, code: 'STAGING_RECOVERY_DISABLED' });
    return true;
  }
  if (PAGES.has(url.pathname)) {
    const login = url.pathname.startsWith('/platform-') ? '/platform-login.html' : '/login.html';
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Staging password recovery</title><link rel="stylesheet" href="/login.css"></head><body><main class="auth-shell"><section class="auth-card"><h1>Staging password recovery</h1><p role="status">${MESSAGE}</p><a href="${login}">Back to sign in</a></section></main></body></html>`);
    return true;
  }
  return false;
}

module.exports = { blockStagingRecovery, MESSAGE };
