'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto'), http = require('node:http');
const { spawn } = require('node:child_process');
const policy = require('./notes-role-permissions');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-role-notes-')), companyId = '11111111-1111-4111-8111-111111111111', dbFile = path.join(temp, 'db.json');
const hash = value => crypto.createHash('sha256').update(value).digest('hex'), token = id => 'synthetic-role-notes-' + id;
const db = JSON.parse(fs.readFileSync(path.join(__dirname, 'data/db.json')));
db.company = { id: companyId, name: 'Synthetic role notes', demo: true, timezone: 'UTC', features: {} };
db.projects = [101, 102].map(id => ({ id, name: 'Synthetic project ' + id, status: 'Active', estimateItems: [] }));
db.team = [{ id: 11, name: 'Synthetic member', crew: 'A' }, { id: 12, name: 'Other member', crew: 'B' }];
db.assignments = [{ id: 1, projectId: 101, memberIds: [11], date: '2026-10-07' }];
db.users = [{ id: 1, role: 'owner' }, { id: 2, role: 'admin' }, { id: 3, role: 'project_manager', projectIds: [101], assignedCrews: ['A'] }, { id: 4, role: 'foreman', memberId: 11 }, { id: 5, role: 'field', memberId: 11 }].map(user => ({ status: 'Active', companyId, name: 'Synthetic user ' + user.id, email: 'qa' + user.id + '@example.invalid', emailVerifiedAt: '2026-10-07T00:00:00Z', ...user }));
db.sessions = db.users.map(user => ({ userId: user.id, companyId, tokenHash: hash(token(user.id)), expiresAt: '2099-01-01T00:00:00Z' }));
for (const collection of ['reports', 'workdays', 'photos', 'auditLog', 'projectNotesTodos', 'changes', 'subcontractorLinks', 'timeCards']) db[collection] = [];
fs.writeFileSync(dbFile, JSON.stringify(db)); fs.writeFileSync(path.join(temp, 'platform.json'), JSON.stringify({ users: [], sessions: [], notes: [] }));
const processes = [];
async function start(mode = 'shared-file') {
  const env = { ...process.env, PDL_DB_FILE: dbFile, PDL_PLATFORM_FILE: path.join(temp, 'platform.json'), PDL_SUPABASE_ENABLED: '0', PDL_TRANSACTIONAL_DB: 'off', PDL_REQUIRE_AUTH: '1', PDL_EMAIL_DEV_MODE: '1', PDL_ROLE_PERMISSIONS_STORAGE: mode };
  for (const key of ['SENTRY_DSN', 'RESEND_API_KEY', 'OPENAI_API_KEY', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET']) delete env[key];
  const child = spawn(process.execPath, ['-e', "const{server}=require('./server');server.listen(0,'127.0.0.1',()=>console.log('PORT='+server.address().port))"], { cwd: __dirname, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }); processes.push(child);
  return new Promise((resolve, reject) => { let output = ''; const timer = setTimeout(() => reject(new Error('Local child server timeout: ' + output)), 20000); child.stdout.on('data', bytes => { output += bytes; const match = output.match(/PORT=(\d+)/); if (match) { clearTimeout(timer); resolve('http://127.0.0.1:' + match[1]); } }); child.stderr.on('data', bytes => { output += bytes; }); child.once('error', err => { clearTimeout(timer); reject(err); }); child.once('exit', code => { clearTimeout(timer); reject(new Error('Child exited ' + code + ': ' + output)); }); });
}
const headers = id => ({ Authorization: 'Bearer ' + token(id), 'X-PDL-Company': companyId, 'Content-Type': 'application/json' });
async function request(base, route, method = 'GET', input, id = 1, extra = {}) { const response = await fetch(base + route, { method, headers: { ...headers(id), ...extra }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) }); return { status: response.status, data: await response.json() }; }
const route = '/api/company/notes-role-permissions', notes = '/api/projects/101/notes-todos';
async function change(a, b, next, revision) {
  next.revision = revision + 1;
  const preview = await request(a, route + '/preview', 'POST', { revision, policy: next, reason: 'Synthetic role review' }); assert.equal(preview.status, 200, JSON.stringify(preview));
  const saved = await request(b, route, 'PUT', { ...preview.data, users: undefined, confirm: true }); assert.equal(saved.status, 200, JSON.stringify(saved)); return preview.data;
}
function slow(base, payload) {
  const raw = JSON.stringify(payload); let req;
  const result = new Promise((resolve, reject) => { req = http.request(base + notes, { method: 'POST', headers: { ...headers(3), 'Content-Length': Buffer.byteLength(raw) } }, res => { let text = ''; res.on('data', bytes => text += bytes); res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(text) })); }); req.on('error', reject); req.write(raw.slice(0, 1)); });
  return { result, finish() { req.end(raw.slice(1)); } };
}
(async () => {
  try {
    const [a, b] = await Promise.all([start(), start()]);
    for (const id of [1, 2, 3, 4, 5]) assert.equal((await request(a, notes, 'GET', undefined, id)).status, 200);
    const originalUsers = JSON.parse(fs.readFileSync(dbFile)).users;
    const created = await request(b, notes, 'POST', { kind: 'todo', text: 'Synthetic task', requestId: 'synthetic-task-1' }, 3); assert.equal(created.status, 201); const item = created.data;
    let next = policy.defaults(); next.roles.project_manager.create = false; next.roles.admin.edit = false; next.roles.field.complete = false; next.roles.foreman = { view: false, create: false, edit: false, complete: false };
    const upload = slow(b, { kind: 'note', text: 'Must be revoked', requestId: 'synthetic-slow-1' });
    await change(a, b, next, 0); upload.finish(); assert.equal((await upload.result).status, 403, 'cross-process in-flight upload revoked');
    assert.equal((await request(a, notes, 'POST', { kind: 'todo', text: 'Synthetic task', requestId: 'synthetic-task-1' }, 3)).status, 403, 'idempotent replay still requires current create');
    assert.equal((await request(b, notes + '/' + item.id, 'PATCH', { revision: 0, text: 'No edit' }, 2)).status, 403, 'no conflict history before action guard');
    for (const completed of [true, false]) assert.equal((await request(a, notes + '/' + item.id, 'PATCH', { revision: 1, completed }, 5)).status, 403);
    assert.equal((await request(b, notes, 'GET', undefined, 4)).status, 403, 'foreman view denial');
    assert.equal((await request(b, '/api/projects/102/notes-todos', 'GET', undefined, 3)).status, 404);
    next = JSON.parse(JSON.stringify(next)); next.customRoles = [{ id: 'custom_readonly', name: 'Project reader', baseRole: 'project_manager', permissions: { view: true, create: false, edit: false, complete: false } }]; next.assignments = [{ userId: 3, customRoleId: 'custom_readonly' }];
    await change(b, a, next, 1);
    assert.equal((await request(b, notes + '/' + item.id, 'PATCH', { revision: 1, text: 'No custom edit' }, 3)).status, 403);
    assert.equal((await request(a, notes + '/' + item.id, 'PATCH', { revision: 1, completed: true }, 3)).status, 403);
    assert.equal((await request(a, notes, 'GET', undefined, 1)).status, 200, 'owner unaffected');
    assert.equal((await request(a, route + '/preview', 'POST', { revision: 2, policy: next, reason: 'self' }, 2)).status, 403);
    for (const id of [3, 4, 5]) {
      assert.equal((await request(a, '/api/projects', 'POST', { id: 102, name: 'Scope injection' }, id)).status, 403);
      assert.equal((await request(b, '/api/workdays/start', 'POST', { projectId: 102, memberIds: [11] }, id)).status, 403);
      assert.equal((await request(a, '/api/reports', 'POST', { projectId: 102, notes: 'Foreign', laborEntries: [{ memberId: 11 }] }, id)).status, 403);
      assert.equal((await request(b, '/api/projects/102/plans', 'GET', undefined, id)).status, 403);
    }
    const saved = JSON.parse(fs.readFileSync(dbFile));
    assert.equal(saved.auditLog.filter(row => row.type === 'notes_role_policy_changed').length, 2);
    for (const user of saved.users) { const before = originalUsers.find(row => row.id === user.id); const { notesCustomRoleId, ...safe } = user; assert.deepEqual(safe, before, 'base role/grants/scope unchanged'); }
    assert.equal(saved.users.find(row => row.id === 3).notesCustomRoleId, 'custom_readonly');
    const disabled = await start(''); assert.equal((await request(disabled, notes, 'GET', undefined, 3)).status, 503, 'saved policy cannot be bypassed by disabling mode');
    assert.equal((await request(a, '/api/platform/companies', 'GET')).status, 503, 'platform writer bypass family unavailable');
    assert.equal((await request(a, '/api/billing/webhook', 'POST', {})).status, 503);
    assert.equal((await fetch(a + '/notes-role-permissions.js')).status, 404);
    console.log('Two-process notes permissions: cross-worker preview/confirm, upload revocation, all roles/custom profile, scope protection, audit, and unsupported-mode fail closed passed');
  } finally { await Promise.all(processes.map(child => new Promise(resolve => { if (child.exitCode != null) return resolve(); child.once('exit', resolve); child.kill(); }))); fs.rmSync(temp, { recursive: true, force: true }); }
})().catch(err => { console.error(err); process.exitCode = 1; });
