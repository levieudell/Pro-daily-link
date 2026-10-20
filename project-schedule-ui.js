(function(){
  'use strict';
  // Project detail "Schedule" tab: linked tasks with auto-computed dates.
  // The server schedules (project-schedule.js engine); this module renders
  // the tab, wires add/edit/delete/status, and repaints after every change.
  let scheduleTabSequence = 0;
let scheduleView = 'table';

  function projectScheduleLocale(){
    if (typeof interfaceLocale === 'function') return interfaceLocale() || 'en-US';
    return typeof preferredLanguage !== 'undefined' && preferredLanguage === 'es' ? 'es-US' : 'en-US';
  }
  function projectScheduleCopy(value){
    return typeof PDLLocale !== 'undefined' && PDLLocale && typeof PDLLocale.translate === 'function' ? PDLLocale.translate(value) : value;
  }
  function canEditTasks(){ return typeof canManageSchedule === 'function' && canManageSchedule(); }
  function taskStatusLabel(status){ return status === 'done' ? 'Done' : status === 'in-progress' ? 'In progress' : 'Not started'; }
  function memberNames(ids){ return (ids || []).map(id => (team || []).find(m => Number(m.id) === Number(id))?.name).filter(Boolean); }
  function assigneeLabel(task){
    const people = memberNames(task.memberIds);
    if (task.crew) return people.length ? task.crew + ' · ' + people.join(', ') : task.crew + ' (crew)';
    if (people.length) return people.join(', ');
    return 'Unassigned';
  }
  function taskById(tasks, id){ return (tasks || []).find(t => Number(t.id) === Number(id)); }
  function dependencyChips(tasks, task){
    const deps = (task.predecessorIds || []).map(id => taskById(tasks, id)).filter(Boolean);
    return deps.length ? deps.map(d => `<span class="project-schedule-dep">${escapeHtml(d.name)}</span>`).join('') : '<span class="project-schedule-none">None</span>';
  }

  // Planned-vs-done for a task linked to an estimate line: planned quantity
  // from the estimate, done from approved daily-report production entries.
  // Office workspace only — the field workspace ships a scoped report subset
  // without production entries, so progress there would always read zero.
  function estimateProgress(project, estimateItemId){
    if (typeof currentRole !== 'undefined' && currentRole === 'field') return null;
    const item = (project.estimateItems || []).find(row => Number(row.id) === Number(estimateItemId));
    const planned = Number(item?.plannedQuantity) || 0;
    if (!item || !(planned > 0)) return null;
    const allProjects = (typeof projects !== 'undefined' ? projects : []);
    const done = ((typeof reports !== 'undefined' ? reports : []) || [])
      .filter(row => row && row.status === 'Approved' && !row.deletedAt && Number(allProjects[Number(row.project)]?.id) === Number(project.id))
      .flatMap(row => (row.productionEntries || []).filter(entry => Number(entry.estimateItemId) === Number(estimateItemId)))
      .reduce((sum, entry) => sum + (Number(entry.quantity) || 0), 0);
    return { done, planned, unit: String(item.unit || ''), pct: Math.min(100, Math.round(done / planned * 100)) };
  }
  function progressMarkup(progress){
    if (!progress) return '';
    const fmt = value => Number(value).toLocaleString(projectScheduleLocale(), { maximumFractionDigits: 1 });
    return `<span class="project-schedule-progress" title="Approved daily-report quantities"><i><u style="width:${progress.pct}%"></u></i><b>${fmt(progress.done)} / ${fmt(progress.planned)} ${escapeHtml(progress.unit)}</b><small>${progress.pct}%</small></span>`;
  }
  function progressText(progress){
    if (!progress) return '';
    const fmt = value => Number(value).toLocaleString(projectScheduleLocale(), { maximumFractionDigits: 1 });
    return `${fmt(progress.done)} / ${fmt(progress.planned)} ${progress.unit} (${progress.pct}%)`;
  }

  function timelineRow(task, windowStart, windowEnd){
    if (!windowStart || !windowEnd) return '';
    const total = Math.max(1, Date.parse(windowEnd + 'T12:00:00') - Date.parse(windowStart + 'T12:00:00'));
    const left = Math.min(96, Math.max(0, (Date.parse(task.startDate + 'T12:00:00') - Date.parse(windowStart + 'T12:00:00')) / total * 100));
    const right = Math.min(96, Math.max(0, (Date.parse(windowEnd + 'T12:00:00') - Date.parse(task.endDate + 'T12:00:00')) / total * 100));
        const statusClass = task.status === 'done' ? ' is-done' : task.status === 'in-progress' ? ' is-progress' : ' is-todo';
    return `<div class="project-schedule-track${statusClass}" aria-hidden="true"><i style="left:${left}%;right:${right}%"></i></div>`;
  }

  function crewOptions(field, selected){
    const crews = [...new Set((typeof team !== 'undefined' ? team : []).map(m => m.crew).filter(Boolean))];
    if (!crews.length) return '';
    return `<select ${field} aria-label="Crew (optional)"><option value="">No crew</option>${crews.map(crew => `<option value="${escapeHtml(crew)}" ${String(selected || '') === crew ? 'selected' : ''}>${escapeHtml(crew)}</option>`).join('')}</select>`;
  }
  function chipPick(field, options, selected){
    const chosen = new Set((selected || []).map(Number));
    const opts = (options || []).filter(o => o && o.value != null);
    const select = `<select ${field} multiple class="schedule-chip-select" size="2" aria-label="Pick one or more">${opts.length ? opts.map(o => `<option value="${Number(o.value)}" ${chosen.has(Number(o.value)) ? 'selected' : ''}>${escapeHtml(o.label)}</option>`).join('') : '<option value="" disabled>Nothing to pick yet</option>'}</select>`;
    if (!opts.length) return select;
    return `<div class="schedule-chip-pick">${select}<div class="schedule-chip-row">${opts.map(o => `<button type="button" class="schedule-chip${chosen.has(Number(o.value)) ? ' is-on' : ''}" data-chip-value="${Number(o.value)}" aria-pressed="${chosen.has(Number(o.value))}">${escapeHtml(o.label)}</button>`).join('')}</div></div>`;
  }
  function memberPick(field, selected){
    const people = (typeof team !== 'undefined' ? team : []) || [];
    return chipPick(field, people.map(member => ({ value: Number(member.id), label: member.name })), selected);
  }

  function forecastBanner(project, sorted){
    if (!sorted.length) return '';
    const ends = sorted.map(t => t.endDate).filter(Boolean).sort();
    const finish = ends[ends.length - 1];
    if (!finish) return '';
    const target = project.endDate && /^\d{4}-\d{2}-\d{2}$/.test(String(project.endDate)) ? String(project.endDate) : null;
    const label = formatDate(finish);
    if (!target) return `<div class="project-schedule-forecast" data-schedule-forecast><strong>Forecast finish ${escapeHtml(label)}</strong><span>Set a target end date above to track the schedule against it.</span></div>`;
    const diffDays = Math.round((Date.parse(finish + 'T12:00:00') - Date.parse(target + 'T12:00:00')) / 86400000);
    if (diffDays <= 0) return `<div class=\"project-schedule-forecast is-ahead\" data-schedule-forecast><strong>Forecast finish ${escapeHtml(label)}</strong><span>${diffDays === 0 ? 'Right on the target end date.' : `${Math.abs(diffDays)} calendar day${Math.abs(diffDays) === 1 ? '' : 's'} ahead of target.`}</span></div>`;
    return `<div class="project-schedule-forecast is-behind" data-schedule-forecast><strong>Forecast finish ${escapeHtml(label)}</strong><span>${diffDays} calendar day${diffDays === 1 ? '' : 's'} past the target end ${escapeHtml(formatDate(target))} — trim scope, add crew, or move the target.</span></div>`;
  }

  function ganttChart(project, sorted){
    if (!sorted.length) return '';
    const dates = sorted.map(t => t.startDate).concat(sorted.map(t => t.endDate)).filter(Boolean).sort();
    if (!dates.length) return '';
    const DAY = 86400000;
    const start = Date.parse(dates[0] + 'T12:00:00') - 2 * DAY;
    let end = Date.parse(dates[dates.length - 1] + 'T12:00:00') + 2 * DAY;
    if ((end - start) / DAY > 62) end = start + 62 * DAY;
    const span = end - start + DAY;
    const days = [];
    for (let t = start; t <= end; t += DAY) days.push(new Date(t));
    const isoOf = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const locale = projectScheduleLocale();
    const dayCells = days.map(d => `<i class="gantt-day${(d.getDay() === 0 || d.getDay() === 6) ? ' gantt-weekend' : ''}"><small>${escapeHtml(d.toLocaleDateString(locale, { weekday: 'narrow' }).toUpperCase())}</small><b>${d.getDate()}</b></i>`).join('');
    const months = [];
    for (const d of days) {
      const key = `${d.getFullYear()}-${d.getMonth()}`;
      if (months.length && months[months.length - 1].key === key) months[months.length - 1].count++;
      else months.push({ key, label: d.toLocaleDateString(locale, { month: 'short' }), count: 1 });
    }
    const monthRow = months.map(m => `<span class="gantt-month" style="flex-grow:${m.count}">${escapeHtml(m.label)}</span>`).join('');
    const todayIso = typeof companyTodayIso === 'function' ? companyTodayIso() : (typeof localDateIso === 'function' ? localDateIso() : '');
    const todayLeft = todayIso && todayIso >= isoOf(days[0]) && todayIso <= isoOf(days[days.length - 1]) ? (Date.parse(todayIso + 'T12:00:00') - start) / span * 100 : null;
    const rows = sorted.map(task => {
      const statusClass = task.status === 'done' ? ' is-done' : task.status === 'in-progress' ? ' is-progress' : ' is-todo';
      const deps = (task.predecessorIds || []).map(id => taskById(sorted, id)).filter(Boolean).map(d => d.name).join(', ');
      const left = Math.max(0, (Date.parse(task.startDate + 'T12:00:00') - start) / span * 100);
      const right = Math.min(100, (Date.parse(task.endDate + 'T12:00:00') + DAY - start) / span * 100);
      const progress = estimateProgress(project, task.estimateItemId);
      return `<div class="gantt-row">
        <div class="gantt-row-label"><strong>${escapeHtml(task.name)}</strong><small>${escapeHtml(assigneeLabel(task))}${deps ? ` · waits for ${escapeHtml(deps)}` : ''}${progressText(progress) ? ` · ${escapeHtml(progressText(progress))}` : ''}</small></div>
        <div class="gantt-row-track">${dayCells}<i class="gantt-bar${statusClass}" style="left:${left.toFixed(2)}%;width:${Math.max(0.8, right - left).toFixed(2)}%" title="${escapeHtml(task.name)} · ${escapeHtml(formatDate(task.startDate))} – ${escapeHtml(formatDate(task.endDate))}">${task.status === 'done' ? '✓' : ''}</i>${todayLeft == null ? '' : `<i class="gantt-today" style="left:${todayLeft.toFixed(2)}%" title="Today"></i>`}</div>
      </div>`;
    }).join('');
    return `<div class="project-schedule-gantt" data-schedule-gantt><div class="project-schedule-gantt-inner">
      <div class="gantt-head"><div class="gantt-corner">TASK</div><div><div class="gantt-months">${monthRow}</div><div class="gantt-days">${dayCells}</div></div></div>
      ${rows}
    </div></div>`;
  }

function renderSchedulePane(pane, project, tasks, editingId){
    const editable = canEditTasks();
    const hasStart = Boolean(project.startDate && /^\d{4}-\d{2}-\d{2}$/.test(String(project.startDate)));
    const sorted = (tasks || []).slice().sort((a, b) => String(a.startDate).localeCompare(String(b.startDate)) || Number(a.id) - Number(b.id));
    const dates = sorted.map(t => t.startDate).concat(sorted.map(t => t.endDate)).filter(Boolean).sort();
    const windowStart = dates[0], windowEnd = dates[dates.length - 1];
    const estimateItems = project.estimateItems || [];
    const linkedEstimateIds = new Set((tasks || []).map(t => Number(t.estimateItemId)).filter(Boolean));
    const estimatePick = (field, selected) => estimateItems.length ? `<select ${field} aria-label="Linked estimate line (optional)"><option value="">Custom task / milestone</option>${estimateItems.filter(item => !linkedEstimateIds.has(Number(item.id)) || Number(item.id) === Number(selected)).map(item => `<option value="${Number(item.id)}" ${Number(selected) === Number(item.id) ? 'selected' : ''}>${escapeHtml(item.name)} · ${Number(item.plannedQuantity) || 0} ${escapeHtml(item.unit || '')}</option>`).join('')}</select>` : '';
    const editorRow = task => `
      <tr class="project-schedule-edit-row" data-schedule-edit-row="${Number(task.id)}">
        <td colspan="6">
          <div class="project-schedule-editor">
            <label class="schedule-field schedule-span-3"><span>Task</span><input type="text" data-edit-task-name value="${escapeHtml(task.name)}" maxlength="160"></label>
            ${estimateItems.length ? `<label class="schedule-field schedule-span-3"><span>From estimate <em>optional</em></span>${estimatePick('data-edit-task-estimate', task.estimateItemId)}</label>` : ''}
            <label class="schedule-field"><span>Working days</span><input type="number" data-edit-task-duration min="1" max="365" step="1" value="${Number(task.durationDays)}"></label>
            <div class="schedule-field schedule-span-2"><span>Waits for <em>links dates</em></span>${chipPick('data-edit-task-deps', sorted.filter(t => Number(t.id) !== Number(task.id)).map(t => ({ value: Number(t.id), label: t.name })), task.predecessorIds)}</div>
            <div class="schedule-field schedule-span-2"><span>People <em>optional</em></span>${memberPick('data-edit-task-members', task.memberIds)}</div>
            <label class="schedule-field"><span>Crew <em>optional</em></span>${crewOptions('data-edit-task-crew', task.crew)}</label>
            <div class="project-schedule-editor-actions"><button type="button" class="primary small" data-save-task-edit="${Number(task.id)}">Save task</button><button type="button" class="secondary small" data-cancel-task-edit>Cancel</button></div>
          </div>
        </td>
      </tr>`;
    const rows = sorted.map(task => (Number(editingId) === Number(task.id) ? editorRow(task) : `
      <tr data-schedule-task-row="${Number(task.id)}">
        <td><strong>${escapeHtml(task.name)}</strong>${task.estimateItemId ? `<small class="project-schedule-est-tag">From estimate · ${escapeHtml(estimateItems.find(item => Number(item.id) === Number(task.estimateItemId))?.name || 'line item')}</small>` : ''}${progressMarkup(estimateProgress(project, task.estimateItemId))}${timelineRow(task, windowStart, windowEnd)}</td>
        <td>${dependencyChips(sorted, task)}</td>
        <td>${Number(task.durationDays)}d</td>
        <td><small>${formatDate(task.startDate)} – ${formatDate(task.endDate)}</small></td>
        <td>${escapeHtml(assigneeLabel(task))}</td>
        <td class="project-schedule-actions">${editable ? `<select data-task-status="${Number(task.id)}" aria-label="Status for ${escapeHtml(task.name)}"><option value="not-started" ${task.status === 'not-started' ? 'selected' : ''}>Not started</option><option value="in-progress" ${task.status === 'in-progress' ? 'selected' : ''}>In progress</option><option value="done" ${task.status === 'done' ? 'selected' : ''}>Done</option></select><button type="button" class="secondary small" data-edit-task="${Number(task.id)}">Edit</button><button type="button" class="danger small" data-delete-task="${Number(task.id)}" aria-label="Delete ${escapeHtml(task.name)}">Delete</button>` : `<span class="status">${taskStatusLabel(task.status)}</span>`}</td>
      </tr>`)).join('');
    pane.innerHTML = `
      <div class="project-schedule-head"><div><h3>Project schedule</h3><p>Linked tasks auto-schedule: a task starts the next working day after everything it waits for is done. Change one and the rest follow.</p></div><div class="project-schedule-view-toggle" role="tablist" aria-label="Schedule view"><button type="button" role="tab" id="project-schedule-table-tab" aria-controls="project-schedule-view-panel" aria-selected="${scheduleView === 'table'}" tabindex="${scheduleView === 'table' ? '0' : '-1'}" data-schedule-view="table" class="${scheduleView === 'table' ? 'active' : ''}">Table</button><button type="button" role="tab" id="project-schedule-timeline-tab" aria-controls="project-schedule-view-panel" aria-selected="${scheduleView === 'timeline'}" tabindex="${scheduleView === 'timeline' ? '0' : '-1'}" data-schedule-view="timeline" class="${scheduleView === 'timeline' ? 'active' : ''}">Timeline</button></div></div>
      ${forecastBanner(project, sorted)}
      ${editable ? `${!hasStart ? `<div class="project-schedule-needs-start" data-schedule-needs-start><strong>No start date on this project yet.</strong><span>Set one below and every task will schedule itself from that day.</span></div>` : ''}
      <div class="project-schedule-add" data-project-dates-form>
        <label style="display:grid;gap:4px;font-size:12px;font-weight:600;color:#64726c">Start date<input type="date" data-project-start-date value="${escapeHtml(String(project.startDate || (typeof companyTodayIso === 'function' ? companyTodayIso() : (typeof localDateIso === 'function' ? localDateIso() : new Date().toISOString().slice(0, 10)))))}"></label>
        <label style="display:grid;gap:4px;font-size:12px;font-weight:600;color:#64726c">Target end <span style="font-weight:400">(optional)</span><input type="date" data-project-end-date value="${escapeHtml(String(project.endDate || ''))}"></label>
        <button type="button" class="secondary small" data-save-project-dates>Save dates</button>
        <span style="font-size:12px;color:#98a5a0;flex:1 1 180px">Tasks count working days from the start date. Change it any time and the dates follow.</span>
      </div>
      <div class="project-schedule-add" data-schedule-add-form>
        <div class="schedule-add-grid">
          <label class="schedule-field schedule-span-3"><span>Task name</span><input type="text" data-new-task-name placeholder="e.g. Form footings, pour slab, rough inspection…" maxlength="160"></label>
          ${estimateItems.length ? `<label class="schedule-field schedule-span-3"><span>From estimate <em>optional — prefills the name</em></span>${estimatePick('data-new-task-estimate', '')}</label>` : ''}
          <label class="schedule-field"><span>Working days</span><input type="number" data-new-task-duration min="1" max="365" step="1" value="1"></label>
          <div class="schedule-field schedule-span-2"><span>Waits for <em>links the dates</em></span>${chipPick('data-new-task-deps', sorted.map(t => ({ value: Number(t.id), label: t.name })), [])}</div>
          <div class="schedule-field schedule-span-2"><span>People <em>optional</em></span>${memberPick('data-new-task-members', [])}</div>
          <label class="schedule-field"><span>Crew <em>optional</em></span>${crewOptions('data-new-task-crew', '')}</label>
        </div>
        <div class="schedule-add-actions"><button type="button" class="primary" data-add-task>＋ Add task</button><span class="schedule-add-hint">Dates set themselves from the links — no calendar needed.</span></div>
      </div>` : ''}
      <div id="project-schedule-view-panel" role="tabpanel" aria-labelledby="project-schedule-${scheduleView}-tab">${sorted.length ? (scheduleView === 'timeline' ? ganttChart(project, sorted) : `<div class="project-schedule-table-wrap"><table class="project-schedule-table"><thead><tr><th>Task</th><th>Waits for</th><th>Length</th><th>Dates</th><th>Assigned</th><th>${editable ? 'Status / actions' : 'Status'}</th></tr></thead><tbody>${rows}</tbody></table></div>`) : `<div class="project-tab-empty"><strong>No scheduled tasks yet</strong><p>${editable ? 'Add the project’s phases or milestones above and link them so the dates keep themselves honest.' : 'Your office will add the project schedule here.'}</p></div>`}</div>`;
    if (Number(editingId)) { const select = pane.querySelector(`[data-schedule-edit-row="${Number(editingId)}"] [data-edit-task-deps]`); if (select) { const editing = taskById(tasks, editingId); [...select.options].forEach(option => { option.selected = (editing?.predecessorIds || []).map(Number).includes(Number(option.value)); }); } }
    wireSchedulePane(pane, project, tasks, editingId);
  }

  function selectedValues(select){ return [...select.options].filter(o => o.selected && o.value !== '').map(o => Number(o.value)); }

  function wireSchedulePane(pane, project, tasks){
    const editable = canEditTasks();
    const viewTabs = [...pane.querySelectorAll('[data-schedule-view]')];
    const activateView = (button, moveFocus) => {
      if (!button || scheduleView === button.dataset.scheduleView) return;
      scheduleView = button.dataset.scheduleView;
      renderSchedulePane(pane, project, tasks, null);
      if (moveFocus) pane.querySelector(`[data-schedule-view="${scheduleView}"]`)?.focus();
    };
    viewTabs.forEach((button, index) => {
      button.onclick = () => activateView(button, true);
      button.onkeydown = event => {
        let nextIndex = null;
        if (event.key === 'ArrowRight' || event.key === 'ArrowDown') nextIndex = (index + 1) % viewTabs.length;
        else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') nextIndex = (index - 1 + viewTabs.length) % viewTabs.length;
        else if (event.key === 'Home') nextIndex = 0;
        else if (event.key === 'End') nextIndex = viewTabs.length - 1;
        if (nextIndex == null) return;
        event.preventDefault();
        activateView(viewTabs[nextIndex], true);
      };
    });
    pane.querySelectorAll('.schedule-chip').forEach(chip => chip.onclick = () => {
      const pick = chip.closest('.schedule-chip-pick'), select = pick && pick.querySelector('select');
      const on = chip.classList.toggle('is-on');
      chip.setAttribute('aria-pressed', String(on));
      if (select) [...select.options].forEach(option => { if (String(option.value) === String(chip.dataset.chipValue)) option.selected = on; });
    });
    const refresh = payload => { renderSchedulePane(pane, project, payload.tasks, null); syncLaneWithServer(); };
    const notifyChanged = payload => { const others = (payload.changed || []).filter(id => true).length; notify(others > 1 ? `Schedule updated — ${others} tasks moved` : 'Schedule updated'); };
    const saveDates = pane.querySelector('[data-save-project-dates]');
    if (saveDates) saveDates.onclick = async () => {
      const startDate = pane.querySelector('[data-project-start-date]').value, endDate = pane.querySelector('[data-project-end-date]').value;
      if (!startDate) return notify('Pick a start date first');
      if (endDate && endDate < startDate) return notify('Target end must be on or after the start date');
      try {
        const payload = await api(`/api/projects/${project.id}`, { method: 'PATCH', body: JSON.stringify({ startDate, endDate }) });
        project.startDate = payload.startDate; project.endDate = payload.endDate;
        const entry = (typeof projects !== 'undefined' ? projects : []).find(item => Number(item.id) === Number(project.id));
        if (entry) { entry.startDate = payload.startDate; entry.endDate = payload.endDate; }
        renderSchedulePane(pane, project, Array.isArray(payload.tasks) ? payload.tasks : [], null);
        try { const state = await api('/api/state'); if (typeof assignments !== 'undefined') assignments = state.assignments || []; laneTasksCache = state.projectTasks || []; laneTasksFetchedAt = Date.now(); if (typeof renderSchedule === 'function') renderSchedule(); } catch (error) { /* board refresh is best-effort */ }
        const moved = (payload.changed || []).length;
        notify(moved > 1 ? `Dates saved — ${moved} tasks moved` : 'Project dates saved');
      } catch (error) { notify(error.message); }
    };
    const addButton = pane.querySelector('[data-add-task]');
    const newEstimateSelect = pane.querySelector('[data-new-task-estimate]');
    if (newEstimateSelect) newEstimateSelect.onchange = () => {
      const item = (project.estimateItems || []).find(row => Number(row.id) === Number(newEstimateSelect.value)), nameInput = pane.querySelector('[data-new-task-name]');
      if (item && nameInput && !nameInput.value.trim()) nameInput.value = item.name;
    };
    if (addButton) addButton.onclick = async () => {
      const name = pane.querySelector('[data-new-task-name]').value.trim(), durationDays = Number(pane.querySelector('[data-new-task-duration]').value), predecessorIds = selectedValues(pane.querySelector('[data-new-task-deps]')), estimateItemId = Number(pane.querySelector('[data-new-task-estimate]')?.value) || null;
      const memberIds = selectedValues(pane.querySelector('[data-new-task-members]')), crew = pane.querySelector('[data-new-task-crew]')?.value || '';
      if (!name) return notify('Give the task a name first');
      try { const payload = await api(`/api/projects/${project.id}/tasks`, { method: 'POST', body: JSON.stringify({ name, durationDays, predecessorIds, estimateItemId, memberIds, crew }) }); refresh(payload); notifyChanged(payload); }
      catch (error) { notify(error.message); }
    };
    if (!editable) return;
    pane.querySelectorAll('[data-task-status]').forEach(select => select.onchange = async () => {
      try { const payload = await api(`/api/project-tasks/${select.dataset.taskStatus}`, { method: 'PATCH', body: JSON.stringify({ status: select.value }) }); refresh(payload); }
      catch (error) { notify(error.message); }
    });
    pane.querySelectorAll('[data-edit-task]').forEach(button => button.onclick = () => renderSchedulePane(pane, project, tasks, Number(button.dataset.editTask)));
    pane.querySelectorAll('[data-delete-task]').forEach(button => button.onclick = async () => {
      const task = taskById(tasks, button.dataset.deleteTask);
      if (!task || !confirm(projectScheduleCopy(`Delete “${task.name}”? Linked tasks will move up to fill the gap.`))) return;
      try { const payload = await api(`/api/project-tasks/${task.id}`, { method: 'DELETE' }); refresh(payload); notifyChanged(payload); }
      catch (error) { notify(error.message); }
    });
    const saveEdit = pane.querySelector('[data-save-task-edit]');
    if (saveEdit) saveEdit.onclick = async () => {
      const row = pane.querySelector(`[data-schedule-edit-row="${saveEdit.dataset.saveTaskEdit}"]`);
      const name = row.querySelector('[data-edit-task-name]').value.trim(), durationDays = Number(row.querySelector('[data-edit-task-duration]').value), predecessorIds = selectedValues(row.querySelector('[data-edit-task-deps]')), estimateItemId = Number(row.querySelector('[data-edit-task-estimate]')?.value) || null;
      const memberIds = selectedValues(row.querySelector('[data-edit-task-members]')), crew = row.querySelector('[data-edit-task-crew]')?.value || '';
      if (!name) return notify('Give the task a name first');
      try { const payload = await api(`/api/project-tasks/${saveEdit.dataset.saveTaskEdit}`, { method: 'PATCH', body: JSON.stringify({ name, durationDays, predecessorIds, estimateItemId, memberIds, crew }) }); refresh(payload); notifyChanged(payload); }
      catch (error) { notify(error.message); }
    };
    const cancelEdit = pane.querySelector('[data-cancel-task-edit]');
    if (cancelEdit) cancelEdit.onclick = () => renderSchedulePane(pane, project, tasks, null);
  }

  async function paintProjectScheduleTab(projectId){
    const content = document.getElementById('project-detail-content');
    if (!content) return;
    const tabs = content.querySelector('.project-detail-tabs');
    if (!tabs) return;
    const project = (typeof projects !== 'undefined' ? projects : []).find(item => Number(item.id) === Number(projectId));
    if (!project) return;
    if (!tabs.querySelector('[data-project-detail-tab="schedule"]')) {
      tabs.insertAdjacentHTML('beforeend', '<button type="button" data-project-detail-tab="schedule">Schedule</button>');
      const panes = content;
      panes.insertAdjacentHTML('beforeend', '<section class="project-detail-pane" data-project-detail-pane="schedule"><div class="project-tab-empty"><strong>Loading schedule…</strong></div></section>');
      tabs.querySelector('[data-project-detail-tab="schedule"]').onclick = () => {
        document.querySelectorAll('[data-project-detail-tab]').forEach(tab => tab.classList.toggle('active', tab === tabs.querySelector('[data-project-detail-tab="schedule"]')));
        document.querySelectorAll('[data-project-detail-pane]').forEach(paneEl => paneEl.classList.toggle('active', paneEl.dataset.projectDetailPane === 'schedule'));
        paintProjectScheduleTab(projectId);
      };
    }
    const pane = content.querySelector('[data-project-detail-pane="schedule"]');
    if (!pane) return;
    const sequence = ++scheduleTabSequence;
    try {
      const taskList = await api(`/api/projects/${project.id}/tasks`);
      if (sequence !== scheduleTabSequence || !pane.isConnected) return;
      renderSchedulePane(pane, project, Array.isArray(taskList) ? taskList : [], null);
    } catch (error) {
      if (sequence !== scheduleTabSequence || !pane.isConnected) return;
      pane.innerHTML = `<div class="project-tab-empty"><strong>Schedule could not be loaded</strong><p>${escapeHtml(error.message)}</p></div>`;
    }
  }

  // --- Unassigned lane on the team schedule ---------------------------------
  // Scheduled tasks with nobody on them surface below the schedule board.
  // Office drags a task onto a person's day (or picks a person from the chip
  // on touch screens) and the server writes daily assignments for the rest of
  // the task. Chips intentionally carry no data-assignment attribute so the
  // board's assignment wiring never confuses a task with an assignment row.
  let laneTasksCache = null, laneTasksFetchedAt = 0, laneSequence = 0, draggedTaskId = null, laneDropWired = false, laneTouchAttached = false, renderScheduleWithLane = null, laneVisibleFirstDay = '';

  function canAssignTasks(){ return typeof canManageSchedule === 'function' && canManageSchedule(); }

  function laneVisibleDays(){
    if (typeof scheduleView === 'undefined' || typeof schedulePeriodDays !== 'function') return [];
    if (scheduleView === 'month') return [];
    try { return schedulePeriodDays(); } catch (error) { return []; }
  }

  function laneTeamOptions(){
    if (typeof team === 'undefined' || typeof isOfficeMember !== 'function') return [];
    const filter = document.getElementById('schedule-crew-filter'), showOffice = document.getElementById('schedule-show-office');
    const crew = filter ? filter.value : 'all', includeOffice = showOffice ? showOffice.checked : false;
    return team.filter(member => (includeOffice || !isOfficeMember(member)) && (!crew || crew === 'all' || member.crew === crew));
  }

  function laneAssignmentTargets(members){
    const people = (members || []).filter(member => member && member.id != null);
    const crews = [...new Set(people.filter(member => !isOfficeMember(member)).map(member => String(member.crew || '').trim()).filter(name => name && !/^(office|unassigned)$/i.test(name)))].sort((a, b) => a.localeCompare(b));
    return {
      crews: crews.map(crew => ({ value: `crew:${encodeURIComponent(crew)}`, label: `${crew} · ${people.filter(member => !isOfficeMember(member) && String(member.crew || '').trim() === crew).length} people` })),
      people: people.slice().sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''))).map(member => ({ value: `member:${Number(member.id)}`, label: `${member.name} · ${member.crew || member.role || 'Individual'}` }))
    };
  }

  function laneAssignmentTarget(value){
    const raw = String(value || '');
    if (raw.startsWith('crew:')) {
      let crew = '';
      try { crew = decodeURIComponent(raw.slice(5)); } catch (error) { crew = raw.slice(5); }
      return crew ? { crew } : null;
    }
    if (raw.startsWith('member:')) {
      const memberId = Number(raw.slice(7));
      return Number.isFinite(memberId) && memberId > 0 ? { memberId } : null;
    }
    return null;
  }

  function visibleLaneStart(days){
    if (!(days || []).length) return '';
    const today = typeof companyTodayIso === 'function' ? companyTodayIso() : days[0].date;
    return ((days || []).find(day => day.date >= today) || days[0]).date;
  }

  function laneAssignmentDate(task, firstDay){
    const start = String(task?.startDate || firstDay || ''), end = String(task?.endDate || start), visible = String(firstDay || start);
    if (visible < start) return start;
    if (visible > end) return end;
    return visible;
  }

  function currentLaneDropDate(){ return laneVisibleFirstDay; }

  function unassignedLaneTasks(){
    const activeProjects = new Set((typeof projects !== 'undefined' ? projects : []).filter(project => !project.archived).map(project => Number(project.id)));
    return (laneTasksCache || [])
      .filter(task => task && activeProjects.has(Number(task.projectId)) && !(task.memberIds || []).length && !task.crew && task.status !== 'done')
      .sort((a, b) => String(a.startDate).localeCompare(String(b.startDate)) || Number(a.id) - Number(b.id));
  }

  // Tasks changed in the project Schedule tab must reach the team-schedule
  // lane immediately — the 30s cache would otherwise hide fresh work.
  function syncLaneWithServer(){ return refreshLaneTasks(true).then(() => paintUnassignedLane()); }

  async function refreshLaneTasks(force){
    const stamp = Date.now();
    if (!force && laneTasksCache && laneTasksFetchedAt && stamp - laneTasksFetchedAt < 30000) return;
    laneTasksFetchedAt = stamp;
    try {
      const state = await api('/api/state');
      laneTasksCache = state.projectTasks || [];
    } catch (error) { /* a stale lane beats an empty one */ }
  }

  function removeLane(){ document.querySelectorAll('.schedule-unassigned').forEach(element => element.remove()); }

  function wireLaneChips(section){
    if (canAssignTasks() && !laneDropWired) {
      laneDropWired = true;
      document.addEventListener('drop', event => {
        if (!draggedTaskId) return;
        event.preventDefault();
        event.stopPropagation();
        const cell = typeof event.target.closest === 'function' ? event.target.closest('[data-schedule-date]') : null;
        const crewRow = !cell && typeof event.target.closest === 'function' ? event.target.closest('[data-schedule-crew-drop]') : null;
        document.querySelectorAll('.drag-over').forEach(element => element.classList.remove('drag-over'));
        const taskId = draggedTaskId;
        draggedTaskId = null;
        if (cell) assignTaskTo(taskId, { memberId: Number(cell.dataset.scheduleMember) }, cell.dataset.scheduleDate);
        else if (crewRow) assignTaskTo(taskId, { crew: crewRow.dataset.scheduleCrewDrop }, currentLaneDropDate());
      }, true);
    }
    section.querySelectorAll('.schedule-task-chip').forEach(chip => {
      const taskId = Number(chip.dataset.scheduleTask);
      chip.ondragstart = event => {
        if (!canAssignTasks()) { event.preventDefault(); return; }
        draggedTaskId = taskId;
        event.dataTransfer.effectAllowed = 'move';
        if (typeof event.dataTransfer.setData === 'function') event.dataTransfer.setData('text/plain', String(taskId));
        chip.classList.add('dragging');
      };
      chip.ondragend = () => {
        draggedTaskId = null;
        chip.classList.remove('dragging');
        document.querySelectorAll('.drag-over').forEach(element => element.classList.remove('drag-over'));
      };
    });
    section.querySelectorAll('[data-task-assign-go]').forEach(button => button.onclick = () => {
      const select = section.querySelector(`[data-task-assign-target="${button.dataset.taskAssignGo}"]`);
      const dateInput = section.querySelector(`[data-task-assign-date="${button.dataset.taskAssignGo}"]`);
      const target = laneAssignmentTarget(select && select.value);
      if (!target) return notify('Choose a crew or person first');
      if (!dateInput || !/^\d{4}-\d{2}-\d{2}$/.test(dateInput.value)) return notify('Choose a start date first');
      if (dateInput.value < dateInput.min || dateInput.value > dateInput.max) {
        dateInput.focus();
        return notify(`Choose a start date between ${formatDate(dateInput.min)} and ${formatDate(dateInput.max)}`);
      }
      assignTaskTo(Number(button.dataset.taskAssignGo), target, dateInput.value);
    });
  }

  function paintUnassignedLane(){
    removeLane();
    if (typeof currentRole !== 'undefined' && currentRole !== 'office') return;
    const board = document.getElementById('schedule-board'), days = laneVisibleDays();
    if (!board || !days.length) return;
    const tasks = unassignedLaneTasks(), editable = canAssignTasks(), members = laneTeamOptions(), targets = laneAssignmentTargets(members);
    if (!tasks.length && !editable) return;
    const firstDay = visibleLaneStart(days);
    laneVisibleFirstDay = firstDay;
    const chip = task => {
      const project = (typeof projects !== 'undefined' ? projects : []).find(item => Number(item.id) === Number(task.projectId));
      const label = `${project && project.code ? project.code : 'JOB'} · ${project ? project.name : 'Project'} — ${task.name}`;
      const assignDate = laneAssignmentDate(task, firstDay);
      const targetOptions = `${targets.crews.length ? `<optgroup label="Crews">${targets.crews.map(option => `<option value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</option>`).join('')}</optgroup>` : ''}${targets.people.length ? `<optgroup label="People">${targets.people.map(option => `<option value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</option>`).join('')}</optgroup>` : ''}`;
      return `<div class="schedule-task-chip" draggable="${editable}" data-schedule-task="${Number(task.id)}" title="${escapeHtml(label)}">
        <div class="schedule-task-chip-main"><b>${escapeHtml(project && project.code ? project.code : 'JOB')}</b> <strong>${escapeHtml(task.name)}</strong><small>${escapeHtml(project ? project.name : '')} · ${escapeHtml(formatDate(task.startDate))} – ${escapeHtml(formatDate(task.endDate))} · ${Number(task.durationDays)}d</small></div>
        ${editable && (targets.crews.length || targets.people.length) ? `<div class="schedule-task-assign"><select data-task-assign-target="${Number(task.id)}" aria-label="Assign ${escapeHtml(task.name)} to"><option value="">Choose a crew or person</option>${targetOptions}</select><label class="schedule-task-assign-date"><span>Start date</span><input type="date" data-task-assign-date="${Number(task.id)}" value="${escapeHtml(assignDate)}" min="${escapeHtml(task.startDate)}" max="${escapeHtml(task.endDate)}" aria-label="Start date"></label><button type="button" class="secondary small" data-task-assign-go="${Number(task.id)}">Assign</button></div>` : ''}
      </div>`;
    };
    board.insertAdjacentHTML('afterend', `<section class="schedule-unassigned" aria-label="Unassigned project work">
      <div class="schedule-unassigned-head"><h3>Unassigned project work</h3><p>${tasks.length ? (editable ? 'Drag a task onto someone’s day — or choose a crew or person here.' : 'Waiting for the office to assign a crew.') : 'Every scheduled task has someone on it.'}</p></div>
      <div class="schedule-unassigned-list">${tasks.length ? tasks.map(chip).join('') : '<p class="schedule-unassigned-empty">Nothing waiting for a crew.</p>'}</div>
    </section>`);
    wireLaneChips(document.querySelector('.schedule-unassigned'));
  }

  function wrapRenderSchedule(){
    if (renderScheduleWithLane || typeof renderSchedule !== 'function') return;
    renderScheduleWithLane = renderSchedule;
    renderSchedule = function(){
      const result = renderScheduleWithLane.apply(this, arguments);
      const sequence = ++laneSequence;
      refreshLaneTasks(false).then(() => { if (sequence === laneSequence) paintUnassignedLane(); });
      paintUnassignedLane();
      return result;
    };
  }

  function attachLaneTouchDrag(){
    if (laneTouchAttached || typeof PDLScheduleTouchDrag === 'undefined' || !PDLScheduleTouchDrag || typeof PDLScheduleTouchDrag.attach !== 'function') return;
    laneTouchAttached = true;
    PDLScheduleTouchDrag.attach(document, { blockSelector: '[data-schedule-task]', canManage: canAssignTasks, onMove: work => { if (work.taskId) assignTaskTo(work.taskId, { memberId: work.targetMemberId }, work.date); } });
  }

  async function assignTaskTo(taskId, target, fromDate){
    if (!canAssignTasks() || !taskId || !target || (!target.memberId && !target.crew)) return;
    const task = (laneTasksCache || []).find(item => Number(item.id) === Number(taskId));
    try {
      const payload = await api(`/api/project-tasks/${taskId}/assign`, { method: 'POST', body: JSON.stringify(target.crew ? { crew: target.crew, fromDate } : { memberId: target.memberId, fromDate }) });
      if (task && Array.isArray(payload.tasks)) laneTasksCache = [...(laneTasksCache || []).filter(item => Number(item.projectId) !== Number(task.projectId)), ...payload.tasks];
      laneTasksFetchedAt = Date.now();
      if (typeof renderSchedule === 'function') renderSchedule();
      if (typeof renderMyDay === 'function') renderMyDay();
      const notes = [`${payload.created} day${Number(payload.created) === 1 ? '' : 's'} scheduled`];
      if (payload.merged) notes.push(`${payload.merged} joined an existing shift`);
      if (payload.skipped) notes.push(`${payload.skipped} skipped (time off or another job)`);
      const who = target.crew ? `Crew ${payload.crew} (${payload.members} ${Number(payload.members) === 1 ? 'person' : 'people'})` : payload.memberName;
      notify(`${who} is on “${task ? task.name : 'the task'}” — ${notes.join(', ')}`);
      try {
        const state = await api('/api/state');
        if (typeof assignments !== 'undefined') assignments = state.assignments || assignments;
        laneTasksCache = state.projectTasks || laneTasksCache;
        laneTasksFetchedAt = Date.now();
        if (typeof renderSchedule === 'function') renderSchedule();
        if (typeof renderMyDay === 'function') renderMyDay();
      } catch (error) { /* the assignment is committed; the next refresh reconciles full state */ }
    } catch (error) {
      notify(error.message);
    }
  }

  if (typeof openProject === 'function') {
    const openProjectWithSchedule = openProject;
    openProject = async function(id, view){
      const result = await openProjectWithSchedule(id, view);
      if (view && !view.current()) return result;
      paintProjectScheduleTab(id);
      return result;
    };
  }
  window.paintProjectScheduleTab = paintProjectScheduleTab;
  window.PDLProjectScheduleUI = { assignTaskTo, paintUnassignedLane, estimateProgress, get draggingTaskId(){ return draggedTaskId; } };
  wrapRenderSchedule();
  attachLaneTouchDrag();
})();
