(function(){
  'use strict';
  // Project detail "Schedule" tab: linked tasks with auto-computed dates.
  // The server schedules (project-schedule.js engine); this module renders
  // the tab, wires add/edit/delete/status, and repaints after every change.
  let scheduleTabSequence = 0;

  function canEditTasks(){ return typeof canManageSchedule === 'function' && canManageSchedule(); }
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
    const editable = canEditTasks();
    const sorted = (tasks || []).slice().sort((a, b) => String(a.startDate).localeCompare(String(b.startDate)) || Number(a.id) - Number(b.id));
    const dates = sorted.map(t => t.startDate).concat(sorted.map(t => t.endDate)).filter(Boolean).sort();
    const windowStart = dates[0], windowEnd = dates[dates.length - 1];
    const depsOptions = sorted.map(t => `<option value="${Number(t.id)}">${escapeHtml(t.name)}</option>`).join('');
    const editorRow = task => `
      <tr class="project-schedule-edit-row" data-schedule-edit-row="${Number(task.id)}">
        <td colspan="6">
          <div class="project-schedule-editor">
            <label>Task<input type="text" data-edit-task-name value="${escapeHtml(task.name)}" maxlength="160"></label>
            <label>Working days<input type="number" data-edit-task-duration min="1" max="365" step="1" value="${Number(task.durationDays)}"></label>
            <label>Waits for<select data-edit-task-deps multiple size="${Math.min(4, Math.max(2, sorted.length))}">${depsOptions.replace(`value="${Number(task.id)}"`, 'value="" disabled')}</select></label>
            <div class="project-schedule-editor-actions"><button type="button" class="primary small" data-save-task-edit="${Number(task.id)}">Save task</button><button type="button" class="secondary small" data-cancel-task-edit>Cancel</button></div>
          </div>
        </td>
      </tr>`;
    const rows = sorted.map(task => (Number(editingId) === Number(task.id) ? editorRow(task) : `
      <tr data-schedule-task-row="${Number(task.id)}">
        <td><strong>${escapeHtml(task.name)}</strong>${timelineRow(task, windowStart, windowEnd)}</td>
        <td>${dependencyChips(sorted, task)}</td>
        <td>${Number(task.durationDays)}d</td>
        <td><small>${formatDate(task.startDate)} – ${formatDate(task.endDate)}</small></td>
        <td>${escapeHtml(assigneeLabel(task))}</td>
        <td class="project-schedule-actions">${editable ? `<select data-task-status="${Number(task.id)}" aria-label="Status for ${escapeHtml(task.name)}"><option value="not-started" ${task.status === 'not-started' ? 'selected' : ''}>Not started</option><option value="in-progress" ${task.status === 'in-progress' ? 'selected' : ''}>In progress</option><option value="done" ${task.status === 'done' ? 'selected' : ''}>Done</option></select><button type="button" class="secondary small" data-edit-task="${Number(task.id)}">Edit</button><button type="button" class="danger small" data-delete-task="${Number(task.id)}" aria-label="Delete ${escapeHtml(task.name)}">Delete</button>` : `<span class="status">${taskStatusLabel(task.status)}</span>`}</td>
      </tr>`)).join('');
    pane.innerHTML = `
      <div class="project-schedule-head"><div><h3>Project schedule</h3><p>Linked tasks auto-schedule: a task starts the next working day after everything it waits for is done. Change one and the rest follow.</p></div></div>
      ${editable ? `<form class="project-schedule-add" data-schedule-add-form>
        <input type="text" data-new-task-name placeholder="Task name, e.g. Set footings" maxlength="160" aria-label="Task name">
        <input type="number" data-new-task-duration min="1" max="365" step="1" value="1" aria-label="Working days">
        <select data-new-task-deps multiple size="${Math.min(4, Math.max(2, sorted.length))}" aria-label="Waits for">${depsOptions || '<option value="" disabled>No tasks yet</option>'}</select>
        <button type="submit" class="primary">＋ Add task</button>
      </form>` : ''}
      ${sorted.length ? `<div class="project-schedule-table-wrap"><table class="project-schedule-table"><thead><tr><th>Task</th><th>Waits for</th><th>Length</th><th>Dates</th><th>Assigned</th><th>${editable ? 'Status / actions' : 'Status'}</th></tr></thead><tbody>${rows}</tbody></table></div>` : `<div class="project-tab-empty"><strong>No scheduled tasks yet</strong><p>${editable ? 'Add the project’s phases or milestones above and link them so the dates keep themselves honest.' : 'Your office will add the project schedule here.'}</p></div>`}`;
    if (Number(editingId)) { const select = pane.querySelector(`[data-schedule-edit-row="${Number(editingId)}"] [data-edit-task-deps]`); if (select) { const editing = taskById(tasks, editingId); [...select.options].forEach(option => { option.selected = (editing?.predecessorIds || []).map(Number).includes(Number(option.value)); }); } }
    wireSchedulePane(pane, project, tasks, editingId);
  }

  function selectedValues(select){ return [...select.options].filter(o => o.selected && o.value !== '').map(o => Number(o.value)); }

  function wireSchedulePane(pane, project, tasks){
    const editable = canEditTasks();
    const refresh = payload => renderSchedulePane(pane, project, payload.tasks, null);
    const notifyChanged = payload => { const others = (payload.changed || []).filter(id => true).length; notify(others > 1 ? `Schedule updated — ${others} tasks moved` : 'Schedule updated'); };
    const addForm = pane.querySelector('[data-schedule-add-form]');
    if (addForm) addForm.onsubmit = async event => {
      event.preventDefault();
      const name = pane.querySelector('[data-new-task-name]').value.trim(), durationDays = Number(pane.querySelector('[data-new-task-duration]').value), predecessorIds = selectedValues(pane.querySelector('[data-new-task-deps]'));
      if (!name) return notify('Give the task a name first');
      try { const payload = await api(`/api/projects/${project.id}/tasks`, { method: 'POST', body: JSON.stringify({ name, durationDays, predecessorIds }) }); refresh(payload); notifyChanged(payload); }
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
      if (!task || !confirm(`Delete “${task.name}”? Linked tasks will move up to fill the gap.`)) return;
      try { const payload = await api(`/api/project-tasks/${task.id}`, { method: 'DELETE' }); refresh(payload); notifyChanged(payload); }
      catch (error) { notify(error.message); }
    });
    const saveEdit = pane.querySelector('[data-save-task-edit]');
    if (saveEdit) saveEdit.onclick = async () => {
      const row = pane.querySelector(`[data-schedule-edit-row="${saveEdit.dataset.saveTaskEdit}"]`);
      const name = row.querySelector('[data-edit-task-name]').value.trim(), durationDays = Number(row.querySelector('[data-edit-task-duration]').value), predecessorIds = selectedValues(row.querySelector('[data-edit-task-deps]'));
      if (!name) return notify('Give the task a name first');
      try { const payload = await api(`/api/project-tasks/${saveEdit.dataset.saveTaskEdit}`, { method: 'PATCH', body: JSON.stringify({ name, durationDays, predecessorIds }) }); refresh(payload); notifyChanged(payload); }
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
})();
