'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { tmSummary } = require('./editor-commercial-reads');
const daily = require('./daily-access');
const profiles = require('./role-profiles');
const reportRates = require('./report-rate-policy');

// Evaluate the actual two unchanged pure server functions without importing
// server.js, starting a service or invoking any provider. A changed declaration
// fails this contract instead of silently substituting a test-only permission.
const serverLines = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8').split(/\r?\n/);
const pricingDeclarations = ['pricingPolicy', 'canViewPricing'].map(name => {
  const declarations = serverLines.filter(line => line.startsWith('function ' + name + '('));
  assert.equal(declarations.length, 1, 'One existing pure server pricing declaration: ' + name);
  return declarations[0];
});
const canViewPricing = vm.runInNewContext(pricingDeclarations.join('\n') + '\ncanViewPricing;');
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const capturedAt = '2026-10-11T08:00:00.000Z';
const snapshot = laborRate => ({ schemaVersion: 1, laborRate, materialMarkup: 0.1, equipmentMarkup: 0.2, capturedAt, capturedBy: { id: 1, name: 'Owner context', role: 'owner' }, source: 'first-office-approval' });
function seed() {
  return {
    company: { id: A, name: 'Synthetic company', pricingAccess: { enabled: true, officeMode: 'all', userIds: [] } },
    users: [
      { id: 1, companyId: A, name: 'Owner', role: 'owner', status: 'Active', permissions: {} },
      { id: 2, companyId: A, name: 'Manager', role: 'project_manager', status: 'Active', projectIds: [101], assignedCrews: ['Alpha'], permissions: { viewDailies: true, approveDailies: true, scheduleCrews: true } },
      { id: 3, companyId: A, name: 'Admin', role: 'admin', status: 'Active', permissions: {} }
    ],
    projects: [
      { id: 101, name: 'Selected project', tmSettings: { defaultLaborRate: 120, materialMarkup: '0.15', equipmentMarkup: null } },
      { id: 202, name: 'Hidden project', tmSettings: { defaultLaborRate: 999 } }
    ],
    team: [
      { id: 11, name: 'Visible member', crew: 'Alpha', role: 'Mason' },
      { id: 12, name: 'Hidden member', crew: 'Beta', role: 'Secret classification' }
    ],
    reports: [
      { id: 1, project: 0, status: 'Approved', dateIso: '2026-10-10', laborEntries: [{ memberId: 11, hours: 2 }], materials: 'Visible material', equipment: 'Visible equipment', rateSnapshot: snapshot(100) },
      { id: 2, project: 0, status: 'Approved', dateIso: '2026-10-10', laborEntries: [{ memberId: 11, hours: 4 }, { memberId: 12, hours: 80 }], laborExclusions: [{ memberId: 11, hours: 2, sourceReportId: 1, by: 'Private source actor', at: capturedAt }], materials: 'Hidden shared material', equipment: 'Hidden shared equipment', rateSnapshot: snapshot(125) },
      { id: 3, project: 0, status: 'Approved', dateIso: '2026-10-10', laborEntries: [{ memberId: 12, hours: 90 }], materials: 'Hidden material', equipment: 'Hidden equipment', rateReview: { reason: 'legacy_missing_rate_snapshot' } },
      { id: 4, project: 1, status: 'Approved', dateIso: '2026-10-10', laborEntries: [{ memberId: 11, hours: 50 }], rateSnapshot: snapshot(999) },
      { id: 5, project: 0, status: 'Needs review', dateIso: '2026-10-10', laborEntries: [{ memberId: 11, hours: 10 }], rateSnapshot: snapshot(777) }
    ]
  };
}
const summary = (db, actor = db.users[1], projectId = 101) => tmSummary(db, actor, projectId, { canViewPricing });
const denied = (fn, code) => assert.throws(fn, error => error.statusCode === code);
function restrictView(db, role = 'project_manager') {
  db.company.dailyPolicyRequired = true;
  db.company.dailyRolePolicy = { version: 1, revision: 1, roles: Object.fromEntries(daily.roles.map(value => [value, daily.ceiling(value)])) };
  Object.assign(db.company.dailyRolePolicy.roles[role], { viewReports: false, createReports: false, editReports: false, approveReports: false, runWorkdays: false });
  daily.validatePolicy(db.company.dailyRolePolicy);
}

test('Owner no-policy DTO exactly preserves actual legacy summarizeRates and defaults', () => {
  const db = seed(), before = structuredClone(db), reports = db.reports.filter(row => row.project === 0 && row.status === 'Approved');
  assert.deepEqual(summary(db, db.users[0]), { projectId: 101, ...reportRates.summarizeRates(db, 0, reports), materialEntries: 3, equipmentEntries: 3, currentDefaults: db.projects[0].tmSettings });
  assert.deepEqual(db, before, 'A read never mutates reports, policy or accounting evidence');
});
test('PM original report and member scope excludes hidden hours, classification, report IDs and incomplete rates', () => {
  const result = summary(seed());
  assert.deepEqual(result, { projectId: 101, approvedDailies: 2, laborHours: 4, complete: true, laborAmount: 450, knownLaborAmount: 450, labor: [{ classification: 'Mason', rate: 100, hours: 2, amount: 200 }, { classification: 'Mason', rate: 125, hours: 2, amount: 250 }], missingRateReports: [], materialEntries: 1, equipmentEntries: 1, currentDefaults: { defaultLaborRate: 120, materialMarkup: '0.15', equipmentMarkup: null } });
  for (const hidden of ['Hidden', 'Secret', '999', '777', 'Owner context', 'Private source actor', 'sourceReportId', 'capturedBy']) assert.ok(!JSON.stringify(result).includes(hidden), hidden + ' is absent');
});
test('Changing fully hidden reports has no influence on PM result', () => {
  const db = seed(), expected = summary(db);
  db.reports[2].rateSnapshot = snapshot(888); db.reports[2].laborEntries[0].hours = 3; db.reports[2].materials = ''; db.reports[2].id = 33;
  db.reports[3].laborEntries[0].hours = 100; db.reports[4].rateSnapshot = snapshot(111);
  assert.deepEqual(summary(db), expected);
});
test('Visible mixed report incomplete rate exposes only that visible report ID with canonical missing reason', () => {
  const db = seed(); delete db.reports[1].rateSnapshot; db.reports[1].rateReview = { reason: 'Hidden arbitrary financial context' };
  const result = summary(db); assert.equal(result.complete, false); assert.equal(result.laborAmount, null); assert.equal(result.knownLaborAmount, 200);
  assert.deepEqual(result.missingRateReports, [{ reportId: 2, dateIso: '2026-10-10', reason: 'legacy_missing_rate_snapshot' }]);
});
test('Daily typed view restriction denies effective actor even when stored PM grants permit', () => {
  const db = seed(); restrictView(db); assert.equal(db.users[1].permissions.viewDailies, true); assert.equal(db.users[1].permissions.approveDailies, true);
  denied(() => summary(db), 403);
});
test('Assembled dailyAccess restriction is retained instead of reconstructing broader stored grants', () => {
  const db = seed(); denied(() => summary(db, { ...db.users[1], dailyAccess: { ...daily.access(db, db.users[1]), viewReports: false } }), 403);
  denied(() => summary(db, { ...db.users[1], effectiveCapabilities: { daily: { viewReports: false } } }), 403);
});
test('Current actor grant and scope restrictions intersect fresh stored authority', () => {
  const db = seed(); denied(() => summary(db, { ...db.users[1], permissions: { viewDailies: false, approveDailies: false } }), 403);
  denied(() => summary(db, { ...db.users[1], projectIds: [] }), 404);
  const result = summary(db, { ...db.users[1], assignedCrews: [] }); assert.equal(result.approvedDailies, 0); assert.equal(result.laborHours, 0); assert.deepEqual(result.labor, []);
});
test('Fresh stored revocation cannot be reinstated by a stale assembled grant or scope', () => {
  const db = seed(), stale = structuredClone(db.users[1]); db.users[1].permissions.viewDailies = false; db.users[1].permissions.approveDailies = false;
  denied(() => summary(db, stale), 403);
  db.users[1].permissions.viewDailies = true; db.users[1].projectIds = []; denied(() => summary(db, stale), 404);
});
test('PM project scope and current crew changes remain immutable', () => {
  const db = seed(); denied(() => summary(db, db.users[1], 202), 404);
  db.team[0].crew = 'Beta'; assert.equal(summary(db).approvedDailies, 0);
  denied(() => summary(db, db.users[1], 999), 404);
});
test('No-labor and foreign-crew reports remain outside the original PM report-view scope', () => {
  const db = seed(); db.reports.push({ id: 6, project: 0, status: 'Approved', dateIso: '2026-10-10', laborEntries: [], materials: 'Hidden no-labor', equipment: 'Hidden no-labor', rateSnapshot: snapshot(555) });
  assert.equal(daily.reportInScope(db, db.users[1], db.reports.at(-1)), false); assert.equal(summary(db).approvedDailies, 2);
});
test('Fixed pricing policy denies despite all editable actions and fake generic flags', () => {
  const db = seed(); db.company.pricingAccess = { enabled: false, officeMode: 'all', userIds: [2] };
  denied(() => summary(db, { ...db.users[1], canViewPricing: true, permissions: { ...db.users[1].permissions, pricing: true, tmSummary: true } }), 403);
  db.company.pricingAccess = { enabled: true, officeMode: 'selected', userIds: [3] }; denied(() => summary(db), 403);
  db.company.pricingAccess.userIds = [2]; assert.equal(summary(db).laborAmount, 450);
});
test('Foreman, field, crew, platform and unknown roles cannot obtain financial summary', () => {
  for (const role of ['foreman', 'field', 'crew', 'platform', 'platform_admin', 'unknown']) {
    const db = seed(); db.users[1].role = role; denied(() => summary(db), 403);
  }
});
test('Cross-company actor, inactive account and changed role cannot reuse a read actor', () => {
  const db = seed(); denied(() => summary(db, { ...db.users[1], companyId: B }), 404);
  const stale = structuredClone(db.users[1]); db.users[1].status = 'Deactivated'; denied(() => summary(db, stale), 403);
  db.users[1].status = 'Active'; db.users[1].role = 'field'; denied(() => summary(db, stale), 403);
});
test('Owner immutable report view survives invalid restrictive policies and profiles', () => {
  const db = seed(); db.company.dailyPolicyRequired = true; db.company.dailyRolePolicy = { genericPermissions: { viewReports: false } }; db.company.roleProfilesRequired = true; db.company.roleProfiles = null;
  assert.equal(summary(db, db.users[0]).approvedDailies, 3); denied(() => summary(db), 403);
});
test('Named profile daily restriction intersects its existing PM base role and grants', () => {
  const db = seed(), capabilities = profiles.defaults('project_manager'), profileId = '11111111-1111-4111-8111-111111111111';
  Object.assign(capabilities.daily, { viewReports: false, createReports: false, editReports: false, approveReports: false, runWorkdays: false });
  db.company.roleProfilesRequired = true; db.company.roleProfiles = { version: 1, revision: 1, profiles: [{ id: profileId, name: 'Restricted PM', kind: 'custom', baseRole: 'project_manager', scopeInheritance: profiles.SCOPE, revision: 1, capabilities }], assignments: [{ accountId: 2, profileId }], retiredIds: [] };
  profiles.validateModel(db.company.roleProfiles); denied(() => summary(db), 403);
  db.company.roleProfiles.profiles[0].capabilities = profiles.defaults('project_manager'); assert.equal(summary(db).laborAmount, 450);
  db.company.roleProfiles.assignments[0].profileId = '22222222-2222-4222-8222-222222222222'; denied(() => summary(db), 403);
});
test('Mixed report exclusions preserve exact accounting while hidden member exclusions do not leak', () => {
  const db = seed(); db.reports[2].rateSnapshot = snapshot(250); db.reports[1].laborExclusions.push({ memberId: 12, hours: 10, sourceReportId: 3, by: 'Hidden source actor' });
  assert.equal(summary(db).laborAmount, 450); assert.equal(summary(db).laborHours, 4); assert.equal(summary(db, db.users[0]).laborHours, 164);
});
test('Source identities, labor and exclusion bindings fail closed before aggregation', () => {
  const malformed = [
    db => { db.reports.push(structuredClone(db.reports[0])); },
    db => { db.team[1].companyId = B; },
    db => { db.reports[0].project = 99; },
    db => { db.reports[0].laborEntries = {}; },
    db => { db.reports[0].laborEntries[0].memberId = 999; },
    db => { db.reports[0].laborEntries.push({ ...db.reports[0].laborEntries[0] }); },
    db => { db.reports[0].laborEntries[0].hours = 'not a number'; },
    db => { db.reports[0].laborEntries[0].hours = -1; },
    db => { db.reports[1].laborExclusions[0].sourceReportId = 4; },
    db => { db.reports[1].laborExclusions[0].hours = 3; },
    db => { db.reports[1].laborExclusions.push({ ...db.reports[1].laborExclusions[0] }); },
    db => { db.reports[0].laborExclusions = [{ memberId: 11, hours: 1, sourceReportId: 2 }]; },
    db => { db.reports[0].rateSnapshot = []; },
    db => { db.reports[0].rateSnapshot.capturedAt = {}; },
    db => { db.projects[0].tmSettings.defaultLaborRate = Infinity; },
    db => { db.company.pricingAccess.userIds = {}; }
  ];
  for (const mutate of malformed) { const db = seed(); mutate(db); denied(() => summary(db), 409); }
});
test('Finite defaults and rate DTO suppress unknown financial context without creating new permissions', () => {
  const db = seed(); db.projects[0].tmSettings.privateProviderContext = 'Hidden provider'; db.reports[0].rateSnapshot.privateContext = 'Hidden rate context';
  assert.deepEqual(summary(db).currentDefaults, { defaultLaborRate: 120, materialMarkup: '0.15', equipmentMarkup: null });
  assert.ok(!JSON.stringify(summary(db)).includes('Hidden')); denied(() => tmSummary(db, db.users[1], 101), 409);
});
test('Admin and legacy Office financial view retain defaults but obey typed daily restriction', () => {
  const db = seed(); assert.equal(summary(db, db.users[2]).approvedDailies, 3); db.users[2].role = 'office'; assert.equal(summary(db, { ...db.users[2], role: 'admin' }).approvedDailies, 3);
  restrictView(db, 'admin'); denied(() => summary(db, { ...db.users[2], role: 'admin' }), 403);
});
test('Summary module uses actual existing typed controller and rates implementation only', () => {
  const source = fs.readFileSync(path.join(__dirname, 'editor-commercial-reads.js'), 'utf8');
  assert.match(source, /reportRates\.summarizeRates\(/); assert.match(source, /daily\.reportInScope\(db, actor, report\)/);
  assert.ok(!source.includes('fetch(')); assert.ok(!source.includes('writeDb(')); assert.ok(!source.includes('require(\'./server\')'));
});
