'use strict';
// Independent synthetic checks: actual memory HTTP handlers and the real legacy
// repair functions. No browser, provider adapter, or shared database is used.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { A, B, initial, credential, snapshot, memory } = require('./compat-account-fixture');
const { workspaceSnapshot } = require('./compat-workspace-fixture');
const { services } = require('./compat-lifecycle-fixture');
const { canonicalHash } = require('./database/transactional-repository');
const reconciliation = require('./compat-workspace-reconciliation');

const equal = (actual, expected, message) => assert.equal(canonicalHash(actual), canonicalHash(expected), message);
const changedKeys = (before, after) => [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(name => canonicalHash(before[name] ?? null) !== canonicalHash(after[name] ?? null));
const denied = fn => assert.throws(fn, error => error.statusCode === 409);

function legacyHelpers() {
  const lines = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8').split(/\r?\n/);
  const names = ['nextId', 'reportHasOpenUnplanned', 'draftKey', 'coalesceDuplicateDrafts', 'alignReportNarrative', 'purgeKnownTestCustomer', 'prepareWorkspace', 'ensureOwnerTeamMember'];
  const definitions = names.map(name => {
    const start = lines.findIndex(line => line.startsWith('function ' + name + '('));
    assert.ok(start >= 0, 'Actual legacy function exists: ' + name);
    if (lines[start].endsWith('}')) return lines[start];
    let end = start + 1;
    while (end < lines.length && !/^}\s*$/.test(lines[end])) end++;
    assert.ok(end < lines.length, 'Actual legacy function terminates: ' + name);
    return lines.slice(start, end + 1).join('\n');
  });
  const context = vm.createContext({});
  vm.runInContext(definitions.join('\n') + '\nglobalThis.helpers={prepareWorkspace,ensureOwnerTeamMember};', context, { filename: 'actual-server-reconciliation-functions.js' });
  return context.helpers;
}

function base() {
  const seed = workspaceSnapshot();
  seed.team[0].crew = 'Office';
  return seed;
}

function compoundSeed() {
  const seed = base();
  seed.projectPlans ||= [];
  seed.customers.push({ id: 22, name: ' ABC Test ', contact: 'Tester McTest' });
  seed.projects.push({ id: 202, name: 'Synthetic known test project', customerId: 22, crew: 'Synthetic Crew', status: 'Active', estimateItems: [] });
  seed.projects.push({ id: 303, name: 'Synthetic retained later project', customerId: 21, crew: 'Synthetic Crew', status: 'Active', estimateItems: [] });
  const draft = { ...structuredClone(seed.reports[0]), id: 2, status: 'Draft', workdayId: 5, notes: 'Synthetic duplicate draft', summary: 'Field work recorded: Synthetic unresolved work', flags: [{ id: 'unplanned', type: 'unplanned_work', message: 'Synthetic unresolved scope' }], history: [{ action: 'Draft retained', at: '2026-10-01T08:00:00.000Z', by: 'Synthetic Field' }], privateBeforeImage: { marker: 'synthetic-retained-before-image' } };
  seed.reports.push(draft, { ...structuredClone(draft), id: 3 }, { ...structuredClone(seed.reports[0]), id: 4, project: 1, workdayId: 6, notes: 'Synthetic known test work' }, { ...structuredClone(seed.reports[0]), id: 5, project: 2, workdayId: 7, summary: 'Synthetic retained summary. Unplanned work needs an office decision.' });
  seed.workdays.push({ id: 5, projectId: 101, memberIds: [12], reportId: 2, status: 'ended', startedAt: '2026-10-01T08:00:00Z', endedAt: '2026-10-01T10:00:00Z', history: [] }, { id: 6, projectId: 202, memberIds: [12], reportId: 4, status: 'ended', startedAt: '2026-10-01T08:00:00Z', endedAt: '2026-10-01T10:00:00Z', history: [] }, { id: 7, projectId: 303, memberIds: [12], reportId: 5, status: 'ended', startedAt: '2026-10-01T08:00:00Z', endedAt: '2026-10-01T10:00:00Z', history: [] });
  seed.photos.push({ id: 41, project: 0, projectId: 101, reportId: 2, workdayId: 5, uploader: 'Levi Foreman', caption: 'Synthetic redirected draft photo' }, { id: 42, project: 1, projectId: 202, reportId: 4, workdayId: 6, uploader: 'Synthetic Field', caption: 'Synthetic removed test photo' }, { id: 43, project: 2, projectId: 303, reportId: 5, workdayId: 7, uploader: 'Keep this uploader', caption: 'Synthetic retained later photo' }, { id: 44, project: 0, projectId: 101, reportId: 1, uploader: '', caption: 'Synthetic report-derived uploader' });
  seed.assignments.push({ ...structuredClone(seed.assignments[0]), id: 2, projectId: 202 });
  seed.timeCards.push({ id: 42, memberId: 12, projectId: 202, date: '2026-10-01', inAt: '2026-10-01T08:00:00Z', outAt: '2026-10-01T10:00:00Z', hours: 2, status: 'Draft', history: [] });
  seed.projectPlans.push({ id: 51, projectId: 202, name: 'Synthetic removed plan' });
  seed.projectTickets.push({ id: 61, projectId: 202, reportId: 4, status: 'Confirmed', history: [], lines: [] });
  seed.subcontractorLinks.push({ id: crypto.randomUUID(), projectId: 202, subcontractorId: 71, status: 'Active' });
  seed.changes.push({ id: 81, projectId: 202, description: 'Synthetic removed change' });
  seed.auditLog.push({ id: crypto.randomUUID(), projectId: 202, detail: 'Synthetic project ID audit' }, { id: crypto.randomUUID(), projectName: 'Synthetic known test project', detail: 'Synthetic project name audit' }, { id: crypto.randomUUID(), projectId: 101, detail: 'Synthetic retained audit' });
  seed.users.push({ id: 3, companyId: A, name: 'Synthetic PM', email: 'pm@example.invalid', status: 'Active', role: 'project_manager', ...credential(initial), projectIds: [101, 202], assignedCrews: ['Synthetic Crew'], permissions: { scheduleCrews: true, viewTime: true, manageTime: true, viewDailies: true, approveDailies: true } });
  return seed;
}

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-reconciliation-review-'));
  const file = path.join(directory, 'legacy.json');
  const legacy = snapshot(); legacy.company.id = B; legacy.users[0].companyId = B;
  fs.writeFileSync(file, JSON.stringify(legacy));
  const legacyBytes = fs.readFileSync(file), platformFile = path.join(directory, 'platform.json');
  for (const name of ['OPENAI_API_KEY', 'RESEND_API_KEY', 'STRIPE_SECRET_KEY', 'SENTRY_DSN', 'SUPABASE_SECRET_KEY', 'PDL_PLATFORM_KEY']) process.env[name] = '';
  Object.assign(process.env, { NODE_ENV: 'test', PDL_COMPAT_ACCOUNT_SYNTHETIC: '1', PDL_REQUIRE_AUTH: '1', PDL_DB_FILE: file, PDL_PLATFORM_FILE: platformFile, PDL_SUPABASE_ENABLED: '0', PDL_TRANSACTIONAL_DB: 'off' });
  const mod = require('./server');
  await new Promise(resolve => mod.server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + mod.server.address().port, key = crypto.randomBytes(32), helpers = legacyHelpers();
  const passed = [], failed = [];
  let uninstall, attemptedExternalCalls = 0, attemptedDeliveries = 0;
  const realFetch = global.fetch;
  global.fetch = (url, options) => {
    if (new URL(url).origin !== origin) { attemptedExternalCalls++; throw Error('External requests are forbidden in this test.'); }
    return realFetch(url, options);
  };
  async function check(name, fn) { try { await fn(); passed.push(name); } catch (error) { failed.push({ name, error: error.stack || String(error), ...(error.cause ? { cause: error.cause.stack || String(error.cause) } : {}) }); } }
  async function scenario(seed, email = 'owner@example.invalid') {
    uninstall?.();
    const store = memory(seed);
    const fixture = services(store, origin, { key, send: async () => { attemptedDeliveries++; throw Error('Credential delivery is forbidden in this test.'); } });
    uninstall = mod.installCompatibilityAccountTests({ synthetic: true, companyId: A, origin, globalOrigin: 'http://localhost:4999', repository: store, ...fixture, workspace: true, workspaceKey: key });
    let token;
    const request = async (route, method = 'GET', data, bearer = token) => {
      const response = await fetch(origin + route, { method, signal: AbortSignal.timeout(10000), headers: { 'X-PDL-Company': A, ...(bearer ? { Authorization: 'Bearer ' + bearer } : {}), ...(data !== undefined ? { 'Content-Type': 'application/json' } : {}) }, ...(data !== undefined ? { body: JSON.stringify(data) } : {}) });
      return { status: response.status, data: await response.json(), headers: response.headers };
    };
    const login = await request('/api/auth/login', 'POST', { email, password: initial });
    assert.equal(login.status, 200, JSON.stringify(login)); token = login.data.token;
    return { store, request, async mutate(fn) { const loaded = await store.load(A); fn(loaded.snapshot); await store.commit(loaded.snapshot, loaded.revision); } };
  }
  const ledger = reconciliation.createLedger(key, A);
  function signedRow() {
    const before = base(), after = structuredClone(before); after.team[0].crew = 'Repaired';
    ledger.append(after, before, before.users[0], 1, ['team']);
    return after.workspaceReconciliations[0];
  }
  function resign(row) {
    const copy = structuredClone(row); delete copy.proof;
    return { ...copy, proof: crypto.createHmac('sha256', key).update('legacy-workspace-reconciliation-v1:' + canonicalHash(copy)).digest('hex') };
  }
  try {
    await check('default no-policy stable state has no repair or revision change', async () => {
      const s = await scenario(base()), before = s.store.current(), revision = s.store.revision();
      const response = await s.request('/api/state');
      assert.equal(response.status, 200, JSON.stringify(response));
      assert.equal(s.store.revision(), revision); equal(s.store.current(), before);
      assert.equal(response.data.currentUser.memberId, before.users[0].memberId);
      assert.equal(response.headers.get('X-PDL-Workspace-Reconciled-From'), null);
      assert.equal(Object.hasOwn(s.store.current(), 'workspaceReconciliations'), false);
    });
    await check('no active Owner preserves normal Admin state parity', async () => {
      const seed = base(); seed.users[0].role = 'admin';
      const expected = structuredClone(seed); assert.equal(helpers.prepareWorkspace(expected), false); assert.equal(helpers.ensureOwnerTeamMember(expected), false);
      const s = await scenario(seed), before = s.store.current(), revision = s.store.revision(), response = await s.request('/api/state');
      assert.equal(response.status, 200, JSON.stringify(response)); assert.equal(response.data.currentUser.role, 'admin');
      assert.equal(s.store.revision(), revision); equal(s.store.current(), before);
    });
    await check('no active Owner still performs the exact named compound repairs', async () => {
      const seed = compoundSeed(); seed.users[0].role = 'admin';
      const s = await scenario(seed);
      for (let pass = 0; pass < 3; pass++) {
        const before = s.store.current(), expected = structuredClone(before), revision = s.store.revision();
        const prepared = helpers.prepareWorkspace(expected); assert.equal(helpers.ensureOwnerTeamMember(expected), false);
        const response = await s.request('/api/state'); assert.equal(response.status, 200, JSON.stringify(response));
        const saved = s.store.current(); equal(saved.team, before.team);
        for (const name of new Set([...Object.keys(expected), ...Object.keys(saved)])) if (!['workspaceReconciliations', 'auditLog'].includes(name)) equal(saved[name] ?? null, expected[name] ?? null, 'no-owner legacy parity: ' + name);
        assert.equal(s.store.revision(), revision + Number(prepared));
        if (prepared) { const record = ledger.valid(saved).at(-1); for (const name of record.changed) equal(record.previous[name], before[name] ?? null); }
      }
    });
    await check('multiple existing Owners remain readable when the first owner needs no member repair', async () => {
      const seed = base(); seed.users.push({ id: 3, companyId: A, name: 'Second Synthetic Owner', email: 'second-owner@example.invalid', role: 'owner', status: 'Active', ...credential(initial), projectIds: [], assignedCrews: [], permissions: {} });
      const expected = structuredClone(seed); assert.equal(helpers.ensureOwnerTeamMember(expected), false);
      const s = await scenario(seed), before = s.store.current(), revision = s.store.revision(), response = await s.request('/api/state');
      assert.equal(response.status, 200, JSON.stringify(response)); assert.equal(s.store.revision(), revision); equal(s.store.current(), before);
    });
    await check('first owner repair response presents the committed member link and controlled authority transition', async () => {
      const seed = base(); delete seed.users[0].memberId; seed.team = seed.team.filter(row => row.id !== 11);
      const s = await scenario(seed), identity = await s.request('/api/workspace-identity'), before = s.store.current(), revision = s.store.revision();
      const expected = structuredClone(before); assert.equal(helpers.prepareWorkspace(expected), false); assert.equal(helpers.ensureOwnerTeamMember(expected), true);
      const response = await s.request('/api/state'); assert.equal(response.status, 200, JSON.stringify(response));
      const saved = s.store.current(); assert.equal(saved.users[0].memberId, expected.users[0].memberId); assert.equal(response.data.currentUser.memberId, saved.users[0].memberId);
      equal(saved.team, expected.team); assert.equal(s.store.revision(), revision + 1);
      assert.equal(response.headers.get('X-PDL-Workspace-Reconciled-From'), identity.data.authority);
      assert.notEqual(response.headers.get('X-PDL-Workspace-Authority'), identity.data.authority);
      const row = ledger.valid(saved)[0]; equal(row.previous.users, before.users); equal(row.previous.team, before.team); assert.equal(row.sourceRevision, revision);
      assert.equal(Object.hasOwn(response.data, 'workspaceReconciliations'), false);
    });
    await check('real legacy helpers preserve ordered multipass compound repair and exact retained before-images', async () => {
      const s = await scenario(compoundSeed());
      for (let pass = 0; pass < 3; pass++) {
        const before = s.store.current(), revision = s.store.revision(), expected = structuredClone(before);
        const prepared = helpers.prepareWorkspace(expected), ownerChanged = helpers.ensureOwnerTeamMember(expected), changed = changedKeys(before, expected);
        const response = await s.request('/api/state'); assert.equal(response.status, 200, 'pass ' + pass + ': ' + JSON.stringify(response));
        const saved = s.store.current();
        for (const name of new Set([...Object.keys(expected), ...Object.keys(saved)])) if (!['workspaceReconciliations', 'auditLog'].includes(name)) equal(saved[name] ?? null, expected[name] ?? null, 'actual legacy parity: ' + name + ', pass ' + pass);
        if (prepared || ownerChanged) {
          assert.equal(s.store.revision(), revision + 1);
          equal(saved.auditLog.slice(0, -1), expected.auditLog); assert.equal(saved.auditLog.at(-1).type, 'workspace_reconciled');
          const record = ledger.valid(saved).at(-1); equal(record.changed.slice().sort(), changed.slice().sort());
          assert.equal(record.sourceHash, canonicalHash(before)); assert.equal(record.resultHash, canonicalHash(expected)); assert.equal(record.sourceRevision, revision);
          for (const name of changed) equal(record.previous[name], before[name] ?? null, 'exact before-image: ' + name);
        } else { assert.equal(s.store.revision(), revision); equal(saved, before); }
        if (pass === 0) {
          assert.ok(saved.customers.some(row => row.id === 22), 'Legacy short-circuit defers test-customer purge');
          assert.equal(saved.reports.some(row => row.id === 2), false); assert.equal(saved.photos.find(row => row.id === 41).reportId, 3);
          assert.equal(saved.workdays.find(row => row.id === 5).reportId, 3); assert.equal(saved.photos.find(row => row.id === 41).uploader, 'Synthetic Field');
          assert.match(saved.reports.find(row => row.id === 3).summary, /Unplanned work needs an office decision\./);
          assert.equal(saved.reports.find(row => row.id === 5).summary, 'Synthetic retained summary.');
          assert.equal(saved.photos.find(row => row.id === 43).uploader, 'Keep this uploader'); assert.equal(saved.photos.find(row => row.id === 44).uploader, 'Synthetic Field');
          assert.ok(JSON.stringify(saved.workspaceReconciliations[0].previous.reports).includes('synthetic-retained-before-image'));
        }
        if (pass === 1) {
          assert.equal(saved.customers.some(row => row.id === 22), false); assert.equal(saved.projects.some(row => row.id === 202), false);
          for (const name of ['assignments', 'workdays', 'timeCards', 'projectPlans', 'projectTickets', 'subcontractorLinks', 'changes']) assert.equal(saved[name].some(row => row.projectId === 202), false, name);
          assert.equal(saved.photos.some(row => row.id === 42), false); assert.equal(saved.reports.some(row => row.id === 4), false); equal(saved.users.find(row => row.id === 3).projectIds, [101]);
          assert.equal(saved.reports.find(row => row.id === 5).project, 1); assert.equal(saved.photos.find(row => row.id === 43).project, 1); assert.equal(saved.projects[1].id, 303);
        }
      }
    });
    await check('first PM purge response retires removed project IDs', async () => {
      const seed = compoundSeed(); helpers.prepareWorkspace(seed); helpers.ensureOwnerTeamMember(seed);
      assert.ok(seed.projects.some(row => row.id === 202));
      const s = await scenario(seed, 'pm@example.invalid'), before = s.store.current(), response = await s.request('/api/state');
      assert.equal(response.status, 200, JSON.stringify(response)); equal(response.data.currentUser.projectIds, [101]); equal(s.store.current().users.find(row => row.id === 3).projectIds, [101]);
      equal(ledger.valid(s.store.current()).at(-1).previous.users, before.users);
    });
    const poisonCases = [
      ['null', () => null], ['false', () => false], ['zero', () => 0], ['object', () => ({})],
      ['forged proof', () => [{ ...signedRow(), proof: '0'.repeat(64) }]],
      ['tampered before-image', () => { const row = signedRow(); row.previous.team[0].name = 'Forged history'; return [row]; }],
      ['duplicate record identity', () => { const row = signedRow(); return [row, structuredClone(row)]; }],
      ['foreign company signed record', () => [resign({ ...signedRow(), companyId: B })]],
      ['foreign purpose signed record', () => [resign({ ...signedRow(), purpose: 'other-purpose' })]],
      ['extra signed custody field', () => [resign({ ...signedRow(), unexpected: true })]],
      ['forbidden changed collection', () => [resign({ ...signedRow(), changed: ['company'], previous: { company: {} } })]],
      ['mismatched before-image keys', () => [resign({ ...signedRow(), previous: { users: [] } })]]
    ];
    for (const [name, makePoison] of poisonCases) await check('poisoned custody fails unchanged: ' + name, async () => {
      const seed = base(); seed.team[0].crew = 'Needs owner repair'; seed.workspaceReconciliations = makePoison();
      denied(() => ledger.valid(seed));
      const s = await scenario(seed), before = s.store.current(), revision = s.store.revision(), response = await s.request('/api/state');
      assert.equal(response.status, 409, JSON.stringify(response)); assert.equal(s.store.revision(), revision); equal(s.store.current(), before);
    });
    await check('custody count and byte limits reject without mutation', async () => {
      const count = base(); count.workspaceReconciliations = Array(10001).fill(signedRow()); const countHash = canonicalHash(count); denied(() => ledger.valid(count)); assert.equal(canonicalHash(count), countHash);
      const bytes = base(); bytes.workspaceReconciliations = [resign({ ...signedRow(), previous: { team: 'x'.repeat(20000001) } })]; const byteHash = canonicalHash(bytes); denied(() => ledger.valid(bytes)); assert.equal(canonicalHash(bytes), byteHash);
    });
    await check('normalized shared owner member is denied before HTTP repair', async () => {
      const seed = base(); seed.team[0].id = '11'; seed.users[1].memberId = 11; seed.team[0].crew = 'Needs repair';
      denied(() => reconciliation.source(seed)); const s = await scenario(seed), before = s.store.current(), revision = s.store.revision(), response = await s.request('/api/state');
      assert.equal(response.status, 409, JSON.stringify(response)); assert.equal(s.store.revision(), revision); equal(s.store.current(), before);
    });
    await check('candidate forbids unrelated employee team edits', async () => {
      const before = base(), after = structuredClone(before); after.team[1].crew = 'Unauthorized crew'; denied(() => reconciliation.candidate(before, after, ['team']));
    });
    await check('candidate forbids owner relink to another account member', async () => {
      const before = base(), after = structuredClone(before); after.users[0].memberId = 12; after.team[1].role = 'Account Owner'; after.team[1].crew = 'Office'; denied(() => reconciliation.candidate(before, after, ['users', 'team']));
    });
    await check('candidate permits only exact owner role and crew repair values', async () => {
      const before = base(), after = structuredClone(before); after.team[0].role = 'Arbitrary role'; after.team[0].crew = 'Arbitrary crew'; denied(() => reconciliation.candidate(before, after, ['team']));
    });
    await check('candidate cannot alter PM role, grants or crew assignments during repair', async () => {
      const before = compoundSeed(); helpers.prepareWorkspace(before);
      for (const change of [user => { user.role = 'admin'; }, user => { user.permissions.approveDailies = false; }, user => { user.assignedCrews = ['Foreign Crew']; }]) {
        const after = structuredClone(before); change(after.users.find(user => user.id === 3)); denied(() => reconciliation.candidate(before, after, ['users']));
      }
    });
    await check('ambiguous owner email fallback cannot choose a team row and commit a repair', async () => {
      const seed = base(); delete seed.users[0].memberId;
      seed.team.push({ id: 13, name: 'Ambiguous Synthetic Owner', email: seed.users[0].email, crew: 'Other Crew', role: 'Field' });
      denied(() => reconciliation.source(seed)); const s = await scenario(seed), before = s.store.current(), revision = s.store.revision(), response = await s.request('/api/state');
      assert.equal(response.status, 409, JSON.stringify(response)); assert.equal(s.store.revision(), revision); equal(s.store.current(), before);
    });
    for (const role of ['field', 'foreman']) await check(role + ' multi-assignee first confirm and replay obey current GET privacy ceiling', async () => {
      const seed = base(); seed.users[1].role = role; seed.team.push({ id: 99, name: 'Hidden Coworker', crew: 'Hidden Crew', role: 'Field' });
      seed.assignments[0].memberIds = [12, 99]; seed.assignments[0].acknowledgements[99] = { status: 'acknowledged', by: 'Hidden Coworker', userId: 9 }; seed.assignments[0].notifications[99] = { emailStatus: 'sent' };
      const s = await scenario(seed, 'field@example.invalid'); const read = await s.request('/api/assignments'); assert.equal(read.status, 200); equal(read.data.assignments[0].memberIds, [12]);
      const preview = await s.request('/api/workspace-direct-preview', 'POST', { family: 'scheduling', method: 'POST', path: '/api/assignments/1/acknowledge', details: { memberId: 12 } }); assert.equal(preview.status, 200, JSON.stringify(preview));
      const proof = { token: preview.data.token, version: preview.data.version, confirmed: true, requestId: crypto.randomUUID() };
      const saved = await s.request('/api/assignments/1/acknowledge', 'POST', proof); assert.equal(saved.status, 200, JSON.stringify(saved));
      const replay = await s.request('/api/assignments/1/acknowledge', 'POST', proof); assert.equal(replay.status, 200, JSON.stringify(replay)); assert.equal(replay.data.originalSaveResult, true);
      for (const response of [saved, replay]) { equal(response.data.memberIds, [12]); equal(Object.keys(response.data.acknowledgements), ['12']); equal(Object.keys(response.data.notifications), []); assert.equal(JSON.stringify(response.data).includes('Hidden Coworker'), false); }
      assert.ok(s.store.current().assignments[0].memberIds.includes(99), 'Privacy projection must retain source assignment members');
      const otherSession = await s.request('/api/auth/login', 'POST', { email: 'field@example.invalid', password: initial }); assert.equal(otherSession.status, 200);
      let before = s.store.current(), revision = s.store.revision();
      assert.equal((await s.request('/api/assignments/1/acknowledge', 'POST', proof, otherSession.data.token)).status, 409); assert.equal(s.store.revision(), revision); equal(s.store.current(), before);
      await s.mutate(db => { const scheduling = require('./scheduling-access'); db.company.schedulingPolicyRequired = true; db.company.schedulingRolePolicy = { version: 1, revision: 1, roles: Object.fromEntries(scheduling.roles.map(name => [name, { ...scheduling.ceiling(name), ...(name === role ? { acknowledge: false } : {}) }])) }; scheduling.validatePolicy(db.company.schedulingRolePolicy); });
      before = s.store.current(); revision = s.store.revision();
      assert.equal((await s.request('/api/assignments/1/acknowledge', 'POST', proof)).status, 409); assert.equal(s.store.revision(), revision); equal(s.store.current(), before);
    });
    await check('provider-free fixtures preserve legacy bytes and create no platform file', async () => {
      assert.deepEqual(fs.readFileSync(file), legacyBytes); assert.equal(fs.existsSync(platformFile), false); assert.equal(attemptedExternalCalls, 0); assert.equal(attemptedDeliveries, 0);
    });
  } finally { uninstall?.(); global.fetch = realFetch; mod.server.closeAllConnections(); await new Promise(resolve => mod.server.close(resolve)); }
  console.log(JSON.stringify({ reconciliationReview: true, passed: passed.length, failed: failed.length, checks: passed, failures: failed, attemptedExternalCalls, attemptedDeliveries, productionReady: false }));
  if (failed.length) process.exitCode = 1;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
