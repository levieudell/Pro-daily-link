'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto'), { fork } = require('node:child_process');
const { workspaceSnapshot } = require('./compat-workspace-fixture'), { A, credential, initial } = require('./compat-account-fixture');
const { PLATFORM_ID, PLATFORM_NAME } = require('./database/platform-snapshot-repository');
const { canonicalHash } = require('./database/transactional-repository');
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const bounded = pending => Promise.race([pending, new Promise((_, reject) => { const timer = setTimeout(() => reject(Error('Owned synthetic worker deadline.')), 15000); timer.unref(); })]);
const managedHelp = { id: 'pdl-help-19', title: 'Synthetic authoritative help', type: 'article', audience: 'all', category: 'Synthetic', summary: 'Shared source', content: 'Only current shared source.', status: 'Published', order: 1 };
let platform, tenant, platformRevision = 0, tenantRevision = 0, managed = true, hook = null, oldWrites = 0, transportCalls = 0, requests = 0, nativeClaim = null;
const platformToken = crypto.randomBytes(32).toString('base64url'), issuerToken = crypto.randomBytes(32).toString('base64url'), tenantToken = crypto.randomBytes(32).toString('base64url'), supportToken = crypto.randomBytes(32).toString('base64url');
const session = (userId, token, companyId) => ({ id: crypto.randomUUID(), ...(companyId ? { companyId } : {}), userId, tokenHash: digest(token), createdAt: new Date().toISOString(), expiresAt: '2099-01-01T00:00:00.000Z' });
function seed() {
  tenant = workspaceSnapshot(); tenant.team[0].crew = 'Office'; tenant.sessions.push(session(1, tenantToken, A));
  platform = { company: { id: PLATFORM_ID, name: PLATFORM_NAME }, platform: { users: [{ id: 1, name: 'Synthetic Platform Owner', email: 'platform@example.invalid', role: 'platform_owner', status: 'Active', ...credential(initial) }, { id: 2, name: 'Synthetic Revocable Issuer', email: 'issuer@example.invalid', role: 'support', status: 'Active', ...credential(initial) }], sessions: [session(1, platformToken), session(2, issuerToken)], notes: [], auditEvents: [], helpItems: [managedHelp], supportGrants: [{ id: crypto.randomUUID(), companyId: A, companyName: 'Synthetic private company', actorUserId: 2, actorName: 'Synthetic Revocable Issuer', reason: 'Synthetic support only', status: 'Active', tokenHash: digest(supportToken), createdAt: new Date().toISOString(), expiresAt: '2099-01-01T00:00:00.000Z' }] } };
}
seed();
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-platform-multiworker-')), children = [], files = [], journeys = [];
const policyKey = crypto.randomBytes(32).toString('hex');
function row(id) { return id === PLATFORM_ID ? { id, data: structuredClone(platform), platform_revision: platformRevision, platform_managed: managed, roles_managed: false } : id === A ? { id, data: structuredClone(tenant), roles_revision: tenantRevision, roles_managed: managed, platform_managed: false } : null; }
function conflict() { throw Object.assign(Error('PDL_REVISION_CONFLICT'), { code: '40001' }); }
function changePlatform(change) { change(platform.platform); platformRevision++; }
function changeTenant(change) { change(tenant); tenantRevision++; }
function hold(predicate, count = 1) {
  assert.equal(hook, null); let signal;
  const entries = [], ready = new Promise(resolve => { signal = resolve; });
  hook = async event => {
    if (!predicate(event) || entries.length >= count) return;
    let release; const wait = new Promise(resolve => { release = resolve; }); entries.push({ event, release }); if (entries.length === count) signal(); await wait;
  };
  return { ready: bounded(ready), entries, release() { for (const entry of entries) entry.release(); hook = null; } };
}
async function transport(worker, kind, details) {
  transportCalls++;
  if (kind === 'request') {
    assert.deepEqual(Object.keys(details).sort(), details.body === undefined ? ['method', 'relative'] : ['body', 'method', 'relative']);
    const url = new URL('http://synthetic.invalid' + details.relative);
    if (url.pathname === '/rest/v1/rpc/platform_snapshot_trigger_contract') { assert.equal(details.method, 'POST'); assert.equal(details.body, '{}'); return nativeClaim?.active ? (await nativeClaim.admin.query('SELECT public.platform_snapshot_trigger_contract() AS ready')).rows[0].ready : true; }
    if (url.pathname === '/rest/v1/companies' && details.method === 'GET') {
      const id = url.searchParams.get('id')?.slice(3); assert.ok([A, PLATFORM_ID].includes(id)); assert.equal(url.searchParams.get('limit'), '1');
      assert.ok(['*', 'data,roles_revision,roles_managed', 'id,data,platform_revision,platform_managed,roles_managed'].includes(url.searchParams.get('select')));
      assert.ok([...url.searchParams.keys()].every(key => ['id', 'select', 'limit'].includes(key)));
      const value = nativeClaim?.active && id === PLATFORM_ID ? (await nativeClaim.admin.query('SELECT id,data,platform_revision,platform_managed,roles_managed FROM public.companies WHERE id=$1', [PLATFORM_ID])).rows[0] : row(id), captured = value ? [value] : [];
      if (hook) await hook({ worker, kind: id === PLATFORM_ID ? 'platform-read' : 'tenant-read', captured }); return captured;
    }
    assert.equal(details.method, 'POST'); const input = JSON.parse(details.body);
    if (url.pathname === '/rest/v1/rpc/commit_platform_snapshot') {
      assert.deepEqual(Object.keys(input).sort(), ['p_deadline', 'p_expected_revision', 'p_platform_id', 'p_snapshot']);
      if (hook) await hook({ worker, kind: 'platform-commit', input });
      if (nativeClaim?.active) {
        nativeClaim.lastCommit = structuredClone(input);
        const result = await nativeClaim.writer.query('SELECT * FROM public.commit_platform_snapshot($1,$2,$3,$4)', [input.p_platform_id, input.p_expected_revision, input.p_snapshot, input.p_deadline]);
        const current = (await nativeClaim.admin.query('SELECT data,platform_revision FROM public.companies WHERE id=$1', [PLATFORM_ID])).rows[0]; platform = current.data; platformRevision = Number(current.platform_revision); return result.rows;
      }
      assert.equal(input.p_platform_id, PLATFORM_ID); if (!managed || input.p_expected_revision !== platformRevision || Date.parse(input.p_deadline) <= Date.now()) conflict();
      assert.equal(input.p_snapshot.company.id, PLATFORM_ID); platform = structuredClone(input.p_snapshot); platformRevision++; return [{ revision: platformRevision }];
    }
    assert.ok(['/rest/v1/rpc/commit_roles_snapshot', '/rest/v1/rpc/commit_roles_snapshot_with_platform'].includes(url.pathname));
    const cross = url.pathname.endsWith('_with_platform');
    assert.deepEqual(Object.keys(input).sort(), ['p_company_id', 'p_deadline', 'p_expected_revision', 'p_snapshot', ...(cross ? ['p_platform_expected_revision', 'p_platform_id'] : [])].sort());
    if (hook) await hook({ worker, kind: cross ? 'cross-commit' : 'tenant-commit', input });
    assert.equal(input.p_company_id, A); if (!managed || input.p_expected_revision !== tenantRevision || Date.parse(input.p_deadline) <= Date.now() || cross && (input.p_platform_id !== PLATFORM_ID || input.p_platform_expected_revision !== platformRevision)) conflict();
    tenant = structuredClone(input.p_snapshot); tenantRevision++; return [{ revision: tenantRevision }];
  }
  if (kind === 'snapshot') { assert.ok([A, PLATFORM_ID].includes(details.id)); return structuredClone(details.id === A ? tenant : platform); }
  if (kind === 'list') { assert.deepEqual(details, {}); return [structuredClone(tenant), structuredClone(platform)]; }
  assert.equal(kind, 'legacy-save'); assert.equal(managed, false, 'Managed source must never use the full legacy writer'); oldWrites++; assert.ok([A, PLATFORM_ID].includes(details.snapshot.company.id));
  if (details.snapshot.company.id === PLATFORM_ID) platform = structuredClone(details.snapshot); else tenant = structuredClone(details.snapshot); return true;
}
async function worker(index, flag = true) {
  const own = path.join(directory, 'worker-' + index); fs.mkdirSync(own); const stale = structuredClone(platform.platform); stale.helpItems = [{ ...managedHelp, title: 'Stale local help must never return' }]; stale.users.push({ id: 999, name: 'Stale restored actor', role: 'platform_owner', status: 'Active' });
  const tenantFile = path.join(own, 'tenant.json'), platformFile = path.join(own, 'platform.json'); fs.writeFileSync(tenantFile, JSON.stringify(tenant)); fs.writeFileSync(platformFile, JSON.stringify(flag ? stale : platform.platform));
  const bootstrap = path.join(own, 'bootstrap.json'); fs.writeFileSync(bootstrap, JSON.stringify({ companyId: A, policyKey, managed: flag })); files.push({ tenantFile, platformFile, hashes: [digest(fs.readFileSync(tenantFile)), digest(fs.readFileSync(platformFile))], managed: flag });
  const child = fork(path.join(__dirname, 'roles-platform-http-worker.test.cjs'), [], { env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP, NODE_PATH: process.env.NODE_PATH, PDL_PLATFORM_WORKER_BOOTSTRAP: bootstrap }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
  const output = []; child.stdout.on('data', bytes => output.push(String(bytes))); child.stderr.on('data', bytes => output.push(String(bytes)));
  children.push(child); const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal }))); child.ownedExit = exited;
  const ready = new Promise((resolve, reject) => {
    child.on('message', message => {
      if (message?.type === 'ready') { assert.equal(message.pid, child.pid); assert.match(message.origin, /^http:\/\/127\.0\.0\.1:\d+$/); resolve({ child, origin: message.origin, index }); }
      if (message?.type === 'transport') transport(index, message.kind, message.details).then(value => child.connected && child.send({ type: 'transport-result', id: message.id, value }), error => child.connected && child.send({ type: 'transport-result', id: message.id, error: { message: error.message, code: error.code } }));
    });
    child.once('error', reject); exited.then(result => reject(Error('Owned worker exited before readiness: ' + JSON.stringify(result) + '\n' + output.join(''))));
  });
  const result = await bounded(ready); result.output = output; return result;
}
async function call(worker, method, route, { data, token = platformToken, tenantHint = A } = {}) {
  requests++; const response = await fetch(worker.origin + route, { method, signal: AbortSignal.timeout(14000), headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(tenantHint ? { 'X-PDL-Company': tenantHint } : {}), 'Content-Type': 'application/json' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  const raw = await response.text(); let value; try { value = JSON.parse(raw); } catch { value = raw; } return { status: response.status, value, raw };
}
const help = title => ({ title, type: 'article', audience: 'all', content: 'Synthetic help content only', status: 'Published' });
const okay = response => { assert.ok([200, 201].includes(response.status), JSON.stringify(response)); return response.value; };
async function eventually(predicate) { const until = Date.now() + 5000; while (!predicate()) { if (Date.now() >= until) throw Error('Expected owned synthetic legacy write was not observed.'); await new Promise(resolve => setTimeout(resolve, 20)); } }
async function nativeClaimFixture() {
  const url = process.env.TEST_PLATFORM_HTTP_DATABASE_URL;
  if (!url || !/^postgresql:\/\/postgres@127\.0\.0\.1:\d+\/pdl_platform_authority_synthetic_[a-z0-9_]+$/.test(url)) throw Error('Explicit fresh owned platform HTTP database required.');
  const { Client } = require('pg'), admin = new Client({ connectionString: url }), writer = new Client({ connectionString: url });
  await admin.connect();
  try {
    await admin.query("CREATE TABLE public.companies(id uuid PRIMARY KEY,slug text,name text NOT NULL,data jsonb NOT NULL); CREATE FUNCTION public.app_company_id() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.company_id',true),'')::uuid $$");
    for (const source of ['007_transactional_records.sql', '008_require_explicit_revision.sql', '009_roles_snapshot_authority.sql', '010_platform_snapshot_authority.sql']) await admin.query(fs.readFileSync(path.join(__dirname, 'database', source), 'utf8'));
    await admin.query('GRANT SELECT ON public.companies TO service_role'); await writer.connect(); await writer.query('SET ROLE service_role');
    return { admin, writer, active: false, lastCommit: null };
  } catch (error) { await writer.end().catch(() => {}); await admin.end(); throw error; }
}
async function waitUntil(time) { await new Promise(resolve => setTimeout(resolve, Math.max(0, time - Date.now()) + 35)); }
async function claimJourneys(first, second) {
  const code = crypto.randomBytes(16).toString('base64url'), setup = credential(code), expiresAt = new Date(Date.now() + 2500).toISOString(), password = 'Synthetic claimed password 2026';
  changePlatform(db => { db.users.push({ id: 3, name: 'Synthetic Claimant', email: 'claimant@example.invalid', role: 'engineering', status: 'Active', ...credential(initial), setupHash: setup.passwordHash, setupSalt: setup.passwordSalt, setupExpiresAt: expiresAt, mustSetPassword: true }); });
  if (nativeClaim) {
    await nativeClaim.admin.query('INSERT INTO public.companies(id,slug,name,data,platform_revision) VALUES($1,$2,$3,$4,$5)', [PLATFORM_ID, 'synthetic-platform-claim', PLATFORM_NAME, platform, platformRevision]);
    await nativeClaim.admin.query('UPDATE public.companies SET platform_managed=true WHERE id=$1', [PLATFORM_ID]); nativeClaim.active = true;
  }
  const before = canonicalHash(platform), revisionBefore = platformRevision, originalPasswordHash = platform.platform.users.find(row => row.id === 3).passwordHash;
  let held;
  try {
    if (nativeClaim) { await nativeClaim.admin.query('BEGIN'); await nativeClaim.admin.query('SELECT id FROM public.companies WHERE id=$1 FOR UPDATE', [PLATFORM_ID]); }
    else held = hold(event => event.kind === 'platform-commit');
    let early;
    const pending = call(first, 'POST', '/api/platform/auth/claim', { token: null, data: { email: 'claimant@example.invalid', setupCode: code, password } }).then(value => { early = value; return value; });
    if (nativeClaim) {
      const until = Date.now() + 5000;
      for (;;) { if (early) throw Error('Claim returned before SQL CAS: ' + JSON.stringify(early)); const waiting = (await nativeClaim.admin.query('SELECT wait_event_type FROM pg_catalog.pg_stat_activity WHERE pid=$1', [nativeClaim.writer.processID])).rows[0]?.wait_event_type === 'Lock'; if (waiting) break; if (Date.now() >= until) throw Error('Claim did not reach its actual SQL platform row lock.'); await new Promise(resolve => setTimeout(resolve, 20)); }
      assert.equal(nativeClaim.lastCommit.p_deadline, expiresAt);
    } else { await Promise.race([held.ready, pending.then(value => { throw Error('Claim returned before CAS: ' + JSON.stringify(value) + '\n' + first.output.join('')); })]); assert.equal(held.entries[0].event.input.p_deadline, expiresAt); }
    await waitUntil(Date.parse(expiresAt));
    if (nativeClaim) await nativeClaim.admin.query('ROLLBACK'); else held.release();
    assert.equal((await pending).status, 409); assert.equal(canonicalHash(platform), before); assert.equal(platformRevision, revisionBefore);
    if (nativeClaim) { const stored = (await nativeClaim.admin.query('SELECT data,platform_revision FROM public.companies WHERE id=$1', [PLATFORM_ID])).rows[0]; assert.equal(canonicalHash(stored.data), before); assert.equal(Number(stored.platform_revision), revisionBefore); }
  } finally { if (nativeClaim) await nativeClaim.admin.query('ROLLBACK'); else held?.release(); }
  journeys.push('normal claim naturally expires while waiting at ' + (nativeClaim ? 'the observed SQL platform lock' : 'shared CAS') + '; complete password/setup/snapshot/revision remain unchanged');
  const validCode = crypto.randomBytes(16).toString('base64url'), validSetup = credential(validCode), validExpires = new Date(Date.now() + 10000).toISOString();
  changePlatform(db => { Object.assign(db.users.find(row => row.id === 3), { setupHash: validSetup.passwordHash, setupSalt: validSetup.passwordSalt, setupExpiresAt: validExpires }); });
  if (nativeClaim) await nativeClaim.admin.query('SELECT * FROM public.commit_platform_snapshot($1,$2,$3,clock_timestamp()+interval \'5 seconds\')', [PLATFORM_ID, revisionBefore, platform]);
  okay(await call(second, 'POST', '/api/platform/auth/claim', { token: null, data: { email: 'claimant@example.invalid', setupCode: validCode, password } }));
  const claimed = platform.platform.users.find(row => row.id === 3); assert.equal(claimed.mustSetPassword, false); assert.equal(claimed.setupHash, undefined); assert.equal(claimed.setupSalt, undefined); assert.equal(claimed.setupExpiresAt, undefined); assert.notEqual(claimed.passwordHash, originalPasswordHash);
  const login = okay(await call(first, 'POST', '/api/platform/auth/login', { token: null, data: { email: claimed.email, password } })); okay(await call(second, 'GET', '/api/platform/auth/me', { token: login.token }));
  journeys.push('still-valid normal claim commits and its new password authenticates across workers');
  if (nativeClaim) nativeClaim.active = false;
}
async function main() {
  let first, second, legacy;
  try {
    if (process.argv.includes('--native-claim')) nativeClaim = await nativeClaimFixture();
    first = await worker(1); second = await worker(2);
    okay(await call(first, 'GET', '/api/platform/auth/me')); const current = okay(await call(second, 'GET', '/api/platform/help'));
    assert.ok(current.some(row => row.title === managedHelp.title)); assert.ok(!JSON.stringify(current).includes('Stale local')); assert.equal(platform.platform.users.some(row => row.id === 999), false);
    journeys.push('two normal HTTP processes ignore their separate stale local platform mirrors');
    const overview = okay(await call(first, 'GET', '/api/platform/overview'));
    assert.ok(overview.staff.some(row => row.id === 1)); for (const key of ['passwordHash', 'passwordSalt', 'setupHash', 'setupSalt', 'resetTokenHash', 'tokenHash']) assert.equal(JSON.stringify(overview.staff).includes(key), false);
    journeys.push('normal staff response projects current public fields without credential or session hashes');
    const usersBefore = canonicalHash(platform.platform.users), sessionsBefore = canonicalHash(platform.platform.sessions), beforeCount = platform.platform.helpItems.length;
    const gate = hold(event => event.kind === 'platform-commit', 2), a = call(first, 'POST', '/api/platform/help', { data: help('Worker one contender') }), b = call(second, 'POST', '/api/platform/help', { data: help('Worker two contender') });
    await gate.ready; assert.equal(gate.entries[0].event.input.p_expected_revision, gate.entries[1].event.input.p_expected_revision);
    gate.entries[0].release(); const firstWorker = gate.entries[0].event.worker === 1 ? a : b; assert.equal((await firstWorker).status, 201); gate.entries[1].release(); hook = null;
    const outcomes = await Promise.all([a, b]); assert.equal(outcomes.filter(row => row.status === 201).length, 1, JSON.stringify(outcomes)); assert.equal(outcomes.filter(row => row.status === 409).length, 1, JSON.stringify(outcomes)); assert.equal(platform.platform.helpItems.length, beforeCount + 1); assert.equal(canonicalHash(platform.platform.users), usersBefore); assert.equal(canonicalHash(platform.platform.sessions), sessionsBefore);
    journeys.push('different workers at one opening revision produce exactly one help write without restoring actors or sessions');
    const stale = hold(event => event.worker === 1 && event.kind === 'platform-commit'), staleSave = call(first, 'POST', '/api/platform/help', { data: help('Revoked stale save') }); await stale.ready;
    assert.ok(stale.entries[0].event.input.p_snapshot.platform.sessions.some(row => row.tokenHash === digest(issuerToken)), 'Staged contender contains the actual old issuer session');
    changePlatform(db => { db.users.find(row => row.id === 2).status = 'Deactivated'; db.sessions = db.sessions.filter(row => row.userId !== 2); }); const revokedHash = canonicalHash(platform); stale.release(); assert.equal((await staleSave).status, 409); assert.equal(canonicalHash(platform), revokedHash); assert.equal(platform.platform.sessions.some(row => row.tokenHash === digest(issuerToken)), false);
    journeys.push('a staged help save cannot restore a concurrently revoked actor or session');
    changePlatform(db => { db.users.find(row => row.id === 2).status = 'Active'; }); okay(await call(second, 'GET', '/api/support-session/' + supportToken, { token: null }));
    for (const kind of ['issuer', 'grant', 'tenant']) {
      changePlatform(db => { db.users.find(row => row.id === 2).status = 'Active'; db.supportGrants[0].status = 'Active'; });
      // The first tenant load selects the normal request database. Hold the
      // second load, which selects the support response's private source.
      let tenantReads = 0;
      const held = hold(event => event.worker === 1 && event.kind === 'tenant-read' && ++tenantReads === 2), response = call(first, 'GET', '/api/support-session/' + supportToken, { token: null }); await held.ready;
      if (kind === 'tenant') changeTenant(db => { db.company.name = 'Changed private company during read'; }); else changePlatform(db => { if (kind === 'issuer') db.users.find(row => row.id === 2).status = 'Deactivated'; else db.supportGrants[0].status = 'Revoked'; });
      const afterMutation = canonicalHash(tenant), platformAfter = canonicalHash(platform); held.release(); const rejected = await response; assert.ok([404, 409].includes(rejected.status), JSON.stringify(rejected)); assert.ok(!rejected.raw.includes('summary') && !rejected.raw.includes('Synthetic private company') && !rejected.raw.includes('Changed private company')); assert.equal(canonicalHash(tenant), afterMutation); assert.equal(canonicalHash(platform), platformAfter);
      journeys.push(kind + ' mutation while a support read waits withholds private response bytes');
    }
    for (const [method, route, details] of [['PATCH', 'features', { templates: !tenant.company.features.templates }], ['POST', 'owner-reset', {}]]) {
      const command = '/api/platform/companies/' + A + '/' + route, held = hold(event => event.kind === 'cross-commit'), pending = call(second, method, command, { data: { ...details, expectedRevision: tenantRevision } }); await held.ready;
      assert.equal(held.entries[0].event.input.p_platform_expected_revision, platformRevision); const before = canonicalHash(tenant); changePlatform(db => { db.auditEvents.push({ id: crypto.randomUUID(), action: 'Synthetic concurrent authority change' }); }); held.release(); const denied = await pending; assert.equal(denied.status, 409, JSON.stringify(denied)); assert.equal(canonicalHash(tenant), before);
      journeys.push('system ' + route + ' rejects a changed platform revision before tenant CAS');
    }
    okay(await call(first, 'PATCH', '/api/platform/companies/' + A + '/features', { data: { expectedRevision: tenantRevision, templates: !tenant.company.features.templates } }));
    journeys.push('current platform owner can positively save a finite tenant feature through cross-store CAS');
    await claimJourneys(first, second);
    const login = okay(await call(first, 'POST', '/api/platform/auth/login', { token: null, data: { email: 'platform@example.invalid', password: initial } })); okay(await call(second, 'GET', '/api/platform/auth/me', { token: login.token }));
    okay(await call(second, 'POST', '/api/platform/auth/logout', { token: login.token, data: {} })); assert.equal(platform.platform.sessions.some(row => row.tokenHash === digest(login.token)), false); assert.ok([401, 403].includes((await call(first, 'GET', '/api/platform/auth/me', { token: login.token })).status));
    journeys.push('normal login crosses workers; logout removes the shared session and positive acknowledgement remains deliverable');
    const resetToken = crypto.randomBytes(32).toString('base64url'), newPassword = 'Synthetic reset password 2026';
    changePlatform(db => { const user = db.users.find(row => row.id === 1); user.resetTokenHash = digest(resetToken); user.resetExpiresAt = '2099-01-01T00:00:00.000Z'; user.resetRequestedAt = new Date().toISOString(); });
    okay(await call(first, 'POST', '/api/platform/auth/reset', { token: null, data: { token: resetToken, password: newPassword } })); assert.equal(platform.platform.sessions.some(row => row.userId === 1), false); assert.equal(platform.platform.users[0].resetTokenHash, undefined);
    assert.ok([401, 403].includes((await call(second, 'GET', '/api/platform/auth/me')).status)); const fresh = okay(await call(second, 'POST', '/api/platform/auth/login', { token: null, data: { email: 'platform@example.invalid', password: newPassword } })); okay(await call(first, 'GET', '/api/platform/auth/me', { token: fresh.token }));
    journeys.push('normal password reset removes old shared sessions and fresh credentials work across workers');
    const tenantLogin = okay(await call(first, 'POST', '/api/auth/login', { token: null, data: { email: tenant.users.find(row => row.id === 1).email, password: initial } }));
    okay(await call(second, 'GET', '/api/auth/me', { token: tenantLogin.token })); okay(await call(second, 'POST', '/api/auth/logout', { token: tenantLogin.token, data: {} }));
    assert.equal(tenant.sessions.some(row => row.tokenHash === digest(tenantLogin.token)), false); assert.equal((await call(first, 'GET', '/api/auth/me', { token: tenantLogin.token })).status, 401);
    const tenantReset = crypto.randomBytes(32).toString('base64url'), tenantPassword = 'Synthetic tenant reset password 2026';
    changeTenant(db => { const owner = db.users.find(row => row.id === 1); owner.resetTokenHash = digest(tenantReset); owner.resetExpiresAt = '2099-01-01T00:00:00.000Z'; owner.resetRequestedAt = new Date().toISOString(); });
    okay(await call(first, 'POST', '/api/auth/reset', { token: null, data: { email: tenant.users.find(row => row.id === 1).email, token: tenantReset, password: tenantPassword } })); assert.equal(tenant.sessions.some(row => row.userId === 1), false); assert.equal(tenant.users.find(row => row.id === 1).resetTokenHash, undefined);
    const freshTenant = okay(await call(second, 'POST', '/api/auth/login', { token: null, data: { email: tenant.users.find(row => row.id === 1).email, password: tenantPassword } })); okay(await call(first, 'GET', '/api/auth/me', { token: freshTenant.token }));
    journeys.push('normal tenant login/logout/reset also remove old sessions and accept current credentials across workers');
    for (const file of files.filter(row => row.managed)) assert.deepEqual([digest(fs.readFileSync(file.tenantFile)), digest(fs.readFileSync(file.platformFile))], file.hashes, 'Managed normal routes never write stale local mirrors');
    assert.equal(oldWrites, 0);
    // Independent flag-off process retains the ordinary local/default workflow.
    managed = false; legacy = await worker(3, false); const previous = platform.platform.helpItems.length;
    okay(await call(legacy, 'POST', '/api/platform/help', { token: fresh.token, data: help('Flag off inherited local help') })); await eventually(() => platform.platform.helpItems.length === previous + 1 && oldWrites > 0); journeys.push('flag-off normal worker preserves the existing local/full-snapshot workflow');
    console.log(JSON.stringify({ passed: true, journeys, normalWorkers: 2, flagOffWorker: 1, requests, transportCalls, claimBackend: nativeClaim ? 'owned-native-postgresql-observed-lock' : 'closed-shared-memory', legacyWritesOnlyWhileFlagOff: oldWrites, externalProviderCalls: 0, compatibilityInstallerUsed: false, generatedFixturesOnly: true }));
  } finally {
    if (hook) { hook = null; }
    for (const child of children) if (child.connected) child.send({ type: 'stop' });
    await Promise.all(children.map(async child => { try { await bounded(child.ownedExit); } catch { if (child.exitCode === null && child.signalCode === null) child.kill(); await bounded(child.ownedExit); } }));
    if (nativeClaim) { await nativeClaim.writer.end(); await nativeClaim.admin.end(); }
    const absolute = path.resolve(directory); assert.ok(absolute.startsWith(path.resolve(os.tmpdir()) + path.sep) && /^pdl-platform-multiworker-/.test(path.basename(absolute)) && fs.realpathSync(absolute) === absolute); fs.rmSync(absolute, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
