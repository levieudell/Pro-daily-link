'use strict';
// Project messages: office <-> crew threads scoped to a project.
// Office can message the whole crew or one person; crew read and reply in the
// field workspace. Targeted messages stay private to that person.
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-messages-')), companyId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', ownerToken = 'synthetic-messages-owner', chloeToken = 'synthetic-messages-chloe', andiToken = 'synthetic-messages-andi';
const hash = token => crypto.createHash('sha256').update(token).digest('hex');
const db = {
  company: { id: companyId, name: 'Synthetic messages', demo: true, timezone: 'UTC' },
  projects: [{ id: 101, name: 'Sunrise Slab', customer: 'Cust', site: 'Site A', status: 'Active' }, { id: 102, name: 'Other Job', customer: 'Cust', site: 'Site B', status: 'Active' }],
  team: [{ id: 7, name: 'Chloe', crew: 'A' }, { id: 8, name: 'Andi', crew: 'A' }],
  assignments: [{ id: 1, projectId: 101, memberIds: [7, 8], crew: 'A', date: '2026-10-13', start: '07:00', end: '15:30', activity: 'Pour slab' }],
  workdays: [], timeCards: [], timeOffRequests: [], reports: [], photos: [], auditLog: [], projectTasks: [], projectEvents: [], projectMessages: [], customers: [], changes: [], catalog: [],
  users: [
    { id: 1, name: 'Synthetic owner', role: 'owner', status: 'Active', companyId },
    { id: 2, name: 'Field Chloe', role: 'field', status: 'Active', companyId, memberId: 7 },
    { id: 3, name: 'Field Andi', role: 'field', status: 'Active', companyId, memberId: 8 }
  ],
  sessions: [
    { companyId, userId: 1, tokenHash: hash(ownerToken), expiresAt: '2099-01-01' },
    { companyId, userId: 2, tokenHash: hash(chloeToken), expiresAt: '2099-01-01' },
    { companyId, userId: 3, tokenHash: hash(andiToken), expiresAt: '2099-01-01' }
  ]
};
const file = path.join(root, 'db.json'); fs.writeFileSync(file, JSON.stringify(db)); fs.writeFileSync(path.join(root, 'platform.json'), JSON.stringify({ users: [], sessions: [] }));
Object.assign(process.env, { PDL_DB_FILE: file, PDL_PLATFORM_FILE: path.join(root, 'platform.json'), PDL_REQUIRE_AUTH: '1', PDL_SUPABASE_ENABLED: '0', PDL_TRANSACTIONAL_DB: 'off', PDL_EMAIL_DEV_MODE: '1' });
for (const name of ['OPENAI_API_KEY', 'SENTRY_DSN', 'RESEND_API_KEY', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET']) delete process.env[name];
require('./database/supabase').loadLocalEnv = () => {};
const { server } = require('./server');
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const call = (method, route, input, token = ownerToken) => fetch(base + route, { method, signal: AbortSignal.timeout(10000), headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', 'x-pdl-company': companyId }, ...(input !== undefined ? { body: JSON.stringify(input) } : {}) }).then(async response => ({ status: response.status, data: await response.json() }));
  const reload = () => JSON.parse(fs.readFileSync(file));
  try {
    // Office sends: broadcast + targeted, validated, persisted.
    const broadcast = await call('POST', '/api/projects/101/messages', { text: 'Inspector at 10 tomorrow — have forms ready' });
    assert.equal(broadcast.status, 201, JSON.stringify(broadcast.data));
    assert.equal(broadcast.data.sender, 'office');
    assert.equal(broadcast.data.memberId, null);
    const targeted = await call('POST', '/api/projects/101/messages', { text: 'Andi, grab the laser from the truck', memberId: 8 });
    assert.equal(targeted.status, 201);
    assert.equal(targeted.data.memberId, 8);
    assert.ok(reload().projectMessages.some(message => message.text === 'Inspector at 10 tomorrow — have forms ready'), 'persisted');

    assert.equal((await call('POST', '/api/projects/101/messages', { text: '  ' })).status, 400, 'text required');
    assert.equal((await call('POST', '/api/projects/101/messages', { text: 'x', memberId: 999 })).status, 400, 'member must exist');
    assert.equal((await call('POST', '/api/projects/999/messages', { text: 'x' })).status, 404, 'project must exist');

    // Field replies on own project; forced sender + own memberId.
    const reply = await call('POST', '/api/projects/101/messages', { text: 'Copy — forms are staged', memberId: 7 }, chloeToken);
    assert.equal(reply.status, 201, JSON.stringify(reply.data));
    assert.equal(reply.data.sender, 'field');
    assert.equal(reply.data.memberId, 7, 'field reply is attributed to the sender');
    assert.equal((await call('POST', '/api/projects/102/messages', { text: 'wrong job' }, chloeToken)).status, 403, 'field cannot message other projects');

    // Workspace scoping: broadcast + own-targeted only.
    const chloeState = await call('GET', '/api/state', undefined, chloeToken);
    assert.equal(chloeState.status, 200);
    const chloeMessages = chloeState.data.projectMessages || [];
    assert.equal(chloeMessages.length, 2, 'chloe sees broadcast + her own reply, not andi-targeted');
    assert.ok(chloeMessages.every(message => message.memberId == null || Number(message.memberId) === 7));
    const andiState = await call('GET', '/api/state', undefined, andiToken);
    const andiMessages = (andiState.data.projectMessages || []).map(message => Number(message.id)).sort();
    assert.deepEqual(andiMessages, [broadcast.data.id, targeted.data.id].sort(), 'andi sees broadcast + her targeted message, not chloe reply');

    // Office state carries the thread once the key exists.
    const officeState = await call('GET', '/api/state');
    assert.equal((officeState.data.projectMessages || []).length, 3, 'office sees the whole thread');

    // Read receipts: per-audience, no cross-reading.
    assert.equal((await call('POST', '/api/projects/102/messages/read', {}, chloeToken)).status, 403, 'field cannot mark read on other projects');
    assert.equal((await call('POST', '/api/projects/101/messages/read', {})).status, 200);
    assert.equal((await call('POST', '/api/projects/101/messages/read', {}, chloeToken)).status, 200);
    let stored = reload().projectMessages;
    const byId = Object.fromEntries(stored.map(message => [message.id, message]));
    assert.ok(byId[reply.data.id].readBy.includes('office'), 'office read marks field messages');
    assert.ok(!byId[reply.data.id].readBy.includes('m:7'), 'office read does not mark field messages for the crew');
    assert.ok(byId[broadcast.data.id].readBy.includes('m:7'), 'chloe read marks broadcast office messages');
    assert.ok(!byId[targeted.data.id].readBy.includes('m:7'), 'chloe read does not mark andi-targeted messages');
    await call('POST', '/api/projects/101/messages/read', {}, andiToken);
    stored = reload().projectMessages;
    assert.ok(stored.find(message => message.id === targeted.data.id).readBy.includes('m:8'), 'andi read marks her targeted messages');

    // Client contracts.
    const appJs = fs.readFileSync('app.js', 'utf8'), index = fs.readFileSync('index.html', 'utf8'), styles = fs.readFileSync('styles.css', 'utf8');
    for (const selector of ['id="messages-page"', 'id="msg-project"', 'id="msg-audience"', 'id="msg-new-text"', 'id="msg-send-new"', 'id="msg-warning"', 'id="msg-thread-list"', 'id="msg-thread-body"', 'id="msg-reply-text"', 'id="msg-send-reply"', 'id="message-count"', 'id="field-messages"']) assert.ok(index.includes(selector), 'messages markup: ' + selector);
    assert.ok(index.includes('data-page="messages"'), 'nav offers the Messages page');
    assert.ok(appJs.includes("projectMessages=(state.projectMessages||[]).filter(message=>messageVisible(message))"), 'state loads messages through current fixed scope');
    assert.ok(appJs.includes('function renderMessages'), 'thread list renderer exists');
    assert.ok(appJs.includes('function renderMessageThread'), 'conversation renderer exists');
    assert.ok(appJs.includes('function sendProjectMessage'), 'send helper exists');
    assert.ok(/async function sendFieldProjectMessage\(\)[\s\S]*?await sendProjectMessage\(projectId,memberId,text,\{form:fieldMessageForm/.test(appJs), 'field reply uses the send helper with its own captured form');
    assert.ok(appJs.includes("messages/read"), 'read receipts are wired');
    assert.ok(styles.includes('.msg-bubble'), 'bubbles are styled');
    assert.ok(styles.includes('.field-messages'), 'My Day messages card is styled');

    console.log('project-messages API + workspace scoping + client contracts: ok');
  } catch (error) { console.error('project-messages FAILED:', error.message); process.exitCode = 1; }
  finally { server.close(); }
})();
