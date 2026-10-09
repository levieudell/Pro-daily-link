'use strict';
(function () {
  let enabled = false, actor = null, epoch = 0, retire = null, loading = 0, loadRevision = null, loadSequence = 0, configured = false, expected = null, displayedRevision = null;
  const failure = message => Object.assign(Error(message), { status: 409, code: 'PDL_WORKSPACE_STALE' });
  function clear() { epoch++; actor = null; displayedRevision = null; retire?.(); document.querySelectorAll('[data-workspace-dialog]').forEach(node => node.remove()); }
  function headers() { const companyId = localStorage.getItem('pdl-company-id'); return companyId ? { 'X-PDL-Company': companyId } : {}; }
  async function identity() {
    const opening = epoch, company = localStorage.getItem('pdl-company-id'), binding = expected;
    const response = await fetch('/api/workspace-identity', { credentials: 'include', cache: 'no-store', headers: headers() });
    if (opening !== epoch || company !== localStorage.getItem('pdl-company-id')) throw failure('Workspace changed while checking access.');
    if (!response.ok) { clear(); throw Object.assign(Error('Current workspace access could not be verified.'), { status: response.status }); }
    const current = await response.json();
    if (opening !== epoch || binding !== expected || company !== localStorage.getItem('pdl-company-id')) throw failure('Workspace changed while checking access.');
    if (!current || !Number.isSafeInteger(current.actorId) || current.actorId < 1 || !Number.isSafeInteger(current.revision) || current.revision < 0 || !['owner','admin','project_manager','foreman','field'].includes(current.role) || !/^[a-f0-9]{64}$/.test(current.authority) || !/^[a-f0-9]{64}$/.test(current.sessionBinding) || !Number.isFinite(Date.parse(current.expiresAt)) || Date.parse(current.expiresAt) <= Date.now() || current.companyId !== company || binding && Object.entries(binding).some(([key,value]) => value !== undefined && value !== null && current[key] !== value)) { clear(); throw failure('Sign in again to verify current workspace access.'); }
    if (actor && ['companyId', 'actorId', 'role', 'sessionBinding', 'authority', 'locked'].some(key => actor[key] !== current[key])) { clear(); throw failure('Your workspace access changed. Refresh current records.'); }
    actor = current; return current;
  }
  async function verifyResponse(response, path) {
    const revision = response.headers.get('X-PDL-Workspace-Revision'), authority = response.headers.get('X-PDL-Workspace-Authority');
    if (!enabled && revision === null) return;
    if(!response.ok && path.startsWith('/api/') && [401,402,403,409].includes(response.status)){clear();throw Object.assign(Error('Workspace access changed. Refresh current records.'),{status:response.status});}
    if (path === '/api/workspace-identity' || !response.ok || !path.startsWith('/api/') || ['/api/config', '/api/auth/company', '/api/auth/logout', '/api/auth/forgot', '/api/auth/reset', '/api/auth/claim'].includes(path)) return;
    enabled = true;
    const opening = epoch, current = await identity();
    if(loading && path==='/api/state')loadRevision=current.revision;
    else if(loadRevision!==null && loading && current.revision!==loadRevision){clear();throw failure('Workspace records changed during loading. Refresh current records.');}
    if (opening !== epoch || revision === null || Number(revision) !== current.revision || authority !== current.authority || current.locked && !['/api/billing', '/api/account-access', '/api/auth/me', '/api/auth/login'].includes(path)) { clear(); throw failure('Workspace changed while loading. Refresh current records.'); }
  }
  function configure(config, me, onRetire) { epoch++; displayedRevision = null; if (configured && enabled) retire?.(); configured = true; enabled = config?.compatibilityAccount?.workspace === true; retire = onRetire; actor = null; expected = enabled ? { companyId: config.compatibilityAccount.companyId, actorId: me?.id, role: (me?.accessRole || me?.role) === 'office' ? 'admin' : (me?.accessRole || me?.role), sessionBinding: me?.accountSessionBinding } : null; if (!enabled) return; window.pdlWorkspaceSave?.draw(); }
  window.addEventListener('focus', () => { if (enabled) identity().catch(() => {}); });
  async function load(run) { if (!enabled) return run(); const generation = ++loadSequence; loading = generation; displayedRevision = null; const opening = epoch; loadRevision=null; await identity(); if(typeof workspaceApi!=='function')throw failure('Workspace preparation is unavailable.');await workspaceApi('/api/workspace-prepare'); const root = document.getElementById('main-content') || document.querySelector('main'); if (root) root.style.visibility = 'hidden'; try { const value = await run(); const final=await identity();if(loadRevision!==null&&final.revision!==loadRevision)throw failure('Workspace records changed during loading. Refresh current records.'); if (generation !== loading || opening !== epoch) throw failure('Workspace changed during loading. Refresh current records.'); displayedRevision = final.revision; return value; } catch (error) { if (opening === epoch) clear(); throw error; } finally { if (generation === loading){loading=0;loadRevision=null;if(root) root.style.visibility = '';} } }
  window.pdlWorkspaceActions = { configure, verifyResponse, load, identity, clear, displayedRevision: () => displayedRevision, enabled: () => enabled };
})();
