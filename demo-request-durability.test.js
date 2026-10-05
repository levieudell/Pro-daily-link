'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-demo-durability-'));
Object.assign(process.env, {
  PDL_DB_FILE: path.join(temp, 'db.json'), PDL_PLATFORM_FILE: path.join(temp, 'platform.json'),
  PDL_REQUIRE_AUTH: '1', PDL_SUPABASE_ENABLED: '0', PDL_TRANSACTIONAL_DB: 'off',
  PDL_PLATFORM_KEY: 'synthetic-platform-key-with-32-characters'
});
for (const key of ['SENTRY_DSN', 'STRIPE_SECRET_KEY', 'RESEND_API_KEY', 'OPENAI_API_KEY']) delete process.env[key];
fs.copyFileSync(path.join(__dirname, 'data/db.json'), process.env.PDL_DB_FILE);
fs.writeFileSync(process.env.PDL_PLATFORM_FILE, JSON.stringify({ users: [], notes: [], demoRequests: [] }));

const supabase = require('./database/supabase');
let cloudEnabled = false, failSave = false, savedSnapshot, saveCount = 0;
let holdSave = false, releaseSave, activeSaves = 0, maximumActiveSaves = 0;
supabase.configured = () => cloudEnabled;
supabase.listCompanySnapshots = async () => [];
supabase.saveCompanySnapshot = async snapshot => {
  saveCount++;
  activeSaves++;
  maximumActiveSaves = Math.max(maximumActiveSaves, activeSaves);
  try {
    if (holdSave) {
      holdSave = false;
      await new Promise(resolve => { releaseSave = resolve; });
    }
    if (failSave) throw new Error('Synthetic cloud persistence failure');
    savedSnapshot = structuredClone(snapshot);
    return true;
  } finally { activeSaves--; }
};
const { server } = require('./server');
let base;
const realFetch = global.fetch;
let releaseEmail;
global.fetch = async (url, options) => {
  if (String(url).startsWith('http://127.0.0.1:')) return realFetch(url, options);
  assert.equal(String(url), 'https://api.resend.com/emails', 'no external network request is allowed');
  return new Promise(resolve => { releaseEmail = () => resolve(new Response('{}', { status: 503 })); });
};
async function request(route, payload, headers = {}) {
  const response = await fetch(base + route, payload === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(payload)
  });
  return { status: response.status, data: await response.json() };
}
const lead = { name: 'Synthetic Buyer', email: 'buyer@example.test', company: 'Synthetic Contractor',
  requestId: '11111111-1111-4111-8111-111111111111' };
const localPlatform = () => JSON.parse(fs.readFileSync(process.env.PDL_PLATFORM_FILE, 'utf8'));
async function until(predicate) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for synthetic save');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

(async () => {
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    await request('/api/help'); // Seed built-in help locally before testing cloud lead writes.
    cloudEnabled = true;
    failSave = true;
    const failed = await request('/api/demo-requests', lead);
    assert.equal(failed.status, 503, 'a failed cloud lead save must not acknowledge success');
    assert.equal(failed.data.ok, undefined);
    assert.equal(saveCount, 1);
    assert.match(failed.data.error, /could not confirm.*saved.*try again/i);
    assert.equal(localPlatform().demoRequests.length, 1, 'unconfirmed lead remains locally recoverable');
    const originalId = localPlatform().demoRequests[0].id;
    failSave = false;
    const retry = await request('/api/demo-requests', lead);
    assert.equal(retry.status, 201);
    assert.equal(retry.data.id, originalId, 'retry confirms the same saved intent');
    assert.equal(savedSnapshot.platform.demoRequests.length, 1);
    assert.equal(savedSnapshot.platform.auditEvents.filter(row => row.action === 'demo_requested').length, 1);

    const repeated = await request('/api/demo-requests', lead);
    assert.equal(repeated.data.id, originalId, 'a lost success response can be retried safely');
    const beforeConflict = saveCount;
    const conflict = await request('/api/demo-requests', { ...lead, notes: 'Different request content' });
    assert.equal(conflict.status, 409);
    assert.equal(saveCount, beforeConflict);
    assert.equal(localPlatform().demoRequests[0].notes, '');
    assert.equal((await request('/api/demo-requests', { ...lead, requestId: 'invalid' })).status, 400);
    assert.equal((await request('/api/demo-requests', { ...lead, email: 'invalid' })).status, 400);
    const beforeHoneypot = saveCount;
    assert.equal((await request('/api/demo-requests', { ...lead, website: 'bot-filled' })).status, 201);
    assert.equal(saveCount, beforeHoneypot, 'existing honeypot does not create a lead');

    for (const mode of ['off', 'primary']) {
      process.env.PDL_TRANSACTIONAL_DB = mode;
      releaseSave = null; holdSave = true;
      let settled = false;
      const payload = { ...lead, requestId: `held-request-${mode}-12345678`, company: `${mode} synthetic contractor` };
      const held = request('/api/demo-requests', payload).then(value => { settled = true; return value; });
      await until(() => releaseSave);
      await new Promise(resolve => setTimeout(resolve, 30));
      assert.equal(settled, false, `${mode}: do not return success while cloud persistence is pending`);
      const unrelated = await Promise.race([
        Promise.all([request('/api/config'), request('/api/signup', {})]),
        new Promise(resolve => setTimeout(() => resolve(null), 250))
      ]);
      assert.ok(unrelated, `${mode}: a slow demo save cannot hold the primary tenant/public request queue`);
      assert.equal(unrelated[0].status, 200);
      assert.equal(unrelated[1].status, 400, 'independent signup validation remains responsive');
      releaseSave();
      assert.equal((await held).status, 201);
      assert.ok(savedSnapshot.platform.demoRequests.some(row => row.requestId === payload.requestId));
    }
    process.env.PDL_TRANSACTIONAL_DB = 'off';

    // An existing background platform write must not land after a newer lead.
    const older = localPlatform();
    older.notes.push({ id: 'synthetic-note', text: 'Preserve unrelated platform work' });
    older.helpItems = older.helpItems.filter(item => item.id !== 'pdl-help-01');
    fs.writeFileSync(process.env.PDL_PLATFORM_FILE, JSON.stringify(older));
    releaseSave = null; holdSave = true;
    await request('/api/help'); // The existing help seeding path calls writePlatform without await.
    await until(() => releaseSave);
    const beforeQueued = saveCount;
    const latest = { ...lead, requestId: 'queued-request-12345678', company: 'Queued synthetic contractor' };
    let queuedSettled = false;
    const queued = request('/api/demo-requests', latest).then(value => { queuedSettled = true; return value; });
    await until(() => localPlatform().demoRequests.some(row => row.requestId === latest.requestId));
    assert.equal(saveCount, beforeQueued, 'newer cloud snapshot waits for the older one');
    assert.equal(queuedSettled, false);
    releaseSave();
    assert.equal((await queued).status, 201);
    assert.equal(maximumActiveSaves, 1, 'platform cloud saves are serialized');
    assert.ok(savedSnapshot.platform.demoRequests.some(row => row.requestId === latest.requestId));
    assert.ok(savedSnapshot.platform.notes.some(row => row.id === 'synthetic-note'));
    assert.equal(savedSnapshot.platform.demoRequests.length, 4);

    // Async company lookups must not later replace the platform with a stale copy.
    const companyId = JSON.parse(fs.readFileSync(process.env.PDL_DB_FILE, 'utf8')).company.id;
    for (const [route, details] of [
      ['onboarding', { owner: 'Synthetic Operator' }],
      ['tickets', { subject: 'Synthetic support question' }],
      ['follow-ups', { title: 'Synthetic follow-up' }]
    ]) {
      let releaseLookup;
      supabase.listCompanySnapshots = () => new Promise(resolve => { releaseLookup = () => resolve([]); });
      const work = request(`/api/platform/${route}`, { companyId, ...details }, { 'x-pdl-platform-key': process.env.PDL_PLATFORM_KEY });
      await until(() => releaseLookup);
      const concurrentLead = { ...lead, requestId: `during-${route}-123456789`, company: `Synthetic ${route} lead` };
      const accepted = await request('/api/demo-requests', concurrentLead);
      assert.equal(accepted.status, 201);
      releaseLookup();
      assert.equal((await work).status, 201);
      await until(() => activeSaves === 0);
      assert.ok(localPlatform().demoRequests.some(row => row.id === accepted.data.id), `${route} preserves the newer local lead`);
      assert.ok(savedSnapshot.platform.demoRequests.some(row => row.id === accepted.data.id), `${route} preserves the newer cloud lead`);
    }
    supabase.listCompanySnapshots = async () => [];
    assert.equal(localPlatform().demoRequests.length, 7);
    assert.equal(localPlatform().auditEvents.filter(row => row.action === 'demo_requested').length, 7);

    // Failed reset-email rollback must reload current platform work and never
    // clear a newer reset intent. The email adapter is entirely synthetic.
    process.env.RESEND_API_KEY = 'synthetic-only-not-a-provider-key';
    const resetPlatform = localPlatform();
    resetPlatform.users.push({ id: 'synthetic-operator', name: 'Synthetic Operator', email: 'operator@example.test', status: 'Active' });
    fs.writeFileSync(process.env.PDL_PLATFORM_FILE, JSON.stringify(resetPlatform));
    for (const newerReset of [false, true]) {
      releaseEmail = null;
      const reset = request('/api/platform/auth/forgot', { email: 'operator@example.test' });
      await until(() => releaseEmail);
      const accepted = await request('/api/demo-requests', { ...lead, requestId: `during-email-${newerReset}-123456789` });
      assert.equal(accepted.status, 201);
      if (newerReset) {
        const newer = localPlatform();
        newer.users[0].resetTokenHash = 'newer-synthetic-reset-hash';
        fs.writeFileSync(process.env.PDL_PLATFORM_FILE, JSON.stringify(newer));
      }
      releaseEmail();
      assert.equal((await reset).status, 502);
      await until(() => activeSaves === 0);
      assert.ok(localPlatform().demoRequests.some(row => row.id === accepted.data.id));
      assert.ok(savedSnapshot.platform.demoRequests.some(row => row.id === accepted.data.id));
      assert.equal(localPlatform().users[0].resetTokenHash, newerReset ? 'newer-synthetic-reset-hash' : undefined);
    }
    delete process.env.RESEND_API_KEY;

    // Existing clients without a retry ID and local-only deployments remain supported.
    cloudEnabled = false;
    const beforeLocal = saveCount;
    const legacy = { ...lead, requestId: undefined, company: 'Legacy synthetic contractor' };
    assert.equal((await request('/api/demo-requests', legacy)).status, 201);
    assert.equal(saveCount, beforeLocal);
    assert.equal(localPlatform().demoRequests.length, 10);
    console.log('Demo request durability passed: delayed/failing cloud saves, retries, deduplication, ordered snapshots, validation, and local-only compatibility.');
  } finally {
    releaseSave?.();
    releaseEmail?.();
    global.fetch = realFetch;
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
