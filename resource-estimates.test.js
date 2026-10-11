'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const family = require('./resource-estimates');
const input = require('./resource-inputs');
const daily = require('./daily-access');
const profiles = require('./role-profiles');
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const at = '2026-10-11T10:00:00.000Z';
const server = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8').split(/\r?\n/);
function declaration(name) {
  const matches = server.map((value, index) => ({ value, index })).filter(row => row.value.startsWith('function ' + name + '('));
  assert.equal(matches.length, 1, 'One actual existing pure helper ' + name);
  const { value, index } = matches[0];
  if (value.includes('}')) return value;
  const end = server.findIndex((line, i) => i > index && /^  }$/.test(line)); assert.ok(end > index);
  return server.slice(index, end + 1).join('\n');
}
const names = ['pricingPolicy', 'canViewPricing', 'managerScope', 'fieldProjectIds', 'fieldRole', 'projectNotesCanAccessProject', 'nextId', 'nonNegativeNumber', 'importBudgetHours', 'catalogWords', 'catalogSuggestions', 'enrichEstimateDraft'];
const declarations = names.map(declaration).join('\n');
const helpers = vm.runInNewContext(declarations + '\n({ canViewPricing, canAccessProject: projectNotesCanAccessProject, importBudgetHours, enrichEstimateDraft });');
const prefixes = ['  const estimateItemRoute=', '  const estimate=', '  const estimateProposals=', '  const estimateProposalApprove=', '  const saveImportDraft=', '  const approveImport=', "  if(req.method==='GET'&&url.pathname==='/api/estimate-imports')"];
const handlers = prefixes.map(prefix => {
  const matches = server.filter(line => line.startsWith(prefix)); assert.equal(matches.length, 1, 'One actual existing handler ' + prefix.trim()); return matches[0];
}).join('\n');
const denyExternal = () => { throw Error('No provider, physical file or network call permitted.'); };
async function actual(db, auth, operation) {
  const candidate = structuredClone(db); let response, writes = 0;
  const context = {
    req: { method: operation.method, auth }, url: new URL('http://127.0.0.1' + operation.path), res: {},
    readDb: () => candidate, body: async () => structuredClone(operation.details),
    writeDb: value => { assert.equal(value, candidate); writes++; },
    json: (_res, status, data) => { response = { status, data: structuredClone(data) }; return response; },
    process: { env: { PDL_REQUIRE_AUTH: '1', OPENAI_API_KEY: '' } },
    fs: { mkdirSync: denyExternal, writeFileSync: denyExternal }, path: { join: denyExternal },
    fetch: denyExternal, aiEstimateDraft: denyExternal, pdfText: denyExternal, estimateDraft: denyExternal,
    ROOT: 'forbidden-files', crypto: { randomUUID: denyExternal }
  };
  // Execute unchanged route bodies on an isolated clone. Pure helpers are the
  // actual declarations, not replicas; global ingress/final CAS belongs to the
  // parent's HTTP/native test. Nothing opens a port or starts server.js.
  await vm.runInNewContext('(async () => {\n' + declarations + '\n' + handlers + '\n})()', context);
  assert.ok(response, 'Selected actual handler returns a response'); return { candidate: structuredClone(candidate), response, writes };
}
function seed() {
  return {
    company: { id: A, name: 'Synthetic company', pricingAccess: { enabled: true, officeMode: 'all', userIds: [] } },
    users: [
      { id: 1, companyId: A, name: 'Owner', role: 'owner', status: 'Active', permissions: {} },
      { id: 2, companyId: A, name: 'Admin', role: 'admin', status: 'Active', permissions: {} },
      { id: 3, companyId: A, name: 'Manager', role: 'project_manager', status: 'Active', projectIds: [101], assignedCrews: ['Alpha'], permissions: { viewDailies: true, approveDailies: true } },
      { id: 4, companyId: A, name: 'Field', role: 'field', status: 'Active', memberId: 11, permissions: {} }
    ],
    team: [{ id: 11, name: 'Field', crew: 'Alpha', role: 'Mason' }],
    assignments: [{ id: 1, projectId: 101, memberIds: [11] }], workdays: [],
    reports: [{ id: 1, project: 0, status: 'Approved', laborEntries: [{ memberId: 11, hours: 2 }], productionEntries: [{ estimateItemId: 1, quantity: 1 }] }],
    projects: [
      { id: 101, name: 'Selected project', rateSettingsHistory: [{ reason: 'Private rate history' }], estimateItems: [{ id: 1, name: 'Linked scope', plannedQuantity: 2, unit: 'SF', budgetHours: 0, cost: 20, sourceImportId: 90 }, { id: 2, name: 'Spare scope', plannedQuantity: 3, unit: 'EA', budgetHours: null, cost: null }], estimateProposals: [{ id: 4, name: 'Proposed scope', plannedQuantity: 3, unit: 'LF', sourceFile: null, createdBy: 'Field', createdAt: at, status: 'Needs office review' }] },
      { id: 202, name: 'Unassigned project', estimateItems: [], estimateProposals: [] }
    ],
    catalog: [{ id: 10, name: 'Wall tile', category: 'Tile', description: 'Standard tile', unit: 'SF', targetHoursPerUnit: 0.125, createdAt: at }],
    estimateImports: [
      { id: 7, filename: 'Synthetic stored.pdf', url: '/uploads/estimates/synthetic-stored.pdf', status: 'Draft', createdAt: at, createdByUserId: 3, projectId: 101, lines: [{ description: 'Wall tile', quantity: 10, unit: 'SF', amount: 100 }], textPreview: 'Private PDF text', privateMarker: 'Private original metadata' },
      { id: 8, filename: 'Synthetic foreign.pdf', url: '/uploads/estimates/synthetic-foreign.pdf', status: 'Draft', createdAt: at, createdByUserId: 1, projectId: 202, lines: [] },
      { id: 9, filename: 'Synthetic unassigned.pdf', url: '/uploads/estimates/synthetic-unassigned.pdf', status: 'Draft', createdAt: at, createdByUserId: 1, lines: [] }
    ], auditLog: [{ id: 'kept', detail: 'Private original audit' }]
  };
}
const auth = (db, role = 'owner') => ({ user: db.users.find(row => row.role === role), companyId: A });
const op = (kind, method, route, details) => family.parse({ kind, method, path: route, details }, input);
const reject = (fn, status) => assert.throws(fn, error => error.statusCode === status);
const rows = [
  ['estimateItemCreate', 'POST', '/api/projects/101/estimate-items', { name: 'Manual scope', plannedQuantity: 10, unit: 'SF', budgetHours: null, cost: 25 }],
  ['estimateItemEdit', 'PATCH', '/api/projects/101/estimate-items/2', { name: 'Revised scope', plannedQuantity: 8, budgetHours: 0, cost: 10.129 }],
  ['estimateItemEdit', 'PUT', '/api/projects/101/estimate-items/2', { unit: 'LF', budgetHours: null }],
  ['estimateItemRemove', 'DELETE', '/api/projects/101/estimate-items/2', {}],
  ['estimateProposalCreate', 'POST', '/api/projects/101/estimate-proposals', { name: 'Manual field scope', plannedQuantity: 5, unit: 'sf' }],
  ['estimateProposalApprove', 'POST', '/api/projects/101/estimate-proposals/4/approve', {}],
  ['estimateImportDraft', 'PATCH', '/api/estimate-imports/7/draft', { projectId: 101, lines: [{ description: 'Reviewed unknown scope', quantity: null, unit: '', amount: null, budgetHours: null, unitPrice: 999, internalCost: 100, catalogItemId: 10, scopeStatus: 'uncertain', budgetHoursUserEdited: false }] }],
  ['estimateImportApprove', 'POST', '/api/estimate-imports/7/approve', { projectId: 101, lines: [{ description: 'Wall tile', quantity: 10, unit: 'SF', amount: null, catalogItemId: 10, budgetHours: null }, { description: 'Manual zero budget', quantity: 5, unit: 'EA', amount: 0, budgetHours: 0 }] }]
];

for (const row of rows) test('Actual unchanged manual handler and closed consequence: ' + row[1] + ' ' + row[2], async () => {
  const before = seed(), operation = op(...row), identity = auth(before), opening = structuredClone(before);
  family.authorize(before, identity, operation, helpers, input);
  const result = await actual(before, identity, operation); assert.ok([200, 201].includes(result.response.status), JSON.stringify(result.response)); assert.equal(result.writes, 1);
  const checked = family.validate(before, result.candidate, operation, identity, helpers, input);
  assert.deepEqual(before, opening, 'Original source is untouched'); assert.deepEqual(checked.retained.project, before.projects[0]);
  for (const key of ['users', 'company', 'reports', 'workdays', 'assignments', 'team', 'auditLog', 'catalog']) assert.deepEqual(result.candidate[key], before[key], key + ' protected');
  assert.deepEqual(result.candidate.projects[1], before.projects[1]);
  assert.ok(!JSON.stringify(checked.data).includes('Private'), 'Finite response does not expose PDF text/history/private metadata');
  const receipt = { id: 'synthetic-receipt', operation, result: checked.data, retained: checked.retained };
  const first = family.currentResult(result.candidate, identity, receipt, true, helpers, input); assert.ok(first);
  const replayDb = { company: before.company, get projects() { throw Error('A replay must not look up a reused numerical project ID'); } };
  assert.equal(family.currentResult(replayDb, identity, receipt, false, helpers, input).receiptId, receipt.id);
});
test('Finite route inventory rejects providers, uploads, aliases and noncanonical or unsafe IDs', () => {
  for (const route of ['/api/estimate-imports/analyze', '/api/projects/101/estimate-proposals/04/approve', '/api/projects/01/estimate-items', '/api/projects/101/estimate-items?companyId=foreign', '/api/projects/101/estimate-proposals/4', '/api/projects/101/estimates']) assert.equal(family.route('POST', route), null);
  reject(() => op('estimateItemCreate', 'POST', '/api/projects/9007199254740992/estimate-items', { name: 'Test', plannedQuantity: 1 }), 400);
  reject(() => op('estimateProposalCreate', 'POST', '/api/projects/101/estimate-proposals', { name: 'Test', plannedQuantity: 1, data: 'data:application/pdf;base64,forbidden' }), 400);
  reject(() => op('estimateProposalCreate', 'POST', '/api/projects/101/estimate-proposals', { name: 'Test', plannedQuantity: 1, filename: 'forbidden.pdf' }), 400);
});
test('Strict input denies injected identity, history, source IDs, rate/private fields and malformed amounts', () => {
  for (const extra of [{ id: 9 }, { companyId: B }, { sourceImportId: 9 }, { sourceProposalId: 4 }, { permissions: { pricing: true } }, { rateSnapshot: {} }, { privateContext: 'secret' }]) reject(() => op('estimateItemCreate', 'POST', '/api/projects/101/estimate-items', { name: 'Test', plannedQuantity: 1, ...extra }), 400);
  for (const amount of [Infinity, NaN, -1, {}, true, 'bad']) reject(() => op('estimateItemCreate', 'POST', '/api/projects/101/estimate-items', { name: 'Test', plannedQuantity: 1, cost: amount }), 400);
  for (const lines of [[null], [{ description: 'Test', quantity: 1, unit: 'SF', sourceImportId: 99 }], [{ description: 'Test', quantity: 0, unit: 'SF' }], [{ description: 'Test', quantity: 1, unit: '' }]]) reject(() => op('estimateImportApprove', 'POST', '/api/estimate-imports/7/approve', { projectId: 101, lines }), 400);
  reject(() => op('estimateProposalApprove', 'POST', '/api/projects/101/estimate-proposals/4/approve', { projectId: 202 }), 400);
});
test('Immutable roles and original actual project scope apply without daily mask grants', () => {
  const db = seed(), create = op(...rows[0]), edit = op(...rows[1]), proposal = op(...rows[4]), approve = op(...rows[5]), imported = op(...rows[7]);
  family.authorize(db, auth(db, 'project_manager'), create, helpers, input); family.authorize(db, auth(db, 'project_manager'), approve, helpers, input);
  for (const role of ['project_manager', 'field', 'foreman', 'platform_admin', 'crew', 'office']) reject(() => family.authorizeActor({ user: { ...db.users[0], role } }, edit, input), 403);
  reject(() => family.authorize(db, { user: { ...db.users[0], status: 'Inactive' } }, create, helpers, input), 403);
  reject(() => family.authorize(db, auth(db, 'field'), imported, helpers, input), 403);
  reject(() => family.authorize(db, { ...auth(db), companyId: B }, create, helpers, input), 403);
  reject(() => family.authorize(db, auth(db, 'project_manager'), { ...create, path: '/api/projects/202/estimate-items' }, helpers, input), 404);
  reject(() => family.authorize(db, auth(db, 'field'), { ...proposal, path: '/api/projects/202/estimate-proposals' }, helpers, input), 404);
  reject(() => family.authorize(db, auth(db), create, { ...helpers, canAccessProject: undefined }, input), 503);
});
test('All daily actions restricted does not revoke independent fixed estimate financial authority', async () => {
  const db = seed(); db.company.dailyPolicyRequired = true; db.company.dailyRolePolicy = { version: 1, revision: 1, roles: Object.fromEntries(daily.roles.map(role => [role, Object.fromEntries(daily.actions.map(action => [action, false]))])) };
  daily.validatePolicy(db.company.dailyRolePolicy); assert.equal(daily.access(db, db.users[2]).approveReports, false);
  const operation = op(...rows[7]), identity = auth(db, 'project_manager'); family.authorize(db, identity, operation, helpers, input);
  const result = await actual(db, identity, operation); assert.equal(result.response.status, 200); family.validate(db, result.candidate, operation, identity, helpers, input);
  db.company.pricingAccess.enabled = false; reject(() => family.authorize(db, { user: { ...identity.user, dailyAccess: Object.fromEntries(daily.actions.map(action => [action, true])), permissions: { pricing: true } } }, operation, helpers, input), 403);
});
test('Existing named profile masks cannot grant denied pricing or platform/field management', () => {
  const db = seed(), identity = auth(db, 'project_manager'), operation = op(...rows[7]); db.company.pricingAccess = { enabled: true, officeMode: 'selected', userIds: [1] };
  db.company.roleProfilesRequired = true; const id = '11111111-1111-4111-8111-111111111111'; db.company.roleProfiles = { version: 1, revision: 1, profiles: [{ id, name: 'PM current mask', kind: 'custom', baseRole: 'project_manager', scopeInheritance: profiles.SCOPE, revision: 1, capabilities: profiles.defaults('project_manager') }], assignments: [{ accountId: 3, profileId: id }], retiredIds: [] };
  profiles.validateModel(db.company.roleProfiles); reject(() => family.authorize(db, identity, operation, helpers, input), 403);
  reject(() => family.authorizeActor({ user: { ...identity.user, role: 'platform_admin', permissions: { pricing: true } } }, operation, input), 403);
});
test('Nonpricing creators preserve zero-cost legacy operation while financial response is redacted', async () => {
  const db = seed(), operation = op('estimateItemCreate', 'POST', '/api/projects/101/estimate-items', { name: 'Field manual scope', plannedQuantity: 1, budgetHours: 0, cost: 0 }), identity = auth(db, 'field');
  family.authorize(db, identity, operation, helpers, input); const result = await actual(db, identity, operation); const checked = family.validate(db, result.candidate, operation, identity, helpers, input);
  assert.equal(checked.data.cost, undefined); assert.equal(checked.data.budgetHours, 0); assert.equal(result.candidate.projects[0].estimateItems.at(-1).cost, 0);
  reject(() => family.authorize(db, identity, { ...operation, details: { ...operation.details, cost: 1 } }, helpers, input), 403);
  db.company.pricingAccess.enabled = false; const pm = auth(db, 'project_manager'); family.authorize(db, pm, operation, helpers, input);
  const nonpricing = await actual(db, pm, operation);
  assert.equal(family.validate(db, nonpricing.candidate, operation, pm, helpers, input).data.cost, undefined);
});
test('Retained daily estimate references prevent deletion even when daily view is restricted', () => {
  const db = seed(), operation = op('estimateItemRemove', 'DELETE', '/api/projects/101/estimate-items/1', {});
  db.company.dailyPolicyRequired = true; db.company.dailyRolePolicy = { version: 1, revision: 1, roles: Object.fromEntries(daily.roles.map(role => [role, Object.fromEntries(daily.actions.map(action => [action, false]))])) };
  reject(() => family.authorize(db, auth(db, 'admin'), operation, helpers, input), 409);
  db.reports[0].productionEntries = {}; reject(() => family.authorize(db, auth(db), operation, helpers, input), 409);
});
test('Imports bind original and destination project or private unassigned creator; retarget cannot evade PM scope', () => {
  const db = seed(), identity = auth(db, 'project_manager'), draft = op(...rows[6]);
  reject(() => family.authorize(db, identity, { ...draft, details: { ...draft.details, projectId: 202 } }, helpers, input), 404);
  reject(() => family.authorize(db, identity, { ...draft, path: '/api/estimate-imports/8/draft' }, helpers, input), 404);
  reject(() => family.authorize(db, identity, { ...draft, path: '/api/estimate-imports/9/draft' }, helpers, input), 404);
  db.estimateImports[2].createdByUserId = 3; family.authorize(db, identity, { ...draft, path: '/api/estimate-imports/9/draft' }, helpers, input);
  db.estimateImports[0].status = 'Approved'; reject(() => family.authorize(db, identity, draft, helpers, input), 409);
});
test('Catalog source and selected line references cannot fabricate scope or hidden context', () => {
  const db = seed(), operation = op(...rows[7]), identity = auth(db);
  reject(() => family.authorize(db, identity, { ...operation, details: { ...operation.details, lines: [{ ...operation.details.lines[0], catalogItemId: 99 }] } }, helpers, input), 404);
  db.catalog[0].companyId = B; reject(() => family.authorize(db, identity, operation, helpers, input), 409);
  delete db.catalog[0].companyId; db.catalog[0].privateToken = 'forbidden'; reject(() => family.authorize(db, identity, operation, helpers, input), 409);
  delete db.catalog[0].privateToken; db.catalog[0].targetHoursPerUnit = Infinity; reject(() => family.authorize(db, identity, operation, helpers, input), 409);
});
test('Malformed fixed pricing source cannot become a grant through legacy default coercion', () => {
  for (const policy of [{ enabled: 'false', officeMode: 'all', userIds: [] }, { enabled: true, officeMode: 'invalid', userIds: [] }, { enabled: true, officeMode: 'selected', userIds: {} }, { enabled: true, officeMode: 'all', userIds: [], genericGrants: { pricing: true } }]) {
    const db = seed(); db.company.pricingAccess = policy; reject(() => family.authorize(db, auth(db, 'project_manager'), op(...rows[7]), helpers, input), 409);
  }
});
test('Actual import budget null/zero/omission and unknown selling amount remain distinct', async () => {
  const db = seed(), identity = auth(db);
  for (const [value, expected] of [[null, null], [0, 0], [2.345, 2.35], [undefined, 1.25]]) {
    const line = { description: 'Wall tile', quantity: 10, unit: 'SF', amount: null, catalogItemId: 10 }; if (value !== undefined) line.budgetHours = value;
    const operation = op('estimateImportApprove', 'POST', '/api/estimate-imports/7/approve', { projectId: 101, lines: [line] }), result = await actual(db, identity, operation), checked = family.validate(db, result.candidate, operation, identity, helpers, input);
    assert.equal(checked.data.items[0].budgetHours, expected); assert.equal(checked.data.items[0].cost, null); assert.equal(checked.data.items[0].sourceImportId, 7);
    reject(() => family.authorize(result.candidate, identity, operation, helpers, input), 409);
  }
});
test('Actual zero-row saved draft preserves all estimates and finite private document DTO', async () => {
  const db = seed(), identity = auth(db, 'project_manager'), operation = op('estimateImportDraft', 'PATCH', '/api/estimate-imports/7/draft', { projectId: 101, lines: [] });
  const result = await actual(db, identity, operation), checked = family.validate(db, result.candidate, operation, identity, helpers, input);
  assert.deepEqual(result.candidate.projects, db.projects); assert.deepEqual(checked.data.reviewedLines, []); assert.equal(checked.data.textPreview, undefined); assert.equal(checked.data.privateMarker, undefined);
});
test('Closed complete deltas reject users/policies/history/unrelated project/import/rate/source corruption', async () => {
  for (const row of rows) {
    const db = seed(), operation = op(...row), identity = auth(db), result = await actual(db, identity, operation);
    for (const mutation of [
      next => { next.users[0].role = 'admin'; }, next => { next.company.genericPermissions = { owner: true }; },
      next => { next.reports[0].status = 'Needs review'; }, next => { next.projects[1].name = 'Foreign changed'; },
      next => { next.projects[0].rateSettingsHistory[0].reason = 'Rewritten history'; }, next => { next.auditLog.push({ id: 'bad' }); },
      next => { next.estimateImports[1].projectId = 101; }, next => { next.projects[0].privateContext = 'New private field'; }
    ]) { const poisoned = structuredClone(result.candidate); mutation(poisoned); reject(() => family.validate(db, poisoned, operation, identity, helpers, input), 409); }
  }
});
test('Selected item/proposal/import identities and outcome fields cannot be changed by a malicious handler', async () => {
  for (const [index, mutate] of [
    [0, next => { next.projects[0].estimateItems.at(-1).sourceImportId = 999; }],
    [1, next => { next.projects[0].estimateItems[1].id = 99; }],
    [4, next => { next.projects[0].estimateProposals.at(-1).sourceFile = { url: '/uploads/evil' }; }],
    [5, next => { next.projects[0].estimateItems.at(-1).sourceProposalId = 999; }],
    [6, next => { next.estimateImports[0].url = '/uploads/replaced.pdf'; }],
    [7, next => { next.projects[0].estimateItems.at(-1).budgetHours = 99; }]
  ]) { const db = seed(), operation = op(...rows[index]), identity = auth(db), result = await actual(db, identity, operation); mutate(result.candidate); reject(() => family.validate(db, result.candidate, operation, identity, helpers, input), 409); }
});
test('Current return respects revoked scope/pricing and replay never exposes numeric ID reincarnations', async () => {
  const db = seed(), identity = auth(db, 'project_manager'), operation = op(...rows[7]), result = await actual(db, identity, operation), checked = family.validate(db, result.candidate, operation, identity, helpers, input), receipt = { id: 'receipt', operation, result: checked.data, retained: checked.retained };
  assert.equal(family.currentResult(result.candidate, identity, receipt, true, helpers, input).items.length, 2);
  const noScope = { user: { ...identity.user, projectIds: [202] } }; assert.deepEqual(family.currentResult(result.candidate, noScope, receipt, true, helpers, input), { id: 7, receiptId: 'receipt' });
  result.candidate.company.pricingAccess.enabled = false; assert.deepEqual(family.currentResult(result.candidate, identity, receipt, true, helpers, input), { id: 7, receiptId: 'receipt' });
  result.candidate.estimateImports[0] = { id: 7, status: 'Approved', projectId: 101, createdAt: '2099-01-01T00:00:00.000Z', privateContext: 'Reused numeric ID' };
  assert.deepEqual(family.currentResult(result.candidate, identity, receipt, false, helpers, input), { id: 7, receiptId: 'receipt' });
  reject(() => family.currentResult(result.candidate, { user: { ...identity.user, role: 'field' } }, receipt, false, helpers, input), 403);
});
test('Saved import read retains actual Owner no-policy document fields and hides private source context', async () => {
  const db = seed(), identity = auth(db), actualRead = await actual(db, identity, { method: 'GET', path: '/api/estimate-imports?projectId=101', details: {} });
  assert.equal(actualRead.response.status, 200); assert.equal(actualRead.writes, 0);
  const data = family.readImports(db, identity.user, 101, helpers, input);
  assert.deepEqual(data, actualRead.response.data.map(family.importDTO)); assert.equal(data.length, 1); assert.equal(data[0].filename, 'Synthetic stored.pdf'); assert.deepEqual(data[0].lines, db.estimateImports[0].lines);
  for (const key of ['textPreview', 'privateMarker']) assert.equal(data[0][key], undefined);
});
test('Saved import read intersects current stored/request company/project/pricing scope without daily masks', () => {
  const db = seed(), manager = structuredClone(db.users[2]);
  manager.dailyAccess = Object.fromEntries(daily.actions.map(action => [action, false]));
  assert.equal(family.readImports(db, manager, 101, helpers, input).length, 1);
  reject(() => family.readImports(db, manager, 202, helpers, input), 404);
  reject(() => family.readImports(db, { ...manager, companyId: B }, 101, helpers, input), 404);
  reject(() => family.readImports(db, db.users[3], 101, helpers, input), 403);
  db.users[2].projectIds = []; reject(() => family.readImports(db, manager, 101, helpers, input), 404);
  db.users[2].projectIds = [101]; db.company.pricingAccess.enabled = false; reject(() => family.readImports(db, manager, 101, helpers, input), 403);
  reject(() => family.readImports(db, manager, '101', helpers, input), 403);
});
test('Saved import read rejects foreign or ambiguous document source and retains no cross-project/unassigned drafts', () => {
  const db = seed(), manager = db.users[2], expected = family.readImports(db, manager, 101, helpers, input);
  db.estimateImports[1].textPreview = 'Changed hidden foreign draft'; db.estimateImports[2].lines = [{ description: 'Hidden unassigned draft' }];
  assert.deepEqual(family.readImports(db, manager, 101, helpers, input), expected);
  db.estimateImports[0].companyId = B; reject(() => family.readImports(db, manager, 101, helpers, input), 409);
  delete db.estimateImports[0].companyId; db.estimateImports.push({ ...db.estimateImports[0] }); reject(() => family.readImports(db, manager, 101, helpers, input), 409);
});
