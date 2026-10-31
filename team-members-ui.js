/* One directory entry per worker profile, with its linked login accounts. */
(function () {
  'use strict';
  const esc = escapeHtml;
  let selectedKey = null;
  const dialog = document.createElement('dialog');
  dialog.id = 'team-details-modal';
  dialog.innerHTML = `<header class="modal-header"><div><p>TEAM MEMBER</p><h2 id="team-details-title"></h2></div><button type="button" data-team-close aria-label="Close team member details">×</button></header><div class="team-details-body"><section class="team-profile-summary"></section><form id="team-profile-form"><h3>Details</h3><div class="team-profile-fields"></div><p class="team-profile-error" role="alert" hidden></p><button type="submit" class="primary">Save details</button></form><section class="team-member-access" aria-label="App access"></section></div>`;
  dialog.setAttribute('aria-labelledby', 'team-details-title');
  document.body.append(dialog);
  dialog.querySelector('[data-team-close]').onclick = () => dialog.close();
  const owner = () => currentUser?.role === 'owner';
  const canEdit = () => ['owner', 'admin'].includes(currentUser?.role);
  function entries() {
    const linked = new Set();
    const rows = team.map(member => {
      const accounts = users.filter(user => Number(user.memberId) === Number(member.id));
      accounts.forEach(user => linked.add(user.id));
      return { key: 'member-' + member.id, member, accounts, name: member.name };
    });
    users.filter(user => !linked.has(user.id)).forEach(user => rows.push({ key: 'user-' + user.id, member: null, accounts: [user], name: user.name }));
    return rows;
  }
  function currentEntry() { return entries().find(row => row.key === selectedKey); }
  function accessMarkup(row) {
    return `<h3>App access</h3>${row.accounts.length ? row.accounts.map(user => `<div class="account-row" data-member-account="${user.id}"><div class="account-identity"><strong>${esc(user.name)}</strong><small><span class="exact-email">${esc(user.email || '')}</span> · <span class="account-role">${esc(String(user.role || '').replaceAll('_', ' '))}</span></small>${user.role === 'owner' ? '<span class="payroll-access-always">Payroll access: Always on</span><b class="payroll-account-owner">Account owner</b>' : ''}<p>${esc(user.status || 'Active')}</p></div>${owner() ? `<div class="team-account-actions">${user.role !== 'owner' ? `<button type="button" data-user-edit="${user.id}">Edit access</button><button type="button" data-user-toggle="${user.id}">${user.status === 'Active' ? 'Deactivate' : 'Reactivate'}</button>${['field', 'foreman'].includes(user.role) ? '' : `<button type="button" class="payroll-grant" data-payroll-grant="${user.id}" aria-pressed="${user.permissionGrants?.includes('payroll') === true}">Payroll access: ${user.permissionGrants?.includes('payroll') ? 'On' : 'Off'}</button>`}` : ''}${user.status === 'Active' ? `<button type="button" data-user-reset="${user.id}">${user.mustSetPassword ? 'Replace temporary password' : 'Reset password'}</button>` : ''}</div>` : ''}</div>`).join('') : `<p>No login yet.</p>${owner() ? '<button type="button" data-member-login>Create login</button>' : '<p>The account owner can add a login.</p>'}`}`;
  }
  function renderAccess() {
    const row = currentEntry();
    if (!row) return dialog.close();
    const target = dialog.querySelector('.team-member-access');
    target.innerHTML = accessMarkup(row);
    target.querySelectorAll('[data-user-edit]').forEach(button => button.onclick = () => { dialog.close(); openUserModal(users.find(user => Number(user.id) === Number(button.dataset.userEdit))); });
    target.querySelectorAll('[data-user-toggle]').forEach(button => button.onclick = () => updateUserStatus(Number(button.dataset.userToggle)));
    target.querySelectorAll('[data-user-reset]').forEach(button => button.onclick = () => { dialog.close(); openPasswordReset(Number(button.dataset.userReset)); });
    const create = target.querySelector('[data-member-login]');
    if (create) create.onclick = () => {
      dialog.close(); openUserModal();
      $('#user-name').value = row.member.name;
      $('#user-email').value = row.member.email || '';
      $('#user-role').value = 'field';
      $('#user-field-member').value = String(row.member.id);
      configureUserFields();
    };
  }
  function openDetails(key) {
    selectedKey = key;
    const row = currentEntry();
    if (!row) return;
    $('#team-details-title').textContent = row.name;
    const form = $('#team-profile-form'), member = row.member;
    form.hidden = true;
    const summary=dialog.querySelector('.team-profile-summary');
    summary.innerHTML=member?`<h3>Details</h3><dl>${[['Job role',member.role],['Crew',member.crew],['Phone',member.phone],['Contact email',member.email]].map(([label,value])=>`<div><dt>${label}</dt><dd>${esc(value||'Not entered')}</dd></div>`).join('')}</dl>${canEdit()?'<button type="button" data-edit-profile>Edit details</button>':''}`:'';
    const edit=summary.querySelector('[data-edit-profile]');
    if(edit)edit.onclick=()=>{summary.hidden=true;form.hidden=false;form.querySelector('input').focus();};
    summary.hidden=!member;
    if (member) {
      const disabled = canEdit() ? '' : 'disabled';
      form.querySelector('.team-profile-fields').innerHTML = [['name', 'Full name'], ['role', 'Job role'], ['crew', 'Crew'], ['phone', 'Phone'], ['email', 'Contact email']].map(([name, label]) => `<label>${label}<input name="${name}" type="${name === 'email' ? 'email' : name === 'phone' ? 'tel' : 'text'}" value="${esc(member[name] || '')}" maxlength="${name === 'email' ? 254 : name === 'phone' ? 80 : 120}" ${['name', 'role', 'crew'].includes(name) ? 'required' : ''} ${disabled}></label>`).join('');
      form.querySelector('[type=submit]').hidden = !canEdit();
      form.querySelector('.team-profile-error').hidden = true;
    }
    renderAccess();
    dialog.showModal();
  }
  $('#team-profile-form').onsubmit = async event => {
    event.preventDefault();
    const row = currentEntry();
    if (!row?.member || !canEdit()) return;
    const form = event.currentTarget, button = form.querySelector('[type=submit]'), message = form.querySelector('.team-profile-error');
    button.disabled = true; message.hidden = true;
    try {
      const updated = await api(`/api/team/${row.member.id}/profile`, { method: 'PATCH', body: JSON.stringify(Object.fromEntries(new FormData(form))) });
      Object.assign(row.member, updated);
      $('#team-details-title').textContent = updated.name;
      renderTeamDirectory(); dialog.close(); openDetails(row.key); notify('Team member details saved');
    } catch (error) { message.textContent = error.message; message.hidden = false; }
    finally { button.disabled = false; }
  };
  renderTeam = function () {
    $('#team-grid').innerHTML = entries().map(row => {
      const member = row.member;
      const active = member && workdays.find(day => day.status === 'active' && (day.memberIds || []).map(Number).includes(Number(member.id)));
      const project = active && projects.find(project => Number(project.id) === Number(active.projectId));
      const role = member?.role || String(row.accounts[0]?.role || '').replaceAll('_', ' ');
      const subtitle = [role, member?.crew].filter(Boolean).join(' · ');
      return `<button type="button" class="panel member-card team-member-card" data-team-member="${row.key}" aria-haspopup="dialog" aria-label="View ${esc(row.name)} details"><span class="avatar" aria-hidden="true">${esc(userInitials(row.name))}</span><span class="team-member-copy"><span class="team-member-name">${esc(row.name)}</span><span class="team-member-meta">${esc(subtitle)}</span>${active ? `<span class="team-member-working">Clocked in${project ? ' · ' + esc(project.name) : ''}</span>` : ''}</span><span class="team-member-open" aria-hidden="true">›</span></button>`;
    }).join('') || '<p>No team members yet. Add your first person.</p>';
    $('#team-grid').querySelectorAll('[data-team-member]').forEach(button => button.onclick = () => openDetails(button.dataset.teamMember));
  };
  const previousRender = renderTeamDirectory;
  renderTeamDirectory = function () {
    if (teamTab === 'accounts') teamTab = 'employees';
    const result = previousRender();
    if (dialog.open) renderAccess();
    return result;
  };
  renderTeamDirectory();
})();
