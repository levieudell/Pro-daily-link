'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {A,B,initial,memory}=require('./compat-account-fixture'),{workspaceSnapshot}=require('./compat-workspace-fixture'),{services}=require('./compat-lifecycle-fixture');
const {canonicalHash}=require('./database/transactional-repository');
async function main(){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'pdl-field-flags-read-')),file=path.join(directory,'legacy.json'),legacy=Buffer.from(JSON.stringify({company:{id:B},private:'unchanged synthetic legacy'}));fs.writeFileSync(file,legacy);
  for(const name of ['OPENAI_API_KEY','RESEND_API_KEY','STRIPE_SECRET_KEY','STRIPE_WEBHOOK_SECRET','SUPABASE_SECRET_KEY','PDL_PLATFORM_KEY','SENTRY_DSN']){if(process.env[name])throw Error('Provider-free synthetic test required');process.env[name]='';}
  Object.assign(process.env,{NODE_ENV:'test',PDL_REQUIRE_AUTH:'1',PDL_COMPAT_ACCOUNT_SYNTHETIC:'1',PDL_DB_FILE:file,PDL_PLATFORM_FILE:path.join(directory,'platform.json'),PDL_SUPABASE_ENABLED:'0',PDL_TRANSACTIONAL_DB:'off',PDL_WEEKLY_DIGEST:'0'});
  const mod=require('./server');await new Promise(resolve=>mod.server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+mod.server.address().port;
  const seed=workspaceSnapshot(),field=seed.users.find(row=>row.role==='field'),owner=seed.users.find(row=>row.role==='owner'),name=field.name,at='2026-10-12T08:00:00.000Z';
  seed.projects.push({id:202,name:'Other project',code:'OTHER',status:'Active',customer:0,estimateItems:[]});
  const base={projectId:101,fieldFlag:true,number:'PC-001',title:'Own flagged work',status:'Potential',createdAt:at,flagDate:'2026-10-12',createdBy:name,amount:987654,detail:'private sentinel',history:[{action:'private sentinel'}],customerTokenHash:'private sentinel',privateProviderData:'private sentinel'};
  seed.changes=[{...base,id:501},{...base,id:502,createdBy:'Another account'},{...base,id:503,projectId:202},{...base,id:504,fieldFlag:false},{...base,id:505,createdById:field.id+999},{...base,id:506,createdById:field.id}];
  const store=memory(seed),key=crypto.randomBytes(32),fixture=services(store,origin,{key});let requests=0,checks=0;
  const uninstall=mod.installCompatibilityAccountTests({synthetic:true,companyId:A,origin,globalOrigin:'http://localhost:4999',repository:store,...fixture,workspace:true,workspaceKey:key});
  const request=async(route='/api/changes/mine',{method='GET',token,tenant=A,data}={})=>{requests++;const response=await fetch(origin+route,{method,headers:{'X-PDL-Company':tenant,...(token?{Authorization:'Bearer '+token}:{}),...(data?{'Content-Type':'application/json'}:{})},...(data?{body:JSON.stringify(data)}:{})});const text=await response.text();return {status:response.status,value:JSON.parse(text),text};};
  const check=(actual,expected)=>{assert.deepEqual(actual,expected);checks++;};
  let fieldToken,ownerToken;
  async function reset(change=()=>{}){store.beforeLoad=null;const db=structuredClone(seed);change(db);const loaded=await store.load(A);await store.commit(db,loaded.revision);const login=async(email)=>request('/api/auth/login',{method:'POST',data:{email,password:initial}});const f=await login(field.email),o=await login(owner.email);check(f.status,200);check(o.status,200);fieldToken=f.value.token;ownerToken=o.value.token;}
  async function unchangedRead(options,expected){const revision=store.revision(),source=canonicalHash(store.current()),result=await request('/api/changes/mine',options);check(result.status,expected);check(store.revision(),revision);check(canonicalHash(store.current()),source);assert.equal(result.text.includes('private sentinel'),false);checks++;return result;}
  try{
    await reset();check((await request()).status,401);
    let r=await unchangedRead({token:fieldToken},200);check(r.value.map(row=>row.id),[501,506]);check(Object.keys(r.value[0]).sort(),['createdAt','flagDate','id','number','status','title']);check(r.value[0],{id:501,number:'PC-001',title:'Own flagged work',status:'Potential',flagDate:'2026-10-12',createdAt:at});
    check((await request('/api/changes/mine',{token:fieldToken,tenant:B})).status,404);await unchangedRead({token:ownerToken},403);
    for(const role of ['admin','project_manager']){await reset(db=>{db.users.find(row=>row.id===field.id).role=role;});await unchangedRead({token:fieldToken},403);}
    await reset(db=>{db.users.find(row=>row.id===field.id).role='foreman';});r=await unchangedRead({token:fieldToken},200);check(r.value.map(row=>row.id),[501,506]);
    await reset();for(const query of ['?memberId=11','?projectId=202','?role=owner','?permission=viewChanges','?projectId=101&projectId=202'])check((await request('/api/changes/mine'+query,{token:fieldToken})).status,400);
    for(const method of ['POST','PATCH','DELETE'])check((await request('/api/changes/mine',{token:fieldToken,method,data:{confirmed:true}})).status,503);
    await reset(db=>{db.users.push({...db.users.find(row=>row.id===field.id),id:77,email:'another@example.invalid',status:'Inactive'});});await unchangedRead({token:fieldToken},409);
    await reset(db=>{db.changes=db.changes.filter(row=>row.id===506);db.users.push({...db.users.find(row=>row.id===field.id),id:77,email:'another@example.invalid',status:'Inactive'});});await unchangedRead({token:fieldToken},409);
    for(const change of [db=>db.changes.push({...db.changes[0]}),db=>db.changes[0].companyId=B,db=>db.changes[0].fieldFlag='true',db=>db.changes[0].title={secret:'private sentinel'},db=>db.changes[0].projectId=999,db=>db.changes[0].createdById='2']){await reset();const loaded=await store.load(A);change(loaded.snapshot);await store.commit(loaded.snapshot,loaded.revision);await unchangedRead({token:fieldToken},409);}
    await reset(db=>{const row=db.changes.find(row=>row.id===501);row.reportId=db.reports[0].id;const daily=require('./daily-access');db.company.dailyRolePolicy={version:1,revision:1,roles:Object.fromEntries(daily.roles.map(role=>[role,role==='field'?{...daily.ceiling(role),viewReports:false}:daily.ceiling(role)]))};});r=await unchangedRead({token:fieldToken},200);check(r.value.map(row=>row.id),[506]);
    for(const stage of [2,3])for(const revoke of ['status','role','session','project','linked-report']){
      await reset(db=>{if(revoke==='linked-report')db.changes.find(row=>row.id===501).reportId=db.reports[0].id;});
      const revision=store.revision();let loads=0,changed=false;
      store.beforeLoad=async()=>{if(++loads!==stage)return;store.beforeLoad=null;const db=store.current();if(revoke==='status')db.users.find(row=>row.id===field.id).status='Inactive';if(revoke==='role')db.users.find(row=>row.id===field.id).role='project_manager';if(revoke==='session')db.sessions=db.sessions.filter(row=>row.userId!==field.id);if(revoke==='project'){db.assignments=[];db.reports=[];db.workdays=[];}if(revoke==='linked-report')db.reports[0].foreman='Another member';await store.commit(db,store.revision());changed=true;};
      r=await request('/api/changes/mine',{token:fieldToken});store.beforeLoad=null;check(changed,true);check(r.status,409);check(r.text.includes('Own flagged work'),false);check(store.revision(),revision+1);
    }
    check(fs.readFileSync(file),legacy);console.log(JSON.stringify({passed:true,checks,requests,actualCompatibilityHttp:true,normalProductEndpoint:true,fixedRoles:true,readOnly:true,currentReturnRaces:10,providerCalls:0,legacyWrites:0,productionChanges:false}));
  }finally{store.beforeLoad=null;uninstall();await new Promise(resolve=>mod.server.close(resolve));}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
