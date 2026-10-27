'use strict';

// Project safety is served by the same authenticated, tenant-scoped API as the daily.
// Draft input lives only in this open dialog; it is cleared when the account changes.
(function () {
  const TRADES = ['roofing', 'excavation', 'framing', 'demolition'];
  const LABELS = { roofing: 'Roofing', excavation: 'Excavation', framing: 'Framing', demolition: 'Demolition' };
  const STATUS = { pending: 'Needs check', pass: 'Checked', fail: 'Failed — unresolved', deferred: 'Deferred — unresolved', not_applicable: 'Not applicable' };
  const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  const sourceLink = source => {
    const value = typeof source === 'string' ? source : source?.url;
    try { const url = new URL(value); return url.protocol === 'https:' ? `<a href="${esc(url.href)}" target="_blank" rel="noopener noreferrer">Read the rule source ↗</a>` : ''; } catch { return ''; }
  };
  const statusLabel = status => STATUS[status] || 'Needs review';
  const dateTime = value => { const date = new Date(value); return Number.isFinite(date.valueOf()) ? date.toLocaleString() : ''; };
  const catalogRows = catalog => Array.isArray(catalog) ? catalog : Array.isArray(catalog?.activities) ? catalog.activities : [];
  const unresolved = day => (day?.hazards || []).filter(item => item.status !== 'verified');

  function reportSafetyEvidenceMarkup(report, projectId) {
    const evidence = report?.safetyEvidence;
    if (!evidence || typeof evidence !== 'object') return '';
    const checks = Array.isArray(evidence.checks) ? evidence.checks : [];
    const hazards = [...(Array.isArray(evidence.hazards) ? evidence.hazards : []), ...(Array.isArray(evidence.carriedHazards) ? evidence.carriedHazards : [])];
    const count = Number.isSafeInteger(evidence.summary?.unresolved) ? evidence.summary.unresolved : checks.filter(check => ['fail', 'deferred'].includes(check.status)).length + hazards.filter(hazard => hazard.status !== 'verified').length;
    const hazardStatus = status => status === 'verified' ? 'Verified closed' : status === 'corrected' ? 'Corrected - needs verification' : 'Open - unresolved';
    const details = hazards.map(hazard => `<li><strong>${esc(hazard.observation || 'Safety hazard')}</strong><span class="safety-evidence-status">${esc(hazardStatus(hazard.status))}</span>${hazard.date ? `<small>Originally recorded ${esc(hazard.date)}</small>` : ''}<p>${esc(hazard.location || 'Location not recorded')}</p><p>Action: ${esc(hazard.action || 'Not recorded')}</p><p>Follow-up: ${esc(hazard.owner || 'Unassigned')}${hazard.dueDate ? ` · due ${esc(hazard.dueDate)}` : ''}</p>${hazard.verification ? `<p>Verification: ${esc(hazard.verification)}</p>` : ''}${hazard.workStopped ? '<small>Affected work recorded as stopped.</small>' : ''}</li>`).join('');
    return `<section class="report-safety-evidence" data-safety-evidence><div class="safety-evidence-heading"><div><small>SAVED DAILY EVIDENCE</small><h3>Safety record at submission</h3></div><strong class="safety-evidence-total ${count ? 'is-unresolved' : ''}">${esc(count)} unresolved</strong></div><p class="safety-evidence-meta">${esc(evidence.date || report.dateIso || '')} · saved revision ${esc(evidence.dayRevision)} · ${esc(evidence.ruleVersion || 'Rule version not recorded')}${evidence.capturedAt ? ` · captured ${esc(dateTime(evidence.capturedAt))}` : ''}</p><p>This is the safety snapshot saved with this daily, not the current project record. Unresolved items remain unresolved in this snapshot even if corrected later.</p><details><summary>Inspection responses (${checks.length})</summary><ol>${checks.map(check => `<li><strong>${esc(check.title || check.id)}</strong><span class="safety-evidence-status">${esc(statusLabel(check.status))}</span><small>Recorded by ${esc(check.inspector || 'Not recorded')}${check.competentPerson ? ` · competent person: ${esc(check.competentPerson)}` : ''}</small><p>Findings: ${esc(check.notes || 'Not recorded')}</p>${check.action ? `<p>Action: ${esc(check.action)}</p>` : ''}${check.owner ? `<p>Follow-up: ${esc(check.owner)}${check.dueDate ? ` · due ${esc(check.dueDate)}` : ''}</p>` : ''}</li>`).join('')}</ol></details>${hazards.length ? `<details><summary>Hazards and carried follow-up (${hazards.length})</summary><ol>${details}</ol></details>` : '<p>No hazards were included in this saved record. This is not a hazard-free certification.</p>'}${Number.isSafeInteger(Number(projectId)) && Number(projectId) > 0 ? `<button type="button" class="secondary" data-open-safety-pm data-project-id="${esc(projectId)}" data-date="${esc(evidence.date || report.dateIso || '')}">Open current safety record</button>` : ''}</section>`;
  }

  // Exposed only for plain renderer tests; Node never initializes a browser session.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { esc, sourceLink, statusLabel, catalogRows, unresolved, reportSafetyEvidenceMarkup };
    return;
  }

  let active = null, sequence = 0, dialog = null, returnFocus = null;
  const user = () => typeof currentUser === 'undefined' ? null : currentUser;
  const identity = () => JSON.stringify([
    typeof signedInCompanyId === 'function' ? signedInCompanyId() : '',
    typeof company === 'undefined' ? '' : company?.id,
    user()?.id, user()?.role, user()?.projectIds, user()?.permissions, user()?.assignedCrews,
    typeof currentRole === 'undefined' ? '' : currentRole
  ]);
  const permitted = () => user()?.id && ['owner', 'admin', 'project_manager', 'foreman', 'field'].includes(user()?.role);
  const projectList = () => typeof projects === 'undefined' ? [] : projects.filter(project => !project.archived);
  const today = () => typeof companyTodayIso === 'function' ? companyTodayIso() : new Date().toISOString().slice(0, 10);
  const current = state => Boolean(state && active === state && state.sequence === sequence && state.identity === identity() && permitted() && dialog?.open);
  const base = state => `/api/projects/${encodeURIComponent(state.projectId)}/safety`;
  const dayBase = state => `${base(state)}/days/${encodeURIComponent(state.date)}`;
  const value = (form, name) => String(new FormData(form).get(name) || '').trim();

  function close() {
    sequence++;
    active?.controller?.abort();
    active = null;
    if (dialog?.open) dialog.close();
    if (dialog) dialog.querySelector('[data-safety-body]').replaceChildren();
    if (returnFocus?.isConnected) returnFocus.focus();
  }

  function notice(state, text, error = false) {
    if (!current(state)) return;
    const target = dialog.querySelector('[data-safety-notice]');
    target.textContent = text;
    target.hidden = !text;
    target.setAttribute('role', error ? 'alert' : 'status');
    target.classList.toggle('is-error', error);
  }

  function busy(state, enabled) {
    if (!current(state)) return;
    state.busy = enabled;
    dialog.querySelector('[data-safety-body]').setAttribute('aria-busy', String(enabled));
    dialog.querySelectorAll('[data-safety-body] button,[data-safety-body] input,[data-safety-body] select,[data-safety-body] textarea,[data-safety-context] input,[data-safety-context] select,[data-safety-reload]').forEach(node => { node.disabled = enabled; });
  }

  function captureDrafts(state, except) {
    if (!current(state)) return [];
    return [...dialog.querySelectorAll('form[data-form-key]')].filter(form => form.dataset.dirty === 'true' && form.dataset.formKey !== except).map(form => ({
      key: form.dataset.formKey,
      revision: form.dataset.revision,
      open: form.closest('details')?.open,
      values: [...form.querySelectorAll('input,textarea,select')].map(node => ({ name: node.name, value: node.value, checked: node.checked }))
    }));
  }

  function restoreDrafts(state, drafts) {
    for (const draft of drafts) {
      const form = [...dialog.querySelectorAll('form[data-form-key]')].find(node => node.dataset.formKey === draft.key);
      if (!form) continue;
      form.dataset.revision = draft.revision;
      form.dataset.dirty = 'true';
      for (const saved of draft.values) {
        const node = [...form.elements].find(input => input.name === saved.name && (input.type !== 'checkbox' || input.value === saved.value));
        if (!node) continue;
        node.value = saved.value;
        if (node.type === 'checkbox') node.checked = saved.checked;
      }
      if (draft.open && form.closest('details')) form.closest('details').open = true;
      revealConditional(form);
    }
    state.dirty = drafts.length > 0;
  }

  function revisionField(state) { return esc(state.data?.day?.revision || 0); }
  function fields(names, initial = {}) {
    return names.map(([name, label, type, required]) => `<label>${esc(label)}${type === 'textarea' ? `<textarea name="${name}" rows="2" maxlength="${name === 'observation' ? 1000 : 1000}" ${required ? 'required' : ''}>${esc(initial[name])}</textarea>` : `<input name="${name}" type="${type || 'text'}" value="${esc(initial[name])}" ${required ? 'required' : ''} ${type !== 'date' ? 'maxlength="300"' : ''}>`}</label>`).join('');
  }

  function photoPicker(state) {
    const rows = typeof photos === 'undefined' ? [] : photos;
    const projectIndex = typeof projects === 'undefined' ? -1 : projects.findIndex(project => Number(project.id) === Number(state.projectId));
    const available = rows.filter(photo => !photo.deletedAt && (Number(photo.projectId) === Number(state.projectId) || projectIndex >= 0 && Number(photo.project) === projectIndex));
    return `<label>Attach a project photo (optional)<select name="photoId"><option value="">No photo selected</option>${available.map(photo => `<option value="${esc(photo.id)}">${esc(photo.caption || 'Project photo')}${photo.createdAt ? ` · ${esc(dateTime(photo.createdAt))}` : ''}</option>`).join('')}</select></label>`;
  }

  function hazardStopControl(hazard) {
    return `<label class="safety-checkbox"><input type="checkbox" name="workStopped" ${hazard.workStopped === true ? 'checked' : ''}><span>Affected work has been stopped pending resolution</span></label>`;
  }

  function profileMarkup(state) {
    const profile = state.data.profile || {}, configured = profile.enabled === true;
    if (!state.data.canManage) return !configured ? '<div class="safety-empty"><h3>Safety checks are not enabled here yet</h3><p>Ask the project manager or account owner to confirm the project’s safety setup.</p></div>' : '';
    return `<details class="safety-setup" ${configured ? '' : 'open'}><summary>Project safety setup <span>${configured ? 'Enabled' : 'Set up this project'}</span></summary><form data-form-key="profile" data-safety-profile data-revision="${esc(profile.revision || 0)}"><p>Choose the work actually performed. Scheduled activities can add checks; the daily scope check confirms field changes.</p><div class="safety-grid">${fields([['employer', 'Employer responsible for this record', 'text', true]], { employer: profile.employer || (typeof company === 'undefined' ? '' : company?.name) })}<label>Job jurisdiction<select name="state"><option value="OR" ${profile.state === 'OR' ? 'selected' : ''}>Oregon — starter coverage</option>${profile.state && profile.state !== 'OR' ? `<option value="${esc(profile.state)}" selected>${esc(profile.state)} — manual review needed</option>` : ''}</select></label></div><fieldset><legend>Work on this project</legend><div class="safety-trades">${TRADES.map(trade => `<label class="safety-checkbox"><input type="checkbox" name="activities" value="${trade}" ${(profile.activities || []).includes(trade) ? 'checked' : ''}><span>${LABELS[trade]}</span></label>`).join('')}</div></fieldset><label class="safety-checkbox"><input name="enabled" type="checkbox" ${configured ? 'checked' : ''}><span>Require safety documentation for this project’s daily reports</span></label><p class="safety-help">Verify the job’s jurisdiction. These starter checks do not cover every hazard or employer program. A setup change requires a fresh review of affected daily checks.</p><button class="primary" type="submit">Save project setup</button></form></details>`;
  }

  function demoMarkup(state) {
    if (!state.data.canManage) return '';
    const catalog = catalogRows(state.data.catalog);
    return `<details class="safety-demo"><summary>Prepare a prospect demo <span>Preview only</span></summary><p>Pick the company’s trade to see the available starter coverage before promising a demo.</p><div class="safety-grid"><label>Company you are meeting<input data-demo-company maxlength="120" placeholder="Company name"></label><label>Trade<select data-demo-trade>${TRADES.map(trade => `<option value="${trade}">${LABELS[trade]}</option>`).join('')}</select></label></div><div data-demo-preview class="safety-demo-preview"></div><button type="button" class="secondary" data-demo-use>Use this trade in project setup</button><p class="safety-help">A demo preview is not saved to this project and does not activate or approve rules. New trades and states need reviewed coverage before they are offered.</p><div data-demo-catalog hidden>${esc(JSON.stringify(catalog))}</div></details>`;
  }

  function checkMarkup(state, check) {
    const initial = { ...check, inspector: check.inspector || user()?.name || '' }, status = check.status || 'pending', needsPerson = check.requiresCompetentPerson === true;
    return `<article class="safety-check safety-status-${esc(status)}"><div class="safety-check-head"><div><small>${esc(check.activity === 'general' ? 'Site check' : LABELS[check.activity] || check.activity || 'Site check')}${check.timing ? ` · ${esc(check.timing)}` : ''}</small><h3>${esc(check.title)}</h3></div><span class="safety-state">${esc(statusLabel(status))}</span></div>${check.description ? `<p>${esc(check.description)}</p>` : ''}<details class="safety-response"><summary>${status === 'pending' ? 'Record check' : 'Review or update response'}</summary><form data-form-key="check-${esc(check.id)}" data-safety-check="${esc(check.id)}" data-revision="${revisionField(state)}"><div class="safety-grid"><label>Response<select name="status" required><option value="pending" ${status === 'pending' ? 'selected' : ''}>Choose a response</option>${['pass', 'fail', 'deferred', 'not_applicable'].map(option => `<option value="${option}" ${status === option ? 'selected' : ''}>${esc(STATUS[option])}</option>`).join('')}</select></label>${fields([['inspector', 'Person recording the check', 'text', true]], initial)}${needsPerson ? fields([['competentPerson', 'Competent person who inspected this work', 'text', true]], initial) : ''}</div>${needsPerson ? '<p class="safety-help">Record the actual designated competent person. Entering a name does not establish qualification or site presence.</p>' : ''}${fields([['notes', 'Findings or reason this does not apply', 'textarea']], initial)}<div data-response-unresolved ${['fail', 'deferred'].includes(status) ? '' : 'hidden'}><div class="safety-warning">This remains unresolved. Record the protection or work stoppage and follow-up; a documented response does not clear the work.</div>${fields([['action', 'Immediate protection / corrective action', 'textarea']], initial)}<div class="safety-grid">${fields([['owner', 'Person responsible for follow-up', 'text'], ['dueDate', 'Follow-up due date', 'date']], initial)}</div><label class="safety-checkbox"><input type="checkbox" name="workStopped" ${check.workStopped ? 'checked' : ''}><span>Affected work is stopped pending resolution</span></label></div><div class="safety-form-actions"><button class="primary" type="submit">Save response</button></div></form></details><details class="safety-rule"><summary>Why this check appears</summary><p>${esc(check.ruleVersion || state.data.day?.ruleVersion || '')}</p>${sourceLink(check.source)}</details>${check.updatedBy || check.updatedAt ? `<small class="safety-help">Last recorded by ${esc(check.updatedBy || '')}${check.updatedAt ? ` · ${esc(dateTime(check.updatedAt))}` : ''}</small>` : ''}</article>`;
  }

  function hazardMarkup(state, hazard) {
    const status = hazard.status || 'open', canVerify = state.data.canManage;
    return `<article class="safety-hazard ${status === 'verified' ? 'is-verified' : ''}"><div class="safety-check-head"><div><small>${esc(hazard.location || 'Location not recorded')}</small><h3>${esc(hazard.observation)}</h3></div><span class="safety-state">${esc(status === 'verified' ? 'Verified closed' : status === 'corrected' ? 'Corrected — verify' : 'Open hazard')}</span></div><p>${esc(hazard.action || 'No immediate action recorded.')}</p><small class="safety-help">Follow-up: ${esc(hazard.owner || 'Unassigned')}${hazard.dueDate ? ` · due ${esc(hazard.dueDate)}` : ''}${hazard.date && hazard.date !== state.date ? ` · reported ${esc(hazard.date)}` : ''}</small>${hazard.workStopped ? '<p class="safety-work-stopped">Affected work stopped</p>' : ''}${hazard.photoId ? `<p class="safety-help">Project photo attached</p>` : ''}${hazard.date && hazard.date !== state.date ? `<button type="button" class="secondary" data-safety-select-date="${esc(hazard.date)}">Open ${esc(hazard.date)} follow-up</button>` : ''}${status !== 'verified' && (!hazard.date || hazard.date === state.date) ? `<details class="safety-response"><summary>Update follow-up</summary><form data-form-key="hazard-${esc(hazard.id)}" data-safety-hazard-update="${esc(hazard.id)}" data-revision="${revisionField(state)}"><label>Status<select name="status"><option value="open" ${status === 'open' ? 'selected' : ''}>Open — follow-up needed</option><option value="corrected" ${status === 'corrected' ? 'selected' : ''}>Corrected — needs verification</option>${canVerify ? '<option value="verified">Verified closed by PM / office</option>' : ''}</select></label>${fields([['action', 'Corrective action', 'textarea'], ['owner', 'Responsible person', 'text'], ['dueDate', 'Follow-up due date', 'date'], ['verification', 'Verification findings', 'textarea']], hazard)}${hazardStopControl(hazard)}<button class="primary" type="submit">Save follow-up</button></form></details>` : hazard.verification ? `<p>${esc(hazard.verification)}</p>` : ''}</article>`;
  }

  function dayMarkup(state) {
    const day = state.data.day, profile = state.data.profile || {};
    if (!profile.enabled) return '';
    if (!day) return '<section class="safety-empty"><h3>Prepare today’s checks</h3><p>Use the project setup and scheduled work to prepare the record. Confirm actual site conditions before work starts.</p><button class="primary" type="button" data-safety-generate>Prepare checks</button></section>';
    const summary = day.summary || {}, checks = day.checks || [], hazards = day.hazards || [], count = checks.filter(check => check.status !== 'pending').length;
    const stale = summary.stale === true;
    const banner = stale ? 'Work or setup changed. Refresh checks before recording or submitting this daily.' : summary.pending > 0 ? 'Required checks still need a response.' : summary.unresolved > 0 || unresolved(day).length ? 'Documentation recorded. Unresolved safety issues still need action.' : summary.readyForWork ? 'Required starter checks are recorded. Continue to monitor changing conditions.' : 'Review required checks and project coverage before proceeding.';
    const older = (state.data.openHazards || []).filter(hazard => !hazards.some(item => item.id === hazard.id));
    return `<section class="safety-day"><div class="safety-progress"><div><small>DAILY SAFETY RECORD</small><h3>${count} of ${checks.length} checks recorded</h3><p>${esc(banner)}</p></div><strong class="safety-open-count">${Number(summary.unresolved || 0)}<span>unresolved</span></strong></div><div class="safety-progress-track" role="progressbar" aria-label="Checks recorded" aria-valuenow="${count}" aria-valuemin="0" aria-valuemax="${checks.length || 1}"><span style="width:${checks.length ? Math.round(count / checks.length * 100) : 0}%"></span></div>${summary.error ? `<p class="safety-warning">${esc(summary.error)}</p>` : ''}<div class="safety-day-toolbar"><p class="safety-help">${esc((day.activities || []).map(trade => LABELS[trade] || trade).join(' · '))}</p><button type="button" class="secondary" data-safety-generate>${stale ? 'Refresh changed checks' : 'Refresh from schedule'}</button></div><div class="safety-checks">${checks.map(check => checkMarkup(state, check)).join('')}</div><section class="safety-hazards-section"><div class="safety-section-title"><div><small>SEE IT. RECORD IT. FOLLOW THROUGH.</small><h3>Hazards & corrective actions</h3></div><button type="button" class="secondary" data-safety-open-hazard>＋ Flag a hazard</button></div><p class="safety-help">Saved hazards appear in this project’s safety view. No email, SMS or push alert is sent by this MVP.</p><details class="safety-hazard-create"><summary>Record a hazard</summary><form data-form-key="new-hazard" data-safety-hazard-create data-revision="${revisionField(state)}">${fields([['observation', 'What is the hazard?', 'textarea', true], ['location', 'Where is it?', 'text', true], ['action', 'Immediate protective action', 'textarea', true]], {})}<div class="safety-grid">${fields([['owner', 'Person responsible for follow-up', 'text', true], ['dueDate', 'Due date', 'date', true]], {})}</div>${photoPicker(state)}<label class="safety-checkbox"><input name="workStopped" type="checkbox"><span>Affected work has been stopped</span></label><p class="safety-help">Respond to immediate danger on site first. This record is not an emergency dispatch.</p><button class="primary" type="submit">Save hazard</button></form></details><div class="safety-hazards">${hazards.length ? hazards.map(hazard => hazardMarkup(state, hazard)).join('') : '<p class="safety-help">No hazards recorded for this date. That is not a hazard-free certification.</p>'}${older.length ? `<h4>Earlier unresolved hazards</h4>${older.map(hazard => hazardMarkup(state, hazard)).join('')}<p class="safety-help">Select the hazard’s original date to update its record.</p>` : ''}</div></section><details class="safety-history"><summary>Evidence history (${(day.history || []).length})</summary><ol>${(day.history || []).slice().reverse().map(entry => `<li><strong>${esc(entry.action || entry.type || 'Updated')}</strong><small>${esc(entry.by || entry.actor?.name || entry.actor || '')} · ${esc(dateTime(entry.at))}</small>${entry.checkId ? `<span>Check: ${esc(entry.checkId)}</span>` : ''}${entry.hazardId ? `<span>Hazard: ${esc(entry.hazardId)}</span>` : ''}</li>`).join('')}</ol><p class="safety-help">Rule pack: ${esc(day.ruleVersion)} · daily revision ${esc(day.revision)}</p></details></section>`;
  }

  function paint(state, drafts = []) {
    if (!current(state)) return;
    dialog.querySelector('[data-safety-body]').innerHTML = `<p class="safety-coverage">Oregon starter checks · not a compliance certification</p>${state.data.coverage === 'manual-review' ? '<div class="safety-warning">This jurisdiction has no reviewed starter pack. Manual safety review is required; the daily cannot be finalized through this pack.</div>' : ''}${profileMarkup(state)}${dayMarkup(state)}${demoMarkup(state)}`;
    restoreDrafts(state, drafts);
    dialog.querySelectorAll('form[data-safety-check]').forEach(revealConditional);
    renderDemo(state);
  }

  function renderDemo(state) {
    if (!current(state)) return;
    const host = dialog.querySelector('[data-demo-preview]');
    if (!host) return;
    const trade = dialog.querySelector('[data-demo-trade]').value;
    const prospect = dialog.querySelector('[data-demo-company]').value.trim();
    const pack = catalogRows(state.data.catalog).find(row => row.id === trade || row.activity === trade);
    host.innerHTML = `<small>DEMO BRIEF${prospect ? ` · ${esc(prospect)}` : ''}</small><h4>${esc(LABELS[trade])} in Oregon</h4><p>${esc(pack?.description || 'Coverage for this trade needs review before a demo is promised.')}</p><ol><li>Prepare activity checks from the daily schedule.</li><li>Record an inspection and demonstrate a failed check.</li><li>Assign a hazard, review the daily, then verify the correction.</li></ol><p><strong>${pack ? 'Starter workflow available for preview' : 'Coverage review needed'}</strong> · not a compliance determination</p>${sourceLink(pack?.source)}`;
  }

  async function load(state, options = {}) {
    if (!current(state)) return;
    const request = ++state.load;
    busy(state, true);
    try {
      const data = await api(`${base(state)}?date=${encodeURIComponent(state.date)}`, { signal: state.controller.signal });
      if (!current(state) || request !== state.load) return;
      state.data = data;
      if (options.preserve) {
        notice(state, 'This record changed. Your unsaved input is still here. Use Reload to review the latest saved record before re-entering it.', true);
      } else {
        paint(state, options.drafts || []);
        notice(state, options.message || '');
      }
    } catch (error) {
      if (current(state) && request === state.load) notice(state, error.message || 'Safety checks could not be loaded.', true);
    } finally { if (current(state) && request === state.load) busy(state, false); }
  }

  async function mutate(state, path, method, input, form, message) {
    if (!current(state) || state.busy) return;
    const drafts = captureDrafts(state, form?.dataset.formKey);
    busy(state, true);
    notice(state, 'Saving…');
    try {
      await api(path, { method, body: JSON.stringify(input), signal: state.controller.signal });
      if (!current(state)) return;
      await load(state, { drafts, message });
      window.dispatchEvent(new CustomEvent('pdl:safety-updated', { detail: { projectId: state.projectId, date: state.date } }));
    } catch (error) {
      if (!current(state)) return;
      if (error.status === 409) {
        // Obtain current state but preserve both old form revisions and typed input.
        // A retry must not silently rebase a stale response onto a newer inspection.
        await load(state, { preserve: true });
      } else notice(state, `${error.message || 'The save could not be confirmed.'} Your input is still here.`, true);
    } finally { if (current(state)) busy(state, false); }
  }

  function revealConditional(form) {
    if (!form?.hasAttribute('data-safety-check')) return;
    const status = form.elements.status.value, required = ['fail', 'deferred'].includes(status), host = form.querySelector('[data-response-unresolved]');
    host.hidden = !required;
    for (const name of ['action', 'owner', 'dueDate', 'workStopped']) form.elements[name].required = required;
    form.elements.notes.required = status !== 'pending';
    form.elements.notes.placeholder = 'Record the actual conditions, protection and findings you checked.';
  }

  function mount() {
    if (dialog) return;
    dialog = document.createElement('dialog');
    dialog.id = 'safety-pm-dialog';
    dialog.className = 'safety-pm-dialog';
    dialog.setAttribute('aria-labelledby', 'safety-pm-title');
    dialog.innerHTML = '<div class="safety-shell"><header class="safety-header"><div><p class="safety-eyebrow">PRO DAILY LINK · PM WORKSPACE</p><h2 id="safety-pm-title">Safety today</h2><p>Know the work. Record the check. Close the loop.</p></div><button type="button" class="safety-close" data-safety-close aria-label="Close safety workspace">×</button></header><div class="safety-context" data-safety-context><label>Project<select data-safety-project></select></label><label>Work date<input type="date" data-safety-date required></label><button type="button" class="secondary" data-safety-reload>Reload</button></div><p data-safety-notice role="status" aria-live="polite" class="safety-notice" hidden></p><main data-safety-body></main><footer class="safety-footer">This record supports your safety program. It does not replace competent-person judgment, employer responsibilities or an emergency response.</footer></div>';
    document.body.append(dialog);
    dialog.addEventListener('cancel', event => { if (active?.dirty && !confirm('Close safety checks? Unsaved input will be lost.')) event.preventDefault(); else close(); });
    dialog.addEventListener('close', () => { if (!dialog.open && active) close(); });
    dialog.addEventListener('input', event => { const state = active; if (!current(state)) return; const form = event.target.closest('form'); if (form) { state.dirty = true; form.dataset.dirty = 'true'; } if (event.target.matches('[data-demo-company],[data-demo-trade]')) renderDemo(state); });
    dialog.addEventListener('change', event => {
      const state = active;
      if (!current(state)) return;
      if (event.target.matches('[data-safety-project],[data-safety-date]')) {
        if (state.dirty && !confirm('Change project or date? Unsaved safety input will be lost.')) {
          dialog.querySelector('[data-safety-project]').value = String(state.projectId);
          dialog.querySelector('[data-safety-date]').value = state.date;
          return;
        }
        void open({ projectId: dialog.querySelector('[data-safety-project]').value, date: dialog.querySelector('[data-safety-date]').value });
      }
      if (event.target.name === 'status') revealConditional(event.target.closest('form'));
      if (event.target.matches('[data-demo-trade]')) renderDemo(state);
    });
    dialog.addEventListener('click', event => {
      const button = event.target.closest('button'), state = active;
      if (!button || !current(state)) return;
      if (button.hasAttribute('data-safety-close')) { if (!state.dirty || confirm('Close safety checks? Unsaved input will be lost.')) close(); return; }
      if (button.hasAttribute('data-safety-reload')) { if (!state.dirty || confirm('Reload the latest saved record? Your unsaved input will be lost.')) { state.dirty = false; void load(state); } return; }
      if (button.hasAttribute('data-safety-generate')) { if (state.dirty && !confirm('Refresh the checks? Save or discard your current input first. Discard it now?')) return; void mutate(state, `${base(state)}/days`, 'POST', { date: state.date, revision: state.data.day?.revision || 0 }, null, 'Checks refreshed. Confirm the actual work and site conditions.'); return; }
      if (button.hasAttribute('data-safety-open-hazard')) { const details = dialog.querySelector('.safety-hazard-create'); details.open = true; details.querySelector('textarea').focus(); return; }
      if (button.hasAttribute('data-safety-select-date')) { if (!state.dirty || confirm('Open the earlier record? Unsaved input will be lost.')) void open({ projectId: state.projectId, date: button.dataset.safetySelectDate }); return; }
      if (button.hasAttribute('data-demo-use')) {
        const trade = dialog.querySelector('[data-demo-trade]').value, form = dialog.querySelector('[data-safety-profile]');
        if (!form) return;
        form.querySelectorAll('[name="activities"]').forEach(input => { input.checked = input.value === trade; });
        form.dataset.dirty = 'true'; state.dirty = true;
        form.closest('details').open = true;
        form.scrollIntoView({ block: 'start', behavior: 'smooth' });
        notice(state, 'Trade selected in the project setup. Review and Save project setup to activate it.');
      }
    });
    dialog.addEventListener('submit', event => {
      const form = event.target, state = active;
      if (!current(state) || !form.matches('form[data-form-key]')) return;
      event.preventDefault();
      if (state.busy || !form.reportValidity()) return;
      const revision = Number(form.dataset.revision);
      if (form.hasAttribute('data-safety-profile')) {
        const input = { revision, enabled: form.elements.enabled.checked, state: value(form, 'state'), employer: value(form, 'employer'), activities: [...form.querySelectorAll('[name="activities"]:checked')].map(node => node.value) };
        void mutate(state, `${base(state)}/profile`, 'PUT', input, form, 'Project safety setup saved. Prepare or refresh the day’s checks.');
      } else if (form.hasAttribute('data-safety-check')) {
        if (value(form, 'status') === 'pending') { notice(state, 'Choose a response before saving this check.', true); return; }
        const input = { revision, status: value(form, 'status'), notes: value(form, 'notes'), inspector: value(form, 'inspector'), competentPerson: value(form, 'competentPerson'), action: value(form, 'action'), owner: value(form, 'owner'), dueDate: value(form, 'dueDate'), workStopped: form.elements.workStopped.checked };
        void mutate(state, `${dayBase(state)}/checks/${encodeURIComponent(form.dataset.safetyCheck)}`, 'PATCH', input, form, 'Check recorded. Review any unresolved conditions before work continues.');
      } else if (form.hasAttribute('data-safety-hazard-create')) {
        const input = { revision, observation: value(form, 'observation'), location: value(form, 'location'), action: value(form, 'action'), owner: value(form, 'owner'), dueDate: value(form, 'dueDate'), workStopped: form.elements.workStopped.checked };
        if (value(form, 'photoId')) input.photoId = Number(value(form, 'photoId'));
        void mutate(state, `${dayBase(state)}/hazards`, 'POST', input, form, 'Hazard saved to this project’s safety view. No external alert has been sent.');
      } else if (form.hasAttribute('data-safety-hazard-update')) {
        const input = { revision, status: value(form, 'status'), verification: value(form, 'verification'), action: value(form, 'action'), owner: value(form, 'owner'), dueDate: value(form, 'dueDate'), workStopped: form.elements.workStopped.checked };
        void mutate(state, `${dayBase(state)}/hazards/${encodeURIComponent(form.dataset.safetyHazardUpdate)}`, 'PATCH', input, form, 'Hazard follow-up saved.');
      }
    });
  }

  async function open(options = {}) {
    if (!permitted()) return;
    const available = projectList();
    mount();
    active?.controller?.abort();
    sequence++;
    const projectId = Number(options.projectId) || available[0]?.id;
    const state = { sequence, identity: identity(), projectId, date: /^\d{4}-\d{2}-\d{2}$/.test(String(options.date)) ? options.date : today(), controller: new AbortController(), load: 0, data: {}, dirty: false, busy: false };
    active = state;
    returnFocus = options.opener || document.activeElement;
    dialog.querySelector('[data-safety-project]').innerHTML = available.map(project => `<option value="${esc(project.id)}">${esc(project.name)}</option>`).join('');
    dialog.querySelector('[data-safety-project]').value = String(projectId);
    dialog.querySelector('[data-safety-date]').value = state.date;
    dialog.querySelector('[data-safety-body]').innerHTML = '<p class="safety-empty">Loading the project safety record…</p>';
    if (!dialog.open) dialog.showModal();
    if (!projectId || !available.some(project => Number(project.id) === Number(projectId))) { notice(state, 'Choose an accessible project to open safety checks.', true); return; }
    await load(state);
  }

  document.addEventListener('click', event => {
    if (event.target.closest('#logout-button,#profile-logout-button,#subscription-lock-logout')) { close(); return; }
    const opener = event.target.closest('#report-open-safety,[data-open-safety-pm]');
    if (!opener) return;
    event.preventDefault();
    const reportSelect = document.getElementById('report-project'), reportDate = document.getElementById('report-date');
    const reportProject = opener.closest('#report-modal') && typeof projects !== 'undefined' ? projects[Number(reportSelect?.value)]?.id : null;
    void open({ projectId: opener.dataset.projectId || reportProject, date: opener.dataset.date || (reportProject ? reportDate?.value : undefined), opener });
  });
  if (typeof renderEverything === 'function') {
    const previousRender = renderEverything;
    renderEverything = function (...args) { if (active && active.identity !== identity()) close(); return previousRender.apply(this, args); };
  }
  if (typeof loadRole === 'function') {
    const previousLoadRole = loadRole;
    loadRole = async function (...args) { close(); return previousLoadRole.apply(this, args); };
  }
  if (typeof renderActionCenter === 'function') {
    const previousRenderActions = renderActionCenter;
    renderActionCenter = function (...args) {
      const result = previousRenderActions.apply(this, args);
      for (const item of typeof actionCenter === 'undefined' ? [] : actionCenter.items || []) {
        if (item.type !== 'safety_engine') continue;
        const button = [...document.querySelectorAll('[data-action-id]')].find(node => node.dataset.actionId === String(item.id));
        if (button) button.onclick = () => open({ projectId: item.projectId, date: item.safetyDate, opener: button });
      }
      return result;
    };
  }
  if (typeof renderReports === 'function') {
    const previousRenderReports = renderReports;
    renderReports = function (...args) {
      const result = previousRenderReports.apply(this, args), host = document.getElementById('report-detail');
      if (!host) return result;
      host.querySelectorAll('[data-safety-evidence]').forEach(node => node.remove());
      // Read the actual selected list item after PDL's existing filter/sort wrappers.
      const selected = document.querySelector('#report-list .report-list-item.active')?.dataset.report;
      const report = typeof reports === 'undefined' ? null : reports.find(row => Number(row.id) === Number(selected));
      if (!report?.safetyEvidence) return result;
      const projectId = report.projectId || (typeof projects === 'undefined' ? null : projects[Number(report.project)]?.id);
      const markup = reportSafetyEvidenceMarkup(report, projectId);
      const summary = host.querySelector('.ai-banner');
      if (summary) summary.insertAdjacentHTML('afterend', markup);
      else host.insertAdjacentHTML('beforeend', markup);
      return result;
    };
  }
  window.addEventListener('pagehide', close);
  window.addEventListener('hashchange', close);
  window.addEventListener('storage', event => { if (['pdl-company-id', 'pdl-role'].includes(event.key)) close(); });
  window.PDLSafetyPM = { open, close };
  window.PDLSafety = { open: (projectId, date) => open({ projectId, date }), close };
}());
