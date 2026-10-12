(function(){
  'use strict';
  // Project detail "Schedule" tab: linked tasks with auto-computed dates.
  // The server schedules (project-schedule.js engine); this module renders
  // the tab, wires add/edit/delete/status, and repaints after every change.
  let scheduleTabSequence = 0;

  function selectedWorkspace(){ return window.pdlWorkspaceActions?.enabled() === true || window.pdlProductionRoles?.rolePolicies() === true; }
  function taskAccess(action){ const access = window.pdlProductionRoles?.rolePolicies() === true ? currentUser?.effectiveCapabilities?.scheduling : currentUser?.schedulingAccess; return access?.[action] === true; }
  function canViewTasks(project){
    if (!selectedWorkspace()) return true;
    if (!taskAccess('view')) return false;
    if (currentUser.role === 'project_manager') return (currentUser.projectIds || []).map(Number).includes(Number(project.id));
    if (['field', 'foreman'].includes(currentUser.role)) return [...(assignments || []), ...(workdays || [])].some(row => Number(row.projectId) === Number(project.id) && (row.memberIds || []).map(Number).includes(Number(currentUser.memberId)));
    return ['owner', 'admin'].includes(currentUser.role);
  }
  function taskPermission(action, project, task){
    if (typeof canManageSchedule !== 'function' || !canManageSchedule()) return false;
    if (!selectedWorkspace()) return true;
    if (task?.readOnly === true) return false;
    if (!taskAccess(action)) return false;
    if (currentUser?.role !== 'project_manager') return ['owner', 'admin'].includes(currentUser?.role);
    if (project && !(currentUser.projectIds || []).map(Number).includes(Number(project.id))) return false;
    const crews = new Set((currentUser.assignedCrews || []).map(name => String(name).trim().toLowerCase()));
    return !task || (task.memberIds || []).every(id => (team || []).some(member => Number(member.id) === Number(id) && crews.has(String(member.crew || '').trim().toLowerCase()))) && (!task.crew || crews.has(String(task.crew).trim().toLowerCase()));
  }
  function taskStatusLabel(status){ return status === 'done' ? 'Done' : status === 'in-progress' ? 'In progress' : 'Not started'; }
  function memberNames(ids){ return (ids || []).map(id => (team || []).find(m => Number(m.id) === Number(id))?.name).filter(Boolean); }
  function assigneeLabel(task){
    const people = memberNames(task.memberIds);
    if (people.length) return people.join(', ');
    if (task.crew) return task.crew + ' (crew)';
    return 'Unassigned';
  }
  function taskById(tasks, id){ return (tasks || []).find(t => Number(t.id) === Number(id)); }
  function dependencyChips(tasks, task){
    const deps = (task.predecessorIds || []).map(id => taskById(tasks, id)).filter(Boolean);
    return deps.length ? deps.map(d => `<span class="project-schedule-dep">${escapeHtml(d.name)}</span>`).join('') : '<span class="project-schedule-none">None</span>';
  }

  function timelineRow(task, windowStart, windowEnd){
    if (!windowStart || !windowEnd) return '';
    const total = Math.max(1, Date.parse(windowEnd + 'T12:00:00') - Date.parse(windowStart + 'T12:00:00'));
    const left = Math.min(96, Math.max(0, (Date.parse(task.startDate + 'T12:00:00') - Date.parse(windowStart + 'T12:00:00')) / total * 100));
    const right = Math.min(96, Math.max(0, (Date.parse(windowEnd + 'T12:00:00') - Date.parse(task.endDate + 'T12:00:00')) / total * 100));
    return `<div class="project-schedule-track" aria-hidden="true"><i style="left:${left}%;right:${right}%"></i></div>`;
  }

  function renderSchedulePane(pane, project, tasks, editingId){
    const create = taskPermission('create', project), edit = taskPermission('edit', project), remove = taskPermission('remove', project), editable = create || edit || remove;
    const hasStart = Boolean(project.startDate && /^\d{4}-\d{2}-\d{2}$/.test(String(project.startDate)));
    const sorted = (tasks || []).slice().sort((a, b) => String(a.startDate).localeCompare(String(b.startDate)) || Number(a.id) - Number(b.id));
    const dates = sorted.map(t => t.startDate).concat(sorted.map(t => t.endDate)).filter(Boolean).sort();
    const windowStart = dates[0], windowEnd = dates[dates.length - 1];
    const depsOptions = sorted.map(t => `<option value="${Number(t.id)}">${escapeHtml(t.name)}</option>`).join('');
    const estimateItems = project.estimateItems || [];
    const linkedEstimateIds = new Set((tasks || []).map(t => Number(t.estimateItemId)).filter(Boolean));
    const estimatePick = (field, selected) => estimateItems.length ? `<select ${field} aria-label="Linked estimate line (optional)"><option value="">Custom task / milestone</option>${estimateItems.filter(item => !linkedEstimateIds.has(Number(item.id)) || Number(item.id) === Number(selected)).map(item => `<option value="${Number(item.id)}" ${Number(selected) === Number(item.id) ? 'selected' : ''}>${escapeHtml(item.name)} · ${Number(item.plannedQuantity) || 0} ${escapeHtml(item.unit || '')}</option>`).join('')}</select>` : '';
    const editorRow = task => `
      <tr class="project-schedule-edit-row" data-schedule-edit-row="${Number(task.id)}">
        <td colspan="6">
          <div class="project-schedule-editor">
            <label>Task<input type="text" data-edit-task-name value="${escapeHtml(task.name)}" maxlength="160"></label>
            ${estimatePick('data-edit-task-estimate', task.estimateItemId)}
            <label>Working days<input type="number" data-edit-task-duration min="1" max="365" step="1" value="${Number(task.durationDays)}"></label>
            <label>Waits for<select data-edit-task-deps multiple size="${Math.min(4, Math.max(2, sorted.length))}">${depsOptions.replace(`value="${Number(task.id)}"`, 'value="" disabled')}</select></label>
            <div class="project-schedule-editor-actions"><button type="button" class="primary small" data-save-task-edit="${Number(task.id)}">Save task</button><button type="button" class="secondary small" data-cancel-task-edit>Cancel</button></div>
          </div>
        </td>
      </tr>`;
    const rows = sorted.map(task => (Number(editingId) === Number(task.id) && taskPermission('edit', project, task) ? editorRow(task) : `
      <tr data-schedule-task-row="${Number(task.id)}">
        <td><strong>${escapeHtml(task.name)}</strong>${task.estimateItemId ? `<small class="project-schedule-est-tag">From estimate · ${escapeHtml(estimateItems.find(item => Number(item.id) === Number(task.estimateItemId))?.name || 'line item')}</small>` : ''}${timelineRow(task, windowStart, windowEnd)}</td>
        <td>${dependencyChips(sorted, task)}</td>
        <td>${Number(task.durationDays)}d</td>
        <td><small>${formatDate(task.startDate)} – ${formatDate(task.endDate)}</small></td>
        <td>${escapeHtml(assigneeLabel(task))}</td>
        <td class="project-schedule-actions">${taskPermission('edit', project, task) ? `<select data-task-status="${Number(task.id)}" aria-label="Status for ${escapeHtml(task.name)}"><option value="not-started" ${task.status === 'not-started' ? 'selected' : ''}>Not started</option><option value="in-progress" ${task.status === 'in-progress' ? 'selected' : ''}>In progress</option><option value="done" ${task.status === 'done' ? 'selected' : ''}>Done</option></select><button type="button" class="secondary small" data-edit-task="${Number(task.id)}">Edit</button>` : `<span class="status">${taskStatusLabel(task.status)}</span>`}${taskPermission('remove', project, task) ? `<button type="button" class="danger small" data-delete-task="${Number(task.id)}" aria-label="Delete ${escapeHtml(task.name)}">Delete</button>` : ''}</td>
      </tr>`)).join('');
    pane.innerHTML = `
      <div class="project-schedule-head"><div><h3>Project schedule</h3><p>Linked tasks auto-schedule: a task starts the next working day after everything it waits for is done. Change one and the rest follow.</p></div></div>
      ${edit ? `${!hasStart ? `<div data-schedule-needs-start style="display:flex;gap:8px 16px;align-items:baseline;flex-wrap:wrap;padding:12px 14px;margin-bottom:12px;border:1px solid #e5c97a;background:#fdf6e3;border-radius:12px;font-size:14px"><strong>No start date on this project yet.</strong><span style="color:#6b5d33">Set one below and every task will schedule itself from that day.</span></div>` : ''}
      <div class="project-schedule-add" data-project-dates-form>
        <label style="display:grid;gap:4px;font-size:12px;font-weight:600;color:#64726c">Start date<input type="date" data-project-start-date value="${escapeHtml(String(project.startDate || (typeof localDateIso === 'function' ? localDateIso() : new Date().toISOString().slice(0, 10))))}"></label>
        <label style="display:grid;gap:4px;font-size:12px;font-weight:600;color:#64726c">Target end <span style="font-weight:400">(optional)</span><input type="date" data-project-end-date value="${escapeHtml(String(project.endDate || ''))}"></label>
        <button type="button" class="secondary small" data-save-project-dates>Save dates</button>
        <span style="font-size:12px;color:#98a5a0;flex:1 1 180px">Tasks count working days from the start date. Change it any time and the dates follow.</span>
      </div>` : ''}
      ${create ? `<div class="project-schedule-add" data-schedule-add-form>
        ${estimatePick('data-new-task-estimate', '')}
        <input type="text" data-new-task-name placeholder="Task name or pick an estimate line above" maxlength="160" aria-label="Task name">
        <input type="number" data-new-task-duration min="1" max="365" step="1" value="1" aria-label="Working days">
        <select data-new-task-deps multiple size="${Math.min(4, Math.max(2, sorted.length))}" aria-label="Waits for">${depsOptions || '<option value="" disabled>No tasks yet</option>'}</select>
        <button type="button" class="primary" data-add-task>＋ Add task</button>
      </div>` : ''}
      ${sorted.length ? `<div class="project-schedule-table-wrap"><table class="project-schedule-table"><thead><tr><th>Task</th><th>Waits for</th><th>Length</th><th>Dates</th><th>Assigned</th><th>${editable ? 'Status / actions' : 'Status'}</th></tr></thead><tbody>${rows}</tbody></table></div>` : `<div class="project-tab-empty"><strong>No scheduled tasks yet</strong><p>${editable ? 'Add the project’s phases or milestones above and link them so the dates keep themselves honest.' : 'Your office will add the project schedule here.'}</p></div>`}`;
    if (Number(editingId)) { const select = pane.querySelector(`[data-schedule-edit-row="${Number(editingId)}"] [data-edit-task-deps]`); if (select) { const editing = taskById(tasks, editingId); [...select.options].forEach(option => { option.selected = (editing?.predecessorIds || []).map(Number).includes(Number(option.value)); }); } }
    wireSchedulePane(pane, project, tasks, editingId);
  }

  function selectedValues(select){ return [...select.options].filter(o => o.selected && o.value !== '').map(o => Number(o.value)); }

  function wireSchedulePane(pane, project, tasks){
    const opening = scheduleTabSequence, current = () => opening === scheduleTabSequence && pane.isConnected;
    const refresh = async payload => { if (selectedWorkspace()) return freshSchedule(project.id); if (current()) { renderSchedulePane(pane, project, payload.tasks, null); await syncLaneWithServer(); } };
    const notifyChanged = payload => { const others = (payload.changed || []).filter(id => true).length; notify(others > 1 ? `Schedule updated — ${others} tasks moved` : 'Schedule updated'); };
    const saveDates = pane.querySelector('[data-save-project-dates]');
    if (saveDates) saveDates.onclick = async () => {
      if (!current() || !taskPermission('edit', project)) return;
      const startDate = pane.querySelector('[data-project-start-date]').value, endDate = pane.querySelector('[data-project-end-date]').value;
      if (!startDate) return notify('Pick a start date first');
      if (endDate && endDate < startDate) return notify('Target end must be on or after the start date');
      try {
        const payload = await api(`/api/projects/${project.id}`, { method: 'PATCH', body: JSON.stringify({ startDate, endDate }) });
        if (selectedWorkspace()) await freshSchedule(project.id);
        else if (current()) {
          project.startDate = payload.startDate; project.endDate = payload.endDate;
          const entry = (typeof projects !== 'undefined' ? projects : []).find(item => Number(item.id) === Number(project.id));
          if (entry) { entry.startDate = payload.startDate; entry.endDate = payload.endDate; }
          renderSchedulePane(pane, project, Array.isArray(payload.tasks) ? payload.tasks : [], null);
          try { const state = await api('/api/state'); if (typeof assignments !== 'undefined') assignments = state.assignments || []; laneTasksCache = state.projectTasks || []; laneTasksFetchedAt = Date.now(); if (typeof renderSchedule === 'function') renderSchedule(); } catch (error) { /* board refresh is best-effort */ }
        }
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
      if (!current() || !taskPermission('create', project)) return;
      const name = pane.querySelector('[data-new-task-name]').value.trim(), durationDays = Number(pane.querySelector('[data-new-task-duration]').value), predecessorIds = selectedValues(pane.querySelector('[data-new-task-deps]')), estimateItemId = Number(pane.querySelector('[data-new-task-estimate]')?.value) || null;
      if (!name) return notify('Give the task a name first');
      try { const payload = await api(`/api/projects/${project.id}/tasks`, { method: 'POST', body: JSON.stringify({ name, durationDays, predecessorIds, estimateItemId }) }); await refresh(payload); notifyChanged(payload); }
      catch (error) { notify(error.message); }
    };
    pane.querySelectorAll('[data-task-status]').forEach(select => select.onchange = async () => {
      const task = taskById(tasks, select.dataset.taskStatus); if (!current() || !taskPermission('edit', project, task)) return;
      try { const payload = await api(`/api/project-tasks/${select.dataset.taskStatus}`, { method: 'PATCH', body: JSON.stringify({ status: select.value }) }); await refresh(payload); }
      catch (error) { if (current()) select.value = task?.status || 'not-started'; notify(error.message); }
    });
    pane.querySelectorAll('[data-edit-task]').forEach(button => button.onclick = () => { if (current() && taskPermission('edit', project, taskById(tasks, button.dataset.editTask))) renderSchedulePane(pane, project, tasks, Number(button.dataset.editTask)); });
    pane.querySelectorAll('[data-delete-task]').forEach(button => button.onclick = async () => {
      const task = taskById(tasks, button.dataset.deleteTask);
      if (!current() || !taskPermission('remove', project, task)) return;
      if (!task || !confirm(`Delete “${task.name}”? Linked tasks will move up to fill the gap.`)) return;
      try { const payload = await api(`/api/project-tasks/${task.id}`, { method: 'DELETE' }); await refresh(payload); notifyChanged(payload); }
      catch (error) { notify(error.message); }
    });
    const saveEdit = pane.querySelector('[data-save-task-edit]');
    if (saveEdit) saveEdit.onclick = async () => {
      if (!current() || !taskPermission('edit', project, taskById(tasks, saveEdit.dataset.saveTaskEdit))) return;
      const row = pane.querySelector(`[data-schedule-edit-row="${saveEdit.dataset.saveTaskEdit}"]`);
      const name = row.querySelector('[data-edit-task-name]').value.trim(), durationDays = Number(row.querySelector('[data-edit-task-duration]').value), predecessorIds = selectedValues(row.querySelector('[data-edit-task-deps]')), estimateItemId = Number(row.querySelector('[data-edit-task-estimate]')?.value) || null;
      if (!name) return notify('Give the task a name first');
      try { const payload = await api(`/api/project-tasks/${saveEdit.dataset.saveTaskEdit}`, { method: 'PATCH', body: JSON.stringify({ name, durationDays, predecessorIds, estimateItemId }) }); await refresh(payload); notifyChanged(payload); }
      catch (error) { notify(error.message); }
    };
    const cancelEdit = pane.querySelector('[data-cancel-task-edit]');
    if (cancelEdit) cancelEdit.onclick = () => { if (current()) renderSchedulePane(pane, project, tasks, null); };
  }

  async function freshSchedule(projectId){
    if (window.pdlProductionRoles?.enabled() === true) await loadData();
    // The reviewed save has already retired views and loaded the current projection.
    if (!(projects || []).some(project => Number(project.id) === Number(projectId))) return;
    await openProject(Number(projectId));
    const tab = document.querySelector('#project-detail-content [data-project-detail-tab="schedule"]');
    if (tab) tab.click();
  }

  async function paintProjectScheduleTab(projectId){
    const content = document.getElementById('project-detail-content');
    if (!content) return;
    const tabs = content.querySelector('.project-detail-tabs');
    if (!tabs) return;
    const project = (typeof projects !== 'undefined' ? projects : []).find(item => Number(item.id) === Number(projectId));
    if (!project || !canViewTasks(project)) {
      scheduleTabSequence++;
      tabs.querySelector('[data-project-detail-tab="schedule"]')?.remove();
      content.querySelector('[data-project-detail-pane="schedule"]')?.remove();
      return;
    }
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
    pane.innerHTML = '<div class="project-tab-empty"><strong>Loading schedule…</strong></div>';
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
  let laneTasksCache = null, laneTasksFetchedAt = 0, laneSequence = 0, draggedTaskId = null, laneDropWired = false, laneTouchAttached = false, laneTouchController = null, renderScheduleWithLane = null;

  function canAssignTasks(){ return taskPermission('create'); }

  function laneVisibleDays(){
    if (typeof scheduleView === 'undefined' || typeof schedulePeriodDays !== 'function') return [];
    if (scheduleView === 'month') return [];
    try { return schedulePeriodDays(); } catch (error) { return []; }
  }

  function laneTeamOptions(){
    if (typeof team === 'undefined' || typeof isOfficeMember !== 'function') return [];
    const filter = document.getElementById('schedule-crew-filter'), showOffice = document.getElementById('schedule-show-office');
    const crew = filter ? filter.value : 'all', includeOffice = showOffice ? showOffice.checked : false;
    const allowedCrews = selectedWorkspace() && currentUser?.role === 'project_manager' ? new Set((currentUser.assignedCrews || []).map(name => String(name).trim().toLowerCase())) : null;
    return team.filter(member => !member.archived && !member.archivedAt && member.status !== 'Inactive' && (!allowedCrews || allowedCrews.has(String(member.crew || '').trim().toLowerCase())) && (includeOffice || !isOfficeMember(member)) && (!crew || crew === 'all' || member.crew === crew));
  }

  function unassignedLaneTasks(){
    const activeProjects = new Set((typeof projects !== 'undefined' ? projects : []).filter(project => !project.archived).map(project => Number(project.id)));
    return (laneTasksCache || [])
      .filter(task => task && activeProjects.has(Number(task.projectId)) && !(task.memberIds || []).length && !task.crew && task.status !== 'done')
      .sort((a, b) => String(a.startDate).localeCompare(String(b.startDate)) || Number(a.id) - Number(b.id));
  }

  function syncLaneWithServer(){ return refreshLaneTasks(true).then(() => paintUnassignedLane()); }

  async function refreshLaneTasks(force){
    if (selectedWorkspace() && !taskAccess('view')) { laneTasksCache = null; laneTasksFetchedAt = 0; removeLane(); return; }
    const stamp = Date.now();
    if (!force && laneTasksCache && laneTasksFetchedAt && stamp - laneTasksFetchedAt < 30000) return;
    laneTasksFetchedAt = stamp; const sequence = laneSequence;
    try {
      const state = await api('/api/state');
      if (sequence !== laneSequence) return;
      laneTasksCache = state.projectTasks || [];
    } catch (error) { if (selectedWorkspace() && sequence === laneSequence) { laneTasksCache = []; laneTasksFetchedAt = 0; removeLane(); } }
  }

  function removeLane(){ document.querySelectorAll('.schedule-unassigned').forEach(element => element.remove()); }

  function wireLaneChips(section, firstDay){
    if (canAssignTasks() && !laneDropWired) {
      laneDropWired = true;
      document.addEventListener('drop', event => {
        if (!draggedTaskId) return;
        event.preventDefault();
        event.stopPropagation();
        const cell = typeof event.target.closest === 'function' ? event.target.closest('[data-schedule-date]') : null;
        document.querySelectorAll('.drag-over').forEach(element => element.classList.remove('drag-over'));
        const taskId = draggedTaskId;
        draggedTaskId = null;
        if (cell) assignTaskTo(taskId, Number(cell.dataset.scheduleMember), cell.dataset.scheduleDate);
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
      const select = section.querySelector(`[data-task-assign-member="${button.dataset.taskAssignGo}"]`);
      const memberId = Number(select && select.value);
      if (!memberId) return notify('Pick a person first');
      assignTaskTo(Number(button.dataset.taskAssignGo), memberId, firstDay);
    });
  }

  function paintUnassignedLane(){
    removeLane();
    if (typeof currentRole !== 'undefined' && currentRole !== 'office') return;
    if (selectedWorkspace() && !taskAccess('view')) return;
    const board = document.getElementById('schedule-board'), days = laneVisibleDays();
    if (!board || !days.length) return;
    const tasks = unassignedLaneTasks(), editable = canAssignTasks(), members = laneTeamOptions();
    if (!tasks.length && !editable) return;
    const today = typeof localDateIso === 'function' ? localDateIso() : '';
    const firstDay = (days.find(day => day.date >= today) || days[0]).date;
    const chip = task => {
      const project = (typeof projects !== 'undefined' ? projects : []).find(item => Number(item.id) === Number(task.projectId));
      const taskEditable = editable && taskPermission('create', project, task);
      const label = `${project && project.code ? project.code : 'JOB'} · ${project ? project.name : 'Project'} — ${task.name}`;
      return `<div class="schedule-task-chip" draggable="${taskEditable}" data-schedule-task="${Number(task.id)}" title="${escapeHtml(label)}">
        <div class="schedule-task-chip-main"><b>${escapeHtml(project && project.code ? project.code : 'JOB')}</b> <strong>${escapeHtml(task.name)}</strong><small>${escapeHtml(project ? project.name : '')} · ${escapeHtml(formatDate(task.startDate))} – ${escapeHtml(formatDate(task.endDate))} · ${Number(task.durationDays)}d</small></div>
        ${taskEditable && members.length ? `<div class="schedule-task-assign"><select data-task-assign-member="${Number(task.id)}" aria-label="Assign ${escapeHtml(task.name)} to"><option value="">Assign to…</option>${members.map(member => `<option value="${Number(member.id)}">${escapeHtml(member.name)}</option>`).join('')}</select><button type="button" class="secondary small" data-task-assign-go="${Number(task.id)}">Assign</button></div>` : ''}
      </div>`;
    };
    board.insertAdjacentHTML('afterend', `<section class="schedule-unassigned" aria-label="Unassigned project work">
      <div class="schedule-unassigned-head"><h3>Unassigned project work</h3><p>${tasks.length ? (editable ? 'Drag a task onto someone’s day — or pick a person right here.' : 'Waiting for the office to assign a crew.') : 'Every scheduled task has someone on it.'}</p></div>
      <div class="schedule-unassigned-list">${tasks.length ? tasks.map(chip).join('') : '<p class="schedule-unassigned-empty">Nothing waiting for a crew.</p>'}</div>
    </section>`);
    wireLaneChips(document.querySelector('.schedule-unassigned'), firstDay);
    attachLaneTouchDrag();
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
    laneTouchController = PDLScheduleTouchDrag.attach(document, { blockSelector: '[data-schedule-task][draggable="true"]', canManage: canAssignTasks, onMove: work => { if (work.taskId) assignTaskTo(work.taskId, work.targetMemberId, work.date); } });
  }

  async function assignTaskTo(taskId, memberId, fromDate){
    if (!canAssignTasks() || !taskId || !memberId) return;
    const task = (laneTasksCache || []).find(item => Number(item.id) === Number(taskId));
    if (selectedWorkspace()) {
      const project = (projects || []).find(item => Number(item.id) === Number(task?.projectId));
      if (!task || !project || !taskPermission('create', project, task) || !laneTeamOptions().some(member => Number(member.id) === Number(memberId))) return notify('Refresh and choose a current project task and employee.');
    }
    try {
      const payload = await api(`/api/project-tasks/${taskId}/assign`, { method: 'POST', body: JSON.stringify({ memberId, fromDate }) });
      if (selectedWorkspace()) { if (window.pdlProductionRoles?.enabled() === true) await loadData(); laneTasksCache = (typeof projectTasks !== 'undefined' ? projectTasks : []).slice(); }
      else {
        const state = await api('/api/state');
        if (typeof assignments !== 'undefined') assignments = state.assignments || [];
        laneTasksCache = state.projectTasks || [];
      }
      laneTasksFetchedAt = Date.now();
      if (typeof renderSchedule === 'function') renderSchedule();
      if (typeof renderMyDay === 'function') renderMyDay();
      const notes = [`${payload.created} day${Number(payload.created) === 1 ? '' : 's'} scheduled`];
      if (payload.merged) notes.push(`${payload.merged} joined an existing shift`);
      if (payload.skipped) notes.push(`${payload.skipped} skipped (time off or another job)`);
      notify(`${payload.memberName} is on “${task ? task.name : 'the task'}” — ${notes.join(', ')}`);
    } catch (error) {
      notify(error.message);
    }
  }

  function retire(){
    scheduleTabSequence++; laneSequence++; draggedTaskId = null; laneTasksCache = null; laneTasksFetchedAt = 0;
    laneTouchController?.detach(); laneTouchController = null; laneTouchAttached = false;
    removeLane();
    document.querySelectorAll('[data-project-detail-pane="schedule"]').forEach(pane => pane.replaceChildren());
    document.querySelectorAll('.drag-over').forEach(element => element.classList.remove('drag-over'));
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
  window.PDLProjectScheduleUI = { assignTaskTo, paintUnassignedLane };
  window.PDLProjectScheduleUI.retire = retire;
  wrapRenderSchedule();
  attachLaneTouchDrag();
})();
