(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PDLProjectAssistant = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';
  const voiceAPI = typeof module === 'object' && module.exports ? require('./project-assistant-voice') : globalThis.PDLAssistantVoice;
  const conversationAPI = typeof module === 'object' && module.exports ? require('./project-assistant-conversation') : globalThis.PDLAssistantConversation;
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const permitted = workspace => workspace?.currentRole === 'office' && Boolean(workspace.user?.id) &&
    ['owner', 'admin', 'project_manager'].includes(workspace.user.role);
  const mascot = '<svg viewBox="0 0 80 80" aria-hidden="true" focusable="false"><path d="M15 41c0-18 10-27 25-27s25 9 25 27v13c0 15-12 24-25 24S15 69 15 54z" fill="#ffb36b" stroke="#492d24" stroke-width="3"/><path d="M12 35c1-18 11-29 28-29s27 11 28 29H12z" fill="#ff751f" stroke="#492d24" stroke-width="3"/><path d="M35 6h10v25H35z" fill="#ffa247"/><path d="M8 34h64v9H8z" fill="#ff751f" stroke="#492d24" stroke-width="3" stroke-linejoin="round"/><ellipse cx="29" cy="51" rx="7" ry="9" fill="white"/><ellipse cx="51" cy="49" rx="7" ry="9" fill="white"/><circle cx="31" cy="52" r="3.5" fill="#492d24"/><circle cx="49" cy="50" r="3.5" fill="#492d24"/><path d="M27 64q14 9 28-5" fill="none" stroke="#492d24" stroke-width="3" stroke-linecap="round"/></svg>';
  function previewMarkup(result) {
    const row = result.proposal;
    if (row.action === 'schedule_batch') return `<h3>Review this exact scheduling batch</h3><dl><dt>Project</dt><dd>${escape(row.projectName)}</dd><dt>Range / weekdays</dt><dd>${escape(row.startDate)} to ${escape(row.endDate)} (inclusive)<br>${row.weekdays.map(day => ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][day]).map(escape).join(', ')}</dd><dt>Shift / timezone</dt><dd>${escape(row.start)}-${escape(row.end)} &#183; ${escape(row.timezone)}</dd><dt>Task</dt><dd>${escape(row.activity)}</dd><dt>Daily instructions</dt><dd class="assistant-instructions">${escape(row.instructions)}</dd><dt>Batch size</dt><dd>${row.dates.length} daily assignment records for ${row.members.length} people (${row.personDays} person/day combinations).</dd><dt>Save policy</dt><dd>All dates and people save together or none do. No partial batch.</dd><dt>Notifications</dt><dd>${escape(row.notification)}</dd></dl><h4>Every person and date</h4><ul class="assistant-batch-list">${row.dates.flatMap(date => row.members.map(member => `<li>${escape(date)} &#183; ${escape(member.name)} (${escape(member.crew)}, ID ${member.id}) &#183; ${escape(row.start)}-${escape(row.end)}</li>`)).join('')}</ul>${result.conflicts.length ? '<h4>Resolve all conflicts before saving</h4><ul>' + result.conflicts.map(conflict => `<li>${escape(conflict.memberName)} (ID ${conflict.memberId}) &#183; ${escape(conflict.date)}: ${escape(conflict.message)} ${escape(conflict.start || '')}${conflict.end ? '-' + escape(conflict.end) : ''}</li>`).join('') + '</ul><p>Nothing will be saved while any person/date conflicts.</p>' : '<p>No current conflicts. Every person/date and your access will be checked again before the entire batch is saved.</p>'}`;
    if (row.action === 'note' || row.action === 'todo') return `<h3>Review this exact project ${row.action === 'note' ? 'note' : 'to-do'}</h3><dl><dt>Project</dt><dd>${escape(row.projectName)}</dd><dt>Text</dt><dd class="assistant-instructions">${escape(row.text)}</dd><dt>Visibility</dt><dd>${escape(row.visibility)}</dd><dt>Deadline</dt><dd>${row.dueDate ? `${row.deadline === 'today' ? 'Due today: ' : ''}${escape(row.dueDate)} · ${escape(row.timezone)}` : 'No deadline'}</dd>${row.action === 'todo' ? '<dt>Assignee / status</dt><dd>Unassigned · Open</dd>' : ''}<dt>Notifications</dt><dd>${escape(row.notification)}</dd></dl><p>Nothing saved yet. Confirm only if this project and text are correct.</p>`;
    return `<h3>Review this exact assignment</h3><dl><dt>Project</dt><dd>${escape(row.projectName)}</dd><dt>Person</dt><dd>${escape(row.memberName)}${Number.isSafeInteger(row.memberId) ? ' (ID ' + row.memberId + ')' : ''}</dd><dt>Date and hours</dt><dd>${escape(row.date)} · ${escape(row.start)}–${escape(row.end)} · ${escape(row.timezone)}</dd><dt>Task</dt><dd>${escape(row.activity)}</dd><dt>Daily instructions</dt><dd class="assistant-instructions">${escape(row.instructions)}</dd><dt>Notification</dt><dd>${escape(row.notification)}</dd></dl>${result.conflicts.length ? '<h4>Resolve these conflicts before saving</h4><ul>' + result.conflicts.map(row => `<li>${escape(row.message)} ${escape(row.date)} ${escape(row.start || '')}${row.end ? '–' + escape(row.end) : ''}</li>`).join('') + '</ul>' : '<p>No current conflicts. Availability and access will be checked again when you confirm.</p>'}`;
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
        <label>What would you like to do?<select data-assistant-action><option value="schedule">Schedule one person's day</option><option value="schedule_batch">Schedule people across days</option><option value="note">Add a project note</option><option value="todo">Add a project to-do</option></select></label>
        <label>Describe the assignment<textarea data-assistant-text rows="3" maxlength="6000" placeholder="Schedule Jordan on 2026-10-12 from 08:00 to 16:00. Task: framing. Instructions: start on the west wall."></textarea></label>
        <p class="input-help">Sending a request shares your text and this project's name with the configured AI provider. Scheduling may also include authorized team names. Keep unrelated customer information out of the request.</p>
        <div class="assistant-actions"><button type="button" class="secondary" data-assistant-dictate>Dictate</button><button type="button" class="secondary" data-assistant-chat>Suggest fields</button><button type="button" class="secondary" data-assistant-voice-session>Start voice prototype</button><button type="button" class="secondary" data-assistant-read-preview>Read preview aloud</button></div>
        <p class="input-help">Voice prototype: explicit microphone permission, visible page only, up to five minutes. Your browser/device speech service may process audio. Say &quot;assistant suggest fields&quot;, &quot;assistant preview changes&quot;, &quot;assistant read preview&quot;, &quot;assistant cancel preview&quot;, or &quot;assistant stop listening&quot;. It pauses after a command or browser stop; tap Start again to continue. Saving still requires the Confirm button. No locked-screen/background or driving mode.</p><p data-assistant-voice-status role="status" aria-live="polite"></p>
        <button type="button" class="secondary" data-assistant-converse aria-pressed="false">Start guided voice conversation</button>
        <p class="input-help">Guided conversation asks for missing details one answer at a time and reads the complete server preview with the microphone off. Up to five minutes / 20 answers; no automatic AI calls. Browser speech may process audio. Keep this page visible and focused; interruptions stop the session. Say &quot;preview these changes&quot;, &quot;change date&quot; (or another field name), or &quot;cancel conversation&quot;. Saving requires the on-screen Confirm button. Use only while stationary.</p>
        <p data-assistant-converse-status role="status" aria-live="polite"></p>
        <div data-assistant-conversation class="assistant-conversation" aria-label="Assistant conversation"></div>
        <p data-assistant-voice class="input-help"></p><p data-assistant-message role="status" aria-live="polite"></p>
        <form data-assistant-form><label>Company timezone<input data-assistant-timezone required maxlength="100" placeholder="Confirm in Company settings"></label><div data-assistant-schedule-fields><div data-assistant-single-fields><label>Person<select data-assistant-memberId required><option value="">Choose a person</option></select></label>
        <div class="assistant-grid"><label>Exact date<input data-assistant-date type="date" required></label><label>Start<input data-assistant-start type="time" required></label><label>End<input data-assistant-end type="time" required></label></div>
        </div><div data-assistant-batch-fields hidden><label>People (choose every person)<select data-assistant-memberIds multiple size="4" required aria-describedby="assistant-batch-help"></select></label>
        <div class="assistant-grid"><label>Inclusive start date<input data-assistant-startDate type="date" required></label><label>Inclusive end date<input data-assistant-endDate type="date" required></label></div>
        <label>Weekdays (choose explicitly)<select data-assistant-weekdays multiple size="7" required>${['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'].map((day,index) => `<option value="${index}">${day}</option>`).join('')}</select></label>
        <p id="assistant-batch-help" class="input-help">Up to 31 calendar days, 10 people and 100 person/day combinations. Choose intended weekdays, including weekends when needed. Preview lists every person/date. The entire batch saves together or none does.</p><div class="assistant-grid"><label>Batch shift start<input data-assistant-batchStart type="time" required></label><label>Batch shift end<input data-assistant-batchEnd type="time" required></label></div></div>
        <label>Task<input data-assistant-activity required maxlength="120"></label><label>Daily instructions<textarea data-assistant-instructions rows="3" required maxlength="2000"></textarea></label>
        </div><div data-assistant-note-fields hidden><label>Exact project note / to-do<textarea data-assistant-noteText rows="4" required maxlength="5000"></textarea></label><label data-assistant-deadline-label>To-do deadline<select data-assistant-deadline><option value="none">No deadline</option><option value="today">Due today (company timezone)</option><option value="date">Choose an exact date</option></select></label><label data-assistant-due-date-label hidden>Exact due date<input data-assistant-dueDate type="date"></label><p class="input-help">Visible to the authorized project team through existing project access. No assignee, notification blast, or public sharing.</p></div>
        <button type="submit" class="primary" data-assistant-preview>Preview changes</button></form>
        <section data-assistant-review hidden aria-label="Assignment preview"></section>
        <div class="assistant-actions" data-assistant-confirm-actions hidden><button type="button" class="secondary" data-assistant-edit>Edit / cancel preview</button><button type="button" class="primary" data-assistant-confirm>Confirm and save this assignment</button></div>
      </section>`;
    document.body.append(launcher, dialog);
    const node = name => dialog.querySelector(`[data-assistant-${name}]`), fieldNames = ['memberId', 'date', 'timezone', 'start', 'end', 'activity', 'instructions'], extraNames = ['action', 'noteText', 'deadline', 'dueDate'], batchNames = ['memberIds','startDate','endDate','weekdays','batchStart','batchEnd'];
    let identity = '', sequence = 0, preview = null, uncertain = false, busy = false, saving = false, activeSave = 0, recognition = null, projectId = null, speechSequence = 0, conversation = [], authorizedContext = null, deadlineExplicit = false;
    const workspaceIdentity = () => { const { companyId, user, currentRole } = getWorkspace(); return JSON.stringify({ companyId, user, currentRole }); };
    const current = version => dialog.open && version === sequence && identity === workspaceIdentity() && permitted(getWorkspace());
    const message = (text, error = false) => { node('message').textContent = text; node('message').setAttribute('role', error ? 'alert' : 'status'); };
    const voice = voiceAPI.createVoiceSession({document,window,SpeechRecognition,canContinue:()=>dialog.open&&Boolean(projectId)&&identity===workspaceIdentity()&&permitted(getWorkspace())&&!busy&&!uncertain,
      onTranscript:text=>{invalidate();const combined=(node('text').value+' '+text).trim();if(combined.length>6000){voice.stop('Transcript limit reached. Review or shorten the text before continuing.');return;}node('text').value=combined;message('Voice text is a draft. Ask for suggested fields or preview completed fields; nothing is saved.');},
      onCommand:async command=>{if(command==='suggest'){const pending=chat(),version=sequence,voiceCurrent=voice.checkpoint();await pending;if(current(version)&&voiceCurrent())voice.read(node('message').textContent);}else if(command==='preview'){const pending=makePreview(),version=sequence,voiceCurrent=voice.checkpoint();await pending;if(current(version)&&voiceCurrent()&&preview)voice.read(node('review').textContent);}else if(command==='read')readPreview();else if(command==='cancel'&&!busy&&!uncertain){invalidate();(['schedule','schedule_batch'].includes(node('action').value)?node('activity'):node('noteText')).focus();message('Preview cancelled. Nothing saved.');}},
      onStatus:(text,listening)=>{node('voice-status').textContent=text;node('voice-session').textContent=listening?'Stop voice prototype':'Start voice prototype';node('voice-session').setAttribute('aria-pressed',String(listening));}});
    const guided = conversationAPI.createConversation({document, window, SpeechRecognition,
      canContinue:()=>dialog.open&&Boolean(projectId)&&Boolean(authorizedContext)&&identity===workspaceIdentity()&&permitted(getWorkspace())&&!uncertain&&!saving,
      getContext:()=>authorizedContext, getDraft:()=>{const draft=draftPayload();if(draft.action==='todo'&&!deadlineExplicit)draft.deadline='';return draft;},
      setDraft:patch=>{sequence++;invalidate();for(const [key,value] of Object.entries(patch)){
        const name=key==='text'?'noteText':(['start','end'].includes(key)&&node('action').value==='schedule_batch'?'batch'+key[0].toUpperCase()+key.slice(1):key);
        if(['memberIds','weekdays'].includes(name)){for(const option of Array.from(node(name).options||[]))option.selected=value.includes(Number(option.value));}
        else node(name).value=value;if(key==='deadline')deadlineExplicit=true;
      }applyMode();},
      preview:async()=>{await makePreview(undefined,true);return preview?{text:node('review').innerText||node('review').textContent,confirmable:Boolean(preview.token)}:null;},
      onCancelPreview:invalidate,
      onInterrupted:()=>{sequence++;invalidate();if(!saving)setBusy(false);message('Conversation preview was interrupted. Nothing saved. Request a fresh preview before confirming.');},
      onTurn:(speaker,text)=>{const turn=document.createElement('p');turn.textContent=speaker+': '+text;node('conversation').append(turn);},
      onStatus:(text,active)=>{node('converse-status').textContent=text;node('converse').textContent=active?'Stop guided voice conversation':'Start guided voice conversation';node('converse').setAttribute('aria-pressed',String(active));}});
    function readPreview(){guided.stop();if(preview&&!busy&&!uncertain)voice.read(node('review').textContent);}
    function stopSpeech(keepConversation = false) { if(keepConversation!==true)guided.stop();voice.stop(); speechSequence++; recognition?.abort(); recognition = null; node('dictate').textContent = 'Dictate'; }
    function setBusy(value) {
      busy = value;
      dialog.querySelectorAll('button, input, textarea, select').forEach(control => control.disabled = value || uncertain && !['edit', 'confirm', 'close'].some(name => control.hasAttribute(`data-assistant-${name}`)));
      // An uncertain save must be retried with the original reviewed token.
      node('edit').disabled = value || uncertain; node('close').disabled = saving;
      applyMode(); node('voice-session').disabled = value || uncertain || !voice.supported; node('read-preview').disabled = value || uncertain || !preview;node('converse').disabled = value&&!guided.active || uncertain || !guided.supported;
    }
    function applyMode() {
      const batch = node('action').value === 'schedule_batch', schedule = batch || node('action').value === 'schedule', todo = node('action').value === 'todo';
      node('single-fields').hidden = batch; node('batch-fields').hidden = !batch;
      for (const name of batchNames) node(name).disabled = busy || uncertain || !batch;
      node('schedule-fields').hidden = !schedule; node('note-fields').hidden = schedule; node('deadline-label').hidden = !todo;
      node('due-date-label').hidden = !todo || node('deadline').value !== 'date';
      for (const name of fieldNames.filter(name => name !== 'timezone')) node(name).disabled = busy || uncertain || !schedule || batch && ['memberId','date','start','end'].includes(name);
      node('noteText').disabled = busy || uncertain || schedule; node('deadline').disabled = busy || uncertain || !todo;
      node('dueDate').disabled = busy || uncertain || !todo || node('deadline').value !== 'date'; node('dueDate').required = todo && node('deadline').value === 'date';
      node('timezone').required = schedule || todo && node('deadline').value !== 'none';
    }
    function invalidate() { preview = null; node('read-preview').disabled = true; node('review').hidden = true; node('review').innerHTML = ''; node('confirm-actions').hidden = true; }
    function reset() { sequence++; stopSpeech(); invalidate(); uncertain = false; projectId = null; authorizedContext=null;deadlineExplicit=false;conversation = []; node('conversation').innerHTML = ''; busy = false; node('action').value = 'schedule'; node('deadline').value = 'none'; node('noteText').value = ''; node('dueDate').value = ''; setBusy(false); node('confirm').textContent = 'Confirm and save these changes'; node('work').hidden = true; [...fieldNames,...batchNames].forEach(name => node(name).value = ''); node('text').value = ''; message(''); }
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
        authorizedContext=context;
        node('work').hidden = false; node('memberId').innerHTML = '<option value="">Choose a person</option>' + context.members.map(row => `<option value="${row.id}">${escape(row.name)} · ${escape(row.crew)}</option>`).join('');
        node('memberIds').innerHTML = context.members.map(row => `<option value="${row.id}">${escape(row.name)} &#183; ${escape(row.crew)} &#183; ID ${row.id}</option>`).join('');
        node('timezone').value = context.timezone; node('timezone').readOnly = Boolean(context.timezone);
        const option = node('action').querySelector('option[value="schedule"]'); if (option) option.disabled = context.capabilities?.schedule === false;
        const batchOption = node('action').querySelector('option[value="schedule_batch"]'); if (batchOption) batchOption.disabled = context.capabilities?.schedule === false;
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
        for (const name of fieldNames) if (name !== 'timezone') node(name).value = result.draft[name] ?? '';
        for (const name of ['startDate','endDate']) node(name).value = result.draft[name] ?? '';
        for (const name of ['memberIds','weekdays']) for (const option of Array.from(node(name).options || [])) option.selected = (result.draft[name] || []).includes(Number(option.value));
        node('batchStart').value = result.draft.start || ''; node('batchEnd').value = result.draft.end || ''; message(result.message); applyMode();
      } catch (error) { if (current(version)) message(error.message, true); }
      finally { if (current(version)) { setBusy(false); node('dictate').disabled = !SpeechRecognition; } }
    }
    function draftPayload() {
      const action = node('action').value;
      return action === 'schedule_batch' ? { action, memberIds: Array.from(node('memberIds').selectedOptions || []).map(option => Number(option.value)), weekdays: Array.from(node('weekdays').selectedOptions || []).map(option => Number(option.value)), startDate: node('startDate').value, endDate: node('endDate').value, start: node('batchStart').value, end: node('batchEnd').value, activity: node('activity').value, instructions: node('instructions').value, timezone: node('timezone').value } : action === 'schedule' ? { action, ...Object.fromEntries(fieldNames.map(name => [name, node(name).value])), memberId: Number(node('memberId').value) || '', } : { action, text: node('noteText').value, deadline: action === 'todo' ? node('deadline').value : 'none', dueDate: action === 'todo' && node('deadline').value === 'date' ? node('dueDate').value : '', timezone: node('timezone').value };
    }
    async function makePreview(event, fromConversation = false) {
      event?.preventDefault(); if (busy || uncertain || !projectId) return; stopSpeech(fromConversation); invalidate(); const version = ++sequence;
      const payload = draftPayload();
      setBusy(true); message('Checking the preview.');
      try { const result = await boundedRequest(`/api/projects/${projectId}/assistant/preview`, payload); if (!current(version)) return; preview = result;
        node('review').innerHTML = previewMarkup(result); node('review').hidden = false; node('confirm-actions').hidden = !result.token; message(result.token ? 'Nothing saved yet. Confirm only if this exact preview is correct.' : 'Nothing saved. Edit the assignment to resolve the conflicts.');
        node('review').tabIndex = -1; node('review').focus();
      } catch (error) { if (current(version)) message(error.message, true); }
      finally { if (current(version)) { setBusy(false); node('dictate').disabled = !SpeechRecognition; } }
    }
    async function confirm() {
      if (busy || !preview?.token || !projectId) return; stopSpeech();if(!preview?.token)return; const version = sequence, original = preview, saveId = ++activeSave; saving = true; setBusy(true); message('Saving the reviewed changes.');
      try { const result = await boundedRequest(`/api/projects/${projectId}/assistant/confirm`, { token: original.token, version: original.version, confirmed: true }); if (!current(version)) return;
        uncertain = false; invalidate(); message(result.kind === 'note' || result.kind === 'todo' ? `Project ${result.kind === 'note' ? 'note' : 'to-do'} saved. Open the project's Notes & To-dos to see it.` : result.kind === 'schedule_batch' ? `Batch saved: ${result.assignmentIds.length} daily assignments. All selected people/dates are available in the schedule and My Day.` : 'Assignment saved. It is available in the schedule and My Day.'); node('text').value = ''; saving = false; setBusy(false);
        try { await bounded(signal => onSaved(() => current(version), signal)); } catch { if (current(version)) message('Changes saved. Refresh the schedule or project notes to see them.'); }
      } catch (error) { if (!current(version)) return; if (error.status == null || error.status >= 500) { uncertain = true; message('The save outcome is unknown. Retry this same confirmed preview to check it safely. Do not repeat the request with a new preview.', true); node('confirm').textContent = 'Retry the same confirmed save'; }
        else { uncertain = false; invalidate(); message(error.message + ' Review a fresh preview before saving.', true); }
      } finally { if (saveId === activeSave) { saving = false; if (current(version)) { setBusy(false); node('dictate').disabled = !SpeechRecognition || uncertain; } } }
    }
    function dictate() {
      if (busy || uncertain || !SpeechRecognition) return; guided.stop();voice.stop(); if (recognition) { stopSpeech(); return; }
      invalidate(); const version = sequence, speechVersion = ++speechSequence, initial = node('text').value, session = new SpeechRecognition(); recognition = session; session.lang = 'en-US'; session.interimResults = false; session.continuous = false;
      session.onresult = event => { if (!current(version) || speechVersion !== speechSequence || recognition !== session) return; const text = Array.from(event.results).map(row => row[0].transcript).join(' '); node('text').value = (initial + ' ' + text).trim().slice(0, 6000); message('Review the transcript, then choose Suggest fields.'); };
      session.onerror = () => { if (current(version) && speechVersion === speechSequence) message('Dictation did not finish. Type or use your keyboard microphone.', true); };
      session.onend = () => { if (recognition === session) { recognition = null; node('dictate').textContent = 'Dictate'; } };
      try { session.start(); node('dictate').textContent = 'Stop dictation'; } catch { stopSpeech(); message('Dictation is unavailable. Type or use your keyboard microphone.', true); }
    }
    launcher.onclick = open; node('close').onclick = close; node('project').onchange = selectProject; node('chat').onclick = chat; node('form').onsubmit = makePreview;
    node('confirm').onclick = confirm; node('edit').onclick = () => { if (!busy && !uncertain) { stopSpeech(); invalidate(); (['schedule','schedule_batch'].includes(node('action').value) ? node('activity') : node('noteText')).focus(); message('Edit the fields, then build a fresh preview.'); } }; node('dictate').onclick = dictate; node('voice-session').onclick = () => { if(voice.listening)voice.stop();else{stopSpeech();voice.start();} }; node('read-preview').onclick = ()=>{guided.stop();readPreview();};node('converse').onclick=()=>{if(guided.active)guided.stop();else if(!busy&&!uncertain){stopSpeech();guided.start();}};
    for (const name of [...fieldNames, ...extraNames, ...batchNames, 'text']) node(name).addEventListener('input', () => { if (!uncertain) { stopSpeech(); sequence++; invalidate(); applyMode(); } });
    node('action').onchange = () => { if (!busy && !uncertain) { stopSpeech(); sequence++; invalidate(); deadlineExplicit=false;applyMode(); } }; node('deadline').onchange = ()=>{node('action').onchange();deadlineExplicit=true;};
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); }); dialog.addEventListener('close', stopSpeech);
    window.addEventListener('blur', stopSpeech); document.addEventListener?.('visibilitychange', () => { if (document.hidden) stopSpeech(); }); window.addEventListener('focus', sync); window.addEventListener('storage', sync); window.addEventListener('popstate', close); sync();
    return { sync, open, close, selectProject, chat, makePreview, confirm, launcher, dialog };
  }
  return { escape, permitted, previewMarkup, createAssistant };
});

if (typeof window !== 'undefined' && window.PDLProjectAssistant && typeof currentUser !== 'undefined') {
  const projectAssistant = window.PDLProjectAssistant.createAssistant({ document, window,
    getWorkspace: () => ({ companyId: signedInCompanyId() || company?.id, user: currentUser && { id: currentUser.id, role: currentUser.role, projectIds: currentUser.projectIds, assignedCrews: currentUser.assignedCrews, permissions: currentUser.permissions }, currentRole, projects: (projects || []).map(({ id, name, archived, status }) => ({ id, name, archived, status })) }),
    request: async (path, payload, signal) => { const response = await fetch(path, { method: payload ? 'POST' : 'GET', signal, credentials: 'include', cache: 'no-store', headers: { 'Content-Type': 'application/json', 'X-PDL-Company': signedInCompanyId() || company?.id || '' }, ...(payload ? { body: JSON.stringify(payload) } : {}) }); const data = await response.json(); if (!response.ok) { const error = new Error(data.error || 'Request unavailable.'); error.status = response.status; throw error; } return data; },
    onSaved: async (isCurrent, signal) => { const response = await fetch('/api/state', { signal, credentials: 'include', cache: 'no-store', headers: { 'X-PDL-Company': signedInCompanyId() || company?.id || '' } }); if (!response.ok) throw new Error('Schedule refresh failed.'); const state = await response.json(); if (!isCurrent()) return; assignments = state.assignments || []; renderSchedule(); renderActivities(); renderDashboardSummary(); }
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
