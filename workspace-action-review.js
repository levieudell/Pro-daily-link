'use strict';
(function () {
  // The existing forms remain the entry points. This finite route adapter
  // supplies the reviewed server previews and an explicit product confirmation.
  const id = () => crypto.randomUUID();
  function operation(path, options) {
    const method = String(options.method || 'GET').toUpperCase(), value = options.body ? JSON.parse(options.body) : {}, url = new URL(path, location.origin), p = url.pathname;
    if (method === 'GET' || /\/(?:action-preview|review-preview)$/.test(p) || p === '/api/daily-actions/preview') return null;
    let match;
    if (method === 'POST' && p === '/api/time-cards/approve' || method === 'POST' && (match = /^\/api\/time-cards\/(\d+)\/(approve|unapprove)$/.exec(p))) return { title: 'Review time approval', previewPath: '/api/time-cards/review-preview', preview: { decision: match?.[2] || 'approve', ids: match ? [Number(match[1])] : value.ids }, family: 'timeReview', action: match?.[2] === 'unapprove' ? 'unapproveCards' : 'approveCards' };
    if (method === 'POST' && (match = /^\/api\/time-off-requests\/([^/]+)\/(approve|decline)$/.exec(p))) return { title: 'Review time-off decision', previewPath: '/api/time-off-requests/' + match[1] + '/review-preview', preview: { decision: match[2], note: value.note || '' }, family: 'timeReview', action: 'reviewLeave' };
    const cardAction = method === 'POST' && p === '/api/time-cards' ? 'create' : method === 'POST' && p === '/api/time-cards/company-clock' ? 'companyClock' : (match = /^\/api\/time-cards\/(\d+)(?:\/(submit|clock-out))?$/.exec(p)) ? method === 'PATCH' ? 'correct' : method === 'DELETE' ? 'remove' : method === 'POST' ? match[2] : null : null;
    if (cardAction) { const typedAction = cardAction === 'clock-out' ? 'clockOut' : cardAction; return { title: 'Review time record', previewPath: '/api/time-cards/action-preview', preview: { action: typedAction, ...(match ? { id: Number(match[1]) } : {}), details: value }, family: 'timeWrite', action: { create: 'createCards', correct: 'correctCards', remove: 'removeCards', submit: 'submitCards', companyClock: 'clockCards', clockOut: 'clockCards' }[typedAction] }; }
    if ((method === 'POST' || method === 'PATCH') && (match = /^\/api\/pay-periods(?:\/([^/]+)(?:\/(exports))?)?$/.exec(p))) return { title: 'Review pay-period change', previewPath: '/api/pay-periods/action-preview', preview: { action: match[2] ? 'captureExport' : match[1] ? 'editPeriod' : 'createPeriod', ...(match[1] ? { id: match[1] } : {}), details: value }, family: 'timeWrite', action: match[2] ? 'captureExports' : 'configurePeriods' };
    let dailyAction = method === 'POST' && p === '/api/reports' ? 'createReport' : (match = /^\/api\/reports\/(\d+)(?:\/(approve))?$/.exec(p)) && method === 'PATCH' ? match[2] ? 'approveReport' : 'editReport' : method === 'POST' && p === '/api/workdays/start' ? 'startWorkday' : (match = /^\/api\/workdays\/(\d+)\/end$/.exec(p)) && method === 'POST' ? 'endWorkday' : method === 'POST' && p === '/api/reporting-exports' ? 'captureExport' : null;
    if (dailyAction) {
      const details = { ...value }; delete details.extracted;
      if (['createReport', 'editReport'].includes(dailyAction)) { delete details.project; if (dailyAction === 'editReport') delete details.projectId; }
      return { title: 'Review daily or workday', previewPath: '/api/daily-actions/preview', preview: { action: dailyAction, ...(match ? { id: Number(match[1]) } : {}), details }, family: dailyAction === 'captureExport' ? null : 'daily', action: { createReport: 'createReports', editReport: 'editReports', approveReport: 'approveReports', startWorkday: 'runWorkdays', endWorkday: 'runWorkdays' }[dailyAction] };
    }
    if (/^\/api\/assignments(?:\/\d+(?:\/acknowledge)?)?$/.test(p)) return { title: 'Review scheduling change', details: value, family: 'scheduling', action: p.endsWith('/acknowledge') ? 'acknowledge' : method === 'POST' ? 'create' : method === 'PATCH' ? 'edit' : 'remove', requestId: method === 'POST' && p === '/api/assignments' };
    if (method === 'POST' && p === '/api/time-off-requests') return { title: 'Review private time-off request', details: value, family: 'timeOff', action: 'createRequest', requestId: true };
    if ((method === 'POST' || method === 'PATCH') && /^\/api\/projects\/\d+\/notes-todos(?:\/[^/]+)?$/.test(p)) return { title: 'Review project note or to-do', details: value, family: 'notes', action: method === 'POST' ? 'create' : Object.hasOwn(value, 'completed') ? 'complete' : 'edit', requestId: method === 'POST' };
    return null;
  }
  async function review(title, details) {
    return new Promise((resolve, reject) => {
      const dialog = document.createElement('dialog'); dialog.dataset.workspaceDialog = 'review'; dialog.id = 'workspace-action-review';
      dialog.innerHTML = '<h2></h2><p>Review the proposed change before saving.</p><pre style="white-space:pre-wrap;max-height:40vh;overflow:auto"></pre><label><input type="checkbox" id="workspace-action-confirmed"> I reviewed this change and confirm it.</label><p role="status"></p><div class="modal-actions"><button type="button" class="secondary">Cancel</button><button type="button" class="primary" id="workspace-action-save">Confirm and save</button></div>';
      dialog.querySelector('h2').textContent = title; dialog.querySelector('pre').textContent = details;
      const finish = value => { dialog.close(); dialog.remove(); resolve(value); };
      dialog.querySelector('.secondary').onclick = () => finish(false);
      dialog.querySelector('#workspace-action-save').onclick = () => { if (!dialog.querySelector('input').checked) { dialog.querySelector('[role=status]').textContent = 'Check the confirmation box after reviewing.'; return; } finish(true); };
      dialog.addEventListener('cancel', event => { event.preventDefault(); finish(false); }); document.body.append(dialog); dialog.showModal();
      const observer = new MutationObserver(() => { if (!dialog.isConnected) { observer.disconnect(); reject(Object.assign(Error('Workspace identity changed. Review again.'), { status: 409 })); } }); observer.observe(document.body, { childList: true });
      dialog.addEventListener('close', () => observer.disconnect(), { once: true });
    });
  }
  function summary(action, preview) {
    const details = preview?.details || action.preview?.details || action.details || {}, lines = [], record = preview?.proposed;
    const projectName = projectId => projects.find(row => Number(row.id) === Number(projectId))?.name || 'Selected project';
    const personName = memberId => team.find(row => Number(row.id) === Number(memberId))?.name || 'Selected person';
    if (details.projectId != null) lines.push('Project: ' + projectName(details.projectId));
    if (details.memberId != null) lines.push('Person: ' + personName(details.memberId));
    if (details.memberIds) lines.push('People: ' + details.memberIds.map(personName).join(', '));
    for (const [key, label] of [['date','Work date'],['dateIso','Report date'],['startDate','First day'],['endDate','Last day'],['from','Period starts'],['to','Period ends'],['label','Period'],['start','Shift starts'],['end','Shift ends'],['inAt','Clock in'],['outAt','Clock out'],['activity','Work'],['reason','Reason'],['notes','Work recorded'],['text','Text'],['note','Private note'],['dueDate','To-do deadline'],['startNote','Starting note'],['next','Next steps']]) if (details[key] !== undefined && details[key] !== null && details[key] !== '') lines.push(label + ': ' + details[key]);
    if (details.status) lines.push('Daily status: ' + details.status);
    if (Object.hasOwn(details,'completed')) lines.push('To-do: ' + (details.completed ? 'Complete' : 'Open'));
    if (details.laborEntries?.length) lines.push('Labor: ' + details.laborEntries.map(row => personName(row.memberId) + ' — ' + row.hours + ' hours').join('; '));
    if (details.productionEntries?.length) lines.push('Production: ' + details.productionEntries.map(row => row.description + ' — ' + (row.quantity ?? 'pending quantity') + ' ' + row.unit + ', ' + (row.laborHours ?? 0) + ' labor hours').join('; '));
    const reviewed = preview?.records;
    if (reviewed) for (const row of Array.isArray(reviewed) ? reviewed : [reviewed]) { if (row.memberId) lines.push(personName(row.memberId) + ' — ' + (row.date || [row.startDate,row.endDate].filter(Boolean).join(' through ')) + (row.hours !== undefined ? ', ' + row.hours + ' hours' : '') + (row.note ? '\nPrivate note: ' + row.note : '')); }
    if (record?.startedAt) lines.push('Start the workday now. The saved clock uses confirmation time.');
    if (action.preview?.action === 'captureExport') lines.push('Create a fixed export of the currently approved records. Earlier exports keep their saved contents.');
    if (action.action === 'remove') lines.push('Remove the selected assignment or person from this schedule.');
    if (action.action === 'acknowledge') lines.push('Acknowledge your selected assignment.');
    if (action.action === 'approveCards' || action.action === 'reviewLeave') lines.push('Decision: ' + (action.preview?.decision || 'approve'));
    if (action.action === 'unapproveCards') lines.push('Return this approved time record to Draft.');
    if (preview?.scheduledConflicts?.length) lines.push('Approved time off overlaps ' + preview.scheduledConflicts.length + ' existing shift(s). Review the schedule separately.');
    if (!lines.length) lines.push('Apply the selected change to the current record.');
    return lines.join('\n\n');
  }
  async function request(path, options, send) {
    if (!window.pdlWorkspaceActions?.enabled()) return send(path, options);
    const action = operation(path, options); if (!action) return send(path, options);
    if(window.pdlWorkspaceSave?.read()){window.pdlWorkspaceSave.draw();throw Object.assign(Error('Check the previous save result before making another change.'),{status:409});}
    const opening = await window.pdlWorkspaceActions.identity();
    if (action.family && opening.effectiveCapabilities?.[action.family]?.[action.action] !== true || !action.family && opening.role !== 'owner') throw Object.assign(Error('This action is restricted by your current permissions.'), { status: 403 });
    let preview = null;
    if (action.previewPath) preview = await send(action.previewPath, { method: 'POST', body: JSON.stringify(action.preview) });
    const confirmed = await review(action.title, summary(action, preview));
    if (!confirmed) throw Object.assign(Error('Change cancelled.'), { status: 400 });
    const current = await window.pdlWorkspaceActions.identity();
    if (current.authority !== opening.authority || current.sessionBinding !== opening.sessionBinding) throw Object.assign(Error('Workspace permissions changed. Review again.'), { status: 409 });
    const details = preview ? { token: preview.token, version: preview.version, confirmed: true, requestId: id() } : { ...action.details, ...(action.requestId ? { requestId: action.details.requestId || id() } : {}) };
    if(preview)window.pdlWorkspaceSave.remember(current,String(options.method||'GET').toUpperCase(),new URL(path,location.origin).pathname,details);
    const result = await send(path, { ...options, body: JSON.stringify(details), ...(preview ? { onAcknowledged: () => window.pdlWorkspaceSave.finish(details.requestId) } : {}) });
    if(preview)window.pdlWorkspaceSave.finish(details.requestId);
    // Normal report lists index the actor's projected project array.
    const remap = row => row && Number.isSafeInteger(row.projectId) && Object.hasOwn(row, 'project') ? { ...row, project: projects.findIndex(project => Number(project.id) === row.projectId) } : row;
    return result?.report ? { ...result, report: remap(result.report) } : remap(result);
  }
  window.pdlWorkspaceReview = { operation, request };
})();
