'use strict';
// Five existing handlers. Route kinds are custody identities, never role flags.
const { canonicalHash } = require('./database/transactional-repository');
const daily = require('./daily-access');
const rates = require('./report-rate-policy');
const dto = require('./compat-workspace-projections');
const equal = (a, b) => canonicalHash(a ?? null) === canonicalHash(b ?? null);
const omit = (row, keys) => Object.fromEntries(Object.entries(row).filter(([key]) => !keys.includes(key)));
const defaults = () => require('./resource-inputs');
const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const resolutions = ['mapped', 'non_billable', 'tm', 'potential_change'];
const safetyText = { observation: 1000, location: 200, company: 200, notified: 200, action: 500, owner: 200, verification: 500 };
const reportSafetyText = { safetyTalk: 1500, safetyTalkAttendees: 500, safetyInspection: 1500, safetyIncident: 1500 };
const safetyFields = Object.freeze(['reportType', 'safetyItems', ...Object.keys(reportSafetyText), 'noSafetyObservations']);
const reconcile = input => input.fail(409, 'Report effects or source bindings require reconciliation.');
function route(method, path) {
  if (method === 'DELETE' && /^\/api\/reports\/[1-9]\d*$/.test(path)) return 'reportRemove';
  if (method !== 'PATCH') return null;
  if (/^\/api\/projects\/[1-9]\d*\/rate-settings$/.test(path)) return 'projectRateSettings';
  return ({ disposition: 'reportDisposition', safety: 'reportSafety', rate: 'reportRate' })[/^\/api\/reports\/[1-9]\d*\/(disposition|safety|rate)$/.exec(path)?.[1]] || null;
}
function amount(value, input) {
  // Normal HTML number inputs submit strings. Preserve that explicit baseline.
  if (typeof value === 'string' && /^[+]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim())) value = Number(value);
  return input.number(value);
}
function parse(op, input = defaults()) {
  if (!input.object(op, ['kind', 'method', 'path', 'details']) || Object.keys(op).length !== 4 || typeof op.path !== 'string' || op.path.length > 160 || !op.kind || route(op.method, op.path) !== op.kind || !input.id(Number(op.path.split('/')[3]))) input.fail(400, 'Choose one supported report change.');
  const d = op.details; let out;
  if (op.kind === 'reportDisposition') {
    if (!input.object(d, ['resolution', 'note']) || !resolutions.includes(d.resolution)) input.fail(400, 'Choose an existing office disposition.');
    out = { resolution: d.resolution, note: Object.hasOwn(d, 'note') ? input.text(d.note, 500) : '' };
  } else if (op.kind === 'reportRemove') {
    if (!input.object(d, ['reason']) || Object.keys(d).length !== 1) input.fail(400, 'Enter only the deletion reason.');
    out = { reason: input.text(d.reason, 500, true) };
  } else if (op.kind === 'reportSafety') {
    if (!input.object(d, safetyFields)) input.fail(400, 'Use only the existing safety follow-up fields.');
    const reportType = d.reportType ?? 'production', raw = d.safetyItems ?? [];
    if (!['production', 'superintendent'].includes(reportType) || !Array.isArray(raw) || raw.length > 50 || Object.hasOwn(d, 'noSafetyObservations') && typeof d.noSafetyObservations !== 'boolean') input.fail(400, 'Choose valid safety follow-up details.');
    const safetyItems = raw.map(row => {
      if (!input.object(row, [...Object.keys(safetyText), 'dueDate', 'status'])) input.fail(400, 'Use only the supported safety observation fields.');
      const item = Object.fromEntries(Object.entries(safetyText).map(([name, limit]) => [name, input.text(row[name] ?? '', limit, name === 'observation')]));
      item.dueDate = row.dueDate ?? ''; item.status = row.status ?? 'open';
      if (item.dueDate !== '' && !input.date(item.dueDate) || !['open', 'corrected', 'verified'].includes(item.status)) input.fail(400, 'Choose a valid safety due date and follow-up status.');
      return item;
    });
    out = { reportType, safetyItems, ...Object.fromEntries(Object.entries(reportSafetyText).map(([name, limit]) => [name, input.text(d[name] ?? '', limit)])), noSafetyObservations: d.noSafetyObservations ?? false };
    if (out.noSafetyObservations && safetyItems.length) input.fail(400, 'A log cannot contain observations and also say none were reported.');
  } else {
    const field = op.kind === 'reportRate' ? 'laborRate' : 'defaultLaborRate', keys = [field, 'reason', ...(op.kind === 'reportRate' ? ['evidenceReference'] : [])];
    if (!input.object(d, keys)) input.fail(400, 'Use only the existing rate review fields.');
    out = { [field]: amount(d[field], input), reason: input.text(d.reason, 1000, true) };
    if (op.kind === 'reportRate') out.evidenceReference = Object.hasOwn(d, 'evidenceReference') ? input.text(d.evidenceReference, 1000) : '';
  }
  return { kind: op.kind, method: op.method, path: op.path, details: out };
}
function authorizeActor(auth, op, input = defaults()) {
  const roles = ['reportRate', 'projectRateSettings'].includes(op.kind) ? ['owner', 'admin'] : op.kind === 'reportSafety' ? ['owner', 'admin', 'project_manager', 'foreman', 'field'] : ['owner', 'admin', 'project_manager'];
  if (!auth?.user || auth.user.status !== 'Active' || !roles.includes(auth.user.role)) input.fail(403, 'Current inherited report or financial permission required.');
}
function rows(db, name, input) {
  const value = db[name] === undefined ? [] : db[name];
  if (!Array.isArray(value) || value.length > 50000 || value.some(row => !row || typeof row !== 'object' || Array.isArray(row) || !input.id(row.id) || row.companyId != null && row.companyId !== db.company.id) || new Set(value.map(row => row.id)).size !== value.length) reconcile(input);
  return value;
}
function select(db, name, id, input) {
  const row = rows(db, name, input).find(row => row.id === id);
  if (!row) input.fail(404, name === 'reports' ? 'Report not found.' : 'Project not found.');
  return row;
}
function array(row, name, input, limit = 10000) {
  const value = row[name] === undefined ? [] : row[name];
  if (!Array.isArray(value) || value.length > limit || value.some(value => !value || typeof value !== 'object' || Array.isArray(value))) reconcile(input);
  return value;
}
function sourceReport(db, report, input) {
  if (!Number.isSafeInteger(report.project) || report.project < 0 || !db.projects?.[report.project] || !['Draft', 'Needs review', 'Missing data', 'Approved'].includes(report.status)) reconcile(input);
  select(db, 'projects', db.projects[report.project].id, input); rows(db, 'team', input);
  const entries = array(report, 'laborEntries', input, 100);
  if (new Set(entries.map(row => Number(row.memberId))).size !== entries.length || entries.some(row => !input.id(Number(row.memberId)) || !db.team.some(member => Number(member.id) === Number(row.memberId)) || rates.amount(row.hours) === null || Number(row.hours) > 24)) reconcile(input);
  array(report, 'productionEntries', input, 100); array(report, 'history', input); array(report, 'flags', input, 100);
  array(report, 'laborExclusions', input, 100);
  // No private cached row can become scope evidence for a different tenant.
  for (const name of ['history', 'flags', 'productionEntries', 'laborEntries']) if ((report[name] || []).some(row => row.companyId != null && row.companyId !== db.company.id)) reconcile(input);
  return report;
}
function laborSources(db, report, user, input) {
  const refs = array(report, 'laborExclusions', input, 100), members = new Set();
  for (const ref of refs) {
    if (!input.id(Number(ref.memberId)) || !input.id(Number(ref.sourceReportId)) || rates.amount(ref.hours) === null || Number(ref.hours) <= 0 || Number(ref.hours) > 24 || members.has(Number(ref.memberId))) reconcile(input);
    members.add(Number(ref.memberId)); const other = sourceReport(db, select(db, 'reports', Number(ref.sourceReportId), input), input);
    const target = (report.laborEntries || []).find(row => Number(row.memberId) === Number(ref.memberId)), source = (other.laborEntries || []).find(row => Number(row.memberId) === Number(ref.memberId));
    if (!target || !source || other.id === report.id || other.project !== report.project || !report.dateIso || other.dateIso !== report.dateIso || other.deletedAt || (other.laborExclusions || []).some(row => Number(row.memberId) === Number(ref.memberId)) || report.status === 'Approved' && other.status !== 'Approved' || Number(ref.hours) > Number(target.hours) || Number(ref.hours) > Number(source.hours)) reconcile(input);
    if (!daily.reportInScope(db, user, other, 'viewReports') || !daily.memberAllowed(db, user, ref.memberId)) input.fail(403, 'Referenced daily and member must remain within current scope.');
  }
}
function affectedReferences(db, report, user, input) {
  const projectId = db.projects[report.project].id;
  const days = rows(db, 'workdays', input).filter(row => row.reportId === report.id);
  for (const day of days) {
    if (Number(day.projectId) !== projectId || !Array.isArray(day.memberIds) || !day.memberIds.length || day.memberIds.some(id => !input.id(Number(id))) || new Set(day.memberIds.map(Number)).size !== day.memberIds.length) reconcile(input);
    if (!daily.workdayInScope(db, user, day, 'viewWorkdays') || !day.memberIds.every(id => daily.memberAllowed(db, user, id))) input.fail(403, 'Affected workday and its entire crew must remain within current scope.');
  }
  const photos = rows(db, 'photos', input).filter(row => row.reportId === report.id);
  for (const photo of photos) {
    if (photo.project != null && photo.project !== report.project || photo.projectId != null && Number(photo.projectId) !== projectId) reconcile(input);
    if (photo.workdayId != null) {
      const day = select(db, 'workdays', Number(photo.workdayId), input);
      if (Number(day.projectId) !== projectId) reconcile(input);
      if (!daily.workdayInScope(db, user, day, 'viewWorkdays') || !day.memberIds.every(id => daily.memberAllowed(db, user, id))) input.fail(403, 'Affected photo workday and crew must remain within current scope.');
    }
  }
  // The original delete handler cannot repair these retained references. Deny
  // instead of silently deleting evidence or orphaning a dependent daily/ticket.
  if (rows(db, 'reports', input).some(row => row.id !== report.id && array(row, 'laborExclusions', input, 100).some(ref => Number(ref.sourceReportId) === report.id)) || rows(db, 'projectTickets', input).some(row => Number(row.reportId) === report.id)) input.fail(409, 'This daily is still referenced by retained labor or ticket evidence.');
  return { days, photos };
}
function pricing(db, user, h, input) { if (typeof h.canViewPricing !== 'function' || !h.canViewPricing(db, user)) input.fail(403, 'Existing financial visibility is required.'); }
function authorize(db, auth, op, h, input = defaults()) {
  authorizeActor(auth, op, input); const user = auth.user;
  if (auth.companyId != null && auth.companyId !== db.company.id || user.companyId != null && user.companyId !== db.company.id) input.fail(403, 'Current company permission required.');
  if (op.kind === 'projectRateSettings') {
    const project = select(db, 'projects', Number(op.path.split('/')[3]), input);
    pricing(db, user, h, input); if (!rates.applicable(project)) input.fail(404, 'T&M or hybrid project not found.');
    array(project, 'rateSettingsHistory', input); return;
  }
  const report = sourceReport(db, select(db, 'reports', Number(op.path.split('/')[3]), input), input), gates = daily.access(db, user);
  if (!gates.editReports || !gates.viewReports) input.fail(403, 'Current daily view and edit permission required.');
  if (!daily.reportInScope(db, user, report, 'editReports') || !daily.reportInScope(db, user, report, 'viewReports')) input.fail(404, 'Report not found.');
  if (report.status === 'Approved' && !gates.approveReports) input.fail(403, 'Current approval permission required to change approved work.');
  laborSources(db, report, user, input);
  if (op.kind === 'reportDisposition') {
    if (!array(report, 'flags', input, 100).some(flag => !flag.resolution)) input.fail(400, 'This report has no unresolved exceptions.');
    rows(db, 'changes', input);
  }
  if (op.kind === 'reportRemove') affectedReferences(db, report, user, input);
  if (op.kind === 'reportRate') {
    pricing(db, user, h, input);
    if (!rates.applicable(db.projects[report.project]) || !rates.approvedBefore(report)) input.fail(409, 'Rate review requires previously approved T&M or hybrid work.');
    if (!gates.approveReports) input.fail(403, 'Current approval permission required to change a historically approved rate.');
    if (!rates.validSnapshot(report.rateSnapshot) && !op.details.evidenceReference) input.fail(400, 'Missing historical rates require an evidence reference.');
    array(report, 'rateHistory', input);
  }
}
function appended(before, after, name, input) {
  const old = before[name] || [], current = after[name];
  if (!Array.isArray(current) || current.length !== old.length + 1 || !equal(current.slice(0, -1), old)) reconcile(input);
  return current.at(-1);
}
function freshUuid(value, previous, input) { if (!uuid(value) || (previous || []).some(row => row.id === value)) reconcile(input); }
function reportDTO(db, user, report, h, input) {
  if (typeof h.presentReport !== 'function') input.fail(503, 'Current report projection helper required.');
  const result = require('./daily-admission').reportProjection(db, user, report, h.presentReport);
  // Preserve every existing supported safety field using the same finite DTO.
  Object.assign(result, dto.pick(report, [...Object.keys(reportSafetyText), 'noSafetyObservations']));
  result.safetyItems = (report.safetyItems || []).map(row => dto.pick(row, [...Object.keys(safetyText), 'dueDate', 'status']));
  return result;
}
function changeDTO(row, pricing) { return { ...dto.pick(row, ['id', 'projectId', 'reportId', 'number', 'title', 'status', 'createdAt']), ...(pricing ? dto.pick(row, ['amount']) : {}), history: (row.history || []).map(row => dto.pick(row, ['action', 'by', 'at'])) }; }
function projectRateDTO(row) { return { id: row.id, tmSettings: dto.pick(row.tmSettings, ['defaultLaborRate', 'materialMarkup', 'equipmentMarkup']), rateSettingsHistory: (row.rateSettingsHistory || []).map(entry => ({ ...dto.pick(entry, ['previous', 'laborRate', 'reason', 'at']), actor: dto.pick(entry.actor, ['id', 'name', 'role']) })) }; }
function validateSafetyConsequence(before, after, op, auth, h, input = defaults()) {
  // The compound daily caller owns create/edit/approve authority. A newly
  // created report must not require the separate editReports action merely
  // because its existing superintendent handler runs second on the same clone.
  if (op.kind !== 'reportSafety' || !equal(parse(op, input), op)) reconcile(input);
  const id = Number(op.path.split('/')[3]), old = sourceReport(before, select(before, 'reports', id, input), input), current = sourceReport(after, select(after, 'reports', id, input), input);
  const history = appended(old, current, 'history', input), at = history.at;
  const expected = { ...old, ...op.details, history: [...(old.history || []), history] };
  if (!iso(at) || !equal(history, { action: 'Safety follow-up updated', by: auth.user.name || 'Office user', at }) || !equal(current, expected) || !equal(after.reports, before.reports.map(row => row.id === id ? current : row)) || !equal(omit(before, ['reports']), omit(after, ['reports']))) reconcile(input);
  return { data: reportDTO(after, auth.user, current, h, input), retained: { report: structuredClone(old) } };
}
function validate(before, after, op, auth, h, input = defaults()) {
  authorize(before, auth, op, h, input); const id = Number(op.path.split('/')[3]), user = auth.user, d = op.details;
  if (op.kind === 'reportSafety') return validateSafetyConsequence(before, after, op, auth, h, input);
  let allowed, data, retained;
  if (op.kind === 'projectRateSettings') {
    const old = select(before, 'projects', id, input), current = select(after, 'projects', id, input), entry = appended(old, current, 'rateSettingsHistory', input), audit = appended(before, after, 'auditLog', input), at = entry.at;
    freshUuid(audit.id, before.auditLog, input);
    if (!iso(at) || !uuid(audit.id) || !equal(entry, { previous: old.tmSettings?.defaultLaborRate ?? null, laborRate: d.defaultLaborRate, reason: d.reason, actor: { id: user.id, name: user.name, role: user.role }, at }) || !equal(current, { ...old, tmSettings: { ...(old.tmSettings || {}), defaultLaborRate: d.defaultLaborRate }, rateSettingsHistory: [...(old.rateSettingsHistory || []), entry] }) || !equal(after.projects, before.projects.map(row => row.id === id ? current : row)) || !equal(omit(audit, ['id']), { type: 'project_default_rate_changed', projectId: id, actor: user.name, at, detail: 'Default labor rate changed for future approvals; reason retained in financial history' })) reconcile(input);
    allowed = ['projects', 'auditLog']; data = projectRateDTO(current); retained = { project: structuredClone(old) };
  } else {
    const old = select(before, 'reports', id, input), project = before.projects[old.project]; retained = { report: structuredClone(old) };
    if (op.kind === 'reportRemove') {
      const refs = affectedReferences(before, old, user, input), audit = appended(before, after, 'auditLog', input), at = audit.at;
      freshUuid(audit.id, before.auditLog, input);
      if (!iso(at) || !uuid(audit.id) || !equal(after.reports, before.reports.filter(row => row.id !== id)) || !equal(after.workdays || [], (before.workdays || []).map(row => row.reportId === id ? { ...row, reportId: null } : row)) || !equal(after.photos || [], (before.photos || []).map(row => row.reportId === id ? { ...row, reportId: null } : row)) || !equal(omit(audit, ['id']), { type: 'daily_deleted', reportId: id, projectId: project.id, projectName: project.name || 'Project', reportDate: old.dateIso || old.date, previousStatus: old.status, foreman: old.foreman, laborHours: (old.laborEntries || []).reduce((sum, row) => sum + Number(row.hours || 0), 0), actor: user.name || 'Office user', reason: d.reason, at })) reconcile(input);
      retained.workdays = structuredClone(refs.days); retained.photos = structuredClone(refs.photos);
      allowed = ['reports', 'workdays', 'photos', 'auditLog']; data = { ok: true, id };
    } else {
      const current = sourceReport(after, select(after, 'reports', id, input), input), expected = structuredClone(old);
      if (!equal(after.reports, before.reports.map(row => row.id === id ? current : row))) reconcile(input);
      const history = appended(old, current, 'history', input), at = history.at; if (!iso(at)) reconcile(input);
      expected.history = [...(old.history || []), history]; allowed = ['reports'];
      if (op.kind === 'reportDisposition') {
        for (const flag of expected.flags) if (!flag.resolution) Object.assign(flag, { resolution: d.resolution, resolutionNote: d.note, resolvedBy: 'Office', resolvedAt: at });
        const summary = String(expected.summary || '').replace(/\s*Unplanned work needs an office decision\.?/gi, '').trim(); if (summary !== String(expected.summary || '')) expected.summary = summary;
        if (!equal(history, { action: 'Exception resolved: ' + d.resolution.replace('_', ' '), by: 'Office', at })) reconcile(input);
        let change = null;
        if (['tm', 'potential_change'].includes(d.resolution)) {
          allowed.push('changes'); change = appended(before, after, 'changes', input); const oldChanges = before.changes || [], changeId = Math.max(0, ...oldChanges.map(row => Number(row.id) || 0)) + 1;
          if (!input.id(changeId) || !equal(change, { id: changeId, projectId: project.id, reportId: id, number: (d.resolution === 'tm' ? 'TM' : 'PC') + '-' + String(oldChanges.filter(row => row.projectId === project.id).length + 1).padStart(3, '0'), title: d.note || (old.productionEntries || []).filter(row => !row.estimateItemId).map(row => row.description).join(', ') || 'Unplanned field work', status: d.resolution === 'tm' ? 'T&M' : 'Potential', amount: 0, createdAt: at, history: [{ action: 'Created from daily exception as ' + (d.resolution === 'tm' ? 'T&M' : 'potential change'), by: 'Office', at }] })) reconcile(input);
        }
        data = { report: reportDTO(after, user, current, h, input), change: change ? changeDTO(change, h.canViewPricing(after, user)) : null };
        if (change) retained.createdChangeId = change.id;
      } else if (op.kind === 'reportRate') {
        allowed.push('auditLog'); const entry = appended(old, current, 'rateHistory', input), audit = appended(before, after, 'auditLog', input);
        freshUuid(entry.id, old.rateHistory, input); freshUuid(audit.id, before.auditLog, input);
        // The actual production rate helper defines captured/legacy snapshots.
        rates.reviewRate(expected, project, d, user, at); expected.rateHistory.at(-1).id = entry.id;
        if (!uuid(entry.id) || !uuid(audit.id) || !equal(history, { action: 'Billable rate reviewed', by: user.name, actorId: user.id, at }) || !equal(omit(audit, ['id']), { type: 'report_rate_reviewed', reportId: id, projectId: project.id, actor: user.name, at, detail: 'Billable rate reviewed; reason and evidence retained in financial rate history' })) reconcile(input);
        data = reportDTO(after, user, current, h, input);
      } else reconcile(input);
      if (!equal(current, expected)) reconcile(input);
    }
  }
  if (!equal(omit(before, allowed), omit(after, allowed))) reconcile(input);
  return { data, retained };
}
function currentResult(db, auth, receipt, first, h, input = defaults()) {
  const op = receipt.operation; authorizeActor(auth, op, input);
  if (auth.companyId != null && auth.companyId !== db.company.id || auth.user.companyId != null && auth.user.companyId !== db.company.id) input.fail(403, 'Current company permission required.');
  const id = Number(op.path.split('/')[3]), technical = { id, receiptId: receipt.id };
  if (op.kind === 'reportRemove') return { ok: true, ...technical };
  const name = op.kind === 'projectRateSettings' ? 'projects' : 'reports', current = rows(db, name, input).find(row => row.id === id), old = receipt.retained?.[name === 'projects' ? 'project' : 'report'];
  // These numeric IDs have no mandatory immutable lifecycle key. Replay
  // acknowledges custody only and tells the caller to reload authorized views.
  if (!first || !current || !old) return technical;
  if (op.kind === 'projectRateSettings') {
    if (!equal(omit(current, ['tmSettings', 'rateSettingsHistory']), omit(old, ['tmSettings', 'rateSettingsHistory'])) || !rates.applicable(current) || typeof h.canViewPricing !== 'function' || !h.canViewPricing(db, auth.user)) return technical;
    return { ...projectRateDTO(current), receiptId: receipt.id };
  }
  const excluded = { reportSafety: ['history', 'reportType', 'safetyItems', ...Object.keys(reportSafetyText), 'noSafetyObservations'], reportDisposition: ['history', 'flags', 'summary'], reportRate: ['history', 'rateSnapshot', 'rateReview', 'rateHistory'] }[op.kind];
  if (!excluded || !equal(omit(current, excluded), omit(old, excluded)) || !daily.reportInScope(db, auth.user, current, 'viewReports') || op.kind === 'reportRate' && !h.canViewPricing(db, auth.user)) return technical;
  sourceReport(db, current, input); laborSources(db, current, auth.user, input);
  return op.kind === 'reportDisposition' ? { report: reportDTO(db, auth.user, current, h, input), change: null, receiptId: receipt.id } : { ...reportDTO(db, auth.user, current, h, input), receiptId: receipt.id };
}
module.exports = { route, parse, authorizeActor, authorize, validate, currentResult, safetyFields, validateSafetyConsequence };
