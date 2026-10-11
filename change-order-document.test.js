'use strict';
// Change orders step 4 — CO document + customer approve-by-link (spec C).
// The office submits a change through POST /api/changes/:id/submit (status →
// Submitted, foreman emailed, signed customer link issued); the customer opens
// /change-order.html?c=…&t=… with no login, reviews the document, and signs
// approve/decline. Only the token hash is stored; decisions are idempotent.
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-co-doc-')), companyId = '66556655-6655-4665-b665-665566556655', ownerToken = 'synthetic-codoc-owner', samToken = 'synthetic-codoc-sam';
const db = {
  company: { id: companyId, name: 'Synthetic Builders', demo: true, timezone: 'UTC' },
  projects: [{ id: 101, name: 'Synthetic Job', customer: 'Nicholl Hill', site: '42 Birch Rd', estimateItems: [] }],
  team: [{ id: 7, name: 'Sam Foreman', crew: 'A' }],
  assignments: [{ id: 1, projectId: 101, date: '2026-10-11', crew: 'A', memberIds: [7] }],
  reports: [], photos: [{ id: 501, project: 0, reportId: 55, changeId: 1, url: '/uploads/t/p1.jpg', caption: 'Bedrock at footer', capturedAt: '2026-10-11T15:00:00.000Z', createdAt: '2026-10-11T15:00:00.000Z', source: 'field' }],
  workdays: [], timeCards: [], changes: [
    { id: 1, projectId: 101, number: 'PC-001', title: 'Bedrock rip', status: 'Pricing', amount: 1800, fieldFlag: true, createdBy: 'Sam Foreman', reason: 'Rock outside excavation limits', lines: [{ description: 'Rock removal', quantity: 10, unit: 'cy', laborHours: 6, materialCost: 1500 }, { description: 'Haul off', materialCost: 300 }], createdAt: '2026-10-11T08:00:00.000Z', history: [] },
    { id: 2, projectId: 101, number: 'PC-002', title: 'Approved already', status: 'Approved', amount: 500, createdBy: 'Synthetic owner', createdAt: '2026-10-11T09:00:00.000Z', history: [] },
  ], customers: [], catalog: [],
  users: [
    { id: 1, name: 'Synthetic owner', role: 'owner', status: 'Active', companyId, email: 'owner@example.com' },
    { id: 2, name: 'Sam Foreman', memberId: 7, role: 'field', status: 'Active', companyId, email: 'sam@example.com', preferredLanguage: 'en' },
  ],
  sessions: [
    { companyId, userId: 1, tokenHash: crypto.createHash('sha256').update(ownerToken).digest('hex'), expiresAt: '2099-01-01' },
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
async function callPublic(method, route, body) {
  const response = await fetch(base + route, { method, signal: AbortSignal.timeout(10000), headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, data: await response.json() };
}

(async () => {
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = 'http://127.0.0.1:' + server.address().port;

    // Submit: office-only, moves Pricing → Submitted, issues a signed link.
    assert.equal((await call('POST', '/api/changes/1/submit', null, samToken)).status, 403, 'field roles cannot submit');
    assert.equal((await call('POST', '/api/changes/2/submit')).status, 409, 'decided changes cannot be re-submitted');
    const submitted = await call('POST', '/api/changes/1/submit');
    assert.equal(submitted.status, 200);
    assert.equal(submitted.data.status, 'Submitted');
    assert.ok(/^\/change-order\.html\?c=1&t=[A-Za-z0-9_-]+$/.test(submitted.data.url), 'signed customer link issued');
    const rawToken = submitted.data.url.split('t=')[1];
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    const storedOne = stored.changes.find(change => change.id === 1);
    assert.equal(storedOne.customerTokenHash, crypto.createHash('sha256').update(rawToken).digest('hex'), 'only the hash is stored');
    assert.ok(!JSON.stringify(stored).includes(rawToken), 'the raw token never touches the database');
    assert.ok(storedOne.submittedAt && storedOne.history.some(row => /status Pricing → Submitted/.test(row.action)), 'submission journaled');

    // Customer document: no login required, wrong token → 404.
    const page = await callPublic('GET', '/api/change-order/' + rawToken);
    assert.equal(page.status, 200, 'customer reads the document without an account');
    assert.equal(page.data.number, 'PC-001');
    assert.equal(page.data.amount, 1800);
    assert.equal(page.data.lines.length, 2);
    assert.equal(page.data.photos.length, 1, 'field photos travel with the document');
    assert.equal(page.data.company.name, 'Synthetic Builders');
    assert.equal(page.data.project.customer, 'Nicholl Hill');
    assert.equal((await callPublic('GET', '/api/change-order/bogustoken123')).status, 404, 'wrong token is a 404');
    const html = await (await nativeFetch(base + '/change-order.html')).text();
    assert.ok(html.includes('change-order.js') && html.includes('co-document'), 'the document page is publicly served');

    // Decision: approve with a signature and note; foreman email is fire-and-forget.
    const missing = await callPublic('POST', `/api/change-order/${rawToken}/decision`, { decision: 'approved', name: '  ' });
    assert.equal(missing.status, 400, 'a signature name is required');
    const approved = await callPublic('POST', `/api/change-order/${rawToken}/decision`, { decision: 'approved', name: 'Nicholl Hill', note: 'Proceed, please keep the sidewalk clean' });
    assert.equal(approved.status, 200);
    assert.equal(approved.data.status, 'Approved');
    const after = JSON.parse(fs.readFileSync(file, 'utf8')).changes.find(change => change.id === 1);
    assert.equal(after.decidedBy, 'Nicholl Hill');
    assert.equal(after.decidedAt, approved.data.decidedAt);
    assert.equal(after.decisionNote, 'Proceed, please keep the sidewalk clean');
    assert.ok(after.history.some(row => /Approved by customer signature \(Nicholl Hill\)/.test(row.action)), 'customer signature journaled');
    assert.ok(after.history.some(row => row.by === 'Nicholl Hill'), 'history credits the customer');
    const audit = JSON.parse(fs.readFileSync(file, 'utf8')).auditLog.find(row => row.type === 'project_change_decided');
    assert.ok(audit && /approved via change order link/.test(audit.detail), 'decision audited');

    // Idempotent: a second decision returns the current state, no flip.
    const again = await callPublic('POST', `/api/change-order/${rawToken}/decision`, { decision: 'declined', name: 'Nicholl Hill' });
    assert.equal(again.status, 200);
    assert.equal(again.data.already, true);
    assert.equal(again.data.status, 'Approved', 'decision cannot be flipped through the link');

    // --- Client / policy contracts --------------------------------------------
    const serverSrc = fs.readFileSync('server.js', 'utf8'), app = fs.readFileSync('app.js', 'utf8');
    assert.ok(serverSrc.includes('changeOrderRequestDatabase'), 'token-resolved tenant lookup exists');
    assert.ok(serverSrc.includes("url.pathname.startsWith('/api/change-order/')") || serverSrc.includes('change-order/'), 'change-order routes bypass the auth gate');
    assert.ok(serverSrc.includes('customerTokenHash=crypto.createHash'), 'tokens are stored as hashes');
    const index = fs.readFileSync('index.html', 'utf8'), guest = fs.readFileSync('guest.html', 'utf8');
    assert.ok(!index.includes('change-order.html'), 'the workspace never loads the CO route');
    assert.ok(!guest.includes('change-order.html'), 'guest pages never load the CO route');
    assert.ok(app.includes('data-generate-co'), 'office cards expose Generate change order');
    assert.ok(app.includes("api(`/api/changes/${button.dataset.generateCo}/submit`"), 'the button calls the submit endpoint');
    const policy = require('./public-file-policy');
    assert.ok(policy.PUBLIC_FILES.has('change-order.html') && policy.PUBLIC_FILES.has('change-order.js'), 'the document page is a served public file');

    console.log('Change order document passed: submit + signed link, hash-only storage, public read, signature decision, idempotency, and static contracts.');
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    global.fetch = nativeFetch;
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; server.close(); });
