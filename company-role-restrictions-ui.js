'use strict';
(() => {
  const route = '/api/company/role-restrictions';
  const host = $('#role-restrictions-content'), status = $('#role-restrictions-status');
  if (!host || !status) return;
  let loaded = null, preview = null, sequence = 0, identity = '', busy = false;
  const context = () => JSON.stringify([signedInCompanyId(), currentUser?.id, currentUser?.role, currentRole]);
  const allowed = () => currentRole === 'office' && ['owner', 'admin'].includes(currentUser?.role);
  const editing = () => allowed() && currentUser?.role === 'owner' && loaded?.canEdit === true && loaded?.valid === true;
  function clear() { sequence++; loaded = null; preview = null; busy = false; host.innerHTML = ''; status.textContent = ''; }
  function guard() { const next = context(); if (identity !== next) { clear(); identity = next; } if (!allowed()) clear(); return allowed(); }
  function message(text, error = false) { status.textContent = text; status.setAttribute('role', error ? 'alert' : 'status'); }
  function impactMarkup(users) {
    const changed = users.filter(user => user.changes.length);
    return changed.length ? `<ul>${changed.map(user => `<li><strong>${escapeHtml(user.name)}</strong>: ${user.changes.map(key => `${escapeHtml(loaded.capabilities.find(cap => cap.key === key)?.label || key)} ${user.after[key] ? 'restored to existing grant' : 'blocked'}`).join('; ')}</li>`).join('')}</ul>` : '<p>No active user’s effective access changes. This cap also applies to future Project Managers.</p>';
  }
  function render() {
    if (!guard() || !loaded) return;
    const editable = editing();
    host.innerHTML = `<p>${editable ? 'The Account Owner can restrict existing Project Manager permissions for this company.' : 'Review only. The Account Owner manages these restrictions.'} “Follow user grants” keeps each person’s existing permissions. It does not grant access.</p>
      <p>Projects and crews remain limited to each person’s assignments. Pricing visibility is managed separately.</p>
      <div class="role-policy-matrix"><table><caption>Role customization available in this phase</caption><thead><tr><th scope="col">Role</th><th scope="col">Available controls</th></tr></thead><tbody>
      <tr><th scope="row">Account Owner</th><td>Protected. Company ownership, security and user administration stay fixed.</td></tr>
      <tr><th scope="row">Admin</th><td>Fixed role access; existing individual time management grant stays unchanged.</td></tr>
      <tr><th scope="row">Project Manager</th><td>Restriction controls below. Existing user grants and assigned projects / crews still apply.</td></tr>
      <tr><th scope="row">Foreman</th><td>Fixed crew access. Role customization requires further server route work.</td></tr>
      <tr><th scope="row">Field / crew</th><td>Fixed assigned work and own time access. Office assistant access stays unavailable.</td></tr>
      </tbody></table></div>
      <form id="role-restrictions-form"><fieldset ${editable ? '' : 'disabled'}><legend>Project Manager restrictions · revision ${loaded.revision ?? 'invalid'}</legend>
      ${loaded.capabilities.map(cap => `<label>${escapeHtml(cap.label)}<select data-role-cap="${escapeHtml(cap.key)}"><option value="follow" ${loaded.projectManager[cap.key] ? 'selected' : ''}>Follow user grants</option><option value="block" ${loaded.projectManager[cap.key] ? '' : 'selected'}>Block for this role</option></select></label>`).join('')}
      <label>Reason for changing restrictions<textarea id="role-restrictions-reason" maxlength="500" required></textarea></label><button type="submit" class="primary" ${editable ? '' : 'disabled'}>Preview changes</button></fieldset></form>
      <div id="role-restrictions-preview" hidden></div>
      <h3>Restriction history</h3>${loaded.history.length ? `<ul>${loaded.history.map(row => `<li><strong>${escapeHtml(row.actor)}</strong> · ${escapeHtml(row.at)}<p>${escapeHtml(row.detail)}</p></li>`).join('')}</ul>` : '<p>No role restrictions have been saved.</p>'}`;
    $('#role-restrictions-form').addEventListener('submit', event => { event.preventDefault(); previewChanges(); });
    $('#role-restrictions-form').addEventListener('input', () => { sequence++; busy = false; preview = null; $('#role-restrictions-preview').hidden = true; message('Preview again after changing a selection or reason.'); });
  }
  async function refresh() {
    if (!guard()) return;
    const ticket = ++sequence, original = context(); loaded = null; preview = null; busy = false; host.innerHTML = ''; message('Loading role restrictions…');
    try {
      const result = await api(route);
      if (ticket !== sequence || context() !== original || !guard()) return;
      loaded = result; render(); message(result.valid ? '' : 'Stored restrictions need repair. Project Manager capabilities are blocked; editing is unavailable.', !result.valid);
    } catch (error) { if (ticket === sequence && context() === original) { host.innerHTML = ''; message(error.message, true); } }
  }
  async function previewChanges() {
    if (!guard() || !editing() || busy) return;
    const projectManager = Object.fromEntries($$('[data-role-cap]').map(input => [input.dataset.roleCap, input.value === 'follow']));
    const reason = $('#role-restrictions-reason').value.trim();
    if (!reason) { message('Enter a reason before previewing.', true); return; }
    const ticket = ++sequence, original = context(); busy = true; preview = null;
    try {
      const result = await api(route + '/preview', { method: 'POST', body: JSON.stringify({ revision: loaded.revision, projectManager, reason }) });
      if (ticket !== sequence || context() !== original || !guard()) return;
      preview = result;
      const panel = $('#role-restrictions-preview'); panel.hidden = false;
      panel.innerHTML = `<h3>Review before saving</h3><p>${escapeHtml(result.reason)}</p>${impactMarkup(result.users)}<p>New requests use the confirmed restrictions. Work already committed remains recorded.</p><label><input type="checkbox" id="role-restrictions-confirm"> I reviewed the affected users and confirm this change.</label><button type="button" class="primary" id="role-restrictions-save" disabled>Confirm and save restrictions</button>`;
      $('#role-restrictions-confirm').addEventListener('change', () => { $('#role-restrictions-save').disabled = !$('#role-restrictions-confirm').checked; });
      $('#role-restrictions-save').addEventListener('click', save);
      message('Preview ready. Confirm only after reviewing the affected users.');
    } catch (error) { if (ticket === sequence && context() === original) message(error.message, true); }
    finally { if (ticket === sequence) busy = false; }
  }
  async function save() {
    if (!guard() || !editing() || busy || !preview || !$('#role-restrictions-confirm')?.checked) return;
    const ticket = ++sequence, original = context(), value = preview; busy = true;
    $('#role-restrictions-save').disabled = true;
    try {
      await api(route, { method: 'PUT', body: JSON.stringify({ revision: value.revision, projectManager: value.projectManager, reason: value.reason, previewToken: value.previewToken, expiresAt: value.expiresAt, confirm: true }) });
      if (ticket !== sequence || context() !== original || !guard()) return;
      await refresh(); message('Role restrictions saved. The activity trail records the reason and affected users.');
    } catch (error) {
      if (ticket === sequence && context() === original) { preview = null; $('#role-restrictions-preview').hidden = true; message(error.message + ' Refresh and preview again.', true); }
    } finally { if (ticket === sequence) busy = false; }
  }
  window.PDLRoleRestrictions = { refresh };
  const previousRender = renderEverything;
  renderEverything = function () { const result = previousRender(); guard(); return result; };
  // Refresh effective grants and scoped workspace on return to an old tab.
  // A stale button never grants access; every server request uses current stored caps.
  window.addEventListener('focus', () => { if (currentUser?.role === 'project_manager') loadRole(currentRole); if (allowed() && !$('#company-role-restrictions').hidden) refresh(); });
})();
