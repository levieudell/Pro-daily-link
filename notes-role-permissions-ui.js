'use strict';
(() => {
  const host = $('#notes-role-permissions-content'), status = $('#notes-role-permissions-status'); if (!host || !status) return;
  const route = '/api/company/notes-role-permissions', actions = ['view', 'create', 'edit', 'complete'];
  const labels = { admin: 'Office / Admin', project_manager: 'Project Manager', foreman: 'Foreman', field: 'Field team' };
  let loaded = null, draft = null, preview = null, sequence = 0, identity = '', busy = false;
  const context = () => JSON.stringify([signedInCompanyId(), currentUser?.id, currentUser?.role, currentRole]);
  const allowed = () => currentRole === 'office' && ['owner', 'admin'].includes(currentUser?.role);
  function guard() { const value = context(); if (value !== identity || !allowed()) { identity = value; sequence++; loaded = draft = preview = null; busy = false; host.innerHTML = ''; status.textContent = ''; } return allowed(); }
  const editable = () => guard() && loaded?.canEdit === true;
  const message = (text, failed = false) => { status.textContent = text; status.setAttribute('role', failed ? 'alert' : 'status'); };
  function invalidate() { sequence++; preview = null; busy = false; $('#notes-role-preview').hidden = true; message('Preview the current selections before saving.'); }
  function checks(value, kind, id) { return actions.map(action => `<label>${action === 'complete' ? 'Complete / reopen' : action[0].toUpperCase() + action.slice(1)}<input type="checkbox" data-notes-permission="${action}" data-profile-kind="${kind}" data-profile-id="${id}" ${value[action] ? 'checked' : ''} ${!editable() || action !== 'view' && !value.view ? 'disabled' : ''}></label>`).join(''); }
  function render() {
    if (!guard() || !loaded) return;
    host.innerHTML = `<p>Configure project notes and to-dos for each role. Assigned projects and team visibility stay in place. Owner access is protected.</p><p>Other workflows retain their existing base-role access. Their controls and notes approval are unavailable here.</p>${!loaded.storageSupported ? '<p role="alert">Permission editing is unavailable in this environment.</p>' : ''}
    ${Object.keys(labels).map(role => `<fieldset><legend>${labels[role]}</legend><div class="notes-permission-controls">${checks(draft.roles[role], 'role', role)}</div><p>Approve: unavailable; notes have no approval workflow.</p></fieldset>`).join('')}
    <h3>Named custom notes profiles</h3><p>A profile restricts notes access within its protected base role. It inherits that role's restrictions; it does not add grants or change project/crew assignments.</p>
    <div class="two-col"><label>Profile name<input id="notes-profile-name" maxlength="60" ${editable() ? '' : 'disabled'}></label><label>Protected base role<select id="notes-profile-base" ${editable() ? '' : 'disabled'}>${Object.keys(labels).map(role => `<option value="${role}">${labels[role]}</option>`).join('')}</select></label></div><button type="button" id="notes-profile-add" class="secondary" ${editable() ? '' : 'disabled'}>Add profile to preview</button>
    ${draft.customRoles.map(row => `<fieldset><legend>${escapeHtml(row.name)} · ${labels[row.baseRole]}</legend><div class="notes-permission-controls">${checks(row.permissions, 'custom', row.id)}</div><button type="button" data-retire-profile="${row.id}" class="secondary" ${editable() ? '' : 'disabled'}>Retire profile and remove assignments</button></fieldset>`).join('')}
    <h3>Profile assignments</h3><p>Clear assignments for inactive accounts or accounts whose base role changed before saving.</p>${loaded.accounts.map(account => { const assigned = draft.assignments.find(row => row.userId === account.id), options = draft.customRoles.filter(row => account.eligible && row.baseRole === account.role); return `<label>${escapeHtml(account.name)} · ${escapeHtml(labels[account.role] || account.role || 'Removed')} ${account.eligible ? '' : '(' + escapeHtml(account.status) + '; clear assignment)'}<select data-notes-assignment="${account.id}" ${editable() ? '' : 'disabled'}><option value="" ${assigned ? '' : 'selected'}>Base role only</option>${assigned && !options.some(row => row.id === assigned.customRoleId) ? `<option value="${assigned.customRoleId}" selected disabled>Unavailable assignment — remove</option>` : ''}${options.map(row => `<option value="${row.id}" ${assigned?.customRoleId === row.id ? 'selected' : ''}>${escapeHtml(row.name)}</option>`).join('')}</select></label>`; }).join('')}
    <label>Reason for this change<textarea id="notes-role-reason" maxlength="500" ${editable() ? '' : 'disabled'}></textarea></label><button type="button" id="notes-role-preview-button" class="primary" ${editable() ? '' : 'disabled'}>Preview changes</button><div id="notes-role-preview" hidden></div>
    <h3>Permission history</h3>${loaded.history.length ? `<ul>${loaded.history.map(row => `<li>${escapeHtml(row.actor)} · ${escapeHtml(row.at)}<p>${escapeHtml(row.reason)}</p></li>`).join('')}</ul>` : '<p>No notes permission changes have been saved.</p>'}`;
    host.querySelectorAll('[data-notes-permission]').forEach(input => input.addEventListener('change', () => {
      if (!editable()) return; const value = input.dataset.profileKind === 'role' ? draft.roles[input.dataset.profileId] : draft.customRoles.find(row => row.id === input.dataset.profileId).permissions;
      value[input.dataset.notesPermission] = input.checked; if (!value.view) for (const action of actions.slice(1)) value[action] = false;
      const reason = $('#notes-role-reason').value; invalidate(); render(); $('#notes-role-reason').value = reason;
    }));
    host.querySelectorAll('[data-notes-assignment]').forEach(input => input.addEventListener('change', () => { if (!editable()) return; draft.assignments = draft.assignments.filter(row => row.userId !== Number(input.dataset.notesAssignment)); if (input.value) draft.assignments.push({ userId: Number(input.dataset.notesAssignment), customRoleId: input.value }); invalidate(); }));
    $('#notes-role-reason').addEventListener('input', invalidate);
    $('#notes-profile-add').onclick = () => { if (!editable()) return; const name = $('#notes-profile-name').value.trim(); if (!name) return message('Enter a profile name.', true); const reason = $('#notes-role-reason').value; draft.customRoles.push({ id: 'custom_' + crypto.randomUUID().replace(/-/g, ''), name, baseRole: $('#notes-profile-base').value, permissions: { view: true, create: false, edit: false, complete: false } }); invalidate(); render(); $('#notes-role-reason').value = reason; };
    host.querySelectorAll('[data-retire-profile]').forEach(button => button.onclick = () => { if (!editable()) return; const id = button.dataset.retireProfile, reason = $('#notes-role-reason').value; draft.customRoles = draft.customRoles.filter(row => row.id !== id); draft.assignments = draft.assignments.filter(row => row.customRoleId !== id); if (!draft.retiredIds.includes(id)) draft.retiredIds.push(id); invalidate(); render(); $('#notes-role-reason').value = reason; });
    $('#notes-role-preview-button').onclick = previewChanges;
  }
  async function refresh() {
    if (!guard()) return; const ticket = ++sequence, original = context(); busy = false; loaded = draft = preview = null; host.innerHTML = ''; message('Loading role permissions.');
    try { const result = await api(route); if (ticket !== sequence || original !== context() || !guard()) return; loaded = result; draft = { schemaVersion: result.schemaVersion, revision: result.revision + 1, roles: structuredClone(result.roles), customRoles: structuredClone(result.customRoles), assignments: structuredClone(result.assignments), retiredIds: [...result.retiredIds] }; render(); message(result.valid ? '' : 'Stored policy needs repair. Notes access is restricted.', !result.valid); }
    catch (failure) { if (ticket === sequence && original === context()) message(failure.message, true); }
  }
  async function previewChanges() {
    if (!editable() || busy) return; const reason = $('#notes-role-reason').value.trim(); if (!reason) return message('Enter a reason before previewing.', true);
    const ticket = ++sequence, original = context(); busy = true; preview = null;
    try {
      const result = await api(route + '/preview', { method: 'POST', body: JSON.stringify({ revision: loaded.revision, policy: draft, reason }) });
      if (ticket !== sequence || original !== context() || !guard()) return; preview = result; const panel = $('#notes-role-preview'); panel.hidden = false;
      const permissionsText = value => actions.filter(action => value[action]).join(', ') || 'none';
      panel.innerHTML = `<h3>Review before saving</h3><p>${escapeHtml(result.reason)}</p><h4>Role controls after saving</h4><ul>${Object.keys(labels).map(role => `<li>${labels[role]}: ${permissionsText(result.policy.roles[role])}</li>`).join('')}${result.policy.customRoles.map(row => `<li>${escapeHtml(row.name)} (${labels[row.baseRole]}): ${permissionsText(row.permissions)} within base-role restrictions</li>`).join('')}</ul><h4>Account impact</h4><ul>${result.users.map(user => `<li><strong>${escapeHtml(user.name)}</strong>: ${escapeHtml(user.beforeProfile)} → ${escapeHtml(user.afterProfile)}; notes ${permissionsText(user.before)} → ${permissionsText(user.after)}</li>`).join('')}</ul><p>Other workflow access and project/crew scope stay with the base role.</p><label><input type="checkbox" id="notes-role-confirm"> I reviewed these role controls and profile assignments.</label><button id="notes-role-save" type="button" class="primary" disabled>Confirm and save permissions</button>`;
      $('#notes-role-confirm').onchange = () => $('#notes-role-save').disabled = !$('#notes-role-confirm').checked; $('#notes-role-save').onclick = save; message('Review the preview, then explicitly confirm.');
    } catch (failure) { if (ticket === sequence && original === context()) message(failure.message, true); } finally { if (ticket === sequence) busy = false; }
  }
  async function save() {
    if (!editable() || busy || !preview || !$('#notes-role-confirm')?.checked) return;
    const ticket = ++sequence, original = context(), value = preview; busy = true; $('#notes-role-save').disabled = true;
    try { await api(route, { method: 'PUT', body: JSON.stringify({ revision: value.revision, policy: value.policy, reason: value.reason, expiresAt: value.expiresAt, previewToken: value.previewToken, confirm: true }) }); if (ticket !== sequence || original !== context() || !guard()) return; await refresh(); message('Permissions saved. Role and profile changes are recorded in the activity trail.'); }
    catch (failure) { if (ticket === sequence && original === context()) { preview = null; $('#notes-role-preview').hidden = true; message(failure.message + ' Reload and preview again.', true); } } finally { if (ticket === sequence) busy = false; }
  }
  window.NotesRolePermissions = { refresh }; const previous = renderEverything; renderEverything = function () { const result = previous(); guard(); return result; };
  window.addEventListener('focus', () => { if (allowed() && !$('#notes-role-permissions-panel').hidden) refresh(); });
})();
