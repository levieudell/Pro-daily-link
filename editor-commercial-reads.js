'use strict';
// Existing T&M summary admission and projection, not a new commercial grant.
// The caller supplies the unchanged server pricing check and owns session,
// account locks and the authoritative revision/current-return fence.
const daily = require('./daily-access');
const reportRates = require('./report-rate-policy');
const { identities } = require('./compat-workspace-evidence');

const fail = (statusCode, message) => { throw Object.assign(Error(message), { statusCode }); };
const invalid = () => fail(409, 'T&M source records need reconciliation.');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const id = value => ['number', 'string'].includes(typeof value) && /^[1-9]\d*$/.test(String(value)) && Number.isSafeInteger(Number(value));
const crewKey = value => String(value).trim().toLowerCase();
function numeric(value, optional = false) {
  if (optional && value === undefined) return 0;
  if (!['number', 'string'].includes(typeof value) || String(value).trim() === '' || !Number.isFinite(Number(value)) || Number(value) < 0 || Number(value) > Number.MAX_SAFE_INTEGER) invalid();
  return Number(value);
}
function numberList(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some(row => !id(row)) || new Set(value.map(Number)).size !== value.length) invalid();
  return value.map(Number);
}
function crewList(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some(row => typeof row !== 'string' || !row.trim())) invalid();
  return value.map(crewKey);
}
function currentActor(db, user) {
  if (!object(db) || !object(db.company) || !db.company.id || !Array.isArray(db.users)) invalid();
  if (!object(user) || !id(user.id) || user.status !== 'Active') fail(403, 'A current company account is required.');
  if (user.companyId !== undefined && user.companyId !== db.company.id) fail(404, 'Project not found');
  const accounts = identities(db, 'users'), stored = accounts.get(String(Number(user.id)));
  const normalize = role => role === 'office' ? 'admin' : role;
  if (!stored || stored.status !== 'Active' || normalize(stored.role) !== normalize(user.role)) fail(403, 'A current company account is required.');
  if (!['owner', 'admin', 'project_manager'].includes(normalize(user.role))) fail(403, 'Pricing permission required');
  // Keep a restrictive assembled actor restrictive. Fresh stored grants alone
  // cannot reinstate a permission revoked in the request actor or its scope.
  const actor = { ...stored, role: normalize(stored.role) };
  if (actor.role === 'project_manager') {
    for (const row of [stored, user]) if (row.permissions !== undefined && (!object(row.permissions) || ['viewDailies', 'approveDailies'].some(key => Object.hasOwn(row.permissions, key) && typeof row.permissions[key] !== 'boolean'))) invalid();
    const projects = new Set(numberList(user.projectIds)), crews = new Set(crewList(user.assignedCrews));
    actor.projectIds = numberList(stored.projectIds).filter(value => projects.has(value));
    actor.assignedCrews = crewList(stored.assignedCrews).filter(value => crews.has(value));
    actor.permissions = { ...stored.permissions, viewDailies: stored.permissions?.viewDailies === true && user.permissions?.viewDailies === true, approveDailies: stored.permissions?.approveDailies === true && user.permissions?.approveDailies === true };
  }
  // Only the existing typed daily view control participates here. Arbitrary
  // flags such as tmSummary or pricing never constitute authority.
  for (const evidence of [user.dailyAccess, user.effectiveCapabilities?.daily]) {
    if (evidence !== undefined && (!object(evidence) || typeof evidence.viewReports !== 'boolean')) invalid();
    if (evidence?.viewReports === false && actor.role !== 'owner') fail(403, 'Daily report viewing permission required');
  }
  if (!daily.access(db, actor).viewReports || !daily.access(db, { ...user, role: normalize(user.role) }).viewReports) fail(403, 'Daily report viewing permission required');
  return actor;
}
function source(db) {
  const projects = identities(db, 'projects'), team = identities(db, 'team'), reports = identities(db, 'reports');
  for (const member of team.values()) for (const key of ['role', 'crew']) if (member[key] !== undefined && member[key] !== null && typeof member[key] !== 'string') invalid();
  for (const report of reports.values()) {
    if (!Number.isSafeInteger(report.project) || report.project < 0 || !db.projects[report.project] || typeof report.status !== 'string' || report.laborEntries !== undefined && !Array.isArray(report.laborEntries)) invalid();
    const seen = new Set();
    for (const entry of report.laborEntries || []) {
      if (!object(entry) || !id(entry.memberId) || !team.has(String(Number(entry.memberId))) || seen.has(Number(entry.memberId))) invalid();
      numeric(entry.hours, true); seen.add(Number(entry.memberId));
    }
  }
  return { projects, team, reports };
}
function exclusions(db, report, reports) {
  if (report.laborExclusions === undefined) return [];
  if (!Array.isArray(report.laborExclusions) || report.laborExclusions.length > 100) invalid();
  const seen = new Set();
  return report.laborExclusions.map(row => {
    if (!object(row) || !id(row.memberId) || !id(row.sourceReportId) || seen.has(Number(row.memberId))) invalid();
    seen.add(Number(row.memberId));
    const hours = numeric(row.hours), original = reports.get(String(Number(row.sourceReportId)));
    const targetLabor = (report.laborEntries || []).find(entry => Number(entry.memberId) === Number(row.memberId));
    const sourceLabor = (original?.laborEntries || []).find(entry => Number(entry.memberId) === Number(row.memberId));
    if (!(hours > 0 && hours <= 24) || !original || Number(original.id) === Number(report.id) || original.project !== report.project || !report.dateIso || original.dateIso !== report.dateIso || original.deletedAt || original.status !== 'Approved' || !targetLabor || !sourceLabor || hours > numeric(targetLabor.hours) || hours > numeric(sourceLabor.hours) || original.laborExclusions !== undefined && !Array.isArray(original.laborExclusions) || (original.laborExclusions || []).some(entry => Number(entry.memberId) === Number(row.memberId))) invalid();
    // summarizeRates only needs the accounting member/hours, never source IDs,
    // actor names, reasons or history from another daily.
    return { memberId: row.memberId, hours: row.hours };
  });
}
function rateSnapshot(value) {
  if (value === undefined || value === null) return undefined;
  if (!object(value)) invalid();
  if (!reportRates.validSnapshot(value)) return undefined; // Existing incomplete-rate semantics.
  numeric(value.laborRate);
  if (typeof value.capturedAt !== 'string' || !Number.isFinite(Date.parse(value.capturedAt)) || !object(value.capturedBy) || !id(value.capturedBy.id)) invalid();
  // Classification, historical labor rate and completeness are the only
  // original summarizeRates inputs. No captured actor/context enters its DTO.
  return { schemaVersion: 1, laborRate: value.laborRate, capturedAt: value.capturedAt, capturedBy: { id: value.capturedBy.id } };
}
function currentDefaults(value) {
  if (value === undefined || value === null) return {};
  if (!object(value)) invalid();
  const out = {};
  for (const key of ['defaultLaborRate', 'materialMarkup', 'equipmentMarkup']) if (Object.hasOwn(value, key)) {
    if (value[key] !== null) numeric(value[key]);
    out[key] = value[key];
  }
  return out;
}
function tmSummary(db, user, projectId, helpers) {
  if (typeof helpers?.canViewPricing !== 'function') invalid();
  const actor = currentActor(db, user);
  if (db.company.pricingAccess !== undefined) {
    const policy = db.company.pricingAccess;
    if (!object(policy) || Object.hasOwn(policy, 'enabled') && typeof policy.enabled !== 'boolean' || Object.hasOwn(policy, 'officeMode') && !['all', 'selected'].includes(policy.officeMode)) invalid();
    numberList(policy.userIds);
  }
  if (!helpers.canViewPricing(db, actor) || !helpers.canViewPricing(db, user)) fail(403, 'Pricing permission required');
  if (!id(projectId)) fail(404, 'Project not found');
  const { projects, team, reports: reportIndex } = source(db), project = projects.get(String(Number(projectId)));
  if (!project || !daily.projectAllowed(db, actor, project.id)) fail(404, 'Project not found');
  const projectIndex = db.projects.indexOf(project), projected = [];
  let materialEntries = 0, equipmentEntries = 0;
  for (const report of db.reports || []) {
    // Original authority is tested before redacting any source evidence.
    if (report.project !== projectIndex || report.status !== 'Approved' || !daily.reportInScope(db, actor, report)) continue;
    const laborEntries = (report.laborEntries || []).filter(entry => daily.memberAllowed(db, actor, entry.memberId)).map(entry => ({ memberId: entry.memberId, hours: entry.hours }));
    const visibleMembers = new Set(laborEntries.map(entry => Number(entry.memberId)));
    const laborExclusions = exclusions(db, report, reportIndex).filter(entry => visibleMembers.has(Number(entry.memberId)));
    const snapshot = rateSnapshot(report.rateSnapshot);
    const reason = ['legacy_missing_rate_snapshot', 'missing_project_rate_at_approval'].includes(report.rateReview?.reason) ? report.rateReview.reason : 'legacy_missing_rate_snapshot';
    if (report.dateIso !== undefined && report.dateIso !== null && typeof report.dateIso !== 'string') invalid();
    projected.push({ id: report.id, dateIso: report.dateIso, laborEntries, laborExclusions, ...(snapshot ? { rateSnapshot: snapshot } : {}), rateReview: { reason } });
    // Legacy strings apply to the entire report. They cannot be allocated to
    // a PM's visible crew when that original report also contains hidden labor.
    if (laborEntries.length === (report.laborEntries || []).length) {
      for (const key of ['materials', 'equipment']) if (report[key] !== undefined && report[key] !== null && typeof report[key] !== 'string') invalid();
      materialEntries += report.materials ? 1 : 0; equipmentEntries += report.equipment ? 1 : 0;
    }
  }
  const allowedTeam = [...team.values()].filter(member => daily.memberAllowed(db, actor, member.id)).map(member => ({ id: member.id, role: member.role }));
  return { projectId: project.id, ...reportRates.summarizeRates({ team: allowedTeam }, projectIndex, projected), materialEntries, equipmentEntries, currentDefaults: currentDefaults(project.tmSettings) };
}
module.exports = { tmSummary };
