'use strict';
const crypto = require('node:crypto');
const access = require('./time-write-access');
const review = require('./time-review-access');
const { cardProjection, authority: reviewAuthority } = require('./time-review-admission');
const { canonicalHash } = require('./database/transactional-repository');
const fail = (status, message) => { throw Object.assign(Error(message), { statusCode: status }); };
const key = value => String(value ?? '').trim();
const object = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(name => keys.includes(name));
const equal = (a, b) => canonicalHash(a ?? null) === canonicalHash(b ?? null);
const pick = (row, keys) => Object.fromEntries(keys.filter(name => Object.hasOwn(row, name)).map(name => [name, row[name]]));
const omit = (row, keys) => Object.fromEntries(Object.entries(row || {}).filter(([name]) => !keys.includes(name)));
const instant = value => value === null || value === '' || typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(value) && Number.isFinite(Date.parse(value));
const positive = value => ['string', 'number'].includes(typeof value) && /^[1-9]\d*$/.test(key(value)) && Number.isSafeInteger(Number(value));
const definitions = Object.freeze({
  create: ['cards', 'createCards', 'POST', '/api/time-cards'],
  correct: ['cards', 'correctCards', 'PATCH', id => '/api/time-cards/' + id],
  remove: ['cards', 'removeCards', 'DELETE', id => '/api/time-cards/' + id],
  submit: ['cards', 'submitCards', 'POST', id => '/api/time-cards/' + id + '/submit'],
  companyClock: ['cards', 'clockCards', 'POST', '/api/time-cards/company-clock'],
  clockOut: ['cards', 'clockCards', 'POST', id => '/api/time-cards/' + id + '/clock-out'],
  createPeriod: ['payroll', 'configurePeriods', 'POST', '/api/pay-periods'],
  editPeriod: ['payroll', 'configurePeriods', 'PATCH', id => '/api/pay-periods/' + id],
  captureExport: ['payroll', 'captureExports', 'POST', id => '/api/pay-periods/' + id + '/exports']
});
function parse(input, kind) {
  if (!object(input, ['action', 'id', 'details']) || !Object.hasOwn(definitions, input.action) || definitions[input.action][0] !== kind) fail(400, 'Choose a supported time action');
  const [group, permission, method, path] = definitions[input.action], hasId = typeof path === 'function';
  if (hasId ? group === 'cards' ? !positive(input.id) : typeof input.id !== 'string' || !/^[0-9a-f-]{36}$/.test(input.id) : Object.hasOwn(input, 'id')) fail(400, 'Choose a valid action record');
  const fields = { create: ['memberId', 'projectId', 'activityCodeId', 'inAt', 'outAt', 'reason'], correct: ['inAt', 'outAt', 'breaks', 'activityCodeId', 'reason', 'revision'], remove: ['reason'], submit: ['revision'], companyClock: ['activityCodeId'], clockOut: ['revision'], createPeriod: ['label', 'from', 'to', 'reason'], editPeriod: ['label', 'from', 'to', 'reason'], captureExport: ['supersedesId', 'reason'] }[input.action];
  const details = input.details;
  if (!object(details, fields)) fail(400, 'Use only supported action details');
  for (const name of ['inAt', 'outAt']) if (Object.hasOwn(details, name) && !instant(details[name])) fail(400, 'Use explicit valid clock instants');
  for (const name of ['reason', 'label', 'from', 'to', 'revision', 'supersedesId']) if (Object.hasOwn(details, name) && (typeof details[name] !== 'string' || details[name].length > (name === 'reason' ? 1000 : 500))) fail(400, 'Use valid text action details');
  if (Object.hasOwn(details, 'memberId') && !positive(details.memberId) || Object.hasOwn(details, 'projectId') && details.projectId !== null && details.projectId !== '' && !positive(details.projectId)) fail(400, 'Choose valid person and project identifiers');
  if (Object.hasOwn(details, 'activityCodeId') && details.activityCodeId !== null && (typeof details.activityCodeId !== 'string' || !details.activityCodeId || details.activityCodeId.length > 128)) fail(400, 'Choose a valid company activity');
  if (Object.hasOwn(details, 'breaks') && (!Array.isArray(details.breaks) || details.breaks.length > 100 || details.breaks.some(row => !object(row, ['type', 'startedAt', 'endedAt', 'missed', 'interrupted']) || !['unpaid_meal', 'paid_rest'].includes(row.type) || ['startedAt', 'endedAt'].some(name => Object.hasOwn(row, name) && !instant(row[name])) || ['missed', 'interrupted'].some(name => Object.hasOwn(row, name) && typeof row[name] !== 'boolean')))) fail(400, 'Use valid break details');
  const id = hasId ? key(input.id) : null;
  return { action: input.action, kind: group, permission, method, path: hasId ? path(id) : path, id, details: structuredClone(details) };
}
function authority(db, req) { return canonicalHash({ review: reviewAuthority(db, req), access: access.access(db, req.auth.user), policy: db.company.timeWriteRolePolicy || null, required: access.required(db) }); }
function unique(rows, id, name) {
  const matches = (rows || []).filter(row => key(row.id) === key(id));
  if (matches.length !== 1) fail(matches.length ? 409 : 404, matches.length ? 'Ambiguous ' + name + ' needs reconciliation' : name + ' not found');
  return matches[0];
}
function authorize(db, user, operation, activities, replay = false) {
  if (!access.access(db, user)[operation.permission]) fail(403, 'Time action permission required');
  const field = ['field', 'foreman'].includes(user.role);
  if (operation.kind === 'payroll') {
    if (operation.id) unique(db.payPeriods, operation.id, 'Pay period');
    if ((db.payPeriodExports || []).some(row => row.companyId !== db.company.id)) fail(409, 'Fixed exports need tenant reconciliation');
    return;
  }
  if (field) unique(db.team, user.memberId, 'Linked member');
  if (operation.id) {
    const rows = (db.timeCards || []).filter(row => key(row.id) === operation.id);
    if (!rows.some(row => (!row.deletedAt || replay && operation.action === 'remove') && access.inScope(db, user, { ...row, deletedAt: null }, operation.permission))) fail(404, 'Time card not found');
    unique(db.timeCards, operation.id, 'Time card');
    if (field && Object.hasOwn(operation.details, 'activityCodeId')) fail(400, 'Only office accounts can change the activity');
  }
  if (operation.action === 'create') {
    const member = unique(db.team, operation.details.memberId, 'Team member'), projectId = operation.details.projectId;
    if (projectId) unique(db.projects, projectId, 'Project');
    if (user.role === 'project_manager' && !review.cardInScope(db, user, { projectId, memberId: member.id })) fail(403, 'Assigned project and crew required');
  }
  if (operation.details.activityCodeId && !activities(db).some(row => key(row.id) === operation.details.activityCodeId && row.active !== false)) fail(400, 'Choose an active company activity');
}
function rowsChanged(before, after, name) {
  const oldRows = before[name] || [], newRows = after[name] || [], ids = new Set([...oldRows, ...newRows].map(row => key(row.id)));
  return [...ids].filter(id => !equal(oldRows.filter(row => key(row.id) === id), newRows.filter(row => key(row.id) === id)));
}
function validateDelta(before, after, user, operation) {
  const allowed = operation.kind === 'payroll' ? ['payPeriods', 'payPeriodExports', 'auditLog'] : ['timeCards', 'reports', 'workdays', 'companyActivityCodes'];
  if (!equal(omit(before, allowed), omit(after, allowed))) fail(409, 'This action changes unsupported company data');
  if (operation.kind === 'payroll') {
    if (operation.action !== 'captureExport' && !equal(before.payPeriodExports, after.payPeriodExports)) fail(409, 'Fixed exports cannot be rewritten');
    if (operation.action === 'captureExport' && (!equal(before.payPeriodExports || [], (after.payPeriodExports || []).slice(0, -1)) || after.payPeriodExports.length !== (before.payPeriodExports || []).length + 1)) fail(409, 'Fixed exports cannot be rewritten');
    const periods = rowsChanged(before, after, 'payPeriods');
    if (periods.length !== 1 || operation.id && periods[0] !== operation.id) fail(409, 'Unrelated pay periods cannot change');
    const row = unique(after.payPeriods, periods[0], 'Pay period');
    if (operation.action === 'captureExport') {
      const old = unique(before.payPeriods, periods[0], 'Pay period');
      if (!equal(omit(old, ['status', 'closedAt']), omit(row, ['status', 'closedAt']))) fail(409, 'Captured period settings cannot change');
    }
    if (!equal(before.auditLog || [], (after.auditLog || []).slice(0, -1)) || after.auditLog.length !== (before.auditLog || []).length + 1) fail(409, 'Existing audit records cannot change');
    return;
  }
  const changed = rowsChanged(before, after, 'timeCards');
  if (changed.length !== 1 || operation.id && changed[0] !== operation.id) fail(409, 'Unrelated time cards need separate reconciliation');
  const card = unique(after.timeCards, changed[0], 'Time card'), prior = (before.timeCards || []).find(row => key(row.id) === changed[0]);
  if (!access.inScope(after, user, { ...card, deletedAt: null }, operation.permission) || prior && (!access.inScope(before, user, prior, operation.permission) || Number(prior.memberId) !== Number(card.memberId) || prior.projectId !== card.projectId)) fail(403, 'Time card scope changed');
  if (!['create', 'companyClock'].includes(operation.action) && !prior || ['create', 'companyClock'].includes(operation.action) && prior) fail(409, 'Time card identifier needs reconciliation');
  if (!['create', 'companyClock'].includes(operation.action) && !equal(before.companyActivityCodes, after.companyActivityCodes)) fail(409, 'Activity changes need separate review');
  const field = ['field', 'foreman'].includes(user.role), projectIndex = (before.projects || []).findIndex(row => Number(row.id) === Number(card.projectId));
  for (const id of rowsChanged(before, after, 'workdays')) {
    const old = unique(before.workdays, id, 'Workday'), row = unique(after.workdays, id, 'Workday');
    if (!field || operation.action !== 'correct' || Number(card.workdayId) !== Number(old.id) || Number(old.projectId) !== Number(card.projectId) || old.status !== 'active' || !equal((old.memberIds || []).map(Number), [Number(card.memberId)]) || !equal(omit(old, ['status', 'startedAt', 'endedAt', 'endNotes', 'history']), omit(row, ['status', 'startedAt', 'endedAt', 'endNotes', 'history']))) fail(409, 'Workday binding needs separate reconciliation');
  }
  for (const id of rowsChanged(before, after, 'reports')) {
    const old = unique(before.reports, id, 'Report'), row = unique(after.reports, id, 'Report');
    if (!['correct', 'remove'].includes(operation.action) || projectIndex < 0 || Number(old.project) !== projectIndex || field && (String(old.status).toLowerCase() !== 'draft' || operation.action !== 'correct') || !equal(omit(old, ['laborEntries', 'productionEntries', 'history']), omit(row, ['laborEntries', 'productionEntries', 'history']))) fail(409, 'Report binding needs separate reconciliation');
    if (field) {
      const day = card.workdayId ? unique(before.workdays, card.workdayId, 'Workday') : null;
      if (key(card.reportId || day?.reportId) !== id || day && Number(day.projectId) !== Number(card.projectId)) fail(409, 'Report and workday bindings disagree');
    }
    const otherLabor = entries => (entries || []).filter(entry => Number(entry.memberId) !== Number(card.memberId));
    if (!equal(otherLabor(old.laborEntries), otherLabor(row.laborEntries))) fail(409, 'Another person\'s labor cannot change');
    const oldOwn = (old.laborEntries || []).filter(entry => Number(entry.memberId) === Number(card.memberId)), newOwn = (row.laborEntries || []).filter(entry => Number(entry.memberId) === Number(card.memberId));
    if (oldOwn.length > 1 || newOwn.length > 1 || oldOwn.length && newOwn.length && !equal(omit(oldOwn[0], ['hours']), omit(newOwn[0], ['hours'])) || !oldOwn.length && newOwn.some(entry => !object(entry, ['memberId', 'hours', 'crew']))) fail(409, 'Labor binding needs reconciliation');
    if (!equal((old.productionEntries || []).map(entry => omit(entry, ['laborHours'])), (row.productionEntries || []).map(entry => omit(entry, ['laborHours'])))) fail(409, 'Production details cannot change');
    for (const contributor of after.timeCards || []) {
      const day = (after.workdays || []).find(item => Number(item.id) === Number(contributor.workdayId));
      if (!contributor.deletedAt && Number(contributor.memberId) === Number(card.memberId) && key(contributor.reportId || day?.reportId) === id && Number(contributor.projectId) !== Number(card.projectId)) fail(409, 'Linked time belongs to another project');
    }
  }
}
function periodProjection(row) { return pick(row, ['id', 'label', 'from', 'to', 'timeZone', 'status', 'createdAt', 'updatedAt', 'closedAt', 'exportCount']); }
function summaryProjection(row) {
  return { ...pick(row, ['datePolicy', 'approvedHours', 'approvedCount', 'ready', 'latestExport']), period: periodProjection(row.period || {}), review: pick(row.review || {}, ['draft', 'submitted', 'running', 'invalid', 'undated', 'missingScheduledEntries']), people: (row.people || []).map(item => pick(item, ['memberId', 'name', 'hours', 'cardCount'])), missingEntries: (row.missingEntries || []).map(item => pick(item, ['date', 'memberId', 'projectId', 'person', 'project'])), records: (row.records || []).map(item => pick(item, ['id', 'memberId', 'person', 'projectId', 'project', 'date', 'inAt', 'outAt', 'hours', 'approvedBy', 'approvedAt'])) };
}
function exportProjection(row) { return { ...pick(row, ['id', 'companyId', 'periodId', 'version', 'supersedesId', 'reason', 'createdAt', 'createdBy', 'sourceHash']), ...(row.summary ? { summary: summaryProjection(row.summary) } : {}) }; }
function projectResponse(response, operation) {
  if (operation.kind === 'payroll') return operation.action === 'captureExport' ? exportProjection(response) : periodProjection(response);
  if (operation.action === 'remove') return pick(response, ['ok', 'reportSynced']);
  return { ...cardProjection(response), ...pick(response, ['historyLines', 'fieldAccess', 'workdayCompleted', 'reportSynced']) };
}
function routeOperation(method, path) {
  for (const [action, definition] of Object.entries(definitions)) {
    if (definition[2] !== method) continue;
    if (typeof definition[3] === 'string') { if (definition[3] === path) return { action, kind: definition[0], permission: definition[1], method, path, id: null }; }
    else {
      const match = definition[0] === 'cards' ? path.match(/^\/api\/time-cards\/(\d+)(?:\/(submit|clock-out))?$/) : path.match(/^\/api\/pay-periods\/([0-9a-f-]{36})(?:\/exports)?$/);
      if (match && definition[3](match[1]) === path) return { action, kind: definition[0], permission: definition[1], method, path, id: match[1] };
    }
  }
  return null;
}
function createHandler({ readDb, writeDb, body, json, raw, revision, run, activities, assertCurrent, now = () => Date.now() }) {
  return async function handle(req, res, url) {
    const previewKind = url.pathname === '/api/time-cards/action-preview' ? 'cards' : url.pathname === '/api/pay-periods/action-preview' ? 'payroll' : null;
    const route = routeOperation(req.method, url.pathname);
    const read = req.method === 'GET' && (['/api/time-cards.csv', '/api/report-labor-suggestions', '/api/company-activities'].includes(url.pathname) || /^\/api\/pay-periods(?:\/[0-9a-f-]{36}(?:\/(?:summary|exports(?:\/[0-9a-f-]{36}(?:\.csv)?)?))?)?$/.test(url.pathname));
    if (!previewKind && !route && !read) return false;
    const db = readDb(), user = req.auth.user;
    try {
      if (db.company?.features?.timeCards !== true) fail(404, 'Not found');
      if (read) {
        const permission = url.pathname === '/api/time-cards.csv' ? 'downloadCards' : url.pathname === '/api/company-activities' ? 'viewActivities' : url.pathname === '/api/report-labor-suggestions' ? 'correctCards' : url.pathname.includes('/exports') ? 'downloadExports' : 'viewPayroll';
        if (!access.access(db, user)[permission]) fail(403, 'Time view permission required');
        if (url.pathname === '/api/report-labor-suggestions') {
          const project = unique(db.projects, url.searchParams.get('projectId'), 'Project');
          if (user.role === 'project_manager' && !(user.projectIds || []).map(Number).includes(Number(project.id)) || ['field', 'foreman'].includes(user.role) && !(db.timeCards || []).some(card => Number(card.projectId) === Number(project.id) && access.inScope(db, user, card, 'correctCards'))) fail(404, 'Project not found');
          if (url.searchParams.get('reportId')) { const report = unique(db.reports, url.searchParams.get('reportId'), 'Report'); if (Number(report.project) !== (db.projects || []).indexOf(project)) fail(404, 'Report not found'); }
        }
        const periodId = url.pathname.split('/')[3];
        if (url.pathname.startsWith('/api/pay-periods/') && periodId) unique(db.payPeriods, periodId, 'Pay period');
        const exportId = url.pathname.split('/')[5]?.replace(/\.csv$/, '');
        if (url.pathname.includes('/exports')) {
          if ((db.payPeriodExports || []).some(row => row.periodId === periodId && row.companyId !== db.company.id)) fail(409, 'Fixed exports need tenant reconciliation');
          if (exportId) unique(db.payPeriodExports, exportId, 'Export');
        }
        const executed = await run(req, { method: 'GET', path: url.pathname + url.search, kind: url.pathname.startsWith('/api/pay-periods') ? 'payroll' : url.pathname === '/api/company-activities' ? 'activities' : 'cards', details: {} });
        if (executed.response.status >= 400) fail(executed.response.status, 'Time view is unavailable');
        await assertCurrent();
        if (Object.hasOwn(executed.response, 'raw')) raw(res, executed.response); else {
          let data = executed.response.data;
          if (url.pathname === '/api/company-activities') data = data.map(row => pick(row, ['id', 'name', 'active']));
          else if (url.pathname === '/api/pay-periods') data = { canConfigure: access.access(db, user).configurePeriods, periods: data.periods.map(periodProjection) };
          else if (url.pathname.endsWith('/summary')) { data = summaryProjection(data); if (!access.access(db, user).downloadExports) delete data.latestExport; }
          else if (url.pathname.endsWith('/exports')) data = data.map(exportProjection);
          else if (url.pathname.includes('/exports/')) data = exportProjection(data);
          json(res, 200, data);
        }
        return true;
      }
      if (previewKind && req.method !== 'POST') fail(404, 'Not found');
      const input = await body(req);
      if (previewKind) {
        const operation = parse(input, previewKind); authorize(db, user, operation, activities);
        const executed = await run(req, operation);
        if (executed.response.status >= 400) fail(executed.response.status, executed.response.data?.error || 'Time action is unavailable');
        validateDelta(db, executed.candidate, user, operation);
        const token = crypto.randomBytes(32).toString('base64url'), tokenHash = canonicalHash(token), actorHash = authority(db, req), expectedRevision = revision() + 1;
        const version = canonicalHash({ operation, actorHash, expectedRevision, tokenHash });
        db.timeWriterPreviews = (db.timeWriterPreviews || []).filter(row => row.expiresAt >= now());
        if (db.timeWriterPreviews.length >= 200) fail(409, 'Too many pending previews; wait for expiry');
        db.timeWriterPreviews.push({ tokenHash, version, operation, actorHash, actorId: user.id, sessionHash: req.auth.session.tokenHash, expectedRevision, expiresAt: now() + 10 * 60000 });
        db.auditLog ||= []; db.auditLog.push({ id: crypto.randomUUID(), type: 'time_action_previewed', actorId: user.id, action: operation.action, at: new Date(now()).toISOString() });
        writeDb(db);
        json(res, 200, { token, version, revision: expectedRevision, action: operation.action, details: operation.details, recordId: operation.id, proposed: projectResponse(executed.response.data, operation), message: 'Review and explicitly confirm. This preview saves a private expiring proof and audit entry only. Clock actions use the actual confirmation time; generated record IDs are provisional.' }); return true;
      }
      if (!object(input, ['token', 'version', 'confirmed', 'requestId']) || input.confirmed !== true || typeof input.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(input.token) || Buffer.from(input.token, 'base64url').toString('base64url') !== input.token || typeof input.version !== 'string' || !/^[a-f0-9]{64}$/.test(input.version) || typeof input.requestId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(input.requestId)) fail(400, 'Preview and explicitly confirm with a request ID');
      const tokenHash = canonicalHash(input.token), inputHash = canonicalHash(input), prior = (db.timeWriterReceipts || []).find(row => row.tokenHash === tokenHash || row.actorId === user.id && row.requestId === input.requestId);
      const proof = prior || (db.timeWriterPreviews || []).find(row => row.tokenHash === tokenHash);
      if (!proof || proof.operation.path !== url.pathname || proof.operation.method !== req.method) fail(409, 'Preview does not match this action');
      const operation = parse({ action: proof.operation.action, ...(proof.operation.id ? { id: proof.operation.id } : {}), details: proof.operation.details }, proof.operation.kind);
      if (!equal(operation, proof.operation)) fail(409, 'Preview operation needs reconciliation');
      authorize(db, user, operation, activities, Boolean(prior));
      if (proof.actorId !== user.id || proof.sessionHash !== req.auth.session.tokenHash || proof.actorHash !== authority(db, req) || proof.version !== input.version || proof.tokenHash !== tokenHash) fail(409, 'Action authority changed; preview again');
      if (prior) {
        if (prior.inputHash !== inputHash || prior.effectHash !== canonicalHash(effect(db, operation, prior.recordId))) fail(409, 'This action was already used or its records changed');
        await assertCurrent(); json(res, 200, prior.result); return true;
      }
      if (proof.expiresAt < now() || proof.expectedRevision !== revision()) fail(409, 'Company changed or preview expired; preview again');
      const executed = await run(req, operation);
      if (executed.response.status >= 400) fail(executed.response.status, executed.response.data?.error || 'Time action is unavailable');
      validateDelta(db, executed.candidate, user, operation);
      const candidate = executed.candidate, result = projectResponse(executed.response.data, operation), recordId = result.id || operation.id;
      candidate.timeWriterPreviews = (candidate.timeWriterPreviews || []).filter(row => row.tokenHash !== tokenHash);
      candidate.timeWriterReceipts ||= []; candidate.timeWriterReceipts.push({ ...proof, inputHash, requestId: input.requestId, recordId, result, effectHash: canonicalHash(effect(candidate, operation, recordId)), at: new Date(now()).toISOString() });
      candidate.auditLog ||= []; candidate.auditLog.push({ id: crypto.randomUUID(), type: 'time_action_confirmed', actorId: user.id, action: operation.action, recordId, at: new Date(now()).toISOString() });
      writeDb(candidate); json(res, executed.response.status, result); return true;
    } catch (error) { if (![400, 403, 404, 409].includes(error.statusCode)) throw error; json(res, error.statusCode, { error: error.message }); return true; }
  };
}
// Receipts compare all business collections touched by an action. A later
// correction cannot replay an old result, even when the original card survives.
function effect(db, operation, recordId) {
  return operation.kind === 'payroll' ? { periods: db.payPeriods || [], exports: db.payPeriodExports || [] } : { cards: db.timeCards || [], reports: db.reports || [], workdays: db.workdays || [], recordId };
}
module.exports = { definitions, parse, authorize, validateDelta, authority, periodProjection, summaryProjection, exportProjection, routeOperation, createHandler };
