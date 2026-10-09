'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { fork } = require('node:child_process');
const { Pool } = require('pg');
const { CompatTenantRepository, split } = require('./database/compat-tenant-repository');
const { canonicalHash } = require('./database/transactional-repository');
const { createCredentialDelivery, COLLECTION } = require('./account-credential-delivery');
const { validateAccounts } = require('./account-evidence');
const companyId = '849cde3b-05bf-4a2d-8f13-d9069927fe71';
process.env.NODE_ENV = 'test'; process.env.PDL_COMPAT_ACCOUNT_SYNTHETIC = '1';
const connectionString = process.env.TEST_COMPAT_DATABASE_URL;
function repository() { return new CompatTenantRepository({ connectionString, companyId, synthetic: true }); }
function seed() { return { company: { id: companyId, name: 'Synthetic native account', billingExempt: true }, users: [{ id: 1, companyId, name: 'Synthetic Owner', role: 'owner', email: 'native@example.invalid', status: 'Active' }], sessions: [], team: [], projects: [], reports: [], explicitEmpty: [], explicitNull: null, [COLLECTION]: [] }; }
async function worker() {
  const repo = repository(); let loaded;
  process.on('message', async message => {
    try {
      if (message.action === 'load') { loaded = await repo.load(companyId); process.send({ event: 'loaded', revision: loaded.revision }); return; }
      if (message.action === 'commit') {
        if (message.kind === 'revoke') { loaded.snapshot.users[0].status = 'Inactive'; loaded.snapshot.sessions = []; }
        else loaded.snapshot.company.syntheticActionMarker = true;
        await repo.commit(loaded.snapshot, loaded.revision); process.send({ event: 'committed' }); return;
      }
      if (message.action === 'close') { await repo.close(); process.disconnect(); }
    } catch (error) { process.send({ event: 'rejected', code: error.code }); }
  });
}
function next(child, message) { return new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error('Synthetic worker timed out')), 15000); const received = value => { clearTimeout(timer); child.off('error', failed); resolve(value); }; const failed = error => { clearTimeout(timer); child.off('message', received); reject(error); }; child.once('message', received); child.once('error', failed); child.send(message); }); }
async function main() {
  let url; try { url = new URL(connectionString); } catch { throw Error('Set an explicit local synthetic TEST_COMPAT_DATABASE_URL'); }
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)); assert.match(url.pathname, /^\/(?:pdl_compat_|compat_test)/);
  const admin = new Pool({ connectionString, ssl: false, max: 4 }), repo = repository();
  const children = [];
  try {
    await admin.query("DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF; IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF; IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN; END IF; END $$");
    await admin.query("CREATE TABLE IF NOT EXISTS public.companies(id uuid PRIMARY KEY,slug text,name text,data jsonb); CREATE OR REPLACE FUNCTION public.app_company_id() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('app.company_id',true),'')::uuid $$");
    for (const file of ['007_transactional_records.sql', '008_require_explicit_revision.sql']) await admin.query(fs.readFileSync(path.join(__dirname, 'database', file), 'utf8'));
    const privileges = await admin.query("SELECT has_function_privilege('anon','public.replace_tenant_records(uuid,bigint,jsonb,text,jsonb)','EXECUTE') AS anonymous, has_function_privilege('authenticated','public.replace_tenant_records(uuid,bigint,jsonb,text,jsonb)','EXECUTE') AS authenticated");
    assert.deepEqual(privileges.rows[0], { anonymous: false, authenticated: false });
    await admin.query('INSERT INTO public.companies(id,slug,name) VALUES($1,$2,$3) ON CONFLICT(id) DO NOTHING', [companyId, 'synthetic-compat', 'Synthetic native account']);
    await admin.query('DELETE FROM public.tenant_records WHERE company_id=$1', [companyId]); await admin.query('DELETE FROM public.tenant_revisions WHERE company_id=$1', [companyId]);
    const db = seed(), parts = split(db), records = parts.records.map(row => ({ collection: row.collection, record_key: row.recordKey, position: row.position, data: row.data }));
    await admin.query('SELECT * FROM public.replace_tenant_records($1,0,$2::jsonb,$3,$4::jsonb)', [companyId, JSON.stringify(parts.scalarData), canonicalHash(db), JSON.stringify(records)]);
    assert.deepEqual((await repo.load(companyId)).snapshot, db); // absent/null/empty intact
    // Real stored poison with a correctly recomputed hash still fails evidence.
    const canonical = structuredClone(db); canonical.sessions.push({ id: crypto.randomUUID(), userId: 1, companyId, tokenHash: 'a'.repeat(64), expiresAt: new Date(Date.now() + 86400000).toISOString() });
    for (const mutate of [value => { value.sessions.push({ ...value.sessions[0], id: crypto.randomUUID() }); }, value => { value.users[0].id = '1'; }, value => { value.users[0].role = { role: 'owner' }; }, value => { value.users[0].permissions = { scheduleCrews: { allowed: true } }; }]) {
      let current = await repo.load(companyId); const poison = structuredClone(canonical); mutate(poison); await repo.commit(poison, current.revision);
      const stored = await repo.load(companyId); assert.equal(stored.contentHash, canonicalHash(poison)); assert.throws(() => validateAccounts(stored.snapshot), /evidence/);
      await repo.commit(structuredClone(db), stored.revision);
    }
    await assert.rejects(repo.load('b0576860-a3d9-4bb6-aae2-b5e7186cbb71'), /unavailable/);
    const key = crypto.randomBytes(32), messages = [], delivery = createCredentialDelivery({ key, origin: 'http://127.0.0.1:4009', load: id => repo.load(id), commit: (...args) => repo.commit(...args), send: async value => { messages.push(value); return { accepted: true }; } });
    let loaded = await repo.load(companyId), queued = delivery.requestReset(loaded.snapshot, 'native@example.invalid'); await repo.commit(loaded.snapshot, loaded.revision);
    assert.equal((await delivery.dispatch(companyId, queued.jobId)).status, 'sent'); assert.equal(messages.length, 1);
    const token = new URL(messages[0].resetUrl).searchParams.get('token'); assert.equal(JSON.stringify((await repo.load(companyId)).snapshot).includes(token), false);
    loaded = await repo.load(companyId); const authorized = delivery.authorizeReset(loaded.snapshot, 'native@example.invalid', token); assert.ok(authorized); delivery.consumeReset(loaded.snapshot, authorized.user); await repo.commit(loaded.snapshot, loaded.revision, { deadline: authorized.deadline });
    assert.equal(delivery.authorizeReset((await repo.load(companyId)).snapshot, 'native@example.invalid', token), null);
    // Recomputed snapshot hash does not legitimize copied/ambiguous custody.
    loaded = await repo.load(companyId); queued = delivery.requestReset(loaded.snapshot, 'native@example.invalid'); const clone = structuredClone(loaded.snapshot[COLLECTION].at(-1)); clone.id = crypto.randomUUID(); loaded.snapshot[COLLECTION].push(clone); await repo.commit(loaded.snapshot, loaded.revision);
    await assert.rejects(delivery.dispatch(companyId, queued.jobId), /recovery/); assert.equal(messages.length, 1);
    loaded = await repo.load(companyId); loaded.snapshot[COLLECTION].pop(); await repo.commit(loaded.snapshot, loaded.revision);
    // Two independent processes cannot restore access from a stale snapshot.
    for (let index = 0; index < 2; index++) children.push(fork(__filename, ['worker'], { env: { ...process.env, TEST_COMPAT_DATABASE_URL: connectionString }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true }));
    assert.equal((await next(children[0], { action: 'load' })).event, 'loaded'); assert.equal((await next(children[1], { action: 'load' })).event, 'loaded');
    assert.equal((await next(children[0], { action: 'commit', kind: 'revoke' })).event, 'committed'); const stale = await next(children[1], { action: 'commit', kind: 'action' }); assert.deepEqual(stale, { event: 'rejected', code: 'PDL_REVISION_CONFLICT' });
    loaded = await repo.load(companyId); assert.equal(loaded.snapshot.users[0].status, 'Inactive'); assert.equal(loaded.snapshot.company.syntheticActionMarker, undefined);
    // Guard is checked after acquiring the real database lock, not before wait.
    const locker = await admin.connect();
    try {
      await locker.query('BEGIN'); await locker.query('SELECT revision FROM public.tenant_revisions WHERE company_id=$1 FOR UPDATE', [companyId]);
      const deadline = new Date(Date.now() + 150).toISOString(), candidate = structuredClone(loaded.snapshot); candidate.company.syntheticExpiredMarker = true;
      const waiting = repo.commit(candidate, loaded.revision, { deadline });
      const observed = waiting.then(() => ({ accepted: true }), error => ({ code: error.code }));
      await new Promise(resolve => setTimeout(resolve, 300)); await locker.query('COMMIT');
      assert.deepEqual(await observed, { code: 'PDL_REVISION_CONFLICT' }); assert.equal((await repo.load(companyId)).snapshot.company.syntheticExpiredMarker, undefined);
    } finally { await locker.query('ROLLBACK').catch(() => {}); locker.release(); }
    console.log('Compatibility native PostgreSQL: exact shape, private credential lifecycle, poisoned custody, two-process revocation, privilege and after-lock expiry checks passed.');
  } finally {
    for (const child of children) { if (child.connected) child.send({ action: 'close' }); }
    await Promise.all(children.map(child => new Promise(resolve => { if (!child.pid || child.exitCode !== null) return resolve(); child.once('exit', resolve); setTimeout(() => { if (child.exitCode === null) child.kill(); }, 3000); })));
    await repo.close(); await admin.end();
  }
}
(process.argv[2] === 'worker' ? worker() : main()).catch(error => { console.error(error); process.exitCode = 1; });
