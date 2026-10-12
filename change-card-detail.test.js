'use strict';
// Change orders step 3 — line items + photos on office change cards (spec B).
// Office PATCH accepts lines[] and reason, auto-sums amount from line material
// costs (explicit amount overrides), promotes submittedAt/decidedAt/decidedBy
// on status transitions, and keeps money gated for non-pricing users.
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-change-detail-')), companyId = '44334433-4433-4443-9443-443344334433', ownerToken = 'synthetic-detail-owner', pmToken = 'synthetic-detail-pm', samToken = 'synthetic-detail-sam';
const db = {
  company: { id: companyId, name: 'Synthetic detail', demo: true, timezone: 'UTC', pricingAccess: { enabled: true, officeMode: 'selected', userIds: [1] } },
  projects: [{ id: 101, name: 'Synthetic Job', estimateItems: [] }],
  team: [{ id: 7, name: 'Sam Foreman', crew: 'A' }],
  assignments: [{ id: 1, projectId: 101, date: '2026-10-11', crew: 'A', memberIds: [7] }],
  reports: [{ id: 55, project: 0, foreman: 'Sam Foreman', status: 'Submitted', dateIso: '2026-10-11', flags: [], laborEntries: [], productionEntries: [] }],
  photos: [{ id: 501, project: 0, reportId: 55, changeId: 1, url: '/uploads/test/photo1.jpg', caption: 'Extra work PC-001', capturedAt: '2026-10-11T15:00:00.000Z', createdAt: '2026-10-11T15:00:00.000Z', source: 'field' }],
  workdays: [], timeCards: [], changes: [
    { id: 1, projectId: 101, number: 'PC-001', title: 'Sam bedrock rip', status: 'Potential', amount: 0, fieldFlag: true, createdBy: 'Sam Foreman', detail: 'Hit rock at footer excavation', hours: 12, quantity: 40, unit: 'cy', flagDate: '2026-10-11', createdAt: '2026-10-11T08:00:00.000Z', history: [] },
    { id: 3, projectId: 101, number: 'PC-003', title: 'Office change', status: 'Pricing', amount: 1200, createdBy: 'Synthetic owner', createdAt: '2026-10-11T09:00:00.000Z', history: [] },
  ], customers: [], catalog: [],
  users: [
    { id: 1, name: 'Synthetic owner', role: 'owner', status: 'Active', companyId, email: 'owner@example.com' },
    { id: 4, name: 'Synthetic PM', role: 'project_manager', status: 'Active', companyId, email: 'pm@example.com', projectIds: [101] },
    { id: 2, name: 'Sam Foreman', memberId: 7, role: 'field', status: 'Active', companyId, email: 'sam@example.com', preferredLanguage: 'es' },
  ],
  sessions: [
    { companyId, userId: 1, tokenHash: crypto.createHash('sha256').update(ownerToken).digest('hex'), expiresAt: '2099-01-01' },
    { companyId, userId: 4, tokenHash: crypto.createHash('sha256').update(pmToken).digest('hex'), expiresAt: '2099-01-01' },
    { companyId, userId: 2, tokenHash: crypto.createHash('sha256').update(samToken).digest('hex'), expiresAt: '2099-01-01' },
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

    // Lines auto-sum the amount when no explicit amount is sent.
    const lined = await call('PATCH', '/api/changes/3', { lines: [{ description: 'Rock removal', quantity: 10, unit: 'cy', laborHours: 6, materialCost: 1500 }, { description: 'Haul off', materialCost: 300 }] });
    assert.equal(lined.status, 200);
    assert.equal(lined.data.amount, 1800, 'amount auto-summed from line material costs');
    assert.equal(lined.data.lines.length, 2);
    assert.equal(lined.data.lines[0].laborHours, 6);
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    const storedThree = stored.changes.find(change => change.id === 3);
    assert.equal(storedThree.amount, 1800);
    assert.ok(storedThree.history.some(row => /line items/.test(row.action)), 'line edit recorded in history');

    // Explicit amount overrides the auto-sum in the same request.
    const overridden = await call('PATCH', '/api/changes/3', { lines: [{ description: 'Rock removal', materialCost: 1500 }], amount: 5000 });
    assert.equal(overridden.data.amount, 5000, 'explicit amount wins over the line sum');
    assert.equal(overridden.data.lines.length, 1);

    // Validation: lines must be a list; description-less rows are dropped; labor clamps to 24.
    assert.equal((await call('PATCH', '/api/changes/3', { lines: 'nope' })).status, 400, 'lines must be an array');
    const clamped = await call('PATCH', '/api/changes/3', { lines: [{ description: '', materialCost: 50 }, { description: 'Long shift', laborHours: 99, quantity: -5 }] });
    assert.equal(clamped.data.lines.length, 1, 'empty-description rows dropped');
    assert.equal(clamped.data.lines[0].laborHours, 24, 'labor hours clamped to 24');
    assert.equal(clamped.data.lines[0].quantity, 0, 'negative quantity clamped to 0');

    // Money gate: a project manager without pricing access cannot send material costs.
    assert.equal((await call('PATCH', '/api/changes/3', { lines: [{ description: 'Secret price', materialCost: 100 }] }, pmToken)).status, 403, 'non-pricing office role blocked from material costs');
    const pmFree = await call('PATCH', '/api/changes/3', { lines: [{ description: 'Crew hours only', laborHours: 8 }] }, pmToken);
    assert.equal(pmFree.status, 200, 'labor-only lines are allowed without pricing access');
    assert.equal(pmFree.data.lines[0].laborHours, 8);

    // Reason / basis text is stored and journaled.
    const reasoned = await call('PATCH', '/api/changes/1', { reason: 'Bedrock found 4 ft outside the excavation limits shown on sheet A-301.' });
    assert.equal(reasoned.status, 200);
    assert.equal(reasoned.data.reason, 'Bedrock found 4 ft outside the excavation limits shown on sheet A-301.');
    const storedOne = JSON.parse(fs.readFileSync(file, 'utf8')).changes.find(change => change.id === 1);
    assert.ok(storedOne.history.some(row => /reason/.test(row.action)), 'reason edit recorded in history');

    // Status transitions promote submittedAt / decidedAt / decidedBy.
    const submitted = await call('PATCH', '/api/changes/1', { status: 'Submitted' });
    assert.ok(submitted.data.submittedAt, 'submittedAt set on first Submitted');
    const decided = await call('PATCH', '/api/changes/1', { status: 'Approved' });
    assert.ok(decided.data.decidedAt && decided.data.decidedBy === 'Synthetic owner', 'decidedAt/decidedBy set on decision');
    const decidedStored = JSON.parse(fs.readFileSync(file, 'utf8')).changes.find(change => change.id === 1);
    assert.ok(decidedStored.history.some(row => /status Submitted → Approved/.test(row.action)), 'decision journaled');

    // Office GET returns the enriched record; field routes keep their gates.
    const list = await call('GET', '/api/changes?projectId=101');
    assert.equal(list.status, 200);
    const one = list.data.find(change => change.id === 1);
    assert.equal(one.reason, 'Bedrock found 4 ft outside the excavation limits shown on sheet A-301.');
    assert.equal(one.hours, 12, 'field context (hours) visible to office');
    assert.ok(one.submittedAt && one.decidedAt, 'timestamps exposed to the office list');
    assert.equal((await call('GET', '/api/changes?projectId=101', null, samToken)).status, 403, 'field still blocked from the office list');
    assert.equal((await call('PATCH', '/api/changes/1', { status: 'Void' }, samToken)).status, 403, 'field cannot edit changes');
    const mine = await call('GET', '/api/changes/mine', null, samToken);
    assert.ok(mine.data.every(flag => !('lines' in flag) && !('reason' in flag)), 'mine stays a lean list');

    // --- Server wiring contracts ----------------------------------------------
    const serverSrc = fs.readFileSync('server.js', 'utf8');
    assert.ok(serverSrc.includes("Object.hasOwn(input,'lines')"), 'PATCH accepts lines');
    assert.ok(serverSrc.includes('parsedLines'), 'lines are parsed and sanitized');
    assert.ok(serverSrc.includes("change.submittedAt=at"), 'Submitted promotes submittedAt');
    assert.ok(serverSrc.includes('change.decidedAt=at'), 'decision promotes decidedAt');
    assert.ok(serverSrc.includes("Object.hasOwn(input,'reason')"), 'PATCH accepts reason');

    // --- Client contracts -----------------------------------------------------
    const index = fs.readFileSync('index.html', 'utf8'), app = fs.readFileSync('app.js', 'utf8');
    assert.ok(app.includes('data-change-line-add'), 'card has an add-line control');
    assert.ok(app.includes('data-change-reason='), 'card has a reason field');
    assert.ok(app.includes('change-photo-strip'), 'card renders a photo strip');
    assert.ok(app.includes('data-open-daily'), 'photo strip links back to the daily');
    assert.ok(app.includes('autoSumChangeLines'), 'line material costs auto-sum the amount');
    assert.ok(app.includes('changeLineRow('), 'line rows render from a helper');
    assert.ok(app.includes('FROM THE FIELD'), 'field-flag context block renders');
    assert.ok(app.includes('data-change-line-row'), 'save gathers line rows');
    assert.match(index, /app\.js\?v=20261011-step2-ai/);
    assert.match(index, /styles\.css\?v=20261011-step2-ai/);
    const styles = fs.readFileSync('styles.css', 'utf8');
    assert.ok(styles.includes('.change-line-row'), 'line rows are styled');
    assert.ok(styles.includes('.change-photo-strip'), 'photo strip is styled');
    assert.ok(styles.includes('.change-flag-note'), 'field note is styled');

    console.log('Change card detail API passed: lines auto-sum/override, validation, pricing gate, reason, transition timestamps, and client contracts.');
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    global.fetch = nativeFetch;
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; server.close(); });
