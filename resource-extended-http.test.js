'use strict';
// Real shared resource admission and named server handlers; one owned memory
// tenant, synthetic provider only, no PG/browser/external service or .env load.
const assert = require('node:assert/strict'), crypto = require('node:crypto');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const { A, B, initial, credential, snapshot, memory } = require('./compat-account-fixture');
const { services } = require('./compat-lifecycle-fixture');
const { canonicalHash } = require('./database/transactional-repository');
const registry = require('./capability-registry');
const { createCompliance, jobs } = require('./compat-workspace-delivery');
const business = db => canonicalHash(Object.fromEntries(['company', 'projects', 'dailyTemplates', 'subcontractors', 'subcontractorLinks', 'reports', 'assignments', 'timeCards', 'team', jobs].filter(key => Object.hasOwn(db, key)).map(key => [key, db[key]])));
const op = (kind, method, route, details) => ({ kind, method, path: route, details });
async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-resource-extended-http-synthetic-'));
  const file = path.join(dir, 'legacy.json'), platformFile = path.join(dir, 'platform.json');
  const legacy = snapshot(); legacy.company.id = B; legacy.users[0].companyId = B;
  fs.writeFileSync(file, JSON.stringify(legacy)); fs.writeFileSync(platformFile, JSON.stringify({ users: [], sessions: [] }));
  const legacyBytes = fs.readFileSync(file), platformBytes = fs.readFileSync(platformFile);
  for (const name of ['OPENAI_API_KEY', 'RESEND_API_KEY', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'SENTRY_DSN', 'SUPABASE_SECRET_KEY', 'PDL_PLATFORM_KEY']) process.env[name] = '';
  for (const name of ['PDL_COMPAT_GLOBAL_FENCE_FILE', 'DATABASE_URL', 'SUPABASE_URL', 'SUPABASE_ANON_KEY']) delete process.env[name];
  Object.assign(process.env, { NODE_ENV: 'test', PDL_COMPAT_ACCOUNT_SYNTHETIC: '1', PDL_REQUIRE_AUTH: '1', PDL_DB_FILE: file, PDL_PLATFORM_FILE: platformFile, PDL_SUPABASE_ENABLED: '0', PDL_TRANSACTIONAL_DB: 'off', PDL_WEEKLY_DIGEST: '0' });
  require('./database/supabase').loadLocalEnv = () => {};
  const mod = require('./server'); await new Promise(resolve => mod.server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + mod.server.address().port, realFetch = global.fetch, realNow = Date.now;
  let externalCalls = 0;
  global.fetch = (url, options) => { if (new URL(url).origin !== origin) { externalCalls++; throw Error('External fetch forbidden in extended synthetic HTTP fixture.'); } return realFetch(url, options); };
  const seed = snapshot(); seed.team[0].crew = 'Office'; seed.company.pricingAccess = { enabled: true, officeMode: 'all', userIds: [] };
  seed.projects[0].templateVersion = 1; seed.projects[0].templateIds = ['standard'];
  seed.projects.push({ id: 102, name: 'Separate synthetic project', estimateItems: [], templateId: 'standard', templateVersion: 1, templateIds: ['standard'] });
  for (const [id, role] of [[2, 'admin'], [3, 'project_manager'], [4, 'foreman'], [5, 'field']]) {
    seed.users.push({ id, companyId: A, memberId: id + 10, name: 'Synthetic ' + role, email: role + '@example.invalid', status: 'Active', role, ...credential(initial), projectIds: [101], assignedCrews: ['North'], permissions: { scheduleCrews: true, viewTime: true, manageTime: true, viewDailies: true, approveDailies: true } });
    seed.team.push({ id: id + 10, name: 'Synthetic ' + role, crew: role === 'admin' ? 'Office' : 'North', role: 'Employee', initials: 'SE', hours: 0 });
  }
  seed.crews = [{ id: 1, name: 'North' }];
  seed.reports = [{ id: 1, project: 0, date: '2026-10-01', dateIso: '2026-10-01', status: 'Draft', templateId: 'standard', templateVersion: 1, customFields: {}, notes: 'Synthetic historic report', laborEntries: [], history: [] }];
  const store = memory(seed), key = crypto.randomBytes(32), fixture = services(store, origin, { key });
  let providerCalls = 0, providerMode = 'unknown', releaseProvider, providerStarted;
  const send = async () => { providerCalls++; if (providerMode === 'hold') { providerStarted?.(); return new Promise(resolve => { releaseProvider = resolve; }); } return { status: providerMode }; };
  const uninstall = mod.installCompatibilityAccountTests({ synthetic: true, companyId: A, origin, globalOrigin: 'http://localhost:4999', repository: store, ...fixture, workspace: true, workspaceKey: key, complianceSend: send });
  const authenticateSession = (db, hash) => { const session = db.sessions.find(row => row.tokenHash === hash && Date.parse(row.expiresAt) > Date.now()), user = session && db.users.find(row => row.id === session.userId && row.status === 'Active'); return user ? { session, user: registry.actor(db, registry.normalize(user)), companyId: A } : null; };
  const serverSource = fs.readFileSync(require.resolve('./server'), 'utf8');
  const start = serverSource.indexOf('function subcontractorRequirements('), end = serverSource.indexOf('async function sendComplianceEmail(', start);
  assert.ok(start >= 0 && end > start);
  const requirements = vm.runInNewContext(serverSource.slice(start, end) + '\nsubcontractorRequirements', { Date });
  const compliance = createCompliance({ repository: store, companyId: A, key, requirements, send, authenticateSession, accountAccess: () => ({ locked: false, status: 'Active' }) });
  const tokens = {}, checks = []; let httpCalls = 0;
  const request = async (route, { method = 'GET', data, token = tokens.owner, tenant = A } = {}) => {
    const response = await fetch(origin + route, { method, signal: AbortSignal.timeout(10000), headers: { 'X-PDL-Company': tenant, ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(data !== undefined ? { 'Content-Type': 'application/json' } : {}) }, ...(data !== undefined ? { body: JSON.stringify(data) } : {}) });
    httpCalls++; return { status: response.status, value: await response.json(), response };
  };
  const login = async role => { const result = await request('/api/auth/login', { token: null, method: 'POST', data: { email: role + '@example.invalid', password: initial } }); assert.equal(result.status, 200, JSON.stringify(result.value)); return result.value.token; };
  const mutate = async fn => { const loaded = await store.load(A); fn(loaded.snapshot); await store.commit(loaded.snapshot, loaded.revision); };
  const preview = async (operation, token = tokens.owner) => { const current = await request('/api/workspace-identity', { token }); assert.equal(current.status, 200, JSON.stringify(current.value)); return request('/api/resources/preview', { token, method: 'POST', data: { operation, expectedRevision: current.value.revision, reason: 'Synthetic template/subcontractor review' } }); };
  const proof = reviewed => ({ token: reviewed.value.token, version: reviewed.value.version, confirmed: true, requestId: crypto.randomUUID() });
  const confirm = (operation, details, token = tokens.owner) => request(operation.path, { method: operation.method, data: details, token });
  const save = async (operation, token = tokens.owner) => { const before = business(store.current()), reviewed = await preview(operation, token); assert.equal(reviewed.status, 200, operation.kind + ': ' + JSON.stringify(reviewed.value)); assert.equal(business(store.current()), before, 'preview mutated business rows'); const p = proof(reviewed), saved = await confirm(operation, p, token); assert.ok([200, 201].includes(saved.status), operation.kind + ': ' + JSON.stringify(saved.value)); assert.ok(saved.response.headers.get('X-PDL-Resource-Receipt')); return { saved, reviewed, proof: p }; };
  const assertPrivate = value => { const source = JSON.stringify(value); for (const name of ['resourcePreviews', 'resourceReceipts', 'resourceReconciliations', 'workspaceComplianceJobs', 'tokenHash', 'complianceReminderStages', 'complianceHistory', 'synthetic-raw-guest-token']) assert.equal(source.includes('"' + name + '"'), false, 'private DTO key leaked: ' + name); };
  try {
    for (const role of ['owner', 'admin', 'project_manager', 'foreman', 'field']) tokens[role] = await login(role);
    const templateCreate = op('templateCreate', 'POST', '/api/daily-templates', { name: 'Synthetic field form', category: 'daily', fields: [{ label: 'Area reviewed', type: 'text', required: true, help: 'Synthetic evidence' }] });
    const rawBefore = business(store.current()); assert.equal((await confirm(templateCreate, templateCreate.details)).status, 400); assert.equal(business(store.current()), rawBefore);
    const created = await save(templateCreate); assert.equal(created.saved.value.id, 1); assert.equal(created.saved.value.versions[0].version, 1); assertPrivate(created.saved.value);
    const aux = await save({ ...templateCreate, details: { ...templateCreate.details, name: 'Unused synthetic form' } }, tokens.admin); assert.equal(aux.saved.value.id, 2);
    const templateEdit = op('templateEdit', 'PATCH', '/api/daily-templates/1', { name: 'Synthetic revised form', fields: [{ label: 'Area reviewed', type: 'text', required: true }, { label: 'Accepted', type: 'yesno' }] });
    const firstVersion = structuredClone(store.current().dailyTemplates[0].versions[0]), reportsHash = canonicalHash(store.current().reports);
    const edited = await save(templateEdit, tokens.admin); assert.equal(edited.saved.value.versions.at(-1).version, 2); assert.deepEqual(store.current().dailyTemplates[0].versions[0], firstVersion); assert.equal(canonicalHash(store.current().reports), reportsHash);
    const templateDefault = op('templateDefault', 'POST', '/api/daily-templates/default', { templateId: 1 }); await save(templateDefault);
    const binding = op('projectTemplates', 'PATCH', '/api/projects/101/template', { templateIds: [1, 'standard'] }); const bound = await save(binding, tokens.admin); assert.equal(bound.saved.value.templateVersion, 2); assert.deepEqual(bound.saved.value.templateIds, ['1', 'standard']);
    await save({ ...templateEdit, details: { name: 'Synthetic current third version', fields: [{ label: 'Area reviewed', type: 'text' }] } }, tokens.admin);
    assert.equal(store.current().projects[0].templateVersion, 2, 'later edits must retain the existing project pin');
    const replayRevision = store.revision(), replayCount = store.current().dailyTemplates[0].versions.length; const editReplay = await confirm(templateEdit, edited.proof, tokens.admin); assert.equal(editReplay.status, 200, JSON.stringify(editReplay.value)); assert.equal(editReplay.value.name, 'Synthetic current third version'); assert.equal(editReplay.value.versions.length, 3, 'replay must freshly project current data, not its cached saved version'); assert.equal(store.revision(), replayRevision); assert.equal(store.current().dailyTemplates[0].versions.length, replayCount);
    const bindingReplay = await confirm(binding, bound.proof, tokens.admin); assert.equal(bindingReplay.status, 200, JSON.stringify(bindingReplay.value)); assert.equal(bindingReplay.value.templateId, undefined); assert.equal(bindingReplay.value.id, 101); assert.equal(store.revision(), replayRevision);
    for (const details of [{ templateIds: ['1', 1] }, { templateIds: ['foreign'] }, { templateIds: [1], permissions: { owner: true } }]) assert.equal((await preview({ ...binding, details })).status, 400);
    assert.equal((await preview({ ...binding, path: '/api/projects/999/template' })).status, 404); assert.equal((await preview({ ...binding, details: { templateIds: [999] } })).status, 404);
    const remove = op('templateRemove', 'DELETE', '/api/daily-templates/1', {}); assert.equal((await preview(remove)).status, 409);
    assert.equal((await preview({ ...templateEdit, path: '/api/daily-templates/standard' })).status, 409);
    const unusedRemove = op('templateRemove', 'DELETE', '/api/daily-templates/2', {});
    for (const bindReference of [db => { db.company.defaultTemplateId = 2; }, db => { db.projects[0].templateId = 2; db.projects[0].templateVersion = 1; }, db => { db.projects[0].templateIds.push('2'); }, db => { db.reports[0].templateId = 2; }]) {
      const source = store.current(); await mutate(bindReference); assert.equal((await preview(unusedRemove)).status, 409);
      await mutate(db => { db.company.defaultTemplateId = source.company.defaultTemplateId; db.projects = source.projects; db.reports = source.reports; });
    }
    await save(op('templateRemove', 'DELETE', '/api/daily-templates/2', {}), tokens.admin); assert.equal(store.current().dailyTemplates.some(row => row.id === 2), false);
    checks.push('template create/edit/default/bind/remove use real signed previews; prior versions, pinned reports, in-use protections, exact binding and technical replay retained');

    const subCreate = op('subcontractorCreate', 'POST', '/api/subcontractors', { name: 'Synthetic trade partner', email: 'trade@example.invalid', phone: '555-123-4567', trade: 'Concrete', autoComplianceReminders: false });
    const subCreated = await save(subCreate, tokens.admin); assert.equal(subCreated.saved.value.id, 1); assertPrivate(subCreated.saved.value);
    const profile = op('subcontractorProfile', 'PATCH', '/api/subcontractors/1/profile', { contact: 'Synthetic Contact', notes: 'Office reviewed profile' }); await save(profile);
    const subCompliance = op('subcontractorCompliance', 'PATCH', '/api/subcontractors/1', { w9Received: true, agreementSigned: true, autoComplianceReminders: false }); await save(subCompliance, tokens.admin);
    const guestHash = crypto.createHash('sha256').update('synthetic-raw-guest-token').digest('hex');
    await mutate(db => { db.subcontractorLinks.push({ id: 'synthetic-guest-link', projectId: 101, subcontractorId: 1, mode: 'daily', status: 'Active', tokenHash: guestHash, createdAt: '2026-10-01T00:00:00.000Z', expiresAt: '2030-01-01T00:00:00.000Z' }); });
    const historyBefore = structuredClone(store.current().subcontractors[0].complianceHistory), archive = op('subcontractorArchive', 'PATCH', '/api/subcontractors/1/archive', { archived: true, reason: 'Synthetic archive review' });
    const archived = await save(archive); assert.equal(archived.saved.value.status, 'Archived'); assertPrivate(archived.saved.value); assert.equal(store.current().subcontractorLinks[0].status, 'Revoked'); assert.equal(store.current().subcontractorLinks[0].tokenHash, guestHash); assert.deepEqual(store.current().subcontractors[0].complianceHistory.slice(0, historyBefore.length), historyBefore); assert.equal(canonicalHash(store.current().reports), reportsHash);
    const archiveRevision = store.revision(); assert.equal((await confirm(archive, archived.proof)).status, 200); assert.equal(store.revision(), archiveRevision);
    await save({ ...archive, details: { archived: false } }, tokens.admin); assert.equal(store.current().subcontractorLinks[0].status, 'Revoked', 'restore must not silently restore guest access');
    for (const details of [{ email: 'private@example.invalid' }, { permissions: { owner: true } }, { projectIds: [102] }]) assert.equal((await preview({ ...subCompliance, details })).status, 400);
    assert.equal((await preview({ ...profile, path: '/api/subcontractors/999/profile' })).status, 404);
    checks.push('subcontractor create/profile/compliance/archive retain history, revoke active guest links, avoid automatic access restoration and exclude secrets/private stages from DTOs');

    const allNine = [templateCreate, templateEdit, templateDefault, binding, op('templateRemove', 'DELETE', '/api/daily-templates/999', {}), subCreate, profile, subCompliance, archive];
    for (const operation of allNine) for (const role of ['project_manager', 'foreman', 'field']) { const before = business(store.current()); assert.equal((await preview(operation, tokens[role])).status, 403, operation.kind + ' widened ' + role); assert.equal(business(store.current()), before); }
    await mutate(db => { db.company.features.templates = false; }); assert.equal((await preview(templateCreate)).status, 404); await mutate(db => { db.company.features.templates = true; });
    const tenantBefore = business(store.current()), identityBefore = store.revision(); const foreign = await request('/api/resources/preview', { method: 'POST', tenant: B, data: { operation: templateCreate, expectedRevision: identityBefore, reason: 'Synthetic foreign company attack' } }); assert.ok([401, 403, 404, 409].includes(foreign.status), JSON.stringify(foreign.value)); assert.equal(business(store.current()), tenantBefore);
    checks.push('all nine retain fixed Owner/Admin authority; PM permissions and project scope cannot grant them; feature disable and foreign tenant/target attempts fail closed');

    const competing = await preview(templateCreate); assert.equal(competing.status, 200); const competingProof = proof(competing); await save({ ...templateCreate, details: { name: 'CAS competitor', fields: [] } }); const beforeConflict = business(store.current()); assert.equal((await confirm(templateCreate, competingProof)).status, 409); assert.equal(business(store.current()), beforeConflict);
    const expiredPreview = await preview(profile); assert.equal(expiredPreview.status, 200); const expirySnapshot = canonicalHash(store.current()), expiryRevision = store.revision();
    Date.now = () => Date.parse(expiredPreview.value.expiresAt) + 1;
    try { assert.equal((await confirm(profile, proof(expiredPreview))).status, 409); } finally { Date.now = realNow; }
    assert.equal(canonicalHash(store.current()), expirySnapshot); assert.equal(store.revision(), expiryRevision);
    const revoked = await preview(profile, tokens.admin); assert.equal(revoked.status, 200); await mutate(db => { db.users.find(row => row.id === 2).role = 'project_manager'; }); const roleBefore = business(store.current()); const roleResult = await confirm(profile, proof(revoked), tokens.admin); assert.ok([403, 409].includes(roleResult.status), JSON.stringify(roleResult.value)); assert.equal(business(store.current()), roleBefore); await mutate(db => { db.users.find(row => row.id === 2).role = 'admin'; });
    const expired = await preview(profile, tokens.admin); assert.equal(expired.status, 200); const adminHash = crypto.createHash('sha256').update(tokens.admin).digest('hex'); await mutate(db => { db.sessions.find(row => row.tokenHash === adminHash).expiresAt = new Date(realNow() - 1000).toISOString(); }); const sessionBefore = business(store.current()); assert.equal((await confirm(profile, proof(expired), tokens.admin)).status, 401); assert.equal(business(store.current()), sessionBefore); tokens.admin = await login('admin');
    checks.push('competing revisions, changed management role and expired session revoke first confirmation without modifying business rows');

    const ownerHash = crypto.createHash('sha256').update(tokens.owner).digest('hex'); let sessionDeadline;
    await mutate(db => { const session = db.sessions.find(row => row.tokenHash === ownerHash); sessionDeadline = realNow() + 5000; session.expiresAt = new Date(sessionDeadline).toISOString(); });
    const inFlight = await preview({ ...profile, details: { notes: 'Must never commit after deadline' } }); assert.equal(inFlight.status, 200); const inFlightProof = proof(inFlight), deadlineBefore = canonicalHash(store.current());
    store.beforeCommit = candidate => { if (candidate.resourceReceipts?.some(row => row.requestId === inFlightProof.requestId)) Date.now = () => sessionDeadline + 1; };
    try { assert.equal((await confirm(profile, inFlightProof)).status, 409); } finally { Date.now = realNow; store.beforeCommit = null; }
    assert.equal(canonicalHash(store.current()), deadlineBefore); await mutate(db => { db.sessions.find(row => row.tokenHash === ownerHash).expiresAt = new Date(realNow() + 600000).toISOString(); });
    checks.push('a real signed confirmation delayed past its originating session deadline rolls back business, audit, receipt and revision at the memory CAS guard');

    const lostOperation = { ...profile, details: { notes: 'Synthetic acknowledgement loss saved once' } }, lostPreview = await preview(lostOperation); assert.equal(lostPreview.status, 200); const lostProof = proof(lostPreview); store.loseCommitAck = true; assert.equal((await confirm(lostOperation, lostProof)).status, 503);
    assert.equal(store.current().subcontractors[0].notes, lostOperation.details.notes); const lostRevision = store.revision(), lostHistory = store.current().subcontractors[0].complianceHistory.length;
    const lookup = { token: lostProof.token, version: lostProof.version, requestId: lostProof.requestId, method: lostOperation.method, path: lostOperation.path };
    const recovered = await request('/api/resources/original-result', { method: 'POST', data: lookup }); assert.equal(recovered.status, 200, JSON.stringify(recovered.value)); assert.equal(recovered.value.receipt.status, 'committed'); assert.equal(recovered.value.notes, undefined); assertPrivate(recovered.value); assert.equal(store.revision(), lostRevision); assert.equal(store.current().subcontractors[0].complianceHistory.length, lostHistory);
    const otherSession = await login('owner'); const afterLoginRevision = store.revision(); assert.equal((await request('/api/resources/original-result', { method: 'POST', token: otherSession, data: lookup })).status, 409); assert.equal(store.revision(), afterLoginRevision);
    checks.push('lost COMMIT acknowledgement recovers the original technical result without another mutation; a different originating session cannot replay its receipt');

    await save({ ...profile, details: { autoComplianceReminders: true, w9Received: false, agreementSigned: false } });
    async function stageJob() { const loaded = await store.load(A), auth = authenticateSession(loaded.snapshot, ownerHash); assert.ok(auth); assert.equal(compliance.stage(loaded.snapshot, { auth }), true); await store.commit(loaded.snapshot, loaded.revision); return store.current()[jobs].at(-1).id; }
    const queuedId = await stageJob(); assert.equal(store.current()[jobs].find(row => row.id === queuedId).status, 'queued'); const queuedBefore = canonicalHash(store.current()[jobs]);
    const cancellation = await preview({ ...profile, details: { contact: 'Cancellation reviewed contact' } }); assert.equal(cancellation.status, 200, JSON.stringify(cancellation.value)); assert.equal(canonicalHash(store.current()[jobs]), queuedBefore); assert.equal(providerCalls, 0);
    const cancelProof = proof(cancellation), beforeCancel = canonicalHash(store.current()), beforeCancelRevision = store.revision(); store.rejectCommit = true;
    try { assert.equal((await confirm(profile, cancelProof)).status, 409); } finally { store.rejectCommit = false; }
    assert.equal(canonicalHash(store.current()), beforeCancel); assert.equal(store.revision(), beforeCancelRevision); assert.equal(store.current()[jobs].find(row => row.id === queuedId).status, 'queued');
    const cancelled = await confirm(profile, cancelProof); assert.equal(cancelled.status, 200, JSON.stringify(cancelled.value)); assert.equal(store.current()[jobs].find(row => row.id === queuedId).status, 'cancelled'); assert.equal(providerCalls, 0);
    const privateReceipt = store.current().resourceReceipts.find(row => row.requestId === cancelProof.requestId); assert.equal(privateReceipt.retained.complianceJobs[0].status, 'queued'); assert.equal(privateReceipt.retained.complianceJobs[0].proof.length, 64);
    checks.push('actual signed queued reminder stays unchanged during pure preview, then cancellation and exact beforeimage commit atomically with the reviewed resource change');

    providerMode = 'hold'; const sendingId = await stageJob(); let started; const providerStart = new Promise(resolve => { started = resolve; }); providerStarted = started;
    const dispatch = compliance.dispatch(sendingId); await Promise.race([providerStart, new Promise((_, reject) => { const timer = setTimeout(() => reject(Error('Synthetic provider did not start')), 5000); timer.unref?.(); })]);
    assert.equal(store.current()[jobs].find(row => row.id === sendingId).status, 'sending');
    for (const operation of [profile, subCompliance, archive]) assert.equal((await preview(operation)).status, 409);
    releaseProvider({ status: 'unknown' }); const uncertain = await dispatch; assert.equal(uncertain.status, 'uncertain'); assert.equal(providerCalls, 1);
    for (const operation of [profile, subCompliance, archive]) assert.equal((await preview(operation)).status, 409);
    const beforeRestage = canonicalHash(store.current()), noResend = await compliance.dispatch(sendingId); assert.equal(noResend.status, 'uncertain'); assert.equal(providerCalls, 1); assert.equal(canonicalHash(store.current()), beforeRestage);
    checks.push('real sending/uncertain signed reminder blocks all three management writers and repeated dispatch cannot retry the synthetic provider');
    const state = await request('/api/state'); assert.equal(state.status, 200, JSON.stringify(state.value)); assertPrivate(state.value); assert.equal(providerCalls, 1);
    const directory = await request('/api/subcontractors'); assert.equal(directory.status, 503, 'the unintegrated directory GET remains fenced; current directory is in finite /api/state'); assertPrivate(directory.value);
    assert.deepEqual(fs.readFileSync(file), legacyBytes); assert.deepEqual(fs.readFileSync(platformFile), platformBytes); assert.equal(externalCalls, 0);
    console.log(JSON.stringify({ passed: checks.length, httpCalls, syntheticProviderCalls: providerCalls, allowedExternalCalls: externalCalls, checks }));
  } finally {
    Date.now = realNow; store.beforeCommit = null; releaseProvider?.({ status: 'unknown' }); global.fetch = realFetch;
    uninstall(); await new Promise(resolve => mod.server.close(resolve));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
