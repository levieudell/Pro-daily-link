'use strict';
// Change orders step 2 — "My flagged work" + status emails: field users can
// list only their own flags through GET /api/changes/mine (no amounts, no
// office data), and the office status change emails the flagging foreman in
// their own language. Office roles stay blocked from the field endpoints.
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-my-flags-')), companyId = '33223322-3322-4332-8332-332233223322', ownerToken = 'synthetic-flags-owner', samToken = 'synthetic-flags-sam', patToken = 'synthetic-flags-pat';
const db = {
  company: { id: companyId, name: 'Synthetic flags', demo: true, timezone: 'UTC' },
  projects: [{ id: 101, name: 'Synthetic Job', estimateItems: [] }],
  team: [{ id: 7, name: 'Sam Foreman', crew: 'A' }, { id: 9, name: 'Pat Laborer', crew: 'B' }],
  assignments: [{ id: 1, projectId: 101, date: '2026-10-11', crew: 'A', memberIds: [7] }, { id: 2, projectId: 101, date: '2026-10-11', crew: 'B', memberIds: [9] }],
  reports: [], photos: [], workdays: [], timeCards: [], changes: [
    { id: 1, projectId: 101, number: 'PC-001', title: 'Sam bedrock rip', status: 'Potential', amount: 0, fieldFlag: true, createdBy: 'Sam Foreman', createdAt: '2026-10-11T08:00:00.000Z', history: [] },
    { id: 2, projectId: 101, number: 'PC-002', title: 'Pat extra tie-in', status: 'Submitted', amount: 0, fieldFlag: true, createdBy: 'Pat Laborer', createdAt: '2026-10-11T08:05:00.000Z', history: [] },
    { id: 3, projectId: 101, number: 'PC-003', title: 'Office change', status: 'Pricing', amount: 1200, createdBy: 'Synthetic owner', createdAt: '2026-10-11T09:00:00.000Z', history: [] },
  ], customers: [], catalog: [],
  users: [
    { id: 1, name: 'Synthetic owner', role: 'owner', status: 'Active', companyId, email: 'owner@example.com' },
    { id: 2, name: 'Sam Foreman', memberId: 7, role: 'field', status: 'Active', companyId, email: 'sam@example.com', preferredLanguage: 'es' },
    { id: 3, name: 'Pat Laborer', memberId: 9, role: 'field', status: 'Active', companyId, email: 'pat@example.com', preferredLanguage: 'en' },
  ],
  sessions: [
    { companyId, userId: 1, tokenHash: crypto.createHash('sha256').update(ownerToken).digest('hex'), expiresAt: '2099-01-01' },
    { companyId, userId: 2, tokenHash: crypto.createHash('sha256').update(samToken).digest('hex'), expiresAt: '2099-01-01' },
    { companyId, userId: 3, tokenHash: crypto.createHash('sha256').update(patToken).digest('hex'), expiresAt: '2099-01-01' },
  ],
};
const file = path.join(root, 'db.json');
fs.writeFileSync(file, JSON.stringify(db));
fs.writeFileSync(path.join(root, 'platform.json'), JSON.stringify({ users: [], sessions: [] }));
Object.assign(process.env, { PDL_DB_FILE: file, PDL_PLATFORM_FILE: path.join(root, 'platform.json'), PDL_REQUIRE_AUTH: '1', PDL_SUPABASE_ENABLED: '0', PDL_TRANSACTIONAL_DB: 'off', PDL_EMAIL_DEV_MODE: '1' });
for (const name of ['OPENAI_API_KEY', 'SENTRY_DSN', 'RESEND_API_KEY', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET']) delete process.env[name];
require('./database/supabase').loadLocalEnv = () => {};
const { server } = require('./server'), nativeFetch = global.fetch;
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

    // My flags: only the caller's own field flags, stripped of money data.
    const mine = await call('GET', '/api/changes/mine', null, samToken);
    assert.equal(mine.status, 200);
    assert.equal(mine.data.length, 1, 'only own flags returned');
    assert.equal(mine.data[0].number, 'PC-001');
    assert.equal(mine.data[0].title, 'Sam bedrock rip');
    assert.equal(mine.data[0].status, 'Potential');
    assert.ok(!('amount' in mine.data[0]), 'amounts never leave the office');
    assert.ok(!('detail' in mine.data[0]) && !('photoIds' in mine.data[0]), 'mine is a lean list view');
    const pats = await call('GET', '/api/changes/mine', null, patToken);
    assert.equal(pats.data.length, 1);
    assert.equal(pats.data[0].number, 'PC-002');
    assert.equal(pats.data[0].status, 'Submitted');
    // Office roles cannot use the field endpoint.
    assert.equal((await call('GET', '/api/changes/mine')).status, 403, 'office cannot read the field list');

    // Status change: patch works with email config absent (no throw, no hang).
    const moved = await call('PATCH', '/api/changes/1', { status: 'Approved' });
    assert.equal(moved.status, 200);
    assert.equal(moved.data.status, 'Approved');
    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(after.changes.find(change => change.id === 1).status, 'Approved');
    assert.ok(after.changes.find(change => change.id === 1).history.some(row => /status Potential → Approved/.test(row.action)), 'status transition recorded in history');

    // --- Server email wiring contracts ---------------------------------------
    const serverSrc = fs.readFileSync('server.js', 'utf8');
    assert.ok(serverSrc.includes('async function sendChangeStatusEmail'), 'status email sender exists');
    assert.ok(serverSrc.includes("change.fieldFlag&&before.status!==change.status"), 'email fires only on real status transitions for field flags');
    assert.ok(serverSrc.includes('language:flagUser.preferredLanguage'), 'email follows the flagging user language');
    assert.ok(serverSrc.includes("change status email failed") || serverSrc.includes("'Change status email failed'"), 'send is fire-and-forget');
    assert.ok(serverSrc.includes("url.pathname!=='/api/changes/mine'"), 'the mine route bypasses the office gate');
    assert.ok(serverSrc.includes('Trabajo extra actualizado'), 'Spanish email subject exists');
    assert.ok(serverSrc.includes('Extra work update'), 'English email subject exists');

    // --- Client contracts -----------------------------------------------------
    const index = fs.readFileSync('index.html', 'utf8'), app = fs.readFileSync('app.js', 'utf8');
    assert.ok(index.includes('id="my-flags-panel"'), 'field home has the flagged-work panel');
    assert.ok(index.includes('id="my-flags"'), 'panel has a list container');
    assert.ok(app.includes("api('/api/changes/mine')"), 'client fetches the field list');
    assert.ok(app.includes('renderMyDayWithFlags'), 'renderMyDay wraps the flags refresh');
    assert.ok(app.includes('Trabajo extra reportado'), 'Spanish panel title');
    assert.ok(app.includes('Sent to customer'), 'English status label');
    assert.ok(app.includes('Enviado al cliente'), 'Spanish status label');
    assert.ok(app.includes('renderMyFlags()}catch(error){message.textContent'), 'flags refresh after a successful flag save');
    assert.match(index, /app\.js\?v=20261013-roles-uxa/);
    assert.match(index, /styles\.css\?v=20261013-roles-uxa/);
    const styles = fs.readFileSync('styles.css', 'utf8');
    assert.ok(styles.includes('.my-flag-row'), 'flag rows are styled');

    console.log('My flagged work API passed: own-flags scoping, money stripping, office gate, transition emails wiring, and client contracts.');
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    global.fetch = nativeFetch;
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; server.close(); });
