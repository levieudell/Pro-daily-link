'use strict';
// Actual legacy HTTP handlers plus current typed controllers/profile models.
// All tenants, sessions, files and provider adapters below are synthetic.
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto'), vm = require('node:vm');
const { spawn } = require('node:child_process'), { once } = require('node:events');
const registry = require('./capability-registry'), profiles = require('./role-profiles');
const { companyA, companyB, fixture, token } = require('./fixtures/project-assistant');
const { createAIHandler } = require('./project-assistant-ai');
const { memoryStore, changes } = require('./fixtures/assistant-ai');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-editor-assistant-policy-')), dbFile = path.join(temp, 'db.json');
fs.writeFileSync(path.join(temp, 'platform.json'), JSON.stringify({ users: [], sessions: [] }));
let child, base, requests = 0, providerCalls = 0;
const schedule = { action: 'schedule', memberId: 11, date: '2098-10-12', start: '08:00', end: '16:00', activity: 'Synthetic policy work', instructions: 'Check the synthetic layout', timezone: 'America/Los_Angeles' };
const batch = { action: 'schedule_batch', memberIds: [11, 12], startDate: '2098-10-12', endDate: '2098-10-13', weekdays: [0, 1, 2, 3, 4, 5, 6], start: '08:00', end: '16:00', activity: schedule.activity, instructions: schedule.instructions, timezone: schedule.timezone };
const note = { action: 'note', text: 'Synthetic project access note', deadline: 'none', dueDate: '', timezone: schedule.timezone }, todo = { ...note, action: 'todo' };
function setPolicy(db, family, actions, role = 'project_manager') {
  const [, , prefix, , controller] = registry.families.find(row => row[0] === family);
  db.company[prefix + 'PolicyRequired'] = true;
  const policy = db.company[prefix + 'RolePolicy'] || { version: 1, revision: 0, roles: Object.fromEntries(controller.roles.map(id => [id, controller.ceiling(id)])) };
  policy.revision++; Object.assign(policy.roles[role], actions); db.company[prefix + 'RolePolicy'] = policy;
  db.company.rolePolicyRevision = (db.company.rolePolicyRevision || 0) + 1;
}
function profile(db, capabilities, accountId = 2) {
  const id = crypto.randomUUID(), baseRole = db.users.find(row => row.id === accountId).role;
  db = profiles.plan(db, { operation: 'create', profileId: id, name: 'Synthetic restricted assistant profile', baseRole, capabilities });
  return profiles.plan(db, { operation: 'assign', accountId, profileId: id });
}
const write = db => fs.writeFileSync(dbFile, JSON.stringify(db));
const read = () => JSON.parse(fs.readFileSync(dbFile, 'utf8'));
const reset = () => write(fixture());
function change(fn) { const db = read(); fn(db); write(db); }
async function start() {
  const env = { ...process.env, NODE_ENV: 'test', PDL_DB_FILE: dbFile, PDL_PLATFORM_FILE: path.join(temp, 'platform.json'), PDL_REQUIRE_AUTH: '1', PDL_SUPABASE_ENABLED: '0', PDL_TRANSACTIONAL_DB: 'off', PDL_EMAIL_DEV_MODE: '1', PDL_ASSISTANT_AI_ENABLED: '0' };
  for (const name of Object.keys(env)) if (/^(OPENAI_|STRIPE_|SUPABASE_|SENTRY_|RESEND_|PDL_COMPAT_)/.test(name) || name === 'DATABASE_URL') delete env[name];
  const script = `global.fetch=async()=>{throw Error('No external calls allowed in editor Assistant HTTP proofs');};const{server}=require('./server');server.listen(0,'127.0.0.1',()=>console.log('EDITOR_ASSISTANT_PORT='+server.address().port));`;
  child = spawn(process.execPath, ['-e', script], { cwd: __dirname, env, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => { let log = ''; const timeout = setTimeout(() => reject(Error(log)), 15000); child.stdout.on('data', bytes => { log += bytes; const match = log.match(/EDITOR_ASSISTANT_PORT=(\d+)/); if (match) { base = 'http://127.0.0.1:' + match[1]; clearTimeout(timeout); resolve(); } }); child.stderr.on('data', bytes => { log += bytes; }); child.once('error', reject); child.once('exit', code => { clearTimeout(timeout); reject(Error('Synthetic HTTP worker exited ' + code + ': ' + log)); }); });
}
async function stop() { if (!child || child.exitCode != null) return; const exited = once(child, 'exit'); child.kill(); await exited; child = null; }
async function request(action, input, user = 2, project = 101) {
  requests++; const response = await fetch(base + '/api/projects/' + project + '/assistant/' + action, { method: input ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', 'X-PDL-Company': companyA, Authorization: 'Bearer ' + token(companyA, user) }, ...(input ? { body: JSON.stringify(input) } : {}) });
  return { status: response.status, data: await response.json() };
}
const confirmation = preview => ({ token: preview.data.token, version: preview.data.version, confirmed: true });
async function preview(input, user = 2) { const result = await request('preview', input, user); assert.equal(result.status, 200, JSON.stringify(result)); assert.ok(result.data.token); return confirmation(result); }
async function httpProofs() {
  reset(); await start();
  for (const user of [1, 2, 7]) { reset(); assert.equal((await request('context', undefined, user)).status, 200); await preview(schedule, user); await preview(note, user); }
  reset(); assert.equal((await request('preview', schedule, 6)).status, 403); await preview(note, 6);
  for (const user of [4, 5]) for (const action of ['context', 'preview']) assert.equal((await request(action, action === 'preview' ? note : undefined, user)).status, 403);
  change(db => { const user = { ...db.users[0], id: 8, role: 'platform_owner' }; db.users.push(user); db.sessions.push({ ...db.sessions[0], userId: 8, tokenHash: crypto.createHash('sha256').update(token(companyA, 8)).digest('hex') }); });
  assert.equal((await request('context', undefined, 8)).status, 403);
  for (const input of [schedule, batch]) {
    reset(); const original = await preview(input);
    change(db => setPolicy(db, 'scheduling', { create: false }));
    assert.equal(read().users[1].permissions.scheduleCrews, true, 'typed restriction does not rewrite stored grant');
    assert.equal((await request('preview', input)).status, 403); assert.equal((await request('confirm', original)).status, 403); assert.equal(read().assignments.length, 0);
    const ctx = await request('context'); assert.equal(ctx.status, 200); assert.equal(ctx.data.capabilities.schedule, false); assert.equal(ctx.data.capabilities.note, true); assert.deepEqual(ctx.data.members, []);
    change(db => setPolicy(db, 'scheduling', { create: true })); assert.equal((await request('confirm', original)).status, 409, 'changed policy authority needs fresh preview even after re-enable');
    const fresh = await preview(input); assert.equal((await request('confirm', fresh)).status, 201); const count = read().assignments.length;
    assert.equal((await request('confirm', fresh)).status, 200); assert.equal(read().assignments.length, count);
    change(db => setPolicy(db, 'scheduling', { create: false })); assert.equal((await request('confirm', fresh)).status, 403, 'saved receipt cannot bypass current typed scheduling restriction'); assert.equal(read().assignments.length, count);
    await preview(note);
  }
  for (const input of [note, todo]) {
    reset(); const original = await preview(input); change(db => setPolicy(db, 'notes', { create: false }));
    assert.equal((await request('preview', input)).status, 403); assert.equal((await request('confirm', original)).status, 403); assert.equal(read().projectNotesTodos, undefined);
    const ctx = await request('context'); assert.equal(ctx.data.capabilities.note, false); assert.equal(ctx.data.capabilities.schedule, true); await preview(schedule);
    change(db => setPolicy(db, 'notes', { create: true })); assert.equal((await request('confirm', original)).status, 409);
    const fresh = await preview(input); assert.equal((await request('confirm', fresh)).status, 201); assert.equal((await request('confirm', fresh)).status, 200); assert.equal(read().projectNotesTodos.length, 1);
    change(db => setPolicy(db, 'notes', { create: false })); assert.equal((await request('confirm', fresh)).status, 403); assert.equal(read().projectNotesTodos.length, 1);
  }
  reset(); const capabilities = profiles.defaults('project_manager'); capabilities.scheduling.create = false; for (const action of Object.keys(capabilities.notes)) capabilities.notes[action] = false; write(profile(read(), capabilities));
  assert.equal((await request('preview', schedule)).status, 403); assert.equal((await request('preview', note)).status, 403); assert.equal((await request('context')).data.capabilities.schedule, false); await preview(schedule, 1);
  reset(); const profilePending = await preview(schedule); write(profile(read(), capabilities)); assert.equal((await request('confirm', profilePending)).status, 403); assert.equal(read().assignments.length, 0);
  for (const corrupt of [db => { db.company.schedulingPolicyRequired = true; db.company.schedulingRolePolicy = { version: 99 }; }, db => { db.company.roleProfilesRequired = true; }]) {
    reset(); corruptDb(corrupt); const denied = await request('preview', schedule); assert.ok([403, 404].includes(denied.status)); assert.ok(!JSON.stringify(denied.data).includes('Synthetic site A')); assert.equal(read().assignments.length, 0); await preview(schedule, 1);
  }
  reset(); change(db => { setPolicy(db, 'scheduling', Object.fromEntries(require('./scheduling-access').actions.map(action => [action, false]))); setPolicy(db, 'notes', Object.fromEntries(require('./notes-access').actions.map(action => [action, false]))); });
  assert.equal((await request('context')).status, 404, 'no typed view returns no selected project labels'); assert.equal((await request('context', undefined, 1)).status, 200, 'Owner remains able to recover');
  for (const revoke of [db => { db.users[1].status = 'Inactive'; }, db => { db.sessions.find(row => row.userId === 2).expiresAt = '2000-01-01T00:00:00Z'; }, db => { db.users[1].role = 'field'; }, db => { db.users[1].projectIds = [102]; }, db => { db.team[1].crew = 'B'; }]) {
    reset(); const original = await preview(batch); change(revoke); assert.ok([401, 403, 404].includes((await request('confirm', original)).status)); assert.equal(read().assignments.length, 0);
  }
  reset(); const foreign = await preview(schedule); change(db => { db.sessions.find(row => row.userId === 2).companyId = companyB; }); assert.ok([401, 404].includes((await request('confirm', foreign)).status)); assert.equal(read().assignments.length, 0);
  reset(); assert.equal((await request('preview', { ...schedule, schedulingAccess: { create: true }, permissions: { owner: true } })).status, 400); assert.equal(read().assignments.length, 0);
  reset(); change(db => { db.assignments.push({ id: 1, projectId: 101, memberIds: [11], date: '2098-10-10', start: '08:00', end: '10:00' }); }); const originalNote = await preview(note); assert.equal((await request('confirm', originalNote)).status, 201); assert.equal(read().projectNotesTodos[0].text, note.text); assert.equal(Object.hasOwn(read().projectNotesTodos[0], 'assignee'), false); assert.equal(read().assignments.length, 1, 'note does not create schedules or notifications');
}
function corruptDb(corrupt) { change(corrupt); }
function currentAuthentication() {
  const source = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8'), start = source.indexOf('function authenticateRequestAccount('), end = source.indexOf('function projectNotesUser(', start);
  assert.ok(start >= 0 && end > start); const context = { crypto, bearer: req => req.token, cookie: () => null, compatibilityAccountRuntime: { companyId: companyA, actor: registry.actor } };
  vm.createContext(context); vm.runInContext(source.slice(start, end), context); return context.authenticateRequestAccount;
}
async function aiProofs() {
  const authenticate = currentAuthentication();
  function harness(mutate, reserveMutation) {
    let db = fixture(); if (mutate) mutate(db); const store = memoryStore(), compareAndSwap = store.compareAndSwap; let calls = 0;
    if (reserveMutation) store.compareAndSwap = async (...args) => { const saved = await compareAndSwap(...args); reserveMutation(db); return saved; };
    const handler = createAIHandler({ readDb: () => db, readFreshDb: () => db, authenticatedUser: (req, current) => authenticate(req, current).auth?.user, accountAccess: () => ({ locked: false }), body: async req => req.input, json: (res, status, data) => Object.assign(res, { status, data }), now: () => new Date('2026-10-07T16:00:00Z'), store, enabled: () => true, signingKey: () => 'synthetic-editor-policy-only', adapter: async payload => { calls++; providerCalls++; const input = JSON.parse(payload.input); assert.ok(!JSON.stringify(input).includes('Private member')); assert.ok(!JSON.stringify(input).includes('Private synthetic site')); return { changes: changes({ action: 'note', project: 'Synthetic site A', text: 'Only a synthetic note' }), usage: { input_tokens: 100, output_tokens: 100 } }; } });
    async function turn(input) { const req = { method: 'POST', input, token: token(companyA, 2), auth: { user: { role: 'owner', schedulingAccess: { create: true } } } }, res = {}; await handler(req, res, new URL('http://localhost/api/assistant/interpret')); return res; }
    return { turn, get calls() { return calls; }, get db() { return db; } };
  }
  const input = () => ({ text: 'Add a note for Synthetic site A: Only a synthetic note', projectId: 101, sessionId: crypto.randomUUID(), turnId: crypto.randomUUID() });
  let h = harness(db => setPolicy(db, 'scheduling', { create: false })), result = await h.turn(input()); assert.equal(result.status, 200); assert.equal(result.data.ready, true); assert.deepEqual(result.data.context.members, []); assert.equal(h.calls, 1, 'denied scheduling does not deny permitted notes');
  h = harness(db => setPolicy(db, 'notes', { create: false })); result = await h.turn(input()); assert.equal(result.status, 200); assert.equal(result.data.ready, false, 'AI interpretation cannot mark a denied note ready'); assert.equal(result.data.context.capabilities.note, false);
  h = harness(undefined, db => setPolicy(db, 'notes', { create: false })); result = await h.turn(input()); assert.equal(result.data.source, 'form'); assert.equal(h.calls, 0, 'actual policy revocation during reservation suppresses provider dispatch');
  h = harness(db => { setPolicy(db, 'scheduling', Object.fromEntries(require('./scheduling-access').actions.map(action => [action, false]))); setPolicy(db, 'notes', Object.fromEntries(require('./notes-access').actions.map(action => [action, false]))); }); result = await h.turn(input()); assert.equal(h.calls, 0); assert.equal(result.data.source, 'form'); assert.ok(!JSON.stringify(result.data).includes('Synthetic site A'), 'denied view produces no retained project context');
  h = harness(); const first = await h.turn(input()); assert.equal(first.data.source, 'ai'); setPolicy(h.db, 'notes', { create: false }); const replay = await h.turn({ ...input(), state: first.data.state }); assert.equal(replay.data.source, 'form'); assert.equal(h.calls, 1, 'conversation cannot replay through actual changed typed authority');
}
async function main() {
  try { await httpProofs(); await aiProofs(); console.log(JSON.stringify({ result: 'passed', httpRequests: requests, syntheticProviderCalls: providerCalls, externalCalls: 0, coverage: ['actual current-session HTTP policy/profile masks', 'single/batch preview/confirm/replay', 'independent notes/to-dos and scheduling', 'stale policy/profile authority', 'invalid policy/profile fail-closed and Owner recovery', 'fixed field/foreman/platform exclusion', 'scope/session/tenant revocation', 'minimal context and typed provider-reservation revocation', 'no-policy legacy behavior'], syntheticDataDirectory: temp })); }
  finally { await stop(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
