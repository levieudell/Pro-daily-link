'use strict';
// Offline mode contracts: service worker + queue module serving, api() wiring,
// server clientTag dedupe (synthetic HTTP), and the queue's replay semantics
// (synthetic VM).
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto'), vm = require('node:vm');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-offline-')), companyId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', ownerToken = 'synthetic-offline-owner';
const hash = token => crypto.createHash('sha256').update(token).digest('hex');
const { isPublicFile } = require('./public-file-policy');

// ---------- Static contracts ----------
const index = fs.readFileSync('index.html', 'utf8');
const app = fs.readFileSync('app.js', 'utf8');
const server = fs.readFileSync('server.js', 'utf8');
const sw = fs.readFileSync('sw.js', 'utf8');
const offline = fs.readFileSync('offline.js', 'utf8');
const workspaceGate = fs.readFileSync('workspace-gate.js', 'utf8');
const serviceWorkerRegistration = fs.readFileSync('register-service-worker.js', 'utf8');
assert.equal(isPublicFile(process.cwd(), path.join(process.cwd(), 'sw.js')), true, 'service worker is publicly served');
assert.equal(isPublicFile(process.cwd(), path.join(process.cwd(), 'offline.js')), true, 'offline module is publicly served');
assert.equal(isPublicFile(process.cwd(), path.join(process.cwd(), 'register-service-worker.js')), true, 'service worker registration is publicly served');
assert.ok(index.indexOf('register-service-worker.js') < index.indexOf('offline.js?'), 'service worker registration loads before the offline queue');
assert.ok(index.indexOf('offline.js?') < index.indexOf('app.js?'), 'offline module loads before app.js');
assert.match(serviceWorkerRegistration, /location\.protocol === 'https:'/,
  'service worker registration is restricted to secure production pages');
assert.match(serviceWorkerRegistration, /navigator\.serviceWorker\.register\('\/sw\.js'\)/,
  'the external registration module installs the service worker without weakening CSP');
assert.equal([index, app, offline, workspaceGate, serviceWorkerRegistration]
  .filter(source => /navigator\.serviceWorker\.register\('\/sw\.js'\)/.test(source)).length, 1,
  'the service worker has one registration owner');
assert.ok(workspaceGate.includes("localStorage.getItem('pdl-last-state')"), 'external workspace gate opens the cached state when offline');
assert.match(sw, /url\.pathname\.startsWith\('\/api\/'\)\)/, 'service worker never caches API responses');
assert.match(sw, /caches\.match\(APP_PAGE\)/, 'service worker serves the cached app page for navigations');
assert.match(app, /window\.PDLOffline\.loadState\(\)/, 'api() falls back to the cached state for GET /api/state');
assert.match(app, /window\.PDLOffline\.saveState\(data\)/, 'successful state loads refresh the cache');
assert.match(app, /window\.PDLOffline\.enqueue\(method,path,options\.body\)/, 'eligible offline mutations are queued');
assert.match(app, /queuedError\.queued=true/, 'queued throws are marked so callers could special-case');
assert.match(app, /\(typeof navigator==='undefined'\|\|!navigator\.onLine\)&&typeof window!=='undefined'&&window\.PDLOffline/, 'offline check runs before the 36s wake poll');
assert.match(app, /PDLOffline\.queuedCount\(\)/, 'the connection banner counts queued changes');
assert.match(server, /clientTag=String\(input\.clientTag\|\|''\)\.trim\(\)\.slice\(0,64\)/, 'server reads the client tag');
assert.ok((server.match(/clientTag/g) || []).length >= 4, 'clientTag dedupe on reports and workdays start');

// ---------- Queue semantics (synthetic VM) ----------
function makeStorage(){ const map = new Map(); return { getItem:k=>map.has(k)?map.get(k):null, setItem:(k,v)=>map.set(k,String(v)), removeItem:k=>map.delete(k), _map:map }; }
function loadQueue(online, fetchImpl){
  const storage = makeStorage(), handlers = {};
  const sandbox = {
    window: null, document: { readyState: 'complete', addEventListener(){} },
    navigator: { onLine: online }, localStorage: storage, fetch: fetchImpl,
    setTimeout, console
  };
  sandbox.window = { addEventListener: (name, fn) => { handlers[name] = fn; } };
  sandbox.window.addEventListener = (name, fn) => { handlers[name] = fn; };
  vm.createContext(sandbox);
  vm.runInContext(offline, sandbox);
  return { PDLOffline: sandbox.window.PDLOffline, handlers, storage };
}
{
  const { PDLOffline } = loadQueue(false, async () => { throw new Error('offline'); });
  assert.equal(PDLOffline.eligible('POST', '/api/reports'), true);
  assert.equal(PDLOffline.eligible('POST', '/api/workdays/start'), true);
  assert.equal(PDLOffline.eligible('POST', '/api/workdays/42/end'), true);
  assert.equal(PDLOffline.eligible('POST', '/api/assignments/9/acknowledge'), true);
  assert.equal(PDLOffline.eligible('POST', '/api/time-off-requests'), true);
  assert.equal(PDLOffline.eligible('POST', '/api/projects'), false, 'non-whitelisted mutations are not queued');
  assert.equal(PDLOffline.eligible('PATCH', '/api/reports/1'), false);
  PDLOffline.enqueue('POST', '/api/reports', '{"notes":"x"}');
  PDLOffline.enqueue('POST', '/api/reports', '{"notes":"x"}');
  assert.equal(PDLOffline.queuedCount(), 1, 'identical content replaces instead of duplicating');
  PDLOffline.enqueue('POST', '/api/reports', '{"notes":"y"}');
  assert.equal(PDLOffline.queuedCount(), 2, 'different content queues separately');
}
{
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options, body: options.body });
    if (calls.length === 1) return { ok: true, status: 200 };
    throw new Error('still flaky');
  };
  const { PDLOffline, handlers } = loadQueue(true, fetchImpl);
  PDLOffline.enqueue('POST', '/api/reports', '{"notes":"first"}');
  PDLOffline.enqueue('POST', '/api/workdays/start', '{"projectId":1,"memberIds":[1]}');
  assert.equal(typeof handlers.online, 'function', 'online event drains the queue');
  (async () => {
    const result = await PDLOffline.drain();
    assert.equal(result.sent, 1, 'the reachable request replays');
    assert.equal(result.remaining, 1, 'the network failure stops the drain and keeps the entry');
    assert.equal(calls.length, 2, 'the failing request is attempted once, then the drain stops');
    assert.equal(calls[0].url, '/api/reports', 'in-order replay');
    assert.match(calls[0].body, /clientTag/, 'the replay carries the dedupe tag');
    assert.match(JSON.parse(calls[0].body).clientTag, /^pdlq-/, 'the tag is stable and content-derived per entry');
  })().then(() => runServerChecks(), error => { console.error(error); process.exit(1); });
}

function runServerChecks(){
{
  const { PDLOffline } = loadQueue(true, async () => ({ ok: true, status: 200 }));
  const state = { company: { id: companyId }, team: [{ id: 1 }], photos: [{ id: 1, data: 'huge' }] };
  PDLOffline.saveState(state);
  const cached = PDLOffline.loadState();
  assert.equal(cached.company.id, companyId);
  assert.equal(cached.photos, undefined, 'photos are stripped from the offline state cache');
}

// ---------- Server clientTag dedupe (synthetic HTTP) ----------
const db = {
  company: { id: companyId, name: 'Synthetic offline', demo: true, timezone: 'UTC' },
  projects: [{ id: 1, name: 'Offline Job', customer: 'Test Customer', site: 'Site A', startDate: '2026-10-12', endDate: '2026-12-31', status: 'Active', estimateItems: [{ id: 5, name: 'Footings', plannedQuantity: 100, unit: 'SF' }] }],
  team: [{ id: 1, name: 'Chloe', crew: 'A' }],
  assignments: [], workdays: [], timeCards: [], timeOffRequests: [], reports: [], photos: [], auditLog: [], projectTasks: [], customers: [], changes: [], catalog: [],
  users: [{ id: 1, name: 'Synthetic owner', role: 'owner', status: 'Active', companyId }],
  sessions: [{ companyId, userId: 1, tokenHash: hash(ownerToken), expiresAt: '2099-01-01' }]
};
const file = path.join(root, 'db.json'); fs.writeFileSync(file, JSON.stringify(db)); fs.writeFileSync(path.join(root, 'platform.json'), JSON.stringify({ users: [], sessions: [] }));
Object.assign(process.env, { PDL_DB_FILE: file, PDL_PLATFORM_FILE: path.join(root, 'platform.json'), PDL_REQUIRE_AUTH: '1', PDL_SUPABASE_ENABLED: '0', PDL_TRANSACTIONAL_DB: 'off', PDL_EMAIL_DEV_MODE: '1' });
for (const name of ['OPENAI_API_KEY', 'SENTRY_DSN', 'RESEND_API_KEY', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET']) delete process.env[name];
require('./database/supabase').loadLocalEnv = () => {};
const { server } = require('./server');
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const call = (method, route, input) => fetch(base + route, { method, signal: AbortSignal.timeout(10000), headers: { Authorization: 'Bearer ' + ownerToken, 'Content-Type': 'application/json', 'x-pdl-company': companyId }, ...(input !== undefined ? { body: JSON.stringify(input) } : {}) }).then(async response => ({ status: response.status, data: await response.json() }));
  const reload = () => JSON.parse(fs.readFileSync(file));
  try {
    const body = { projectId: 1, dateIso: '2026-10-14', notes: 'Poured half the footing edge', foreman: 'Synthetic owner', productionEntries: [{ estimateItemId: 5, description: 'Footings', quantity: 40, unit: 'SF', laborHours: 8 }], laborEntries: [{ memberId: 1, hours: 8 }] };
    const first = await call('POST', '/api/reports', { ...body, clientTag: 'pdlq-test-1' });
    assert.equal(first.status, 201);
    const second = await call('POST', '/api/reports', { ...body, clientTag: 'pdlq-test-1' });
    assert.equal(second.status, 200);
    assert.equal(second.data.id, first.data.id, 'a replayed daily returns the original report instead of duplicating it');
    assert.equal(reload().reports.length, 1, 'only one report is stored');
    const third = await call('POST', '/api/reports', { ...body, notes: 'Poured half the footing edge, revised', clientTag: 'pdlq-test-2' });
    assert.notEqual(third.data.id, first.data.id, 'a different tag is a different report');
    assert.equal(reload().reports.length, 2);
    assert.equal(reload().reports.find(row => row.id === first.data.id).clientTag, 'pdlq-test-1', 'the tag is stored for future dedupe');

    const start = await call('POST', '/api/workdays/start', { projectId: 1, memberIds: [1], clientTag: 'pdlq-start-1' });
    assert.equal(start.status, 201);
    const replay = await call('POST', '/api/workdays/start', { projectId: 1, memberIds: [1], clientTag: 'pdlq-start-1' });
    assert.equal(replay.status, 200);
    assert.equal(replay.data.id, start.data.id, 'a replayed start returns the original workday');
    assert.equal(reload().workdays.length, 1, 'no second active workday');
    const conflicting = await call('POST', '/api/workdays/start', { projectId: 1, memberIds: [1], clientTag: 'pdlq-start-2' });
    assert.equal(conflicting.status, 409, 'a genuinely different start still hits the busy guard');

    console.log('offline mode: ok');
  } finally {
    server.close();
  }
  process.exit(0);
})().catch(error => { console.error(error); process.exit(1); });
}
