'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { splitSnapshot, assembleSnapshot } = require('./database/transactional-repository');
const { createPortableBackup, digest } = require('./database/portable-backup');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-project-notes-'));
const dbFile = path.join(temp, 'db.json');
const companyA = '11111111-1111-4111-8111-111111111111';
const companyB = '22222222-2222-4222-8222-222222222222';
const guestToken = 'ab'.repeat(24);
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const token = (company, user) => `synthetic-notes-${company}-${user}`;
const route = project => `/api/projects/${project}/notes-todos`;
const newInput = (kind = 'note', text = 'Synthetic project note') => ({ kind, text, requestId: crypto.randomUUID() });

function fixture(companyId) {
  const db = {
    company: { id: companyId, name: 'Synthetic notes tenant', demo: true, timezone: 'America/Los_Angeles', features: {} },
    projects: [101, 102, 103, 104].map(id => ({ id, name: `Synthetic project ${id}`, status: 'Active', customerId: 1, budget: '$918273', contractValue: 918273, tmSettings: { defaultLaborRate: 918273 }, estimateItems: [{ id: 1, cost: 918273 }] })),
    customers: [{ id: 1, name: 'Synthetic customer' }],
    team: [11, 12, 13].map(id => ({ id, name: `Synthetic member ${id}`, crew: 'Notes crew', role: 'Crew member' })),
    assignments: [{ id: 1, projectId: 101, memberIds: [11], date: '2026-10-01' }],
    workdays: [{ id: 1, projectId: 103, memberIds: [12] }],
    reports: [{ id: 1, project: 3, foreman: 'Synthetic member 13', status: 'Draft', notes: 'Synthetic report', laborEntries: [{ memberId: 13, hours: 1 }] }],
    subcontractors: [{ id: 1, name: 'Synthetic subcontractor', trade: 'Synthetic' }],
    subcontractorLinks: [{ id: 1, projectId: 101, subcontractorId: 1, tokenHash: hash(guestToken), status: 'Active', expiresAt: '2099-01-01T00:00:00Z' }],
    photos: [], changes: [], catalog: [], users: [], sessions: []
  };
  db.users = [
    { id: 1, role: 'owner' }, { id: 2, role: 'admin' },
    { id: 3, role: 'project_manager', projectIds: [101] },
    { id: 4, role: 'foreman', memberId: 11 },
    { id: 5, role: 'field', memberId: 12 },
    { id: 6, role: 'field', memberId: 13 },
    { id: 7, role: 'guest' }, { id: 8, role: 'unrecognized' },
    { id: 9, role: 'field' }, { id: 10, role: 'owner', status: 'Inactive' },
    { id: 11, role: 'office' }, { id: 12, role: 'owner', companyId: companyB },
    { id: 13, role: 'owner', expired: true }, { id: 14, role: 'project_manager', projectIds: [] }
  ].map(user => ({ companyId, status: 'Active', name: `Synthetic user ${user.id}`, email: `qa${user.id}@example.invalid`, ...user }));
  db.sessions = db.users.map(user => ({ userId: user.id, companyId, tokenHash: hash(token(companyId, user.id)), expiresAt: user.expired ? '2000-01-01T00:00:00Z' : '2099-01-01T00:00:00Z' }));
  return db;
}

fs.mkdirSync(path.join(temp, 'tenants'));
fs.writeFileSync(dbFile, JSON.stringify(fixture(companyA)));
fs.writeFileSync(path.join(temp, 'tenants', `${companyB}.json`), JSON.stringify(fixture(companyB)));
fs.writeFileSync(path.join(temp, 'platform.json'), JSON.stringify({ users: [], sessions: [], notes: [] }));

let child, base, serverLog = '';
async function startServer(authRequired = true) {
  const env = { ...process.env, PDL_DB_FILE: dbFile, PDL_PLATFORM_FILE: path.join(temp, 'platform.json'), PDL_SUPABASE_ENABLED: '0', PDL_TRANSACTIONAL_DB: 'off', PDL_REQUIRE_AUTH: authRequired ? '1' : '0', PDL_EMAIL_DEV_MODE: '1' };
  for (const key of ['SENTRY_DSN', 'RESEND_API_KEY', 'OPENAI_API_KEY', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET']) delete env[key];
  serverLog = '';
  child = spawn(process.execPath, ['-e', "const {server}=require('./server');server.listen(0,'127.0.0.1',()=>console.log('NOTES_TEST_PORT='+server.address().port));"], { cwd: __dirname, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Synthetic notes server did not start: ' + serverLog)), 15000);
    child.stdout.on('data', bytes => {
      serverLog += String(bytes);
      const match = serverLog.match(/NOTES_TEST_PORT=(\d+)/);
      if (match) { base = `http://127.0.0.1:${match[1]}`; clearTimeout(timeout); resolve(); }
    });
    child.stderr.on('data', bytes => { serverLog += String(bytes); });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', code => { clearTimeout(timeout); reject(new Error(`Synthetic notes server exited ${code}: ${serverLog}`)); });
  });
}

async function stopServer() {
  if (!child || child.exitCode != null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  await exited;
  child = null;
}

async function request(method, url, user = 1, input, company = companyA, extras = {}) {
  const headers = { 'Content-Type': 'application/json', 'x-pdl-company': company, ...(user == null ? {} : { Authorization: `Bearer ${token(company, user)}` }), ...extras };
  const response = await fetch(base + url, { method, headers, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
  const data = await response.json();
  return { status: response.status, data, headers: response.headers };
}

async function expectStatus(status, ...args) {
  const result = await request(...args);
  assert.equal(result.status, status, `${args[0]} ${args[1]} user ${args[2]}: ${JSON.stringify(result.data)}`);
  return result.data;
}

(async () => {
  try {
    await startServer();
    for (const file of ['/project-notes-ui.js', '/project-notes-ui.css']) {
      assert.equal((await fetch(base + file)).status, 200, 'notes UI asset is public: ' + file);
    }
    for (const file of ['/project-notes.js', '/project-notes-api.test.js']) {
      assert.equal((await fetch(base + file)).status, 404, 'notes implementation and synthetic tests stay private: ' + file);
    }
    for (const [user, project] of [[1, 101], [2, 102], [3, 101], [4, 101], [5, 103], [6, 104], [11, 102]]) {
      assert.deepEqual(await expectStatus(200, 'GET', route(project), user), { projectId: project, items: [] });
    }
    for (const [user, project] of [[3, 102], [4, 102], [5, 101], [6, 103], [9, 101], [14, 101]]) {
      await expectStatus(404, 'GET', route(project), user);
      await expectStatus(404, 'POST', route(project), user, newInput());
      await expectStatus(404, 'PATCH', route(project) + '/invented-item', user, { revision: 1, text: 'Denied edit' });
    }
    for (const user of [null, 10, 12, 13]) for (const method of ['GET', 'POST', 'PATCH']) {
      await expectStatus(401, method, route(101) + (method === 'PATCH' ? '/invented-item' : ''), user, method === 'GET' ? undefined : newInput());
    }
    for (const user of [7, 8]) for (const method of ['GET', 'POST', 'PATCH']) {
      await expectStatus(403, method, route(101) + (method === 'PATCH' ? '/invented-item' : ''), user, method === 'GET' ? undefined : newInput());
    }
    await expectStatus(401, 'GET', route(101), null, undefined, companyA, { Authorization: `Bearer ${guestToken}` });
    await expectStatus(404, 'GET', route(999), 1);

    const originalText = '<script>alert("notes-xss")</script>\n<img src=x onerror=alert(1)> & "quoted"';
    const noteInput = newInput('note', originalText);
    const note = await expectStatus(201, 'POST', route(101), 1, noteInput);
    assert.match(note.id, /^[a-f0-9-]{36}$/);
    assert.equal(note.text, originalText, 'plain text is returned literally in JSON');
    assert.equal(note.completed, false); assert.equal(note.revision, 1);
    assert.equal(note.createdBy, 'Synthetic user 1'); assert.equal(note.createdByUserId, 1);
    assert.equal(note.updatedByUserId, 1); assert.ok(Number.isFinite(Date.parse(note.createdAt)));
    assert.deepEqual(note.history, [{ action: 'Created', by: 'Synthetic user 1', userId: 1, at: note.createdAt, before: null, after: { text: originalText, completed: false, revision: 1 } }]);
    assert.equal(Object.hasOwn(note, 'requestId'), false); assert.equal(Object.hasOwn(note, 'companyId'), false);
    assert.deepEqual(await expectStatus(200, 'POST', route(101), 1, noteInput), note, 'repeated create is idempotent');
    await expectStatus(409, 'POST', route(101), 1, { ...noteInput, text: 'Changed original payload' });
    await expectStatus(409, 'POST', route(101), 1, { ...noteInput, kind: 'todo' });

    const edited = await expectStatus(200, 'PATCH', route(101) + '/' + note.id, 3, { revision: 1, text: 'Revised plain text\nwith a second line' });
    assert.equal(edited.revision, 2); assert.equal(edited.updatedByUserId, 3); assert.equal(edited.createdByUserId, 1);
    assert.equal(edited.history[1].action, 'Edited'); assert.equal(edited.history[1].before.text, originalText);
    assert.equal(edited.history[1].after.text, edited.text);
    assert.deepEqual(await expectStatus(200, 'POST', route(101), 1, noteInput), edited, 'uncertain original create can be retried after subsequent edits');
    const stale = await expectStatus(409, 'PATCH', route(101) + '/' + note.id, 1, { revision: 1, text: 'Stale change must not win' });
    assert.equal(stale.code, 'PROJECT_NOTE_CONFLICT'); assert.deepEqual(stale.item, edited);
    assert.deepEqual(await expectStatus(200, 'PATCH', route(101) + '/' + note.id, 1, { revision: 2, text: edited.text }), edited, 'no-op preserves revision, actor and history');
    await expectStatus(400, 'PATCH', route(101) + '/' + note.id, 1, { revision: 2, completed: true });
    await expectStatus(400, 'PATCH', route(101) + '/' + note.id, 1, { revision: 2, completed: false });

    const todoInput = newInput('todo', 'Check the synthetic LVP sample');
    let todo = await expectStatus(201, 'POST', route(101), 4, todoInput);
    todo = await expectStatus(200, 'PATCH', route(101) + '/' + todo.id, 4, { revision: todo.revision, completed: true });
    assert.equal(todo.completed, true); assert.equal(todo.history.at(-1).action, 'Completed');
    assert.equal(todo.history.at(-1).before.completed, false);
    todo = await expectStatus(200, 'PATCH', route(101) + '/' + todo.id, 2, { revision: todo.revision, completed: false, text: 'Check revised synthetic LVP sample' });
    assert.equal(todo.completed, false); assert.equal(todo.history.at(-1).action, 'Reopened and edited');
    assert.equal(todo.history.at(-1).before.completed, true); assert.equal(todo.history.at(-1).before.text, todoInput.text);
    assert.equal(todo.history.at(-1).after.text, todo.text);
    todo = await expectStatus(200, 'PATCH', route(101) + '/' + todo.id, 2, { revision: todo.revision, completed: true });
    todo = await expectStatus(200, 'PATCH', route(101) + '/' + todo.id, 2, { revision: todo.revision, completed: false });
    assert.equal(todo.history.at(-1).action, 'Reopened');

    // Field access follows all existing assignment/workday/report scope sources.
    for (const [user, project] of [[5, 103], [6, 104]]) {
      const item = await expectStatus(201, 'POST', route(project), user, newInput('todo'));
      await expectStatus(200, 'PATCH', route(project) + '/' + item.id, user, { revision: 1, completed: true });
    }
    await expectStatus(404, 'PATCH', route(102) + '/' + note.id, 1, { revision: 2, text: 'Wrong project' });
    await expectStatus(404, 'PATCH', route(102) + '/' + note.id, 3, { revision: 2, text: 'Unassigned project' });
    await expectStatus(404, 'GET', route(102) + '?userId=1&role=owner&memberId=11', 3);
    const byOtherActor = await expectStatus(201, 'POST', route(101), 2, noteInput);
    const byOtherProject = await expectStatus(201, 'POST', route(102), 1, noteInput);
    assert.notEqual(byOtherActor.id, note.id); assert.notEqual(byOtherProject.id, note.id);

    const invalidCreates = [
      null, [], 'text', 42, {}, newInput('invalid'), newInput('note', ''), newInput('note', '  \n '),
      newInput('note', {}), newInput('note', 123), newInput('note', 'a'.repeat(5001)), newInput('note', 'bad\u0000text'),
      { ...newInput(), requestId: undefined }, { ...newInput(), requestId: 'short' }, { ...newInput(), requestId: '../unsafe-key' },
      { ...newInput(), projectId: 102 }, { ...newInput(), companyId: companyB }, { ...newInput(), id: note.id },
      { ...newInput(), createdBy: 'Forged author' }, { ...newInput(), createdByUserId: 3 }, { ...newInput(), history: [] }, { ...newInput(), completed: true }
    ];
    for (const input of invalidCreates) await expectStatus(400, 'POST', route(101), 1, input);
    for (const input of [null, [], {}, { text: 'No revision' }, { revision: '2', text: 'Wrong revision type' }, { revision: 0, text: 'Wrong revision' }, { revision: 2 }, { revision: 2, text: '' }, { revision: 2, text: false }, { revision: 2, text: 'a'.repeat(5001) }, { revision: 2, history: [] }, { revision: 2, kind: 'todo', text: 'Cannot change kind' }]) {
      await expectStatus(400, 'PATCH', route(101) + '/' + note.id, 1, input);
    }
    await expectStatus(400, 'PATCH', route(101) + '/' + todo.id, 1, { revision: todo.revision, completed: 'false' });
    await expectStatus(405, 'DELETE', route(101) + '/' + note.id, 1);
    await expectStatus(405, 'PUT', route(101), 1, newInput());
    const longest = await expectStatus(201, 'POST', route(101), 1, newInput('note', 'a'.repeat(5000)));
    assert.equal(longest.text.length, 5000);

    // Same project IDs, user IDs and request IDs remain separate across tenants.
    assert.deepEqual(await expectStatus(200, 'GET', route(101), 1, undefined, companyB), { projectId: 101, items: [] });
    const otherTenant = await expectStatus(201, 'POST', route(101), 1, { ...noteInput, text: 'Tenant B private note' }, companyB);
    assert.notEqual(otherTenant.id, note.id);
    await expectStatus(404, 'PATCH', route(101) + '/' + note.id, 1, { revision: 2, text: 'Cross tenant write' }, companyB);
    await expectStatus(401, 'GET', route(101), 1, undefined, companyB, { Authorization: `Bearer ${token(companyA, 1)}` });
    assert.equal((await expectStatus(200, 'GET', route(101), 1, undefined, companyB)).items.length, 1);

    // Parallel requests use the existing tenant queue: create once and reject a stale competing edit.
    const parallelInput = newInput('todo', 'Exactly one parallel creation');
    const parallelCreates = await Promise.all(Array.from({ length: 8 }, () => request('POST', route(101), 1, parallelInput)));
    assert.equal(parallelCreates.filter(result => result.status === 201).length, 1);
    assert.equal(parallelCreates.filter(result => result.status === 200).length, 7);
    assert.equal(new Set(parallelCreates.map(result => result.data.id)).size, 1);
    const concurrentId = parallelCreates[0].data.id;
    const competing = await Promise.all([
      request('PATCH', route(101) + '/' + concurrentId, 1, { revision: 1, text: 'Concurrent writer one' }),
      request('PATCH', route(101) + '/' + concurrentId, 2, { revision: 1, text: 'Concurrent writer two' })
    ]);
    assert.deepEqual(competing.map(result => result.status).sort(), [200, 409]);
    const winner = competing.find(result => result.status === 200).data;
    assert.equal(winner.revision, 2); assert.equal(winner.history.length, 2);
    assert.deepEqual(competing.find(result => result.status === 409).data.item, winner);
    assert.deepEqual(await expectStatus(200, 'PATCH', route(101) + '/' + concurrentId, 1, { revision: 2, text: winner.text }), winner);

    // Inject synthetic extra fields to prove safe projections, not just input rejection.
    const stored = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
    const storedNote = stored.projectNotesTodos.find(row => row.id === note.id);
    storedNote.cost = 918273; storedNote.rateSnapshot = { private: 'SHOULD_NOT_LEAK' };
    storedNote.history[0].before = null;
    storedNote.history[0].after.contractValue = 918273;
    storedNote.history[0].private = 'SHOULD_NOT_LEAK';
    stored.projectNotesTodos.push({ ...structuredClone(storedNote), id: crypto.randomUUID(), companyId: companyB, text: 'CROSS_TENANT_INJECTED' });
    fs.writeFileSync(dbFile, JSON.stringify(stored));
    const listing = await request('GET', route(101), 4);
    assert.equal(listing.status, 200); assert.match(listing.headers.get('content-type'), /^application\/json/);
    assert.match(listing.headers.get('cache-control'), /no-store/);
    const listingText = JSON.stringify(listing.data);
    for (const forbidden of ['918273', 'SHOULD_NOT_LEAK', 'CROSS_TENANT_INJECTED', 'requestId', 'companyId', 'password', 'budget', 'rateSnapshot']) assert.equal(listingText.includes(forbidden), false, 'private field excluded: ' + forbidden);
    assert.equal(listing.data.items.find(row => row.id === note.id).history[0].after.text, originalText);
    for (const user of [1, 2, 3, 4, 5, 7, 8]) {
      const state = await expectStatus(200, 'GET', '/api/state', user);
      assert.equal(Object.hasOwn(state, 'projectNotesTodos'), false);
      assert.equal(JSON.stringify(state).includes('notes-xss'), false, 'notes/history absent from broad workspace');
    }
    const guest = await expectStatus(200, 'GET', '/api/guest/' + guestToken, null);
    assert.equal(JSON.stringify(guest).includes('notes-xss'), false);
    assert.equal(Object.hasOwn(guest, 'projectNotesTodos'), false);

    // The generic snapshot persistence and authorized owner export retain all history.
    const onDisk = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
    const split = splitSnapshot(onDisk);
    assert.deepEqual(assembleSnapshot(split.scalarData, split.records).projectNotesTodos, onDisk.projectNotesTodos);
    const ownerExport = await expectStatus(200, 'GET', '/api/company/export', 1);
    assert.deepEqual(ownerExport.projectNotesTodos, onDisk.projectNotesTodos.filter(row => row.companyId === companyA));
    assert.equal(JSON.stringify(ownerExport).includes('CROSS_TENANT_INJECTED'), false, 'owner export excludes foreign-company notes even in a contaminated snapshot');
    for (const user of [null, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]) {
      const result = await request('GET', '/api/company/export', user);
      assert.equal(Object.hasOwn(result.data, 'projectNotesTodos'), false, 'non-owner/invalid account cannot export notes: ' + user);
    }
    const portable = await createPortableBackup({ snapshot: onDisk, destination: path.join(temp, 'portable'), download: async () => { throw new Error('Synthetic notes backup must not download provider objects'); } });
    const backupBytes = fs.readFileSync(path.join(portable.directory, 'snapshot.json'));
    assert.equal(digest(backupBytes), portable.manifest.snapshot.sha256, 'portable notes backup digest verifies');
    assert.deepEqual(JSON.parse(backupBytes).projectNotesTodos, onDisk.projectNotesTodos, 'portable backup preserves complete note history and retry IDs');
    const beforeRestart = await expectStatus(200, 'GET', route(101), 1);
    await stopServer();
    fs.writeFileSync(dbFile, backupBytes);
    await startServer();
    for (const user of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const restoredState = await expectStatus(200, 'GET', '/api/state', user);
      assert.equal(Object.hasOwn(restoredState, 'projectNotesTodos'), false, 'restored notes remain absent from generic state for role ' + user);
    }
    assert.deepEqual(await expectStatus(200, 'GET', route(101), 1), beforeRestart, 'separate-process restart preserves items, revision and full history');
    assert.deepEqual(await expectStatus(200, 'POST', route(101), 1, parallelInput), winner, 'create idempotency survives restart');
    assert.equal((await expectStatus(200, 'GET', route(101), 1, undefined, companyB)).items[0].text, 'Tenant B private note');

    // The new routes remain private if an operator runs the rest of the app in demo mode.
    await stopServer();
    await startServer(false);
    await expectStatus(401, 'GET', route(101), null);
    await expectStatus(401, 'POST', route(101), null, newInput());
    await expectStatus(403, 'GET', route(101), 7);
    await expectStatus(404, 'GET', route(102), 3);
    assert.deepEqual(await expectStatus(200, 'GET', route(101), 1), beforeRestart);
    for (const user of [null, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]) {
      const demoState = await expectStatus(200, 'GET', '/api/state', user);
      assert.equal(Object.hasOwn(demoState, 'projectNotesTodos'), false, 'demo generic state cannot expose restored notes: ' + user);
    }
    for (const user of [null, 2, 3, 4, 7, 8, 10, 12, 13]) {
      const demoExport = await expectStatus(200, 'GET', '/api/company/export', user);
      assert.equal(Object.hasOwn(demoExport, 'projectNotesTodos'), false, 'demo export must not bypass notes authentication or owner-only export access');
    }
    const signedInDemoExport = await expectStatus(200, 'GET', '/api/company/export', 1);
    assert.ok(signedInDemoExport.projectNotesTodos.length > 0, 'real owner may export notes in demo mode');
    assert.equal(JSON.stringify(signedInDemoExport).includes('CROSS_TENANT_INJECTED'), false, 'demo owner export also excludes foreign-company notes');
    console.log('Project notes API acceptance passed: notes/tasks, audit history, role/project/tenant isolation, literal text validation, idempotency, concurrent revisions, safe projections, verified portable backup restore and process restart.');
  } finally {
    await stopServer();
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); if (serverLog) console.error(serverLog); process.exitCode = 1; });
