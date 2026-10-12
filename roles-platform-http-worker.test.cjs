'use strict';
// Normal application process; only its transport is a closed synthetic IPC
// adapter. No compatibility installer, live key or provider socket is available.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const bootstrapFile = path.resolve(process.env.PDL_PLATFORM_WORKER_BOOTSTRAP || '');
const ownedRoot = path.dirname(path.dirname(bootstrapFile)), temporaryRoot = path.resolve(os.tmpdir()) + path.sep;
assert.ok(ownedRoot.startsWith(temporaryRoot) && /^pdl-platform-multiworker-[a-zA-Z0-9_-]+$/.test(path.basename(ownedRoot)) && /^worker-[123]$/.test(path.basename(path.dirname(bootstrapFile))) && path.basename(bootstrapFile) === 'bootstrap.json');
assert.equal(fs.realpathSync(ownedRoot), ownedRoot);
const bootstrap = JSON.parse(fs.readFileSync(bootstrapFile, 'utf8'));
assert.deepEqual(Object.keys(bootstrap).sort(), ['companyId', 'managed', 'policyKey']);
for (const name of ['OPENAI_API_KEY', 'RESEND_API_KEY', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'SENTRY_DSN', 'SUPABASE_SECRET_KEY', 'SUPABASE_ANON_KEY', 'SUPABASE_URL', 'PDL_PLATFORM_KEY', 'DATABASE_URL', 'PDL_COMPAT_GLOBAL_FENCE_FILE', 'PDL_COMPAT_ACCOUNT_SYNTHETIC']) delete process.env[name];
Object.assign(process.env, { NODE_ENV: 'test', PDL_REQUIRE_AUTH: '1', PDL_WEEKLY_DIGEST: '0', PDL_SUPABASE_ENABLED: '0', PDL_TRANSACTIONAL_DB: 'off', PDL_DB_FILE: path.join(path.dirname(bootstrapFile), 'tenant.json'), PDL_PLATFORM_FILE: path.join(path.dirname(bootstrapFile), 'platform.json'), PDL_ROLE_POLICY_KEY: bootstrap.policyKey });
if (bootstrap.managed) process.env.PDL_ROLES_COMPANIES = bootstrap.companyId; else delete process.env.PDL_ROLES_COMPANIES;
globalThis.fetch = async () => { throw Error('Closed worker cannot contact any network provider.'); };
let ordinal = 0;
const pending = new Map();
function ipc(kind, details) {
  return new Promise((resolve, reject) => {
    const id = ++ordinal, timer = setTimeout(() => { pending.delete(id); reject(Error('Synthetic IPC transport deadline.')); }, 12000); timer.unref();
    pending.set(id, { resolve, reject, timer }); process.send({ type: 'transport', id, kind, details });
  });
}
const supabase = require('./database/supabase');
supabase.loadLocalEnv = () => {};
supabase.configured = () => true;
supabase.request = async (relative, options = {}) => {
  assert.equal(typeof relative, 'string'); assert.ok(!Object.keys(options).some(name => !['method', 'headers', 'body', 'signal'].includes(name)));
  const result = await ipc('request', { relative, method: options.method || 'GET', ...(options.body === undefined ? {} : { body: options.body }) });
  return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });
};
supabase.loadCompanySnapshot = id => ipc('snapshot', { id });
supabase.listCompanySnapshots = () => ipc('list', {});
supabase.health = () => Promise.resolve({ configured: true, reachable: true });
supabase.saveCompanySnapshot = snapshot => ipc('legacy-save', { snapshot });
supabase.saveSnapshot = (id, name, snapshot) => ipc('legacy-save', { snapshot });
supabase.upload = supabase.download = supabase.remove = async () => { throw Error('No storage provider is available to this worker fixture.'); };
const { server } = require('./server');
process.on('message', async message => {
  if (message?.type === 'transport-result') {
    const row = pending.get(message.id); if (!row) return; pending.delete(message.id); clearTimeout(row.timer);
    if (message.error) row.reject(Object.assign(Error(message.error.message), { code: message.error.code })); else row.resolve(message.value);
  } else if (message?.type === 'stop') {
    server.closeAllConnections(); server.close(() => { process.send({ type: 'stopped', pid: process.pid }); process.disconnect(); });
  }
});
server.listen(0, '127.0.0.1', () => process.send({ type: 'ready', pid: process.pid, origin: 'http://127.0.0.1:' + server.address().port }));
server.on('error', error => { console.error(error.message); process.exitCode = 1; });
