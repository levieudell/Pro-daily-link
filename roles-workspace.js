'use strict';
(function () {
  const labels = { view: 'View', create: 'Create', edit: 'Edit', remove: 'Remove', acknowledge: 'Acknowledge own assignment', viewRequests: 'View time-off requests in existing scope', createRequest: 'Request own time off', viewCards: 'View time cards', reviewLeave: 'Review time off', approveCards: 'Approve time cards', unapproveCards: 'Undo time approval', createCards: 'Create time cards', correctCards: 'Correct time cards', removeCards: 'Remove time cards', submitCards: 'Submit time cards', clockCards: 'Clock time', downloadCards: 'Download time cards', viewActivities: 'View company activities', viewPayroll: 'View pay periods', configurePeriods: 'Configure pay periods', captureExports: 'Create payroll exports', downloadExports: 'Download payroll exports', viewReports: 'View dailies', createReports: 'Create dailies', editReports: 'Edit dailies', approveReports: 'Approve dailies', viewWorkdays: 'View workdays', runWorkdays: 'Start and end workdays', complete: 'Complete to-dos' };
  const roleLabels = { admin: 'Admin', project_manager: 'Project manager', foreman: 'Foreman', field: 'Field' };
  const scopeHelp = { scheduling: 'Project managers retain assigned projects and crews. Field and foreman views retain their own assignments.', timeOff: 'Admin viewing retains the existing manage-time grant. Project managers retain existing time grants and assigned-crew requests. Field and foreman users see only their own requests.', timeReview: 'Existing time grants and the time-card feature still apply. Project managers retain assigned projects and crews; field users retain own cards and foremen retain crew cards.', timeWrite: 'Existing time grants, viewing permissions and the time-card feature still apply. Payroll exports remain limited to existing office roles.', daily: 'Existing daily grants, project scope and whole-crew visibility still apply. Starting workdays also requires the existing time-card permissions when enabled.', notes: 'Existing project scope and team visibility still apply. Activating a notes policy requires member-ID evidence; name-only project visibility can be removed in the preview.' };
  const requirements = { scheduling: { create: ['view'], edit: ['view'], remove: ['view'], acknowledge: ['view'] }, timeOff: { createRequest: ['viewRequests'] }, timeReview: { approveCards: ['viewCards'], unapproveCards: ['viewCards'] }, timeWrite: { configurePeriods: ['viewPayroll'], captureExports: ['viewPayroll'], downloadExports: ['viewPayroll'] }, daily: { createReports: ['viewReports'], editReports: ['viewReports'], approveReports: ['viewReports'], runWorkdays: ['viewWorkdays', 'createReports'] }, notes: { create: ['view'], edit: ['view'], complete: ['view'] } };
  function proposalErrors(rows) {
    return Object.entries(requirements).flatMap(([family, actions]) => Object.entries(rows[family]).flatMap(([role, flags]) => Object.entries(actions).filter(([action, needs]) => flags[action] && needs.some(key => !flags[key])).map(([action, needs]) => `${roleLabels[role]}: ${labels[action]} requires ${needs.map(key => labels[key]).join(' and ')}.`)));
  }
  const copy = value => structuredClone(value);
  function currentRows(state) {
    return Object.fromEntries(Object.keys(state.defaults).map(family => [family, state.states[family].state === 'valid' ? copy(state.policies[family].roles) : state.states[family].state === 'default' ? copy(state.defaults[family]) : Object.fromEntries(Object.entries(state.defaults[family]).map(([role, flags]) => [role, Object.fromEntries(Object.keys(flags).map(action => [action, false]))]))]));
  }
  if (typeof module !== 'undefined' && module.exports) { module.exports = { currentRows, labels, roleLabels, proposalErrors }; return; }
  const $ = selector => document.querySelector(selector), content = $('#workspace-content'), message = $('#workspace-message');
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const records = new Map(), recovery = window.RoleSaveRecovery;
  let nav, identity = '', sequence = 0, loadGeneration = 0, busy = false, signingOut = false, route = '', state, registry, audit, proposed, reason = '', proof, stage = 'loading', outcome = '', confirmed = false;
  const root = '/api/company/role-policy';
  const companyId = () => { const value = document.cookie.split(';').map(row => row.trim()).find(row => row.startsWith('pdl_company='))?.slice(12); try { return new URLSearchParams(location.search).get('tenant') || (value ? decodeURIComponent(value) : ''); } catch { return ''; } };
  const identityOf = data => JSON.stringify([data.company.id, data.actor.id, data.actor.accessRole, data.sessionBinding]);
  const pending = () => records.get(identity);
  const isCurrent = (ticket, owner = false) => ticket.sequence === sequence && ticket.identity === identity && ticket.companyId === companyId() && (!owner || nav?.settings.roles === true) && route === ticket.route;
  const ticket = () => ({ sequence, identity, companyId: companyId(), route });
  function say(text, error = false) { message.className = error ? 'notice error' : ''; message.textContent = text; }
  async function request(path, options = {}) {
    let response, data; const method = options.method || 'GET';
    try { response = await fetch(path, { credentials: 'include', cache: 'no-store', headers: { 'Content-Type': 'application/json', 'X-PDL-Company': companyId() }, ...options }); data = await response.json(); }
    catch { throw Object.assign(Error(method === 'GET' ? 'The workspace could not be reached. Try again.' : 'The request result is unknown. Keep this page open and recover the same request.'), { uncertain: method !== 'GET' }); }
    if (!response.ok) throw Object.assign(Error(data.error || 'The request could not be completed.'), { status: response.status, code: data.code, uncertain: method !== 'GET' && response.status >= 500 });
    return data;
  }
  function applyNavigation(data) {
    if (data.company.id !== companyId()) throw Object.assign(Error('The selected company changed. Reopen the workspace.'), { status: 401, identityChanged: true });
    const nextIdentity = identityOf(data);
    if (identity && identity !== nextIdentity) { sequence++; state = registry = proposed = proof = audit = null; reason = ''; outcome = ''; confirmed = false; content.replaceChildren(); }
    nav = data; identity = nextIdentity;
    $('#company-label').textContent = data.company.name; $('#actor-label').textContent = data.actor.name;
    for (const name of ['projects', 'team', 'customers']) $('[data-route="' + name + '"]').hidden = false;
    $('[data-route="roles"]').hidden = !data.settings.roles;
    $('[data-route="role-profiles"]').hidden = !data.settings.roles;
    for (const [name, [, family, action]] of Object.entries(window.WorkspaceActions?.routes || {})) $('[data-route="' + name + '"]').hidden = !data.actor.effectiveCapabilities[family]?.[action];
  }
  function clearPrivate() {
    sequence++; loadGeneration++; nav = null; identity = ''; state = registry = audit = proposed = proof = null; reason = outcome = ''; confirmed = false;
    window.WorkspaceActions?.leave(); window.RoleProfiles?.leave(); content.replaceChildren();
    $('#company-label').textContent = 'Your workspace'; $('#actor-label').textContent = '';
    document.querySelectorAll('[data-route]').forEach(link => { link.hidden = true; link.removeAttribute('aria-current'); });
  }
  function signInLink() {
    const link = document.createElement('a'); link.href = window.WorkspaceEntry.login(companyId(), '#' + route); link.textContent = 'Sign in'; content.append(link);
  }
  async function freshIdentity(expectedRevision, ownerOnly = true) {
    const old = identity, mark = ticket(), data = await request('/api/navigation');
    if (!isCurrent(mark)) throw Object.assign(Error('The workspace changed while this request was pending.'), { stale: true });
    applyNavigation(data);
    if (old !== identity || ownerOnly && !data.settings.roles) { say('Your signed-in identity or permissions changed. Reopen this workspace.', true); throw Object.assign(Error('Your signed-in identity or permissions changed. Reopen this workspace.'), { status: 403, identityChanged: true }); }
    if (expectedRevision != null && data.tenantRevision !== expectedRevision) throw Object.assign(Error('The company changed after this review. Refresh current permissions and preview again.'), { status: 409 });
  }
  function directory() {
    const names = { projects: 'Projects', team: 'People', customers: 'Customers' }, rows = nav[route] || [];
    content.innerHTML = `<p class="eyebrow">Workspace directory</p><h1>${names[route]}</h1><p class="muted">Only information available to your signed-in account is shown. Directory entries do not change project, crew or role assignments.</p><section class="panel"><ul class="directory">${rows.map(row => `<li><strong>${escape(row.name)}</strong>${row.views ? `<p class="muted">Available: ${escape(Object.entries(row.views).filter(([, allowed]) => allowed).map(([key]) => ({ notes: 'notes', scheduling: 'schedule', reports: 'dailies', workdays: 'workdays', timeCards: 'time cards' }[key])).join(', ') || 'directory information only')}</p>` : ''}</li>`).join('') || '<li>No entries available.</li>'}</ul></section>${route === 'customers' && nav.missingCustomerLinks ? '<p class="notice">Some project customer links need review. No substitute customer information is shown.</p>' : ''}`;
  }
  function protect() { return '<section class="panel protections"><h2>Protections stay fixed</h2><p>Owner permissions, billing, pricing, security, account administration, project and crew assignments, and Assistant eligibility stay protected. Role limits apply alongside each person’s existing grants and assignments.</p></section>'; }
  function matrix() {
    const current = currentRows(state);
    return registry.domains.map(domain => `<section class="panel"><h2>${escape(domain.label)}</h2><p class="muted">${escape(scopeHelp[domain.id])}</p><p class="muted">${state.states[domain.id].state === 'default' ? 'Default role limits' : state.states[domain.id].state === 'valid' ? 'Saved role policy · revision ' + state.states[domain.id].revision : 'Needs repair · access is restricted'}</p><table class="matrix"><thead><tr><th scope="col">Action</th>${registry.roles.map(role => `<th scope="col">${roleLabels[role]}</th>`).join('')}</tr></thead><tbody>${domain.actions.map(action => `<tr><th scope="row">${escape(labels[action] || action)}</th>${registry.roles.map(role => { const ceiling = domain.ceilings[role][action], allowed = proposed[domain.id][role][action], changed = allowed !== current[domain.id][role][action]; return `<td><label data-role-label="${roleLabels[role]}"><input type="checkbox" data-family="${escape(domain.id)}" data-role="${role}" data-action="${escape(action)}" aria-label="${escape(domain.label + ': ' + (labels[action] || action) + ', ' + roleLabels[role])}" ${allowed ? 'checked' : ''} ${!ceiling || busy || stage !== 'editing' ? 'disabled' : ''}><span class="cell"><small>Current: ${current[domain.id][role][action] ? 'Allowed' : 'Blocked'}</small><small class="${changed ? 'changed' : !ceiling ? 'locked' : ''}">${!ceiling ? 'Outside role limits' : 'Proposed: ' + (allowed ? 'Allowed' : 'Blocked')}</small></span></label></td>`; }).join('')}</tr>`).join('')}</tbody></table></section>`).join('');
  }
  function impact() {
    const projectName = id => nav.projects.find(row => row.id === id)?.name || 'Project #' + id;
    const affected = proof.impact.accounts.filter(row => row.changes.length || JSON.stringify(row.notesProjectsBefore) !== JSON.stringify(row.notesProjectsAfter));
    return `<section class="panel"><h2>Review actual access changes</h2><p><strong>${proof.impact.changedAccounts} ${proof.impact.changedAccounts === 1 ? 'person' : 'people'} affected</strong> · ${proof.changedFamilies.map(id => (registry.domains.find(row => row.id === id)?.label || 'Named profiles')).map(escape).join(', ')}</p><p class="notice" id="expiry-status"></p><ul class="impact-list">${affected.map(row => `<li><strong>${escape(row.name)}</strong><span class="badge">${escape(roleLabels[row.role] || row.role)}</span><ul>${row.changes.map(change => { const [family, action] = change.capability.split('.'); return `<li>${escape(registry.domains.find(domain => domain.id === family).label + ' · ' + (labels[action] || action))}: ${change.before ? 'Allowed' : 'Blocked'} → ${change.after ? 'Allowed' : 'Blocked'}</li>`; }).join('')}</ul>${JSON.stringify(row.notesProjectsBefore) !== JSON.stringify(row.notesProjectsAfter) ? `<p>Notes projects before: ${escape(row.notesProjectsBefore.map(projectName).join(', ') || 'None')}<br>Notes projects after: ${escape(row.notesProjectsAfter.map(projectName).join(', ') || 'None')}</p>` : ''}</li>`).join('') || '<li>No individual action or notes-project changes. The saved policy configuration will change.</li>'}</ul><p class="muted">${proof.impact.accounts.length - affected.length} accounts have no effective access change. Owner permissions stay fixed.</p><p>${proof.impact.queuedAssignmentEmails.newlyIneligibleIds.length} queued assignment emails would no longer be authorized. This change sends no email.</p><p><strong>Reason:</strong> ${escape(proof.reason)}</p><label class="confirm-check"><input id="explicit-confirm" type="checkbox" ${confirmed ? 'checked' : ''} ${busy ? 'disabled' : ''}><span>I reviewed the affected people and project access. Apply exactly these role-policy changes.</span></label><div class="actions"><button id="confirm-policy" class="primary" ${!confirmed || busy ? 'disabled' : ''}>Confirm permission changes</button><button id="edit-proposal" ${busy ? 'disabled' : ''}>Return to editing</button></div></section>`;
  }
  function history() {
    if (!audit) return '';
    return `<section class="panel audit"><h2>Policy activity</h2><p class="muted">Previews record a review. Confirmed entries record a saved policy.</p>${audit.entries.slice().reverse().map(row => `<details><summary>${escape(row.actorName)} ${row.kind === 'confirmed' ? 'saved' : 'previewed'} ${escape(row.changedFamilies.map(id => (registry.domains.find(domain => domain.id === id)?.label || 'Named profiles')).join(', '))}<small> · ${escape(new Date(row.at).toLocaleString())}</small></summary><p>${escape(row.reason)}</p><p>Policy revision ${row.before.policyRevision} → ${row.after.policyRevision}</p><small>Request ${escape(row.requestId)}</small></details>`).join('') || '<p>No policy activity yet.</p>'}<div class="actions"><button data-audit-offset="${Math.max(0, audit.offset - 100)}" ${audit.offset === 0 || busy ? 'disabled' : ''}>Older activity</button><button data-audit-offset="${Math.min(Math.max(0, audit.total - 100), audit.offset + 100)}" ${audit.offset + 100 >= audit.total || busy ? 'disabled' : ''}>Newer activity</button></div></section>`;
  }
  function renderEditor() {
    if (!state || !registry || route !== 'roles' || !nav?.settings.roles) return;
    const record = pending();
    content.innerHTML = `<p class="eyebrow">Company settings / Roles</p><h1>What each role can do</h1><p>Set role limits, then preview how they affect your people. Individual grants and project or crew scope still apply. Permissions change only after explicit confirmation.</p><p class="saved-version">Current policy revision ${state.policyRevision}</p>${protect()}${outcome ? `<p class="notice ${stage === 'saved' ? 'success' : ''}" id="save-result">${escape(outcome)}</p>` : ''}${record ? `<section class="panel"><h2>${record.kind === 'confirm' ? 'Check permission save result' : 'Recover the same preview'}</h2><p>Request ${escape(record.body.requestId)} is awaiting a reliable result. Recovery uses the exact original request. Confirmed save identities survive a reload in this tab; no request is sent automatically.</p><div class="actions">${record.unresolved ? `<p>The earlier request result remains unknown. Review current permissions and activity.</p><button id="reconcile-request" ${busy || record.reviewRevision !== state.tenantRevision ? 'disabled' : ''}>I reviewed current permissions and activity</button>` : `<button class="primary" id="recover-request" ${busy ? 'disabled' : ''}>${record.kind === 'confirm' ? 'Check save result' : 'Recover preview'}</button>`}</div></section>` : ''}${stage === 'review' && proof ? impact() : ''}${matrix()}${stage === 'editing' && !record ? `<section class="panel"><label class="reason" for="policy-reason">Reason for this change<textarea id="policy-reason" maxlength="1000" ${busy ? 'disabled' : ''} placeholder="Explain what this change is for">${escape(reason)}</textarea></label><div class="actions"><button class="primary" id="preview-policy" ${busy ? 'disabled' : ''}>Preview access changes</button><button id="reset-defaults" ${busy ? 'disabled' : ''}>Use supported defaults</button></div></section>` : ''}<div class="actions"><button id="refresh-policy" ${busy || record && !record.unresolved ? 'disabled' : ''}>${stage === 'saved' ? 'Review current permissions' : 'Refresh current permissions'}</button><button id="close-editor">Close editor</button></div><section class="panel"><h2>Unavailable role controls</h2><p><a href="#role-profiles">Manage Office and custom profiles</a> for the six admitted families. Profiles inherit one existing role and its assignments. These broader domains remain unavailable.</p><div class="unavailable"><p>Project, customer, people and subcontractor changes</p><p>Company details, forms and catalog</p><p>Report flags, rates and deletion; estimates, tickets and broader changes</p><p>Public sharing, provider actions and complete attachment backup</p></div></section>${history()}`;
    updateExpiry();
  }
  function updateExpiry() {
    const target = $('#expiry-status'); if (!target || !proof) return;
    const seconds = Math.max(0, Math.ceil((Date.parse(proof.expiresAt) - Date.now()) / 1000));
    target.textContent = seconds ? `Review expires in ${Math.floor(seconds / 60)}m ${seconds % 60}s. Company changes also require a new preview.` : 'This review expired. Return to editing and create a fresh preview.';
    const button = $('#confirm-policy'); if (button) button.disabled = busy || !confirmed || seconds === 0;
  }
  async function loadEditor({ preserveProposal = false } = {}) {
    const mark = ticket(), generation = ++loadGeneration, previous = preserveProposal ? copy(proposed) : null, previousReason = preserveProposal ? reason : '';
    const current = () => generation === loadGeneration && isCurrent(mark, true);
    stage = 'loading'; proof = null; confirmed = false; content.replaceChildren(); say('Loading current permissions…');
    try {
      const results = await Promise.all([request(root), request('/api/company/role-capabilities'), request(root + '/audit')]);
      if (!current()) return;
      const [nextState, nextRegistry] = results; let nextAudit = results[2];
      if (nextAudit.total > 100) nextAudit = await request(root + '/audit?offset=' + Math.max(0, nextAudit.total - 100));
      if (!current()) return;
      await freshIdentity(nextState.tenantRevision); if (!current()) return;
      state = nextState; registry = nextRegistry; audit = nextAudit;
      if (!pending()) { const original = recovery.get('roles', identity); if (original) records.set(identity, original); }
      if (pending()?.unresolved) pending().reviewRevision = state.tenantRevision;
      proposed = previous || currentRows(state); reason = previousReason; stage = pending() ? 'recovery' : 'editing'; say(''); renderEditor();
    } catch (error) {
      if (!current() && !error.identityChanged) return;
      state = registry = proposed = proof = audit = null; content.replaceChildren();
      say(error.message + ' Reopen Company settings / Roles to try again.', true);
    }
  }
  async function enter() {
    if (signingOut) return;
    const next = location.hash.slice(1) || 'roles'; route = ['roles', 'role-profiles', 'projects', 'team', 'customers', ...Object.keys(window.WorkspaceActions?.routes || {})].includes(next) ? next : 'projects';
    window.WorkspaceActions?.leave(); window.RoleProfiles?.leave();
    sequence++; confirmed = false; proof = null; content.replaceChildren(); say('Loading your workspace…');
    const mark = sequence;
    try {
      const data = await request('/api/navigation'); if (mark !== sequence) return; applyNavigation(data);
      document.querySelectorAll('[data-route]').forEach(link => { if (link.dataset.route === route) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current'); });
      if (route === 'roles') { if (!nav.settings.roles) { say('Only the active company owner can manage role permissions.', true); return; } await loadEditor(); }
      else if (route === 'role-profiles') { if (!nav.settings.roles) { say('Only the active company owner can manage named profiles.', true); return; } window.RoleProfiles.mount({ nav, route, content, escape, say, request, ticket, current: isCurrent, verify: expectedRevision => freshIdentity(expectedRevision) }); }
      else if (window.WorkspaceActions?.routes[route]) { window.WorkspaceActions.mount({ nav, route, content, escape, say, request, ticket, current: isCurrent, companyId, getNav: () => nav, verify: revision => freshIdentity(revision, false) }); }
      else { say(''); directory(); }
    } catch (error) {
      if (mark !== sequence && !error.identityChanged) return;
      clearPrivate(); say(error.status === 404 || error.status === 503 ? 'This workspace is not available for this company yet.' : error.message, true);
      if (error.status === 402) {
        const current = sequence;
        try { const access = await request('/api/account-access'); if (current !== sequence || signingOut) return; say(access.reason || 'Company workspace access is locked.', true); const help = document.createElement('p'); help.textContent = 'Contact your company owner to restore access. Billing changes are unavailable in this draft. You can sign out above.'; content.append(help); }
        catch (denied) { if (current === sequence && !signingOut) { say(denied.message, true); signInLink(); } }
      } else if ([401, 403, 404].includes(error.status)) signInLink();
    }
  }
  async function perform(kind, record) {
    if (busy || route !== 'roles' || !nav?.settings.roles) return;
    busy = true; confirmed = false; const mark = ticket();
    try {
      await freshIdentity(record ? undefined : kind === 'confirm' ? proof.tenantRevision : state.tenantRevision);
      if (!isCurrent(mark, true)) return;
      if (!record) {
        const body = kind === 'preview' ? { requestId: crypto.randomUUID(), expectedRevision: state.tenantRevision, reason: reason.trim(), policies: copy(proposed) } : { previewId: proof.previewId, version: proof.version, requestId: crypto.randomUUID(), confirmed: true };
        record = { kind, body, identity, sent: false }; if (kind === 'confirm') recovery.remember('roles', record); records.set(identity, record);
      }
      if (record.kind === 'confirm') recovery.remember('roles', record);
      stage = 'recovery'; renderEditor(); record.sent = true;
      const result = await request(root + '/' + record.kind, { method: 'POST', body: JSON.stringify(record.body) });
      record.result = result;
      let cleanupError; if (record.kind === 'confirm') { try { recovery.forget('roles', record); } catch (storageError) { record.cleanupPending = true; cleanupError = storageError; } }
      if (!isCurrent(mark, true)) { record.result = result; return; }
      await freshIdentity(); if (!isCurrent(mark, true)) { record.result = result; return; } if (cleanupError) throw cleanupError;
      records.delete(record.identity); outcome = '';
      if (record.kind === 'preview') { proof = result; proposed = copy(record.body.policies); reason = record.body.reason; stage = 'review'; }
      else {
        stage = 'saved'; outcome = `Permission changes saved. Policy revision ${result.policyRevision}. Request ${result.requestId}.`; proof = null;
        const nextState = await request(root); if (!isCurrent(mark, true)) return;
        let nextAudit = await request(root + '/audit'); if (!isCurrent(mark, true)) return;
        if (nextAudit.total > 100) { nextAudit = await request(root + '/audit?offset=' + (nextAudit.total - 100)); if (!isCurrent(mark, true)) return; }
        await freshIdentity(nextState.tenantRevision); if (!isCurrent(mark, true)) return;
        state = nextState; audit = nextAudit; proposed = currentRows(state);
      }
    } catch (error) {
      if (!isCurrent(mark, true)) return;
      if (error.status === 401 || error.status === 402 || error.status === 403) { state = registry = proposed = proof = audit = null; content.replaceChildren(); say('Your access changed. Reopen the workspace to verify your current identity.', true); }
      else if (error.status >= 400 && error.status < 500) {
        if (record?.kind === 'confirm' && record.hadUncertain && !record.result) { record.unresolved = true; try { recovery.unresolved('roles', record); } catch (storageError) { say(storageError.message, true); } await loadEditor(); } else if (record) { try { if (record.kind === 'confirm') recovery.forget('roles', record); records.delete(record.identity); } catch (storageError) { record.unresolved = true; say(storageError.message, true); } } stage = 'stale'; proof = null;
        outcome = record?.kind === 'confirm' && record.result ? `The original save succeeded at policy revision ${record.result.policyRevision}. This request no longer matches current company settings. Refresh current permissions.` : error.message + (record?.hadUncertain ? ' The earlier request result remains unknown. Review current permissions before a new preview.' : ' Refresh current permissions before a new preview.');
      }
      else if (record?.result && record.kind === 'confirm') { records.delete(record.identity); stage = 'saved'; proof = null; outcome = 'The original save succeeded at policy revision ' + record.result.policyRevision + '. Request ' + record.body.requestId + '. Current permissions could not be refreshed. Use Review current permissions.' + (record.cleanupPending ? ' This tab could not clear its recovery identity; after a reload, check the original result again.' : ''); }
      else if (record && (error.uncertain || record.result)) { record.hadUncertain = true; stage = 'recovery'; outcome = error.message; }
      else { if (record) records.delete(record.identity); stage = 'editing'; proof = null; outcome = error.message + (error.status === 409 ? ' Review current settings before making another change.' : ''); }
    } finally { busy = false; renderEditor(); }
  }
  async function reconcile() {
    const record = pending(); if (busy || !record?.unresolved || record.reviewRevision !== state?.tenantRevision || route !== 'roles') return;
    busy = true; const mark = ticket(), reviewedRevision = record.reviewRevision; renderEditor();
    try { await freshIdentity(reviewedRevision); if (!isCurrent(mark, true)) return; await loadEditor(); if (!isCurrent(mark, true) || !state || !audit) return; if (state.tenantRevision !== reviewedRevision) { outcome = 'The company changed. Review current permissions and activity again before acknowledging the earlier unknown result.'; return; } recovery.forget('roles', record); records.delete(record.identity); stage = 'editing'; outcome = 'Current permissions and activity reviewed. The earlier request result remains unknown. Request ' + record.body.requestId + '.'; }
    catch (error) { if (isCurrent(mark, true)) { if ([401, 402, 403].includes(error.status)) { state = registry = proposed = proof = audit = null; confirmed = false; content.replaceChildren(); say('Your access changed. Reopen the workspace to verify your current identity.', true); } else { if (error.status === 409) await loadEditor(); say(error.message + ' Review current permissions and activity again.', true); } } }
    finally { busy = false; renderEditor(); }
  }
  content.addEventListener('input', event => { if (event.target.id === 'policy-reason' && !busy) reason = event.target.value; });
  content.addEventListener('change', event => {
    if (busy) return;
    if (event.target.id === 'explicit-confirm') { confirmed = event.target.checked; updateExpiry(); return; }
    const { family, role, action } = event.target.dataset;
    if (family && stage === 'editing' && !pending()) { const domain = registry.domains.find(row => row.id === family); if (!domain?.ceilings[role]?.[action]) return; proposed[family][role][action] = event.target.checked; const cell = event.target.closest('label').querySelector('.cell'); const current = currentRows(state)[family][role][action]; cell.children[1].textContent = 'Proposed: ' + (event.target.checked ? 'Allowed' : 'Blocked'); cell.children[1].className = current !== event.target.checked ? 'changed' : ''; }
  });
  content.addEventListener('click', event => {
    const button = event.target.closest('button'); if (!button || button.disabled) return;
    if (button.id === 'close-editor') { confirmed = false; proof = null; outcome = ''; location.hash = 'projects'; return; }
    if (busy) return;
    if (button.id === 'preview-policy') { if (!reason.trim()) { say('Enter a reason before previewing.', true); $('#policy-reason').focus(); return; } const errors = proposalErrors(proposed); if (errors.length) { say(errors.join(' '), true); return; } say(''); perform('preview'); }
    if (button.id === 'confirm-policy' && confirmed && proof && Date.parse(proof.expiresAt) > Date.now()) perform('confirm');
    if (button.id === 'reconcile-request') reconcile();
    if (button.id === 'recover-request' && pending() && !pending().unresolved) perform(pending().kind, pending());
    if (button.id === 'refresh-policy') { outcome = ''; loadEditor(); }
    if (button.id === 'edit-proposal') { outcome = ''; loadEditor({ preserveProposal: true }); }
    if (button.id === 'reset-defaults') { proposed = copy(state.defaults); renderEditor(); }
    if (button.dataset.auditOffset) {
      const mark = ticket(); request(root + '/audit?offset=' + button.dataset.auditOffset).then(async data => {
        if (!isCurrent(mark, true)) return; await freshIdentity(); if (!isCurrent(mark, true)) return; audit = data; renderEditor();
      }).catch(error => { if (!isCurrent(mark, true)) return; if ([401, 402, 403].includes(error.status)) { state = registry = proposed = proof = audit = null; content.replaceChildren(); } say(error.message, true); });
    }
  });
  window.addEventListener('hashchange', enter);
  document.querySelector('nav').addEventListener('click', event => { const link = event.target.closest('[data-route]'); if (link?.dataset.route === route && !busy) { event.preventDefault(); enter(); } });
  async function resume() {
    if (signingOut) return;
    confirmed = false; updateExpiry(); if (!nav) return;
    const old = identity, oldRevision = nav.tenantRevision, mark = ticket();
    try { const data = await request('/api/navigation'); if (mark.companyId !== companyId() || mark.sequence !== sequence) return; applyNavigation(data); if (old !== identity || window.WorkspaceActions?.routes[route] && oldRevision !== data.tenantRevision) await enter(); else if (route === 'role-profiles') window.RoleProfiles?.revalidate(data.tenantRevision); else if (route === 'roles' && proof && data.tenantRevision !== proof.tenantRevision) { proof = null; stage = pending() ? 'recovery' : 'editing'; outcome = 'The company changed. Refresh current permissions and preview again.'; renderEditor(); } }
    catch (error) { if (mark.sequence === sequence) { clearPrivate(); say('Your session or workspace access changed. Sign in again to verify your identity.', true); signInLink(); } }
  }
  $('#workspace-sign-out').onclick = async () => {
    if (signingOut) return;
    const selected = companyId(), destination = window.WorkspaceEntry.login(selected, '#' + route), button = $('#workspace-sign-out');
    signingOut = true; button.disabled = true; clearPrivate(); say('Signing out.');
    try { await request('/api/auth/logout', { method: 'POST', body: '{}' }); try { localStorage.removeItem('pdl-role'); localStorage.removeItem('pdl-company-id'); } catch {} location.replace(destination); }
    catch { signingOut = false; button.disabled = false; say('The sign-out result could not be verified. Try Sign out again; your workspace data has been cleared from this page.', true); }
  };
  window.addEventListener('focus', resume);
  window.addEventListener('blur', () => { confirmed = false; const checkbox = $('#explicit-confirm'); if (checkbox) checkbox.checked = false; updateExpiry(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) { confirmed = false; const checkbox = $('#explicit-confirm'); if (checkbox) checkbox.checked = false; updateExpiry(); } else resume(); });
  setInterval(updateExpiry, 1000);
  enter();
})();
