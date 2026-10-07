(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PDLProjectAssistant = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const permitted = workspace => workspace?.currentRole === 'office' && Boolean(workspace.user?.id) &&
    ['owner', 'admin', 'project_manager'].includes(workspace.user.role);
  const mascot = '<svg viewBox="0 0 80 80" aria-hidden="true" focusable="false"><path d="M15 41c0-18 10-27 25-27s25 9 25 27v13c0 15-12 24-25 24S15 69 15 54z" fill="#ffb36b" stroke="#492d24" stroke-width="3"/><path d="M12 35c1-18 11-29 28-29s27 11 28 29H12z" fill="#ff751f" stroke="#492d24" stroke-width="3"/><path d="M35 6h10v25H35z" fill="#ffa247"/><path d="M8 34h64v9H8z" fill="#ff751f" stroke="#492d24" stroke-width="3" stroke-linejoin="round"/><ellipse cx="29" cy="51" rx="7" ry="9" fill="white"/><ellipse cx="51" cy="49" rx="7" ry="9" fill="white"/><circle cx="31" cy="52" r="3.5" fill="#492d24"/><circle cx="49" cy="50" r="3.5" fill="#492d24"/><path d="M27 64q14 9 28-5" fill="none" stroke="#492d24" stroke-width="3" stroke-linecap="round"/></svg>';
  function previewMarkup(result) {
    const row = result.proposal;
    if (row.action === 'note' || row.action === 'todo') return `<h3>Review this exact project ${row.action === 'note' ? 'note' : 'to-do'}</h3><dl><dt>Project</dt><dd>${escape(row.projectName)}</dd><dt>Text</dt><dd class="assistant-instructions">${escape(row.text)}</dd><dt>Visibility</dt><dd>${escape(row.visibility)}</dd><dt>Deadline</dt><dd>${row.dueDate ? `${row.deadline === 'today' ? 'Due today: ' : ''}${escape(row.dueDate)} · ${escape(row.timezone)}` : 'No deadline'}</dd>${row.action === 'todo' ? '<dt>Assignee / status</dt><dd>Unassigned · Open</dd>' : ''}<dt>Notifications</dt><dd>${escape(row.notification)}</dd></dl><p>Nothing saved yet. Confirm only if this project and text are correct.</p>`;
    return `<h3>Review this exact assignment</h3><dl><dt>Project</dt><dd>${escape(row.projectName)}</dd><dt>Person</dt><dd>${escape(row.memberName)}</dd><dt>Date and hours</dt><dd>${escape(row.date)} · ${escape(row.start)}–${escape(row.end)} · ${escape(row.timezone)}</dd><dt>Task</dt><dd>${escape(row.activity)}</dd><dt>Daily instructions</dt><dd class="assistant-instructions">${escape(row.instructions)}</dd><dt>Notification</dt><dd>${escape(row.notification)}</dd></dl>${result.conflicts.length ? '<h4>Resolve these conflicts before saving</h4><ul>' + result.conflicts.map(row => `<li>${escape(row.message)} ${escape(row.date)} ${escape(row.start || '')}${row.end ? '–' + escape(row.end) : ''}</li>`).join('') + '</ul>' : '<p>No current conflicts. Availability and access will be checked again when you confirm.</p>'}`;
  }
  function createAssistant({ document, window, getWorkspace, request, onSaved = () => {}, timeoutMs = 25000, SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition }) {
    async function bounded(task) {
      const controller = new AbortController(); let timer;
      try { return await Promise.race([task(controller.signal), new Promise((resolve, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('The request timed out.')); }, timeoutMs); })]); }
      finally { clearTimeout(timer); }
    }
    const boundedRequest = (path, payload) => bounded(signal => request(path, payload, signal));
    const launcher = document.createElement('button'); launcher.type = 'button'; launcher.id = 'project-assistant-launcher'; launcher.hidden = true;
    launcher.className = 'project-assistant-launcher'; launcher.setAttribute('aria-label', 'Open project assistant'); launcher.setAttribute('aria-haspopup', 'dialog'); launcher.innerHTML = mascot;
    const dialog = document.createElement('dialog'); dialog.id = 'project-assistant-dialog'; dialog.className = 'project-assistant-dialog'; dialog.setAttribute('aria-labelledby', 'project-assistant-title');
    dialog.innerHTML = `<div class="assistant-heading"><span class="assistant-mascot">${mascot}</span><div><h2 id="project-assistant-title">Project assistant</h2><p>Schedules, notes &amp; to-dos</p></div><button type="button" class="secondary" data-assistant-close aria-label="Close project assistant">Close</button></div>
      <p class="input-help">Optional AI suggestions for schedules, daily instructions, project notes and to-dos. Review the exact project and details before saving.</p>
      <label>Which project?<select data-assistant-project><option value="">Choose a project</option></select></label>
      <section data-assistant-work hidden>
        <label>What would you like to do?<select data-assistant-action><option value="schedule">Schedule one person's day</option><option value="note">Add a project note</option><option value="todo">Add a project to-do</option></select></label>
        <label>Describe the assignment<textarea data-assistant-text rows="3" maxlength="6000" placeholder="Schedule Jordan on 2026-10-12 from 08:00 to 16:00. Task: framing. Instructions: start on the west wall."></textarea></label>
        <p class="input-help">Sending a request shares your text and this project's name with the configured AI provider. Scheduling may also include authorized team names. Keep unrelated customer information out of the request.</p>
        <div class="assistant-actions"><button type="button" class="secondary" data-assistant-dictate>Dictate</button><button type="button" class="secondary" data-assistant-chat>Suggest fields</button></div>
        <div data-assistant-conversation class="assistant-conversation" aria-label="Assistant conversation"></div>
        <p data-assistant-voice class="input-help"></p><p data-assistant-message role="status" aria-live="polite"></p>
        <form data-assistant-form><label>Company timezone<input data-assistant-timezone required maxlength="100" placeholder="Confirm in Company settings"></label><div data-assistant-schedule-fields><label>Person<select data-assistant-memberId required><option value="">Choose a person</option></select></label>
        <div class="assistant-grid"><label>Exact date<input data-assistant-date type="date" required></label><label>Start<input data-assistant-start type="time" required></label><label>End<input data-assistant-end type="time" required></label></div>
        <label>Task<input data-assistant-activity required maxlength="120"></label><label>Daily instructions<textarea data-assistant-instructions rows="3" required maxlength="2000"></textarea></label>
        </div><div data-assistant-note-fields hidden><label>Exact project note / to-do<textarea data-assistant-noteText rows="4" required maxlength="5000"></textarea></label><label data-assistant-deadline-label>To-do deadline<select data-assistant-deadline><option value="none">No deadline</option><option value="today">Due today (company timezone)</option><option value="date">Choose an exact date</option></select></label><label data-assistant-due-date-label hidden>Exact due date<input data-assistant-dueDate type="date"></label><p class="input-help">Visible to the authorized project team through existing project access. No assignee, notification blast, or public sharing.</p></div>
        <button type="submit" class="primary" data-assistant-preview>Preview changes</button></form>
        <section data-assistant-review hidden aria-label="Assignment preview"></section>
        <div class="assistant-actions" data-assistant-confirm-actions hidden><button type="button" class="secondary" data-assistant-edit>Edit / cancel preview</button><button type="button" class="primary" data-assistant-confirm>Confirm and save this assignment</button></div>
      </section>`;
    document.body.append(launcher, dialog);
    const node = name => dialog.querySelector(`[data-assistant-${name}]`), fieldNames = ['memberId', 'date', 'timezone', 'start', 'end', 'activity', 'instructions'], extraNames = ['action', 'noteText', 'deadline', 'dueDate'];
    let identity = '', sequence = 0, preview = null, uncertain = false, busy = false, saving = false, activeSave = 0, recognition = null, projectId = null, speechSequence = 0, conversation = [];
    const workspaceIdentity = () => { const { companyId, user, currentRole } = getWorkspace(); return JSON.stringify({ companyId, user, currentRole }); };
    const current = version => dialog.open && version === sequence && identity === workspaceIdentity() && permitted(getWorkspace());
    const message = (text, error = false) => { node('message').textContent = text; node('message').setAttribute('role', error ? 'alert' : 'status'); };
    function stopSpeech() { speechSequence++; recognition?.abort(); recognition = null; node('dictate').textContent = 'Dictate'; }
    function setBusy(value) {
      busy = value;
      dialog.querySelectorAll('button, input, textarea, select').forEach(control => control.disabled = value || uncertain && !['edit', 'confirm', 'close'].some(name => control.hasAttribute(`data-assistant-${name}`)));
      // An uncertain save must be retried with the original reviewed token.
      node('edit').disabled = value || uncertain; node('close').disabled = saving;
      applyMode();
    }
    function applyMode() {
      const schedule = node('action').value === 'schedule', todo = node('action').value === 'todo';
      node('schedule-fields').hidden = !schedule; node('note-fields').hidden = schedule; node('deadline-label').hidden = !todo;
      node('due-date-label').hidden = !todo || node('deadline').value !== 'date';
      for (const name of fieldNames.filter(name => name !== 'timezone')) node(name).disabled = busy || uncertain || !schedule;
      node('noteText').disabled = busy || uncertain || schedule; node('deadline').disabled = busy || uncertain || !todo;
      node('dueDate').disabled = busy || uncertain || !todo || node('deadline').value !== 'date'; node('dueDate').required = todo && node('deadline').value === 'date';
      node('timezone').required = schedule || todo && node('deadline').value !== 'none';
    }
    function invalidate() { preview = null; node('review').hidden = true; node('review').innerHTML = ''; node('confirm-actions').hidden = true; }
    function reset() { sequence++; stopSpeech(); invalidate(); uncertain = false; projectId = null; conversation = []; node('conversation').innerHTML = ''; busy = false; node('action').value = 'schedule'; node('deadline').value = 'none'; node('noteText').value = ''; node('dueDate').value = ''; setBusy(false); node('confirm').textContent = 'Confirm and save these changes'; node('work').hidden = true; fieldNames.forEach(name => node(name).value = ''); node('text').value = ''; message(''); }
    function close() { if (saving) return; stopSpeech(); sequence++; if (!uncertain) reset(); dialog.close(); launcher.focus(); }
    function sync() {
      const workspace = getWorkspace(), next = workspaceIdentity(); launcher.hidden = !permitted(workspace);
      if (identity && identity !== next) { reset(); if (dialog.open) dialog.close(); }
      identity = next;
    }
    function open() {
      sync(); if (launcher.hidden || dialog.open) return;
      if (!uncertain) { reset(); const choices = (getWorkspace().projects || []).filter(row => !row.archived && !['Completed', 'Cancelled'].includes(row.status)); node('project').innerHTML = '<option value="">Choose a project</option>' + choices.map(row => `<option value="${Number(row.id)}">${escape(row.name)}</option>`).join(''); }
      dialog.showModal(); (uncertain ? node('confirm') : node('project')).focus();
    }
    async function selectProject() {
      if (busy || uncertain) return; reset(); projectId = Number(node('project').value) || null; if (!projectId) return;
      const version = sequence; setBusy(true);
      try {
        const context = await boundedRequest(`/api/projects/${projectId}/assistant/context`);
        if (!current(version)) return;
        node('work').hidden = false; node('memberId').innerHTML = '<option value="">Choose a person</option>' + context.members.map(row => `<option value="${row.id}">${escape(row.name)} · ${escape(row.crew)}</option>`).join('');
        node('timezone').value = context.timezone; node('timezone').readOnly = Boolean(context.timezone);
        const option = node('action').querySelector('option[value="schedule"]'); if (option) option.disabled = context.capabilities?.schedule === false;
        if (context.capabilities?.schedule === false) node('action').value = 'note';
        node('voice').textContent = SpeechRecognition ? 'Dictation may use your browser or device speech service. Start it only when you want to speak; then review the transcript.' : 'Dictation is unavailable on this browser. Type or use your keyboard microphone.';
        node('dictate').disabled = !SpeechRecognition; message(context.aiAvailable ? 'Describe one assignment or complete the fields. Nothing has been saved.' : 'AI is unavailable. Complete the fields below and preview.');
      } catch (error) { if (current(version)) { node('work').hidden = false; message(error.message, true); } }
      finally { if (current(version)) { setBusy(false); node('dictate').disabled = !SpeechRecognition; } }
    }
    async function chat() {
      if (busy || uncertain || !projectId) return;
      const text = node('text').value.trim(), combined = [...conversation, text].join('\nFollow-up: ');
      if (!text || combined.length > 6000) { message('Enter a request or finish the editable fields below. This conversation accepts up to 6,000 characters.', true); return; }
      invalidate(); stopSpeech(); const version = ++sequence; setBusy(true); message('Making a suggestion.');
      try { const result = await boundedRequest(`/api/projects/${projectId}/assistant/chat`, { text: combined, action: node('action').value }); if (!current(version)) return;
        conversation.push(text); const turn = document.createElement('p'); turn.textContent = 'You: ' + text; node('conversation').append(turn); const answer = document.createElement('p'); answer.textContent = 'Assistant: ' + result.message; node('conversation').append(answer); node('text').value = '';
        if (result.draft.action) node('action').value = result.draft.action;
        node('noteText').value = result.draft.text || ''; node('deadline').value = result.draft.deadline || 'none';
        for (const name of fieldNames) if (name !== 'timezone') node(name).value = result.draft[name] ?? ''; message(result.message); applyMode();
      } catch (error) { if (current(version)) message(error.message, true); }
      finally { if (current(version)) { setBusy(false); node('dictate').disabled = !SpeechRecognition; } }
    }
    async function makePreview(event) {
      event?.preventDefault(); if (busy || uncertain || !projectId) return; stopSpeech(); invalidate(); const version = ++sequence;
      const action = node('action').value, payload = action === 'schedule' ? { action, ...Object.fromEntries(fieldNames.map(name => [name, node(name).value])), memberId: Number(node('memberId').value) } : { action, text: node('noteText').value, deadline: action === 'todo' ? node('deadline').value : 'none', dueDate: action === 'todo' && node('deadline').value === 'date' ? node('dueDate').value : '', timezone: node('timezone').value };
      setBusy(true); message('Checking the preview.');
      try { const result = await boundedRequest(`/api/projects/${projectId}/assistant/preview`, payload); if (!current(version)) return; preview = result;
        node('review').innerHTML = previewMarkup(result); node('review').hidden = false; node('confirm-actions').hidden = !result.token; message(result.token ? 'Nothing saved yet. Confirm only if this exact preview is correct.' : 'Nothing saved. Edit the assignment to resolve the conflicts.');
        node('review').tabIndex = -1; node('review').focus();
      } catch (error) { if (current(version)) message(error.message, true); }
      finally { if (current(version)) { setBusy(false); node('dictate').disabled = !SpeechRecognition; } }
    }
    async function confirm() {
      if (busy || !preview?.token || !projectId) return; stopSpeech(); const version = sequence, original = preview, saveId = ++activeSave; saving = true; setBusy(true); message('Saving the reviewed changes.');
      try { const result = await boundedRequest(`/api/projects/${projectId}/assistant/confirm`, { token: original.token, version: original.version, confirmed: true }); if (!current(version)) return;
        uncertain = false; invalidate(); message(result.kind === 'note' || result.kind === 'todo' ? `Project ${result.kind === 'note' ? 'note' : 'to-do'} saved. Open the project's Notes & To-dos to see it.` : 'Assignment saved. It is available in the schedule and My Day.'); node('text').value = ''; saving = false; setBusy(false);
        try { await bounded(signal => onSaved(() => current(version), signal)); } catch { if (current(version)) message('Assignment saved. Refresh the schedule to see it.'); }
      } catch (error) { if (!current(version)) return; if (error.status == null || error.status >= 500) { uncertain = true; message('The save outcome is unknown. Retry this same confirmed preview to check it safely. Do not create a second assignment.', true); node('confirm').textContent = 'Retry the same confirmed save'; }
        else { uncertain = false; invalidate(); message(error.message + ' Review a fresh preview before saving.', true); }
      } finally { if (saveId === activeSave) { saving = false; if (current(version)) { setBusy(false); node('dictate').disabled = !SpeechRecognition || uncertain; } } }
    }
    function dictate() {
      if (busy || uncertain || !SpeechRecognition) return; if (recognition) { stopSpeech(); return; }
      invalidate(); const version = sequence, speechVersion = ++speechSequence, initial = node('text').value, session = new SpeechRecognition(); recognition = session; session.lang = 'en-US'; session.interimResults = false; session.continuous = false;
      session.onresult = event => { if (!current(version) || speechVersion !== speechSequence || recognition !== session) return; const text = Array.from(event.results).map(row => row[0].transcript).join(' '); node('text').value = (initial + ' ' + text).trim().slice(0, 6000); message('Review the transcript, then choose Suggest fields.'); };
      session.onerror = () => { if (current(version) && speechVersion === speechSequence) message('Dictation did not finish. Type or use your keyboard microphone.', true); };
      session.onend = () => { if (recognition === session) { recognition = null; node('dictate').textContent = 'Dictate'; } };
      try { session.start(); node('dictate').textContent = 'Stop dictation'; } catch { stopSpeech(); message('Dictation is unavailable. Type or use your keyboard microphone.', true); }
    }
    launcher.onclick = open; node('close').onclick = close; node('project').onchange = selectProject; node('chat').onclick = chat; node('form').onsubmit = makePreview;
    node('confirm').onclick = confirm; node('edit').onclick = () => { if (!busy && !uncertain) { invalidate(); (node('action').value === 'schedule' ? node('activity') : node('noteText')).focus(); message('Edit the fields, then build a fresh preview.'); } }; node('dictate').onclick = dictate;
    for (const name of [...fieldNames, ...extraNames, 'text']) node(name).addEventListener('input', () => { if (!uncertain) { sequence++; invalidate(); applyMode(); } });
    node('action').onchange = () => { if (!busy && !uncertain) { sequence++; invalidate(); applyMode(); } }; node('deadline').onchange = node('action').onchange;
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); }); dialog.addEventListener('close', stopSpeech);
    window.addEventListener('focus', sync); window.addEventListener('storage', sync); window.addEventListener('popstate', close); sync();
    return { sync, open, close, selectProject, chat, makePreview, confirm, launcher, dialog };
  }
  return { escape, permitted, previewMarkup, createAssistant };
});

if (typeof window !== 'undefined' && window.PDLProjectAssistant && typeof currentUser !== 'undefined') {
  const projectAssistant = window.PDLProjectAssistant.createAssistant({ document, window,
    getWorkspace: () => ({ companyId: signedInCompanyId() || company?.id, user: currentUser && { id: currentUser.id, role: currentUser.role, projectIds: currentUser.projectIds, assignedCrews: currentUser.assignedCrews, permissions: currentUser.permissions }, currentRole, projects: (projects || []).map(({ id, name, archived, status }) => ({ id, name, archived, status })) }),
    request: async (path, payload, signal) => { const response = await fetch(path, { method: payload ? 'POST' : 'GET', signal, credentials: 'include', cache: 'no-store', headers: { 'Content-Type': 'application/json', 'X-PDL-Company': signedInCompanyId() || company?.id || '' }, ...(payload ? { body: JSON.stringify(payload) } : {}) }); const data = await response.json(); if (!response.ok) { const error = new Error(data.error || 'Request unavailable.'); error.status = response.status; throw error; } return data; },
    onSaved: async (isCurrent, signal) => { const response = await fetch('/api/state', { signal, credentials: 'include', cache: 'no-store', headers: { 'X-PDL-Company': signedInCompanyId() || company?.id || '' } }); if (!response.ok) throw new Error('Schedule refresh failed.'); const state = await response.json(); if (!isCurrent()) return; assignments = state.assignments || []; renderSchedule(); }
  });
  const previousAssistantRender = renderEverything;
  renderEverything = function() { const result = previousAssistantRender(); projectAssistant.sync(); return result; };
  // Instructions are plain text beside the existing assigned activity.
  const previousAssistantMyDay = renderMyDay;
  renderMyDay = function() { const result = previousAssistantMyDay(); document.querySelectorAll('[data-myday-assignment]').forEach(card => {
    const row = assignments.find(item => Number(item.id) === Number(card.dataset.mydayAssignment));
    if (row?.instructions && card && !card.querySelector('.assignment-daily-instructions')) { const note = document.createElement('p'); note.className = 'assignment-daily-instructions'; note.textContent = 'Daily instructions: ' + row.instructions; card.append(note); }
  }); return result; };
  const previousAssistantScheduled = openScheduledWork;
  openScheduledWork = function(...args) { const result = previousAssistantScheduled(...args), row = assignments.find(item => Number(item.id) === Number(args[0]));
    if (row?.instructions) { const note = document.createElement('p'); note.className = 'assignment-daily-instructions'; note.textContent = 'Daily instructions: ' + row.instructions; document.getElementById('scheduled-work-detail')?.append(note); } return result; };
}
