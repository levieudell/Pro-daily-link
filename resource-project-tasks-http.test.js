'use strict';
// Actual selected-mode routes against one disposable in-memory tenant. No
// provider or production DB is used; unrelated legacy/platform bytes are kept.
const assert = require('node:assert/strict'), crypto = require('node:crypto');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { A, B, initial, credential, snapshot, memory } = require('./compat-account-fixture');
const { services } = require('./compat-lifecycle-fixture');
const { canonicalHash } = require('./database/transactional-repository');
const scheduling = require('./scheduling-access');

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-resource-task-http-synthetic-'));
  const file = path.join(dir, 'legacy.json'), platformFile = path.join(dir, 'platform.json');
  const legacy = snapshot(); legacy.company.id = B; legacy.users[0].companyId = B;
  fs.writeFileSync(file, JSON.stringify(legacy)); fs.writeFileSync(platformFile, JSON.stringify({ users: [], sessions: [] }));
  const legacyBytes = fs.readFileSync(file), platformBytes = fs.readFileSync(platformFile);
  for (const name of ['OPENAI_API_KEY', 'RESEND_API_KEY', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'SENTRY_DSN', 'SUPABASE_SECRET_KEY', 'PDL_PLATFORM_KEY']) process.env[name] = '';
  Object.assign(process.env, { NODE_ENV: 'test', PDL_COMPAT_ACCOUNT_SYNTHETIC: '1', PDL_REQUIRE_AUTH: '1', PDL_DB_FILE: file, PDL_PLATFORM_FILE: platformFile, PDL_SUPABASE_ENABLED: '0', PDL_TRANSACTIONAL_DB: 'off', PDL_WEEKLY_DIGEST: '0' });
  require('./database/supabase').loadLocalEnv = () => {};
  const mod = require('./server');
  await new Promise(resolve => mod.server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + mod.server.address().port;
  const seed = snapshot(); seed.team[0].crew = 'Office';
  Object.assign(seed.projects[0], { startDate: '2026-10-05', endDate: '2026-12-31' });
  seed.projects.push({ id: 102, name: 'Separate synthetic project', startDate: '2026-10-05', endDate: '2026-12-31', status: 'Active', estimateItems: [], templateId: 'standard' });
  for (const [id, role] of [[2, 'admin'], [3, 'project_manager'], [4, 'foreman'], [5, 'field']]) {
    seed.users.push({ id, companyId: A, memberId: id + 10, name: 'Synthetic ' + role, email: role + '@example.invalid', status: 'Active', role, ...credential(initial), projectIds: [101], assignedCrews: ['North'], permissions: { scheduleCrews: true, viewTime: true, manageTime: true, viewDailies: true, approveDailies: true } });
    seed.team.push({ id: id + 10, name: 'Synthetic ' + role, crew: role === 'admin' ? 'Office' : 'North', role: 'Employee', initials: 'SE', hours: 0 });
  }
  seed.team.push({ id: 17, name: 'Synthetic South employee', crew: 'South', role: 'Employee', initials: 'SS', hours: 0 });
  seed.crews = [{ id: 1, name: 'North' }, { id: 2, name: 'South' }];
  seed.projectTasks = [
    { id: 1, projectId: 101, name: 'North predecessor', durationDays: 3, predecessorIds: [], memberIds: [14, 15], crew: 'North', status: 'not-started', startDate: '2026-10-05', endDate: '2026-10-07', createdAt: '2026-10-01T00:00:00.000Z', createdBy: 'Synthetic Owner' },
    { id: 2, projectId: 101, name: 'South downstream', durationDays: 2, predecessorIds: [1], memberIds: [17], crew: 'South', status: 'in-progress', startDate: '2026-10-08', endDate: '2026-10-09', createdAt: '2026-10-01T00:00:00.000Z', createdBy: 'Synthetic Owner' },
    { id: 3, projectId: 102, name: 'Separate South task', durationDays: 1, predecessorIds: [], memberIds: [17], crew: 'South', status: 'done', startDate: '2026-10-05', endDate: '2026-10-05', createdAt: '2026-10-01T00:00:00.000Z', createdBy: 'Synthetic Owner' }
  ];
  seed.assignments = [{ id: 1, projectId: 101, memberIds: [14, 15], date: '2026-10-01', start: '07:00', end: '15:30', activity: 'Historic task-independent shift', notifications: {}, acknowledgements: {} }];
  seed.timeCards = [{ id: 1, memberId: 14, projectId: 101, date: '2026-10-01', hours: 2, status: 'Approved', history: [] }];
  seed.reports = [{ id: 1, project: 0, date: '2026-10-01', laborEntries: [{ memberId: 14, hours: 2 }] }];
  const historic = canonicalHash({ reports: seed.reports, timeCards: seed.timeCards, assignments: seed.assignments });
  const store = memory(seed), key = crypto.randomBytes(32), fixture = services(store, origin, { key });
  const assignmentMessages = [], externalAttempts = []; let assignmentOutcome = 'accepted', deliveryProof = null, assignmentAttempts = 0;
  const authenticateSession = (db, hash) => { const session = db.sessions.find(row => row.tokenHash === hash && Date.parse(row.expiresAt) > Date.now()), user = session && db.users.find(row => row.id === session.userId && row.status === 'Active'); return user ? { companyId: A, session, user: require('./capability-registry').actor(db, user) } : null; };
  const deliveryValidator = require('./compat-assignment-delivery').createDelivery({ repository: store, companyId: A, key, send: async () => ({ status: 'accepted' }), authenticateSession, accountAccess: () => ({ status: 'Active', locked: false }) });
  const assignmentSend = async (source, options) => {
    assignmentAttempts++;
    const current = store.current(), job = deliveryValidator.valid(current).find(row => row.id === options.idempotencyKey);
    assert.ok(deliveryProof, 'a confirmed task save must authorize each fake delivery'); assert.ok(job); assert.equal(job.status, 'sending'); assert.deepEqual(job.source, source);
    const receipt = current.resourceReceipts.find(row => row.requestId === deliveryProof.requestId); assert.ok(receipt, 'business/receipt CAS must precede the first send'); assert.equal(receipt.operation.kind, 'projectTaskAssign'); assert.ok(store.revision() > receipt.committedRevision, 'delivery claim CAS must also precede the first send');
    assert.equal(source.memberId, deliveryProof.memberId); assert.ok(current.auditLog.some(row => row.requestId === deliveryProof.requestId));
    assignmentMessages.push({ source: structuredClone(source), idempotencyKey: options.idempotencyKey, revision: store.revision(), receiptId: receipt.id });
    return { status: assignmentOutcome };
  };
  const uninstall = mod.installCompatibilityAccountTests({ synthetic: true, companyId: A, origin, globalOrigin: 'http://localhost:4999', repository: store, ...fixture, workspace: true, workspaceKey: key, assignmentSend });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (url, options) => { const target = new URL(typeof url === 'string' || url instanceof URL ? url : url.url); if (target.origin !== origin) { externalAttempts.push(target.origin); throw Error('Synthetic task tests prohibit external provider requests'); } return originalFetch(url, options); };
  const tokens = {};
  const request = async (route, { method = 'GET', data, token = tokens.owner, tenant = A } = {}) => {
    const response = await fetch(origin + route, { method, signal: AbortSignal.timeout(10000), headers: { 'X-PDL-Company': tenant, ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(data !== undefined ? { 'Content-Type': 'application/json' } : {}) }, ...(data !== undefined ? { body: JSON.stringify(data) } : {}) });
    return { status: response.status, value: await response.json(), response };
  };
  async function login(role) { const r = await request('/api/auth/login', { token: null, method: 'POST', data: { email: role + '@example.invalid', password: initial } }); assert.equal(r.status, 200, JSON.stringify(r.value)); tokens[role] = r.value.token; }
  async function mutate(fn) { const loaded = await store.load(A); fn(loaded.snapshot); await store.commit(loaded.snapshot, loaded.revision); }
  async function preview(kind, method, route, details, token = tokens.owner) {
    const current = await request('/api/workspace-identity', { token }); assert.equal(current.status, 200, JSON.stringify(current.value));
    const sends = assignmentAttempts, jobs = (store.current().workspaceAssignmentJobs || []).length;
    const r = await request('/api/resources/preview', { token, method: 'POST', data: { operation: { kind, method, path: route, details }, expectedRevision: current.value.revision, reason: 'Synthetic linked-task review' } });
    assert.equal(assignmentAttempts, sends, 'reviewing a preview cannot attempt assignment email'); assert.equal((store.current().workspaceAssignmentJobs || []).length, jobs, 'reviewing a preview cannot stage a delivery job'); return r;
  }
  async function save(kind, method, route, details, token = tokens.owner) {
    const p = await preview(kind, method, route, details, token); assert.equal(p.status, 200, kind + ' preview: ' + JSON.stringify(p.value));
    const proof = { token: p.value.token, version: p.value.version, confirmed: true, requestId: crypto.randomUUID() };
    if (kind === 'projectTaskAssign') deliveryProof = { requestId: proof.requestId, memberId: details.memberId };
    let r; try { r = await request(route, { token, method, data: proof }); } finally { deliveryProof = null; }
    assert.equal(r.status, kind === 'projectTaskCreate' ? 201 : 200, kind + ' save: ' + JSON.stringify(r.value));
    return { p, proof, r };
  }
  async function deny(kind, method, route, details, token, status) {
    const before = canonicalHash(store.current()), revision = store.revision(), attempts = assignmentAttempts;
    const r = await preview(kind, method, route, details, token); assert.equal(r.status, status, kind + ' denial: ' + JSON.stringify(r.value));
    assert.equal(canonicalHash(store.current()), before, 'denied preview must not mutate tenant state'); assert.equal(store.revision(), revision); assert.equal(assignmentAttempts, attempts);
  }
  const taskById = id => store.current().projectTasks.find(row => row.id === id);
  try {
    for (const role of ['owner', 'admin', 'project_manager', 'foreman', 'field']) await login(role);
    assert.equal((await request('/api/projects/101/tasks', { token: null })).status, 401);
    assert.equal((await request('/api/projects/101/tasks', { tenant: B })).status, 404);
    for (const role of ['owner', 'admin']) { const r = await request('/api/projects/101/tasks', { token: tokens[role] }); assert.equal(r.status, 200, JSON.stringify(r.value)); assert.deepEqual(r.value[1].memberIds, [17]); }
    const pmView = await request('/api/projects/101/tasks', { token: tokens.project_manager }); assert.equal(pmView.status, 200); assert.deepEqual(pmView.value.map(row => row.memberIds), [[14, 15], []]); assert.equal(pmView.value[1].crew, '');
    assert.deepEqual(pmView.value.map(row => row.readOnly), [false, true]);
    assert.equal((await request('/api/projects/102/tasks', { token: tokens.project_manager })).status, 404);
    for (const role of ['foreman', 'field']) {
      const r = await request('/api/projects/101/tasks', { token: tokens[role] }); assert.equal(r.status, 200); assert.deepEqual(r.value.map(row => row.memberIds), [[role === 'foreman' ? 14 : 15], []]); assert.ok(r.value.every(row => row.crew === ''));
      assert.equal((await request('/api/projects/102/tasks', { token: tokens[role] })).status, 404, 'field/foreman cannot read an unassigned project');
      await deny('projectTaskCreate', 'POST', '/api/projects/101/tasks', { name: 'No field writer', durationDays: 1 }, tokens[role], 403);
    }
    assert.equal((await request('/api/projects/101/tasks', { method: 'POST', data: { name: 'Raw bypass', durationDays: 1 } })).status, 400);
    for (const details of [{ name: 'Mixed financial fields', durationDays: 1, budget: 500 }, { name: 'Foreign identity', durationDays: 1, companyId: B }, { name: 'Wrong typed duration', durationDays: '1' }, { name: 'Duplicate members', durationDays: 1, memberIds: [14, 14] }]) await deny('projectTaskCreate', 'POST', '/api/projects/101/tasks', details, tokens.owner, 400);
    await deny('projectDates', 'PATCH', '/api/projects/101', { startDate: '2026-02-30' }, tokens.owner, 400);
    await deny('projectDates', 'PATCH', '/api/projects/101', { startDate: '2026-10-05', contractValue: 1000 }, tokens.owner, 400);
    await deny('projectDates', 'PATCH', '/api/projects/101', { startDate: '2027-01-01' }, tokens.owner, 400);
    await deny('projectTaskCreate', 'POST', '/api/projects/102/tasks', { name: 'PM other project', durationDays: 1, memberIds: [14] }, tokens.project_manager, 404);
    await deny('projectTaskCreate', 'POST', '/api/projects/101/tasks', { name: 'PM mixed crews', durationDays: 1, memberIds: [14, 17] }, tokens.project_manager, 403);
    await deny('projectTaskCreate', 'POST', '/api/projects/101/tasks', { name: 'Foreign predecessor', durationDays: 1, predecessorIds: [3] }, tokens.owner, 400);
    await deny('projectTaskEdit', 'PATCH', '/api/project-tasks/2', { memberIds: [14] }, tokens.project_manager, 403);
    await deny('projectTaskEdit', 'PATCH', '/api/project-tasks/1', { durationDays: 4 }, tokens.project_manager, 403);
    await deny('projectTaskRemove', 'DELETE', '/api/project-tasks/1', {}, tokens.project_manager, 403);
    await deny('projectDates', 'PATCH', '/api/projects/101', { startDate: '2026-10-06' }, tokens.project_manager, 403);
    await mutate(db => { db.users.find(row => row.id === 3).permissions.scheduleCrews = false; });
    await deny('projectTaskCreate', 'POST', '/api/projects/101/tasks', { name: 'Stored permission denied', durationDays: 1 }, tokens.project_manager, 403);
    await mutate(db => { db.users.find(row => row.id === 3).permissions.scheduleCrews = true; db.company.schedulingRolePolicy = { version: 1, revision: 1, roles: Object.fromEntries(scheduling.roles.map(role => [role, scheduling.ceiling(role)])) }; db.company.schedulingRolePolicy.roles.project_manager.create = false; });
    await deny('projectTaskCreate', 'POST', '/api/projects/101/tasks', { name: 'Typed create denied', durationDays: 1 }, tokens.project_manager, 403);
    await mutate(db => { db.company.schedulingRolePolicy.roles.project_manager.create = true; db.company.schedulingRolePolicy.roles.project_manager.view = false; for (const action of ['create', 'edit', 'remove', 'acknowledge']) db.company.schedulingRolePolicy.roles.project_manager[action] = false; });
    assert.equal((await request('/api/projects/101/tasks', { token: tokens.project_manager })).status, 403);
    assert.equal((await request('/api/projects/101/tasks')).status, 200, 'immutable Owner view remains available');
    await mutate(db => { delete db.company.schedulingRolePolicy; });

    const pmCreated = await save('projectTaskCreate', 'POST', '/api/projects/101/tasks', { name: 'PM North work', durationDays: 1, memberIds: [14], crew: 'North' }, tokens.project_manager);
    const pmTask = pmCreated.r.value.tasks.find(row => row.name === 'PM North work'); assert.ok(pmTask); assert.deepEqual(pmCreated.r.value.tasks.find(row => row.id === 2).memberIds, []);
    await save('projectTaskEdit', 'PATCH', '/api/project-tasks/' + pmTask.id, { status: 'in-progress' }, tokens.project_manager); assert.equal(taskById(pmTask.id).status, 'in-progress');
    await save('projectTaskRemove', 'DELETE', '/api/project-tasks/' + pmTask.id, {}, tokens.project_manager); assert.equal(taskById(pmTask.id), undefined);

    const created = await save('projectTaskCreate', 'POST', '/api/projects/101/tasks', { name: 'Owner final linked task', durationDays: 1, predecessorIds: [2], memberIds: [14], crew: 'North' });
    const tail = created.r.value.tasks.find(row => row.name === 'Owner final linked task'); assert.equal(tail.startDate, '2026-10-12', 'Friday completion rolls dependent task to Monday');
    const edit = await save('projectTaskEdit', 'PATCH', '/api/project-tasks/1', { durationDays: 4 }, tokens.admin);
    assert.equal(taskById(1).endDate, '2026-10-08'); assert.equal(taskById(2).startDate, '2026-10-09'); assert.equal(taskById(2).endDate, '2026-10-12'); assert.equal(taskById(tail.id).startDate, '2026-10-13');
    const dates = await save('projectDates', 'PATCH', '/api/projects/101', { startDate: '2026-10-06', endDate: '2026-12-30' });
    assert.equal(dates.r.value.startDate, '2026-10-06'); assert.equal(taskById(1).endDate, '2026-10-09'); assert.equal(taskById(2).startDate, '2026-10-12'); assert.equal(taskById(tail.id).startDate, '2026-10-14');
    const removedSource = taskById(2), removed = await save('projectTaskRemove', 'DELETE', '/api/project-tasks/2', {}, tokens.admin);
    assert.equal(removed.r.value.deleted, 2); assert.equal(taskById(2), undefined); assert.deepEqual(taskById(tail.id).predecessorIds, [1]); assert.equal(taskById(tail.id).startDate, '2026-10-12');
    const retained = store.current().resourceReceipts.find(row => row.requestId === removed.proof.requestId); assert.deepEqual(retained.retained.projectTasks.find(row => row.id === 2), removedSource, 'deleted task before-image remains in receipt custody');
    assert.equal(canonicalHash({ reports: store.current().reports, timeCards: store.current().timeCards, assignments: store.current().assignments }), historic, 'CRUD/date edits preserve historic reports, cards and shifts');
    const replayRevision = store.revision(), replay = await request('/api/project-tasks/2', { method: 'DELETE', token: tokens.admin, data: removed.proof }); assert.equal(replay.status, 200); assert.equal(replay.value.originalSaveResult, true); assert.equal(store.revision(), replayRevision);

    // Revoke after confirmation has derived its candidate but before the
    // repository commits. The competing revision must defeat the held save.
    const inflight = await preview('projectTaskCreate', 'POST', '/api/projects/101/tasks', { name: 'In-flight permission revoked', durationDays: 1, memberIds: [14], crew: 'North' }, tokens.project_manager); assert.equal(inflight.status, 200);
    const inflightProof = { token: inflight.value.token, version: inflight.value.version, confirmed: true, requestId: crypto.randomUUID() };
    let reachedCommit, releaseCommit;
    const reached = new Promise(resolve => { reachedCommit = resolve; }), released = new Promise(resolve => { releaseCommit = resolve; });
    store.beforeCommit = async candidate => { if ((candidate.resourceReceipts || []).some(row => row.requestId === inflightProof.requestId)) { store.beforeCommit = null; reachedCommit(); await released; } };
    const confirmation = request('/api/projects/101/tasks', { method: 'POST', token: tokens.project_manager, data: inflightProof });
    try {
      await Promise.race([reached, new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error('Synthetic confirmation did not reach the held commit')), 5000); timer.unref(); })]);
      await mutate(db => { db.users.find(row => row.id === 3).permissions.scheduleCrews = false; });
      const revoked = canonicalHash(store.current()), revokedRevision = store.revision(); releaseCommit();
      const r = await confirmation; assert.equal(r.status, 409, JSON.stringify(r.value)); assert.equal(canonicalHash(store.current()), revoked); assert.equal(store.revision(), revokedRevision); assert.equal(store.current().projectTasks.some(row => row.name === 'In-flight permission revoked'), false);
    } finally { store.beforeCommit = null; releaseCommit(); }
    await mutate(db => { db.users.find(row => row.id === 3).permissions.scheduleCrews = true; });

    for (const [caseName, change, role] of [
      ['effective permission revoked', db => { db.users.find(row => row.id === 3).permissions.scheduleCrews = false; }, 'project_manager'],
      ['role changed', db => { db.users.find(row => row.id === 3).role = 'field'; }, 'project_manager'],
      ['originating session revoked', db => { db.sessions = db.sessions.filter(row => row.tokenHash !== crypto.createHash('sha256').update(tokens.project_manager).digest('hex')); }, 'project_manager'],
      ['originating session expired', db => { db.sessions.find(row => row.tokenHash === crypto.createHash('sha256').update(tokens.owner).digest('hex')).expiresAt = new Date(Date.now() - 1000).toISOString(); }, 'owner']
    ]) {
      const p = await preview('projectTaskCreate', 'POST', '/api/projects/101/tasks', { name: caseName, durationDays: 1, memberIds: [14], crew: 'North' }, tokens[role]); assert.equal(p.status, 200, caseName + ': ' + JSON.stringify(p.value));
      await mutate(change); const before = canonicalHash(store.current()), revision = store.revision();
      const r = await request('/api/projects/101/tasks', { method: 'POST', token: tokens[role], data: { token: p.value.token, version: p.value.version, confirmed: true, requestId: crypto.randomUUID() } });
      assert.ok([401, 409].includes(r.status), caseName + ' must reject: ' + JSON.stringify(r.value)); assert.equal(canonicalHash(store.current()), before); assert.equal(store.revision(), revision); assert.equal(store.current().projectTasks.some(row => row.name === caseName), false);
      await mutate(db => { const user = db.users.find(row => row.id === 3); user.role = 'project_manager'; user.permissions.scheduleCrews = true; }); await login(role);
    }
    const ownerHash = crypto.createHash('sha256').update(tokens.owner).digest('hex');
    await mutate(db => { db.sessions.find(row => row.tokenHash === ownerHash).expiresAt = new Date(Date.now() + 2000).toISOString(); });
    const expiring = await preview('projectTaskCreate', 'POST', '/api/projects/101/tasks', { name: 'Session expires during commit', durationDays: 1, memberIds: [14], crew: 'North' }); assert.equal(expiring.status, 200);
    const expiringProof = { token: expiring.value.token, version: expiring.value.version, confirmed: true, requestId: crypto.randomUUID() };
    const expiresSnapshot = canonicalHash(store.current()), expiresRevision = store.revision(); let heldExpiry = false;
    store.beforeCommit = async candidate => { if ((candidate.resourceReceipts || []).some(row => row.requestId === expiringProof.requestId)) { heldExpiry = true; await new Promise(resolve => setTimeout(resolve, Math.max(0, Date.parse(expiring.value.expiresAt) - Date.now()) + 25)); } };
    try { const r = await request('/api/projects/101/tasks', { method: 'POST', data: expiringProof }); assert.equal(heldExpiry, true); assert.equal(r.status, 409, JSON.stringify(r.value)); assert.equal(canonicalHash(store.current()), expiresSnapshot); assert.equal(store.revision(), expiresRevision); }
    finally { store.beforeCommit = null; }
    await login('owner');
    const poisoned = store.current(); await mutate(db => { db.projectTasks.find(row => row.id === 3).predecessorIds = [1]; });
    const poisonBefore = canonicalHash(store.current()), poisonRevision = store.revision();
    assert.equal((await request('/api/projects/101/tasks')).status, 409);
    const poisonPreview = await request('/api/resources/preview', { method: 'POST', data: { operation: { kind: 'projectTaskRemove', method: 'DELETE', path: '/api/project-tasks/1', details: {} }, expectedRevision: store.revision(), reason: 'Reject foreign poisoned dependency' } });
    assert.equal(poisonPreview.status, 409);
    assert.equal(canonicalHash(store.current()), poisonBefore); assert.equal(store.revision(), poisonRevision); assert.deepEqual(taskById(3).predecessorIds, [1], 'rejected deletion cannot silently relink a foreign poisoned dependency');
    await mutate(db => { db.projectTasks = poisoned.projectTasks; });
    const lost = await preview('projectTaskCreate', 'POST', '/api/projects/101/tasks', { name: 'Task lost acknowledgement', durationDays: 1, memberIds: [14], crew: 'North' }); assert.equal(lost.status, 200);
    const lostProof = { token: lost.value.token, version: lost.value.version, confirmed: true, requestId: crypto.randomUUID() }; store.loseCommitAck = true;
    assert.equal((await request('/api/projects/101/tasks', { method: 'POST', data: lostProof })).status, 503); const committedCount = store.current().projectTasks.length, committedRevision = store.revision();
    const lookup = { token: lostProof.token, version: lostProof.version, requestId: lostProof.requestId, method: 'POST', path: '/api/projects/101/tasks' };
    const recovered = await request('/api/resources/original-result', { method: 'POST', data: lookup }); assert.equal(recovered.status, 200); assert.equal(recovered.value.originalSaveResult, true); assert.equal(recovered.value.tasks, undefined); assert.equal(store.current().projectTasks.length, committedCount); assert.equal(store.revision(), committedRevision);
    await login('owner'); assert.equal((await request('/api/resources/original-result', { method: 'POST', data: lookup })).status, 409, 'new session cannot recover a prior session receipt');
    // Enable only a dummy key after installing the explicit synthetic runtime.
    // Any legacy direct-SMTP fetch would hit the external-request prohibition.
    process.env.RESEND_API_KEY = 'synthetic-unused-task-provider-key';
    const lane = await save('projectTaskCreate', 'POST', '/api/projects/101/tasks', { name: 'Reviewed lane assignment', durationDays: 8, memberIds: [14], crew: 'North' });
    const laneId = lane.r.value.tasks.find(row => row.name === 'Reviewed lane assignment').id, lanePath = '/api/project-tasks/' + laneId + '/assign';
    await mutate(db => {
      db.assignments.push(
        { id: 50, projectId: 101, memberIds: [14], date: '2026-10-06', start: '07:00', end: '15:30', activity: 'Existing North shift', crew: 'North', notifications: {}, acknowledgements: {} },
        { id: 51, projectId: 102, memberIds: [15], date: '2026-10-07', start: '07:00', end: '15:30', activity: 'Already booked elsewhere', notifications: {}, acknowledgements: {} },
        { id: 52, projectId: 101, memberIds: [15], date: '2026-10-09', start: '07:00', end: '15:30', activity: 'Already assigned here', notifications: { 15: { inAppAt: '2026-10-01T00:00:00.000Z', emailStatus: 'sent' } }, acknowledgements: {} }
      );
      db.timeOffRequests.push({ id: 1, memberId: 15, startDate: '2026-10-08', endDate: '2026-10-08', status: 'approved', allDay: true });
    });
    await mutate(db => { db.assignments.find(row => row.id === 50).memberIds = [14, 17]; });
    await deny('projectTaskAssign', 'POST', lanePath, { memberId: 15 }, tokens.project_manager, 403);
    await mutate(db => { db.assignments.find(row => row.id === 50).memberIds = [14]; db.users.find(row => row.id === 3).permissions.scheduleCrews = false; });
    await deny('projectTaskAssign', 'POST', lanePath, { memberId: 15 }, tokens.project_manager, 403);
    await mutate(db => { db.users.find(row => row.id === 3).permissions.scheduleCrews = true; db.company.schedulingRolePolicy = { version: 1, revision: 1, roles: Object.fromEntries(scheduling.roles.map(role => [role, scheduling.ceiling(role)])) }; db.company.schedulingRolePolicy.roles.project_manager.create = false; });
    await deny('projectTaskAssign', 'POST', lanePath, { memberId: 15 }, tokens.project_manager, 403);
    await mutate(db => { delete db.company.schedulingRolePolicy; });
    await deny('projectTaskAssign', 'POST', '/api/project-tasks/3/assign', { memberId: 14 }, tokens.project_manager, 404);
    await deny('projectTaskAssign', 'POST', lanePath, { memberId: 17 }, tokens.project_manager, 403);
    for (const role of ['foreman', 'field']) await deny('projectTaskAssign', 'POST', lanePath, { memberId: 15 }, tokens[role], 403);
    await deny('projectTaskAssign', 'POST', lanePath, { memberId: 15, fromDate: '2026-10-16' }, tokens.owner, 400);
    await deny('projectTaskAssign', 'POST', lanePath, { memberId: 15, fromDate: '2026-02-30' }, tokens.owner, 400);
    const skippedBefore = structuredClone(store.current().assignments.filter(row => [51, 52].includes(row.id)));
    const assigned = await save('projectTaskAssign', 'POST', lanePath, { memberId: 15 }, tokens.project_manager);
    assert.deepEqual(assigned.p.value.impact.taskAssignment, { createdCount: 4, mergedCount: 1, skippedCount: 3 });
    assert.deepEqual([assigned.r.value.created, assigned.r.value.merged, assigned.r.value.skipped], [4, 1, 3]); assert.deepEqual(taskById(laneId).memberIds, [15]);
    assert.deepEqual(store.current().assignments.filter(row => [51, 52].includes(row.id)), skippedBefore, 'skipped shifts preserve notifications and membership');
    assert.deepEqual(store.current().assignments.find(row => row.id === 50).memberIds, [14, 15]); assert.equal(store.current().assignments.find(row => row.id === 50).notifications[14], undefined, 'existing shift member is not newly notified');
    assert.equal(assignmentMessages.length, 1); assert.equal(assignmentMessages[0].source.to, 'field@example.invalid'); assert.equal(assignmentMessages[0].source.memberId, 15);
    assert.deepEqual(assignmentMessages[0].source.assignments.map(row => row.date).sort(), ['2026-10-06', '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15']);
    for (const row of store.current().assignments.filter(row => assignmentMessages[0].source.assignments.some(source => source.id === row.id))) assert.equal(row.notifications[15].emailStatus, 'sent');
    assert.equal(deliveryValidator.valid(store.current()).find(row => row.id === assignmentMessages[0].idempotencyKey).status, 'sent');
    const assignmentRevision = store.revision(); assert.equal((await request(lanePath, { method: 'POST', token: tokens.project_manager, data: assigned.proof })).status, 200); assert.equal(assignmentMessages.length, 1); assert.equal(store.revision(), assignmentRevision);
    const assignmentLookup = { token: assigned.proof.token, version: assigned.proof.version, requestId: assigned.proof.requestId, method: 'POST', path: lanePath }; assert.equal((await request('/api/resources/original-result', { method: 'POST', token: tokens.project_manager, data: assignmentLookup })).status, 200); assert.equal(assignmentMessages.length, 1);
    const uncertainTask = await save('projectTaskCreate', 'POST', '/api/projects/101/tasks', { name: 'Uncertain lane delivery', durationDays: 9, crew: 'North' });
    const uncertainId = uncertainTask.r.value.tasks.find(row => row.name === 'Uncertain lane delivery').id, uncertainPath = '/api/project-tasks/' + uncertainId + '/assign';
    assignmentOutcome = 'unknown'; const uncertainSave = await save('projectTaskAssign', 'POST', uncertainPath, { memberId: 15, fromDate: '2026-10-16' }); assignmentOutcome = 'accepted';
    assert.equal(assignmentMessages.length, 2); assert.equal(deliveryValidator.valid(store.current()).find(row => row.id === assignmentMessages[1].idempotencyKey).status, 'uncertain');
    await deny('projectTaskAssign', 'POST', uncertainPath, { memberId: 14, fromDate: '2026-10-16' }, tokens.owner, 409); assert.equal(assignmentMessages.length, 2, 'uncertain outcome blocks modifying the same shift before another send');
    assert.equal((await request(uncertainPath, { method: 'POST', data: uncertainSave.proof })).status, 200); assert.equal(assignmentMessages.length, 2, 'uncertain delivery replay cannot resend');
    // Stage a genuine queued delivery for a revised existing shift. A reviewed
    // lane merge cancels that old intent and notifies only the new assignee.
    let queuedId;
    await mutate(db => { const row = db.assignments.find(value => value.projectId === 101 && value.date === '2026-10-12'); row.activity = 'Synthetic revised queued shift'; const owner = authenticateSession(db, crypto.createHash('sha256').update(tokens.owner).digest('hex')); queuedId = deliveryValidator.stage(db, { auth: owner }, [row.id], 15)[0]; });
    assert.ok(queuedId); assert.equal(deliveryValidator.valid(store.current()).find(row => row.id === queuedId).status, 'queued');
    const queuedReplacement = await save('projectTaskAssign', 'POST', lanePath, { memberId: 14, fromDate: '2026-10-12' });
    assert.deepEqual([queuedReplacement.r.value.created, queuedReplacement.r.value.merged, queuedReplacement.r.value.skipped], [0, 4, 0]); assert.equal(deliveryValidator.valid(store.current()).find(row => row.id === queuedId).status, 'cancelled'); assert.equal(assignmentMessages.length, 3); assert.equal(assignmentMessages[2].source.memberId, 14); assert.equal(assignmentMessages[2].source.to, 'foreman@example.invalid');

    const boundary = await save('projectTaskCreate', 'POST', '/api/projects/101/tasks', { name: 'Assignment security boundary', durationDays: 1, predecessorIds: [uncertainId], memberIds: [14], crew: 'North' });
    const boundaryId = boundary.r.value.tasks.find(row => row.name === 'Assignment security boundary').id, boundaryPath = '/api/project-tasks/' + boundaryId + '/assign'; assert.equal(taskById(boundaryId).startDate, '2026-10-19');
    for (const [label, change] of [
      ['assignment stored permission revoked', db => { db.users.find(row => row.id === 3).permissions.scheduleCrews = false; }],
      ['assignment typed permission revoked', db => { db.company.schedulingRolePolicy = { version: 1, revision: 1, roles: Object.fromEntries(scheduling.roles.map(role => [role, scheduling.ceiling(role)])) }; db.company.schedulingRolePolicy.roles.project_manager.create = false; }],
      ['assignment role changed', db => { db.users.find(row => row.id === 3).role = 'field'; }],
      ['assignment session revoked', db => { db.sessions = db.sessions.filter(row => row.tokenHash !== crypto.createHash('sha256').update(tokens.project_manager).digest('hex')); }],
      ['assignment session expired', db => { db.sessions.find(row => row.tokenHash === crypto.createHash('sha256').update(tokens.project_manager).digest('hex')).expiresAt = new Date(Date.now() - 1000).toISOString(); }]
    ]) {
      const p = await preview('projectTaskAssign', 'POST', boundaryPath, { memberId: 15 }, tokens.project_manager); assert.equal(p.status, 200, label + ': ' + JSON.stringify(p.value));
      await mutate(change); const before = canonicalHash(store.current()), revision = store.revision(), attempts = assignmentAttempts;
      const r = await request(boundaryPath, { method: 'POST', token: tokens.project_manager, data: { token: p.value.token, version: p.value.version, confirmed: true, requestId: crypto.randomUUID() } }); assert.ok([401, 409].includes(r.status), label + ': ' + JSON.stringify(r.value)); assert.equal(canonicalHash(store.current()), before); assert.equal(store.revision(), revision); assert.equal(assignmentAttempts, attempts);
      await mutate(db => { db.users.find(row => row.id === 3).role = 'project_manager'; db.users.find(row => row.id === 3).permissions.scheduleCrews = true; delete db.company.schedulingRolePolicy; }); await login('project_manager');
    }
    const held = await preview('projectTaskAssign', 'POST', boundaryPath, { memberId: 15 }, tokens.project_manager); assert.equal(held.status, 200);
    const heldProof = { token: held.value.token, version: held.value.version, confirmed: true, requestId: crypto.randomUUID() }; let atCommit, releaseAssignment;
    const assignmentReached = new Promise(resolve => { atCommit = resolve; }), assignmentReleased = new Promise(resolve => { releaseAssignment = resolve; });
    store.beforeCommit = async candidate => { if ((candidate.resourceReceipts || []).some(row => row.requestId === heldProof.requestId)) { store.beforeCommit = null; atCommit(); await assignmentReleased; } };
    const heldConfirmation = request(boundaryPath, { method: 'POST', token: tokens.project_manager, data: heldProof });
    try {
      await Promise.race([assignmentReached, new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error('Synthetic assignment did not reach held commit')), 5000); timer.unref(); })]);
      await mutate(db => { db.users.find(row => row.id === 3).permissions.scheduleCrews = false; }); const before = canonicalHash(store.current()), revision = store.revision(), attempts = assignmentAttempts; releaseAssignment();
      const r = await heldConfirmation; assert.equal(r.status, 409); assert.equal(canonicalHash(store.current()), before); assert.equal(store.revision(), revision); assert.equal(assignmentAttempts, attempts);
    } finally { store.beforeCommit = null; releaseAssignment(); }
    await mutate(db => { db.users.find(row => row.id === 3).permissions.scheduleCrews = true; db.sessions.find(row => row.tokenHash === crypto.createHash('sha256').update(tokens.project_manager).digest('hex')).expiresAt = new Date(Date.now() + 2000).toISOString(); });
    const assignmentExpiring = await preview('projectTaskAssign', 'POST', boundaryPath, { memberId: 15 }, tokens.project_manager); assert.equal(assignmentExpiring.status, 200); const expireProof = { token: assignmentExpiring.value.token, version: assignmentExpiring.value.version, confirmed: true, requestId: crypto.randomUUID() };
    const expiresBefore = canonicalHash(store.current()), expiresAtRevision = store.revision(), expiryAttempts = assignmentAttempts; let heldAssignmentExpiry = false;
    store.beforeCommit = async candidate => { if ((candidate.resourceReceipts || []).some(row => row.requestId === expireProof.requestId)) { heldAssignmentExpiry = true; await new Promise(resolve => setTimeout(resolve, Math.max(0, Date.parse(assignmentExpiring.value.expiresAt) - Date.now()) + 25)); } };
    try { const r = await request(boundaryPath, { method: 'POST', token: tokens.project_manager, data: expireProof }); assert.equal(heldAssignmentExpiry, true); assert.equal(r.status, 409); assert.equal(canonicalHash(store.current()), expiresBefore); assert.equal(store.revision(), expiresAtRevision); assert.equal(assignmentAttempts, expiryAttempts); }
    finally { store.beforeCommit = null; } await login('project_manager');

    // Lose the claim ACK after it durably enters sending. No fake provider was
    // called, but edits must stop until that original delivery is resolved.
    const claim = await preview('projectTaskAssign', 'POST', boundaryPath, { memberId: 15 }); assert.equal(claim.status, 200); const claimProof = { token: claim.value.token, version: claim.value.version, confirmed: true, requestId: crypto.randomUUID() }, claimAttempts = assignmentAttempts, priorJobs = new Set(deliveryValidator.valid(store.current()).map(row => row.id));
    store.beforeCommit = async candidate => { if ((candidate.workspaceAssignmentJobs || []).some(row => !priorJobs.has(row.id) && row.status === 'sending')) { store.beforeCommit = null; store.loseCommitAck = true; } };
    try { assert.equal((await request(boundaryPath, { method: 'POST', data: claimProof })).status, 503); } finally { store.beforeCommit = null; }
    const unacknowledged = deliveryValidator.valid(store.current()).find(row => !priorJobs.has(row.id)); assert.ok(unacknowledged); assert.equal(unacknowledged.status, 'sending'); assert.equal(assignmentAttempts, claimAttempts); assert.deepEqual(taskById(boundaryId).memberIds, [15]);
    const claimLookup = { token: claimProof.token, version: claimProof.version, requestId: claimProof.requestId, method: 'POST', path: boundaryPath }; assert.equal((await request('/api/resources/original-result', { method: 'POST', data: claimLookup })).status, 200); assert.equal(assignmentAttempts, claimAttempts);
    await deny('projectTaskAssign', 'POST', boundaryPath, { memberId: 14 }, tokens.owner, 409);
    const signedJobs = store.current().workspaceAssignmentJobs; await mutate(db => { db.workspaceAssignmentJobs[0].proof = '0'.repeat(64); }); const poisonedJobs = canonicalHash(store.current()), poisonedJobsRevision = store.revision();
    assert.equal((await request('/api/projects/101/tasks')).status, 409); assert.equal(canonicalHash(store.current()), poisonedJobs); assert.equal(store.revision(), poisonedJobsRevision); assert.equal(assignmentAttempts, claimAttempts);
    await mutate(db => { db.workspaceAssignmentJobs = signedJobs; });

    // Losing the business commit ACK leaves the original reviewed work and its
    // queued delivery durable. Lookup observes only; original confirmation may
    // then deliver those original jobs once without creating business rows.
    const recoverTask = await save('projectTaskCreate', 'POST', '/api/projects/101/tasks', { name: 'Queued original delivery recovery', durationDays: 1, predecessorIds: [boundaryId], memberIds: [14], crew: 'North' });
    const recoverId = recoverTask.r.value.tasks.find(row => row.name === 'Queued original delivery recovery').id, recoverPath = '/api/project-tasks/' + recoverId + '/assign'; assert.equal(taskById(recoverId).startDate, '2026-10-20');
    const recoverPreview = await preview('projectTaskAssign', 'POST', recoverPath, { memberId: 15 }); assert.equal(recoverPreview.status, 200); assert.deepEqual(recoverPreview.value.impact.taskAssignment, { createdCount: 1, mergedCount: 0, skippedCount: 0 });
    const recoverProof = { token: recoverPreview.value.token, version: recoverPreview.value.version, confirmed: true, requestId: crypto.randomUUID() }, recoveryAttempts = assignmentAttempts, earlierJobs = new Set(deliveryValidator.valid(store.current()).map(row => row.id));
    store.loseCommitAck = true; assert.equal((await request(recoverPath, { method: 'POST', data: recoverProof })).status, 503); assert.equal(assignmentAttempts, recoveryAttempts);
    const originalQueued = deliveryValidator.valid(store.current()).filter(row => !earlierJobs.has(row.id)); assert.equal(originalQueued.length, 1); assert.equal(originalQueued[0].status, 'queued');
    const originalReceipt = store.current().resourceReceipts.find(row => row.requestId === recoverProof.requestId); assert.ok(originalReceipt); assert.deepEqual(originalReceipt.retained.assignmentIds, originalQueued[0].source.assignments.map(row => row.id)); assert.deepEqual(originalReceipt.retained.assignmentJobs, [{ id: originalQueued[0].id, sourceHash: originalQueued[0].sourceHash }]);
    const recoveryState = store.current(), recoveryRevision = store.revision(), recoveryLookup = { token: recoverProof.token, version: recoverProof.version, requestId: recoverProof.requestId, method: 'POST', path: recoverPath };
    const originalOutcome = await request('/api/resources/original-result', { method: 'POST', data: recoveryLookup }); assert.equal(originalOutcome.status, 200); assert.equal(originalOutcome.value.originalSaveResult, true); assert.equal(assignmentAttempts, recoveryAttempts); assert.equal(store.revision(), recoveryRevision); assert.equal(canonicalHash(store.current()), canonicalHash(recoveryState));
    deliveryProof = { requestId: recoverProof.requestId, memberId: 15 }; let originalConfirmation;
    try { originalConfirmation = await request(recoverPath, { method: 'POST', data: recoverProof }); } finally { deliveryProof = null; }
    assert.equal(originalConfirmation.status, 200, JSON.stringify(originalConfirmation.value)); assert.equal(originalConfirmation.value.originalSaveResult, true); assert.equal(assignmentAttempts, recoveryAttempts + 1); assert.equal(assignmentMessages.at(-1).idempotencyKey, originalQueued[0].id); assert.equal(assignmentMessages.at(-1).source.memberId, 15);
    const recoveredState = store.current(), recoveredAssignments = structuredClone(recoveryState.assignments); for (const row of recoveredAssignments.filter(row => originalQueued[0].source.assignments.some(source => source.id === row.id))) row.notifications[15].emailStatus = 'sent';
    assert.deepEqual(recoveredState.projectTasks, recoveryState.projectTasks); assert.deepEqual(recoveredState.assignments, recoveredAssignments); assert.deepEqual(recoveredState.resourceReceipts, recoveryState.resourceReceipts); assert.deepEqual(recoveredState.resourcePreviews, recoveryState.resourcePreviews); assert.deepEqual(recoveredState.auditLog, recoveryState.auditLog);
    assert.equal(deliveryValidator.valid(recoveredState).find(row => row.id === originalQueued[0].id).status, 'sent'); assert.equal(store.revision(), recoveryRevision + 2, 'only claim and final delivery CAS run during original confirmation recovery');
    const deliveredRevision = store.revision(); assert.equal((await request(recoverPath, { method: 'POST', data: recoverProof })).status, 200); assert.equal(assignmentAttempts, recoveryAttempts + 1); assert.equal(store.revision(), deliveredRevision); assert.equal((await request('/api/resources/original-result', { method: 'POST', data: recoveryLookup })).status, 200); assert.equal(assignmentAttempts, recoveryAttempts + 1); assert.equal(store.revision(), deliveredRevision);
    // A different valid intent for the same assignment IDs/member/session is
    // independently staged later. Old task confirmation cannot select it.
    let laterJobId;
    await mutate(db => { const row = db.assignments.find(value => value.id === originalReceipt.retained.assignmentIds[0]); row.activity = 'Later independently reviewed delivery'; const owner = authenticateSession(db, crypto.createHash('sha256').update(tokens.owner).digest('hex')); laterJobId = deliveryValidator.stage(db, { auth: owner }, [row.id], 15)[0]; });
    const laterState = store.current(), laterJob = deliveryValidator.valid(laterState).find(row => row.id === laterJobId), laterRevision = store.revision(); assert.ok(laterJob); assert.equal(laterJob.status, 'queued'); assert.equal(laterJob.actorId, originalQueued[0].actorId); assert.equal(laterJob.sessionHash, originalQueued[0].sessionHash); assert.equal(laterJob.source.memberId, originalQueued[0].source.memberId); assert.deepEqual(laterJob.source.assignments.map(row => row.id), originalReceipt.retained.assignmentIds); assert.notEqual(laterJob.id, originalQueued[0].id); assert.notEqual(laterJob.sourceHash, originalQueued[0].sourceHash); assert.equal(deliveryValidator.authorised(laterState, laterJob), true, 'later job is valid and currently eligible, so exact original-job selection is essential');
    assert.equal((await request(recoverPath, { method: 'POST', data: recoverProof })).status, 200); assert.equal(assignmentAttempts, recoveryAttempts + 1); assert.equal(store.revision(), laterRevision); assert.equal(canonicalHash(store.current()), canonicalHash(laterState)); assert.equal(deliveryValidator.valid(store.current()).find(row => row.id === laterJobId).status, 'queued');
    assert.equal((await request('/api/resources/original-result', { method: 'POST', data: recoveryLookup })).status, 200); assert.equal(assignmentAttempts, recoveryAttempts + 1); assert.equal(store.revision(), laterRevision);
    assert.equal(assignmentAttempts, assignmentMessages.length, 'every allowed fake provider invocation is accounted for');
    assert.equal(externalAttempts.length, 0, 'actual candidates must never call the legacy SMTP/provider route');
    assert.equal(fixture.messages.length, 0, 'CRUD/date task actions do not send provider messages');
    assert.deepEqual(fs.readFileSync(file), legacyBytes); assert.deepEqual(fs.readFileSync(platformFile), platformBytes);
    console.log('resource project-task HTTP: actual CRUD/date cascades, retained history, scheduling scopes, in-flight revocation/expiry, lost-ACK recovery and CAS-first assignee-only assignment delivery/replay/uncertain blocking passed');
  } finally { process.env.RESEND_API_KEY = ''; globalThis.fetch = originalFetch; uninstall(); mod.server.closeAllConnections(); await new Promise(resolve => mod.server.close(resolve)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
