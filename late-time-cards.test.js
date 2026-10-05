'use strict';

// These API regressions use only synthetic companies, people and persisted files.
// No repository/customer database, external service or fixed network port is used.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-late-time-'));
const dbFile = path.join(root, 'db.json');
const companyA = '11111111-1111-4111-8111-111111111111';
const companyB = '22222222-2222-4222-8222-222222222222';
const periodId = '33333333-3333-4333-8333-333333333333';
const exportId = '44444444-4444-4444-8444-444444444444';
const token = (company, user) => `synthetic-late-time-${company}-${user}`;
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const roles = { owner: 1, admin: 2, viewer: 3, manager: 4, field: 5, foreman: 6, unlinked: 7, otherField: 8, unlinkedForeman: 9, missingMember: 10 };

function card(id = 101, overrides = {}) {
  return {
    id, projectId: 2, memberId: 1, date: '2026-08-10',
    inAt: '2026-08-10T15:00:00.000Z', outAt: '2026-08-10T23:00:00.000Z', hours: 8,
    status: 'draft', workdayId: null, reportId: null, submittedAt: null, submittedBy: null,
    approvedAt: null, approvedBy: null,
    history: [{ action: 'Opened', by: 'Synthetic field', at: '2026-08-10T15:00:00.000Z' }],
    ...overrides
  };
}

function report(id, date, status = 'Draft', overrides = {}) {
  return {
    id, project: 1, dateIso: date, status, foreman: 'Synthetic field',
    laborEntries: [{ memberId: 1, hours: 8, crew: 'QA crew' }],
    productionEntries: [{ id: 'synthetic-production', description: 'Synthetic work', quantity: 1, laborHours: 8 }],
    history: [{ action: 'Created', by: 'Synthetic field', at: `${date}T23:00:00.000Z` }],
    ...overrides
  };
}

function fixture(companyId) {
  const users = [
    { id: roles.owner, role: 'owner' },
    { id: roles.admin, role: 'admin', permissions: { manageTime: true } },
    { id: roles.viewer, role: 'project_manager', permissions: { viewTime: true } },
    { id: roles.manager, role: 'project_manager', permissions: { manageTime: true } },
    { id: roles.field, role: 'field', memberId: 1 },
    { id: roles.foreman, role: 'foreman', memberId: 2 },
    { id: roles.unlinked, role: 'field' },
    { id: roles.otherField, role: 'field', memberId: 3 },
    { id: roles.unlinkedForeman, role: 'foreman' },
    { id: roles.missingMember, role: 'field', memberId: 999 }
  ].map(user => ({
    companyId, name: `Synthetic user ${user.id}`, email: `late-time-${user.id}@example.invalid`,
    status: 'Active', emailVerifiedAt: '2026-01-01T00:00:00Z', projectIds: [1], assignedCrews: ['QA crew'], ...user
  }));
  return {
    company: { id: companyId, name: 'Synthetic late-time workspace', demo: true, timezone: 'America/Los_Angeles', features: { timeCards: true } },
    users,
    sessions: users.map(user => ({ id: crypto.randomUUID(), companyId, userId: user.id, tokenHash: hash(token(companyId, user.id)), expiresAt: '2099-01-01T00:00:00Z' })),
    team: [
      { id: 1, name: 'Synthetic field', initials: 'SF', role: 'Laborer', crew: 'QA crew' },
      { id: 2, name: 'Synthetic foreman', initials: 'SM', role: 'Foreman', crew: 'QA crew' },
      { id: 3, name: 'Synthetic other crew', initials: 'SO', role: 'Laborer', crew: 'Other crew' }
    ],
    projects: [
      { id: 1, name: 'Currently assigned project', code: 'CURRENT', estimateItems: [] },
      { id: 2, name: 'Historical unassigned project', code: 'OLD', archived: true, estimateItems: [] }
    ],
    assignments: [{ id: 1, projectId: 1, date: '2026-10-05', memberIds: [1, 2], start: '08:00', end: '16:00' }],
    timeCards: [
      card(),
      card(102, { memberId: 2 }),
      card(103, { memberId: 3 }),
      card(104, { projectId: 1, date: '2026-08-11', inAt: '2026-08-11T15:00:00.000Z', outAt: '2026-08-11T23:00:00.000Z' })
    ],
    reports: [], customers: [], subcontractors: [], photos: [], workdays: [], changes: [], auditLog: [], payPeriods: [], payPeriodExports: []
  };
}

fs.mkdirSync(path.join(root, 'tenants'));
fs.writeFileSync(path.join(root, 'platform.json'), JSON.stringify({ users: [], sessions: [], notes: [] }));
let child, base, serverLog = '', passed = 0;
const read = (company = companyA) => JSON.parse(fs.readFileSync(company === companyA ? dbFile : path.join(root, 'tenants', `${company}.json`), 'utf8'));
const storedCard = id => read().timeCards.find(row => Number(row.id) === Number(id));

async function startServer(db) {
  fs.writeFileSync(dbFile, JSON.stringify(db));
  fs.writeFileSync(path.join(root, 'tenants', `${companyB}.json`), JSON.stringify(fixture(companyB)));
  const env = {
    ...process.env, PDL_DB_FILE: dbFile, PDL_PLATFORM_FILE: path.join(root, 'platform.json'),
    PDL_SUPABASE_ENABLED: '0', PDL_TRANSACTIONAL_DB: 'off', PDL_REQUIRE_AUTH: '1',
    PDL_EMAIL_DEV_MODE: '1', PDL_FOUNDER_ENABLED: '0', TZ: 'UTC'
  };
  for (const key of ['SENTRY_DSN', 'RESEND_API_KEY', 'OPENAI_API_KEY', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET']) delete env[key];
  serverLog = '';
  child = spawn(process.execPath, ['-e', "const {server}=require('./server');server.listen(0,'127.0.0.1',()=>console.log('LATE_TIME_TEST_PORT='+server.address().port));"], { cwd: __dirname, env, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Synthetic late-time server did not start: ' + serverLog)), 15000);
    child.stdout.on('data', bytes => {
      serverLog += String(bytes);
      const match = serverLog.match(/LATE_TIME_TEST_PORT=(\d+)/);
      if (match) { base = `http://127.0.0.1:${match[1]}`; clearTimeout(timeout); resolve(); }
    });
    child.stderr.on('data', bytes => { serverLog += String(bytes); });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', code => { clearTimeout(timeout); reject(new Error(`Synthetic late-time server exited ${code}: ${serverLog}`)); });
  });
}

async function stopServer() {
  if (!child || child.exitCode != null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  await exited;
  child = null;
}

async function rawRequest(method, route, user = roles.field, input, company = companyA, extras = {}) {
  const response = await fetch(base + route, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-PDL-Company': company, ...(user == null ? {} : { Authorization: `Bearer ${token(company, user)}` }), ...extras },
    ...(input === undefined ? {} : { body: JSON.stringify(input) })
  });
  const json = (response.headers.get('content-type') || '').includes('application/json');
  return { status: response.status, data: json ? await response.json() : await response.text(), headers: response.headers };
}

async function request(method, route, user = roles.field, input, company = companyA, extras = {}) {
  if (method === 'PATCH' && /^\/api\/time-cards\/\d+$/.test(route) && user >= roles.field && input && typeof input === 'object' && !Array.isArray(input) && !Object.hasOwn(input, 'revision')) {
    const listed = await rawRequest('GET', '/api/time-cards', user, undefined, company, extras);
    const row = Array.isArray(listed.data) && listed.data.find(row => String(row.id) === route.split('/').at(-1));
    if (row?.fieldAccess?.revision) input = { ...input, revision: row.fieldAccess.revision };
  }
  return rawRequest(method, route, user, input, company, extras);
}

async function expectStatus(expected, ...args) {
  const result = await request(...args);
  assert.equal(result.status, expected, `${args[0]} ${args[1]} user ${args[2]}: ${JSON.stringify(result.data)}`);
  return result.data;
}

async function denied(...args) {
  const result = await request(...args);
  assert.ok([403, 404].includes(result.status), `${args[0]} ${args[1]} must deny out-of-scope access: ${JSON.stringify(result)}`);
  return result.data;
}

function access(row, canEdit, canSubmit, label = '') {
  assert.ok(row?.fieldAccess, `${label}: GET must provide fieldAccess`);
  assert.equal(row.fieldAccess.canEdit, canEdit, `${label}: canEdit`);
  assert.equal(row.fieldAccess.canSubmit, canSubmit, `${label}: canSubmit`);
  assert.ok(Object.hasOwn(row.fieldAccess, 'reason'), `${label}: capability reason must be present`);
  if (!canEdit || !canSubmit) assert.equal(typeof row.fieldAccess.reason, 'string', `${label}: blocked action needs an explanation`);
}

const edit = overrides => ({ reason: 'Correct my late time entry', outAt: '2026-08-11T00:00:00.000Z', ...overrides });
async function scenario(label, build, run) {
  await stopServer();
  const db = fixture(companyA);
  if (build) build(db);
  await startServer(db);
  try { await run(); passed++; }
  catch (error) { error.message = `${label}: ${error.message}`; throw error; }
}

(async () => {
  try {
    await scenario('Historical ownership and tenant isolation', null, async () => {
      assert.equal((await fetch(base + '/late-time-cards.test.js')).status, 404, 'test fixtures are not served publicly');
      await expectStatus(401, 'GET', '/api/time-cards', null);
      const own = await expectStatus(200, 'GET', '/api/time-cards');
      assert.deepEqual(own.map(row => row.id).sort(), [101, 104]);
      access(own.find(row => row.id === 101), true, true, 'historical card without current project assignment');
      const foreman = await expectStatus(200, 'GET', '/api/time-cards', roles.foreman);
      assert.ok(foreman.some(row => row.id === 101), 'existing foreman crew visibility remains');
      access(foreman.find(row => row.id === 101), false, false, 'foreman viewing another crew member');
      access(foreman.find(row => row.id === 102), true, true, 'foreman own historical card');
      for (const user of [roles.unlinked, roles.unlinkedForeman, roles.missingMember]) {
        const result = await request('GET', '/api/time-cards', user);
        assert.ok(result.status === 403 || result.status === 200 && result.data.length === 0, 'unlinked accounts cannot see cards');
        await denied('PATCH', '/api/time-cards/101', user, edit());
        await denied('POST', '/api/time-cards/101/submit', user, {});
      }
      await denied('PATCH', '/api/time-cards/103', roles.field, edit());
      await denied('POST', '/api/time-cards/103/submit', roles.field, {});
      await denied('PATCH', '/api/time-cards/101', roles.foreman, edit());
      await denied('POST', '/api/time-cards/101/submit', roles.foreman, {});
      await expectStatus(403, 'GET', '/api/time-cards?memberId=3', roles.field);
      const otherTenant = read(companyB).timeCards;
      await expectStatus(401, 'PATCH', '/api/time-cards/101', roles.field, edit(), companyA, { 'X-PDL-Company': companyB });
      const corrected = await expectStatus(200, 'PATCH', '/api/time-cards/101', roles.field, edit());
      assert.equal(corrected.hours, 9);
      assert.equal(corrected.status, 'draft');
      assert.equal(corrected.projectId, 2);
      assert.equal(corrected.memberId, 1);
      assert.equal(corrected.history.at(-1).by, 'Synthetic user 5');
      assert.equal(corrected.history.at(-1).reason, edit().reason);
      assert.equal(corrected.original.hours, 8);
      assert.deepEqual(read(companyB).timeCards, otherTenant, 'same card and member IDs never cross tenants');
      const submitted = await expectStatus(200, 'POST', '/api/time-cards/101/submit', roles.field, {});
      assert.equal(submitted.status, 'submitted');
      assert.equal(submitted.submittedBy, 'Synthetic user 5');
      assert.equal(submitted.approvedAt, null);
      access((await expectStatus(200, 'GET', '/api/time-cards')).find(row => row.id === 101), false, false, 'submitted own card');
      await expectStatus(200, 'PATCH', '/api/time-cards/102', roles.foreman, edit());
      await expectStatus(200, 'POST', '/api/time-cards/102/submit', roles.foreman, {});
      for (const [user, id] of [[roles.field, 101], [roles.foreman, 102]]) {
        await expectStatus(403, 'POST', `/api/time-cards/${id}/approve`, user, {});
        await expectStatus(403, 'POST', '/api/time-cards/approve', user, { ids: [id] });
        await expectStatus(403, 'DELETE', `/api/time-cards/${id}`, user, { reason: 'Not office' });
      }
      await expectStatus(200, 'POST', '/api/time-cards/101/approve', roles.owner, {});
      assert.equal(storedCard(101).status, 'approved', 'ordinary office approval still works');
    });

    await scenario('Immutable identity, validation and concurrent state change', null, async () => {
      const before = storedCard(101);
      for (const change of [
        { id: 103 }, { companyId: companyB }, { memberId: 3 }, { projectId: 1 }, { workdayId: 123 }, { reportId: 123 },
        { activityCodeId: 'company-1' }, { date: '2026-08-11' }, { hours: 80 }, { status: 'approved' },
        { approvedAt: '2026-08-10T23:00:00Z' }, { approvedBy: 'Spoofed office' }, { submittedBy: 'Spoofed user' },
        { history: [] }, { fieldAccess: { canEdit: true, canSubmit: true } }
      ]) {
        await expectStatus(400, 'PATCH', '/api/time-cards/101', roles.field, edit(change));
        assert.deepEqual(storedCard(101), before, 'rejected immutable-field attempt must not persist partial edits');
      }
      for (const input of [null, [], 'bad body']) {
        await expectStatus(409, 'PATCH', '/api/time-cards/101', roles.field, input);
        assert.deepEqual(storedCard(101), before, 'invalid revision-free input cannot mutate the card');
      }
      for (const input of [{}, { outAt: '2026-08-11T00:00:00Z' }, edit({ inAt: 'invalid' }), edit({ outAt: 'invalid' }), edit({ outAt: before.inAt }), edit({ outAt: '2026-08-10T14:00:00Z' }), edit({ outAt: '2099-08-10T23:00:00Z' })]) {
        await expectStatus(400, 'PATCH', '/api/time-cards/101', roles.field, input);
        assert.deepEqual(storedCard(101), before, 'invalid input must not mutate the card');
      }
      access((await expectStatus(200, 'GET', '/api/time-cards')).find(row => row.id === 101), true, true);
      await expectStatus(200, 'POST', '/api/time-cards/101/submit', roles.owner, {});
      const submitted = storedCard(101);
      await expectStatus(409, 'PATCH', '/api/time-cards/101', roles.field, edit());
      await expectStatus(409, 'POST', '/api/time-cards/101/submit', roles.field, {});
      assert.deepEqual(storedCard(101), submitted, 'stale field UI cannot reopen an office-submitted card');
    });

    await scenario('Required revisions prevent silent overwrites and repeated saves', db => { db.timeCards = [card()]; }, async () => {
      const before = storedCard(101);
      assert.equal((await rawRequest('PATCH', '/api/time-cards/101', roles.field, edit())).status, 409, 'field saves need a current revision');
      assert.deepEqual(storedCard(101), before);
      const revision = (await expectStatus(200, 'GET', '/api/time-cards'))[0].fieldAccess.revision;
      assert.match(revision, /^[0-9a-f]{64}$/);
      await expectStatus(200, 'PATCH', '/api/time-cards/101', roles.owner, edit({ outAt: '2026-08-10T22:00:00.000Z', reason: 'Concurrent office correction' }));
      const officeVersion = storedCard(101);
      await expectStatus(409, 'PATCH', '/api/time-cards/101', roles.field, edit({ revision }));
      await expectStatus(409, 'POST', '/api/time-cards/101/submit', roles.field, { revision });
      assert.deepEqual(storedCard(101), officeVersion, 'stale edits and submits cannot replace the corrected version');
      const fresh = (await expectStatus(200, 'GET', '/api/time-cards'))[0].fieldAccess.revision;
      assert.notEqual(fresh, revision);
      const saves = await Promise.all([
        request('PATCH', '/api/time-cards/101', roles.field, edit({ revision: fresh })),
        request('PATCH', '/api/time-cards/101', roles.field, edit({ revision: fresh }))
      ]);
      assert.deepEqual(saves.map(row => row.status).sort(), [200, 409], 'a repeated save cannot apply twice');
      assert.equal(storedCard(101).hours, 9);
      assert.equal(storedCard(101).history.filter(row => row.reason === edit().reason).length, 1);
    });

    await scenario('Missing clock-out and rejected-card resubmission', db => {
      db.timeCards = [card(101, { outAt: null, hours: null }), card(102, { memberId: 2, status: 'rejected' })];
    }, async () => {
      access((await expectStatus(200, 'GET', '/api/time-cards'))[0], true, false, 'missing clock-out');
      await expectStatus(409, 'POST', '/api/time-cards/101/submit', roles.field, {});
      const fixed = await expectStatus(200, 'PATCH', '/api/time-cards/101', roles.field, edit({ outAt: '2026-08-10T23:00:00.000Z' }));
      assert.equal(fixed.hours, 8);
      assert.equal(fixed.date, '2026-08-10', 'late correction retains the actual company-local work date');
      await expectStatus(200, 'POST', '/api/time-cards/101/submit', roles.field, {});
      access((await expectStatus(200, 'GET', '/api/time-cards', roles.foreman)).find(row => row.id === 102), true, true, 'rejected own card');
      await expectStatus(200, 'PATCH', '/api/time-cards/102', roles.foreman, edit());
      assert.equal((await expectStatus(200, 'POST', '/api/time-cards/102/submit', roles.foreman, {})).status, 'submitted');
    });

    await scenario('Shared active workday cannot be detached by manually closing its card', db => {
      db.timeCards = [card(101, { workdayId: 601, outAt: null, hours: null }), card(102, { workdayId: 601, memberId: 2, outAt: null, hours: null })];
      db.workdays = [{ id: 601, projectId: 2, memberIds: [1, 2], status: 'active', startedAt: '2026-08-10T15:00:00Z', endedAt: null, reportId: null }];
    }, async () => {
      const before = { cards: read().timeCards, workdays: read().workdays, reports: read().reports };
      const own = (await expectStatus(200, 'GET', '/api/time-cards'))[0];
      access(own, false, false, 'shared active linked workday');
      assert.match(own.fieldAccess.reason, /end.*workday/i);
      await expectStatus(409, 'PATCH', '/api/time-cards/101', roles.field, edit());
      await expectStatus(409, 'POST', '/api/time-cards/101/submit', roles.field, {});
      assert.deepEqual({ cards: read().timeCards, workdays: read().workdays, reports: read().reports }, before);
    });

    await scenario('Own single-member active workday recovers accurate overnight times atomically', db => {
      db.timeCards = [card(101, { workdayId: 601, outAt: null, hours: null }), card(102, { memberId: 2, workdayId: 602 })];
      db.workdays = [
        { id: 601, projectId: 2, memberIds: [1], status: 'active', startedAt: '2026-08-10T15:00:00Z', endedAt: null, reportId: null, startNote: 'Keep original note' },
        { id: 602, projectId: 2, memberIds: [2], status: 'complete', startedAt: '2026-08-10T15:00:00Z', endedAt: '2026-08-10T23:00:00Z', reportId: null }
      ];
    }, async () => {
      const before = read(), own = (await expectStatus(200, 'GET', '/api/time-cards'))[0];
      access(own, true, false, 'recoverable own active workday');
      await expectStatus(409, 'POST', '/api/time-cards/101/submit', roles.field, {});
      await expectStatus(409, 'POST', '/api/time-cards/101/clock-out', roles.field, {});
      const input = {
        inAt: '2026-08-11T04:00:00.000Z', outAt: '2026-08-11T12:00:00.000Z',
        reason: 'Recover actual overnight shift, not elapsed time until today', revision: own.fieldAccess.revision,
        breaks: [{ type: 'unpaid_meal', startedAt: '2026-08-11T08:00:00Z', endedAt: '2026-08-11T08:30:00Z' }]
      };
      const corrected = await expectStatus(200, 'PATCH', '/api/time-cards/101', roles.field, input);
      assert.equal(corrected.workdayCompleted, true);
      assert.equal(corrected.hours, 7.5);
      assert.equal(corrected.date, '2026-08-10', 'full overnight shift belongs to its local clock-in day');
      const after = read(), workday = after.workdays.find(row => row.id === 601);
      assert.equal(workday.status, 'complete');
      assert.equal(workday.startedAt, input.inAt);
      assert.equal(workday.endedAt, input.outAt);
      assert.equal(workday.startNote, 'Keep original note');
      assert.equal(workday.history.at(-1).by, 'Synthetic user 5');
      assert.equal(workday.history.at(-1).reason, input.reason);
      assert.deepEqual(after.reports, before.reports, 'recovery never fabricates a daily report from elapsed calendar days');
      assert.deepEqual(after.timeCards.find(row => row.id === 102), before.timeCards.find(row => row.id === 102));
      assert.deepEqual(after.workdays.find(row => row.id === 602), before.workdays.find(row => row.id === 602));
      await expectStatus(409, 'PATCH', '/api/time-cards/101', roles.field, input);
      await expectStatus(404, 'POST', '/api/workdays/601/end', roles.field, { notes: 'Stale End workday action' });
      assert.deepEqual(read().reports, before.reports);
      assert.deepEqual(read().workdays, after.workdays, 'retries and stale End workday cannot append history or change actual dates');
      await expectStatus(200, 'POST', '/api/time-cards/101/submit', roles.field, {});
      const started = await expectStatus(201, 'POST', '/api/workdays/start', roles.field, { projectId: 1, memberIds: [1] });
      assert.equal(started.status, 'active');
      assert.notEqual(started.id, 601, 'recovery releases the person to start a new workday');
      assert.equal(storedCard(101).hours, 7.5);
      assert.deepEqual(read().reports, before.reports);
    });

    await scenario('Single-member recovery synchronizes only its existing draft and preserves rates', db => {
      db.timeCards = [card(101, { workdayId: 601, reportId: 501, outAt: null, hours: null }), card(102, { memberId: 2, reportId: 501 })];
      db.workdays = [{ id: 601, projectId: 2, memberIds: [1], status: 'active', startedAt: '2026-08-10T15:00:00Z', endedAt: null, reportId: 501 }];
      db.projects[1].tmSettings = { defaultLaborRate: 125, materialMarkup: 10 };
      db.reports = [report(501, '2026-08-10', 'Draft', {
        laborEntries: [{ memberId: 1, hours: 0, crew: 'QA crew' }, { memberId: 2, hours: 8, crew: 'QA crew' }],
        rateSnapshot: { schemaVersion: 1, laborRate: 90, capturedAt: '2026-08-09T00:00:00Z', capturedBy: { id: 1, name: 'Office', role: 'owner' }, source: 'synthetic-prior-rate' },
        rateReview: { status: 'Reviewed' }, rateHistory: [{ reason: 'Preserve historical rate' }]
      }), report(502, '2026-08-10', 'Approved')];
    }, async () => {
      const before = read();
      const corrected = await expectStatus(200, 'PATCH', '/api/time-cards/101', roles.field, edit({ inAt: '2026-08-10T15:00:00.000Z' }));
      assert.equal(corrected.workdayCompleted, true);
      assert.equal(corrected.reportSynced, true);
      const after = read(), draft = after.reports.find(row => row.id === 501), previous = before.reports.find(row => row.id === 501);
      assert.equal(after.reports.length, 2, 'recovery uses the existing draft without creating another');
      assert.equal(draft.laborEntries.find(row => row.memberId === 1).hours, 9);
      assert.deepEqual(draft.laborEntries.find(row => row.memberId === 2), previous.laborEntries.find(row => row.memberId === 2));
      assert.equal(draft.productionEntries[0].laborHours, 17);
      for (const key of ['rateSnapshot', 'rateReview', 'rateHistory']) assert.deepEqual(draft[key], previous[key], `${key} survives field recovery unchanged`);
      assert.deepEqual(after.projects, before.projects, 'current project rate settings stay untouched');
      assert.deepEqual(after.reports.find(row => row.id === 502), before.reports.find(row => row.id === 502));
      assert.deepEqual(after.timeCards.find(row => row.id === 102), before.timeCards.find(row => row.id === 102));
    });

    await scenario('Break validation and quarter-hour totals', db => { db.timeCards = [card()]; }, async () => {
      const before = storedCard(101);
      for (const breaks of [
        null, {}, [null], [{ type: 'unknown', startedAt: '2026-08-10T18:00:00Z', endedAt: '2026-08-10T18:30:00Z' }],
        [{ type: 'unpaid_meal', startedAt: '2026-08-10T14:00:00Z', endedAt: '2026-08-10T15:30:00Z' }],
        [{ type: 'unpaid_meal', startedAt: '2026-08-10T23:30:00Z', endedAt: '2026-08-11T00:30:00Z' }],
        [{ type: 'unpaid_meal', startedAt: '2026-08-10T18:00:00Z', endedAt: null }],
        [{ type: 'unpaid_meal', startedAt: '2026-08-10T18:00:00Z', endedAt: '2026-08-10T17:00:00Z' }],
        [{ type: 'unpaid_meal', startedAt: '2026-08-10T18:00:00Z', endedAt: '2026-08-10T18:30:00Z' }, { type: 'paid_rest', startedAt: '2026-08-10T18:15:00Z', endedAt: '2026-08-10T18:45:00Z' }]
      ]) {
        await expectStatus(400, 'PATCH', '/api/time-cards/101', roles.field, edit({ breaks }));
        assert.deepEqual(storedCard(101), before, 'invalid breaks cannot partially update hours');
      }
      const fixed = await expectStatus(200, 'PATCH', '/api/time-cards/101', roles.field, edit({ breaks: [
        { type: 'unpaid_meal', startedAt: '2026-08-10T18:00:00Z', endedAt: '2026-08-10T18:30:00Z' },
        { type: 'paid_rest', startedAt: '2026-08-10T18:30:00Z', endedAt: '2026-08-10T18:45:00Z' }
      ] }));
      assert.equal(fixed.hours, 8.5, 'unpaid meals deduct time; paid adjacent rests do not');
      await expectStatus(200, 'POST', '/api/time-cards/101/submit', roles.field, {});
    });

    for (const [label, overrides] of [
      ['submitted', { status: 'submitted', submittedAt: '2026-08-10T23:00:00Z', submittedBy: 'Office' }],
      ['approved', { status: 'approved', approvedAt: '2026-08-10T23:00:00Z', approvedBy: 'Office' }],
      ['closed state', { status: 'closed' }],
      ['unknown state', { status: 'unexpected' }],
      ['draft with approval metadata', { approvedAt: '2026-08-10T23:00:00Z', approvedBy: 'Office' }],
      ['draft with approved alternate state', { state: 'approved' }],
      ['draft with submitted alternate state', { state: 'submitted' }],
      ['draft with pending approval alias', { approvalStatus: 'pending' }]
    ]) await scenario(`Locked state: ${label}`, db => { db.timeCards = [card(101, overrides)]; }, async () => {
      const before = storedCard(101);
      access((await expectStatus(200, 'GET', '/api/time-cards'))[0], false, false, label);
      await expectStatus(409, 'PATCH', '/api/time-cards/101', roles.field, edit());
      await expectStatus(409, 'POST', '/api/time-cards/101/submit', roles.field, {});
      await expectStatus(409, 'POST', '/api/time-cards/101/clock-out', roles.field, {});
      assert.deepEqual(storedCard(101), before, 'locked field attempts preserve every stored field');
    });

    await scenario('Deleted cards stay inaccessible', db => { db.timeCards = [card(101, { status: 'deleted', deletedAt: '2026-08-11T00:00:00Z' })]; }, async () => {
      assert.deepEqual(await expectStatus(200, 'GET', '/api/time-cards'), []);
      await expectStatus(404, 'PATCH', '/api/time-cards/101', roles.field, edit());
      await expectStatus(404, 'POST', '/api/time-cards/101/submit', roles.field, {});
    });

    await scenario('Draft report sync preserves submitted and approved reports', db => {
      db.timeCards = [card(101, { reportId: 501 })];
      db.reports = [report(501, '2026-08-10'), report(502, '2026-08-10', 'Needs review'), report(503, '2026-08-10', 'Approved')];
    }, async () => {
      const immutableReports = read().reports.filter(row => row.id !== 501);
      await expectStatus(200, 'PATCH', '/api/time-cards/101', roles.field, edit());
      const draft = read().reports.find(row => row.id === 501);
      assert.equal(draft.laborEntries[0].hours, 9, 'own late edit updates its linked draft report');
      assert.equal(draft.productionEntries[0].laborHours, 9);
      assert.equal(draft.status, 'Draft');
      assert.deepEqual(read().reports.filter(row => row.id !== 501), immutableReports, 'field edits cannot rewrite submitted/approved reports, even if report-link ranking prefers them');
      assert.equal(storedCard(101).reportId, 501);
      await expectStatus(200, 'POST', '/api/time-cards/101/submit', roles.field, {});
      assert.deepEqual(read().reports.filter(row => row.id !== 501), immutableReports);
    });

    for (const status of ['Needs review', 'Approved']) await scenario(`Linked ${status} report stays untouched`, db => {
      db.timeCards = [card(101, { reportId: 501 })];
      db.reports = [report(501, '2026-08-10', status)];
    }, async () => {
      const before = read().reports;
      await expectStatus(200, 'PATCH', '/api/time-cards/101', roles.field, edit());
      assert.deepEqual(read().reports, before);
      await expectStatus(200, 'POST', '/api/time-cards/101/submit', roles.field, {});
      assert.deepEqual(read().reports, before);
    });

    await scenario('PM scope and office correction behavior are unchanged', db => {
      db.timeCards[3].status = 'approved';
      db.timeCards[3].approvedAt = '2026-08-11T23:00:00Z';
      db.timeCards[3].approvedBy = 'Office';
      db.timeCards[3].reportId = 504;
      db.reports = [report(504, '2026-08-11', 'Needs review', { project: 0 })];
    }, async () => {
      assert.deepEqual((await expectStatus(200, 'GET', '/api/time-cards', roles.viewer)).map(row => row.id), [104]);
      await expectStatus(403, 'PATCH', '/api/time-cards/104', roles.viewer, edit({ outAt: '2026-08-12T00:00:00Z' }));
      await expectStatus(404, 'PATCH', '/api/time-cards/101', roles.manager, edit());
      await expectStatus(404, 'POST', '/api/time-cards/103/approve', roles.manager, {});
      const corrected = await expectStatus(200, 'PATCH', '/api/time-cards/104', roles.manager, edit({ outAt: '2026-08-12T00:00:00Z' }));
      assert.equal(corrected.status, 'draft');
      assert.equal(corrected.approvedAt, null);
      assert.equal(corrected.hours, 9);
      assert.equal(read().reports[0].laborEntries[0].hours, 9, 'authorized office correction retains existing report sync');
      await expectStatus(200, 'POST', '/api/time-cards/104/submit', roles.manager, {});
      await expectStatus(200, 'POST', '/api/time-cards/104/approve', roles.manager, {});
      assert.equal(storedCard(104).status, 'approved');
    });

    // Current company timezone intentionally differs from the period's saved timezone.
    const frozenPeriod = { id: periodId, label: 'Synthetic closed week', from: '2026-08-01', to: '2026-08-07', timeZone: 'America/Los_Angeles', status: 'closed' };
    for (const [label, inAt, outAt, allowed] of [
      ['exact inclusive start', '2026-08-01T07:00:00.000Z', '2026-08-01T08:00:00.000Z', false],
      ['last local minute with overnight clock-out', '2026-08-08T06:59:00.000Z', '2026-08-08T08:00:00.000Z', false],
      ['previous local day with overnight clock-out', '2026-08-01T06:59:00.000Z', '2026-08-01T08:00:00.000Z', true],
      ['next local day at midnight', '2026-08-08T07:00:00.000Z', '2026-08-08T08:00:00.000Z', true]
    ]) await scenario(`Period timezone boundary: ${label}`, db => {
      db.company.timezone = 'America/New_York';
      db.payPeriods = [structuredClone(frozenPeriod)];
      db.timeCards = [card(101, { date: '2026-08-10', inAt, outAt, hours: 1 })];
    }, async () => {
      access((await expectStatus(200, 'GET', '/api/time-cards'))[0], allowed, allowed, label);
      const before = storedCard(101);
      await expectStatus(allowed ? 200 : 409, 'PATCH', '/api/time-cards/101', roles.field, { inAt, outAt, reason: 'Verify period boundary' });
      await expectStatus(allowed ? 200 : 409, 'POST', '/api/time-cards/101/submit', roles.field, {});
      if (!allowed) assert.deepEqual(storedCard(101), before, 'locked cards ignore misleading stored display date');
    });

    await scenario('Cannot move an editable card into a closed period', db => {
      db.payPeriods = [structuredClone(frozenPeriod)];
      db.timeCards = [card()];
    }, async () => {
      const before = storedCard(101);
      await expectStatus(409, 'PATCH', '/api/time-cards/101', roles.field, edit({ inAt: '2026-08-07T15:00:00Z', outAt: '2026-08-07T23:00:00Z' }));
      assert.deepEqual(storedCard(101), before);
      access((await expectStatus(200, 'GET', '/api/time-cards'))[0], true, true);
    });

    await scenario('Cannot move a closed-period card into an open date', db => {
      db.payPeriods = [structuredClone(frozenPeriod)];
      db.timeCards = [card(101, { date: '2026-08-07', inAt: '2026-08-07T15:00:00Z', outAt: '2026-08-07T23:00:00Z' })];
    }, async () => {
      const before = storedCard(101);
      await expectStatus(409, 'PATCH', '/api/time-cards/101', roles.field, edit({ inAt: '2026-08-10T15:00:00Z', outAt: '2026-08-10T23:00:00Z' }));
      assert.deepEqual(storedCard(101), before);
    });

    await scenario('Captured exports lock field edits even if period status is open', db => {
      const period = { ...frozenPeriod, from: '2026-08-10', to: '2026-08-10', status: 'open' };
      db.payPeriods = [period];
      db.timeCards = [card()];
      db.payPeriodExports = [{
        id: exportId, companyId: companyA, periodId, version: 1, supersedesId: null, reason: '',
        createdAt: '2026-08-11T01:00:00Z', createdBy: 'Synthetic office', sourceHash: 'synthetic-frozen-hash',
        summary: {
          period: { id: periodId, label: period.label, from: period.from, to: period.to, timeZone: period.timeZone },
          approvedHours: 8, approvedCount: 1, people: [{ memberId: 1, name: 'Synthetic field', hours: 8, cardCount: 1 }],
          review: { draft: 0, submitted: 0, running: 0, invalid: 0, undated: 0, missingScheduledEntries: 0 }, missingEntries: [], ready: true,
          records: [{ id: 101, memberId: 1, person: 'Synthetic field', projectId: 2, project: 'Historical unassigned project', date: '2026-08-10', inAt: '2026-08-10T15:00:00Z', outAt: '2026-08-10T23:00:00Z', hours: 8, approvedBy: 'Office', approvedAt: '2026-08-11T00:00:00Z' }]
        }
      }];
    }, async () => {
      const route = `/api/pay-periods/${periodId}/exports/${exportId}`;
      const captured = await expectStatus(200, 'GET', route, roles.owner);
      const csv = await expectStatus(200, 'GET', route + '.csv', roles.owner);
      access((await expectStatus(200, 'GET', '/api/time-cards'))[0], false, false, 'captured period');
      await expectStatus(409, 'PATCH', '/api/time-cards/101', roles.field, edit());
      await expectStatus(409, 'POST', '/api/time-cards/101/submit', roles.field, {});
      await expectStatus(200, 'PATCH', '/api/time-cards/101', roles.owner, edit());
      assert.equal(storedCard(101).hours, 9, 'authorized office corrections remain available after capture');
      assert.deepEqual(await expectStatus(200, 'GET', route, roles.owner), captured, 'fixed export data is never rewritten by field denials or office corrections');
      assert.equal(await expectStatus(200, 'GET', route + '.csv', roles.owner), csv, 'fixed export CSV stays byte-for-byte immutable');
    });

    console.log(`Late time-card API regressions passed (${passed} synthetic scenarios): own historical draft/rejected edits and submission, field/foreman/PM/tenant boundaries, validation and state races, report protection, closed-period timezone/overnight boundaries, and fixed export immutability.`);
  } finally {
    await stopServer();
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); if (serverLog) console.error(serverLog); process.exitCode = 1; });
