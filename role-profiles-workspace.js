'use strict';
(function () {
  const ROOT = '/api/company/role-policy', records = new Map(), recovery = window.RoleSaveRecovery; let active;
  const roleNames = { admin: 'Admin', project_manager: 'Project manager', foreman: 'Foreman', field: 'Field' };
  const actionNames = { view: 'View', create: 'Create', edit: 'Edit', remove: 'Remove', acknowledge: 'Acknowledge own assignment', viewRequests: 'View scoped time off', createRequest: 'Request own time off', viewCards: 'View time cards', reviewLeave: 'Review time off', approveCards: 'Approve time cards', unapproveCards: 'Undo time approval', createCards: 'Create time cards', correctCards: 'Correct time cards', removeCards: 'Remove time cards', submitCards: 'Submit time cards', clockCards: 'Clock time', downloadCards: 'Download time cards', viewPayroll: 'View pay periods', configurePeriods: 'Configure pay periods', captureExports: 'Create payroll exports', downloadExports: 'Download payroll exports', viewActivities: 'View company activities', viewReports: 'View dailies', createReports: 'Create dailies', editReports: 'Edit dailies', approveReports: 'Approve dailies', viewWorkdays: 'View workdays', runWorkdays: 'Start and end workdays', complete: 'Complete to-dos' };
  const copy = value => structuredClone(value);
  function mount(ctx) {
    if (active) active.leave();
    const mark = ctx.ticket(), root = ctx.content, e = ctx.escape, key = mark.identity;
    let alive = true, generation = 0, data, registry, audit, draft, proof, stage = 'loading', busy = false, reason = '', outcome = '', confirmed = false;
    const current = () => alive && ctx.current(mark, true), pending = () => records.get(key), model = () => data?.model || { profiles: [], assignments: [], retiredIds: [] };
    const profile = id => model().profiles.find(row => row.id === id), count = id => model().assignments.filter(row => row.profileId === id).length;
    const label = value => !value || value.state === 'none' ? 'No named profile' : value.state === 'protected' ? 'Protected owner' : value.name || 'Restricted unresolved profile';
    const title = change => ({ createOffice: 'Create the Office profile', create: 'Create custom profile', edit: 'Edit profile limits', delete: 'Retire unused profile', assign: change?.profileId === null ? 'Remove account profile' : 'Assign named profile' }[change?.operation] || 'Review profile change');
    function scope(account) {
      if (account.role === 'admin') return 'Existing Admin company-wide scope; existing grants and fixed financial/Assistant eligibility.';
      if (account.role === 'project_manager') return 'Existing assigned projects and crews; existing grants and fixed Assistant eligibility.';
      return account.role === 'foreman' ? 'Existing linked member and crew/project scope; no Assistant eligibility.' : 'Existing linked member and own project scope; no Assistant eligibility.';
    }
    function clearConfirmation() { confirmed = false; const box = root.querySelector('#profile-confirm'); if (box) box.checked = false; expiry(); }
    function expiry() {
      if (!current() || !proof) return;
      const seconds = Math.max(0, Math.ceil((Date.parse(proof.expiresAt) - Date.now()) / 1000)), target = root.querySelector('#profile-expiry');
      if (target) target.textContent = seconds ? 'Review expires in ' + Math.floor(seconds / 60) + 'm ' + seconds % 60 + 's. Company changes require a new preview.' : 'Review expired. Refresh and preview again.';
      const button = root.querySelector('#profile-save'); if (button) button.disabled = busy || !confirmed || !seconds;
    }
    function capabilityForm() {
      if (!['create', 'edit', 'createOffice'].includes(draft?.operation)) return '';
      const office = draft.operation === 'createOffice', baseRole = office ? 'admin' : draft.operation === 'edit' ? profile(draft.profileId).baseRole : draft.baseRole;
      const values = office ? data.officeDefaults : draft.capabilities, locked = office || stage !== 'editing' || busy || Boolean(pending());
      return `<p><strong>Inherited base:</strong> ${e(roleNames[baseRole])}. Scope, grants, feature locks and fixed protected access are unchanged.</p>${registry.domains.map(domain => `<fieldset class="panel profile-capabilities"><legend>${e(domain.label)}</legend>${domain.actions.map(action => `<label class="profile-action"><input type="checkbox" data-profile-family="${e(domain.id)}" data-profile-action="${e(action)}" aria-label="${e(domain.label + ': ' + (actionNames[action] || action))}" ${values[domain.id][action] ? 'checked' : ''} ${locked || !domain.ceilings[baseRole][action] ? 'disabled' : ''}><span>${e(actionNames[action] || action)}${!domain.ceilings[baseRole][action] ? ' — outside inherited base role' : ''}</span></label>`).join('')}</fieldset>`).join('')}`;
    }
    function editor() {
      if (!draft) return '';
      const editing = stage === 'editing' && !busy && !pending();
      let fields = '';
      if (draft.operation === 'create' || draft.operation === 'edit') {
        const base = draft.operation === 'edit' ? profile(draft.profileId).baseRole : draft.baseRole;
        fields = `<label for="profile-name">Profile name<input id="profile-name" maxlength="60" value="${e(draft.name)}" ${!editing || draft.profileId === 'office-profile-v1' ? 'disabled' : ''}></label><label for="profile-base-role">Inherited base role<select id="profile-base-role" ${!editing || draft.operation === 'edit' ? 'disabled' : ''}>${data.baseRoles.map(role => `<option value="${role}" ${role === base ? 'selected' : ''}>${e(roleNames[role])}</option>`).join('')}</select></label>`;
      }
      if (draft.operation === 'createOffice') fields = '<p>Office starts with eight admitted read actions and no assigned accounts. Creating it changes no account access. Its identity and Admin base are protected.</p>';
      if (draft.operation === 'assign') {
        const account = data.accounts.find(row => row.id === draft.accountId), next = draft.profileId === null ? 'No named profile: use the existing role limits' : profile(draft.profileId).name;
        fields = `<p><strong>${e(account?.name || 'Account #' + draft.accountId)}</strong>: ${e(label(account?.profile))} → ${e(next)}</p><p>${e(account ? scope(account) : 'Existing role and resource scope remain unchanged.')}</p><p>Removing a profile can restore access allowed by the existing role policy and grants. The preview shows the actual changes.</p>`;
      }
      if (draft.operation === 'delete') fields = `<p>Retire <strong>${e(profile(draft.profileId).name)}</strong>. No one is assigned. Its ID cannot be reused; no account falls back automatically.</p>`;
      return `<section class="panel" id="profile-draft"><h2>${e(title(draft))}</h2>${fields}${capabilityForm()}${stage === 'editing' ? `<label for="profile-reason">Reason for this change<textarea id="profile-reason" maxlength="1000" ${!editing ? 'disabled' : ''}>${e(reason)}</textarea></label><div class="actions"><button id="profile-preview" class="primary" ${!editing ? 'disabled' : ''}>Preview profile changes</button><button id="profile-cancel" ${!editing ? 'disabled' : ''}>Cancel editing</button></div>` : ''}</section>`;
    }
    function review() {
      if (!proof || stage !== 'review') return '';
      const changed = proof.impact.accounts.filter(row => row.changes.length || JSON.stringify(row.notesProjectsBefore) !== JSON.stringify(row.notesProjectsAfter) || JSON.stringify(row.profileBefore) !== JSON.stringify(row.profileAfter));
      return `<section class="panel" id="profile-impact"><h2>Review actual profile impact</h2><p><strong>${proof.impact.changedAccounts} ${proof.impact.changedAccounts === 1 ? 'person' : 'people'} affected</strong>. Existing role, grants and resource assignments stay fixed.</p><p id="profile-expiry" class="notice"></p><ul class="impact-list">${changed.map(row => `<li><strong>${e(row.name)}</strong> — ${e(roleNames[row.role] || row.role)}<p>Profile: ${e(label(row.profileBefore))} → ${e(label(row.profileAfter))}</p><ul>${row.changes.map(change => { const [family, action] = change.capability.split('.'); return `<li>${e(registry.domains.find(domain => domain.id === family).label + ': ' + (actionNames[action] || action))}: ${change.before ? 'Allowed' : 'Blocked'} → ${change.after ? 'Allowed' : 'Blocked'}</li>`; }).join('') || '<li>No effective action change; the reviewed profile detail or assignment changes.</li>'}</ul>${JSON.stringify(row.notesProjectsBefore) !== JSON.stringify(row.notesProjectsAfter) ? `<p>Notes project IDs: ${e(row.notesProjectsBefore.join(', ') || 'None')} → ${e(row.notesProjectsAfter.join(', ') || 'None')}</p>` : ''}</li>`).join('') || '<li>No account access or assignment changes. Only the named profile definition changes.</li>'}</ul><p>${proof.impact.queuedAssignmentEmails.newlyIneligibleIds.length} queued assignment emails would become ineligible. This change sends no email.</p><p><strong>Reason:</strong> ${e(proof.reason)}</p><label class="confirm-check"><input id="profile-confirm" type="checkbox" ${confirmed ? 'checked' : ''} ${busy ? 'disabled' : ''}><span>I reviewed the named profile and affected people. Apply exactly these changes.</span></label><div class="actions"><button id="profile-save" class="primary" ${busy || !confirmed ? 'disabled' : ''}>Confirm profile changes</button><button id="profile-edit-again" ${busy ? 'disabled' : ''}>Return to editing</button></div></section>`;
    }
    function render() {
      if (!current() || !data || !registry) return;
      const frozen = busy || stage !== 'editing' || Boolean(pending()), record = pending();
      root.innerHTML = `<p class="eyebrow">Company settings / Roles</p><h1>Office and custom profiles</h1><p>Named profiles limit the six admitted workflows within one existing base role. Accounts keep their stored role, grants, project/crew/member assignments and feature locks. Nothing changes until a preview is explicitly confirmed.</p><p><a href="#roles">Review base role limits</a> · Policy revision ${data.policyRevision} · Profile revision ${data.model?.revision || 0}</p><section class="panel protections"><h2>Protected access and scope</h2><p>Owner, security, billing and account administration are outside profiles. Existing pricing/financial ceilings and fixed signed-in PM/Admin/Owner Assistant eligibility stay unchanged. Office inherits its existing Admin company-wide scope and fixed financial/Assistant eligibility; a profile cannot turn a Field account into Office or Admin.</p></section>${outcome ? `<p class="notice ${stage === 'saved' ? 'success' : ''}" id="profile-result">${e(outcome)}</p>` : ''}${record ? `<section class="panel"><h2>Check the original request result</h2><p>Request ${e(record.body.requestId)}. Recovery uses exactly the original request under the original signed-in identity. Confirmed save identities survive a reload in this tab; no request is sent automatically.</p>${record.unresolved ? `<p>The earlier request result remains unknown. Review current profiles and activity before a new preview.</p><button id="profile-reconcile" ${busy || record.reviewRevision !== data.tenantRevision ? 'disabled' : ''}>I reviewed current profiles and activity</button>` : `<button id="profile-recover" ${busy ? 'disabled' : ''}>${record.kind === 'confirm' ? 'Check save result' : 'Recover preview'}</button>`}</section>` : ''}${review()}${editor()}<section class="panel"><h2>Named profiles</h2><div class="actions">${!profile('office-profile-v1') ? `<button id="profile-create-office" ${frozen ? 'disabled' : ''}>Create Office profile</button>` : ''}<button id="profile-create-custom" ${frozen ? 'disabled' : ''}>Create custom profile</button></div><ul class="directory">${model().profiles.map(row => `<li><strong>${e(row.name)}</strong><span class="badge">${e(roleNames[row.baseRole])} base</span><p>Revision ${row.revision} · ${count(row.id)} assigned. Scope inherits the existing role and assignments.</p><div class="actions"><button data-profile-edit="${row.id}" ${frozen ? 'disabled' : ''}>Edit ${e(row.name)}</button><button data-profile-delete="${row.id}" ${frozen || count(row.id) || row.kind === 'office' ? 'disabled' : ''}>Retire ${e(row.name)}</button></div>${count(row.id) ? '<p>Reassign or explicitly remove each account profile before retirement.</p>' : row.kind === 'office' ? '<p>Office identity is protected; its admitted limits can be edited.</p>' : ''}</li>`).join('') || '<li>No named profiles. Existing defaults and assignments remain unchanged.</li>'}</ul></section><section class="panel"><h2>Account profile assignments</h2><ul class="directory">${data.accounts.map(account => { const protectedRole = !data.baseRoles.includes(account.role), compatible = model().profiles.filter(row => row.baseRole === account.role); return `<li><strong>${e(account.name)}</strong><span class="badge">${e(roleNames[account.role] || account.role)}</span><p>${e(account.status)} · ${e(label(account.profile))}${account.profile?.state === 'role-mismatch' ? ' — base role changed; access is restricted until reviewed' : ''}</p>${protectedRole ? '<p>Protected account; no named profile assignment.</p>' : `<p>${e(scope(account))}</p><label for="profile-account-${account.id}">Proposed profile<select id="profile-account-${account.id}" ${frozen ? 'disabled' : ''}><option value="" ${!account.profile?.id ? 'selected' : ''}>Use existing role without a named profile</option>${compatible.map(row => `<option value="${row.id}" ${account.profile?.id === row.id ? 'selected' : ''}>${e(row.name)}</option>`).join('')}${account.profile?.id && !compatible.some(row => row.id === account.profile.id) ? `<option value="${account.profile.id}" selected disabled>Incompatible assigned profile</option>` : ''}</select></label><button data-profile-account="${account.id}" ${frozen ? 'disabled' : ''}>Review assignment for ${e(account.name)}</button>`}</li>`; }).join('')}</ul></section><div class="actions"><button id="profile-refresh" ${busy || record && !record.unresolved ? 'disabled' : ''}>Refresh current profiles</button><a href="#roles">Close profiles</a></div><section class="panel audit"><h2>Role and profile activity</h2>${audit?.entries.slice().reverse().map(row => `<details><summary>${e(row.actorName)} ${row.kind === 'confirmed' ? 'saved' : 'previewed'} ${e(row.changedFamilies.map(id => id === 'profiles' ? 'named profiles' : registry.domains.find(domain => domain.id === id)?.label || id).join(', '))}</summary><p>${e(row.reason)}</p><p>Policy revision ${row.before.policyRevision} → ${row.after.policyRevision}</p><small>Request ${e(row.requestId)}</small></details>`).join('') || '<p>No activity yet.</p>'}</section><p class="muted">Broader company/project/customer/team edits, estimates, changes, tickets, public sharing and provider actions remain unavailable in this draft.</p>`;
      expiry();
    }
    function denied(error) {
      if (![401, 402, 403].includes(error.status)) return false;
      data = registry = audit = draft = proof = null; confirmed = false; root.replaceChildren(); ctx.say('Your access changed. Reopen to verify your current identity.', true); return true;
    }
    async function readState() {
      try {
      const ownGeneration = ++generation;
      const results = await Promise.all([ctx.request(ROOT + '/profiles'), ctx.request('/api/company/role-capabilities'), ctx.request(ROOT + '/audit')]);
      if (!current() || ownGeneration !== generation) return false;
      let nextAudit = results[2]; if (nextAudit.total > 100) nextAudit = await ctx.request(ROOT + '/audit?offset=' + (nextAudit.total - 100));
      if (!current() || ownGeneration !== generation) return false;
      await ctx.verify(results[0].tenantRevision); if (!current() || ownGeneration !== generation) return false;
      [data, registry] = results; audit = nextAudit; return true;
      } catch (error) { if (current()) denied(error); throw error; }
    }
    async function load(preserve = false) {
      if (!current() || busy) return;
      const old = preserve ? copy(draft) : null, oldReason = preserve ? reason : '';
      stage = 'loading'; proof = null; confirmed = false; root.replaceChildren(); ctx.say('Loading current profiles.');
      try { if (!await readState()) return; if (!pending()) { const original = recovery.get('role-profiles', key); if (original) records.set(key, original); } if (pending()?.unresolved) pending().reviewRevision = data.tenantRevision; draft = old; reason = oldReason; stage = pending() ? 'recovery' : 'editing'; ctx.say(''); render(); }
      catch (error) { if (!current()) return; root.replaceChildren(); ctx.say(error.message + ' Reopen Company settings / Roles to verify access.', true); }
    }
    async function perform(kind, recovering) {
      if (!current() || busy || kind === 'preview' && !draft || kind === 'confirm' && !recovering && !confirmed) return;
      busy = true; clearConfirmation(); let record = recovering;
      try {
        await ctx.verify(record ? undefined : kind === 'confirm' ? proof.tenantRevision : data.tenantRevision); if (!current()) return;
        if (!record) { record = { identity: key, kind, path: kind === 'preview' ? ROOT + '/profiles/preview' : ROOT + '/confirm', body: kind === 'preview' ? { requestId: crypto.randomUUID(), expectedRevision: data.tenantRevision, reason: reason.trim(), profileChange: copy(draft) } : { previewId: proof.previewId, version: proof.version, requestId: crypto.randomUUID(), confirmed: true } }; if (kind === 'confirm') recovery.remember('role-profiles', record); records.set(key, record); }
        else if (record.kind === 'confirm') recovery.remember('role-profiles', record);
        stage = 'recovery'; render();
        const result = await ctx.request(record.path, { method: 'POST', body: JSON.stringify(record.body) }); record.result = result;
        let cleanupError; if (record.kind === 'confirm') { try { recovery.forget('role-profiles', record); } catch (storageError) { record.cleanupPending = true; cleanupError = storageError; } }
        if (!current()) return; await ctx.verify(); if (!current()) return; if (cleanupError) throw cleanupError;
        records.delete(key); outcome = '';
        if (record.kind === 'preview') { proof = result; draft = copy(record.body.profileChange); reason = record.body.reason; stage = 'review'; }
        else { stage = 'saved'; draft = proof = null; outcome = 'Profile changes saved. Policy revision ' + result.policyRevision + '. Request ' + result.requestId + '.'; await readState(); }
      } catch (error) {
        if (!current()) return;
        if ([401, 402, 403].includes(error.status)) { data = registry = audit = draft = proof = null; root.replaceChildren(); ctx.say('Your access changed. Reopen to verify your current identity.', true); }
        else if (record?.result && record.kind === 'confirm') { records.delete(key); stage = 'saved'; proof = draft = null; outcome = 'The original profile save succeeded at policy revision ' + record.result.policyRevision + '. Current profiles could not be refreshed. Refresh current profiles.' + (record.cleanupPending ? ' This tab could not clear its recovery identity; after a reload, check the original result again.' : ''); }
        else if (error.status >= 400 && error.status < 500) { if (record?.kind === 'confirm' && record.hadUncertain) { record.unresolved = true; try { recovery.unresolved('role-profiles', record); } catch (storageError) { ctx.say(storageError.message, true); } try { if (await readState()) record.reviewRevision = data.tenantRevision; } catch (readError) { if (!denied(readError)) ctx.say(readError.message, true); } } else if (record) { try { if (record.kind === 'confirm') recovery.forget('role-profiles', record); records.delete(key); } catch (storageError) { record.unresolved = true; ctx.say(storageError.message, true); } } stage = 'stale'; proof = null; outcome = error.message + (record?.hadUncertain ? ' The earlier request result remains unknown. Request ' + record.body.requestId + '. Review current profiles and activity before a new preview.' : ' Refresh current profiles and preview again.'); }
        else if (record && (error.uncertain || record.result)) { record.hadUncertain = true; stage = 'recovery'; outcome = error.message + ' Request ' + record.body.requestId + '.'; }
        else { if (record) records.delete(key); stage = 'editing'; proof = null; outcome = error.message; }
      } finally { busy = false; render(); }
    }
    async function reconcile() {
      const record = pending(); if (!current() || busy || !record?.unresolved || record.reviewRevision !== data.tenantRevision) return;
      busy = true; const reviewedRevision = record.reviewRevision; render();
      try { await ctx.verify(reviewedRevision); if (!current() || !await readState()) return; if (data.tenantRevision !== reviewedRevision) { record.reviewRevision = data.tenantRevision; outcome = 'The company changed. Review current profiles and activity again before acknowledging the earlier unknown result.'; return; } recovery.forget('role-profiles', record); records.delete(key); draft = proof = null; confirmed = false; stage = 'editing'; outcome = 'Current profiles and activity reviewed. The earlier request result remains unknown. Request ' + record.body.requestId + '.'; }
      catch (error) { if (current() && !denied(error)) { if (error.status === 409) { try { if (await readState()) record.reviewRevision = data.tenantRevision; } catch (readError) { if (!denied(readError)) ctx.say(readError.message, true); } } ctx.say(error.message + ' Review current profiles and activity again.', true); } }
      finally { busy = false; render(); }
    }
    function onInput(event) {
      if (!current() || busy || stage !== 'editing' || pending()) return;
      if (event.target.id === 'profile-reason') reason = event.target.value;
      if (event.target.id === 'profile-name' && draft) draft.name = event.target.value;
    }
    function onChange(event) {
      if (!current() || busy) return;
      if (event.target.id === 'profile-confirm') { confirmed = event.target.checked; expiry(); return; }
      if (stage !== 'editing' || pending() || !draft) return;
      if (event.target.id === 'profile-base-role' && draft.operation === 'create') { draft.baseRole = event.target.value; draft.capabilities = copy(data.customDefaults[draft.baseRole]); render(); }
      const family = event.target.dataset.profileFamily, action = event.target.dataset.profileAction;
      if (family && ['create', 'edit'].includes(draft.operation)) { const base = draft.baseRole || profile(draft.profileId).baseRole; if (registry.domains.find(row => row.id === family)?.ceilings[base]?.[action]) draft.capabilities[family][action] = event.target.checked; }
    }
    function onClick(event) {
      const button = event.target.closest('button'); if (!button || button.disabled || !current() || busy) return;
      if (button.id === 'profile-preview') { if (!reason.trim()) { ctx.say('Enter a reason before previewing.', true); root.querySelector('#profile-reason').focus(); return; } ctx.say(''); perform('preview'); return; }
      if (button.id === 'profile-save' && proof && confirmed && Date.parse(proof.expiresAt) > Date.now()) { perform('confirm'); return; }
      if (button.id === 'profile-reconcile') { reconcile(); return; }
      if (button.id === 'profile-recover' && pending() && !pending().unresolved) { perform(pending().kind, pending()); return; }
      if (button.id === 'profile-refresh' || button.id === 'profile-edit-again') { outcome = ''; load(button.id === 'profile-edit-again'); return; }
      if (stage !== 'editing' || pending()) return;
      if (button.id === 'profile-cancel') draft = null;
      if (button.id === 'profile-create-office') draft = { operation: 'createOffice' };
      if (button.id === 'profile-create-custom') draft = { operation: 'create', profileId: crypto.randomUUID(), name: '', baseRole: 'project_manager', capabilities: copy(data.customDefaults.project_manager) };
      if (button.dataset.profileEdit) { const row = profile(button.dataset.profileEdit); draft = { operation: 'edit', profileId: row.id, expectedProfileRevision: row.revision, name: row.name, capabilities: copy(row.capabilities) }; }
      if (button.dataset.profileDelete) { const row = profile(button.dataset.profileDelete); draft = { operation: 'delete', profileId: row.id, expectedProfileRevision: row.revision }; }
      if (button.dataset.profileAccount) { const accountId = Number(button.dataset.profileAccount), value = root.querySelector('#profile-account-' + accountId).value; draft = { operation: 'assign', accountId, profileId: value || null }; }
      proof = null; confirmed = false; reason = ''; outcome = ''; ctx.say(''); render(); root.querySelector('#profile-draft')?.scrollIntoView({ block: 'start' });
    }
    root.addEventListener('input', onInput); root.addEventListener('change', onChange); root.addEventListener('click', onClick);
    const timer = setInterval(expiry, 1000);
    active = { clearConfirmation, revalidate: revision => { clearConfirmation(); if (proof && revision !== proof.tenantRevision) { proof = null; stage = pending() ? 'recovery' : 'stale'; outcome = 'The company changed. Refresh current profiles and preview again.'; render(); } }, leave: () => { alive = false; generation++; clearInterval(timer); root.removeEventListener('input', onInput); root.removeEventListener('change', onChange); root.removeEventListener('click', onClick); } };
    load();
  }
  window.addEventListener('blur', () => active?.clearConfirmation());
  document.addEventListener('visibilitychange', () => { if (document.hidden) active?.clearConfirmation(); });
  window.RoleProfiles = { mount, leave: () => { active?.leave(); active = null; }, revalidate: revision => active?.revalidate(revision) };
})();
