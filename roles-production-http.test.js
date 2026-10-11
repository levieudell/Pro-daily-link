'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
// Actual normal HTTP server + production repository transport contract. Only
// generated data and a closed memory Supabase transport; no test installer.
process.env.NODE_ENV='test';process.env.PDL_REQUIRE_AUTH='1';
for(const name of ['PDL_COMPAT_ACCOUNT_SYNTHETIC','PDL_COMPAT_GLOBAL_FENCE_FILE'])delete process.env[name];
for(const name of ['OPENAI_API_KEY','RESEND_API_KEY','STRIPE_SECRET_KEY','STRIPE_WEBHOOK_SECRET','SENTRY_DSN','SUPABASE_SECRET_KEY','PDL_PLATFORM_KEY'])process.env[name]='';
const {workspaceSnapshot}=require('./compat-workspace-fixture'),{A,B,credential,initial}=require('./compat-account-fixture');
let snapshot=workspaceSnapshot(),revision=0;let beforeCommit=null,beforeRead=null,oldWrites=0,requests=0;
snapshot.team[0].crew='Office';snapshot.users.push({id:3,companyId:A,name:'Synthetic Admin',email:'admin@example.invalid',role:'admin',status:'Active',permissions:{manageTime:true},projectIds:[],assignedCrews:[],...credential(initial)});
const tokens=new Map();for(const user of snapshot.users){const token=crypto.randomBytes(32).toString('base64url');tokens.set(user.id,token);snapshot.sessions.push({id:crypto.randomUUID(),companyId:A,userId:user.id,tokenHash:crypto.createHash('sha256').update(token).digest('hex'),createdAt:new Date().toISOString(),expiresAt:'2099-01-01T00:00:00.000Z'});}
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pdl-roles-production-http-'));process.env.PDL_DB_FILE=path.join(dir,'synthetic.json');fs.writeFileSync(process.env.PDL_DB_FILE,JSON.stringify(snapshot));process.env.PDL_PLATFORM_FILE=path.join(dir,'platform.json');fs.writeFileSync(process.env.PDL_PLATFORM_FILE,JSON.stringify({users:[],notes:[]}));
process.env.PDL_ROLES_COMPANIES=A;process.env.PDL_ROLE_POLICY_KEY=crypto.randomBytes(32).toString('hex');process.env.PDL_TRANSACTIONAL_DB='off';
const supabase=require('./database/supabase');supabase.configured=()=>true;
supabase.loadCompanySnapshot=async id=>id===A?structuredClone(snapshot):null;supabase.listCompanySnapshots=async()=>[structuredClone(snapshot)];supabase.health=async()=>({configured:true,reachable:true});supabase.saveCompanySnapshot=async()=>{oldWrites++;throw Error('Synthetic old writer rejected');};
supabase.request=async(relative,options={})=>{
  if(relative.startsWith('/rest/v1/companies?')){if(beforeRead)await beforeRead();return new Response(JSON.stringify(relative.includes('id=eq.'+A)?[{data:structuredClone(snapshot),roles_revision:revision,roles_managed:true}]:[]));}
  assert.equal(relative,'/rest/v1/rpc/commit_roles_snapshot');const input=JSON.parse(options.body);assert.equal(input.p_company_id,A);if(beforeCommit)await beforeCommit(input);
  if(input.p_expected_revision!==revision||Date.parse(input.p_deadline)<=Date.now())throw Error('PDL_REVISION_CONFLICT');
  snapshot=structuredClone(input.p_snapshot);revision++;return new Response(JSON.stringify([{revision}]));
};
const {server}=require('./server');
async function main(){
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
  async function call(route,userId=1,input,companyId=A){requests++;const response=await fetch(origin+route,{signal:AbortSignal.timeout(5000),method:input===undefined?'GET':'POST',headers:{'X-PDL-Company':companyId,Authorization:'Bearer '+tokens.get(userId),'Content-Type':'application/json'},...(input===undefined?{}:{body:JSON.stringify(input)})});const data=await response.json();return {status:response.status,data,headers:response.headers};}
  assert.equal((await call('/api/config')).data.rolesEditor,true);
  const start=await call('/api/company/role-policy');assert.equal(start.status,200);assert.equal(start.data.policyRevision,0);
  assert.equal((await call('/api/company/role-policy',3)).status,403,'Admin cannot manage policy');
  const originalGrant=structuredClone(snapshot.users.find(row=>row.id===3).permissions);
  const rows=start.data.defaults;rows.scheduling.admin.create=false;
  const preview=await call('/api/company/role-policy/preview',1,{requestId:crypto.randomUUID(),expectedRevision:start.data.tenantRevision,reason:'Synthetic review',policies:rows});assert.equal(preview.status,200,JSON.stringify(preview.data));
  assert.equal(snapshot.company.schedulingRolePolicy,undefined,'Preview cannot activate permission changes');
  const confirmation={previewId:preview.data.previewId,version:preview.data.version,requestId:crypto.randomUUID(),confirmed:true};
  const saved=await call('/api/company/role-policy/confirm',1,confirmation);assert.equal(saved.status,200,JSON.stringify(saved.data));assert.equal(saved.data.committed,true);
  assert.deepEqual(snapshot.users.find(row=>row.id===3).permissions,originalGrant,'Stored grants retained');
  assert.equal((await call('/api/assignments',3,{projectId:101,memberIds:[12],crew:'Synthetic Crew',date:'2098-10-12',start:'08:00',end:'16:00',activity:'Synthetic',requestId:crypto.randomUUID()})).status,403,'Ordinary manual scheduling uses saved restrictions');
  const replay=await call('/api/company/role-policy/confirm',1,confirmation);assert.equal(replay.status,200);assert.equal(snapshot.rolePolicyReceipts.length,1,'Confirmation replay is idempotent');
  assert.equal((await call('/api/company/role-policy',1,undefined,B)).status,404,'Cross-company hint cannot expose managed policy');
  const me=await call('/api/auth/me',3);assert.equal(me.status,200,JSON.stringify(me.data));assert.equal(me.data.rolesEditor,true);assert.equal(me.data.effectiveCapabilities.scheduling.create,false);assert.deepEqual(me.data.permissions,originalGrant);
  const current=await call('/api/company/role-policy');current.data.policies.scheduling.roles.admin.edit=false;
  const nextRows=structuredClone(start.data.defaults);nextRows.scheduling.admin.edit=false;
  const next=await call('/api/company/role-policy/preview',1,{requestId:crypto.randomUUID(),expectedRevision:current.data.tenantRevision,reason:'Synthetic revoke',policies:nextRows});assert.equal(next.status,200,JSON.stringify(next.data));
  beforeCommit=async()=>{snapshot.users.find(row=>row.id===1).status='Deactivated';revision++;beforeCommit=null;};
  const revoked=await call('/api/company/role-policy/confirm',1,{previewId:next.data.previewId,version:next.data.version,requestId:crypto.randomUUID(),confirmed:true});assert.equal(revoked.status,409,'Concurrent role revocation rejects policy COMMIT');assert.equal(snapshot.company.schedulingRolePolicy.roles.admin.edit,true);
  assert.equal(oldWrites,0,'Managed writes never use old snapshot upsert');
  console.log(JSON.stringify({requests,revision,syntheticTransport:true,testInstallerUsed:false,externalCalls:0,oldWrites,passed:true}));
}
if(require.main===module)main().then(()=>server.close()).catch(error=>{console.error(error);server.close();process.exitCode=1;});
module.exports={server,A,B,initial,tokens,read:()=>structuredClone(snapshot),alter:task=>{task(snapshot);revision++;}};
