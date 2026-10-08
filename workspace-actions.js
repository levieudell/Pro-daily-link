'use strict';
(function () {
  // Finite product actions over existing routes, not a permission dictionary.
  const routes = { schedule: ['Schedule', 'scheduling', 'view', '/api/assignments'], notes: ['Notes and to-dos', 'notes', 'view', null], leave: ['Time off', 'timeOff', 'viewRequests', '/api/time-off-requests'], cards: ['Time cards', 'timeReview', 'viewCards', '/api/time-cards'], dailies: ['Dailies', 'daily', 'viewReports', '/api/reports'], workdays: ['Workdays', 'daily', 'viewWorkdays', '/api/workdays'], payroll: ['Pay periods', 'timeWrite', 'viewPayroll', '/api/pay-periods'] };
  const definitions = {
    scheduleCreate: ['Schedule people', 'schedule', 'scheduling', 'create', 'POST', '/api/assignments'], scheduleEdit: ['Edit assignment', 'schedule', 'scheduling', 'edit', 'PATCH', id => '/api/assignments/' + id], scheduleRemove: ['Remove assignment', 'schedule', 'scheduling', 'remove', 'DELETE', id => '/api/assignments/' + id], acknowledge: ['Acknowledge', 'schedule', 'scheduling', 'acknowledge', 'POST', id => '/api/assignments/' + id + '/acknowledge'],
    noteCreate: ['Add note or to-do', 'notes', 'notes', 'create', 'POST', project => '/api/projects/' + project + '/notes-todos'], noteEdit: ['Edit', 'notes', 'notes', 'edit', 'PATCH', (id, project) => '/api/projects/' + project + '/notes-todos/' + encodeURIComponent(id)], noteComplete: ['Change completion', 'notes', 'notes', 'complete', 'PATCH', (id, project) => '/api/projects/' + project + '/notes-todos/' + encodeURIComponent(id)],
    leaveCreate: ['Request time off', 'leave', 'timeOff', 'createRequest', 'POST', '/api/time-off-requests'], leaveApprove: ['Approve request', 'leave', 'timeReview', 'reviewLeave', 'POST', id => '/api/time-off-requests/' + encodeURIComponent(id) + '/approve'], leaveDecline: ['Decline request', 'leave', 'timeReview', 'reviewLeave', 'POST', id => '/api/time-off-requests/' + encodeURIComponent(id) + '/decline'],
    cardCreate: ['Add time card', 'cards', 'timeWrite', 'createCards', 'POST', '/api/time-cards', 'create'], cardCorrect: ['Correct time', 'cards', 'timeWrite', 'correctCards', 'PATCH', id => '/api/time-cards/' + id, 'correct'], cardRemove: ['Remove time card', 'cards', 'timeWrite', 'removeCards', 'DELETE', id => '/api/time-cards/' + id, 'remove'], cardSubmit: ['Submit time card', 'cards', 'timeWrite', 'submitCards', 'POST', id => '/api/time-cards/' + id + '/submit', 'submit'], clockIn: ['Clock in', 'cards', 'timeWrite', 'clockCards', 'POST', '/api/time-cards/company-clock', 'companyClock'], clockOut: ['Clock out', 'cards', 'timeWrite', 'clockCards', 'POST', id => '/api/time-cards/' + id + '/clock-out', 'clockOut'], cardApprove: ['Approve time', 'cards', 'timeReview', 'approveCards', 'POST', id => '/api/time-cards/' + id + '/approve'], cardUnapprove: ['Undo approval', 'cards', 'timeReview', 'unapproveCards', 'POST', id => '/api/time-cards/' + id + '/unapprove'],
    dailyCreate: ['Create daily', 'dailies', 'daily', 'createReports', 'POST', '/api/reports', 'createReport'], dailyEdit: ['Edit daily', 'dailies', 'daily', 'editReports', 'PATCH', id => '/api/reports/' + id, 'editReport'], dailyApprove: ['Approve daily', 'dailies', 'daily', 'approveReports', 'PATCH', id => '/api/reports/' + id + '/approve', 'approveReport'], workdayStart: ['Start workday', 'workdays', 'daily', 'runWorkdays', 'POST', '/api/workdays/start', 'startWorkday'], workdayEnd: ['End workday', 'workdays', 'daily', 'runWorkdays', 'POST', id => '/api/workdays/' + id + '/end', 'endWorkday'], periodCreate: ['Create pay period', 'payroll', 'timeWrite', 'configurePeriods', 'POST', '/api/pay-periods', 'createPeriod'], periodEdit: ['Edit pay period', 'payroll', 'timeWrite', 'configurePeriods', 'PATCH', id => '/api/pay-periods/' + id, 'editPeriod'], periodCapture: ['Create payroll export', 'payroll', 'timeWrite', 'captureExports', 'POST', id => '/api/pay-periods/' + id + '/exports', 'captureExport']
  };
  definitions.photoUpload = ['Add photo', 'dailies', 'daily', 'editReports', 'POST', '/api/photos'];
  definitions.reportExport = ['Create reporting export', 'dailies', null, null, 'POST', '/api/reporting-exports', 'captureExport'];
  const createActions = ['reportExport','scheduleCreate', 'noteCreate', 'leaveCreate', 'cardCreate', 'clockIn', 'dailyCreate', 'workdayStart', 'periodCreate'];
  function allowed(nav, action) { const d = definitions[action]; return Boolean(d && (action === 'reportExport' ? nav.actor.immutableAccess?.ownerManagement === true : nav.actor.effectiveCapabilities[d[2]]?.[d[3]])); }
  function build(action, value, row = {}, project, requestId) {
    const d = definitions[action]; if (!d) throw Error('Choose a supported action');
    let details = {}; const number = name => Number(value[name]), members = () => (value.memberIds || []).map(Number), optionalReason = () => ({ reason: value.reason || '' });
    if (['scheduleCreate', 'scheduleEdit'].includes(action)) details = { projectId: number('projectId'), memberIds: members(), date: value.date, start: value.start, end: value.end, activity: value.activity || '', ...(action === 'scheduleCreate' ? { requestId } : { edit: true }) };
    if (action === 'noteCreate') details = { kind: value.kind, text: value.text, requestId, ...(value.kind === 'todo' && value.dueDate ? { dueDate: value.dueDate } : {}) };
    if (action === 'noteEdit') details = { revision: row.revision, text: value.text, ...(row.kind === 'todo' ? { dueDate: value.dueDate || null } : {}) };
    if (action === 'noteComplete') details = { revision: row.revision, completed: !row.completed };
    if (action === 'leaveCreate') details = { startDate: value.startDate, endDate: value.endDate, allDay: value.allDay === true, type: value.type, note: value.note || '', requestId, ...(value.allDay ? {} : { startTime: value.startTime, endTime: value.endTime }) };
    if (action === 'clockIn') details = { activityCodeId: value.activityCodeId };
    if (action === 'reportExport') details = { projectId: number('projectId'), from: value.from, to: value.to, reason: value.reason || '' };
    if (action === 'photoUpload') return { action, method: 'POST', path: '/api/photos', previewPath: '/api/photos/upload-preview', previewBody: { requestId, projectId: row.projectId, reportId: row.id, ...(row.workdayId ? { workdayId: row.workdayId } : {}), source: ['field', 'foreman'].includes(value.accessRole) ? 'field' : 'office', caption: value.caption || '', file: value.file }, files: value.files, serverPreview: true, retryable: true };
    if (action === 'cardCreate') details = { memberId: number('memberId'), projectId: number('projectId'), inAt: value.inAt, outAt: value.outAt || null, ...optionalReason() };
    if (action === 'cardCorrect') details = { inAt: value.inAt, outAt: value.outAt || null, ...optionalReason() };
    if (action === 'cardRemove') details = optionalReason();
    if (['cardCorrect', 'cardSubmit', 'clockOut'].includes(action) && row.fieldAccess?.revision) details.revision = row.fieldAccess.revision;
    if (action === 'dailyCreate') details = { projectId: number('projectId'), dateIso: value.dateIso, status: 'Draft', notes: value.notes || '', foreman: value.foreman || '', laborEntries: members().map(memberId => ({ memberId, hours: Number(value.laborHours || 0) })), productionEntries: value.estimateItemId ? [{ estimateItemId: number('estimateItemId'), description: value.description || '', unit: value.unit || 'EA', quantity: value.quantity === '' ? null : Number(value.quantity || 0), laborHours: members().length * Number(value.laborHours || 0) }] : [] };
    if (action === 'dailyEdit') details = { notes: value.notes || '', status: value.status, laborEntries: value.laborEntries, productionEntries: value.productionEntries };
    if (action === 'workdayStart') details = { projectId: number('projectId'), memberIds: members(), startNote: value.startNote || '' };
    if (action === 'workdayEnd') details = { notes: value.notes || '', next: value.next || '', foreman: value.foreman || '' };
    if (['periodCreate', 'periodEdit'].includes(action)) details = { label: value.label, from: value.from, to: value.to, ...optionalReason() };
    if (action === 'periodCapture') details = optionalReason();
    if (action === 'dailyCreate' && value.laborEntries) { details.laborEntries = value.laborEntries; details.productionEntries = value.productionEntries; }
    const path = typeof d[5] === 'function' ? d[5](action === 'noteCreate' ? project : row.id, project) : d[5];
    if (action === 'leaveApprove' || action === 'leaveDecline') return { action, method: d[4], path, previewPath: '/api/time-off-requests/' + encodeURIComponent(row.id) + '/review-preview', previewBody: { decision: action === 'leaveApprove' ? 'approve' : 'decline', note: value.note || '' }, serverPreview: true, retryable: true };
    if (action === 'cardApprove' || action === 'cardUnapprove') return { action, method: d[4], path, previewPath: '/api/time-cards/review-preview', previewBody: { decision: action === 'cardApprove' ? 'approve' : 'unapprove', ids: [row.id] }, serverPreview: true, retryable: true };
    if (d[6]) return { action, method: d[4], path, previewPath: d[1] === 'payroll' ? '/api/pay-periods/action-preview' : ['dailies', 'workdays'].includes(d[1]) ? '/api/daily-actions/preview' : '/api/time-cards/action-preview', previewBody: { action: d[6], ...(typeof d[5] === 'function' ? { id: row.id } : {}), details }, serverPreview: true, retryable: true };
    return { action, method: d[4], path, body: details, serverPreview: false, retryable: ['scheduleCreate', 'noteCreate', 'leaveCreate'].includes(action) };
  }
  if (typeof module !== 'undefined' && module.exports) { module.exports = { routes, definitions, createActions, allowed, build }; return; }
  const recoveries = new Map(); let active;
  function mount(ctx) {
    if (active) active.leave();
    const mark = ctx.ticket(), root = ctx.content, e = ctx.escape, route = ctx.route, definition = routes[route], nav = ctx.nav, recoveryKey = JSON.stringify([mark.identity, route]);
    let alive = true, rows = [], activities = [], options = { projects: [], team: [] }, project = null, selection, draft, review, confirmed = false, busy = false, loadGeneration = 0;
    const current = () => alive && ctx.current(mark), pending = () => recoveries.get(recoveryKey), gates = () => ctx.getNav().actor.effectiveCapabilities;
    function setBusy(value) { busy = value; if (!current()) return; for (const button of root.querySelectorAll('button')) button.disabled = button.id === 'work-confirm' ? value || !confirmed || !draft || Date.now() >= draft.expiresAt : value; }
    const button = (label, action, id) => `<button type="button" data-work-action="${action}"${id == null ? '' : ` data-record="${e(id)}"`}>${e(label)}</button>`;
    const option = (row, selected) => `<option value="${e(row.id)}"${String(row.id) === String(selected) ? ' selected' : ''}>${e(row.name)}${typeof row.id === 'number' ? ' (ID ' + e(row.id) + ')' : ''}</option>`;
    const select = (name, label, choices, selected, multiple = false, required = true) => `<label>${e(label)}<select name="${name}" ${multiple ? 'multiple size="4"' : ''} ${required ? 'required' : ''}>${choices.map(row => option(row, selected)).join('')}</select></label>`;
    const input = (name, label, type = 'text', value = '', required = false) => `<label>${e(label)}<input name="${name}" type="${type}" value="${e(value)}" ${required ? 'required' : ''}${type === 'number' ? ' min="0" step="any"' : ''}></label>`;
    const text = (name, label, value = '', max = 5000) => `<label>${e(label)}<textarea name="${name}" maxlength="${max}">${e(value)}</textarea></label>`;
    const names = list => (list || []).map(id => (options.team.find(row => row.id === Number(id))?.name || nav.team.find(row => row.id === Number(id))?.name || 'Team member') + ' (ID ' + id + ')').join(', ');
    const projectName = id => options.projects.find(row => row.id === Number(id))?.name || nav.projects.find(row => row.id === Number(id))?.name || 'Project';
    const summary = row => route === 'schedule' ? `${projectName(row.projectId)} · ${row.date} · ${row.start}–${row.end} · ${names(row.memberIds)} · ${row.activity || ''}` : route === 'notes' ? `${row.kind === 'todo' ? 'To-do' : 'Note'} · ${row.text}${row.dueDate ? ' · Due ' + row.dueDate : ''}${row.completed ? ' · Completed' : ''}` : route === 'leave' ? `${row.type} · ${row.startDate}–${row.endDate} · ${row.status}${row.allDay === false ? ' · ' + row.startTime + '–' + row.endTime : ''}${row.note ? ' · ' + row.note : ''}` : route === 'cards' ? `${names([row.memberId])} · ${projectName(row.projectId)} · ${row.date || row.inAt || ''} · ${row.hours ?? 'Open'} hours · ${row.status || row.state || 'draft'}` : route === 'dailies' ? `${row.dateIso || row.date || ''} · ${row.status || 'Draft'} · ${row.notes || ''}` : route === 'workdays' ? `${projectName(row.projectId)} · ${names(row.memberIds)} · ${row.activity || ''} · ${row.status || ''}` : `${row.label || 'Pay period'} · ${row.from}–${row.to} · ${row.status || ''}`;
    function rowAllowed(action, row) {
      if (!allowed(ctx.getNav(), action)) return false;
      if (action === 'photoUpload') return row.status === 'Draft' && (!row.workdayId || gates().daily.runWorkdays);
      if (action === 'dailyEdit' && row.status === 'Approved') return gates().daily.approveReports;
      if (action === 'leaveApprove' || action === 'leaveDecline') return row.status === 'pending';
      if (action === 'acknowledge') return (row.memberIds || []).includes(nav.actor.memberId);
      if (action === 'noteComplete') return row.kind === 'todo';
      if (action === 'clockOut') return !row.outAt && Number(row.memberId) === Number(nav.actor.memberId);
      if (action === 'cardCorrect' && row.fieldAccess) return row.fieldAccess.canEdit;
      if (action === 'cardSubmit' && row.fieldAccess) return row.fieldAccess.canSubmit;
      if (action === 'cardApprove') return String(row.status || row.state).toLowerCase() === 'submitted';
      if (action === 'cardUnapprove') return String(row.status || row.state).toLowerCase() === 'approved';
      if (action === 'dailyApprove') return row.status !== 'Approved';
      if (action === 'workdayEnd') return row.status === 'active';
      return true;
    }
    function draw() {
      if (!current()) return;
      const pendingRecord = pending()?.state === 'saved' ? null : pending();
      root.innerHTML = `<h1>${e(definition[0])}</h1><p>Actions use your current permissions and existing project and crew scope.</p>${route === 'notes' ? select('notes-project', 'Project', options.projects, project) : ''}<div class="workflow-toolbar">${createActions.filter(action => definitions[action][1] === route && allowed(ctx.getNav(), action)).map(action => button(definitions[action][0], action)).join('')}<button type="button" id="workflow-refresh">Refresh current records</button>${route === 'dailies' && nav.actor.immutableAccess.ownerManagement ? '<button type="button" id="report-exports">View reporting exports</button>' : ''}${route === 'cards' && gates().timeWrite.downloadCards ? '<button type="button" id="cards-download">Download time cards</button>' : ''}</div><div id="workflow-result" role="status"></div><section class="panel workflow-records">${rows.length ? rows.map(row => `<article class="workflow-record"><p>${e(summary(row))}</p><div>${Object.keys(definitions).filter(action => definitions[action][1] === route && !createActions.includes(action) && rowAllowed(action, row)).map(action => button(definitions[action][0], action, row.id)).join('')}${route === 'dailies' && (!row.workdayId || gates().daily.viewWorkdays) ? `<button type="button" data-report-photos="${e(row.id)}">View photos</button>` : ''}${route === 'payroll' ? `<button type="button" data-period-summary="${e(row.id)}">Review period summary</button>` : ''}${route === 'payroll' && gates().timeWrite.downloadExports ? `<button type="button" data-period-download="${e(row.id)}">View saved exports</button>` : ''}</div></article>`).join('') : '<p>No records in your current scope.</p>'}</section><section id="workflow-action"></section>${pendingRecord ? `<section class="notice"><p>The previous save result is unknown. ${pendingRecord.retryable ? 'Recover the exact original request.' : 'Review current records before making another change; this action has no exact replay.'}</p>${pendingRecord.retryable ? '<button type="button" id="workflow-recover">Recover original save</button>' : '<button type="button" id="workflow-reconcile">I checked the current records</button>'}</section>` : ''}`;
      setBusy(busy);
    }
    async function load() {
      const generation = ++loadGeneration, currentLoad = () => current() && generation === loadGeneration;
      setBusy(true); ctx.say('Loading ' + definition[0].toLowerCase() + '…');
      try {
        await ctx.verify(); if (!currentLoad()) return; const sourceRevision = ctx.getNav().tenantRevision;
        const gate = gates()[definition[1]][definition[2]]; if (!gate) throw Object.assign(Error('This view is restricted by your current permissions.'), { status: 403 });
        const workflow = { schedule: 'schedule', notes: 'notes', dailies: 'dailies', workdays: 'workdays', cards: 'cards' }[route];
        const needsOptions = workflow && (route === 'notes' || route === 'cards' && gates().timeWrite.createCards || route === 'schedule' && (gates().scheduling.create || gates().scheduling.edit) || route === 'dailies' && (gates().daily.createReports || gates().daily.editReports) || route === 'workdays' && gates().daily.runWorkdays);
        if (needsOptions) { const data = await ctx.request('/api/workspace/options?workflow=' + workflow); if (!currentLoad()) return; options = data; }
        if (route === 'cards' && gates().timeWrite.viewActivities && gates().timeWrite.clockCards) { activities = await ctx.request('/api/company-activities'); if (!currentLoad()) return; }
        if (route === 'notes') { if (!options.projects.length) { await ctx.verify(sourceRevision); if (!currentLoad()) return; rows = []; draw(); ctx.say(''); return true; } project = options.projects.some(row => Number(row.id) === Number(project)) ? project : options.projects[0].id; }
        const selectedProject = project;
        const data = await ctx.request(route === 'notes' ? '/api/projects/' + selectedProject + '/notes-todos' : definition[3]); if (!currentLoad()) return;
        await ctx.verify(sourceRevision); if (!currentLoad()) return;
        rows = route === 'notes' ? data.items : route === 'payroll' ? data.periods : route === 'schedule' ? data.assignments : data; if (!Array.isArray(rows)) throw Error('The response could not be read. Refresh current records.'); if (pending()?.state === 'saved') recoveries.delete(recoveryKey); selection = draft = review = null; confirmed = false; draw(); ctx.say(''); return true;
      } catch (error) { if (!currentLoad()) return false; root.replaceChildren(); if (![401, 402, 403].includes(error.status)) root.innerHTML = '<button type="button" id="workflow-refresh">Refresh current records</button>'; ctx.say(error.message, true); return false; }
      finally { if (currentLoad()) setBusy(false); }
    }
    function productionLine(line, items) {
      const choices = [{id:'',name:'Unplanned scope / pending measurement'},...items];
      return '<section class="production-line">' + select('line-item','Existing scope',choices,line.estimateItemId || '',false,false) + input('line-description','Scope description','text',line.description || '') + input('line-quantity','Installed quantity (blank means pending)','number',line.quantity ?? '') + input('line-unit','Unit','text',line.unit || 'EA') + input('line-hours','Labor hours allocated to this scope','number',line.laborHours ?? 0) + '<button type="button" data-production-remove>Remove scope</button></section>';
    }
    function form(action, row = {}) {
      if (pending() || busy || !current()) return;
      selection = { action, row }; draft = review = null; confirmed = false;
      let fields = '';
      if (['scheduleCreate', 'scheduleEdit', 'dailyCreate', 'workdayStart', 'cardCreate', 'reportExport'].includes(action)) fields += select('projectId', 'Project', options.projects, row.projectId);
      if (['scheduleCreate', 'scheduleEdit', 'dailyCreate', 'workdayStart'].includes(action)) fields += select('memberIds', 'People (select everyone involved)', options.team, undefined, true);
      if (action === 'clockIn') fields += select('activityCodeId', 'Company activity', activities);
      if (action === 'photoUpload') fields += '<label>One JPG, PNG or WebP photo (up to 6 MB)<input name="photo" type="file" accept="image/jpeg,image/png,image/webp" required></label>' + text('caption','Caption','',500);
      if (action === 'reportExport') fields += input('from','First day','date','',true) + input('to','Last day','date','',true) + text('reason','Reason','',2000);
      if (action === 'cardCreate') fields += select('memberId', 'Person', options.team, row.memberId);
      if (['scheduleCreate', 'scheduleEdit'].includes(action)) fields += input('date', 'Date', 'date', row.date || '', true) + input('start', 'Start', 'time', row.start || '', true) + input('end', 'End', 'time', row.end || '', true) + input('activity', 'Activity', 'text', row.activity || '');
      if (action === 'noteCreate') fields += select('kind', 'Kind', [{ id: 'note', name: 'Note' }, { id: 'todo', name: 'To-do' }], 'note');
      if (['noteCreate', 'noteEdit'].includes(action)) fields += text('text', 'Text', row.text || '') + input('dueDate', 'To-do deadline (optional)', 'date', row.dueDate || '');
      if (action === 'leaveCreate') fields += input('startDate', 'First day', 'date', '', true) + input('endDate', 'Last day', 'date', '', true) + '<label><input name="allDay" type="checkbox" checked>All day</label>' + input('startTime', 'Start time for part-day request', 'time') + input('endTime', 'End time for part-day request', 'time') + select('type', 'Type', ['vacation', 'sick', 'unpaid', 'other'].map(id => ({ id, name: id })), 'vacation');
      if (['leaveCreate', 'leaveApprove', 'leaveDecline'].includes(action)) fields += text('note', 'Private request/review note', '', 500);
      if (['cardCreate', 'cardCorrect'].includes(action)) fields += input('inAt', 'Clock-in time including timezone (for example 2026-10-08T08:00:00-07:00)', 'text', row.inAt || '', true) + input('outAt', 'Clock-out time including timezone (leave empty for an open card)', 'text', row.outAt || '');
      if (action === 'dailyCreate') fields += input('dateIso', 'Work date', 'date', '', true) + input('foreman', 'Report author', 'text', nav.actor.name) + text('notes', 'Work performed', '');
      if (['dailyCreate','dailyEdit'].includes(action)) {
        if (action === 'dailyEdit') fields += select('memberIds', 'People involved', options.team, undefined, true) + select('status','Status',[{id:'Draft',name:'Draft'},{id:'Needs review',name:'Submit for review'},...(row.status === 'Approved' ? [{id:'Approved',name:'Approved correction'}] : [])],row.status) + text('notes','Work performed',row.notes || '',20000);
        fields += '<fieldset class="labor-fields"><legend>Hours for selected people</legend>' + options.team.map(member => input('hours-' + member.id,member.name,'number',row.laborEntries?.find(entry => Number(entry.memberId) === member.id)?.hours || 0)).join('') + '</fieldset>';
        const selectedProject = row.projectId || options.projects[0]?.id, projectItems = options.projects.find(item => item.id === Number(selectedProject))?.items || [];
        const lines = row.productionEntries?.length ? row.productionEntries : [{}];
        fields += '<fieldset id="production-fields"><legend>Production scopes</legend>' + lines.map(line => productionLine(line,projectItems)).join('') + '<button type="button" id="production-add">Add scope</button></fieldset>';
      }
      
      if (action === 'workdayStart') fields += text('startNote', 'Start note', '', 2000);
      if (action === 'workdayEnd') fields += text('notes', 'Work performed', '', 20000) + text('next', 'Next work', '', 2000) + input('foreman', 'Report author', 'text', nav.actor.name);
      if (['periodCreate', 'periodEdit'].includes(action)) fields += input('label', 'Pay-period name', 'text', row.label || '', true) + input('from', 'First day', 'date', row.from || '', true) + input('to', 'Last day', 'date', row.to || '', true);
      if (['cardCreate', 'cardCorrect', 'cardRemove', 'periodCreate', 'periodEdit', 'periodCapture'].includes(action)) fields += text('reason', 'Reason', '', 1000);
      root.querySelector('#workflow-action').innerHTML = `<h2>${e(definitions[action][0])}</h2><form id="work-form">${fields}<button type="submit">Review action</button><button type="button" id="workflow-cancel">Cancel</button></form>`;
      const formElement = root.querySelector('#work-form'), selectedMembers = row.memberIds || row.laborEntries?.map(entry => entry.memberId) || (['dailyCreate', 'workdayStart'].includes(action) && nav.actor.memberId != null ? [nav.actor.memberId] : []); for (const optionElement of formElement.elements.memberIds?.options || []) optionElement.selected = selectedMembers.map(String).includes(optionElement.value);
      formElement.querySelector('input,textarea,select,button')?.focus();
    }
    function readback(operation, proof) {
      const namesByField = { projectId: 'Project', memberIds: 'People', memberId: 'Person', date: 'Date', dateIso: 'Work date', start: 'Start', end: 'End', text: 'Text', kind: 'Kind', completed: 'Proposed completion', status: 'Status', decision: 'Decision', dueDate: 'Deadline', startDate: 'First day', endDate: 'Last day', allDay: 'All day', type: 'Type', note: 'Private note', inAt: 'Clock in', outAt: 'Clock out', notes: 'Work performed', reason: 'Reason', label: 'Period', from: 'First day', to: 'Last day', startNote: 'Start note', next: 'Next work' };
      const details = operation.body || operation.previewBody?.details || operation.previewBody;
      const fields = Object.entries(details || {}).filter(([key]) => Object.hasOwn(namesByField, key)).map(([key, value]) => `<dt>${e(namesByField[key])}</dt><dd>${e(key === 'projectId' ? projectName(value) : key === 'memberIds' ? names(value) : key === 'memberId' ? names([value]) : typeof value === 'boolean' ? value ? 'Yes' : 'No' : value || 'Open / not supplied')}</dd>`).join('');
      const image = operation.action === 'photoUpload' ? '<p>Selected image: ' + e(details.file.type) + ', ' + e(details.file.bytes) + ' bytes</p><img class="review-photo" alt="Selected photo to upload" src="' + e(operation.files[0].data) + '">' : '';
      const allocation = (details?.laborEntries || []).map(row => '<li>' + e(names([row.memberId])) + ': ' + e(row.hours) + ' hours</li>').join('') + (details?.productionEntries || []).map(row => '<li>' + e(row.description) + ': ' + e(row.quantity === null ? 'Pending measurement' : row.quantity) + ' ' + e(row.unit) + ' · ' + e(row.laborHours) + ' allocated hours</li>').join('');
      const card = proof?.proposed; const actual = card && typeof card === 'object' ? ['hours', 'status', 'dateIso', 'from', 'to'].filter(key => card[key] != null).map(key => `<dt>${e(key === 'hours' ? 'Proposed hours' : key)}</dt><dd>${e(card[key])}</dd>`).join('') : '';
      return `<h2>Review ${e(definitions[operation.action][0].toLowerCase())}</h2><dl>${fields}${actual}</dl>${image}${allocation ? '<ul>' + allocation + '</ul>' : ''}${selection?.row?.id ? `<p>Current record: ${e(summary(selection.row))}</p>` : ''}${proof?.scheduledConflicts?.length ? '<p class="notice">This decision affects scheduled availability. Review the request and schedule before confirming.</p>' : ''}<p>${operation.serverPreview ? 'The server reviewed this action. Company changes or expiry require a new review.' : 'Review these exact details. The server checks current authority and scope when you confirm.'}</p><label><input type="checkbox" id="work-explicit-confirm">I reviewed this action and want to save it.</label><button type="button" id="work-confirm" disabled>Confirm action</button><button type="button" id="workflow-cancel">Cancel</button>`;
    }
    async function preview(formElement) {
      if (busy || pending() || !selection) return; setBusy(true); confirmed = false; const generation = loadGeneration, selected = selection, currentPreview = () => current() && generation === loadGeneration && selection === selected;
      try {
        const values = Object.fromEntries(new FormData(formElement)); values.memberIds = formElement.elements.memberIds ? [...formElement.elements.memberIds.selectedOptions].map(row => row.value) : []; values.allDay = formElement.elements.allDay?.checked === true;
        if (['dailyCreate','dailyEdit'].includes(selection.action)) {
          values.laborEntries = values.memberIds.map(id => ({memberId:Number(id),hours:Number(formElement.elements['hours-' + id]?.value || 0)}));
          const projectId = Number(values.projectId || selection.row.projectId), items = options.projects.find(row => row.id === projectId)?.items || [];
          values.productionEntries = [...formElement.querySelectorAll('.production-line')].map(section => {
            const itemId = section.querySelector('[name="line-item"]').value, item = items.find(row => String(row.id) === itemId);
            return { estimateItemId:itemId ? Number(itemId) : null, description:section.querySelector('[name="line-description"]').value || item?.name || '', quantity:section.querySelector('[name="line-quantity"]').value === '' ? null : Number(section.querySelector('[name="line-quantity"]').value), unit:section.querySelector('[name="line-unit"]').value || item?.unit || 'EA', laborHours:Number(section.querySelector('[name="line-hours"]').value || 0), ...(itemId ? {} : {custom:true}) };
          }).filter(line => line.description || line.estimateItemId != null);
        }
        if (selection.action === 'photoUpload') {
          const file = formElement.elements.photo.files[0]; if (!file || !['image/jpeg','image/png','image/webp'].includes(file.type) || file.size < 1 || file.size > 6000000) throw Error('Choose one nonempty JPG, PNG or WebP photo up to 6 MB.');
          const bytes = new Uint8Array(await file.arrayBuffer()), digest = new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)); let binary=''; for(let offset=0;offset<bytes.length;offset+=32768) binary += String.fromCharCode(...bytes.subarray(offset,offset+32768));
          values.accessRole = nav.actor.accessRole; values.file = {type:file.type,bytes:file.size,sha256:[...digest].map(value=>value.toString(16).padStart(2,'0')).join(''),lastModified:file.lastModified}; values.files = [{type:file.type,data:'data:'+file.type+';base64,'+btoa(binary),lastModified:file.lastModified}];
        }
        await ctx.verify(); if (!currentPreview()) return; if (!allowed(ctx.getNav(), selection.action)) throw Object.assign(Error('Your permission for this action changed.'), { status: 403 });
        draft = build(selection.action, values, selection.row, project, crypto.randomUUID());
        review = draft.serverPreview ? await ctx.request(draft.previewPath, { method: 'POST', body: JSON.stringify(draft.previewBody) }) : { revision: ctx.getNav().tenantRevision };
        if (!currentPreview()) return; await ctx.verify(review.revision); if (!currentPreview()) return;
        if (draft.action === 'photoUpload') draft.confirmationExtras = {requestId: review.requestId, files: draft.files};
        draft.expiresAt = Date.now() + 600000; root.querySelector('#workflow-action').innerHTML = readback(draft, review); ctx.say('Review the action before confirming.');
      } catch (error) { if (currentPreview()) { draft = review = null; if ([401, 402, 403].includes(error.status)) root.replaceChildren(); ctx.say(error.message, true); } }
      finally { if (currentPreview()) setBusy(false); }
    }
    async function save(record) {
      if (busy || !current()) return;
      if (!record && (!confirmed || !draft || !review || Date.now() >= draft.expiresAt)) return;
      const generation = loadGeneration, currentSave = () => current() && generation === loadGeneration;
      setBusy(true); confirmed = false; const action = record?.action || draft.action; let saved = false;
      try {
        // A cached original request may be recovered after unrelated revisions;
        // server receipt/current-effect checks remain authoritative.
        await ctx.verify(record ? undefined : review.revision); if (!currentSave() || !allowed(ctx.getNav(), action)) throw Object.assign(Error('Your current permission does not allow this action.'), { status: 403 });
        const requestRecord = record || { action, method: draft.method, path: draft.path, body: draft.serverPreview ? { token: review.token, version: review.version, confirmed: true, requestId: crypto.randomUUID(), ...draft.confirmationExtras } : draft.body, retryable: draft.retryable };
        requestRecord.state = 'unknown'; recoveries.set(recoveryKey, requestRecord);
        const result = await ctx.request(requestRecord.path, { method: requestRecord.method, body: JSON.stringify(requestRecord.body) });
        saved = true; requestRecord.state = 'saved'; if (!currentSave()) return; await ctx.verify(); if (!currentSave()) return;
        const refreshed = await load(); if (!current()) return; ctx.say(refreshed ? 'Saved. Current records have been refreshed.' : 'Saved. The current view could not be refreshed; refresh current records to check the result.');
      } catch (error) { if (!currentSave()) return; if (!error.uncertain && !saved) { if (record) record.retryable = false; else recoveries.delete(recoveryKey); } draft = review = null; confirmed = false; if ([401, 402, 403].includes(error.status)) root.replaceChildren(); else await load(); if (!current()) return; ctx.say(saved ? 'Saved. The current view could not be refreshed; reopen to check current records.' : error.message, !saved); }
      finally { if (currentSave()) setBusy(false); }
    }
    async function download(path) {
      if (busy) return; setBusy(true);
      const permitted = () => path === '/api/time-cards.csv' ? gates().timeWrite.downloadCards : path.startsWith('/api/reporting-exports/') ? ctx.getNav().actor.immutableAccess.ownerManagement : gates().timeWrite.downloadExports;
      try { await ctx.verify(); if (!current()) return; if (!permitted()) throw Error('Download is unavailable under your current access.'); const sourceRevision = ctx.getNav().tenantRevision, response = await fetch(path, { credentials: 'include', cache: 'no-store', headers: { 'X-PDL-Company': ctx.companyId() } }); if (!response.ok) throw Error('Download is unavailable under your current access.'); const bytes = await response.blob(); await ctx.verify(sourceRevision); if (!current() || !permitted()) return; const url = URL.createObjectURL(bytes), a = document.createElement('a'); a.href = url; a.download = path === '/api/time-cards.csv' ? 'time-cards.csv' : path.startsWith('/api/reporting-exports/') ? 'reporting-export.csv' : 'payroll.csv'; a.click(); URL.revokeObjectURL(url); }
      catch (error) { if (current()) ctx.say(error.message, true); } finally { if (current()) setBusy(false); }
    }
    async function showRead(path, render) {
      if(busy || pending() || !current()) return; setBusy(true);
      try { await ctx.verify(); if(!current())return; const revision=ctx.getNav().tenantRevision, data=await ctx.request(path); await ctx.verify(revision); if(!current())return; selection=draft=review=null;confirmed=false;if(!gates()[definition[1]][definition[2]])throw Error('This view is restricted.');root.querySelector('#workflow-action').innerHTML=render(data);ctx.say(''); }
      catch(error){if(current()){root.querySelector('#workflow-action').replaceChildren();ctx.say(error.message,true);}}finally{if(current())setBusy(false);}
    }
    const click = event => {
      const target = event.target.closest('button'); if (!target || !root.contains(target) || target.disabled || !current()) return;
      if (target.id === 'production-add') { const formElement = root.querySelector('#work-form'), projectId = Number(formElement.elements.projectId?.value || selection?.row?.projectId); target.insertAdjacentHTML('beforebegin',productionLine({},options.projects.find(row => row.id === projectId)?.items || [])); return; }
      if (target.hasAttribute('data-production-remove')) { target.closest('.production-line').remove(); return; }
      if (target.id === 'workflow-refresh') { if (!busy) load(); return; }
      if (target.id === 'workflow-recover') { if (pending()?.retryable && pending().state !== 'saved') save(pending()); return; }
      if (target.id === 'workflow-reconcile') { if (!busy) { recoveries.delete(recoveryKey); load(); } return; }
      if (target.id === 'workflow-cancel') { if (!busy) { selection = draft = review = null; confirmed = false; root.querySelector('#workflow-action').replaceChildren(); ctx.say('Action cancelled.'); } return; }
      if (target.id === 'work-confirm') { save(); return; }
      if (target.id === 'report-exports') { showRead('/api/reporting-exports', rows => '<h2>Saved reporting exports</h2><ul>' + rows.map(row => '<li>Version ' + e(row.version) + ' · ' + e(row.createdAt) + ' <button type="button" data-report-export="' + e(row.id) + '">Download CSV</button></li>').join('') + '</ul>'); return; }
      if (target.dataset.reportExport) { download('/api/reporting-exports/' + encodeURIComponent(target.dataset.reportExport) + '.csv'); return; }
      if (target.dataset.reportPhotos) { showRead('/api/reports/' + encodeURIComponent(target.dataset.reportPhotos) + '/photos', rows => '<h2>Report photos</h2>' + rows.map(row => '<figure><img class="review-photo" alt="' + e(row.caption || 'Report photo') + '" src="/api/photos/' + e(row.id) + '/file"><figcaption>' + e(row.caption || '') + '</figcaption></figure>').join('')); return; }
      if (target.dataset.periodSummary) { showRead('/api/pay-periods/' + encodeURIComponent(target.dataset.periodSummary) + '/summary', row => '<h2>Current period summary</h2><p>' + e(row.approvedCount) + ' approved cards · ' + e(row.approvedHours) + ' approved hours · ' + (row.ready ? 'Ready' : 'Review incomplete') + '</p><ul>' + Object.entries(row.review).map(([key,value]) => '<li>' + e(key) + ': ' + e(value) + '</li>').join('') + '</ul><ul>' + row.people.map(person => '<li>' + e(person.name) + ': ' + e(person.hours) + ' hours</li>').join('') + '</ul>'); return; }
      if (target.id === 'cards-download') { download('/api/time-cards.csv'); return; }
      if (target.dataset.periodDownload) { if (!gates().timeWrite.downloadExports) return; const periodId=target.dataset.periodDownload; showRead('/api/pay-periods/' + encodeURIComponent(periodId) + '/exports', exports => '<h2>Saved exports</h2><ul>' + exports.map(row => '<li>Version ' + e(row.version) + ' · ' + e(row.createdAt) + ' <button type="button" data-export-download="' + e(periodId) + '/' + e(row.id) + '">Download CSV</button></li>').join('') + '</ul>'); return; }
      if (target.dataset.exportDownload) { download('/api/pay-periods/' + target.dataset.exportDownload.split('/').map(encodeURIComponent).join('/exports/') + '.csv'); return; }
      if (target.dataset.workAction) { const row = target.dataset.record == null ? {} : rows.find(row => String(row.id) === target.dataset.record); if (row && allowed(ctx.getNav(), target.dataset.workAction)) form(target.dataset.workAction, row); }
    };
    const submit = event => { if (event.target.id === 'work-form') { event.preventDefault(); preview(event.target); } };
    const change = event => {
      if (event.target.id === 'work-explicit-confirm') { confirmed = event.target.checked; const button = root.querySelector('#work-confirm'); if (button) button.disabled = !confirmed || busy || !draft || Date.now() >= draft.expiresAt; }
      if (event.target.name === 'notes-project') { if (pending()) { event.target.value = project; return; } project = Number(event.target.value); selection = draft = review = null; confirmed = false; root.querySelector('#workflow-action')?.replaceChildren(); load(); }
      if (event.target.name === 'projectId' && selection?.action === 'dailyCreate') { const items = options.projects.find(row => row.id === Number(event.target.value))?.items || []; for (const element of root.querySelectorAll('[name="line-item"]')) element.innerHTML = [{ id: '', name: 'Unplanned scope / pending measurement' }, ...items].map(row => option(row, '')).join(''); }
      if (event.target.name === 'line-item') { const section = event.target.closest('.production-line'), projectId = Number(root.querySelector('#work-form').elements.projectId?.value || selection?.row?.projectId), item = options.projects.find(row => row.id === projectId)?.items.find(row => String(row.id) === event.target.value); if (item) { section.querySelector('[name="line-description"]').value = item.name; section.querySelector('[name="line-unit"]').value = item.unit; } }
    };
    const clearConfirmation = () => { confirmed = false; const checkbox = root.querySelector('#work-explicit-confirm'); if (checkbox) checkbox.checked = false; const button = root.querySelector('#work-confirm'); if (button) button.disabled = true; };
    const visibility = () => { if (document.hidden) clearConfirmation(); };
    root.addEventListener('click', click); root.addEventListener('submit', submit); root.addEventListener('change', change); window.addEventListener('blur', clearConfirmation); document.addEventListener('visibilitychange', visibility);
    const timer = setInterval(() => { if (draft && Date.now() >= draft.expiresAt) { clearConfirmation(); if (current()) ctx.say('Review expired. Cancel and review current details again.', true); } }, 1000);
    active = { leave() { alive = false; clearInterval(timer); root.removeEventListener('click', click); root.removeEventListener('submit', submit); root.removeEventListener('change', change); window.removeEventListener('blur', clearConfirmation); document.removeEventListener('visibilitychange', visibility); } };
    load(); return active;
  }
  window.WorkspaceActions = { routes, mount, leave() { if (active) active.leave(); active = null; } };
})();
