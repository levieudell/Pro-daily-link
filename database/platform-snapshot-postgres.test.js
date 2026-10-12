'use strict';
// This test refuses every destination except an explicitly named generated
// loopback PostgreSQL database. It never drops or resets an existing schema.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), { Client } = require('pg');
const { PLATFORM_ID, PLATFORM_NAME, createRepository } = require('./platform-snapshot-repository');
const { emptyLedger, createSharedStore, createBudget } = require('../project-assistant-budget');
const { canonicalHash, assembleSnapshot } = require('./transactional-repository');
const url = process.env.TEST_PLATFORM_DATABASE_URL;
if (!url || !/^postgresql:\/\/postgres@127\.0\.0\.1:\d+\/pdl_platform_authority_synthetic_[a-z0-9_]+$/.test(url)) throw Error('Explicit fresh owned synthetic database required.');
const TENANT = 'a0527b09-7132-4e31-84f8-41ff6512a41b', OTHER = '3739d05a-f03b-45e8-8fb8-a10db90d21ec';
const snapshot = () => ({ company: { id: PLATFORM_ID, name: PLATFORM_NAME }, platform: { users: [{ id: 1, role: 'platform_owner', status: 'Active' }], auditEvents: [] } });
const tenantSnapshot = () => ({ company: { id: TENANT, name: 'Generated tenant', features: { templates: false } }, users: [{ id: 1, role: 'owner', status: 'Active' }] });
const connect = async role => { const client = new Client({ connectionString: url }); await client.connect(); if (role) await client.query('SET ROLE service_role'); return client; };
const bounded = pending => Promise.race([pending, new Promise((_, reject) => { const timer = setTimeout(() => reject(Error('Synthetic lock test timed out')), 10000); timer.unref(); })]);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const checks = [];
async function waitingOnLock(observer, client) {
  const until = Date.now() + 5000;
  while (Date.now() < until) {
    const state = await observer.query('SELECT wait_event_type FROM pg_catalog.pg_stat_activity WHERE pid=$1', [client.processID]);
    if (state.rows[0]?.wait_event_type === 'Lock') return;
    await wait(20);
  }
  throw Error('Owned synthetic writer did not reach its actual database lock wait.');
}
async function main() {
  const admin = await connect(), service = await connect();
  const platformCommit = (client, revision, value = snapshot(), deadline = new Date(Date.now() + 10000).toISOString()) => client.query('SELECT * FROM public.commit_platform_snapshot($1,$2,$3,$4)', [PLATFORM_ID, revision, value, deadline]);
  const tenantCommit = (client, platformRevision, rolesRevision, value = tenantSnapshot(), deadline = new Date(Date.now() + 10000).toISOString()) => client.query('SELECT * FROM public.commit_roles_snapshot_with_platform($1,$2,$3,$4,$5,$6)', [TENANT, rolesRevision, value, deadline, PLATFORM_ID, platformRevision]);
  const platformState = async () => (await admin.query('SELECT data,platform_revision,platform_managed,roles_managed FROM public.companies WHERE id=$1', [PLATFORM_ID])).rows[0];
  const tenantState = async () => (await admin.query('SELECT data,roles_revision FROM public.companies WHERE id=$1', [TENANT])).rows[0];
  const denied = async (client, sql, args, code) => { await assert.rejects(client.query(sql, args), error => error.code === code); };
  try {
    await admin.query("DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF; IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF; IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role; END IF; END $$; CREATE TABLE public.companies(id uuid PRIMARY KEY,slug text,name text NOT NULL,data jsonb NOT NULL); CREATE FUNCTION public.app_company_id() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.company_id',true),'')::uuid $$");
    for (const name of ['007_transactional_records.sql', '008_require_explicit_revision.sql', '009_roles_snapshot_authority.sql', '010_platform_snapshot_authority.sql']) await admin.query(fs.readFileSync(path.join(__dirname, name), 'utf8'));
    await admin.query('GRANT SELECT,INSERT,UPDATE,DELETE ON public.companies,public.tenant_records,public.tenant_revisions TO service_role; GRANT USAGE ON SCHEMA public TO service_role; ALTER ROLE service_role BYPASSRLS');
    for (const [id, value] of [[PLATFORM_ID, snapshot()], [TENANT, tenantSnapshot()], [OTHER, { company: { id: OTHER, name: 'Generated ordinary company' } }]]) await admin.query('INSERT INTO public.companies(id,slug,name,data) VALUES($1,$2,$3,$4)', [id, 'synthetic-' + id, value.company.name, value]);
    await service.query('SET ROLE service_role');
    const off = await platformState(); assert.equal(off.platform_managed, false); assert.equal(Number(off.platform_revision), 0); assert.equal(off.roles_managed, false);
    await service.query('UPDATE public.companies SET data=$2 WHERE id=$1', [PLATFORM_ID, snapshot()]);
    await denied(service, 'SELECT * FROM public.commit_platform_snapshot($1,0,$2,clock_timestamp()+interval \'5 seconds\')', [PLATFORM_ID, snapshot()], '23514');
    await service.query('UPDATE public.companies SET name=$2 WHERE id=$1', [OTHER, 'Ordinary legacy write unchanged']);
    checks.push('flag-off preserves existing platform/ordinary full-snapshot writers and managed RPC stays closed');
    await admin.query('UPDATE public.companies SET platform_managed=true WHERE id=$1', [PLATFORM_ID]);
    await admin.query('UPDATE public.companies SET roles_managed=true WHERE id=$1', [TENANT]);
    await denied(admin, 'UPDATE public.companies SET platform_managed=true WHERE id=$1', [OTHER], '23514');
    await denied(service, 'UPDATE public.companies SET data=$2 WHERE id=$1', [PLATFORM_ID, { ...snapshot(), platform: { oldFullSave: true } }], '23514');
    await denied(service, 'UPDATE public.companies SET data=data WHERE id=$1', [PLATFORM_ID], '23514');
    await denied(service, 'INSERT INTO public.companies(id,slug,name,data) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO UPDATE SET slug=EXCLUDED.slug,name=EXCLUDED.name,data=EXCLUDED.data', [PLATFORM_ID, 'old-upsert', PLATFORM_NAME, snapshot()], '23514');
    await denied(service, 'DELETE FROM public.companies WHERE id=$1', [PLATFORM_ID], '23514');
    await denied(service, 'UPDATE public.companies SET platform_managed=false WHERE id=$1', [PLATFORM_ID], '23514');
    await service.query('BEGIN'); await service.query("SELECT set_config('app.platform_snapshot_commit',$1,true),set_config('app.platform_snapshot_deadline',(clock_timestamp()+interval '5 seconds')::text,true)", [PLATFORM_ID]);
    await denied(service, 'UPDATE public.companies SET platform_revision=platform_revision+1,data=$2 WHERE id=$1', [PLATFORM_ID, snapshot()], '23514'); await service.query('ROLLBACK');
    checks.push('managed legacy full UPDATE/upsert/DELETE/flag-off and spoofed-marker writes denied');
    await platformCommit(service, 0); assert.equal(Number((await platformState()).platform_revision), 1);
    const one = await connect(true), two = await connect(true);
    try { const outcomes = await bounded(Promise.allSettled([one, two].map(client => platformCommit(client, 1)))); assert.equal(outcomes.filter(row => row.status === 'fulfilled').length, 1); assert.equal(outcomes.find(row => row.status === 'rejected').reason.code, '40001'); } finally { await one.end(); await two.end(); }
    assert.equal(Number((await platformState()).platform_revision), 2); checks.push('platform CAS permits one concurrent winner');
    await service.query('BEGIN'); await platformCommit(service, 2, snapshot(), new Date(Date.now() + 120).toISOString()); await wait(180); await denied(service, 'COMMIT', [], '40001');
    assert.equal(Number((await platformState()).platform_revision), 2); checks.push('original deadline at actual COMMIT rolls back staged platform changes');
    const queued = await connect(true); try { await admin.query('BEGIN'); await admin.query('SELECT id FROM public.companies WHERE id=$1 FOR UPDATE', [PLATFORM_ID]); const pending = platformCommit(queued, 2, snapshot(), new Date(Date.now() + 120).toISOString()).then(value => ({ value }), error => ({ error })); await waitingOnLock(admin, queued); await wait(180); await admin.query('COMMIT'); assert.equal((await bounded(pending)).error.code, '40001'); } finally { await admin.query('ROLLBACK'); await queued.end(); }
    assert.equal(Number((await platformState()).platform_revision), 2); checks.push('deadline is checked after waiting for the actual platform row lock');
    for (const trigger of ['platform_snapshot_writer', 'platform_snapshot_deadline']) { await admin.query('ALTER TABLE public.companies DISABLE TRIGGER ' + trigger); await assert.rejects(platformCommit(service, 2), error => error.code === '23514'); await admin.query('ALTER TABLE public.companies ENABLE TRIGGER ' + trigger); }
    for (const mode of ['missing', 'wrong-event', 'conditional', 'wrong-function', 'not-deferred']) {
      await admin.query('DROP TRIGGER platform_snapshot_deadline ON public.companies');
      if (mode !== 'missing') await admin.query((mode === 'not-deferred' ? 'CREATE TRIGGER' : 'CREATE CONSTRAINT TRIGGER') + ' platform_snapshot_deadline AFTER ' + (mode === 'wrong-event' ? 'DELETE' : 'UPDATE') + ' ON public.companies ' + (mode === 'not-deferred' ? '' : 'DEFERRABLE INITIALLY DEFERRED ') + 'FOR EACH ROW ' + (mode === 'conditional' ? 'WHEN (false) ' : '') + 'EXECUTE FUNCTION public.' + (mode === 'wrong-function' ? 'roles_snapshot_deadline_guard' : 'platform_snapshot_deadline_guard') + '()');
      await assert.rejects(platformCommit(service, 2), error => error.code === '23514');
      await assert.rejects(tenantCommit(service, 2, 0), error => error.code === '23514');
      await admin.query('DROP TRIGGER IF EXISTS platform_snapshot_deadline ON public.companies; CREATE CONSTRAINT TRIGGER platform_snapshot_deadline AFTER UPDATE ON public.companies DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.platform_snapshot_deadline_guard()');
    }
    checks.push('missing, disabled, wrong-event/function, conditional or non-deferred exact platform trigger contracts fail closed');
    const migration = fs.readFileSync(path.join(__dirname, '010_platform_snapshot_authority.sql'), 'utf8');
    await admin.query('GRANT CREATE ON SCHEMA public TO service_role');
    for (const sql of [
      'ALTER FUNCTION public.platform_snapshot_writer_guard() SET search_path=public',
      'ALTER FUNCTION public.platform_snapshot_deadline_guard() SECURITY DEFINER',
      'ALTER FUNCTION public.commit_platform_snapshot(uuid,bigint,jsonb,timestamptz) SECURITY INVOKER',
      'ALTER FUNCTION public.commit_roles_snapshot_with_platform(uuid,bigint,jsonb,timestamptz,uuid,bigint) SET search_path=public',
      'GRANT EXECUTE ON FUNCTION public.commit_platform_snapshot(uuid,bigint,jsonb,timestamptz) TO authenticated',
      'GRANT EXECUTE ON FUNCTION public.commit_roles_snapshot_with_platform(uuid,bigint,jsonb,timestamptz,uuid,bigint) TO service_role WITH GRANT OPTION',
      'ALTER FUNCTION public.platform_snapshot_envelope_valid(uuid,jsonb) OWNER TO service_role',
      "CREATE OR REPLACE FUNCTION public.platform_snapshot_envelope_valid(p_id uuid,p_snapshot jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$ BEGIN RETURN true; END $$"
    ]) {
      await admin.query(sql); const before = await platformState();
      assert.equal((await admin.query('SELECT public.platform_snapshot_trigger_contract() AS ready')).rows[0].ready, false);
      await assert.rejects(platformCommit(service, 2), error => ['23514', '42501'].includes(error.code));
      await assert.rejects(tenantCommit(service, 2, 0), error => ['23514', '42501'].includes(error.code));
      assert.deepEqual(await platformState(), before);
      await admin.query('ALTER FUNCTION public.platform_snapshot_envelope_valid(uuid,jsonb) OWNER TO postgres');
      await admin.query(migration);
    }
    for (const sql of [
      'ALTER FUNCTION public.commit_roles_snapshot(uuid,bigint,jsonb,timestamptz) SET search_path=pg_catalog',
      'ALTER FUNCTION public.roles_snapshot_writer_guard() SECURITY DEFINER',
      'GRANT EXECUTE ON FUNCTION public.commit_roles_snapshot(uuid,bigint,jsonb,timestamptz) TO anon'
    ]) {
      await admin.query(sql); const before = await tenantState();
      assert.equal((await admin.query('SELECT public.platform_snapshot_tenant_contract() AS ready')).rows[0].ready, false);
      await assert.rejects(tenantCommit(service, 2, 0), error => error.code === '23514'); assert.deepEqual(await tenantState(), before);
      await admin.query(fs.readFileSync(path.join(__dirname, '009_roles_snapshot_authority.sql'), 'utf8'));
    }
    checks.push('installed function language, definer, pinned path, owner and RPC execution ACL drift fails closed; 009 dependency metadata checked without a body-fingerprint claim');
    for (const role of ['anon', 'authenticated']) { await service.query('RESET ROLE; SET ROLE ' + role); await assert.rejects(platformCommit(service, 2), error => error.code === '42501'); await assert.rejects(tenantCommit(service, 2, 0), error => error.code === '42501'); }
    await service.query('RESET ROLE; SET ROLE service_role'); checks.push('both commit RPCs execute only under the reviewed service role');
    await tenantCommit(service, 2, 0); assert.equal(Number((await tenantState()).roles_revision), 1);
    const revoked = snapshot(); revoked.platform.users[0].status = 'Inactive'; await platformCommit(service, 2, revoked);
    const tenantBefore = await tenantState(); await assert.rejects(tenantCommit(service, 2, 1), error => error.code === '40001'); assert.deepEqual(await tenantState(), tenantBefore);
    checks.push('revoked platform revision invalidates tenant commit without modifying the tenant');
    await platformCommit(service, 3, snapshot());
    const revoker = await connect(true); try { await service.query('BEGIN'); await tenantCommit(service, 4, 1); let finished = false; const revoke = platformCommit(revoker, 4, revoked).then(value => { finished = true; return value; }); await waitingOnLock(admin, revoker); assert.equal(finished, false); await service.query('COMMIT'); await bounded(revoke); } finally { await service.query('ROLLBACK'); await revoker.end(); }
    assert.equal(Number((await tenantState()).roles_revision), 2); checks.push('platform revocation waits until an already authorized tenant transaction commits');
    await platformCommit(service, 5, snapshot());
    const rolesBefore = await tenantState(); await service.query('BEGIN'); await tenantCommit(service, 6, 2, tenantSnapshot(), new Date(Date.now() + 120).toISOString()); await wait(180); await denied(service, 'COMMIT', [], '40001'); assert.deepEqual(await tenantState(), rolesBefore);
    checks.push('cross-store tenant changes retain the original deadline through actual deferred COMMIT');
    await denied(service, 'SELECT * FROM public.commit_roles_snapshot_with_platform($1,0,$2,clock_timestamp()+interval \'5 seconds\',$1,6)', [PLATFORM_ID, snapshot()], '22023');
    await denied(service, 'SELECT * FROM public.commit_platform_snapshot($1,0,$2,clock_timestamp()+interval \'5 seconds\')', [TENANT, tenantSnapshot()], '22023');
    checks.push('dedicated platform identity/envelope cannot be replaced by a tenant snapshot');

    // Exercise the real assistant budget adapter against the same UUID. The
    // synthetic transport performs only its known SELECT and conditional PATCH.
    const scalar = { assistantUsage: emptyLedger(), preservedScalar: 'Synthetic unchanged budget namespace' };
    await admin.query('INSERT INTO public.tenant_revisions(company_id,revision,scalar_data,content_hash) VALUES($1,0,$2,$3)', [PLATFORM_ID, scalar, canonicalHash(scalar)]);
    await service.query("INSERT INTO public.tenant_records(company_id,collection,record_key,position,data) VALUES($1,'budgetFixture','id:1',0,$2)", [PLATFORM_ID, { id: 1, retained: true }]);
    const recordRows = [{ collection: 'budgetFixture', position: 0, data: { id: 1, retained: true } }];
    await service.query('UPDATE public.tenant_revisions SET content_hash=$2 WHERE company_id=$1', [PLATFORM_ID, canonicalHash(assembleSnapshot(scalar, recordRows))]);
    const budgetTransport = { configured: () => true, async request(route, options) {
      if (!options?.method) { assert.ok(route.startsWith('/rest/v1/companies?id=eq.' + PLATFORM_ID + '&select=id,tenant_revisions')); const revision = (await service.query('SELECT revision,scalar_data,content_hash FROM public.tenant_revisions WHERE company_id=$1', [PLATFORM_ID])).rows[0]; return { json: async () => [{ id: PLATFORM_ID, tenant_revisions: revision, tenant_records: recordRows }] }; }
      assert.equal(options.method, 'PATCH'); const expected = Number(new URL('http://localhost' + route).searchParams.get('revision').slice(3)), next = JSON.parse(options.body);
      const updated = await service.query('UPDATE public.tenant_revisions SET revision=$3,scalar_data=$4,content_hash=$5,updated_at=$6 WHERE company_id=$1 AND revision=$2 RETURNING revision', [PLATFORM_ID, expected, next.revision, next.scalar_data, next.content_hash, next.updated_at]); return { json: async () => updated.rows };
    } };
    const beforeBudget = await platformState(), budget = createBudget(createSharedStore(budgetTransport), () => new Date('2026-10-12T12:00:00.000Z'));
    const reservation = await budget.reserve({ companyId: TENANT, userId: 1, sessionId: 'synthetic-session', turnId: 'synthetic-turn', fingerprint: 'synthetic-fingerprint', cost: 100 });
    const settled = await budget.settle(reservation, 40, { status: 'synthetic-only' }); assert.equal(settled.cost, 40); assert.equal(settled.status, 'complete');
    const budgetState = (await service.query('SELECT revision,scalar_data FROM public.tenant_revisions WHERE company_id=$1', [PLATFORM_ID])).rows[0]; assert.equal(Number(budgetState.revision), 2); assert.equal(budgetState.scalar_data.preservedScalar, scalar.preservedScalar); assert.deepEqual(await platformState(), beforeBudget);
    assert.equal(Number((await service.query('SELECT count(*)::int AS n FROM public.tenant_records WHERE company_id=$1', [PLATFORM_ID])).rows[0].n), 1);
    checks.push('real assistant reserve/settle and record writes under the same UUID remain disjoint and writable');
    const nativeTransport = { async request(route, options) {
      if (route === '/rest/v1/rpc/platform_snapshot_trigger_contract') return { json: async () => (await service.query('SELECT public.platform_snapshot_trigger_contract() AS ready')).rows[0].ready };
      if (!options) { assert.ok(route.includes('platform_revision,platform_managed,roles_managed')); return { json: async () => [{ id: PLATFORM_ID, ...(await platformState()) }] }; }
      const payload = JSON.parse(options.body); const saved = await service.query('SELECT * FROM public.commit_platform_snapshot($1,$2,$3,$4)', [payload.p_platform_id, payload.p_expected_revision, payload.p_snapshot, payload.p_deadline]); return { json: async () => saved.rows };
    } };
    const repository = createRepository(nativeTransport, PLATFORM_ID), current = await repository.load(); assert.equal(current.contentHash, canonicalHash(current.snapshot)); const committed = await repository.commit(current.snapshot, current.revision, { deadline: new Date(Date.now() + 10000).toISOString() }); assert.equal(committed.revision, current.revision + 1);
    await admin.query('ALTER FUNCTION public.platform_snapshot_writer_guard() SET search_path=public'); await assert.rejects(repository.load(), error => error.code === 'PDL_PLATFORM_STORAGE'); await admin.query(migration);
    checks.push('fully seeded repository read fails closed on installed-contract drift without any business write');
    checks.push('repository reads fresh native flag/revision/hash and commits the dedicated envelope through its RPC');
    const waiter = await connect(true);
    try {
      const currentPlatform = Number((await platformState()).platform_revision), currentTenant = Number((await tenantState()).roles_revision), oldTenant = await tenantState();
      await admin.query('BEGIN'); await admin.query('SELECT id FROM public.companies WHERE id=$1 FOR UPDATE', [PLATFORM_ID]);
      const pending = tenantCommit(waiter, currentPlatform, currentTenant).then(value => ({ value }), error => ({ error }));
      await waitingOnLock(admin, waiter);
      await platformCommit(admin, currentPlatform, revoked); await admin.query('COMMIT');
      assert.equal((await bounded(pending)).error.code, '40001'); assert.deepEqual(await tenantState(), oldTenant);
    } finally { await admin.query('ROLLBACK'); await waiter.end(); }
    checks.push('revocation committed while a tenant writer waits for platform SHARE is checked after that actual wait');
    const tenantWaiter = await connect(true);
    try {
      const currentPlatform = Number((await platformState()).platform_revision), currentTenant = Number((await tenantState()).roles_revision), oldTenant = await tenantState();
      await admin.query('BEGIN'); await admin.query('SELECT id FROM public.companies WHERE id=$1 FOR UPDATE', [TENANT]);
      const pending = tenantCommit(tenantWaiter, currentPlatform, currentTenant, tenantSnapshot(), new Date(Date.now() + 120).toISOString()).then(value => ({ value }), error => ({ error }));
      await waitingOnLock(admin, tenantWaiter);
      await wait(180); await admin.query('ROLLBACK'); assert.equal((await bounded(pending)).error.code, '40001'); assert.deepEqual(await tenantState(), oldTenant);
    } finally { await admin.query('ROLLBACK'); await tenantWaiter.end(); }
    checks.push('cross-store original deadline is also checked after the tenant row lock wait');
    console.log(JSON.stringify({ nativePlatformAuthority: checks, passed: checks.length, backend: 'owned-native-postgresql', initializesOrActivatesProduction: false, externalCalls: 0 }));
  } finally { await service.end(); await admin.end(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
