'use strict';
// Closed-memory transport shared by normal-server tests; never an application installer.
const {PLATFORM_ID,PLATFORM_NAME}=require('./database/platform-snapshot-repository');
function wrap(tenantRequest){
 let snapshot={company:{id:PLATFORM_ID,name:PLATFORM_NAME},platform:{users:[],sessions:[],notes:[],auditEvents:[]}},revision=0,beforeCommit=null,beforeLoad=null;
 const request=async(relative,options={})=>{
  if(relative==='/rest/v1/rpc/platform_snapshot_trigger_contract'){
   if(options.method!=='POST'||options.body!=='{}')throw Error('Closed platform readiness metadata request required');return new Response('true');
  }
  if(relative.startsWith('/rest/v1/companies?')&&relative.includes('id=eq.'+PLATFORM_ID)){
   if(beforeLoad)await beforeLoad();return new Response(JSON.stringify([{id:PLATFORM_ID,data:structuredClone(snapshot),platform_managed:true,platform_revision:revision,roles_managed:false}]));
  }
  if(relative==='/rest/v1/rpc/commit_platform_snapshot'){
   const input=JSON.parse(options.body);if(beforeCommit)await beforeCommit(input);
   if(input.p_platform_id!==PLATFORM_ID||input.p_expected_revision!==revision||Date.parse(input.p_deadline)<=Date.now())throw Error('PDL_REVISION_CONFLICT');
   snapshot=structuredClone(input.p_snapshot);revision++;return new Response(JSON.stringify([{revision}]));
  }
  if(relative==='/rest/v1/rpc/commit_roles_snapshot_with_platform'){
   const input=JSON.parse(options.body);
   if(input.p_platform_id!==PLATFORM_ID||input.p_platform_expected_revision!==revision)throw Error('PDL_REVISION_CONFLICT');
   const {p_platform_id,p_platform_expected_revision,...tenant}=input;
   return tenantRequest('/rest/v1/rpc/commit_roles_snapshot',{...options,body:JSON.stringify(tenant)});
  }
  return tenantRequest(relative,options);
 };
 return {request,id:PLATFORM_ID,read:()=>structuredClone(snapshot),alter:task=>{task(snapshot.platform);revision++;},beforeCommit:task=>{beforeCommit=task;},beforeLoad:task=>{beforeLoad=task;},revision:()=>revision};
}
module.exports={wrap};
