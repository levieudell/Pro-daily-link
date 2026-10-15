'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { allow } = require('./mcp/rate-limit');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-mcp-'));
const demoId = '7176abe8-07e4-4336-a372-1163d2f21ff9';
const otherId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const file = path.join(root, 'db.json');
const password = 'field-secret';

function credential(value) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { passwordSalt: salt, passwordHash: crypto.scryptSync(value, salt, 64).toString('hex') };
}
function isoDate() {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const value = type => parts.find(part => part.type === type).value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}
function user(id, name, email, role, memberId) {
  return { id, companyId: demoId, name, email, role, memberId, status: 'Active', mustSetPassword: false, ...credential(password) };
}

const today = isoDate();
const demo = {
  company: { id: demoId, name: 'Demo Concrete', demo: true, timezone: 'UTC', features: { timeCards: true }, subscriptionStatus: 'Active' },
  customers: [], projects: [
    { id: 11, name: 'Jordan Footings', customer: 'City', status: 'Active', estimateItems: [{ id: 1, name: 'Footings', plannedQuantity: 100, unit: 'CY', budgetHours: 40 }] },
    { id: 22, name: 'Alex Framing', customer: 'City', status: 'Active', estimateItems: [{ id: 2, name: 'Walls', plannedQuantity: 20, unit: 'LF', budgetHours: 10 }] }
  ],
  team: [
    { id: 1, name: 'DEMO Jordan Reed', role: 'Finisher', crew: 'Concrete' },
    { id: 2, name: 'DEMO Alex Stone', role: 'Carpenter', crew: 'Framing' },
    { id: 3, name: 'DEMO Office Pat', role: 'Superintendent', crew: 'Office' }
  ],
  users: [
    user(1, 'DEMO Jordan Reed', 'jordan@demo.test', 'field', 1),
    user(2, 'DEMO Alex Stone', 'alex@demo.test', 'field', 2),
    user(3, 'DEMO Office Pat', 'pat@demo.test', 'admin', 3),
    user(4, 'DEMO Pat Manager', 'pm@demo.test', 'project_manager', null)
  ],
  assignments: [
    { id: 1, date: today, projectId: 11, memberIds: [1], activity: 'Pour footings' },
    { id: 2, date: today, projectId: 22, memberIds: [2], activity: 'Frame walls' }
  ],
  reports: [{ id: 1, project: 0, dateIso: '2020-01-02', date: 'Jan 2', status: 'Approved', foreman: 'DEMO Office Pat', notes: 'Earlier pour', productionEntries: [{ estimateItemId: 1, description: 'Footings', quantity: 10, unit: 'CY', laborHours: 4 }], laborEntries: [{ memberId: 3, hours: 4, crew: 'Office' }] }],
  workdays: [], timeCards: [], photos: [], sessions: [], auditLog: [], changes: [], catalog: [], subcontractors: []
};
const other = {
  company: { id: otherId, name: 'Other Builder', demo: true, timezone: 'UTC', features: { timeCards: true } },
  customers: [], projects: [{ id: 77, name: 'Secret Bridge', customer: 'Hidden', status: 'Active', estimateItems: [{ id: 1, name: 'Deck', plannedQuantity: 5, unit: 'CY', budgetHours: 8 }] }],
  team: [{ id: 1, name: 'Other Sam', role: 'PM', crew: 'Office' }],
  users: [{ id: 1, companyId: otherId, name: 'Other Sam', email: 'sam@other.test', role: 'owner', memberId: 1, status: 'Active', mustSetPassword: false, ...credential(password) }],
  assignments: [], reports: [], workdays: [], timeCards: [], photos: [], sessions: [], auditLog: [], changes: []
};
fs.mkdirSync(path.join(root, 'tenants'), { recursive: true });
fs.writeFileSync(file, JSON.stringify(demo));
fs.writeFileSync(path.join(root, 'tenants', `${otherId}.json`), JSON.stringify(other));
fs.writeFileSync(path.join(root, 'platform.json'), JSON.stringify({ users: [], sessions: [], helpItems: [] }));
Object.assign(process.env, { PDL_DB_FILE: file, PDL_PLATFORM_FILE: path.join(root, 'platform.json'), PDL_REQUIRE_AUTH: '1', PDL_SUPABASE_ENABLED: '0', PDL_TRANSACTIONAL_DB: 'off', PDL_EMAIL_DEV_MODE: '1' });
delete process.env.PDL_PUBLIC_URL;
for (const name of ['OPENAI_API_KEY', 'SENTRY_DSN', 'RESEND_API_KEY', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET']) delete process.env[name];
require('./database/supabase').loadLocalEnv = () => {};
const { server } = require('./server');

const first = allow('mcp-unit-test', 2, 1000);
const second = allow('mcp-unit-test', 2, 1000);
const third = allow('mcp-unit-test', 2, 1500);
assert.equal(first.ok, true);
assert.equal(second.ok, true);
assert.equal(third.ok, false);

async function connect(email) {
  const registered = await fetch(`${base}/oauth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: 'Test assistant', redirect_uris: ['http://127.0.0.1/callback'], token_endpoint_auth_method: 'none' }) });
  const client = await registered.json();
  assert.equal(registered.status, 201);
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const query = { response_type: 'code', client_id: client.client_id, redirect_uri: 'http://127.0.0.1/callback', code_challenge: challenge, code_challenge_method: 'S256', state: 'state-1', resource: `${base}/mcp`, scope: 'daily:read daily:write' };
  const login = await fetch(`${base}/oauth/authorize`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ...query, email, password }) });
  const html = await login.text();
  return { login, html, client, verifier, query };
}
async function tokenFor(email) {
  const { login, html, client, verifier } = await connect(email);
  assert.equal(login.status, 200, html);
  const ticket = /pdl_mcp_login=([^;]+)/.exec(login.headers.get('set-cookie') || '')?.[1];
  assert.ok(ticket, 'consent ticket cookie');
  const consent = await fetch(`${base}/oauth/authorize`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: `pdl_mcp_login=${ticket}` }, body: new URLSearchParams({ ticket, companyId: email.endsWith('@other.test') ? otherId : demoId, decision: 'allow' }) });
  const location = consent.headers.get('location');
  assert.equal(consent.status, 302, await consent.text());
  const code = new URL(location).searchParams.get('code');
  const traded = await fetch(`${base}/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: 'http://127.0.0.1/callback', client_id: client.client_id, code_verifier: verifier, resource: `${base}/mcp` }) });
  const token = await traded.json();
  assert.equal(traded.status, 200, JSON.stringify(token));
  assert.match(token.access_token, /^pdlm_/);
  return token.access_token;
}
async function mcp(token, method, params) {
  const response = await fetch(`${base}/mcp`, { method: 'POST', headers: { Authorization: token ? `Bearer ${token}` : '', 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const data = await response.json();
  return { status: response.status, data, headers: response.headers };
}
function toolBody(data) {
  assert.equal(data.error, undefined, JSON.stringify(data.error || data));
  const text = data.result?.content?.[0]?.text || '';
  let parsed;
  try { parsed = JSON.parse(text); } catch { assert.fail(text || JSON.stringify(data.result)); }
  return { isError: data.result.isError === true, parsed };
}

let base;
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  try {
    const metadata = await fetch(`${base}/.well-known/oauth-authorization-server`);
    const discovery = await metadata.json();
    assert.equal(discovery.issuer, base);
    assert.equal(discovery.code_challenge_methods_supported[0], 'S256');
    const resource = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json();
    assert.equal(resource.resource, `${base}/mcp`);

    const anonymous = await mcp('', 'tools/list', {});
    assert.equal(anonymous.status, 401);
    assert.match(anonymous.headers.get('www-authenticate'), /resource_metadata="http:\/\/127\.0\.0\.1:\d+\/\.well-known\/oauth-protected-resource\/mcp"/);

    const refused = await connect('pm@demo.test');
    assert.equal(refused.login.status, 403);
    assert.match(refused.html, /cannot connect/i);
    assert.doesNotMatch(refused.html, /name="ticket"/);

    const jordan = await tokenFor('jordan@demo.test');
    const office = await tokenFor('pat@demo.test');
    const outsider = await tokenFor('sam@other.test');
    const fieldNames = (await mcp(jordan, 'tools/list', {})).data.result.tools.map(tool => tool.name);
    assert.ok(fieldNames.includes('clock_in') && fieldNames.includes('log_work') && fieldNames.includes('submit_daily'));
    assert.ok(!fieldNames.includes('create_daily'));
    const officeNames = (await mcp(office, 'tools/list', {})).data.result.tools.map(tool => tool.name);
    assert.ok(officeNames.includes('create_daily') && officeNames.includes('update_daily'));
    assert.ok(!officeNames.includes('clock_in'));

    const mine = toolBody((await mcp(jordan, 'tools/call', { name: 'get_my_day', arguments: {} })).data);
    assert.equal(mine.isError, false);
    assert.deepEqual(mine.parsed.assignments.map(row => row.projectName), ['Jordan Footings']);
    assert.equal(mine.parsed.crew, 'Concrete');
    assert.equal(JSON.stringify(mine.parsed).includes('Alex Framing'), false);
    assert.equal(mine.parsed.jobs[0].lines[0].remaining, 90);
    const hidden = toolBody((await mcp(jordan, 'tools/call', { name: 'get_estimate', arguments: { projectId: 22 } })).data);
    assert.equal(hidden.isError, true);
    const ownProjects = toolBody((await mcp(jordan, 'tools/call', { name: 'list_projects', arguments: {} })).data).parsed.projects;
    assert.deepEqual(ownProjects.map(project => project.name), ['Jordan Footings']);
    const officeProjects = toolBody((await mcp(office, 'tools/call', { name: 'list_projects', arguments: {} })).data).parsed.projects.map(project => project.name);
    assert.deepEqual(officeProjects.sort(), ['Alex Framing', 'Jordan Footings']);
    const otherProjects = toolBody((await mcp(outsider, 'tools/call', { name: 'list_projects', arguments: {} })).data).parsed.projects.map(project => project.name);
    assert.deepEqual(otherProjects, ['Secret Bridge']);
    const isolated = toolBody((await mcp(office, 'tools/call', { name: 'get_estimate', arguments: { projectId: 77 } })).data);
    assert.equal(isolated.isError, true);
    assert.equal(isolated.parsed.error, 'Project not found.');

    const wrongJob = toolBody((await mcp(jordan, 'tools/call', { name: 'clock_in', arguments: { idempotencyKey: 'clock-wrong-job', projectId: 22 } })).data);
    assert.equal(wrongJob.isError, true);
    const clocked = toolBody((await mcp(jordan, 'tools/call', { name: 'clock_in', arguments: { idempotencyKey: 'clock-in-jordan' } })).data);
    assert.equal(clocked.isError, false, JSON.stringify(clocked.parsed));
    assert.equal(clocked.parsed.projectName, 'Jordan Footings');
    assert.equal(clocked.parsed.status, 'active');
    const poured = toolBody((await mcp(jordan, 'tools/call', { name: 'log_work', arguments: { idempotencyKey: 'pour-40-yards', text: 'I poured 40 yards today. 8 hours.' } })).data);
    assert.equal(poured.isError, false, JSON.stringify(poured.parsed));
    assert.equal(poured.parsed.recorded[0].name, 'Footings');
    assert.equal(poured.parsed.recorded[0].quantityAdded, 40);
    assert.equal(poured.parsed.recorded[0].quantityTotal, 40);
    assert.equal(poured.parsed.labor[0].hoursAdded, 8);
    assert.equal(poured.parsed.status, 'Draft');
    const replay = toolBody((await mcp(jordan, 'tools/call', { name: 'log_work', arguments: { idempotencyKey: 'pour-40-yards', text: 'I poured 40 yards today. 8 hours.' } })).data);
    assert.equal(replay.isError, false, JSON.stringify(replay.parsed));
    assert.equal(replay.parsed.recorded[0].quantityTotal, 40);
    const mystery = toolBody((await mcp(jordan, 'tools/call', { name: 'log_work', arguments: { idempotencyKey: 'mystery-widgets', text: 'installed 3 mystery widgets' } })).data);
    assert.equal(mystery.isError, false, JSON.stringify(mystery.parsed));
    assert.equal(mystery.parsed.recorded.length, 0);
    assert.match(mystery.parsed.notes, /mystery widgets/);
    assert.equal(mystery.parsed.quantities.length, 1);
    assert.equal(mystery.parsed.quantities[0].quantity, 40);
    const ended = toolBody((await mcp(jordan, 'tools/call', { name: 'clock_out', arguments: { idempotencyKey: 'clock-out-jordan' } })).data);
    assert.equal(ended.isError, false, JSON.stringify(ended.parsed));
    assert.ok(ended.parsed.timeCard?.outAt);
    const submitted = toolBody((await mcp(jordan, 'tools/call', { name: 'submit_daily', arguments: { idempotencyKey: 'submit-jordan', confirm: true } })).data);
    assert.equal(submitted.isError, false, JSON.stringify(submitted.parsed));
    assert.equal(submitted.parsed.status, 'Needs review');
    assert.notEqual(submitted.parsed.status, 'Approved');
    const after = toolBody((await mcp(jordan, 'tools/call', { name: 'get_my_day', arguments: {} })).data).parsed;
    assert.equal(after.jobs[0].lines[0].remaining, 90);
    assert.equal(after.jobs[0].lines[0].todayQuantity, 40);

    const created = toolBody((await mcp(office, 'tools/call', { name: 'create_daily', arguments: { idempotencyKey: 'office-create-1', projectId: 11, date: '2020-02-02', notes: 'Office draft', status: 'Approved', quantities: [{ estimateItemId: 1, quantity: 2 }], crewHours: [{ memberId: 3, hours: 2 }] } })).data);
    assert.equal(created.isError, false, JSON.stringify(created.parsed));
    assert.equal(created.parsed.status, 'Draft');
    const updated = toolBody((await mcp(office, 'tools/call', { name: 'update_daily', arguments: { idempotencyKey: 'office-update-1', id: created.parsed.id, notes: 'Office draft revised' } })).data);
    assert.equal(updated.isError, false, JSON.stringify(updated.parsed));
    assert.equal(updated.parsed.notes, 'Office draft revised');
    assert.equal(updated.parsed.status, 'Draft');
    const locked = toolBody((await mcp(office, 'tools/call', { name: 'update_daily', arguments: { idempotencyKey: 'office-lock-1', id: 1, notes: 'Should not change' } })).data);
    assert.equal(locked.isError, true);
    assert.match(locked.parsed.error, /locked/i);

    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    const jordanDaily = stored.reports.find(report => report.foreman === 'DEMO Jordan Reed' && report.dateIso === today);
    assert.equal(jordanDaily.status, 'Needs review');
    assert.equal(jordanDaily.productionEntries[0].quantity, 40);
    assert.equal(stored.timeCards.find(card => card.memberId === 1).outAt != null, true);
    assert.ok(stored.auditLog.some(row => String(row.detail).includes('via AI connector')));
    assert.equal(stored.reports.find(report => report.id === 1).notes, 'Earlier pour');
    console.log('MCP connector tests passed');
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; server.close(); });
