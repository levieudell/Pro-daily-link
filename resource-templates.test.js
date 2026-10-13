'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const input = require('./resource-inputs');
const family = require('./resource-templates');
const { canonicalHash } = require('./database/transactional-repository');
const owner = { user: { id: 1, role: 'owner', name: 'Synthetic Owner', status: 'Active' } };
const admin = { user: { id: 2, role: 'admin', name: 'Synthetic Admin', status: 'Active', permissions: {} } };
const base = () => ({ company: { id: 'synthetic-template-company', features: { templates: true } }, users: [owner.user, admin.user], dailyTemplates: [], projects: [{ id: 101, name: 'Synthetic Project', code: 'SYN', customerId: 21 }], reports: [{ id: 1, project: 0, templateId: 'standard', templateVersion: 1, customFields: {} }], team: [], sessions: [], assignments: [] });
const operation = (method, path, details) => family.parse({ kind: family.route(method, path), method, path, details }, input);
const denied = (fn, code) => assert.throws(fn, error => error.statusCode === code);
let checks = 0;
function check(name, fn) { fn(); checks++; }
// Execute the real named handler and its real normalizers over an isolated
// candidate. This is neither a rewritten effect simulator nor a disk/PG writer.
const serverSource = fs.readFileSync(require.resolve('./server'), 'utf8');
const source = serverSource.slice(serverSource.indexOf('const CORE_TEMPLATE_FIELDS='), serverSource.indexOf('function timeCardCsv('));
async function candidate(before, op, auth = owner) {
  let db = structuredClone(before), dirty = false, response;
  const scope = { process: { env: { PDL_REQUIRE_AUTH: '1' } }, console, Date, Set, Number, String, Array, Object,
    readDb: () => db, writeDb: value => { db = value; dirty = true; }, body: async req => structuredClone(req.details),
    json: (res, status, data) => { response = { status, data }; }, nextId: rows => rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1 };
  vm.runInNewContext(source + '\nthis.run = handleDailyTemplates;', scope, { filename: 'actual-template-handler.synthetic.js' });
  const handled = await scope.run({ method: op.method, details: op.details, auth }, {}, new URL(op.path, 'http://127.0.0.1'));
  assert.equal(handled, true); assert.ok(response);
  // Realm objects do not share prototypes; JSON is the actual HTTP boundary.
  return { after: JSON.parse(JSON.stringify(db)), response: JSON.parse(JSON.stringify(response)), dirty };
}
async function apply(before, op, auth = owner) {
  family.authorize(before, auth, op, {}, input);
  const result = await candidate(before, op, auth);
  assert.ok([200, 201].includes(result.response.status), JSON.stringify(result.response)); assert.equal(result.dirty, true);
  return { ...result, checked: family.validate(before, result.after, op, auth, {}, input) };
}
async function main() {
  check('finite routes', () => {
    for (const [method, path] of [['POST', '/api/daily-templates/generate'], ['PATCH', '/api/daily-templates/default'], ['POST', '/api/daily-templates/1'], ['PATCH', '/api/projects/0/template'], ['PATCH', '/api/projects/01/template'], ['PATCH', '/api/daily-templates/1?tenant=foreign'], ['PATCH', '/api/daily-templates/%31'], ['DELETE', '/api/daily-templates/__proto__']]) assert.equal(family.route(method, path), null);
  });
  check('closed operation envelope and identities', () => {
    for (const raw of [null, { kind: 'templateCreate', method: 'POST', path: '/api/daily-templates', details: { name: 'Test' }, flag: true }, { kind: 'templateEdit', method: 'POST', path: '/api/daily-templates', details: { name: 'Test' } }]) denied(() => family.parse(raw, input), 400);
    for (const d of [{ name: 'Test', id: 5 }, { name: 'Test', locked: true }, { name: 'Test', versions: [] }, { name: 'Test', companyId: 'foreign' }, { name: 'Test', permissions: { templates: true } }, { name: 'x'.repeat(81) }, { name: 'Test', category: 'platform' }, { name: 'Test', requirements: { photo: 'true' } }, { name: 'Test', assignment: { userIds: [1] } }]) denied(() => operation('POST', '/api/daily-templates', d), 400);
  });
  check('fixed immutable roles', () => {
    const op = operation('POST', '/api/daily-templates', { name: 'Test' });
    for (const role of ['project_manager', 'foreman', 'field', 'crew', 'platform', 'office']) denied(() => family.authorizeActor({ user: { id: 4, role, status: 'Active', permissions: { templates: true, manageTemplates: true } } }, op, input), 403);
    denied(() => family.authorizeActor({ user: { ...owner.user, status: 'Inactive' } }, op, input), 403);
    family.authorizeActor(owner, op, input); family.authorizeActor(admin, op, input);
    const disabled = base(); disabled.company.features.templates = false; denied(() => family.authorize(disabled, owner, op, {}, input), 404);
    denied(() => family.authorize(base(), { user: { ...owner.user, companyId: 'foreign-company' } }, op, {}, input), 403);
  });
  check('field replacement and malformed options rejected', () => {
    for (const fields of [[{ label: 'Labor entries', type: 'text' }], [{ label: 'Site', id: 'job', type: 'text' }], [{ label: 'Same!', type: 'text' }, { label: 'same', type: 'number' }], [{ label: 'Site', type: 'password' }], [{ label: 'Site', type: 'text', required: 'true' }], [{ label: 'Site', type: 'text', showWhen: { fieldId: 'missing', value: 'yes' } }], [{ label: 'Choice', type: 'dropdown', options: ['One'] }], [{ label: 'Choice', type: 'dropdown', options: ['One', 'One'] }], [{ label: 'Choice', type: 'dropdown', options: ['One', 'x'.repeat(201)] }], Array.from({ length: 41 }, (_, i) => ({ label: 'Field ' + i, type: 'text' }))]) denied(() => operation('POST', '/api/daily-templates', { name: 'Test', fields }), 400);
    denied(() => operation('POST', '/api/daily-templates', { name: 'Test', fields: [{ label: 'One', type: 'yesno', showWhen: { fieldId: 'two', value: 'yes' } }, { label: 'Two', type: 'yesno', showWhen: { fieldId: 'one', value: 'no' } }] }), 400);
  });
  const create = operation('POST', '/api/daily-templates', { name: 'Synthetic safety', category: 'safety', description: 'Synthetic review', reviewNotice: 'Unreviewed claim', requirements: { photo: true, signature: true, acknowledgement: true }, assignment: { crewNames: ['North'], workTypes: ['Concrete'] }, fields: [{ label: 'Crew reviewed', type: 'checkbox', required: true }, { label: 'Corrective action needed', type: 'yesno', required: true }, { label: 'Corrective action details', type: 'longtext', showWhen: { fieldId: 'corrective-action-needed', value: 'yes' } }, { label: 'Location', type: 'dropdown', options: 'East, West' }] });
  check('normalization is idempotent', () => { assert.deepEqual(family.parse(create, input), create); assert.match(create.details.reviewNotice, /does not certify/); assert.deepEqual(create.details.fields.at(-1).options, ['East', 'West']); });
  const original = base(), created = await apply(original, create), template = created.after.dailyTemplates[0]; checks++;
  assert.equal(template.id, 1); assert.equal(template.versions[0].version, 1); assert.deepEqual(created.checked.retained, {}); assert.equal(original.dailyTemplates.length, 0);
  const deniedCandidate = await candidate(original, create, { user: { ...owner.user, role: 'project_manager', permissions: { manageTemplates: true } } }); assert.equal(deniedCandidate.response.status, 403); assert.equal(deniedCandidate.dirty, false); checks++;
  check('candidate mutation cannot escape template creation', () => {
    for (const mutate of [db => { db.users[0].role = 'admin'; }, db => { db.company.features.templates = false; }, db => { db.reports[0].templateVersion = 999; }, db => { db.dailyTemplates[0].versions[0].createdBy = 'Someone else'; }, db => { db.dailyTemplates[0].locked = true; }, db => { db.dailyTemplates[0].providerKey = 'not-a-template-field'; }, db => { db.dailyTemplates[0].versions[0].version = 2; }]) { const after = structuredClone(created.after); mutate(after); denied(() => family.validate(original, after, create, owner, {}, input), 409); }
  });
  const edit = operation('PATCH', '/api/daily-templates/1', { name: 'Synthetic safety revised', fields: [{ label: 'Crew reviewed', type: 'checkbox', required: true }] });
  const pinned = structuredClone(created.after); pinned.projects[0].templateId = 1; pinned.projects[0].templateVersion = 1; pinned.projects[0].templateIds = ['1']; pinned.reports[0].templateId = 1;
  const edited = await apply(pinned, edit, admin); checks++;
  assert.equal(edited.after.dailyTemplates[0].versions.at(-1).version, 2); assert.deepEqual(edited.after.dailyTemplates[0].versions[0], template.versions[0]); assert.deepEqual(edited.after.projects, pinned.projects); assert.deepEqual(edited.after.reports, pinned.reports); assert.deepEqual(edited.checked.retained.template, template);
  check('version history and unrelated template changes rejected', () => {
    for (const mutate of [db => { db.dailyTemplates[0].versions[0].fields = []; }, db => { db.dailyTemplates[0].versions.at(-1).version = 8; }, db => { db.dailyTemplates[0].versions.at(-1).createdAt = 'tomorrow'; }, db => { db.projects[0].templateVersion = 2; }, db => { db.reports[0].templateVersion = 2; }, db => { db.dailyTemplates.push({ id: 2 }); }]) { const after = structuredClone(edited.after); mutate(after); denied(() => family.validate(pinned, after, edit, admin, {}, input), 409); }
    for (const method of ['PATCH', 'DELETE']) denied(() => family.authorize(pinned, owner, operation(method, '/api/daily-templates/standard', method === 'PATCH' ? { name: 'Changed' } : {}), {}, input), 409);
  });
  const defaultOp = operation('POST', '/api/daily-templates/default', { templateId: 1 }), defaulted = await apply(edited.after, defaultOp); checks++;
  assert.equal(defaulted.after.company.defaultTemplateId, 1); assert.deepEqual(defaulted.checked.retained, { defaultTemplateId: { present: false } });
  check('default candidate changes only default ID', () => {
    const after = structuredClone(defaulted.after); after.company.features.templates = false; denied(() => family.validate(edited.after, after, defaultOp, owner, {}, input), 409);
    denied(() => family.authorize(edited.after, owner, operation('POST', '/api/daily-templates/default', { templateId: 999 }), {}, input), 404);
  });
  const secondDefault = await apply(defaulted.after, operation('POST', '/api/daily-templates/default', { templateId: 'standard' })); checks++;
  assert.deepEqual(secondDefault.checked.retained, { defaultTemplateId: { present: true, value: 1 } });
  const binding = operation('PATCH', '/api/projects/101/template', { templateIds: [1, 'standard'] }), bound = await apply(edited.after, binding); checks++;
  assert.equal(bound.after.projects[0].templateId, 1); assert.equal(bound.after.projects[0].templateVersion, 2); assert.deepEqual(bound.after.projects[0].templateIds, ['1', 'standard']); assert.deepEqual(bound.after.reports, edited.after.reports);
  check('binding delivers first fresh tuple and technical replay', () => {
    const receipt = { id: 'binding-receipt', operation: binding, result: bound.checked.data, retained: bound.checked.retained };
    assert.deepEqual(family.currentResult(bound.after, owner, receipt, true, {}, input), { ...bound.checked.data, receiptId: receipt.id });
    assert.deepEqual(family.currentResult(bound.after, owner, receipt, false, {}, input), { id: 101, receiptId: receipt.id });
    const reused = structuredClone(bound.after); reused.projects[0].name = 'Replacement project'; assert.deepEqual(family.currentResult(reused, owner, receipt, true, {}, input), { id: 101, receiptId: receipt.id });
  });
  check('binding rejects foreign/missing IDs and candidate overreach', () => {
    for (const d of [{ templateIds: [1, '1'] }, { templateIds: ['foreign'] }, { templateIds: ['01'] }, { templateIds: [1], templateId: 1 }, { templateIds: [1], templateVersion: 999 }]) denied(() => operation('PATCH', '/api/projects/101/template', d), 400);
    denied(() => family.authorize(edited.after, owner, operation('PATCH', '/api/projects/102/template', { templateId: 1 }), {}, input), 404);
    denied(() => family.authorize(edited.after, owner, operation('PATCH', '/api/projects/101/template', { templateId: 999 }), {}, input), 404);
    const after = structuredClone(bound.after); after.projects[0].contractValue = 100; denied(() => family.validate(edited.after, after, binding, owner, {}, input), 409);
  });
  const empty = await apply(bound.after, operation('PATCH', '/api/projects/101/template', { templateIds: [] })); checks++;
  assert.equal(empty.after.projects[0].templateId, 'standard'); assert.equal(empty.after.projects[0].templateVersion, 1);
  const remove = operation('DELETE', '/api/daily-templates/1', {});
  check('every retained use prevents removal', () => {
    for (const bind of [db => { db.company.defaultTemplateId = 1; }, db => { db.projects[0].templateId = '1'; }, db => { db.projects[0].templateIds = ['1']; }, db => { db.reports[0].templateId = '1'; }]) { const db = structuredClone(created.after); bind(db); denied(() => family.authorize(db, owner, remove, {}, input), 409); }
    denied(() => operation('DELETE', '/api/daily-templates/1', { hardDelete: true }), 400);
  });
  const unused = structuredClone(created.after), deleted = await apply(unused, remove); checks++;
  assert.deepEqual(deleted.after.dailyTemplates, []); assert.deepEqual(deleted.checked.retained.template, unused.dailyTemplates[0]);
  check('delete cannot discard unrelated history', () => { const after = structuredClone(deleted.after); after.reports = []; denied(() => family.validate(unused, after, remove, owner, {}, input), 409); });
  check('fresh readback cannot serve cached or replacement template data', () => {
    const receipt = { id: 'synthetic-receipt', operation: create, result: created.checked.data, retained: {} };
    const current = family.currentResult(edited.after, owner, receipt, false, {}, input); assert.equal(current.name, 'Synthetic safety revised'); assert.equal(current.versions.length, 2);
    const reused = structuredClone(created.after); reused.dailyTemplates[0].name = 'Replacement'; reused.dailyTemplates[0].versions[0].createdAt = '2030-01-01T00:00:00.000Z';
    assert.deepEqual(family.currentResult(reused, owner, receipt, false, {}, input), { id: 1, receiptId: receipt.id });
    assert.deepEqual(family.currentResult(deleted.after, owner, receipt, false, {}, input), { id: 1, receiptId: receipt.id });
    denied(() => family.currentResult(edited.after, { user: { ...owner.user, role: 'field', permissions: { templates: true } } }, receipt, true, {}, input), 403);
    const disabled = structuredClone(edited.after); disabled.company.features.templates = false; denied(() => family.currentResult(disabled, owner, receipt, false, {}, input), 404);
    const outcome = family.currentResult(secondDefault.after, owner, { id: 'default-receipt', operation: defaultOp, result: { defaultTemplateId: 1 }, retained: {} }, false, {}, input); assert.equal(outcome.defaultTemplateId, 'standard');
    const poisoned = structuredClone(edited.after); poisoned.dailyTemplates[0].requirements.photo = 'secret'; denied(() => family.currentResult(poisoned, owner, receipt, false, {}, input), 409);
    denied(() => family.currentResult(edited.after, { user: { ...owner.user, companyId: 'foreign-company' } }, receipt, false, {}, input), 403);
  });
  assert.equal(canonicalHash(original), canonicalHash(base()));
  console.log(`Template resource contract passed ${checks} cases, including all five real named handler candidates.`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
