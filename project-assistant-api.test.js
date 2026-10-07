'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn } = require('node:child_process'), { once } = require('node:events');
const { companyA, companyB, fixture, token } = require('./fixtures/project-assistant');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-assistant-api-')), dbFile = path.join(temp, 'db.json');
fs.mkdirSync(path.join(temp, 'tenants')); fs.writeFileSync(dbFile, JSON.stringify(fixture())); fs.writeFileSync(path.join(temp, 'tenants', companyB + '.json'), JSON.stringify(fixture(companyB))); fs.writeFileSync(path.join(temp, 'platform.json'), JSON.stringify({ users: [], sessions: [] }));
let child, base;
async function start() {
  const env = { ...process.env, PDL_DB_FILE: dbFile, PDL_PLATFORM_FILE: path.join(temp, 'platform.json'), PDL_REQUIRE_AUTH: '1', PDL_SUPABASE_ENABLED: '0', PDL_TRANSACTIONAL_DB: 'off', OPENAI_API_KEY: 'synthetic', PDL_EMAIL_DEV_MODE: '1' };
  for (const key of ['SENTRY_DSN', 'RESEND_API_KEY', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'DATABASE_URL']) delete env[key];
  const script = `global.fetch=async(url,options)=>{if(url!=='https://api.openai.com/v1/responses')throw Error('External network forbidden in synthetic tests');const data=JSON.parse(options.body);if(data.store!==false||data.tools)throw Error('Unsafe provider contract');if(data.input.includes('Private synthetic site')||data.input.includes('Private member'))throw Error('Overbroad AI context');if(data.input.includes('slow-test'))await new Promise(resolve=>setTimeout(resolve,1200));return{ok:true,json:async()=>({output_text:JSON.stringify({memberName:'Jordan Sample',date:null,start:null,end:null,activity:null,instructions:null})})}};const{server}=require('./server');server.listen(0,'127.0.0.1',()=>console.log('ASSISTANT_PORT='+server.address().port));`;
  child = spawn(process.execPath, ['-e', script], { cwd: __dirname, env, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => { let log = ''; const timeout = setTimeout(() => reject(Error(log)), 15000); child.stdout.on('data', bytes => { log += bytes; const match = log.match(/ASSISTANT_PORT=(\d+)/); if (match) { base = 'http://127.0.0.1:' + match[1]; clearTimeout(timeout); resolve(); } }); child.stderr.on('data', bytes => { log += bytes; }); child.once('error', reject); child.once('exit', code => { clearTimeout(timeout); reject(Error('Synthetic server exited ' + code + ': ' + log)); }); });
}
async function stop() { if (!child || child.exitCode != null) return; const exited = once(child, 'exit'); child.kill(); await exited; child = null; }
async function request(action, input, user = 2, project = 101, companyId = companyA, rawPath) {
  const response = await fetch(base + (rawPath || `/api/projects/${project}/assistant/${action}`), { method: input ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', 'X-PDL-Company': companyId, ...(user == null ? {} : { Authorization: 'Bearer ' + token(companyA, user) }) }, ...(input ? { body: JSON.stringify(input) } : {}) });
  return { status: response.status, data: await response.json() };
}
const input = () => ({ memberId: 11, date: '2098-10-12', start: '08:00', end: '16:00', activity: 'Frame west wall', instructions: '<img src=x onerror=alert(1)> stored as plain text', timezone: 'America/Los_Angeles' });
async function main() {
  try {
    await start(); const initial = fs.readFileSync(dbFile, 'utf8');
    assert.equal((await request('context')).status, 200); assert.equal((await request('context', null, null)).status, 401);
    for (const user of [4, 5]) assert.equal((await request('context', null, user)).status, 403);
    assert.equal((await request('context', null, 6)).status, 200); assert.equal((await request('preview', input(), 6)).status, 403); assert.equal((await request('context', null, 2, 102)).status, 404); assert.equal((await request('context', null, 2, 101, companyB)).status, 401);
    const chat = await request('chat', { text: 'Schedule Jordan Sample tomorrow' }); assert.equal(chat.status, 200); assert.equal(chat.data.draft.memberId, undefined); assert.match(chat.data.message, /More than one person/);
    const preview = await request('preview', input()); assert.equal(preview.status, 200); assert.ok(preview.data.token); assert.equal(fs.readFileSync(dbFile, 'utf8'), initial, 'HTTP chat/context/preview have no database side effects');
    const otherUser = await request('confirm', { token: preview.data.token, version: preview.data.version, confirmed: true }, 1); assert.equal(otherUser.status, 409);
    const original = { token: preview.data.token, version: preview.data.version, confirmed: true }, second = (await request('preview', input())).data;
    const revoked = JSON.parse(initial); revoked.users.find(row => row.id === 2).permissions.scheduleCrews = false; fs.writeFileSync(dbFile, JSON.stringify(revoked));
    assert.equal((await request('confirm', original)).status, 403, 'fresh request permissions override preview authority'); assert.equal(JSON.parse(fs.readFileSync(dbFile)).assignments.length, 0);
    fs.writeFileSync(dbFile, initial);
    const confirmed = await Promise.all([request('confirm', original), request('confirm', original)]); assert.deepEqual(confirmed.map(row => row.status).sort(), [200, 201]); assert.equal(JSON.parse(fs.readFileSync(dbFile)).assignments.length, 1);
    assert.equal((await request('confirm', { token: second.token, version: second.version, confirmed: true })).status, 409);
    const snapshot = JSON.parse(fs.readFileSync(dbFile)); assert.equal(snapshot.assignments[0].instructions, input().instructions); assert.equal(snapshot.assistantConfirmations.length, 1);
    await stop(); await start(); const replayBytes = fs.readFileSync(dbFile, 'utf8'); assert.equal((await request('confirm', original)).status, 200); assert.equal(fs.readFileSync(dbFile, 'utf8'), replayBytes, 'restart replay does not write or notify again');
    const modified = JSON.parse(replayBytes); modified.users.find(row => row.id === 2).permissions.scheduleCrews = false; fs.writeFileSync(dbFile, JSON.stringify(modified)); assert.equal((await request('confirm', original)).status, 403); modified.users.find(row => row.id === 2).permissions.scheduleCrews = true; fs.writeFileSync(dbFile, JSON.stringify(modified));
    // The slow provider must not hold the tenant save queue. Existing manual
    // scheduling continues with synthetic data while the AI request is running.
    let chatDone = false; const pending = request('chat', { text: 'slow-test Jordan Sample' }).then(result => { chatDone = true; return result; });
    await new Promise(resolve => setTimeout(resolve, 150));
    const manual = await request(null, { projectId: 101, memberIds: [12], date: '2098-10-14', start: '08:00', end: '12:00', activity: 'Manual schedule' }, 2, 101, companyA, '/api/assignments'); assert.equal(manual.status, 201); assert.equal(chatDone, false, 'manual scheduling remains responsive during AI latency'); assert.equal((await pending).status, 200);
    const state = JSON.parse(fs.readFileSync(dbFile)); assert.equal(state.assignments.length, 2); assert.equal(state.assignments[1].activity, 'Manual schedule');
    const noteInput = { action: 'note', text: "Gate locked midnight–6am; can't arrive earlier.", deadline: 'none', dueDate: '', timezone: 'America/Los_Angeles' };
    const noteBytes = fs.readFileSync(dbFile, 'utf8'), note = (await request('preview', noteInput, 6)).data; assert.ok(note.token); assert.equal(fs.readFileSync(dbFile, 'utf8'), noteBytes);
    const noteConfirmation = { token: note.token, version: note.version, confirmed: true }, savedNote = await request('confirm', noteConfirmation, 6); assert.equal(savedNote.status, 201); assert.equal(savedNote.data.kind, 'note'); assert.equal((await request('confirm', noteConfirmation, 6)).status, 200);
    const visible = await request(null, null, 4, 101, companyA, '/api/projects/101/notes-todos'); assert.equal(visible.status, 200); assert.equal(visible.data.items[0].text, noteInput.text); assert.equal((await request('preview', noteInput, 4)).status, 403, 'crew can read existing project notes but cannot use assistant');
    const todoInput = { action: 'todo', text: 'Pick up the green plastic pieces before anyone leaves today.', deadline: 'today', dueDate: '', timezone: 'America/Los_Angeles' }, todo = (await request('preview', todoInput, 6)).data;
    assert.ok(todo.token); assert.match(todo.proposal.dueDate, /^\d{4}-\d{2}-\d{2}$/); assert.equal(todo.proposal.assignee, 'Unassigned');
    const todoConfirmation = { token: todo.token, version: todo.version, confirmed: true }; assert.equal((await request('confirm', todoConfirmation, 6)).status, 201);
    const resourceBytes = fs.readFileSync(dbFile, 'utf8'); assert.equal(JSON.parse(resourceBytes).projectNotesTodos.length, 2); await stop(); await start(); assert.equal((await request('confirm', todoConfirmation, 6)).status, 200); assert.equal(fs.readFileSync(dbFile, 'utf8'), resourceBytes, 'to-do restart retry cannot duplicate');
    const unicode = (await request('preview', { ...noteInput, text: '界'.repeat(5000) }, 6)).data; assert.ok(unicode.token.length > 18000); const unicodeConfirmation = { token: unicode.token, version: unicode.version, confirmed: true }; assert.equal((await request('confirm', unicodeConfirmation, 6)).status, 201); const unicodeBytes = fs.readFileSync(dbFile, 'utf8'); await stop(); await start(); assert.equal((await request('confirm', unicodeConfirmation, 6)).status, 200); assert.equal(fs.readFileSync(dbFile, 'utf8'), unicodeBytes, 'full-length Unicode receipt is replayable after restart');
    const batchInput = { action: 'schedule_batch', memberIds: [11,12], startDate: '2098-12-30', endDate: '2099-01-03', weekdays: [0,1,2,3,4,5,6], start: '08:00', end: '16:00', activity: 'Batch framing', instructions: 'Start west wall each day.', timezone: 'America/Los_Angeles' };
    const beforeBatch = fs.readFileSync(dbFile,'utf8'), batchPreview = (await request('preview',batchInput)).data; assert.ok(batchPreview.token); assert.equal(batchPreview.proposal.personDays,10); assert.equal(fs.readFileSync(dbFile,'utf8'),beforeBatch);
    const batchConfirmed = { token: batchPreview.token, version: batchPreview.version, confirmed: true };
    const denied = JSON.parse(beforeBatch); denied.team.find(row=>row.id===12).crew='B'; fs.writeFileSync(dbFile,JSON.stringify(denied)); assert.equal((await request('confirm',batchConfirmed)).status,403); assert.equal(JSON.parse(fs.readFileSync(dbFile)).assignments.length,2); fs.writeFileSync(dbFile,beforeBatch);
    const staleBatch = (await request('preview',batchInput)).data;
    denied.team.find(row=>row.id===12).crew='A'; denied.timeOffRequests.push({memberId:12,status:'approved',startDate:'2099-01-03',endDate:'2099-01-03'}); fs.writeFileSync(dbFile,JSON.stringify(denied));
    const blockedBatch = (await request('preview',batchInput)).data; assert.equal(blockedBatch.token,null); assert.equal(blockedBatch.conflicts[0].memberId,12); assert.equal((await request('confirm',batchConfirmed)).status,409); assert.equal(JSON.parse(fs.readFileSync(dbFile)).assignments.length,2); fs.writeFileSync(dbFile,beforeBatch);
    const batchSaved = await Promise.all([request('confirm',batchConfirmed),request('confirm',batchConfirmed)]); assert.deepEqual(batchSaved.map(row=>row.status).sort(),[200,201]); assert.deepEqual(batchSaved[0].data.assignmentIds,batchSaved[1].data.assignmentIds); assert.equal(batchSaved[0].data.assignmentIds.length,5);
    assert.equal((await request(null,null,1,101,companyA,'/api/state')).data.assistantConfirmations,undefined,'confirmation receipts are server-private even in owner workspace');
    const completeBatch = fs.readFileSync(dbFile,'utf8'), batchRows = JSON.parse(completeBatch).assignments.slice(2); assert.equal(batchRows.length,5); assert.equal(new Set(batchRows.map(row=>row.id)).size,5); assert.ok(batchRows.every(row=>row.memberIds.length===2&&Object.values(row.notifications).every(n=>n.emailStatus==='not_available')));
    assert.equal((await request('confirm',{token:staleBatch.token,version:staleBatch.version,confirmed:true})).status,409);
    await stop(); await start(); const restartedBatch = await request('confirm',batchConfirmed); assert.equal(restartedBatch.status,200); assert.deepEqual(restartedBatch.data.assignmentIds,batchSaved[0].data.assignmentIds); assert.equal(fs.readFileSync(dbFile,'utf8'),completeBatch);
    const replayDenied=JSON.parse(completeBatch); replayDenied.team.find(row=>row.id===12).status='Inactive';fs.writeFileSync(dbFile,JSON.stringify(replayDenied));assert.equal((await request('confirm',batchConfirmed)).status,403);fs.writeFileSync(dbFile,completeBatch);
    const body = await fetch(base + '/project-assistant.js'); assert.equal(body.status, 404); assert.equal((await fetch(base + '/project-assistant-ui.js')).status, 200); assert.equal((await fetch(base + '/project-assistant-voice.js')).status,200); for(const file of ['project-assistant-batch.js','project-assistant-batch-proposal.js'])assert.equal((await fetch(base+'/'+file)).status,404);
    console.log('Project assistant isolated HTTP tests passed: multi-tenant auth, PM scope, mocked AI, no chat/preview writes, duplicate/concurrent save, cross-tab stale, restart receipt, role revocation, responsive manual scheduling and private server module.');
  } finally { await stop(); fs.rmSync(temp, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
