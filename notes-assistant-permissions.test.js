'use strict';
// Every record, bearer token, provider and server below is synthetic/local.
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { spawn } = require('node:child_process');
const { fixture, companyA, token } = require('./fixtures/project-assistant');
const policy = require('./notes-role-permissions');
const { createAIHandler } = require('./project-assistant-ai');
const { memoryStore, changes } = require('./fixtures/assistant-ai');
const { createChat } = require('./project-assistant-chat');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-notes-assistant-')), dbFile = path.join(temp, 'db.json'), children = [];
const db = fixture(); db.company.timezone = 'UTC';
fs.writeFileSync(dbFile, JSON.stringify(db)); fs.writeFileSync(path.join(temp, 'platform.json'), JSON.stringify({ users: [], sessions: [] }));
async function start(mode = 'shared-file') {
  const env = { ...process.env, PDL_DB_FILE: dbFile, PDL_PLATFORM_FILE: path.join(temp, 'platform.json'), PDL_SUPABASE_ENABLED: '0', PDL_TRANSACTIONAL_DB: 'off', PDL_REQUIRE_AUTH: '1', PDL_EMAIL_DEV_MODE: '1', PDL_ROLE_PERMISSIONS_STORAGE: mode };
  for (const key of ['SENTRY_DSN', 'RESEND_API_KEY', 'OPENAI_API_KEY', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET']) delete env[key];
  const child = spawn(process.execPath, ['-e', "const{server}=require('./server');server.listen(0,'127.0.0.1',()=>console.log('PORT='+server.address().port))"], { cwd: __dirname, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }); children.push(child);
  return new Promise((resolve, reject) => { let output = ''; const timer = setTimeout(() => reject(Error('Synthetic server timeout: ' + output)), 20000); child.stdout.on('data', bytes => { output += bytes; const port = output.match(/PORT=(\d+)/); if (port) { clearTimeout(timer); resolve('http://127.0.0.1:' + port[1]); } }); child.stderr.on('data', bytes => output += bytes); child.once('error', error => { clearTimeout(timer); reject(error); }); child.once('exit', code => { clearTimeout(timer); reject(Error('Synthetic server exited: ' + code + output)); }); });
}
const headers = userId => ({ Authorization: 'Bearer ' + token(companyA, userId), 'X-PDL-Company': companyA, 'Content-Type': 'application/json' });
async function request(base, route, method = 'GET', input, userId = 2) { const response = await fetch(base + route, { method, headers: headers(userId), ...(input === undefined ? {} : { body: JSON.stringify(input) }) }); return { status: response.status, data: await response.json() }; }
const root = '/api/projects/101/assistant/', settings = '/api/company/notes-role-permissions', notes = '/api/projects/101/notes-todos';
async function savePolicy(base, next, revision) {
  next.revision = revision + 1;
  const preview = await request(base, settings + '/preview', 'POST', { revision, policy: next, reason: 'Synthetic compatibility review' }, 1); assert.equal(preview.status, 200, JSON.stringify(preview));
  const saved = await request(base, settings, 'PUT', { ...preview.data, users: undefined, confirm: true }, 1); assert.equal(saved.status, 200, JSON.stringify(saved));
}
const note = text => ({ action: 'note', text, deadline: 'none' });
const confirmation = preview => ({ token: preview.data.token, version: preview.data.version, confirmed: true });
function slowConfirm(base, payload) {
  const raw = JSON.stringify(payload); let req;
  const result = new Promise((resolve, reject) => { req = http.request(base + root + 'confirm', { method: 'POST', headers: { ...headers(2), 'Content-Length': Buffer.byteLength(raw) } }, res => { let output = ''; res.on('data', bytes => output += bytes); res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(output) })); }); req.on('error', reject); req.write(raw.slice(0, 1)); });
  return { result, finish: () => req.end(raw.slice(1)) };
}
async function aiChecks() {
  const crypto = require('node:crypto'), current = fixture(), store = memoryStore(); let calls = 0;
  const flags = { view: true, create: true, edit: false, complete: false };
  current.users[1].notesPermissions = flags; current.users[1].notesPolicyRevision = 1;
  const handler = createAIHandler({ readDb: () => current, readFreshDb: () => current, authenticatedUser: req => current.users.find(row => row.id === (req.userId || 2)), accountAccess: () => ({ locked: false }), body: async req => req.input, json: (res, status, data) => Object.assign(res, { status, data }), store, enabled: () => true, signingKey: () => 'synthetic-signing-only', now: () => new Date('2026-10-08T16:00:00Z'), adapter: async payload => { calls++; const input = JSON.parse(payload.input); assert.equal(input.memberNames, undefined, 'known notes do not send generated team names'); assert.equal(input.draft.people, undefined); return { changes: changes({ action: 'note', text: 'Synthetic text' }), usage: { input_tokens: 100, output_tokens: 30 } }; } });
  const input = { text: 'Synthetic text', sessionId: crypto.randomUUID(), turnId: crypto.randomUUID(), projectId: 101, draft: { action: 'note', text: 'Synthetic text', deadline: 'none' } };
  const run = async value => { const res = {}; await handler({ method: 'POST', input: value }, res, new URL('http://synthetic/api/assistant/interpret')); return res; };
  let result = await run(input); assert.equal(result.data.ready, true); assert.equal(calls, 1);
  flags.create = false; current.users[1].notesPolicyRevision = 2;
  result = await run({ ...input, state: result.data.state, turnId: crypto.randomUUID() }); assert.equal(result.data.source, 'form'); assert.equal(calls, 1, 'revoked signed state cannot dispatch provider');
  result = await run({ ...input, turnId: crypto.randomUUID() }); assert.equal(result.data.source, 'form'); assert.equal(calls, 1, 'known denied note draft stops before reservation/provider');
  flags.create = true; current.users[1].notesPolicyRevision = 3;
  const swap = store.compareAndSwap; store.compareAndSwap = async (...args) => { const saved = await swap(...args); current.users[1].notesPermissions = { ...flags, create: false }; current.users[1].notesPolicyRevision = 4; return saved; };
  result = await run({ ...input, turnId: crypto.randomUUID() }); assert.equal(result.data.source, 'form'); assert.equal(calls, 1, 'notes revocation during ledger admission suppresses provider dispatch');
  const context = { project: { id: 101, name: 'Synthetic site A' }, timezone: 'UTC', members: [], capabilities: { schedule: true, note: false, todo: false } };
  for (const action of ['note', 'todo']) { const chat = createChat(); chat.adopt({ action, text: 'Synthetic', deadline: 'none' }, 101, context); assert.equal(chat.ready, false); assert.match(chat.question(), /unavailable/); }
}
(async () => {
  try {
    await aiChecks();
    const [a, b] = await Promise.all([start(), start()]);
    const baseline = await request(a, '/api/auth/me'); assert.equal(baseline.status, 200); assert.equal(baseline.data.notesPermissions, undefined, 'no-policy projection preserves baseline shape');
    const savedPreview = await request(a, root + 'preview', 'POST', note('Original saved note')); assert.equal(savedPreview.status, 200);
    const receipt = confirmation(savedPreview); assert.equal((await request(a, root + 'confirm', 'POST', receipt)).status, 201);
    const pending = await request(a, root + 'preview', 'POST', note('Must not save after revocation')); assert.equal(pending.status, 200);
    const todo = await request(a, notes, 'POST', { kind: 'todo', text: 'Deadline fixture', requestId: 'synthetic-deadline', dueDate: '2099-01-01' }); assert.equal(todo.status, 201);
    const next = policy.defaults(); next.roles.project_manager.create = false; next.roles.project_manager.edit = false;
    await savePolicy(b, next, 0);
    const current = await request(a, '/api/auth/me'); assert.equal(current.data.notesPermissions.create, false); assert.equal(current.data.permissions.scheduleCrews, true);
    const context = await request(a, root + 'context'); assert.equal(context.status, 200); assert.equal(context.data.capabilities.schedule, true); assert.equal(context.data.capabilities.note, false); assert.equal(context.data.capabilities.todo, false);
    for (const action of ['note', 'todo']) {
      assert.equal((await request(a, root + 'preview', 'POST', { ...note('Denied preview'), action })).status, 403);
      assert.equal((await request(a, root + 'chat', 'POST', { action, text: 'Denied legacy suggestion' })).status, 403);
    }
    assert.equal((await request(a, root + 'confirm', 'POST', confirmation(pending))).status, 403);
    assert.equal((await request(a, root + 'confirm', 'POST', receipt)).status, 403, 'replay cannot disclose saved receipt after create revocation');
    assert.equal((await request(a, notes + '/' + todo.data.id, 'PATCH', { revision: 1, dueDate: '2099-01-02' })).status, 403, 'deadline-only edit cannot bypass edit capability');
    assert.equal((await request(a, notes + '/' + todo.data.id, 'PATCH', { revision: 999, dueDate: '2099-01-01', completed: true })).status, 403, 'mixed deadline/completion checks before stale disclosure');
    const schedule = { action: 'schedule', memberId: 11, date: '2099-01-02', start: '08:00', end: '16:00', activity: 'Synthetic scheduling', instructions: 'Synthetic only', timezone: 'UTC' };
    const permitted = await request(a, root + 'preview', 'POST', schedule); assert.equal(permitted.status, 200); assert.equal((await request(a, root + 'confirm', 'POST', confirmation(permitted))).status, 201, 'notes restriction leaves authorized scheduling intact');
    assert.equal((await request(a, '/api/projects/102/assistant/context')).status, 404);
    for (const id of [4, 5]) assert.equal((await request(a, root + 'context', 'GET', undefined, id)).status, 403, 'fixed assistant eligibility excludes field/foreman');
    next.roles.project_manager.create = true; await savePolicy(b, next, 1);
    const uploading = await request(a, root + 'preview', 'POST', note('Buffered confirmation must refresh permission'));
    const slow = slowConfirm(a, confirmation(uploading));
    next.roles.project_manager.create = false; await savePolicy(b, next, 2); slow.finish(); assert.equal((await slow.result).status, 403, 'slow confirm body is buffered before fresh admission');
    next.roles.project_manager.create = true;
    next.customRoles = [{ id: 'custom_foreman', name: 'Foreman notes viewer', baseRole: 'foreman', permissions: { view: true, create: false, edit: false, complete: false } }]; next.assignments = [{ userId: 5, customRoleId: 'custom_foreman' }];
    await savePolicy(b, next, 3);
    const lost = JSON.parse(fs.readFileSync(dbFile)); delete lost.company.notesRolePolicy; fs.writeFileSync(dbFile, JSON.stringify(lost));
    const unmarked = await request(a, '/api/auth/me'); assert.equal(unmarked.data.notesPermissions.view, false, 'another account marker causes fresh unmarked actor to fail closed after policy loss');
    const workspace = await request(a, '/api/state'); assert.equal(workspace.data.currentUser.notesPermissions.view, false, 'workspace actor projection preserves global-marker denial');
    assert.equal((await request(a, root + 'preview', 'POST', note('Missing policy cannot restore access'))).status, 403);
    assert.equal((await request(a, root + 'context')).data.capabilities.schedule, true);
    assert.equal((await request(a, root + 'preview', 'POST', note('Protected owner'), 1)).status, 200);
    const unsupported = await start('disabled'); assert.equal((await request(unsupported, root + 'preview', 'POST', note('Unsupported owner mode'), 1)).status, 403);
    const disk = JSON.parse(fs.readFileSync(dbFile)); assert.equal(disk.projectNotesTodos.length, 2, 'all revoked creates leave no notes'); assert.equal(disk.assignments.length, 1);
    console.log('Notes/assistant compatibility passed: fresh typed restrictions, independent scheduling, immutable eligibility, revoked first-confirm/replay/upload, deadlines, missing-policy markers, AI admission/replay and private note context.');
  } finally { for (const child of children) child.kill(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
