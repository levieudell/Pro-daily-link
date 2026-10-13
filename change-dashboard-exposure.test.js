'use strict';
// Change orders step 5 — dashboard exposure (spec D): per-project change
// summaries ride along with /api/state so project cards can show "awaiting
// decision" badges and open exposure, and the project header can show the
// revised contract (contract value + approved changes). Raw change rows no
// longer ship with office state; amounts are null without pricing access.
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-co-dash-')), companyId = '77667766-7766-4776-c776-776677667766', ownerToken = 'synthetic-codash-owner', pmToken = 'synthetic-codash-pm';
const db = {
  company: { id: companyId, name: 'Synthetic Builders', demo: true, timezone: 'UTC', pricingAccess: { enabled: true, officeMode: 'selected', userIds: [1] } },
  projects: [
    { id: 101, name: 'Synthetic Job', customer: 'Nicholl Hill', site: '42 Birch Rd', contractValue: 250000, budget: '$250,000', estimateItems: [] },
    { id: 102, name: 'Second Job', customer: 'Avery Lee', site: '7 Pine St', estimateItems: [] },
  ],
  team: [{ id: 7, name: 'Sam Foreman', crew: 'A' }],
  assignments: [], reports: [], photos: [], workdays: [], timeCards: [], changes: [
    { id: 1, projectId: 101, number: 'PC-001', title: 'Bedrock rip', status: 'Submitted', amount: 1800, createdBy: 'Synthetic owner', createdAt: '2026-10-11T08:00:00.000Z', history: [] },
    { id: 2, projectId: 101, number: 'PC-002', title: 'Window swap', status: 'Approved', amount: 3200, createdBy: 'Synthetic owner', createdAt: '2026-10-11T09:00:00.000Z', history: [] },
    { id: 3, projectId: 101, number: 'PC-003', title: 'Void item', status: 'Void', amount: 0, createdBy: 'Synthetic owner', createdAt: '2026-10-11T09:30:00.000Z', history: [] },
    { id: 4, projectId: 102, number: 'PC-001', title: 'Open potential', status: 'Potential', amount: 500, createdBy: 'Synthetic owner', createdAt: '2026-10-11T10:00:00.000Z', history: [] },
  ], customers: [], catalog: [],
  users: [
    { id: 1, name: 'Synthetic owner', role: 'owner', status: 'Active', companyId, email: 'owner@example.com' },
    { id: 4, name: 'Synthetic PM', role: 'project_manager', status: 'Active', companyId, email: 'pm@example.com', projectIds: [101, 102] },
  ],
  sessions: [
    { companyId, userId: 1, tokenHash: crypto.createHash('sha256').update(ownerToken).digest('hex'), expiresAt: '2099-01-01' },
    { companyId, userId: 4, tokenHash: crypto.createHash('sha256').update(pmToken).digest('hex'), expiresAt: '2099-01-01' },
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

    // Owner state: per-project summary with counts and money.
    const state = await call('GET', '/api/state');
    assert.equal(state.status, 200);
    assert.ok(!('changes' in state.data), 'raw change rows no longer ship with state');
    assert.ok(!JSON.stringify(state.data).includes('customerTokenHash'), 'token hashes never ride along with state');
    const job = state.data.projectChanges.find(row => row.projectId === 101);
    assert.equal(job.awaitingDecision, 1, 'one change awaiting customer decision');
    assert.equal(job.openItems, 1, 'Submitted is open; Approved and Void are not');
    assert.equal(job.approvedCount, 1);
    assert.equal(job.openExposure, 1800, 'open exposure = the Submitted change');
    assert.equal(job.approvedTotal, 3200, 'approved total feeds the revised contract');
    const second = state.data.projectChanges.find(row => row.projectId === 102);
    assert.equal(second.openItems, 1);
    assert.equal(second.openExposure, 500);
    assert.equal(second.awaitingDecision, 0);

    // Non-pricing office role: counts stay, money is null.
    const pmState = await call('GET', '/api/state', null, pmToken);
    assert.equal(pmState.status, 200);
    const pmJob = pmState.data.projectChanges.find(row => row.projectId === 101);
    assert.equal(pmJob.awaitingDecision, 1, 'counts visible without pricing access');
    assert.equal(pmJob.openExposure, null, 'money hidden without pricing access');
    assert.equal(pmJob.approvedTotal, null);

    // --- Client contracts -----------------------------------------------------
    const app = fs.readFileSync('app.js', 'utf8'), index = fs.readFileSync('index.html', 'utf8');
    assert.ok(app.includes('let projectChanges=[]'), 'client keeps a change-summary global');
    assert.ok(app.includes('state.projectChanges'), 'state hydration captures the summary');
    assert.ok(app.includes('awaiting decision'), 'project cards badge changes awaiting decision');
    assert.ok(app.includes('project-co-exposure'), 'project cards can show open exposure');
    assert.ok(app.includes('REVISED CONTRACT'), 'project header shows the revised contract');
    assert.ok(app.includes('coSummary.approvedTotal'), 'revised contract = contract value + approved changes');
    const styles = fs.readFileSync('styles.css', 'utf8');
    assert.ok(styles.includes('.project-co-badge'), 'badges are styled');
    assert.match(index, /app\.js\?v=20261013-uxa/);
    assert.match(index, /styles\.css\?v=20261013-uxa/);

    console.log('Change dashboard exposure passed: per-project summaries, pricing-gated amounts, raw-row removal, revised contract, and client contracts.');
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    global.fetch = nativeFetch;
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; server.close(); });
