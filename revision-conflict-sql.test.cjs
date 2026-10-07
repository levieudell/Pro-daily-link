'use strict';

// Entirely local PostgreSQL (PGlite), synthetic data, no network or env loading.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
// CI installs the pinned WASM test runtime into runner temp, outside app dependencies.
// No DATABASE_URL, application configuration or environment file is loaded.
if (!process.env.PDL_SQL_TEST_RUNTIME) throw new Error('Set PDL_SQL_TEST_RUNTIME to the isolated PGlite test-runtime directory.');
const { PGlite } = require(path.join(process.env.PDL_SQL_TEST_RUNTIME, 'node_modules/@electric-sql/pglite'));
const fresh = fs.readFileSync(path.join(__dirname, 'database/007_transactional_records.sql'), 'utf8');
const migration = fs.readFileSync(path.join(__dirname, 'database/008_revision_conflict_http.sql'), 'utf8');
const productionMigration = fs.readFileSync(path.join(__dirname, 'database/incidents/2026-10-07_revision_conflict_http.sql'), 'utf8');
const liveDefinition = fs.readFileSync(path.join(__dirname, 'fixtures/replace-tenant-records-live-before.sql'), 'utf8');
const identity = 'public.replace_tenant_records(uuid,bigint,jsonb,text,jsonb)';
const tenant = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const oldClause = "USING ERRCODE = '40001';";
const newClause = "USING ERRCODE = 'PT409';";
assert.equal(fresh.split(newClause).length - 1, 1, 'fresh source declares exactly one HTTP conflict clause');
assert(!fresh.includes(oldClause), 'fresh source must not restore the retry-triggering conflict code');
const original = fresh.replace(newClause,oldClause);

async function setup(sql) {
  const db = new PGlite();
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE TABLE public.companies(id uuid PRIMARY KEY);
    CREATE FUNCTION public.app_company_id() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;`);
  await db.exec(sql);
  await db.query('INSERT INTO companies(id) VALUES ($1), ($2)', [tenant, other]);
  return db;
}
async function save(db, expected, label, id=tenant) {
  return db.query('SELECT * FROM public.replace_tenant_records($1,$2,$3::jsonb,$4,$5::jsonb)',
    [id, expected, JSON.stringify({company:{id},label}), `hash-${label}`,
      JSON.stringify([{collection:'reports',record_key:'id:1',position:0,data:{id:1,label}}])]);
}
async function state(db) {
  return (await db.query(`SELECT * FROM (SELECT 'revision' AS kind, to_jsonb(r) AS data FROM tenant_revisions r
    UNION ALL SELECT 'record', to_jsonb(r) FROM tenant_records r) s ORDER BY kind,data::text`)).rows;
}
async function definition(db) {
  return (await db.query('SELECT pg_get_functiondef($1::regprocedure) AS body', [identity])).rows[0].body;
}
async function privileges(db) {
  return (await db.query(`SELECT proowner::regrole::text AS owner, prosecdef, proconfig, proacl::text,
    has_function_privilege('anon',oid,'EXECUTE') AS anon,
    has_function_privilege('authenticated',oid,'EXECUTE') AS authenticated,
    has_function_privilege('service_role',oid,'EXECUTE') AS service
    FROM pg_proc WHERE oid=$1::regprocedure`, [identity])).rows[0];
}
async function rejectsWith(db, expected, code) {
  await assert.rejects(save(db, expected, 'stale'), error => {
    assert.equal(error.code, code);
    assert.match(error.message, /PDL_REVISION_CONFLICT expected=0 actual=1/);
    return true;
  });
}

(async () => {
  const db = await setup(original);
  try {
    assert.equal((await save(db,0,'original')).rows[0].revision,1);
    assert.equal((await save(db,0,'other-tenant',other)).rows[0].revision,1);
    const beforeData = await state(db), beforeDefinition = await definition(db), beforePrivileges = await privileges(db);
    assert.deepEqual([beforePrivileges.anon,beforePrivileges.authenticated,beforePrivileges.service],[false,false,true]);
    await rejectsWith(db,0,'40001');
    assert.deepEqual(await state(db),beforeData, 'baseline conflict rolls back all rows');
    await db.exec(migration);
    assert.equal(await definition(db),beforeDefinition.replace(oldClause,newClause), 'upgrade changes only SQLSTATE in installed body');
    assert.deepEqual(await privileges(db),beforePrivileges, 'owner, SECURITY DEFINER, settings and grants preserved');
    assert.deepEqual(await state(db),beforeData, 'upgrade changes no tenant data');
    await rejectsWith(db,0,'PT409');
    assert.deepEqual(await state(db),beforeData, 'PT409 stale write rolls back all rows and leaves other tenant intact');
    const migratedDefinition=await definition(db);
    await db.exec(migration);
    assert.equal(await definition(db),migratedDefinition, 'upgrade is idempotent');
    assert.equal((await save(db,1,'accepted')).rows[0].revision,2, 'matching revision still commits');
    const changed = beforeDefinition.replace('PDL_REVISION_CONFLICT expected=% actual=%','DIFFERENT_CONFLICT expected=% actual=%');
    await db.exec(changed);
    const driftedDefinition=await definition(db), driftedData=await state(db);
    await assert.rejects(db.exec(migration), /expected exception clause was not found/);
    await db.exec('ROLLBACK;');
    assert.equal(await definition(db),driftedDefinition, 'unexpected installed code fails closed');
    assert.deepEqual(await state(db),driftedData, 'failed migration changes no data');
  } finally { await db.close(); }
  const freshDb=await setup(fresh);
  try {
    assert.equal((await save(freshDb,0,'first')).rows[0].revision,1);
    await rejectsWith(freshDb,0,'PT409');
  } finally { await freshDb.close(); }
  const liveDb=await setup(original);
  try {
    await liveDb.exec(liveDefinition);
    const fingerprint=(await liveDb.query(`SELECT md5(pg_get_functiondef(oid)) AS definition,
      md5(prosrc) AS body FROM pg_proc WHERE oid=$1::regprocedure`,[identity])).rows[0];
    assert.deepEqual(fingerprint,{definition:'42754c22067175058ce461c883b566f5',body:'ddf8908236dab9994ca44522abbbfd73'},'local fixture reproduces exact captured live function fingerprints');
    const initialPrivileges=await privileges(liveDb);
    assert.equal(initialPrivileges.owner,'postgres');
    assert.equal(initialPrivileges.proacl,'{postgres=X/postgres,service_role=X/postgres}');
    assert.equal((await save(liveDb,0,'live-fixture')).rows[0].revision,1);
    const before=await state(liveDb), beforeBody=await definition(liveDb);
    await liveDb.exec(`PREPARE incident_stale AS SELECT * FROM public.replace_tenant_records(
      '${tenant}'::uuid,0::bigint,'{}'::jsonb,'prepared-fixture','[]'::jsonb);`);
    await assert.rejects(liveDb.exec('EXECUTE incident_stale;'),error=>error.code==='40001');
    await liveDb.exec(`GRANT EXECUTE ON FUNCTION ${identity} TO authenticated;`);
    await assert.rejects(liveDb.exec(productionMigration),/ownership, settings or grants differ/);
    await liveDb.exec('ROLLBACK;');
    assert.equal(await definition(liveDb),beforeBody,'grant drift causes no function change');
    await liveDb.exec(`REVOKE EXECUTE ON FUNCTION ${identity} FROM authenticated;`);
    await liveDb.exec(productionMigration);
    const afterBody=await definition(liveDb);
    assert.equal(afterBody,beforeBody.replace(oldClause,newClause),'production script makes exact one-clause change');
    assert.deepEqual(await state(liveDb),before,'production script changes no tenant data');
    assert.deepEqual(await privileges(liveDb),initialPrivileges,'production script preserves exact owner and grants');
    await assert.rejects(liveDb.exec('EXECUTE incident_stale;'),error=>error.code==='PT409');
    assert.deepEqual(await state(liveDb),before,'same prepared statement picks up new SQLSTATE and still rolls back');
    await liveDb.exec(productionMigration);
    assert.equal(await definition(liveDb),afterBody,'production script no-op accepts exact patched fingerprint');
    await liveDb.exec(`GRANT EXECUTE ON FUNCTION ${identity} TO authenticated;`);
    await assert.rejects(liveDb.exec(productionMigration),/ownership, settings or grants differ/);
    await liveDb.exec('ROLLBACK;');
    await liveDb.exec(`REVOKE EXECUTE ON FUNCTION ${identity} FROM authenticated;`);
    await liveDb.exec(afterBody.replace('next_revision := current_revision + 1;','next_revision := current_revision + 2;'));
    await assert.rejects(liveDb.exec(productionMigration),/definition fingerprint differs/);
    await liveDb.exec('ROLLBACK;');
    assert.deepEqual(await state(liveDb),before,'patched-body drift refusal changes no tenant data');
  } finally { await liveDb.close(); }
  console.log('PASS: local PostgreSQL conflict rollback, matching-revision commit, tenant isolation, exact body delta, permissions/settings preservation, idempotency, drift refusal, fresh install; captured production fingerprints, strict guarded migration and same-session prepared-statement invalidation.');
})().catch(error=>{ console.error(error); process.exitCode=1; });
