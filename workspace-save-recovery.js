'use strict';
(function () {
  const key = 'pdl-workspace-original-save-v1';
  const known = new Set();
  const allowed = (method, path) => method === 'POST' && ['/api/time-cards','/api/time-cards/approve','/api/time-cards/company-clock','/api/pay-periods','/api/reports','/api/workdays/start','/api/reporting-exports'].includes(path) || method === 'POST' && /^\/api\/(?:time-cards\/\d+\/(?:submit|approve|unapprove|clock-out)|time-off-requests\/[^/]+\/(?:approve|decline)|workdays\/\d+\/end|pay-periods\/[a-f0-9-]{36}\/exports)$/.test(path) || method === 'PATCH' && /^\/api\/(?:time-cards\/\d+|reports\/\d+(?:\/approve)?|pay-periods\/[a-f0-9-]{36})$/.test(path) || method === 'DELETE' && /^\/api\/time-cards\/\d+$/.test(path);
  function read() { try { const row = JSON.parse(sessionStorage.getItem(key)); return row && !known.has(row.requestId) && Object.keys(row).sort().join(',') === 'actorId,authority,companyId,method,path,requestId,sessionBinding,token,version' && allowed(row.method, row.path) && /^[a-zA-Z0-9_-]{8,128}$/.test(row.requestId) && typeof row.token === 'string' && row.token.length <= 20000 && /^[a-f0-9]{64}$/.test(row.version) ? row : null; } catch { return null; } }
  function remember(identity, method, path, proof) {
    if (!allowed(method, path)) throw Error('This save does not support original-result recovery.');
    const row = { companyId: identity.companyId, actorId: identity.actorId, sessionBinding: identity.sessionBinding, authority: identity.authority, method, path, token: proof.token, version: proof.version, requestId: proof.requestId };
    sessionStorage.setItem(key, JSON.stringify(row)); const current = read(); if (!current || current.requestId !== row.requestId) throw Error('Original save identity could not be retained.'); draw();
  }
  function finish(requestId) { const row = read(); known.add(requestId); try { if (row?.requestId === requestId) sessionStorage.removeItem(key); } catch { if(typeof notify==='function')notify('Saved. The browser could not remove the original-result marker; a reload may offer another result check.'); } draw(); }
  function draw() {
    if (!window.pdlWorkspaceActions?.enabled()) return;
    document.getElementById('workspace-original-save')?.remove(); const row = read(); if (!row) return;
    const box = document.createElement('section'); box.id = 'workspace-original-save'; box.className = 'email-verification-banner'; box.innerHTML = '<div><strong>A previous save has an unknown result.</strong><p>Check the original result before making another change.</p><p role="status"></p></div><button type="button" class="secondary">Check original result</button>';
    box.querySelector('button').onclick = async () => { const button = box.querySelector('button'); button.disabled = true; try { const identity = await window.pdlWorkspaceActions.identity(); if (['companyId','actorId','sessionBinding','authority'].some(key => row[key] !== identity[key])) { showReconciliation(box, row, identity); return; } const result = await workspaceApi(row.path, { method: row.method, body: JSON.stringify({ token: row.token, version: row.version, confirmed: true, requestId: row.requestId }), redirectOnUnauthorized: false, onAcknowledged: () => finish(row.requestId) }); if (typeof loadRole === 'function') await loadRole(currentRole); return result; } catch (error) { box.querySelector('[role=status]').textContent = error.message; if(error.status===409&&!error.saved)try{showReconciliation(box,row,await window.pdlWorkspaceActions.identity());}catch{} } finally { button.disabled = false; } };
    (document.getElementById('app-main') || document.body).prepend(box);
  }
  function showReconciliation(box, row, identity) {
    if (box.querySelector('[data-reconcile]')) return;
    box.querySelector('[role=status]').textContent = 'The originating account, session or permissions changed. The original outcome remains unknown. Review current records with an authorized account; submitting a new change could duplicate that save.';
    const section = document.createElement('div'); section.dataset.reconcile = 'true'; let reviewedRevision = null;
    section.innerHTML = '<label><input type="checkbox"> I reviewed current records and understand the original result remains unknown.</label><button type="button" class="secondary">Retire this browser result marker</button>';
    section.querySelector('input').onchange = () => { reviewedRevision = window.pdlWorkspaceActions.displayedRevision(); if(reviewedRevision===null){section.querySelector('input').checked=false;box.querySelector('[role=status]').textContent='Refresh and review the current workspace records before retiring this result marker.';} };
    section.querySelector('button').onclick = async () => {
      if (!section.querySelector('input').checked) { box.querySelector('[role=status]').textContent = 'Review current records and acknowledge the unknown outcome first.'; return; }
      const current = await window.pdlWorkspaceActions.identity();
      if (reviewedRevision===null || current.revision!==reviewedRevision || window.pdlWorkspaceActions.displayedRevision()!==reviewedRevision || ['companyId','actorId','sessionBinding','authority'].some(key => identity[key] !== current[key])) { box.querySelector('[role=status]').textContent = 'The current workspace changed. Load and review current records again.'; return; }
      // Retiring only this browser marker does not clear the server receipt,
      // declare success, resend the old action, or transfer old authority.
      const historyKey = key + '-retired', previous = JSON.parse(sessionStorage.getItem(historyKey) || '[]');
      if (!Array.isArray(previous)) throw Error('Browser result history needs reconciliation.');
      sessionStorage.setItem(historyKey, JSON.stringify([...previous.slice(-9), { companyId: row.companyId, actorId: row.actorId, requestId: row.requestId, method: row.method, path: row.path, result: 'unknown', retiredAt: new Date().toISOString() }]));
      finish(row.requestId);
    };
    box.append(section);
  }
  window.addEventListener('focus', draw); window.addEventListener('hashchange', draw); document.addEventListener('DOMContentLoaded', draw);
  window.pdlWorkspaceSave = { read, remember, finish, draw };
})();
