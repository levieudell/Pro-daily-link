'use strict';
const { canonicalHash } = require('./database/transactional-repository');
const { stripPrivate, validateOrigin, expires } = require('./account-credential-delivery');
const { validateAccounts } = require('./account-evidence');
const { lifecycleRoute } = require('./compat-route-inventory');
const PUBLIC_CREDENTIALS = new Set(['/api/config', '/api/auth/company', '/api/auth/logout', '/api/auth/login', '/api/auth/forgot', '/api/auth/reset', '/api/auth/claim', '/api/auth/email-verification/confirm']);
const EXPLICIT_CREDENTIALS = new Set(['/api/auth/login', '/api/auth/forgot', '/api/auth/reset', '/api/auth/claim', '/api/auth/email-verification/confirm']);
const PATHS = new Set(['/api/config', '/api/auth/company', '/api/auth/login', '/api/auth/forgot', '/api/auth/reset', '/api/auth/me', '/api/auth/logout', '/api/state', '/api/account-access']);
const unavailable = () => Object.assign(Error('Compatibility source slice is unavailable.'), { statusCode: 503, code: 'PDL_COMPAT_SOURCE_ONLY' });
function assertSynthetic(options) {
  if (process.env.NODE_ENV !== 'test' || process.env.PDL_REQUIRE_AUTH !== '1' || process.env.PDL_COMPAT_ACCOUNT_SYNTHETIC !== '1' || options.synthetic !== true) throw unavailable();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(options.companyId)) throw unavailable();
  for (const value of [options.origin, options.globalOrigin]) { const url = new URL(validateOrigin(value)); if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw unavailable(); }
}
function createRuntime(options) {
  assertSynthetic(options);
  const { companyId, repository, credentials, lifecycle, workspace } = options, origin = validateOrigin(options.origin), globalOrigin = validateOrigin(options.globalOrigin);
  const clock = options.clock || Date.now;
  function selected(req, path) {
    const header = String(req.headers['x-pdl-company'] || ''), cookieCompany = String(req.headers.cookie || '').split(';').map(value => value.trim()).find(value => value.startsWith('pdl_company='))?.slice(12) || '';
    if (header && header !== companyId) return false;
    if (EXPLICIT_CREDENTIALS.has(path) && header !== companyId) return false;
    // Public reset/claim is explicitly bound by the tenant link/header and can
    // recover an account despite an unrelated ambient browser session/cookie.
    if (!PUBLIC_CREDENTIALS.has(path) && cookieCompany && cookieCompany !== companyId) return false;
    if (req.headers.origin && req.headers.origin !== origin) return false;
    return true;
  }
  function stage(context, db) {
    if (!context.compatAccount || context.closed || db.company?.id !== companyId) throw unavailable();
    context.db = db; context.candidate = structuredClone(db); context.dirty = true;
  }
  async function handle(req, res, url, hooks) {
    if (!PATHS.has(url.pathname) && !(lifecycle && lifecycleRoute(req.method, url.pathname)) && !(workspace && workspace.supported(req.method,url.pathname))) {
      // This install hook is a quarantined synthetic proof, never a normal
      // product mode. No private selected-tenant path may fall back to legacy.
      if (url.pathname.startsWith('/api/') && !['/api/signup', '/api/founder-offer', '/api/demo-requests'].includes(url.pathname)) throw Object.assign(unavailable(), { code: 'PDL_COMPAT_WRITER_UNCLOSED' });
      return false;
    }
    if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method)) await hooks.body(req);
    if (!selected(req, url.pathname)) { hooks.json(res, 404, { error: 'Company workspace not found' }); return true; }
    if (req.method === 'GET' && url.pathname === '/api/config') { hooks.json(res, 200, { authRequired: true, compatibilityAccount: { companyId, globalOrigin, ...(lifecycle ? { lifecycle: true } : {}), ...(workspace ? { workspace: true } : {}) }, productionReady: false }); return true; }
    if (!lifecycle && req.method === 'POST' && url.pathname === '/api/auth/company') { hooks.json(res, 200, { companyId }); return true; }
    const loaded = await repository.load(companyId);
    if (!loaded || !Number.isSafeInteger(loaded.revision) || loaded.revision < 0 || loaded.snapshot?.company?.id !== companyId || loaded.contentHash !== canonicalHash(loaded.snapshot)) throw unavailable();
    validateAccounts(loaded.snapshot);
    if(workspace)require('./compat-workspace-evidence').validateWorkspace(loaded.snapshot);
    const context = { compatAccount: true, compatWorkspace: Boolean(workspace), companyId, db: structuredClone(loaded.snapshot), transactionalRevision: loaded.revision, deferResponse: true, pending: [], effects: [], dirty: false, closed: false };
    await hooks.run(context, async () => {
      if (lifecycle && req.method === 'POST' && url.pathname === '/api/auth/company') {
        const input = await hooks.body(req); require('./account-lifecycle-plan').closed(input, ['email']);
        if (typeof input.email !== 'string' || input.email.length > 5000) return hooks.json(res, 400, { error: 'Enter a valid email address' });
        return hooks.json(res, 200, { companyId: context.db.users.some(user => user.status === 'Active' && user.email.trim().toLowerCase() === input.email.trim().toLowerCase()) ? companyId : null });
      }
      if (req.method === 'POST' && url.pathname === '/api/auth/login') {
        const input = await hooks.body(req);
        if (!input || Array.isArray(input) || Object.keys(input).some(name => !['email', 'password'].includes(name)) || typeof input.email !== 'string' || typeof input.password !== 'string') return hooks.json(res, 400, { error: 'Invalid sign-in request' });
        const matches = (context.db.users || []).filter(user => String(user.email || '').trim().toLowerCase() === input.email.trim().toLowerCase() && user.status === 'Active');
        if (matches.length !== 1 || matches[0].companyId && matches[0].companyId !== companyId) return hooks.json(res, 401, { error: 'Invalid email or password' });
      }
      if (!PUBLIC_CREDENTIALS.has(url.pathname) && url.pathname !== '/api/auth/logout' && !(lifecycle && url.pathname === '/api/health')) {
        const { auth, status } = hooks.authenticate(req, context.db);
        if (!auth || (context.db.users || []).filter(user => user.id === auth.user.id).length !== 1) return hooks.json(res, status === 404 ? 404 : 401, { error: 'Authentication required' });
        context.guard = { deadline: auth.session.expiresAt };
        if(workspace && hooks.accountAccess(context.db.company).status==='Trial') context.businessDeadline=context.db.company.trialEndsAt;
      }
      if (req.method === 'POST' && url.pathname === '/api/auth/forgot') {
        const input = await hooks.body(req);
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(name => name !== 'email') || typeof input.email !== 'string') return hooks.json(res, 400, { error: 'Enter an email address' });
        const queued = credentials.requestReset(context.db, input.email);
        if (queued) { stage(context, context.db); context.deliveryJob = queued.jobId; }
        return hooks.json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/auth/reset') {
        const input = await hooks.body(req);
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(name => !['email', 'token', 'password'].includes(name)) || !['email', 'token', 'password'].every(name => typeof input[name] === 'string')) return hooks.json(res, 400, { error: 'Invalid reset request' });
        const authorized = credentials.authorizeReset(context.db, input.email, input.token);
        if (!authorized) return hooks.json(res, 401, { error: 'This password reset link is invalid or expired' });
        if (input.password.length < 12) return hooks.json(res, 400, { error: 'Password must be at least 12 characters' });
        const credential = hooks.credentialHash(input.password), user = authorized.user;
        user.passwordHash = credential.hash; user.passwordSalt = credential.salt; user.mustSetPassword = false;
        credentials.consumeReset(context.db, user); context.guard = { deadline: authorized.deadline };
        if (lifecycle) { lifecycle.invalidateManual(context.db, user.id); for (const name of ['setupHash', 'setupSalt', 'setupExpiresAt', 'setupGeneration', 'setupIssuedEmail']) delete user[name]; }
        stage(context, context.db); return hooks.json(res, 200, { ok: true });
      }
      if (lifecycle && lifecycleRoute(req.method, url.pathname)) {
        if (!PUBLIC_CREDENTIALS.has(url.pathname) && url.pathname !== '/api/health' && hooks.accountAccess(context.db.company).locked) return hooks.json(res, 402, { error: 'Account access requires owner billing review' });
        if (!PUBLIC_CREDENTIALS.has(url.pathname) && url.pathname !== '/api/health' && hooks.accountAccess(context.db.company).status === 'Trial') context.businessDeadline = context.db.company.trialEndsAt;
        if (await lifecycle.handle(req, res, url, context, { ...hooks, stage })) return;
      }
      // Existing handlers/UI remain the implementation, not an alternate app.
      if (!lifecycle && url.pathname === '/api/state' && (context.db.projectTickets || []).some(ticket => ticket.deletedAt && !ticket.purgedAt && ticket.retainedUntil && (!Number.isFinite(Date.parse(ticket.retainedUntil)) || Date.parse(ticket.retainedUntil) <= Number(clock())))) {
        // Explicit source-slice stopping criterion: the legacy state handler's
        // precommit file deletion is not certified by account snapshot staging.
        throw Object.assign(unavailable(), { code: 'PDL_COMPAT_RETENTION_UNCLOSED' });
      }
      await hooks.api(req, res, url);
    });
    context.closed = true;
    if (!context.response) throw unavailable();
    if (context.response.status >= 400) context.dirty = false;
    if (context.dirty) {
      validateAccounts(context.candidate);
      if (context.businessDeadline) context.guard = { deadline: new Date(Math.min(Date.parse(context.guard?.deadline || context.businessDeadline), Date.parse(context.businessDeadline))).toISOString() };
      if (context.guard && !expires(context.guard.deadline, Number(clock()))) throw Object.assign(unavailable(), { statusCode: 409 });
      const result = await repository.commit(context.candidate, loaded.revision, context.guard);
      if (result?.revision !== loaded.revision + 1 || result.contentHash !== canonicalHash(context.candidate)) throw unavailable();
      res.setHeader('X-PDL-Tenant-Revision', String(result.revision));
      context.savedRevision = result.revision;
    }
    if(workspace && context.response.status < 400)await workspace.finalize(req,context,url);
    if (context.response.status < 400 && (!PUBLIC_CREDENTIALS.has(url.pathname) || url.pathname === '/api/auth/login') && !(lifecycle && url.pathname === '/api/health')) {
      const current = await repository.load(companyId);
      if (!current || current.revision !== (context.finalizedRevision ?? context.savedRevision ?? loaded.revision) || current.contentHash !== (context.finalizedContentHash ?? (context.dirty ? canonicalHash(context.candidate) : loaded.contentHash))) throw Object.assign(unavailable(), { statusCode: 409, code: 'PDL_COMPAT_RESPONSE_STALE' });
      validateAccounts(current.snapshot);
      const request = url.pathname === '/api/auth/login' ? { ...req, headers: { ...req.headers, cookie: '', authorization: 'Bearer ' + context.response.data.token } } : req;
      const { auth } = hooks.authenticate(request, current.snapshot);
      if (!auth || !expires(auth.session.expiresAt, Number(clock()))) throw Object.assign(unavailable(), { statusCode: 401, code: 'PDL_COMPAT_RESPONSE_EXPIRED' });
      if (!['/api/auth/me', '/api/auth/login', '/api/account-access', ...(workspace ? ['/api/billing','/api/billing/recover','/api/workspace-identity'] : [])].includes(url.pathname) && hooks.accountAccess(current.snapshot.company).locked) throw Object.assign(unavailable(), { statusCode: 402, code: 'PDL_COMPAT_RESPONSE_LOCKED' });
      if (url.pathname === '/api/account-access') context.response.data = hooks.accountAccess(current.snapshot.company);
      if (lifecycle && ['/api/auth/me', '/api/auth/login'].includes(url.pathname)) {
        context.response.data = { ...context.response.data, preferences: require('./account-evidence').publicPreferences(auth.user), ...Object.fromEntries(require('./capability-registry').families.map(([, , , field]) => [field, auth.user[field]])), accountSessionBinding: lifecycle.sessionBinding(auth) };
      }
      if (context.accountReturn) lifecycle.deliver(context, current.snapshot, auth);
      if(workspace){const identity=require('./compat-workspace-authority').authority(current.snapshot,auth,current.revision,lifecycle,hooks.accountAccess);res.setHeader('X-PDL-Workspace-Revision',String(identity.revision));res.setHeader('X-PDL-Workspace-Authority',identity.authority);if(context.workspaceReconciliationFrom)res.setHeader('X-PDL-Workspace-Reconciled-From',context.workspaceReconciliationFrom);if(url.pathname==='/api/workspace-identity')context.response.data=identity;}
    }
    // All responses, including generic state/user DTOs, omit private custody.
    if (!Object.hasOwn(context.response,'raw')) context.response.data = stripPrivate(context.response.data);
    if(Object.hasOwn(context.response,'raw')){res.writeHead(context.response.status,context.response.headers);res.end(context.response.raw)}else hooks.flush(res, context);
    // Only named postcommit effects; no generic provider payload dictionary.
    for (const effect of context.effects) await effect();
    if (context.deliveryJob && options.dispatchAfterCommit === true) await credentials.dispatch(companyId, context.deliveryJob);
    return true;
  }
  function publicEntry(req, res, url) {
    if (lifecycle && req.method === 'GET' && ['/login.html', '/forgot-password.html', '/reset-password.html', '/verify-email.html', '/app'].includes(url.pathname) && url.searchParams.has('tenant') && url.searchParams.get('tenant') !== companyId) {
      if (url.searchParams.getAll('tenant').length !== 1 || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(url.searchParams.get('tenant')) || url.searchParams.getAll('token').length > 1) throw unavailable();
      const destination = new URL(url.pathname, globalOrigin); for (const [name, value] of url.searchParams) { if (!['tenant', 'token'].includes(name)) throw unavailable(); destination.searchParams.set(name, value); }
      res.writeHead(302, { Location: destination.href, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }); res.end(); return true;
    }
    if (req.method !== 'GET' || url.pathname !== '/signup.html') return false;
    // Normal signup page is hosted by the existing global legacy service.
    res.writeHead(302, { Location: new URL('/signup.html', globalOrigin).href, 'Cache-Control': 'no-store' }); res.end(); return true;
  }
  return { handle, stage, publicEntry, companyId, origin, globalOrigin, sourceOnly: true, lifecycle, workspace, actor: lifecycle?.actor };
}
module.exports = { createRuntime, assertSynthetic, PATHS };
