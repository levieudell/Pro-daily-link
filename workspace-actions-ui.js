'use strict';
(function () {
  let enabled = false, rolePolicies = false, actor = null, epoch = 0, retire = null, loading = 0, loadRevision = null, loadSequence = 0, configured = false, expected = null, displayedRevision = null, loadTail = Promise.resolve();
  const failure = message => Object.assign(Error(message), { status: 409, code: 'PDL_WORKSPACE_STALE' });
  function clear() { epoch++; actor = null; displayedRevision = null; window.PDLCompanyRoles?.retire(); retire?.(); document.querySelectorAll('[data-workspace-dialog]').forEach(node => node.remove()); }
  function headers() { const companyId = localStorage.getItem('pdl-company-id'); return companyId ? { 'X-PDL-Company': companyId } : {}; }
  async function identity({billingTransition=false,reconciliationFrom=null}={}) {
    const opening = epoch, company = localStorage.getItem('pdl-company-id'), binding = expected;
    const response = await fetch('/api/workspace-identity', { credentials: 'include', cache: 'no-store', headers: headers() });
    if (opening !== epoch || company !== localStorage.getItem('pdl-company-id')) throw failure('Workspace changed while checking access.');
    if (!response.ok) { clear(); throw Object.assign(Error('Current workspace access could not be verified.'), { status: response.status }); }
    const current = await response.json();
    if (opening !== epoch || binding !== expected || company !== localStorage.getItem('pdl-company-id')) throw failure('Workspace changed while checking access.');
    if (!current || !Number.isSafeInteger(current.actorId) || current.actorId < 1 || !Number.isSafeInteger(current.revision) || current.revision < 0 || !['owner','admin','project_manager','foreman','field'].includes(current.role) || !/^[a-f0-9]{64}$/.test(current.authority) || !/^[a-f0-9]{64}$/.test(current.sessionBinding) || !Number.isFinite(Date.parse(current.expiresAt)) || Date.parse(current.expiresAt) <= Date.now() || current.companyId !== company || binding && Object.entries(binding).some(([key,value]) => value !== undefined && value !== null && current[key] !== value)) { clear(); throw failure('Sign in again to verify current workspace access.'); }
    if (actor && ['companyId', 'actorId', 'role', 'sessionBinding', ...(reconciliationFrom===actor.authority?[]:['authority']), ...(!billingTransition||actor.role!=='owner'?['locked']:[])].some(key => actor[key] !== current[key])) { clear(); throw failure('Your workspace access changed. Refresh current records.'); }
    actor = current; return current;
  }
  function capture() { return enabled ? { epoch, generation: loading } : null; }
  async function verifyResponse(response, path, binding) {
    const revision = response.headers.get('X-PDL-Workspace-Revision'), authority = response.headers.get('X-PDL-Workspace-Authority');
    if (!enabled && revision === null) return;
    if (!configured || !enabled) throw failure('Authenticated workspace configuration is required before loading records.');
    if (binding && (binding.epoch !== epoch || binding.generation && (binding.generation !== loading || binding.generation !== loadSequence))) throw failure('Workspace response belongs to an earlier load. Refresh current records.');
    if(!response.ok && path.startsWith('/api/') && [401,402,403,409].includes(response.status)){clear();throw Object.assign(Error('Workspace access changed. Refresh current records.'),{status:response.status});}
    if (path === '/api/workspace-identity' || !response.ok || !path.startsWith('/api/') || ['/api/config', '/api/auth/company', '/api/auth/logout', '/api/auth/forgot', '/api/auth/reset', '/api/auth/claim'].includes(path)) return;
    const policyFrom=path==='/api/company/role-policy/confirm'&&actor?.role==='owner'?response.headers.get('X-PDL-Workspace-Policy-From'):null;
    const opening = epoch, current = await identity({billingTransition:path==='/api/billing'||path==='/api/billing/recover',reconciliationFrom:policyFrom||(['/api/state','/api/action-center','/api/exceptions'].includes(path)?response.headers.get('X-PDL-Workspace-Reconciled-From'):null)});
    if (binding && (binding.epoch !== epoch || binding.generation && (binding.generation !== loading || binding.generation !== loadSequence))) throw failure('Workspace response belongs to an earlier load. Refresh current records.');
    if(loading && path==='/api/state')loadRevision=current.revision;
    else if(loadRevision!==null && loading && current.revision!==loadRevision){clear();throw failure('Workspace records changed during loading. Refresh current records.');}
    if (opening !== epoch || revision === null || Number(revision) !== current.revision || authority !== current.authority || current.locked && !['/api/billing', '/api/billing/recover', '/api/account-access', '/api/auth/me', '/api/auth/login'].includes(path)) { clear(); throw failure('Workspace changed while loading. Refresh current records.'); }
  }
  function configure(config, me, onRetire) { epoch++; displayedRevision = null; if (configured && enabled) retire?.(); configured = true; enabled = config?.compatibilityAccount?.workspace === true;rolePolicies=enabled&&config?.compatibilityAccount?.rolePolicies===true; retire = onRetire; actor = null; expected = enabled ? { companyId: config.compatibilityAccount.companyId, actorId: me?.id, role: (me?.accessRole || me?.role) === 'office' ? 'admin' : (me?.accessRole || me?.role), sessionBinding: me?.accountSessionBinding } : null; if (!enabled) return; window.pdlWorkspaceSave?.draw(); }
  window.addEventListener('focus', () => { if (enabled) identity().catch(() => {}); });
  function load(run) {
    if (!enabled) return run();
    const generation = ++loadSequence, opening = epoch;
    const result = loadTail.catch(() => {}).then(() => runLoad(run, generation, opening));
    loadTail = result; return result;
  }
  async function runLoad(run, generation, opening) {
    const current = () => generation === loadSequence && opening === epoch;
    if (!current()) throw failure('Workspace changed before loading. Refresh current records.');
    loading = generation; displayedRevision = null; loadRevision = null;
    const root = document.getElementById('main-content') || document.querySelector('main');
    if (root) root.style.visibility = 'hidden';
    try {
      await identity();
      if (!current()) throw failure('Workspace changed while checking access. Refresh current records.');
      if (typeof workspaceApi !== 'function') throw failure('Workspace preparation is unavailable.');
      await workspaceApi('/api/workspace-prepare');
      if (!current()) throw failure('Workspace changed while preparing. Refresh current records.');
      const value = await run(), final = await identity();
      if (loadRevision !== null && final.revision !== loadRevision) throw failure('Workspace records changed during loading. Refresh current records.');
      if (!current()) throw failure('Workspace changed during loading. Refresh current records.');
      displayedRevision = final.revision; return value;
    } catch (error) {
      if (generation === loading && current()) clear();
      throw error;
    } finally {
      if (generation === loading) { loading = 0; loadRevision = null; if (root && generation === loadSequence) root.style.visibility = ''; }
    }
  }
  window.pdlWorkspaceActions = { configure, capture, verifyResponse, load, identity, clear, displayedRevision: () => displayedRevision, rolePolicies: () => rolePolicies, enabled: () => enabled };
})();
