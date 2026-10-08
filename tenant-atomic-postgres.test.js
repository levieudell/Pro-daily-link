'use strict';
// Only an explicitly supplied disposable localhost database is accepted.
// DATABASE_URL and every application/cloud credential are deliberately ignored.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { Pool } = require('pg');
const { fixture, companyA, companyB, token } = require('./fixtures/project-assistant');
const { TransactionalTenantRepository, splitSnapshot, assembleSnapshot, canonicalHash } = require('./database/transactional-repository');
const { createAdmission } = require('./database/tenant-admission');
const { loadConsistentSnapshot } = require('./database/tenant-consistent-read');
const { readJsonBody } = require('./json-request-body');

const rawUrl = process.env.PDL_ATOMIC_TEST_POSTGRES_URL;
if (!rawUrl) throw new Error('Explicit PDL_ATOMIC_TEST_POSTGRES_URL is required; PostgreSQL evidence cannot be skipped.');
const target = new URL(rawUrl);
if (process.env.PDL_ATOMIC_TEST_ALLOW_SCHEMA !== '1' || !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) || !/^\/pdl_atomic_synthetic[a-z0-9_]*$/.test(target.pathname) || target.search || target.hash) throw new Error('Only an explicitly authorized disposable localhost pdl_atomic_synthetic database is accepted.');
const pool = new Pool({ connectionString: rawUrl, max: 12, connectionTimeoutMillis: 5000 });
const repository = new TransactionalTenantRepository({ pool });
const children = [], temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-atomic-http-'));
const localFile = path.join(temp, 'db.json');
let bridge, bridgeBase, commits = 0, legacyRequests = 0;
const controls = { gate: null, readGate: null, dropAck: false, rejectCommit: false, providerMode: 'success', providerCompleted: false };
const providerEvents = [];
const photoObjects = new Map(), photoEvents = [];
function checkpoint() {
  let resolve; const promise = new Promise(done => { resolve = done; });
  return { promise, resolve, count: 0 };
}
const notePath = '/api/projects/101/notes-todos';
const newNote = text => ({ kind: 'note', text, requestId: crypto.randomUUID() });
const schedule = () => ({ memberId: 11, date: '2098-10-12', start: '08:00', end: '16:00', activity: 'Synthetic framing', instructions: 'Synthetic daily instructions', timezone: 'America/Los_Angeles' });

async function prepareDatabase() {
  // Refuse an existing schema. This suite never migrates or clears an existing DB.
  const existing = await pool.query("SELECT to_regclass('public.companies') AS name");
  assert.equal(existing.rows[0].name, null, 'Provide a fresh disposable database for each run');
  for (const role of ['anon', 'authenticated', 'service_role']) {
    if (!(await pool.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [role])).rowCount) await pool.query('CREATE ROLE ' + role);
  }
  for (const file of ['001_tenant_foundation.sql', '007_transactional_records.sql', '008_require_explicit_revision.sql', 'role-policy-commit.sql']) await pool.query(fs.readFileSync(path.join(__dirname, 'database', file), 'utf8'));
  const initial = fixture(), foreign = fixture(companyB);
  initial.emptySentinel = []; initial.nullSentinel = null;
  for (const role of ['crew', 'platform_owner']) {
    const id = initial.users.length + 1;
    initial.users.push({ id, companyId: companyA, name: 'Synthetic excluded role', email: role + '@example.invalid', role, status: 'Active', projectIds: [101], assignedCrews: ['A'], permissions: { scheduleCrews: true, aiAssistant: true, manageRoles: true } });
    initial.sessions.push({ userId: id, companyId: companyA, tokenHash: crypto.createHash('sha256').update(token(companyA, id)).digest('hex'), expiresAt: '2099-01-01T00:00:00Z' });
  }
  initial.largeSentinel = Array.from({ length: 1103 }, (_, id) => ({ id, label: 'Synthetic row ' + id }));
  fs.writeFileSync(localFile, JSON.stringify(initial));
  fs.writeFileSync(path.join(temp, 'platform.json'), JSON.stringify({ users: [], sessions: [] }));
  await repository.save(initial, 0); await repository.save(foreign, 0);
  assert.deepEqual((await repository.load(companyA)).snapshot, initial);
}
async function rpc(snapshot, revision, recordsOverride) {
  const packed = splitSnapshot(snapshot), records = packed.records.map(row => ({ collection: row.collection, record_key: row.recordKey, position: row.position, data: row.data }));
  return (await pool.query('SELECT * FROM replace_tenant_records($1,$2,$3,$4,$5)', [snapshot.company.id, revision, packed.scalarData, canonicalHash(snapshot), JSON.stringify(recordsOverride || records)])).rows[0];
}
async function startBridge() {
  bridge = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const send = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    try {
      if (req.method === 'GET' && url.pathname === '/storage/v1/bucket/project-photos') return send(200, { id: 'project-photos', public: controls.photoPublicBucket === true, file_size_limit: controls.photoSmallBucket ? 1 : 6000000, allowed_mime_types: ['image/jpeg', 'image/png', 'image/webp'] });
      if (url.pathname.startsWith('/storage/v1/object/project-photos/')) {
        const key = decodeURIComponent(url.pathname.slice('/storage/v1/object/project-photos/'.length));
        photoEvents.push({ method: req.method, key });
        assert.ok(key.startsWith(companyA + '/') || key.startsWith(companyB + '/'), 'Only synthetic tenant object keys are accepted');
        if (req.method === 'POST') {
          assert.equal(req.headers['x-upsert'], 'false'); const chunks = []; for await (const chunk of req) chunks.push(chunk); const bytes = Buffer.concat(chunks);
          if (controls.photoPutGate) { controls.photoPutGate.count++; await controls.photoPutGate.promise; }
          if (controls.photoRejectPut) return send(503, { message: 'Synthetic object rejection' });
          if (photoObjects.has(key)) return send(409, { message: 'Object already exists' });
          photoObjects.set(key, { bytes, type: req.headers['content-type'] }); if (controls.photoDropAck) return req.socket.destroy(); return send(200, { Key: key });
        }
        if (req.method === 'GET') {
          const stored = photoObjects.get(key); if (!stored || controls.photoMissingRead) return send(404, { message: 'Object not found' });
          if (controls.photoGetGate) { controls.photoGetGate.count++; await controls.photoGetGate.promise; }
          res.writeHead(200, { 'Content-Type': controls.photoWrongType ? 'application/pdf' : stored.type }); return res.end(controls.photoWrongBytes ? Buffer.from('Changed synthetic object') : stored.bytes);
        }
        assert.fail('Object deletion and arbitrary storage methods are forbidden');
      }
      const company = String(url.searchParams.get('company_id') || '').replace(/^eq\./, '');
      if (req.method === 'GET' && url.pathname === '/rest/v1/tenant_revisions') {
        if (controls.readGate && company === companyA) { const gate = controls.readGate; if (++gate.count === 3) await gate.promise; }
        return send(200, (await pool.query('SELECT revision, scalar_data, content_hash FROM tenant_revisions WHERE company_id=$1', [company])).rows);
      }
      if (req.method === 'GET' && url.pathname === '/rest/v1/tenant_records') return send(200, (await pool.query('SELECT collection,position,data FROM tenant_records WHERE company_id=$1 ORDER BY collection,position LIMIT $2 OFFSET $3', [company, Number(url.searchParams.get('limit')), Number(url.searchParams.get('offset'))])).rows);
      if (req.method === 'POST' && ['/rest/v1/rpc/replace_tenant_records', '/rest/v1/rpc/replace_tenant_policy_records'].includes(url.pathname)) {
        const chunks = [], collect = chunk => chunks.push(chunk); req.on('data', collect);
        const input = await readJsonBody(req); req.off('data', collect); commits++;
        const formerlyDecoded = chunks.map(chunk => chunk.toString('utf8')).join('');
        const former = JSON.parse(formerlyDecoded), formerHash = canonicalHash(assembleSnapshot(former.p_scalar_data, former.p_records));
        if (formerHash !== input.p_content_hash) console.error('SYNTHETIC_UTF8_DIAGNOSTIC=' + JSON.stringify({ revision: input.p_expected_revision, suppliedHash: input.p_content_hash, bufferedHash: canonicalHash(assembleSnapshot(input.p_scalar_data, input.p_records)), formerChunkHash: formerHash, differences: require('./fixtures/snapshot-wire-diagnostics').differences(input, former) }));
        if (controls.gate && (!controls.commitFilter || controls.commitFilter(url, input))) { const current = controls.gate; current.count++; if (current.count === current.expected) current.resolve(); await current.promise; }
        if (controls.rejectCommit) return send(400, { message: 'Synthetic commit rejected before SQL' });
        const policy = url.pathname.endsWith('replace_tenant_policy_records');
        const wireHash = canonicalHash(assembleSnapshot(input.p_scalar_data, input.p_records));
        assert.equal(wireHash, input.p_content_hash, 'Synthetic RPC bytes must preserve the exact submitted snapshot hash');
        const result = await pool.query(policy ? 'SELECT * FROM replace_tenant_policy_records($1,$2,$3,$4,$5,$6)' : 'SELECT * FROM replace_tenant_records($1,$2,$3,$4,$5)', [input.p_company_id, input.p_expected_revision, input.p_scalar_data, input.p_content_hash, JSON.stringify(input.p_records), ...(policy ? [input.p_policy_guard] : [])]);
        if (controls.dropAck) return req.socket.destroy();
        return send(200, result.rows);
      }
      if (req.method === 'POST' && url.pathname === '/synthetic-resend') {
        const email = await readJsonBody(req), current = await repository.load(companyA), key = req.headers['idempotency-key'];
        const job = current.snapshot.assignmentEmailOutbox.find(row => key === 'pdl-assignment/' + row.id);
        assert.ok(job, 'Only a durable fixed assignment email job may reach transport'); assert.equal(job.status, 'dispatching');
        assert.deepEqual(email.to, [job.payload.to]); assert.ok(email.html.includes(job.payload.projectName));
        assert.ok(job.assignmentIds.every(id => current.snapshot.assignments.some(row => row.id === id)));
        providerEvents.push({ key, assignmentId: job.assignmentIds[0] }); controls.providerCompleted = true;
        if (controls.providerMode === 'drop') return req.socket.destroy();
        return send(200, { id: 'synthetic-resend-id' });
      }
      legacyRequests++; return send(500, { message: 'Legacy or external effect forbidden' });
    } catch (error) { send(error.code === '40001' ? 409 : 400, { message: error.message }); }
  });
  await new Promise(resolve => bridge.listen(0, '127.0.0.1', resolve));
  bridgeBase = 'http://127.0.0.1:' + bridge.address().port;
}
async function startWorker({ dispatch = false } = {}) {
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (/^(SENTRY_|RESEND_|OPENAI_|STRIPE_|SUPABASE_|DATABASE_URL$|PDL_)/.test(name)) delete env[name];
  Object.assign(env, { PDL_DB_FILE: localFile, PDL_PLATFORM_FILE: path.join(temp, 'platform.json'), PDL_REQUIRE_AUTH: '1', PDL_SUPABASE_ENABLED: '1', PDL_TRANSACTIONAL_DB: 'primary', PDL_TENANT_ATOMIC: '1', SUPABASE_URL: bridgeBase, SUPABASE_SECRET_KEY: 'synthetic-only-atomic-stub', PDL_ASSISTANT_AI_ENABLED: '0', PDL_AUTH_FAIL_LIMIT: '3', RESEND_API_KEY: 'synthetic-localhost-only', PDL_ASSIGNMENT_OUTBOX_DISPATCH: dispatch ? '1' : '0' });
  const script = `const original=global.fetch;global.fetch=(url,options)=>{if(String(url)==='https://api.resend.com/emails')return original(${JSON.stringify(bridgeBase + '/synthetic-resend')},options);if(new URL(url).origin!==${JSON.stringify(bridgeBase)})throw Error('External network forbidden');return original(url,options)};const{server}=require('./server');server.listen(0,'127.0.0.1',()=>console.log('ATOMIC_PORT='+server.address().port));`;
  const child = spawn(process.execPath, ['-e', script], { cwd: __dirname, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  return new Promise((resolve, reject) => {
    let log = ''; const timeout = setTimeout(() => reject(Error('Worker start timeout: ' + log)), 15000);
    child.stdout.on('data', bytes => { log += bytes; const match = log.match(/ATOMIC_PORT=(\d+)/); if (match) { clearTimeout(timeout); resolve('http://127.0.0.1:' + match[1]); } });
    child.stderr.on('data', bytes => { log += bytes; });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', code => { clearTimeout(timeout); reject(Error('Worker exit ' + code + ': ' + log)); });
  });
}
async function request(base, method, url, input, user = 1, company = companyA, credentialCompany = companyA, credentialToken) {
  const response = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', 'X-PDL-Company': company, Authorization: 'Bearer ' + (credentialToken || token(credentialCompany, user)) }, ...(input === undefined ? {} : { body: JSON.stringify(input) }), signal: AbortSignal.timeout(15000) });
  return { status: response.status, headers: response.headers, data: response.headers.get('content-type')?.startsWith('text/csv') ? await response.text() : response.headers.get('content-type')?.startsWith('image/') ? Buffer.from(await response.arrayBuffer()) : await response.json() };
}
async function change(mutator, company = companyA) { const loaded = await repository.load(company); mutator(loaded.snapshot); await repository.save(loaded.snapshot, loaded.revision); }
async function waitFor(predicate) { const end = Date.now() + 10000; while (!predicate()) { if (Date.now() > end) throw Error('Synthetic barrier timeout'); await new Promise(resolve => setTimeout(resolve, 20)); } }
async function slowRequest(base, user, input, route = notePath, method = 'POST') {
  const bytes = JSON.stringify(input), address = new URL(base + route);
  let done;
  const result = new Promise((resolve, reject) => {
    const req = http.request(address, { method, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bytes), 'X-PDL-Company': companyA, Authorization: 'Bearer ' + token(companyA, user) } }, res => {
      readJsonBody(res).then(data => resolve({ status: res.statusCode, data }), reject);
    });
    req.on('error', reject); req.setTimeout(15000, () => req.destroy(Error('Slow-body timeout')));
    req.write(bytes.slice(0, -1)); done = () => req.end(bytes.slice(-1));
  });
  return { done, result };
}
async function main() {
  try {
    await prepareDatabase(); await startBridge();
    const load = company => loadConsistentSnapshot(company, async url => fetch(bridgeBase + url));
    assert.equal((await load(companyA)).snapshot.largeSentinel.length, 1103);
    const pristine = await repository.load(companyA);
    const firstCompany = '33333333-3333-4333-8333-333333333333';
    await pool.query('INSERT INTO companies(id,slug,name) VALUES($1,$2,$3)', [firstCompany, 'synthetic-first-writer', 'Synthetic first-materialization tenant']);
    const firstSnapshot = fixture(firstCompany), alternative = structuredClone(firstSnapshot); alternative.syntheticWinner = 'alternative';
    const firstRaces = await Promise.allSettled([rpc(firstSnapshot, 0), rpc(alternative, 0)]);
    assert.equal(firstRaces.filter(row => row.status === 'fulfilled').length, 1, 'Exactly one first writer materializes revision zero');
    assert.equal((await repository.load(firstCompany)).revision, 1);
    for (const bad of [null, -1, '9007199254740991']) {
      await assert.rejects(rpc(pristine.snapshot, bad), /PDL_EXPECTED_REVISION_REQUIRED/);
      assert.equal((await repository.load(companyA)).revision, pristine.revision);
    }
    // SQL exception after DELETE must roll back revision and all records.
    const duplicate = [{ collection: 'users', record_key: 'x', position: 0, data: {} }, { collection: 'users', record_key: 'x', position: 1, data: {} }];
    await assert.rejects(rpc(pristine.snapshot, pristine.revision, duplicate), /duplicate key/);
    assert.deepEqual(await repository.load(companyA), pristine);
    for (const role of ['anon', 'authenticated']) {
      const client = await pool.connect();
      try { await client.query('SET ROLE ' + role); await assert.rejects(client.query('SELECT * FROM replace_tenant_records($1,$2,$3,$4,$5)', [companyA, pristine.revision, {}, 'a'.repeat(64), '[]']), /permission denied/); }
      finally { await client.query('RESET ROLE'); client.release(); }
    }
    const first = structuredClone(pristine.snapshot), second = structuredClone(pristine.snapshot);
    first.syntheticWinner = 'first'; second.syntheticWinner = 'second';
    const races = await Promise.allSettled([rpc(first, pristine.revision), rpc(second, pristine.revision)]);
    assert.equal(races.filter(row => row.status === 'fulfilled').length, 1);
    assert.equal((await repository.load(companyA)).revision, pristine.revision + 1);
    const boundary = createAdmission({ load, commit: async (candidate, revision) => { const row = await rpc(candidate, revision); return { revision: Number(row.revision), contentHash: canonicalHash(candidate) }; }, mirror: async () => { throw Error('Synthetic mirror failure'); } });
    const candidate = await boundary.begin(companyA); boundary.stage(candidate, candidate.db);
    assert.equal((await boundary.finish(candidate)).mirrored, false);

    const bases = [await startWorker(), await startWorker()];
    const originalLocal = fs.readFileSync(localFile, 'utf8'), foreignBefore = await repository.load(companyB);
    const unsupported = [['POST', '/api/signup'], ['POST', '/api/billing/webhook'], ['POST', '/api/billing/checkout'], ['PATCH', '/api/platform/companies/x'], ['POST', '/api/auth/forgot'], ['POST', '/api/auth/email-verification/resend'], ['GET', '/api/action-center'], ['GET', '/api/state'], ['POST', '/api/company/logo'], ['DELETE', '/api/company/logo'], ['POST', '/api/guest/' + 'ab'.repeat(24)], ['POST', '/api/estimate-imports/analyze'], ['POST', '/api/daily-templates/generate'], ['GET', '/api/company/export'], ['POST', '/api/projects/101/assistant/chat'], ['POST', '/api/assistant/interpret']];
    const beforeUnsupported = commits;
    for (const [method, url] of unsupported) assert.equal((await request(bases[0], method, url, method === 'GET' ? undefined : {})).status, 503, url);
    assert.equal(commits, beforeUnsupported); assert.equal(legacyRequests, 0); assert.equal(fs.readFileSync(localFile, 'utf8'), originalLocal);
    assert.equal((await request(bases[0], 'POST', notePath, newNote('Foreign token cannot write'), 1, companyB)).status, 401);
    assert.equal((await request(bases[0], 'GET', '/api/projects/102/notes-todos', undefined, 2)).status, 404);
    assert.equal((await request(bases[0], 'PATCH', '/api/users/2', { role: 'owner' }, 2)).status, 403);
    assert.equal((await request(bases[0], 'PATCH', '/api/users/2', { role: 'owner' }, 1)).status, 400);
    assert.equal((await request(bases[0], 'PATCH', '/api/users/1', { status: 'Deactivated', role: 'field' }, 1)).status, 200);
    assert.equal((await repository.load(companyA)).snapshot.users.find(row => row.id === 1).role, 'owner');

    // Two real workers share PostgreSQL, without sharing their JS request queue.
    const beforeRace = await repository.load(companyA), a = newNote('Atomic candidate A'), b = newNote('Atomic candidate B');
    controls.gate = checkpoint(); controls.gate.expected = 99;
    let responsesSent = 0;
    const pendingResponses = [request(bases[0], 'POST', notePath, a), request(bases[1], 'POST', notePath, b)].map(promise => promise.then(value => { responsesSent++; return value; }));
    await waitFor(() => controls.gate.count === 2);
    assert.equal(responsesSent, 0, 'No successful or conflict response is sent before SQL CAS');
    assert.equal((await repository.load(companyA)).revision, beforeRace.revision);
    controls.gate.resolve(); const outputs = await Promise.all(pendingResponses); controls.gate = null;
    assert.deepEqual(outputs.map(row => row.status).sort(), [201, 409]);
    const raceAfter = await repository.load(companyA); assert.equal(raceAfter.revision, beforeRace.revision + 1);
    assert.equal(raceAfter.snapshot.projectNotesTodos.length, 1);
    const winnerIndex = outputs.findIndex(row => row.status === 201), winnerInput = [a, b][winnerIndex];
    const mirror = JSON.parse(fs.readFileSync(path.join(temp, '.atomic-mirrors', companyA + '.json')));
    assert.equal(canonicalHash(mirror), raceAfter.contentHash); assert.equal(fs.readFileSync(localFile, 'utf8'), originalLocal);
    assert.equal((await request(bases[1 - winnerIndex], 'POST', notePath, winnerInput)).status, 200);
    assert.equal((await repository.load(companyA)).revision, raceAfter.revision);

    // Revocation after admission but before SQL commit invalidates the candidate.
    controls.gate = checkpoint(); controls.gate.expected = 99;
    const inflight = request(bases[0], 'POST', notePath, newNote('Revoked inflight write'), 2);
    await waitFor(() => controls.gate.count === 1);
    await change(db => { db.users.find(row => row.id === 2).projectIds = []; });
    controls.gate.resolve(); const deniedInflight = await inflight; controls.gate = null;
    assert.equal(deniedInflight.status, 409);
    assert.equal((await request(bases[1], 'POST', notePath, newNote('Stale client grant'), 2)).status, 404);
    assert.equal((await repository.load(companyA)).snapshot.projectNotesTodos.length, 1);
    await change(db => { db.users.find(row => row.id === 2).projectIds = [101]; });
    const slow = await slowRequest(bases[0], 2, newNote('Revoked while receiving input'));
    await change(db => { db.users.find(row => row.id === 2).status = 'Deactivated'; }); slow.done();
    assert.equal((await slow.result).status, 401);
    await change(db => { db.users.find(row => row.id === 2).status = 'Active'; });

    // Manual assistant remains in the fixed pilot with fixed eligible roles.
    for (const roleUser of [4, 5, 8, 9]) assert.equal((await request(bases[0], 'POST', '/api/projects/101/assistant/preview', schedule(), roleUser)).status, 403);
    assert.equal((await request(bases[0], 'POST', '/api/projects/101/assistant/preview', schedule(), 1, companyB, companyB)).status, 403);
    assert.equal((await request(bases[0], 'POST', '/api/projects/101/assistant/preview', { ...schedule(), memberId: 13 }, 2)).status, 403);
    const preview = await request(bases[0], 'POST', '/api/projects/101/assistant/preview', schedule(), 2); assert.equal(preview.status, 200, JSON.stringify(preview.data));
    const access = await request(bases[1], 'PATCH', '/api/users/2', { permissions: { scheduleCrews: false }, projectIds: [101], assignedCrews: ['A'] }); assert.equal(access.status, 200);
    assert.equal((await request(bases[0], 'POST', '/api/projects/101/assistant/confirm', { token: preview.data.token, version: preview.data.version, confirmed: true }, 2)).status, 403);
    assert.equal((await repository.load(companyA)).snapshot.assignments.length, 0);
    await request(bases[1], 'PATCH', '/api/users/2', { permissions: { scheduleCrews: true }, projectIds: [101], assignedCrews: ['A'] });
    const freshPreview = await request(bases[0], 'POST', '/api/projects/101/assistant/preview', schedule(), 2);
    const confirmation = { token: freshPreview.data.token, version: freshPreview.data.version, confirmed: true };
    assert.equal((await request(bases[0], 'POST', '/api/projects/101/assistant/confirm', confirmation, 2)).status, 201);
    assert.equal((await request(bases[0], 'POST', '/api/projects/101/assistant/confirm', confirmation, 2)).status, 200);
    assert.equal((await repository.load(companyA)).snapshot.assignments.length, 1);
    await change(db => { db.users.find(row => row.id === 2).role = 'field'; });
    assert.equal((await request(bases[0], 'POST', '/api/projects/101/assistant/confirm', confirmation, 2)).status, 403);

    const mirrorDirectory = path.join(temp, '.atomic-mirrors'), heldMirror = path.join(temp, 'held-mirror');
    fs.renameSync(mirrorDirectory, heldMirror); fs.writeFileSync(mirrorDirectory, 'Synthetic mirror unavailable');
    const degraded = await request(bases[1], 'POST', notePath, newNote('Committed with unavailable mirror'));
    assert.equal(degraded.status, 201); assert.equal(degraded.headers.get('x-pdl-mirror-status'), 'degraded');
    fs.unlinkSync(mirrorDirectory); fs.renameSync(heldMirror, mirrorDirectory);
    const beforeRejection = await repository.load(companyA), mirrorBytes = fs.readFileSync(path.join(temp, '.atomic-mirrors', companyA + '.json'));
    controls.rejectCommit = true;
    assert.equal((await request(bases[1], 'POST', notePath, newNote('Rejected commit'))).status, 503); controls.rejectCommit = false;
    assert.deepEqual(await repository.load(companyA), beforeRejection);
    assert.deepEqual(fs.readFileSync(path.join(temp, '.atomic-mirrors', companyA + '.json')), mirrorBytes);
    controls.dropAck = true; const uncertainInput = newNote('Commit acknowledged by replay');
    const uncertain = await request(bases[1], 'POST', notePath, uncertainInput); controls.dropAck = false;
    assert.equal(uncertain.status, 503); assert.equal(uncertain.data.code, 'COMMIT_OUTCOME_UNKNOWN');
    const afterUnknown = await repository.load(companyA); assert.equal(afterUnknown.revision, beforeRejection.revision + 1);
    assert.deepEqual(fs.readFileSync(path.join(temp, '.atomic-mirrors', companyA + '.json')), mirrorBytes);
    assert.equal((await request(bases[0], 'POST', notePath, uncertainInput)).status, 200);
    assert.equal((await repository.load(companyA)).revision, afterUnknown.revision);
    await pool.query('UPDATE tenant_revisions SET content_hash=$1 WHERE company_id=$2', ['f'.repeat(64), companyA]);
    assert.equal((await request(bases[0], 'GET', notePath)).status, 503, 'Corrupt authority cannot fall back to the stale local file');
    await pool.query('UPDATE tenant_revisions SET content_hash=$1 WHERE company_id=$2', [afterUnknown.contentHash, companyA]);
    await require('./scheduling-postgres-cases')({ repository, change, request, slowRequest, bases, startWorker, checkpoint, waitFor, controls, providerEvents });
    await require('./time-off-postgres-cases')({ repository, change, request, slowRequest, bases, checkpoint, waitFor, controls, providerEvents });
    await require('./time-review-postgres-cases')({ repository, change, request, slowRequest, bases, checkpoint, waitFor, controls, providerEvents });
    await require('./time-write-postgres-cases')({ repository, change, request, slowRequest, bases, startWorker, checkpoint, waitFor, controls, providerEvents });
    await require('./daily-postgres-cases')({ repository, change, request, slowRequest, bases, startWorker, checkpoint, waitFor, controls, providerEvents });
    await require('./photo-postgres-cases')({ repository, change, request, slowRequest, bases, startWorker, checkpoint, waitFor, controls, providerEvents, photoObjects, photoEvents });
    await require('./notes-postgres-cases')({ repository, change, request, slowRequest, bases, checkpoint, waitFor, controls, providerEvents });
    await require('./registry-postgres-cases')({ repository, change, request, bases, checkpoint, waitFor, controls, providerEvents });
    await require('./role-policy-postgres-cases')({ repository, change, request, slowRequest, bases, startWorker, checkpoint, waitFor, controls, providerEvents, pool });
    await require('./navigation-postgres-cases')({ repository, change, request, bases, checkpoint, waitFor, controls, providerEvents });
    if (process.env.PDL_ROLES_BROWSER_TESTS === '1') await require('./roles-browser-postgres-cases')({ repository, change, request, bases, providerEvents });
    for (let attempt = 0; attempt < 3; attempt++) assert.equal((await request(bases[0], 'POST', '/api/auth/login', { email: 'user1@example.invalid', password: 'invalid-synthetic-password' })).status, 401);
    assert.equal((await request(bases[0], 'POST', '/api/auth/login', { email: 'user1@example.invalid', password: 'invalid-synthetic-password' })).status, 429, 'Atomic failed logins retain the credential lockout');
    assert.deepEqual(await repository.load(companyB), foreignBefore);
    assert.equal(legacyRequests, 0); assert.equal(fs.readFileSync(localFile, 'utf8'), originalLocal);
    console.log('Synthetic PostgreSQL and two-worker HTTP: pagination/empty collections, mandatory SQL CAS, races/rollback, stale actor/slow body/inflight revocation, owner protection, IDOR, assistant pilot/replay, rejected effects and lost acknowledgement passed.');
  } finally {
    controls.gate?.resolve();
    controls.readGate?.resolve();
    controls.photoPutGate?.resolve(); controls.photoGetGate?.resolve();
    await Promise.all(children.map(async child => { if (child.exitCode == null) { const ended = once(child, 'exit'); child.kill(); await ended; } }));
    if (bridge) { bridge.closeAllConnections(); await new Promise(resolve => bridge.close(resolve)); }
    await pool.end();
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
