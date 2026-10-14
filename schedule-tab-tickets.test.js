'use strict';
// Schedule tab cleanup (2026 refresh): Tickets & receipts moves out of the
// Schedule tab into its own project-detail tab, and schedule tasks can be
// linked to estimate line items (validated server-side per project).
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-sched-tab-')), companyId = '55445544-5544-4554-a554-554455445544', ownerToken = 'synthetic-sched-owner';
const db = {
  company: { id: companyId, name: 'Synthetic schedule', demo: true, timezone: 'UTC' },
  projects: [{ id: 101, name: 'Synthetic Job', startDate: '2026-10-05', estimateItems: [{ id: 11, name: 'Set footings', plannedQuantity: 20, unit: 'LF', budgetHours: 40, cost: 8000 }, { id: 12, name: 'Pour slabs', plannedQuantity: 6, unit: 'EA', budgetHours: 24, cost: 12000 }] }],
  team: [{ id: 7, name: 'Sam Foreman', crew: 'A' }],
  assignments: [], reports: [], photos: [], workdays: [], timeCards: [], projectTasks: [], customers: [], catalog: [],
  users: [{ id: 1, name: 'Synthetic owner', role: 'owner', status: 'Active', companyId, email: 'owner@example.com' }],
  sessions: [{ companyId, userId: 1, tokenHash: crypto.createHash('sha256').update(ownerToken).digest('hex'), expiresAt: '2099-01-01' }],
};
const file = path.join(root, 'db.json');
fs.writeFileSync(file, JSON.stringify(db));
fs.writeFileSync(path.join(root, 'platform.json'), JSON.stringify({ users: [], sessions: [] }));
Object.assign(process.env, { PDL_DB_FILE: file, PDL_PLATFORM_FILE: path.join(root, 'platform.json'), PDL_REQUIRE_AUTH: '1', PDL_SUPABASE_ENABLED: '0', PDL_TRANSACTIONAL_DB: 'off', PDL_EMAIL_DEV_MODE: '1' });
for (const name of ['OPENAI_API_KEY', 'SENTRY_DSN', 'RESEND_API_KEY', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET']) delete process.env[name];
require('./database/supabase').loadLocalEnv = () => {};
const { server } = require('./server'), nativeFetch = global.fetch, engine = require('./project-schedule');
let base;
global.fetch = (url, options) => { assert.ok(String(url).startsWith(base + '/'), 'only synthetic localhost requests permitted'); return nativeFetch(url, options); };
async function call(method, route, body, auth = ownerToken) {
  const response = await fetch(base + route, { method, signal: AbortSignal.timeout(10000), headers: { 'Content-Type': 'application/json', 'x-pdl-company': companyId, Authorization: 'Bearer ' + auth }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, data: await response.json() };
}

(async () => {
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = 'http://127.0.0.1:' + server.address().port;

    // Engine: estimateItemId passes through create and preserves on edit.
    const created = engine.validate({ name: 'Set footings', durationDays: 3, estimateItemId: '11' }, null, new Set([7]));
    assert.equal(created.error, undefined);
    assert.equal(created.value.estimateItemId, 11, 'estimate link accepted at create');
    const edited = engine.validate({ name: 'Set footings', durationDays: 4 }, { id: 5, name: 'Set footings', durationDays: 3, estimateItemId: 11 }, new Set([7]));
    assert.equal(edited.value.estimateItemId, 11, 'estimate link preserved when not resent');
    assert.equal(engine.validate({ name: 'X', durationDays: 1, estimateItemId: 'junk' }, null, new Set()).value.estimateItemId, null, 'junk estimate link drops to null');

    // API: create a task linked to an estimate line.
    const made = await call('POST', '/api/projects/101/tasks', { name: 'Set footings', durationDays: 3, estimateItemId: 11 });
    assert.equal(made.status, 201);
    assert.equal(made.data.tasks[0].estimateItemId, 11, 'task stores the estimate link');
    const taskId = made.data.tasks[0].id;

    // API: bogus estimate links are rejected at create and edit.
    assert.equal((await call('POST', '/api/projects/101/tasks', { name: 'Bad link', durationDays: 1, estimateItemId: 999 })).status, 400, 'create rejects estimate lines from elsewhere');
    assert.equal((await call('PATCH', `/api/project-tasks/${taskId}`, { name: 'Set footings', durationDays: 3, estimateItemId: 999 })).status, 400, 'edit rejects estimate lines from elsewhere');

    // API: relink to the other estimate line works.
    const relinked = await call('PATCH', `/api/project-tasks/${taskId}`, { name: 'Set footings', durationDays: 3, estimateItemId: 12 });
    assert.equal(relinked.status, 200);
    assert.equal(relinked.data.tasks[0].estimateItemId, 12, 'task relinks to another estimate line');

    // --- Client contracts -----------------------------------------------------
    const app = fs.readFileSync('app.js', 'utf8'), ui = fs.readFileSync('project-schedule-ui.js', 'utf8'), index = fs.readFileSync('index.html', 'utf8');
    assert.ok(app.includes('data-project-detail-pane="tickets"'), 'tickets live in their own project-detail pane');
    assert.ok(app.includes("content.querySelector('[data-project-detail-pane=\"tickets\"]')"), 'tickets pane is inserted once (guarded)');
    assert.ok(!app.includes('class="project-ticket-section"'), 'tickets no longer render as a loose always-visible section');
    assert.ok(ui.includes('data-new-task-estimate'), 'add form can pick an estimate line');
    assert.ok(ui.includes('data-edit-task-estimate'), 'edit form can relink the estimate line');
    assert.ok(ui.includes('project-schedule-est-tag'), 'linked tasks show an estimate tag');
    assert.ok(ui.includes('estimateItemId'), 'client sends the estimate link');
    const styles = fs.readFileSync('styles.css', 'utf8');
    assert.ok(styles.includes('.project-schedule-est-tag'), 'estimate tag is styled');
    assert.match(index, /app\.js\?v=20261013-gantt/);
    assert.match(index, /styles\.css\?v=20261013-gantt/);

    console.log('Schedule tab cleanup passed: tickets get their own tab, tasks link to estimate lines (engine + API + client contracts).');
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    global.fetch = nativeFetch;
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; server.close(); });
