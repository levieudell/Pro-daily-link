'use strict';
const crypto = require('node:crypto');
const access = require('./daily-access');
const autoAdopt = require('./workday-auto-adopt-admission');
const fieldCards = require('./time-card-field-access');
const payPeriods = require('./pay-periods');
const { authority: timeAuthority } = require('./time-write-admission');
const { canonicalHash } = require('./database/transactional-repository');
const fail = (statusCode, message) => { throw Object.assign(Error(message), { statusCode }); };
const key = value => String(value ?? '').trim();
const equal = (a, b) => canonicalHash(a ?? null) === canonicalHash(b ?? null);
const object = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(name => keys.includes(name));
const pick = (row, keys) => Object.fromEntries(keys.filter(name => Object.hasOwn(row || {}, name)).map(name => [name, row[name]]));
const omit = (row, keys) => Object.fromEntries(Object.entries(row || {}).filter(([name]) => !keys.includes(name)));
const positive = value => ['number', 'string'].includes(typeof value) && /^[1-9]\d*$/.test(key(value)) && Number.isSafeInteger(Number(value));
const numeric = value => ['number', 'string'].includes(typeof value) && String(value).trim() !== '' && Number.isFinite(Number(value)) && Number(value) >= 0;
const textFields = ['crew', 'foreman', 'notes', 'weather', 'temperature', 'materials', 'equipment', 'delays', 'safety', 'signature', 'summary', 'labor', 'quantity', 'issue', 'next', 'noteLanguage', 'englishTranslation'];
const productionFields = ['estimateItemId', 'catalogItemId', 'unplanned', 'description', 'workDescription', 'quantity', 'quantityPending', 'unit', 'laborHours', 'laborHoursPending', 'custom', 'scopeEvidence', 'scopeUnverified', 'scopeChoice', 'needsScopeConfirmation', 'needsLaborConfirmation', 'potentialExtraWork'];
const reportFields = ['id', 'project', 'sourceAssignmentId', 'crew', 'date', 'dateIso', 'foreman', 'status', 'notes', 'originalNotes', 'noteLanguage', 'englishTranslation', 'summary', 'labor', 'quantity', 'issue', 'next', 'weather', 'temperature', 'materials', 'equipment', 'delays', 'safety', 'signature', 'workdayId', 'templateId', 'templateVersion'];
const definitions = Object.freeze({
  createReport: ['createReports', 'POST', '/api/reports'],
  editReport: ['editReports', 'PATCH', id => '/api/reports/' + id],
  approveReport: ['approveReports', 'PATCH', id => '/api/reports/' + id + '/approve'],
  startWorkday: ['runWorkdays', 'POST', '/api/workdays/start'],
  endWorkday: ['runWorkdays', 'POST', id => '/api/workdays/' + id + '/end'],
  captureExport: ['ownerExport', 'POST', '/api/reporting-exports']
});
function parse(input) {
  if (!object(input, ['action', 'id', 'details']) || !Object.hasOwn(definitions, input.action)) fail(400, 'Choose a supported daily action');
  const [permission, method, path] = definitions[input.action], hasId = typeof path === 'function';
  if (hasId ? !positive(input.id) : Object.hasOwn(input, 'id')) fail(400, 'Choose a valid daily action record');
  const fields = { createReport: ['projectId', 'sourceAssignmentId', 'dateIso', 'status', ...textFields, 'productionEntries', 'laborEntries', 'workSuggestions', 'templateId', 'templateVersion', 'customFields'], editReport: ['sourceAssignmentId', 'dateIso', 'status', ...textFields.filter(name => !['noteLanguage', 'englishTranslation'].includes(name)), 'productionEntries', 'laborEntries', 'laborExclusions', 'workSuggestions', 'customFields'], approveReport: [], startWorkday: ['projectId', 'memberIds', 'startNote'], endWorkday: ['notes', 'next', 'foreman'], captureExport: ['projectId', 'from', 'to', 'supersedesId', 'reason'] }[input.action];
  const details = input.details;
  if (!object(details, fields)) fail(400, 'Use only supported daily action details');
  for (const name of [...textFields, 'startNote', 'reason', 'supersedesId', 'templateId']) if (Object.hasOwn(details, name) && (typeof details[name] !== 'string' || details[name].length > (name === 'notes' || name === 'englishTranslation' ? 20000 : 2000))) fail(400, 'Use valid daily text');
  if (Object.hasOwn(details, 'projectId') && !positive(details.projectId) || Object.hasOwn(details, 'templateVersion') && !positive(details.templateVersion)) fail(400, 'Choose valid project/template identifiers');
  for (const name of ['dateIso', 'from', 'to']) if (Object.hasOwn(details, name) && !payPeriods.validDate(details[name])) fail(400, 'Use an explicit valid work date');
  if (Object.hasOwn(details, 'status') && !['Draft', 'Needs review', 'Missing data', 'Approved'].includes(details.status) || input.action === 'createReport' && !['Draft', 'Needs review'].includes(details.status)) fail(400, 'Choose a supported daily status');
  if (Object.hasOwn(details, 'memberIds') && (!Array.isArray(details.memberIds) || !details.memberIds.length || details.memberIds.length > 100 || details.memberIds.some(id => !positive(id)) || new Set(details.memberIds.map(Number)).size !== details.memberIds.length)) fail(400, 'Choose distinct team members');
  if (Object.hasOwn(details, 'laborEntries') && (!Array.isArray(details.laborEntries) || details.laborEntries.length > 100 || details.laborEntries.some(row => !object(row, ['memberId', 'hours', 'crew']) || !positive(row.memberId) || !numeric(row.hours) || Object.hasOwn(row, 'crew') && typeof row.crew !== 'string') || new Set(details.laborEntries.map(row => Number(row.memberId))).size !== details.laborEntries.length)) fail(400, 'Choose valid distinct labor entries');
  if (Object.hasOwn(details, 'laborExclusions') && (!Array.isArray(details.laborExclusions) || details.laborExclusions.length > 100 || details.laborExclusions.some(row => !object(row, ['memberId', 'hours', 'sourceReportId']) || !positive(row.memberId) || !positive(row.sourceReportId) || !numeric(row.hours) || Number(row.hours) <= 0 || Number(row.hours) > 24) || new Set(details.laborExclusions.map(row => Number(row.memberId))).size !== details.laborExclusions.length)) fail(400, 'Choose valid distinct labor counted on another daily');
  for (const name of ['productionEntries', 'workSuggestions']) if (Object.hasOwn(details, name) && (!Array.isArray(details[name]) || details[name].length > 100 || details[name].some(row => !object(row, productionFields) || ['estimateItemId','catalogItemId'].some(field=>Object.hasOwn(row,field)&&row[field]!==null&&!positive(row[field])) || ['quantity', 'laborHours'].some(field => Object.hasOwn(row, field) && row[field] !== null && !numeric(row[field])) || ['description', 'workDescription', 'unit', 'scopeEvidence', 'scopeChoice'].some(field => Object.hasOwn(row, field) && (typeof row[field] !== 'string' || row[field].length > 2000)) || ['unplanned','quantityPending', 'laborHoursPending', 'custom', 'scopeUnverified', 'needsScopeConfirmation', 'needsLaborConfirmation', 'potentialExtraWork'].some(field => Object.hasOwn(row, field) && typeof row[field] !== 'boolean')))) fail(400, 'Use valid production entries');
  if (Object.hasOwn(details, 'customFields') && (!details.customFields || typeof details.customFields !== 'object' || Array.isArray(details.customFields) || Object.keys(details.customFields).length > 40 || Object.values(details.customFields).some(value => value !== null && !['string', 'number', 'boolean'].includes(typeof value) || typeof value === 'string' && value.length > 2000))) fail(400, 'Use simple template field values');
  if(Object.hasOwn(details,'sourceAssignmentId')&&details.sourceAssignmentId!==null&&!positive(details.sourceAssignmentId))fail(400,'Choose a valid scheduled assignment');
  const id = hasId ? key(input.id) : null;
  return { action: input.action, permission, method, path: hasId ? path(id) : path, id, details: structuredClone(details) };
}
function unique(rows, id, name) { const selected = (rows || []).filter(row => key(row.id) === key(id)); if (selected.length !== 1) fail(selected.length ? 409 : 404, selected.length ? 'Ambiguous ' + name + ' needs reconciliation' : name + ' not found'); return selected[0]; }
function authority(db, req) { return canonicalHash({ time: timeAuthority(db, req), access: access.access(db, req.auth.user), dailyRolePolicy: db.company.dailyRolePolicy || null, dailyPolicyRequired: access.required(db), pricingAccess: db.company.pricingAccess || null, autoAdoptActualTimes: db.company.autoAdoptActualTimes===true, scheduleView: require('./scheduling-access').access(db,req.auth.user).view }); }
function validateLaborReferences(db, report, user, requireView = false) {
  if (!Array.isArray(report.laborExclusions || []) || (report.laborExclusions || []).length > 100) fail(409, 'Labor counted on another daily needs reconciliation');
  const members = new Set();
  for (const row of report.laborExclusions || []) {
    if (!row || !positive(row.memberId) || !positive(row.sourceReportId) || !numeric(row.hours) || Number(row.hours) <= 0 || Number(row.hours) > 24 || members.has(Number(row.memberId))) fail(409, 'Labor counted on another daily needs reconciliation');
    members.add(Number(row.memberId));
    const source = unique(db.reports, row.sourceReportId, 'Source report'), targetLabor = (report.laborEntries || []).find(entry => Number(entry.memberId) === Number(row.memberId)), sourceLabor = (source.laborEntries || []).find(entry => Number(entry.memberId) === Number(row.memberId));
    if (!targetLabor || !sourceLabor || !numeric(targetLabor.hours) || !numeric(sourceLabor.hours) || (report.laborEntries || []).filter(entry => Number(entry.memberId) === Number(row.memberId)).length !== 1 || (source.laborEntries || []).filter(entry => Number(entry.memberId) === Number(row.memberId)).length !== 1 || Object.hasOwn(source, 'laborExclusions') && !Array.isArray(source.laborExclusions)) fail(409, 'Source daily labor needs reconciliation');
    if (Number(source.id) === Number(report.id) || source.project !== report.project || !report.dateIso || source.dateIso !== report.dateIso || source.deletedAt || (source.laborExclusions || []).some(entry => Number(entry.memberId) === Number(row.memberId)) || report.status === 'Approved' && source.status !== 'Approved' || !targetLabor || !sourceLabor || Number(row.hours) > Number(targetLabor.hours) || Number(row.hours) > Number(sourceLabor.hours)) fail(409, 'Labor must count on a separate daily for the same project, date and member; approved work needs an approved source');
    if (requireView && (!access.reportInScope(db, user, source, 'viewReports') || !access.memberAllowed(db, user, row.memberId))) fail(403, 'Source daily and member must be within current scope');
  }
}
function authorize(db, user, operation, replay = false) {
  if (operation.permission === 'ownerExport' ? user.role !== 'owner' : !access.access(db, user)[operation.permission]) fail(403, 'Daily action permission required');
  if (access.field(user)) unique(db.team, user.memberId, 'Linked member');
  if (operation.action === 'captureExport') { unique(db.projects, operation.details.projectId, 'Project'); if ((db.reportingExports || []).some(row => row.companyId !== db.company.id)) fail(409, 'Reporting exports need tenant reconciliation'); return; }
  let project, members;
  if (operation.action === 'endWorkday') {
    const day = unique(db.workdays, operation.id, 'Workday'); if (!access.workdayInScope(db, user, day, 'runWorkdays')) fail(404, 'Workday not found');
    project = unique(db.projects, day.projectId, 'Project'); members = day.memberIds;
    if (!replay && day.reportId || new Set(members.map(Number)).size !== members.length) fail(409, 'Active workday bindings need reconciliation');
    if (!Number.isFinite(Date.parse(day.startedAt))) fail(409, 'Workday start needs reconciliation');
    const linked = (db.timeCards || []).filter(card => Number(card.workdayId) === Number(day.id));
    if (db.company?.features?.timeCards === true && members.some(id => !linked.some(card => Number(card.memberId) === Number(id))) || members.some(id => linked.filter(card => !card.outAt && Number(card.memberId) === Number(id)).length > 1)) fail(409, 'Workday crew cards need reconciliation');
    for (const card of db.timeCards || []) if (Number(card.workdayId) === Number(day.id)) {
      unique(db.timeCards, card.id, 'Linked time card');
      if (Number(card.projectId) !== Number(day.projectId) || !members.map(Number).includes(Number(card.memberId)) || card.deletedAt || !Number.isFinite(Date.parse(card.inAt)) || !card.outAt && (fieldCards.status(card) !== 'draft' || [card.status, card.Status, card.state, card.approvalStatus].filter(value => value != null && String(value).trim()).some(value => String(value).trim().toLowerCase() !== 'draft') || card.approvedAt || card.approvedBy || card.lockedAt || card.exportedAt || card.payrollLockedAt || fieldCards.lockedPeriod(db, card))) fail(409, 'Workday time-card bindings need reconciliation');
    }
  } else if (operation.id) {
    const report = unique(db.reports, operation.id, 'Report'); if (!access.reportInScope(db, user, report, operation.permission)) fail(404, 'Report not found');
    project = unique(db.projects, db.projects?.[report.project]?.id, 'Project'); members = (report.laborEntries || []).map(row => row.memberId);
    if (report.status === 'Approved' && operation.action === 'editReport' && !access.access(db, user).approveReports) fail(403, 'Office approval permission required to correct approved work');
  } else { project = unique(db.projects, operation.details.projectId, 'Project'); members = operation.details.memberIds || (operation.details.laborEntries || []).map(row => row.memberId); }
  if (!access.projectAllowed(db, user, project.id) || !members.every(id => access.memberAllowed(db, user, id))) fail(403, 'Assigned project and entire crew scope required');
  for (const id of members) unique(db.team, id, 'Team member');
  if (operation.details.laborEntries) for (const row of operation.details.laborEntries) { const member = unique(db.team, row.memberId, 'Team member'); if (!access.memberAllowed(db, user, row.memberId) || row.crew && row.crew !== member.crew) fail(403, 'Labor must use the current managed crew'); }
  if (operation.details.memberIds && access.field(user) && !operation.details.memberIds.map(Number).includes(Number(user.memberId))) fail(403, 'Your crew workday must include your linked member');
  if (operation.action === 'createReport' && access.field(user) && !(operation.details.laborEntries || []).some(row => Number(row.memberId) === Number(user.memberId))) fail(403, 'Your daily must include your linked member');
  for(const row of operation.details.productionEntries||[]){if(row.estimateItemId!=null)unique(project.estimateItems,row.estimateItemId,'Estimate item');if(row.catalogItemId!=null&&!(project.estimateItems||[]).some(item=>Number(item.catalogItemId)===Number(row.catalogItemId)))fail(403,'Use the selected project estimate catalog binding.');}
  if (Object.hasOwn(operation.details, 'laborExclusions')) {
    if (!['owner', 'admin', 'project_manager'].includes(user.role)) fail(403, 'Office permission is required to decide where hours count');
    validateLaborReferences(db, {...unique(db.reports, operation.id, 'Report'),...operation.details}, user, true);
  }
}
function changed(before, after, name) { const ids = new Set([...(before[name] || []), ...(after[name] || [])].map(row => key(row.id))); return [...ids].filter(id => !equal((before[name] || []).filter(row => key(row.id) === id), (after[name] || []).filter(row => key(row.id) === id))); }
function validateDelta(before, after, user, operation) {
  const allowed = operation.action === 'captureExport' ? ['reportingExports', 'auditLog'] : ['reports', 'workdays', 'timeCards', 'projects', 'auditLog', ...(operation.action==='endWorkday'&&before.company.autoAdoptActualTimes===true?['assignments']:[])];
  if (!equal(omit(before, allowed), omit(after, allowed))) fail(409, 'This daily changes unsupported company data');
  if (!equal(before.auditLog || [], (after.auditLog || []).slice(0, (before.auditLog || []).length))) fail(409, 'Historical audit records cannot change');
  if (operation.action === 'captureExport') {
    if (!equal(before.reportingExports || [], (after.reportingExports || []).slice(0, -1)) || (after.reportingExports || []).length !== (before.reportingExports || []).length + 1) fail(409, 'Fixed reporting exports cannot be rewritten');
    return;
  }
  if(operation.action==='endWorkday'&&before.company.autoAdoptActualTimes===true)autoAdopt.validate(before,after,user,operation);
  const reportIds = changed(before, after, 'reports'), dayIds = changed(before, after, 'workdays'), cardIds = changed(before, after, 'timeCards'), projectIds = changed(before, after, 'projects');
  // Later source edits and approvals must not invalidate an already recorded
  // decision, even when this request omits the laborExclusions field.
  for (const report of after.reports || []) if (reportIds.includes(key(report.id)) || (report.laborExclusions || []).some(row => reportIds.includes(key(row.sourceReportId)))) validateLaborReferences(after, report, user);
  if (['createReport', 'editReport', 'approveReport', 'endWorkday'].includes(operation.action)) {
    if (reportIds.length !== 1 || ['editReport', 'approveReport'].includes(operation.action) && reportIds[0] !== operation.id) fail(409, 'Daily creation/cleanup cannot merge or change unrelated reports');
    const report = unique(after.reports, reportIds[0], 'Report'), old = (before.reports || []).find(row => key(row.id) === reportIds[0]);
    if (['createReport', 'endWorkday'].includes(operation.action) && old || ['editReport', 'approveReport'].includes(operation.action) && !old) fail(409, 'Daily identity needs reconciliation');
    if (!access.reportInScope(after, user, report, operation.action === 'endWorkday' ? 'createReports' : operation.permission)) fail(403, 'Resulting daily is outside current scope');
    if (old && (old.project !== report.project || !equal(omit(old, operation.action === 'approveReport' ? ['status', 'history', 'rateSnapshot', 'rateReview'] : ['sourceAssignmentId', 'date', 'dateIso', 'status', ...textFields, 'productionEntries', 'laborEntries', 'laborExclusions', 'workSuggestions', 'flags', 'history', 'customFields', 'rateReview']), omit(report, operation.action === 'approveReport' ? ['status', 'history', 'rateSnapshot', 'rateReview'] : ['sourceAssignmentId', 'date', 'dateIso', 'status', ...textFields, 'productionEntries', 'laborEntries', 'laborExclusions', 'workSuggestions', 'flags', 'history', 'customFields', 'rateReview'])))) fail(409, 'Immutable daily bindings or rate records changed');
  } else if (reportIds.length) fail(409, 'Unrelated reports cannot change');
  if (['startWorkday', 'endWorkday'].includes(operation.action)) {
    if (dayIds.length !== 1 || operation.id && dayIds[0] !== operation.id) fail(409, 'Unrelated workdays cannot change');
    const day = unique(after.workdays, dayIds[0], 'Workday'), old = (before.workdays || []).find(row => key(row.id) === dayIds[0]);
    if (!access.workdayInScope(after, user, day, 'runWorkdays') || operation.action === 'startWorkday' && old || operation.action === 'endWorkday' && (!old || !equal(omit(old, ['status', 'endedAt', 'endNotes', 'reportId']), omit(day, ['status', 'endedAt', 'endNotes', 'reportId'])))) fail(409, 'Workday scope or immutable bindings changed');
    if (operation.action === 'startWorkday' && cardIds.length !== (after.company?.features?.timeCards === true ? day.memberIds.length : 0)) fail(409, 'Expected crew time cards did not match');
    for (const id of cardIds) {
      const card = unique(after.timeCards, id, 'Time card'), prior = (before.timeCards || []).find(row => key(row.id) === id);
      if (!positive(card.id) || Number(card.workdayId) !== Number(day.id) || Number(card.projectId) !== Number(day.projectId) || !day.memberIds.map(Number).includes(Number(card.memberId)) || operation.action === 'startWorkday' && prior || operation.action === 'endWorkday' && (!prior || !equal(omit(prior, ['outAt', 'hours', 'reportId', 'history']), omit(card, ['outAt', 'hours', 'reportId', 'history'])))) fail(409, 'Linked time-card scope or immutable fields changed');
    }
  } else if (dayIds.length || cardIds.length) fail(409, 'Report editing cannot change workdays or time cards');
  if (operation.action === 'approveReport') {
    const report = unique(after.reports, operation.id, 'Report'), project = after.projects[report.project];
    if (projectIds.length > 1 || projectIds.some(id => key(project.id) !== id) || !equal(omit(before.projects[report.project], ['progress', 'production']), omit(project, ['progress', 'production']))) fail(409, 'Approval cannot change unrelated project settings');
  } else if (projectIds.length) fail(409, 'Project settings cannot change');
}
function reportProjection(db, user, report, presentReport, liveProject = true) {
  const row = presentReport(db, user, report), result = require('./compat-workspace-projections').report(row,Object.hasOwn(row,'rateSnapshot'));
  if(liveProject){const project=db.projects?.[report.project];require('./notes-access').uniqueNumeric(db.projects,project?.id,'Report project',db.company.id);if(typeof project.name!=='string'||project.name.length>5000||/[\u0000-\u001f\u007f]/.test(project.name))fail(409,'Report project label needs reconciliation');result.projectId=Number(project.id);result.projectName=project.name;}
  return result;
}
const dayProjection = row => require('./compat-workspace-projections').workday(row);
function createHandler({ readDb, writeDb, body, json, raw, revision, run, assertCurrent, presentReport, exportProjection, adoptActual, guardDeadline = () => {}, now = () => Date.now() }) {
  const present = (db, user, data, operation) => operation.action === 'captureExport' ? exportProjection(db, user, data) : operation.action === 'startWorkday' ? dayProjection(data) : operation.action === 'endWorkday' ? { workday: dayProjection(data.workday), report: reportProjection(db, user, data.report, presentReport), autoAdoptEnabled:db.company.autoAdoptActualTimes===true, ...(Object.hasOwn(data,'adopted')?{adopted:autoAdopt.present(db,user,operation,data.adopted)}:{}) } : reportProjection(db, user, data, presentReport);
  async function execute(req,operation){
    const source=readDb(), enabled=operation.action==='endWorkday'&&source.company.autoAdoptActualTimes===true;
    if(!enabled)return run(req,operation);
    const base={...source,company:{...source.company,autoAdoptActualTimes:false}},executed=await run(req,operation,base);
    if(executed.response.status>=400)return executed;
    if(!equal(executed.candidate.company,base.company))fail(409,'Workday completion cannot change company settings');
    executed.candidate.company=source.company;
    executed.response.data.adopted=autoAdopt.apply(executed.candidate,req.auth.user,operation,adoptActual);
    return executed;
  }
  return async function handle(req, res, url) {
    const preview = url.pathname === '/api/daily-actions/preview';
    const route = Object.entries(definitions).find(([, [permission, method, path]]) => method === req.method && (typeof path === 'string' ? path === url.pathname : path(url.pathname.match(/\/(\d+)(?:\/[^/]+)?$/)?.[1]) === url.pathname));
    const reads = req.method === 'GET' && (/^\/api\/reports(?:\/\d+)?$/.test(url.pathname) || /^\/api\/workdays(?:\/\d+)?$/.test(url.pathname) || /^\/api\/reporting-exports(?:\/[0-9a-f-]{36}(?:\.csv)?)?$/.test(url.pathname));
    if (!preview && !route && !reads) return false;
    const db = readDb(), user = req.auth.user;
    try {
      if (reads) {
        let data;
        if (url.pathname.startsWith('/api/reporting-exports')) {
          if (user.role !== 'owner') fail(403, 'Account owner permission required');
          if ((db.reportingExports || []).some(row => row.companyId !== db.company.id)) fail(409, 'Reporting exports need tenant reconciliation');
          const id = url.pathname.split('/')[3]?.replace(/\.csv$/, '');
          if (id) { const record = unique(db.reportingExports, id, 'Export'); if (String(record.snapshot?.project?.id) !== String(record.filters?.projectId)) fail(409, 'Export bindings need reconciliation'); }
          const executed = await run(req, { method: 'GET', path: url.pathname, details: {} });
          if (executed.response.status >= 400) fail(executed.response.status, 'Reporting export unavailable');
          await assertCurrent(req);
          if (Object.hasOwn(executed.response, 'raw')) raw(res, executed.response); else json(res, 200, Array.isArray(executed.response.data) ? executed.response.data.map(row => exportProjection(db, user, row)) : exportProjection(db, user, executed.response.data)); return true;
        }
        const reports = url.pathname.startsWith('/api/reports'), id = url.pathname.split('/')[3], permission = reports ? 'viewReports' : 'viewWorkdays';
        if (!access.access(db, user)[permission]) fail(403, 'Daily view permission required');
        const allowed = row => reports ? access.reportInScope(db, user, row) : access.workdayInScope(db, user, row);
        const projectId = url.searchParams.get('projectId');
        const rows = (reports ? db.reports || [] : db.workdays || []).filter(row => allowed(row) && (!projectId || Number(reports ? db.projects?.[row.project]?.id : row.projectId) === Number(projectId)));
        if (id && !rows.some(row => key(row.id) === id)) fail(404, 'Daily record not found');
        if (id) unique(reports ? db.reports : db.workdays, id, 'Daily record');
        data = rows.filter(row => !id || key(row.id) === id).map(row => reports ? reportProjection(db, user, row, presentReport) : dayProjection(row));
        await assertCurrent(req); json(res, 200, id ? data[0] : data); return true;
      }
      if (preview && req.method !== 'POST') fail(404, 'Not found');
      const input = await body(req);
      if (preview) {
        const operation = parse(input); authorize(db, user, operation);
        const executed = await execute(req, operation); if (executed.response.status >= 400) fail(executed.response.status, executed.response.data?.error || 'Daily action unavailable');
        validateDelta(db, executed.candidate, user, operation);
        const token = crypto.randomBytes(32).toString('base64url'), tokenHash = canonicalHash(token), actorHash = authority(db, req), expectedRevision = revision() + 1, version = canonicalHash({ operation, actorHash, tokenHash, expectedRevision });
        db.dailyActionPreviews = (db.dailyActionPreviews || []).filter(row => row.expiresAt >= now()); if (db.dailyActionPreviews.length >= 200) fail(409, 'Too many pending daily previews');
        db.dailyActionPreviews.push({ operation, tokenHash, version, actorHash, actorId: user.id, sessionHash: req.auth.session.tokenHash, expectedRevision, expiresAt: now() + 600000 });
        db.auditLog ||= []; db.auditLog.push({ id: crypto.randomUUID(), type: 'daily_action_previewed', actorId: user.id, action: operation.action, at: new Date(now()).toISOString() });
        writeDb(db); json(res, 200, { token, version, revision: expectedRevision, action: operation.action, details: operation.details, recordId: operation.id, proposed: present(executed.candidate, user, executed.response.data, operation), message: 'Review and explicitly confirm. Only private proof/audit is saved by preview. Workday clocks use actual confirmation time; IDs are provisional. Photo uploads remain unavailable in this draft.' }); return true;
      }
      if (!object(input, ['token', 'version', 'confirmed', 'requestId']) || input.confirmed !== true || typeof input.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(input.token) || Buffer.from(input.token, 'base64url').toString('base64url') !== input.token || typeof input.version !== 'string' || !/^[a-f0-9]{64}$/.test(input.version) || typeof input.requestId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(input.requestId)) fail(400, 'Preview and explicitly confirm with a request ID');
      const tokenHash = canonicalHash(input.token), inputHash = canonicalHash(input), prior = (db.dailyActionReceipts || []).find(row => row.tokenHash === tokenHash || row.actorId === user.id && row.requestId === input.requestId), proof = prior || (db.dailyActionPreviews || []).find(row => row.tokenHash === tokenHash);
      if (!proof || proof.operation.method !== req.method || proof.operation.path !== url.pathname) fail(409, 'Preview does not match this daily route');
      const operation = parse({ action: proof.operation.action, ...(proof.operation.id ? { id: proof.operation.id } : {}), details: proof.operation.details }); if (!equal(operation, proof.operation)) fail(409, 'Daily proof needs reconciliation');
      authorize(db, user, operation, Boolean(prior));
      if (proof.actorId !== user.id || proof.sessionHash !== req.auth.session.tokenHash || proof.actorHash !== authority(db, req) || proof.tokenHash !== tokenHash || proof.version !== input.version) fail(409, 'Daily authority changed; preview again');
      if (prior) {
        if (prior.inputHash !== inputHash || prior.effectHash !== effect(db, operation)) fail(409, 'This daily action or its result changed');
        await assertCurrent(req); json(res, 200, present(db, req.auth.user, prior.result, operation)); return true;
      }
      if (proof.expectedRevision !== revision() || proof.expiresAt < now()) fail(409, 'Company changed or daily preview expired');
      guardDeadline(new Date(proof.expiresAt).toISOString());
      const executed = await execute(req, operation); if (executed.response.status >= 400) fail(executed.response.status, executed.response.data?.error || 'Daily action unavailable');
      validateDelta(db, executed.candidate, user, operation);
      const candidate = executed.candidate, result = present(candidate, user, executed.response.data, operation);
      candidate.dailyActionPreviews = (candidate.dailyActionPreviews || []).filter(row => row.tokenHash !== tokenHash); candidate.dailyActionReceipts ||= []; candidate.dailyActionReceipts.push({ ...proof, inputHash, requestId: input.requestId, effectHash: effect(candidate, operation), result, at: new Date(now()).toISOString() });
      candidate.auditLog ||= []; candidate.auditLog.push({ id: crypto.randomUUID(), type: 'daily_action_confirmed', actorId: user.id, action: operation.action, at: new Date(now()).toISOString() });
      writeDb(candidate); json(res, executed.response.status, result); return true;
    } catch (error) { if (![400, 401, 402, 403, 404, 409].includes(error.statusCode)) throw error; json(res, error.statusCode, { error: error.message }); return true; }
  };
}
function effect(db, operation) { return canonicalHash(operation.action === 'captureExport' ? db.reportingExports || [] : { reports: db.reports || [], workdays: db.workdays || [], timeCards: db.timeCards || [], projects: db.projects || [], ...(operation.action==='endWorkday'&&db.company.autoAdoptActualTimes===true?{assignments:db.assignments||[]}: {}) }); }
module.exports = { definitions, parse, unique, authority, authorize, validateDelta, reportProjection, dayProjection, createHandler };
