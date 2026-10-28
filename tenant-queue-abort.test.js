'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { fixture } = require('./fixtures/project-assistant');
const monitoring = require('./monitoring');

const source = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
const body = vm.runInNewContext(source.slice(source.indexOf('function body(req)'), source.indexOf('function nextId(')) + ';body', { Buffer });
const aborted = error => error.statusCode === 499 && error.code === 'CLIENT_ABORTED';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  const end = Date.now() + 2000;
  while (!predicate()) {
    assert(Date.now() < end, 'fixture reached the expected request state within two seconds');
    await sleep(5);
  }
}

async function bodyChecks() {
  for (const flag of ['destroyed', 'readableAborted']) {
    const req = new EventEmitter();
    req[flag] = true;
    await assert.rejects(body(req), aborted);
    assert.equal(req.listenerCount('data'), 0, 'already aborted requests are rejected without waiting for events');
  }
  for (const event of ['aborted', 'close']) {
    const req = new EventEmitter(), pending = body(req);
    req.emit('data', '{');
    req.emit(event);
    await assert.rejects(pending, aborted);
    req.emit('error', new Error('late socket error'));
  }
  const req = new EventEmitter(), pending = body(req);
  assert.equal(body(req), pending, 'body parsing remains memoized');
  req.emit('data', '{"ok":true}');
  req.emit('end');
  req.emit('close');
  assert.equal((await pending).ok, true, 'normal close after end must not reject a parsed body');
  req.destroyed = true;
  assert.equal(body(req), pending, 'completed streams still return the cached body to repeated readers');
  const invalid = new EventEmitter(), invalidBody = body(invalid);
  invalid.emit('data', '{');
  invalid.emit('end');
  await assert.rejects(invalidBody, error => error.statusCode === 400);
}

async function queueChecks() {
  const logs = [], scheduled = [], env = {};
  const queue = vm.runInNewContext(
    'const tenantQueues=new Map();' + source.slice(source.indexOf('function withTenantQueue('), source.indexOf('function withPlatformQueue(')) + ';withTenantQueue',
    { process: { env }, monitoring, console: { error: (...args) => logs.push(args) },
      setTimeout(fn, ms) { scheduled.push(ms); return setTimeout(fn, ms); }, clearTimeout }
  );
  assert.equal(await queue('tenant', () => 7), 7);
  assert.equal(scheduled[0], 45000, 'default deadline is 45 seconds');
  env.PDL_TENANT_TASK_TIMEOUT_MS = '40';
  const stuck = queue('tenant', () => new Promise(() => {}), '/api/auth/login?token=do-not-log');
  const rejected = assert.rejects(stuck, error => error.statusCode === 503 && error.code === 'TENANT_TASK_TIMEOUT');
  const next = queue('tenant', () => 'queue released');
  assert.equal(await queue('other-tenant', () => 'independent'), 'independent');
  assert.equal(await next, 'queue released', 'a never-settling task cannot wedge its tenant');
  await rejected;
  assert.deepEqual(logs, [['Tenant queue task timed out', 'tenant', '/api/auth/login']]);
  assert.equal(scheduled[1], 40, 'environment override controls the running task deadline');
}

async function httpChecks() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-tenant-queue-abort-'));
  const companyId = '11111111-1111-4111-8111-111111111111';
  const dbFile = path.join(root, 'db.json'), platformFile = path.join(root, 'platform.json');
  fs.writeFileSync(dbFile, JSON.stringify(fixture(companyId)));
  fs.writeFileSync(platformFile, JSON.stringify({ users: [], sessions: [] }));
  Object.assign(process.env, {
    NODE_ENV: 'test', PDL_DB_FILE: dbFile, PDL_PLATFORM_FILE: platformFile,
    PDL_REQUIRE_AUTH: '1', PDL_SUPABASE_ENABLED: '0', PDL_TRANSACTIONAL_DB: 'off',
    PDL_PLATFORM_TRANSACTIONAL_DB: 'off', PDL_EMAIL_DEV_MODE: '1', PDL_STAGING: '0',
    PDL_TENANT_TASK_TIMEOUT_MS: '45000'
  });
  for (const key of ['SENTRY_DSN', 'RESEND_API_KEY', 'OPENAI_API_KEY', 'DATABASE_URL']) delete process.env[key];
  require('./database/supabase').loadLocalEnv = () => {};
  const { server } = require('./server');
  const received = new Map(), clients = [], errors = [], originalError = console.error;
  server.on('request', req => received.set(req.headers['x-test-request'], req));
  console.error = (...args) => errors.push(args);
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const headers = { Cookie: `pdl_company=${companyId}` };
    function login(marker) {
      let finish;
      const result = new Promise(resolve => { finish = resolve; });
      const client = http.request({ hostname: '127.0.0.1', port, method: 'POST', path: '/api/auth/login', agent: false,
        headers: { ...headers, 'Content-Type': 'application/json', 'x-test-request': marker } }, res => {
        res.resume(); res.on('end', () => finish(res.statusCode));
      });
      client.on('error', () => finish('disconnected'));
      clients.push(client);
      client.write('{');
      return { client, result };
    }
    async function config() {
      const started = Date.now();
      const res = await fetch(`http://127.0.0.1:${port}/api/config`, { headers, signal: AbortSignal.timeout(2000) });
      assert.equal(res.status, 200);
      assert.equal((await res.json()).authRequired, true);
      assert(Date.now() - started < 2000, 'same-cookie config returns within two seconds');
    }

    const held = login('busy');
    await until(() => received.get('busy')?.parsedBodyPromise);
    const abandoned = login('queued-abort');
    await until(() => received.has('queued-abort'));
    const queued = received.get('queued-abort');
    assert.equal(queued.parsedBodyPromise, undefined, 'the tenant queue is still busy');
    abandoned.client.destroy();
    await until(() => queued.destroyed);
    held.client.end('}');
    assert.equal(await held.result, 401);
    await config();
    assert.equal(queued.parsedBodyPromise, undefined, 'disconnected queued work never enters api()');

    const active = login('active-abort');
    await until(() => received.get('active-abort')?.parsedBodyPromise);
    active.client.destroy();
    await until(() => received.get('active-abort').destroyed);
    await config();

    process.env.PDL_TENANT_TASK_TIMEOUT_MS = '100';
    const hung = login('deadline');
    await until(() => received.get('deadline')?.parsedBodyPromise);
    assert.equal(await hung.result, 503, 'unsent response receives 503 on task deadline');
    await config();
    hung.client.destroy();
    assert(errors.some(args => args[0] === 'Tenant queue task timed out' && args[1] === companyId && args[2] === '/api/auth/login'));
  } finally {
    for (const client of clients) client.destroy();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    console.error = originalError;
    if (root.startsWith(path.join(os.tmpdir(), 'pdl-tenant-queue-abort-'))) fs.rmSync(root, { recursive: true, force: true });
  }
}

const watchdog = setTimeout(() => { console.error('Tenant queue regression timed out'); process.exit(1); }, 15000);
(async () => {
  await bodyChecks();
  await queueChecks();
  await httpChecks();
  console.log('Tenant queue abort/deadline passed: queued and active disconnects, same-cookie config under 2s, 503 recovery, body parsing, and private timeout logs.');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => clearTimeout(watchdog));
