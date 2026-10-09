'use strict';
// Finite public DTOs over actual existing workspace scope. These definitions
// are projections, not configurable permissions or an alternate grant store.
const registry = require('./capability-registry');
const daily = require('./daily-access'), scheduling = require('./scheduling-access'), timeReview = require('./time-review-access');
const { publicPreferences } = require('./account-evidence');
const fail = () => { throw Object.assign(Error('Workspace records need reconciliation.'), { statusCode: 409 }); };
const scalar = value => value === null || ['string', 'boolean'].includes(typeof value) || typeof value === 'number' && Number.isFinite(value);
function pick(row, names) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) fail();
  return Object.fromEntries(names.filter(key => Object.hasOwn(row, key)).map(key => { if (!scalar(row[key])) fail(); return [key, row[key]]; }));
}
function list(value, project) { if (value === undefined) return []; if (!Array.isArray(value)) fail(); return value.map(project); }
function numbers(value) { return list(value, id => { if (!Number.isSafeInteger(id) || id < 1) fail(); return id; }); }
function texts(value) { return list(value, text => { if (typeof text !== 'string') fail(); return text; }); }
const history = value => list(value, row => pick(row, ['action', 'by', 'actorId', 'at', 'reason', 'note', 'detail', 'previous']));
function account(row, own = false) {
  const dto = pick(row, ['id', 'companyId', 'memberId', 'name', 'email', 'emailVerifiedAt', 'role', 'status', 'preferredLanguage', 'createdAt', 'updatedAt', 'mustSetPassword']);
  dto.projectIds = numbers(row.projectIds); dto.assignedCrews = texts(row.assignedCrews);
  dto.permissions = pick(row.permissions || {}, ['scheduleCrews', 'viewTime', 'manageTime', 'viewDailies', 'approveDailies']);
  if (own) dto.preferences = publicPreferences(row);
  return dto;
}
function company(row, pricing) {
  const dto = pick(row, ['id', 'name', 'trade', 'address', 'demo', 'email', 'phone', 'timezone', 'weekStart', 'overtimeRule', 'plan', 'subscriptionStatus', 'trialEndsAt', 'billingExempt', 'accountType', 'contractValueTracking', 'defaultTemplateId', 'emailVerificationRequiredAt']);
  dto.features = pick(row.features || {}, ['timeCards', 'templates']);
  if (row.logo) dto.logo = pick(row.logo, ['url', 'contentType', 'updatedAt']);
  if (pricing) {
    Object.assign(dto, pick(row, ['planPrice', 'discountPercent', 'commercialNote']));
    if (row.pricingAccess) dto.pricingAccess = { ...pick(row.pricingAccess, ['enabled', 'officeMode']), userIds: numbers(row.pricingAccess.userIds) };
  }
  return dto;
}
const team = row => pick(row, ['id', 'userId', 'name', 'role', 'crew', 'initials', 'email', 'phone', 'hours', 'site', 'status', 'archivedAt', 'startDate', 'trade']);
const customer = row => pick(row, ['id', 'name', 'contact', 'email', 'phone', 'address', 'status', 'notes']);
function project(row, pricing) {
  const dto = pick(row, ['id', 'name', 'code', 'site', 'address', 'siteContact', 'supervisor', 'color', 'crew', 'status', 'customer', 'customerId', 'contractType', 'progress', 'production', 'startDate', 'endDate', 'archived', 'archivedAt', 'templateId', 'templateVersion', 'notes', 'workType']);
  dto.templateIds = texts(row.templateIds);
  dto.estimateItems = list(row.estimateItems, item => ({ ...pick(item, ['id', 'name', 'description', 'unit', 'plannedQuantity', 'budgetHours', 'source', 'sourceProposalId']), ...(pricing ? pick(item, ['cost']) : {}) }));
  if (pricing) { Object.assign(dto, pick(row, ['budget', 'contractValue'])); if (row.tmSettings) dto.tmSettings = pick(row.tmSettings, ['defaultLaborRate', 'materialMarkup', 'equipmentMarkup']); }
  return dto;
}
function assignment(row) {
  const dto = pick(row, ['id', 'projectId', 'crew', 'date', 'start', 'end', 'activity', 'createdBy', 'createdAt', 'updatedAt', 'notes', 'instructions']);
  dto.memberIds = numbers(row.memberIds);
  function memberMap(value, fields) { if (value === undefined) return {}; if (!value || typeof value !== 'object' || Array.isArray(value)) fail(); return Object.fromEntries(Object.entries(value).filter(([id]) => dto.memberIds.map(String).includes(id)).map(([id, entry]) => [id, pick(entry, fields)])); }
  dto.acknowledgements = memberMap(row.acknowledgements, ['memberId', 'status', 'at', 'acknowledgedAt', 'by', 'userId']);
  dto.notifications = memberMap(row.notifications, ['inAppAt', 'emailStatus', 'emailSentAt']);
  return dto;
}
function report(row, pricing) {
  const dto = pick(row, ['id', 'project', 'date', 'dateIso', 'foreman', 'crew', 'sourceAssignmentId', 'status', 'notes', 'originalNotes', 'noteLanguage', 'englishTranslation', 'summary', 'labor', 'quantity', 'issue', 'next', 'weather', 'temperature', 'materials', 'equipment', 'delays', 'safety', 'signature', 'source', 'subcontractorId', 'reportType', 'workdayId', 'templateId', 'templateVersion', 'createdAt', 'updatedAt']);
  dto.productionEntries = list(row.productionEntries, entry => pick(entry, ['estimateItemId', 'catalogItemId', 'description', 'unit', 'quantity', 'laborHours', 'custom', 'scopeEvidence', 'scopeUnverified', 'scopeChoice', 'needsScopeConfirmation', 'needsLaborConfirmation', 'potentialExtraWork']));
  dto.workSuggestions = list(row.workSuggestions, entry => pick(entry, ['estimateItemId', 'catalogItemId', 'description', 'workDescription', 'unit', 'quantity', 'laborHours', 'quantityPending', 'laborHoursPending', 'custom', 'scopeEvidence', 'scopeUnverified', 'scopeChoice', 'needsScopeConfirmation', 'needsLaborConfirmation', 'potentialExtraWork']));
  dto.laborEntries = list(row.laborEntries, entry => pick(entry, ['memberId', 'hours', 'crew']));
  dto.history = history(row.history);
  dto.flags = list(row.flags, flag => { const out = pick(flag, ['id', 'type', 'message', 'status', 'severity', 'resolutionNote', 'resolvedBy', 'resolvedAt']); if (flag.resolution) out.resolution = typeof flag.resolution === 'string' ? flag.resolution : pick(flag.resolution, ['decision', 'note', 'by', 'at', 'estimateItemId', 'changeId']); return out; });
  dto.ticketIds = numbers(row.ticketIds);
  if (row.guestTime) dto.guestTime = pick(row.guestTime, ['startedAt', 'endedAt', 'crewCount', 'hoursPerPerson']);
  dto.safetyItems = list(row.safetyItems, item => pick(item, ['company', 'observation', 'action', 'dueDate', 'status', 'verifiedBy', 'verifiedAt']));
  if (row.safetyIncident) dto.safetyIncident = scalar(row.safetyIncident) ? row.safetyIncident : pick(row.safetyIncident, ['type', 'description', 'company', 'injury', 'medical', 'reviewStatus', 'reviewedBy', 'reviewedAt']);
  // Template values are bounded primitives bound to declared field IDs.
  if (row.customFields) { if (typeof row.customFields !== 'object' || Array.isArray(row.customFields) || Object.keys(row.customFields).length > 40) fail(); dto.customFields = Object.fromEntries(Object.entries(row.customFields).map(([id, value]) => { if (!/^[a-z0-9-]{1,40}$/.test(id) || !scalar(value)) fail(); return [id, value]; })); }
  if (pricing && row.rateSnapshot) {
    const rate = value => value ? { ...pick(value, ['schemaVersion', 'laborRate', 'materialMarkup', 'equipmentMarkup', 'source', 'capturedAt']), ...(value.capturedBy ? { capturedBy: pick(value.capturedBy, ['id', 'name', 'role']) } : {}) } : null;
    dto.rateSnapshot = rate(row.rateSnapshot);
    dto.rateHistory = list(row.rateHistory, entry => ({ ...pick(entry, ['id', 'at', 'reason', 'evidenceReference']), previous: rate(entry.previous), next: rate(entry.next), actor: pick(entry.actor || {}, ['id', 'name', 'role']) }));
    if (row.rateReview) dto.rateReview = pick(row.rateReview, ['status', 'reason', 'reviewedAt', 'reviewedBy']);
  }
  return dto;
}
function workday(row) { const dto = pick(row, ['id', 'projectId', 'assignmentId', 'activity', 'date', 'status', 'startAt', 'endAt', 'startedAt', 'endedAt', 'startNote', 'endNote', 'endNotes', 'notes', 'reportId', 'createdBy', 'startedBy', 'endedBy']); dto.memberIds = numbers(row.memberIds); dto.history = history(row.history); return dto; }
const photo = row => ({...pick(row, ['id', 'project', 'projectId', 'reportId', 'workdayId', 'source', 'phase', 'caption', 'uploader', 'uploadedByUserId', 'createdAt', 'capturedAt', 'url']),...(Object.hasOwn(row,'tags')?{tags:texts(row.tags)}:{})});
const plan = row => pick(row, ['id', 'projectId', 'name', 'filename', 'contentType', 'type', 'size', 'note', 'createdAt', 'uploadedAt', 'uploadedBy', 'url']);
function ticket(row, pricing) { const dto = pick(row, ['id', 'projectId', 'reportId', 'subcontractorId', 'source', 'vendor', 'ticketNumber', 'ticketDate', 'material', 'quantity', 'unit', 'status', 'confidence', 'confirmedBy', 'confirmedAt', 'createdAt', 'updatedAt', 'filename', 'contentType', 'url']); if (pricing) Object.assign(dto, pick(row, ['amount'])); dto.lines = list(row.lines, line => ({ ...pick(line, ['material', 'description', 'quantity', 'unit']), ...(pricing ? pick(line, ['amount']) : {}) })); dto.history = history(row.history); return dto; }
const subcontractor = row => ({ ...pick(row, ['id', 'name', 'trade', 'contact', 'email', 'phone', 'notes', 'status', 'archived', 'archivedAt', 'insuranceExpiration', 'workersCompExpiration', 'licenseNumber', 'licenseExpiration', 'w9Received', 'agreementSigned', 'autoComplianceReminders', 'lastComplianceReminderAt']), projectIds: numbers(row.projectIds) });
const link = row => pick(row, ['id', 'projectId', 'subcontractorId', 'mode', 'status', 'expiresAt', 'createdAt', 'createdBy']);
function template(row) {
  const dto = pick(row, ['id', 'name', 'category', 'description', 'locked', 'reviewNotice']);
  dto.requirements = pick(row.requirements || {}, ['photo', 'signature', 'acknowledgement']);
  dto.assignment = { crewNames: texts(row.assignment?.crewNames), workTypes: texts(row.assignment?.workTypes) };
  dto.versions = list(row.versions, version => ({ ...pick(version, ['version', 'name', 'createdAt', 'createdBy']), fields: list(version.fields, field => { const out = pick(field, ['id', 'label', 'type', 'required', 'help']); if (field.options) out.options = texts(field.options); if (field.showWhen) out.showWhen = pick(field.showWhen, ['fieldId', 'value']); return out; }) }));
  return dto;
}
const audit = row => pick(row, ['id', 'type', 'actor', 'actorId', 'at', 'detail', 'reason', 'projectId', 'projectName', 'reportId', 'reportDate', 'memberId', 'userId', 'decision', 'action']);
function billing(row){return {...pick(row,['plan','planName','price','annualPrice','billingCycle','status','trialEndsAt','daysRemaining','nextBillingAt','configured','hasSubscription','hasBillingCustomer','locked','lockReason','demo','accountType','billingExempt','cohort','discountPercent']),founder:row.founder?pick(row.founder,['protectedUntil','assistedSetup','plan','billingCycle']):null,usage:pick(row.usage,['users','activeProjects']),limits:pick(row.limits,['users','activeProjects']),plans:list(row.plans,value=>pick(value,['id','name','price','annualPrice','maxUsers','maxProjects','available','annualAvailable']))};}
function auditRows(db, user, helpers) {
  if (!['owner','admin'].includes(user.role)) return [];
  const gates = registry.effective(db, user), pricing = helpers.canViewPricing(db, user);
  return list(db.auditLog, row => row).filter(row => {
    if(user.role==='owner')return true;
    const type = String(row.type || '');
    if (/^(?:account_|user_|role_|policy_|workspace_reconciled$)/.test(type)) return true;
    if (/^(?:daily_|report_|labor_|workday_)/.test(type)) return gates.daily.viewReports && (row.projectId == null || daily.projectAllowed(db, user, row.projectId)) && (row.reportId == null || !(db.reports || []).some(report => Number(report.id) === Number(row.reportId)) || daily.reportInScope(db, user, (db.reports || []).find(report => Number(report.id) === Number(row.reportId))));
    if (/^(?:time_|pay_period_|payroll_)/.test(type)) return gates.timeReview.viewCards && (row.memberId == null || timeReview.cardInScope(db, user, {memberId:row.memberId,projectId:row.projectId}));
    if (/^(?:schedule_|assignment_)/.test(type)) return gates.scheduling.view;
    if (/(?:rate|cost|price|billing|invoice|proposal|contract)/.test(type)) return pricing;
    // Unknown legacy business details cannot become a side channel around a
    // typed view restriction. Owner's immutable full access remains intact.
    return gates.daily.viewReports && (db.company.features?.timeCards!==true || gates.timeReview.viewCards) && gates.scheduling.view && pricing;
  }).map(audit);
}
function scoped(db, user, helpers) {
  const base = helpers.workspace(db, user), sourceIndexes = new Map((db.projects || []).map((row, index) => [Number(row.id), index]));
  const original = new Map(base.projects.map((row, index) => [index, sourceIndexes.get(Number(row.id))]));
  const visibleReports = new Set((db.reports || []).filter(row => daily.reportInScope(db, user, row)).map(row => row.id));
  base.reports = base.reports.filter(row => visibleReports.has(row.id));
  base.workdays = (base.workdays || []).filter(row => daily.workdayInScope(db, user, row));
  const assignmentIds = new Set((base.assignments || []).map(row => Number(row.id)));
  base.assignments = scheduling.visibleAssignments(db, user).filter(row => assignmentIds.has(Number(row.id)) && base.projects.some(p => p.id === row.projectId)).map(row=>({...db.assignments.find(source=>Number(source.id)===Number(row.id)),...row}));
  base.timeCards = (base.timeCards || []).filter(row => timeReview.cardInScope(db, user, row));
  const visibleDays = new Set(base.workdays.map(row => row.id));
  base.photos = (base.photos || []).filter(row => (!row.reportId || visibleReports.has(row.reportId)) && (!row.workdayId || visibleDays.has(row.workdayId)));
  // Metrics use the same filtered source records and the same remapped indexes.
  const gates=registry.effective(db,user),metricProjects=base.projects.map(row=>{const value={...row};if(!gates.daily.viewReports){delete value.progress;delete value.production;}return value;});
  const metrics = { ...db, projects: metricProjects, reports: base.reports, assignments: base.assignments, workdays: base.workdays, timeCards: base.timeCards, team: base.team, subcontractors: base.subcontractors || [] };
  return { base, metrics, original };
}
function bootstrap(db, user, helpers) {
  const { base } = scoped(db, user, helpers), pricing = helpers.canViewPricing(db, user), gates = registry.effective(db, user);
  const actor = { ...account(user, true), ...Object.fromEntries(registry.families.map(([id, , , field]) => [field, gates[id]])), effectiveCapabilities: gates };
  const projectedProjects=base.projects.map(row=>{const result=project(row,pricing);if(!gates.daily.viewReports){delete result.progress;delete result.production;}return result;}),projectedTeam=base.team.map(row=>{const result=team(row);if(!gates.timeReview.viewCards)delete result.hours;return result;});
  return { company: company(base.company, pricing), currentUser: actor, projects: projectedProjects, team: projectedTeam, customers: list(base.customers, customer), assignments: base.assignments.map(assignment), reports: base.reports.map(row => report(row, pricing)), workdays: base.workdays.map(workday), photos: list(base.photos, photo), projectTickets: list(base.projectTickets, row => ticket(row, pricing)), projectPlans: list(base.projectPlans, plan), subcontractors: list(base.subcontractors, subcontractor), subcontractorLinks: list(base.subcontractorLinks, link), users: ['owner', 'admin'].includes(user.role) ? list(base.users, row => account(row)) : [], auditLog: auditRows(db, user, helpers), ...(db.company.features?.templates === true ? { dailyTemplates: list(base.dailyTemplates, template) } : {}), scheduleAvailability: scheduling.access(db, user).view ? list(base.scheduleAvailability, row => pick(row, ['memberId', 'date', 'start', 'end', 'allDay', 'busy'])) : [] };
}
module.exports = { pick, list, history, account, company, team, customer, project, assignment, report, workday, photo, plan, ticket, subcontractor, link, template, audit, auditRows, billing, scoped, bootstrap };
