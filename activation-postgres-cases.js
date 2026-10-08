'use strict';
const assert = require('node:assert/strict');
const { companyA, companyB } = require('./fixtures/project-assistant');
module.exports = async function ({ repository, request, startWorker, pool, controls, providerEvents, photoEvents }) {
  const before = await repository.load(companyA), foreign = await repository.load(companyB), providers=providerEvents.length, objects=photoEvents.length;
  const probe = async () => (await pool.query('SELECT * FROM public.tenant_atomic_readiness($1)',[companyA])).rows[0];
  assert.deepEqual(await probe(),{protocol_version:1,initialized:true,mandatory_revision:true,guarded_policy:true,service_only:true,forced_rls:true});
  for(const role of ['anon','authenticated']) {
    const client=await pool.connect();try{await client.query('SET ROLE '+role);await assert.rejects(client.query('SELECT * FROM public.tenant_atomic_readiness($1)',[companyA]),/permission denied/);}finally{await client.query('RESET ROLE');client.release();}
  }
  const mutations=[
    ["ALTER FUNCTION public.replace_tenant_records(uuid,bigint,jsonb,text,jsonb) RESET ALL",'service_only'],
    ["ALTER FUNCTION public.replace_tenant_policy_records(uuid,bigint,jsonb,text,jsonb,jsonb) RESET ALL",'service_only'],
    ["ALTER FUNCTION public.replace_tenant_records(uuid,bigint,jsonb,text,jsonb) SET search_path = alternate_schema, public",'service_only'],
    ["ALTER FUNCTION public.replace_tenant_policy_records(uuid,bigint,jsonb,text,jsonb,jsonb) SET search_path = pg_catalog, public",'service_only'],
    ["ALTER FUNCTION public.replace_tenant_records(uuid,bigint,jsonb,text,jsonb) SECURITY INVOKER",'service_only'],
    ["GRANT EXECUTE ON FUNCTION public.replace_tenant_policy_records(uuid,bigint,jsonb,text,jsonb,jsonb) TO PUBLIC",'service_only'],
    ["REVOKE EXECUTE ON FUNCTION public.replace_tenant_records(uuid,bigint,jsonb,text,jsonb) FROM service_role",'service_only'],
    ["ALTER TABLE public.tenant_records NO FORCE ROW LEVEL SECURITY",'forced_rls']
  ];
  for(const [sql,key] of mutations){const client=await pool.connect();try{await client.query('BEGIN');await client.query(sql);const result=(await client.query('SELECT * FROM public.tenant_atomic_readiness($1)',[companyA])).rows[0];assert.equal(result[key],false,key);}finally{await client.query('ROLLBACK');client.release();}}
  for(const [signature,key] of [['public.replace_tenant_records(uuid,bigint,jsonb,text,jsonb)','mandatory_revision'],['public.replace_tenant_policy_records(uuid,bigint,jsonb,text,jsonb,jsonb)','guarded_policy']]){
    const client=await pool.connect();try{await client.query('BEGIN');const definition=(await client.query('SELECT pg_get_functiondef($1::regprocedure) AS definition',[signature])).rows[0].definition;await client.query(definition.replace('BEGIN','BEGIN\n-- synthetic changed body'));assert.equal((await client.query('SELECT * FROM public.tenant_atomic_readiness($1)',[companyA])).rows[0][key],false);}finally{await client.query('ROLLBACK');client.release();}
  }
  assert.equal((await probe()).service_only,true);
  const bound=await startWorker({companyId:companyA}); controls.tenantLookups=[];
  for(const [method,path,input] of [['GET','/api/navigation',undefined],['POST','/api/projects/101/notes-todos',{kind:'note',text:'Foreign header',requestId:'foreign-header-request'}]]) assert.equal((await request(bound,method,path,input,1,companyB,companyB)).status,401);
  assert.deepEqual(controls.tenantLookups,[],'Foreign process target must be denied before authoritative lookup');
  assert.equal((await request(bound,'GET','/api/navigation',undefined,1,companyA,companyB)).status,401);
  assert.ok(controls.tenantLookups.every(id=>id===companyA)); controls.tenantLookups=[];
  assert.equal((await request(bound,'POST','/api/projects/101/notes-todos',{companyId:companyB,kind:'note',text:'Forged body',requestId:'foreign-body-request'})).status,400);
  assert.deepEqual(controls.tenantLookups,[]);
  const mismatch=await fetch(bound+'/api/navigation',{headers:{'X-PDL-Company':companyA,'Cookie':'pdl_company='+companyB,'Authorization':'Bearer synthetic'}});
  assert.equal(mismatch.status,400);assert.deepEqual(controls.tenantLookups,[]);
  assert.equal((await request(bound,'GET','/api/navigation')).status,200);
  await pool.query('UPDATE public.tenant_revisions SET content_hash=$1 WHERE company_id=$2',['f'.repeat(64),companyA]);
  try { await assert.rejects(startWorker({companyId:companyA}),/PDL_ACTIVATION_NOT_READY|PDL_SNAPSHOT_HASH_MISMATCH|Worker exit/); }
  finally { await pool.query('UPDATE public.tenant_revisions SET content_hash=$1 WHERE company_id=$2',[before.contentHash,companyA]); }
  await pool.query('REVOKE EXECUTE ON FUNCTION public.replace_tenant_records(uuid,bigint,jsonb,text,jsonb) FROM service_role');
  try { await assert.rejects(startWorker({companyId:companyA}),/PDL_ACTIVATION_NOT_READY|Worker exit/); }
  finally { await pool.query('GRANT EXECUTE ON FUNCTION public.replace_tenant_records(uuid,bigint,jsonb,text,jsonb) TO service_role'); }
  assert.deepEqual(await repository.load(companyA),before);assert.deepEqual(await repository.load(companyB),foreign);assert.equal(providerEvents.length,providers);assert.equal(photoEvents.length,objects); controls.tenantLookups=null;
  console.log('Dedicated synthetic activation HTTP/SQL: exact mandatory/guarded body, grants/RLS negatives, foreign target before lookup, foreign credential/body/cookie denial, failed-readiness no listener, no mutation/provider/object effect passed.');
};
