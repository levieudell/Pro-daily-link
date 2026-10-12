'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const family = require('./resource-report-variants');
const input = require('./resource-inputs');
const daily = require('./daily-access');
const profiles = require('./role-profiles');
const rates = require('./report-rate-policy');
const { canonicalHash } = require('./database/transactional-repository');
const A = 'b0576860-a3d9-4bb6-aae2-b5e7186cbb71', B = 'ba19a156-1cac-4c8a-b921-6bc356df97ef';
const at = '2026-10-10T12:00:00.000Z';
let assertions = 0, actualHandlers = 0;
const rejects = (fn, status) => { assertions++; assert.throws(fn, error => error.statusCode === status); };
function auth(role = 'owner') { return { companyId: A, user: { id: role === 'owner' ? 1 : role === 'admin' ? 2 : 3, companyId: A, status: 'Active', role, name: 'Synthetic ' + role, memberId: 11, projectIds: [101], assignedCrews: ['North'], permissions: { viewDailies: true, approveDailies: true } } }; }
const h = { canViewPricing: (db, user) => ['owner', 'admin'].includes(user.role) || user.role === 'project_manager' && db.company.pricingAccess?.enabled === true, presentReport: (db, user, row) => h.canViewPricing(db, user) ? row : rates.withoutReportRates(row) };
function seed() {
  return { company: { id: A, name: 'Synthetic company', features: {}, pricingAccess: { enabled: true } }, users: [auth().user, auth('admin').user, auth('project_manager').user],
    projects: [{ id: 101, name: 'Scoped synthetic project', contractType: 'tm', tmSettings: { defaultLaborRate: 100, materialMarkup: 15, equipmentMarkup: 20 }, estimateItems: [] }, { id: 102, name: 'Foreign synthetic project', contractType: 'estimated', estimateItems: [] }],
    team: [{ id: 11, name: 'Synthetic worker', crew: 'North' }, { id: 12, name: 'Other synthetic worker', crew: 'South' }],
    reports: [{ id: 1, project: 0, status: 'Needs review', dateIso: '2026-10-10', foreman: 'Synthetic worker', crew: 'North', summary: 'Recorded work. Unplanned work needs an office decision.', laborEntries: [{ memberId: 11, hours: 8, crew: 'North' }], productionEntries: [{ description: 'Unplanned synthetic work', quantity: 2, laborHours: 8, unit: 'EA' }], flags: [{ type: 'unplanned_work', message: 'Office review required' }], history: [{ action: 'Submitted', by: 'Synthetic worker', at }] }],
    workdays: [{ id: 1, projectId: 101, memberIds: [11], reportId: 1, status: 'ended', startedAt: at, endedAt: at }], photos: [{ id: 1, project: 0, reportId: 1, workdayId: 1, filename: 'synthetic-retained.jpg', url: '/uploads/synthetic-retained.jpg', privateEvidence: 'retained bytes outside this pure test' }], assignments: [], timeCards: [], changes: [], auditLog: [{ id: '10000000-0000-4000-8000-000000000001', type: 'synthetic_original_history', at, privateNote: 'Retained historic evidence' }], projectTickets: [] };
}
const op = (kind, method, path, details) => family.parse({ kind, method, path, details }, input);
const operations = {
  disposition: op('reportDisposition', 'PATCH', '/api/reports/1/disposition', { resolution: 'potential_change', note: 'Synthetic scope decision' }),
  safety: op('reportSafety', 'PATCH', '/api/reports/1/safety', { reportType: 'superintendent', safetyItems: [{ observation: 'Synthetic guard missing', location: 'North edge', company: 'Synthetic company', notified: 'Synthetic supervisor', action: 'Synthetic barrier', owner: 'Synthetic worker', dueDate: '2026-10-11', status: 'corrected', verification: 'Synthetic review pending' }], safetyTalk: 'Synthetic discussion', safetyTalkAttendees: 'Synthetic crew', safetyInspection: 'Synthetic inspection', safetyIncident: '', noSafetyObservations: false }),
  remove: op('reportRemove', 'DELETE', '/api/reports/1', { reason: 'Duplicate synthetic daily' }),
  reportRate: op('reportRate', 'PATCH', '/api/reports/1/rate', { laborRate: '125.50', reason: 'Synthetic documented agreement', evidenceReference: 'Synthetic contract v1' }),
  projectRate: op('projectRateSettings', 'PATCH', '/api/projects/101/rate-settings', { defaultLaborRate: '150', reason: 'Synthetic future rate schedule' })
};
// Execute the exact named production handler statements against a fresh clone.
// No server process, provider, live file/database or copied customer data exists.
const serverSource = fs.readFileSync(require.resolve('./server'), 'utf8');
const lines = serverSource.split(/\r?\n/);
const single = anchor => { const selected = lines.filter(line => line.trimStart().startsWith(anchor)); assert.equal(selected.length, 1, anchor); return selected[0]; };
const block = (start, end) => { const a = serverSource.indexOf(start), b = serverSource.indexOf(end, a + start.length); assert.ok(a >= 0 && b > a); return serverSource.slice(a, b); };
const handlers = {
  reportDisposition: single('const disposition='), reportSafety: single('const reportSafetyEdit='),
  reportRemove: "const reportEdit=url.pathname.match(/^\\/api\\/reports\\/(\\d+)$/);\n" + single("if(req.method==='DELETE'&&reportEdit)"),
  reportRate: block('  const reportRateReview=', '  const projectRates='),
  projectRateSettings: block('  const projectRates=', "  if(url.pathname==='/api/reporting-exports'")
};
async function runLegacy(before, operation, actor) {
  const candidate = structuredClone(before); let response, written = false;
  const context = { req: { method: operation.method, auth: actor }, res: {}, url: new URL('http://synthetic.invalid' + operation.path), process: { env: { PDL_REQUIRE_AUTH: '1' } }, reportRates: rates, crypto,
    body: async () => structuredClone(operation.details), readDb: () => candidate, writeDb: value => { assert.equal(value, candidate); written = true; }, json: (res, status, data) => { response = { status, data }; return response; }, presentReport: h.presentReport };
  vm.createContext(context);
  const helpers = ['function nextId(', 'function reportHasOpenUnplanned(', 'function alignReportNarrative('].map(single).join('\n');
  await vm.runInContext('(async()=>{\n' + helpers + '\n' + handlers[operation.kind] + '\n})()', context);
  assert.ok(written); assert.equal(response.status, 200); actualHandlers++;
  return { candidate, response };
}
function restrict(db, role, changes) { db.company.dailyPolicyRequired = true; db.company.dailyRolePolicy = { version: 1, revision: 1, roles: Object.fromEntries(daily.roles.map(role => [role, daily.ceiling(role)])) }; Object.assign(db.company.dailyRolePolicy.roles[role], changes); }
async function main() {
  for (const operation of Object.values(operations)) { assert.equal(family.route(operation.method, operation.path), operation.kind); assert.deepEqual(family.parse(operation, input), operation); assertions += 2; }
  assert.equal(operations.reportRate.details.laborRate, 125.5); assert.equal(operations.projectRate.details.defaultLaborRate, 150); assertions += 2;
  for (const [method, path] of [['PATCH', '/api/reports/01/safety'], ['PATCH', '/api/reports/1/approve'], ['DELETE', '/api/reports/1?other=2'], ['POST', '/api/reports/1/disposition'], ['PATCH', '/api/projects/101']]) { assert.equal(family.route(method, path), null); assertions++; }
  for (const details of [{ ...operations.safety.details, companyId: B }, { ...operations.safety.details, role: 'owner' }, { ...operations.safety.details, noSafetyObservations: 'false' }, { ...operations.safety.details, noSafetyObservations: true }, { safetyItems: [{ observation: 'Test', verifiedBy: 'Owner' }] }, { safetyItems: [{ observation: 'Test', dueDate: '2026-02-30' }] }, { safetyItems: [{ observation: 'Test', status: 'approved' }] }, { safetyItems: [{ observation: '' }] }, { safetyTalk: 'Test\u0000' }]) rejects(() => op('reportSafety', 'PATCH', '/api/reports/1/safety', details), 400);
  for (const details of [{ laborRate: false, reason: 'Test' }, { laborRate: NaN, reason: 'Test' }, { laborRate: Infinity, reason: 'Test' }, { laborRate: '', reason: 'Test' }, { laborRate: '0x10', reason: 'Test' }, { laborRate: -1, reason: 'Test' }, { laborRate: 1, reason: '' }, { laborRate: 1, reason: 'Test', capturedBy: auth().user }]) rejects(() => op('reportRate', 'PATCH', '/api/reports/1/rate', details), 400);
  rejects(() => op('reportDisposition', 'PATCH', '/api/reports/1/disposition', { resolution: 'approved' }), 400); rejects(() => op('reportRemove', 'DELETE', '/api/reports/1', { reason: 'Test', laborEntries: [] }), 400); rejects(() => family.parse({ ...operations.safety, reason: 'Injected' }, input), 400);

  for (const role of ['owner', 'admin', 'project_manager', 'foreman', 'field']) { family.authorize(seed(), auth(role), operations.safety, h, input); assertions++; }
  for (const operation of [operations.disposition, operations.remove]) for (const role of ['foreman', 'field', 'crew', 'platform_admin']) rejects(() => family.authorize(seed(), auth(role), operation, h, input), 403);
  for (const operation of [operations.reportRate, operations.projectRate]) for (const role of ['project_manager', 'foreman', 'field', 'crew', 'platform_admin']) rejects(() => family.authorize(seed(), auth(role), operation, h, input), 403);
  rejects(() => family.authorize(seed(), { user: { ...auth().user, status: 'Inactive' } }, operations.safety, h, input), 403);
  rejects(() => family.authorize(seed(), { ...auth(), companyId: B }, operations.safety, h, input), 403);
  const denied = seed(); restrict(denied, 'project_manager', { editReports: false }); rejects(() => family.authorize(denied, auth('project_manager'), operations.safety, h, input), 403);
  const staleFlags = { ...auth('project_manager'), user: { ...auth('project_manager').user, dailyAccess: { viewReports: true, editReports: true, approveReports: true } } }; rejects(() => family.authorize(denied, staleFlags, operations.safety, h, input), 403);
  const noView = seed(); restrict(noView, 'admin', { viewReports: false, editReports: false, createReports: false, approveReports: false }); rejects(() => family.authorize(noView, auth('admin'), operations.safety, h, input), 403); family.authorize(noView, auth('admin'), operations.projectRate, h, input); assertions++;
  const noApprove = seed(); noApprove.reports[0].status = 'Approved'; restrict(noApprove, 'project_manager', { approveReports: false }); for (const operation of [operations.safety, operations.disposition, operations.remove]) rejects(() => family.authorize(noApprove, auth('project_manager'), operation, h, input), 403);
  const reopened = seed(); reopened.reports[0].history.push({ action: 'Approved', by: 'Synthetic original approver', at }); restrict(reopened, 'admin', { approveReports: false });
  assert.equal(daily.access(reopened, auth('admin').user).editReports, true); assertions++;
  rejects(() => family.authorize(reopened, auth('admin'), operations.reportRate, h, input), 403);
  const reopenedDefault = seed(); reopenedDefault.reports[0].history.push({ action: 'Approved', by: 'Synthetic original approver', at }); family.authorize(reopenedDefault, auth('admin'), operations.reportRate, h, input); assertions++;
  const mixed = seed(); mixed.reports[0].laborEntries.push({ memberId: 12, hours: 1 }); rejects(() => family.authorize(mixed, auth('project_manager'), operations.safety, h, input), 404);
  rejects(() => family.authorize(seed(), { user: { ...auth('project_manager').user, projectIds: [102] } }, operations.safety, h, input), 404);
  const linked = seed(); linked.workdays[0].memberIds.push(12); rejects(() => family.authorize(linked, auth('project_manager'), operations.remove, h, input), 403);
  const hiddenDay = seed(); restrict(hiddenDay, 'admin', { viewWorkdays: false, runWorkdays: false }); rejects(() => family.authorize(hiddenDay, auth('admin'), operations.remove, h, input), 403);
  const brokenPhoto = seed(); brokenPhoto.photos[0].projectId = 102; rejects(() => family.authorize(brokenPhoto, auth(), operations.remove, h, input), 409);
  const dependent = seed(); dependent.reports.push({ ...structuredClone(dependent.reports[0]), id: 2, laborExclusions: [{ memberId: 11, hours: 2, sourceReportId: 1 }] }); rejects(() => family.authorize(dependent, auth(), operations.remove, h, input), 409);
  const ticket = seed(); ticket.projectTickets.push({ id: 1, projectId: 101, reportId: 1 }); rejects(() => family.authorize(ticket, auth(), operations.remove, h, input), 409);
  const hiddenSource = seed(); hiddenSource.reports.push({ ...structuredClone(hiddenSource.reports[0]), id: 2, laborEntries: [{ memberId: 12, hours: 8 }] }); hiddenSource.reports[0].laborEntries.push({ memberId: 12, hours: 8 }); hiddenSource.reports[0].laborExclusions = [{ memberId: 12, hours: 2, sourceReportId: 2 }]; rejects(() => family.authorize(hiddenSource, auth('project_manager'), operations.safety, h, input), 404);
  const foreign = seed(); foreign.reports[0].companyId = B; rejects(() => family.authorize(foreign, auth(), operations.safety, h, input), 409);
  const duplicate = seed(); duplicate.reports.push(structuredClone(duplicate.reports[0])); rejects(() => family.authorize(duplicate, auth(), operations.safety, h, input), 409);
  for (const poison of [db => db.reports[0].laborEntries = null, db => db.reports[0].history = {}, db => db.reports[0].laborEntries[0].hours = Infinity, db => db.reports[0].project = 99, db => db.reports[0].status = 'Escalated', db => db.reports[0].flags = null, db => db.reports[0].laborExclusions = {}]) { const broken = seed(); poison(broken); rejects(() => family.authorize(broken, auth(), operations.safety, h, input), 409); }
  const named = seed(), profileId = crypto.randomUUID(), caps = profiles.defaults('project_manager'); caps.daily.editReports = false;
  named.company.roleProfilesRequired = true; named.company.roleProfiles = { version: 1, revision: 1, profiles: [{ id: profileId, name: 'Synthetic report observer', kind: 'custom', baseRole: 'project_manager', scopeInheritance: profiles.SCOPE, revision: 1, capabilities: caps }], assignments: [{ accountId: 3, profileId }], retiredIds: [] };
  rejects(() => family.authorize(named, auth('project_manager'), operations.safety, h, input), 403);
  // Compound creation authorizes createReports in the parent controller; the
  // safety-only second handler may validate without an unrelated edit grant.
  const createOnly = seed(); restrict(createOnly, 'project_manager', { editReports: false });
  const safetyOnly = await runLegacy(createOnly, operations.safety, auth('project_manager'));
  assert.equal(family.validateSafetyConsequence(createOnly, safetyOnly.candidate, operations.safety, auth('project_manager'), h, input).data.safetyItems[0].location, 'North edge'); assertions++;
  rejects(() => family.validate(createOnly, safetyOnly.candidate, operations.safety, auth('project_manager'), h, input), 403);
  const poisonedSafety = structuredClone(safetyOnly.candidate); poisonedSafety.projects[1].name = 'Unrelated compound mutation';
  rejects(() => family.validateSafetyConsequence(createOnly, poisonedSafety, operations.safety, auth('project_manager'), h, input), 409);
  assert.equal(Object.isFrozen(family.safetyFields), true); assertions++;

  for (const operation of Object.values(operations)) {
    const before = seed(); if (operation.kind === 'reportRate') before.reports[0].status = 'Approved';
    const unchanged = canonicalHash(before); family.authorize(before, auth(), operation, h, input);
    const executed = await runLegacy(before, operation, auth()); const checked = family.validate(before, executed.candidate, operation, auth(), h, input);
    assert.equal(canonicalHash(before), unchanged); assert.ok(checked.retained.report || checked.retained.project); assertions += 2;
    const forbidden = [db => db.company.name = 'Unexpected', db => db.users[1].role = 'owner', db => db.projects[1].name = 'Foreign mutation', db => db.team[1].crew = 'North', db => db.reports.push({ ...structuredClone(before.reports[0]), id: 9 })];
    if (operation.kind !== 'reportRemove') forbidden.push(db => db.reports[0].rateSnapshot = { schemaVersion: 1, laborRate: 999999, capturedAt: at, capturedBy: auth().user });
    if (operation.kind === 'reportRemove') forbidden.push(db => db.photos = [], db => db.workdays[0].memberIds.push(12), db => db.photos[0].filename = 'replaced.jpg', db => db.auditLog.at(-1).reason = 'Forged reason');
    if (operation.kind === 'reportDisposition') forbidden.push(db => db.changes.at(-1).amount = 1, db => db.changes.at(-1).projectId = 102, db => db.reports[0].flags[0].resolvedBy = 'Injected');
    if (operation.kind === 'reportRate') forbidden.push(db => db.reports[0].rateHistory.at(-1).previous = { laborRate: 999 }, db => db.reports[0].rateHistory.at(-1).actor.role = 'platform_admin', db => db.reports[0].rateReview.reviewedBy = 2);
    if (operation.kind === 'projectRateSettings') forbidden.push(db => db.projects[0].tmSettings.materialMarkup = 100, db => db.projects[0].rateSettingsHistory.at(-1).previous = 1, db => db.projects[0].rateSettingsHistory.at(-1).actor.name = 'Forged');
    if (['reportRemove', 'reportRate', 'projectRateSettings'].includes(operation.kind)) forbidden.push(db => db.auditLog.at(-1).id = before.auditLog[0].id);
    for (const mutate of forbidden) { const poisoned = structuredClone(executed.candidate); mutate(poisoned); rejects(() => family.validate(before, poisoned, operation, auth(), h, input), 409); }
    const receipt = { id: 'synthetic-receipt', operation, result: checked.data, retained: checked.retained };
    assert.deepEqual(family.currentResult(executed.candidate, auth(), receipt, false, h, input), operation.kind === 'reportRemove' ? { ok: true, id: 1, receiptId: 'synthetic-receipt' } : { id: Number(operation.path.split('/')[3]), receiptId: 'synthetic-receipt' }); assertions++;
    const first = family.currentResult(executed.candidate, auth(), receipt, true, h, input);
    assert.equal(first.privateEvidence, undefined); assert.equal(first.retained, undefined); assertions += 2;
    if (operation.kind === 'reportSafety') { assert.equal(first.safetyItems[0].location, 'North edge'); assert.equal(first.safetyTalkAttendees, 'Synthetic crew'); const revoked = structuredClone(executed.candidate); restrict(revoked, 'admin', { viewReports: false, createReports: false, editReports: false, approveReports: false }); assert.deepEqual(family.currentResult(revoked, auth('admin'), receipt, true, h, input), { id: 1, receiptId: 'synthetic-receipt' }); assertions += 3; }
    if (operation.kind === 'reportDisposition') { assert.equal(checked.data.change.projectId, 101); assert.equal(checked.data.change.amount, 0); const managerChecked = family.validate(before, executed.candidate, operation, auth('project_manager'), { ...h, canViewPricing: () => false }, input); assert.equal(managerChecked.data.change.amount, undefined); assertions += 3; }
    if (operation.kind === 'reportRemove') { assert.equal(executed.candidate.photos[0].reportId, null); assert.equal(checked.retained.photos[0].privateEvidence, before.photos[0].privateEvidence); assert.equal(first.audit, undefined); assertions += 3; }
    if (operation.kind === 'reportRate') { assert.equal(first.rateSnapshot.source, 'legacy-review'); assert.equal(first.rateSnapshot.materialMarkup, null); assert.equal(first.rateHistory[0].previous, null); assertions += 3; }
    if (operation.kind === 'projectRateSettings') { assert.equal(first.name, undefined); assert.equal(first.progress, undefined); assert.equal(first.rateSettingsHistory[0].previous, 100); assertions += 3; }
    if (operation.kind !== 'reportRemove') { const recycled = structuredClone(executed.candidate); const row = operation.kind === 'projectRateSettings' ? recycled.projects[0] : recycled.reports[0]; row.name = 'Replacement same numeric ID'; assert.deepEqual(family.currentResult(recycled, auth(), receipt, true, h, input), { id: row.id, receiptId: 'synthetic-receipt' }); assertions++; }
  }
  // Existing captured-rate adjustments retain the complete old snapshot/history.
  const captured = seed(); captured.reports[0].status = 'Approved'; rates.captureFirstApproval({ status: 'Needs review', history: [] }, captured.projects[0], auth().user, at);
  captured.reports[0].rateSnapshot = { schemaVersion: 1, laborRate: 75, materialMarkup: 10, equipmentMarkup: 5, capturedAt: at, capturedBy: { id: 1, name: 'Synthetic original approver', role: 'owner' }, source: 'first-office-approval' };
  captured.reports[0].rateHistory = [{ id: '20000000-0000-4000-8000-000000000001', previous: null, next: structuredClone(captured.reports[0].rateSnapshot), reason: 'Synthetic original agreement', evidenceReference: 'Synthetic original contract', actor: { id: 1, name: 'Synthetic original approver', role: 'owner' }, at, privateNote: 'Retain historic rate evidence' }];
  const adjusted = await runLegacy(captured, operations.reportRate, auth()); const checked = family.validate(captured, adjusted.candidate, operations.reportRate, auth(), h, input);
  assert.deepEqual(checked.data.rateHistory.at(-1).previous, captured.reports[0].rateSnapshot); assert.equal(checked.data.rateSnapshot.materialMarkup, 10); assert.equal(checked.data.rateSnapshot.source, 'audited-adjustment'); assert.equal(checked.data.rateHistory[0].privateNote, undefined); assertions += 4;
  const reusedHistoryId = structuredClone(adjusted.candidate); reusedHistoryId.reports[0].rateHistory.at(-1).id = captured.reports[0].rateHistory[0].id; rejects(() => family.validate(captured, reusedHistoryId, operations.reportRate, auth(), h, input), 409);
  // Non-commercial dispositions preserve every unrelated existing change.
  for (const resolution of ['mapped', 'non_billable', 'tm']) { const operation = op('reportDisposition', 'PATCH', '/api/reports/1/disposition', { resolution }); const before = seed(); const result = await runLegacy(before, operation, auth()); family.validate(before, result.candidate, operation, auth(), h, input); assertions++; }
  console.log(`report variants pure acceptance passed: ${assertions} assertions, ${actualHandlers} exact legacy-handler clone executions, five closed routes, current typed/profile restrictions, immutable financial roles, all-source scope, exact compound deltas, retained bytes references and finite replay/readback; zero servers/providers/live data.`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
