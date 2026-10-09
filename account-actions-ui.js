'use strict';
// Existing account buttons enter a bounded server review. Browser storage holds
// only operation identity, never a password, input, bearer, or preview contents.
(function () {
  let current = null, busy = false, generation = 0, retire = null;
  const key = 'pdl-original-account-operation-v1', seenResults = new Set();
  const supported = (method, path) => method === 'POST' && ['/api/users', '/api/team-with-account'].includes(path) || /^\/api\/users\/[1-9]\d*$/.test(path) && method === 'PATCH' || /^\/api\/users\/[1-9]\d*\/reset-code$/.test(path) && method === 'POST' || /^\/api\/users\/[1-9]\d*\/time-access$/.test(path) && method === 'PATCH';
  function read() { try { const value = JSON.parse(sessionStorage.getItem(key)); return value && !seenResults.has(value.operationId) && Object.keys(value).sort().join(',') === 'companyId,operationId,sessionBinding' && /^[a-f0-9-]{36}$/.test(value.operationId) ? value : null; } catch { return null; } }
  function matches(row) { return row && current && row.companyId === current.companyId && row.sessionBinding === current.sessionBinding && (row.ownerId === undefined || row.ownerId === current.ownerId); }
  function assertCurrent(opening, openedAt) { if (openedAt !== generation || !matches(opening)) throw error('Account identity changed. Sign in again to check the original result.'); }
  async function checkIdentity(send, opening, openedAt) { assertCurrent(opening, openedAt); const me = await send('/api/account-identity', { redirectOnUnauthorized: false }); assertCurrent(opening, openedAt); if (me.role !== 'owner' || me.id !== opening.ownerId || me.companyId !== opening.companyId || me.accountSessionBinding !== opening.sessionBinding) { retireActions(); current = null; throw error('Account identity changed before result delivery.'); } }
  function retireActions() { generation++; retire?.(); document.getElementById('account-original-result-dialog')?.remove(); for (const id of ['setup-code-result', 'password-reset-result', 'team-member-result']) document.getElementById(id)?.replaceChildren(); }
  addEventListener('pagehide', retireActions);
  addEventListener('focus', retireActions);
  function error(message) { return new Error(message); }
  function showDialog() {
    const dialog = document.createElement('dialog'); dialog.id = 'account-review-dialog';
    dialog.innerHTML = '<form method="dialog"><h2>Review account change</h2><label>Reason for this change<textarea id="account-review-reason" minlength="8" maxlength="500" required></textarea></label><p id="account-review-message" role="status"></p><pre id="account-review-impact" hidden style="white-space:pre-wrap;max-height:45vh;overflow:auto"></pre><label id="account-review-check" hidden><input id="account-review-confirmed" type="checkbox"> I reviewed the changes and confirm this account action.</label><div><button id="account-review-cancel" type="button">Cancel</button><button id="account-review-preview" type="button">Preview change</button><button id="account-review-save" type="button" hidden>Confirm change</button></div></form>';
    document.body.append(dialog); dialog.showModal(); return dialog;
  }
  function describe(impact) {
    const label = value => value ? JSON.stringify(value, null, 2) : 'New account';
    return 'Before\n' + label(impact.before) + '\n\nAfter\n' + label(impact.after) + (impact.manualTemporaryPassword ? '\n\nA temporary password will be created after confirmation and expires in 72 hours.' : '') + '\n\nAccount access and the original result are checked again when saved.';
  }
  async function review(path, options, send) {
    if (busy) throw error('An account review is already open.');
    if (matches(read())) throw error('Check the original account result before starting another change.');
    busy = true; const opening = { ...current }, openedAt = generation, dialog = showDialog(), operationId = crypto.randomUUID(), method = String(options.method).toUpperCase();
    try {
      return await new Promise((resolve, reject) => {
        let preview = null, sending = false, settled = false;
        const finish = (failure, value) => { if (settled) return; settled = true; dialog.close(); failure ? reject(failure) : resolve(value); };
        retire = () => finish(error('Account review ended because the current identity needs checking.'));
        dialog.querySelector('#account-review-cancel').onclick = () => { if (!sending) finish(error('Account change cancelled.')); };
        dialog.addEventListener('cancel', event => { event.preventDefault(); if (!sending) finish(error('Account change cancelled.')); });
        dialog.querySelector('#account-review-preview').onclick = async () => {
          if (sending) return; const reason = dialog.querySelector('textarea').value.trim(); if (reason.length < 8) { dialog.querySelector('#account-review-message').textContent = 'Enter a reason of at least 8 characters.'; return; }
          sending = true;
          try {
            preview = await send('/api/account-actions/preview', { method: 'POST', body: JSON.stringify({ method, path, input: JSON.parse(options.body || '{}'), reason, operationId }) });
            await checkIdentity(send, opening, openedAt);
            dialog.querySelector('textarea').disabled = true; dialog.querySelector('#account-review-preview').hidden = true;
            const impact = dialog.querySelector('#account-review-impact'); impact.textContent = describe(preview.impact); impact.hidden = false;
            dialog.querySelector('#account-review-check').hidden = false; dialog.querySelector('#account-review-save').hidden = false;
          } catch (failure) { finish(failure); } finally { sending = false; }
        };
        dialog.querySelector('#account-review-save').onclick = async () => {
          if (sending || !preview) return;
          if (!dialog.querySelector('#account-review-confirmed').checked) { dialog.querySelector('#account-review-message').textContent = 'Check the confirmation box after reviewing the changes.'; return; }
          sending = true;
          // Save identity before the first confirmation; an interrupted or lost
          // response is checked by recovery, never automatically submitted again.
          try { assertCurrent(opening, openedAt); sessionStorage.setItem(key, JSON.stringify({ companyId: opening.companyId, sessionBinding: opening.sessionBinding, operationId })); const persisted = read(); if (!persisted || persisted.operationId !== operationId || !matches(persisted)) throw error('Recovery identity could not be saved.'); }
          catch { sending = false; finish(error('Original-result recovery is unavailable in this browser.')); return; }
          try { const result = await send('/api/account-actions/confirm', { method: 'POST', body: JSON.stringify({ previewId: preview.previewId, operationId, expectedRevision: preview.expectedRevision, confirmed: true }) }); await checkIdentity(send, opening, openedAt); seenResults.add(operationId); try { sessionStorage.removeItem(key); } catch {} finish(null, result); }
          catch (failure) { finish(error('The account result needs checking. ' + (failure.status ? failure.message + ' ' : '') + 'Check the original account result before making another change.')); }
          finally { sending = false; }
        };
      });
    } finally { dialog.remove(); retire = null; busy = false; refreshRecovery(send); }
  }
  function refreshRecovery(send) {
    document.getElementById('account-original-result')?.remove(); const row = read(); if (!matches(row)) return;
    const button = document.createElement('button'); button.id = 'account-original-result'; button.type = 'button'; button.textContent = 'Check original account result';
    button.onclick = async () => {
      const opening = { ...current }, openedAt = generation;
      button.disabled = true;
      try {
        const result = await send('/api/account-actions/recover', { method: 'POST', body: JSON.stringify({ operationId: row.operationId }) });
        await checkIdentity(send, opening, openedAt);
        const dialog = document.createElement('dialog'); dialog.id = 'account-original-result-dialog'; const text = document.createElement('pre'); text.textContent = JSON.stringify(result, null, 2); text.style.whiteSpace = 'pre-wrap';
        const close = document.createElement('button'); close.textContent = 'Close result'; close.onclick = () => { dialog.close(); dialog.remove(); seenResults.add(row.operationId); try { sessionStorage.removeItem(key); } catch {} button.remove(); };
        dialog.append(text, close); document.body.append(dialog); dialog.showModal();
      } catch (failure) {
        button.textContent = failure.message; button.disabled = false;
        if (failure.status === 409 && !document.getElementById('account-reconcile-result')) {
          const review = document.createElement('button'); review.id = 'account-reconcile-result'; review.type = 'button'; review.textContent = 'Review current accounts and reconcile original result'; button.after(review);
          review.onclick = async () => {
            review.disabled = true;
            try {
              const status = await send('/api/account-actions/status', { method: 'POST', body: JSON.stringify({ operationId: row.operationId }) }); await checkIdentity(send, opening, openedAt);
              const dialog = document.createElement('dialog'); dialog.id = 'account-original-result-dialog'; const text = document.createElement('pre'); text.textContent = JSON.stringify(status, null, 2); text.style.cssText = 'white-space:pre-wrap;max-height:50vh;overflow:auto';
              const reason = document.createElement('textarea'); reason.placeholder = 'Reason for reconciling this original result'; reason.maxLength = 500;
              const check = document.createElement('input'); check.type = 'checkbox'; const label = document.createElement('label'); label.append(check, ' I reviewed the current accounts and original outcome.');
              const confirm = document.createElement('button'); confirm.type = 'button'; confirm.textContent = 'Retain original history and close browser recovery';
              const close = document.createElement('button'); close.type = 'button'; close.textContent = 'Keep recovery open'; close.onclick = () => { dialog.close(); dialog.remove(); };
              confirm.onclick = async () => { if (!check.checked || reason.value.trim().length < 8) return; confirm.disabled = true; try { await checkIdentity(send, opening, openedAt); await send('/api/account-actions/reconcile', { method: 'POST', body: JSON.stringify({ operationId: row.operationId, expectedRevision: status.currentRevision, confirmed: true, reason: reason.value.trim() }) }); await checkIdentity(send, opening, openedAt); try { sessionStorage.removeItem(key); } catch {} dialog.close(); dialog.remove(); review.remove(); button.remove(); } catch (failure) { confirm.disabled = false; close.textContent = failure.message; } };
              dialog.append(text, reason, label, confirm, close); document.body.append(dialog); dialog.showModal();
            } catch (failure) { review.textContent = failure.message; } finally { review.disabled = false; }
          };
        }
      }
    };
    (document.getElementById('team-page') || document.body).prepend(button);
  }
  window.pdlAccountActions = {
    configure(config, user, send) { retireActions(); current = config?.compatibilityAccount?.lifecycle && user?.role === 'owner' && typeof user.accountSessionBinding === 'string' ? { companyId: user.companyId, ownerId: user.id, sessionBinding: user.accountSessionBinding } : null; refreshRecovery(send); },
    request(path, options, send) { return current && supported(String(options.method || 'GET').toUpperCase(), path) ? review(path, options, send) : send(path, options); }
  };
})();
