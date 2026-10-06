'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const policy=require('./employee-access');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'pdl-employee-access-')),file=path.join(root,'db.json');
const companyId='11111111-1111-4111-8111-111111111111',otherId='22222222-2222-4222-8222-222222222222';
const token=(id,tenant=companyId)=>'synthetic-employee-'+tenant+'-'+id;
function fixture(id=companyId){const users=['owner','admin','project_manager','field'].map((role,index)=>({id:index+1,companyId:id,name:'Synthetic '+role,email:role+'@example.invalid',status:'Active',role,emailVerifiedAt:'2026-01-01',projectIds:[1],assignedCrews:['QA'],memberId:role==='field'?9:null}));return{company:{id,name:'Synthetic employee company',demo:true},users,sessions:users.map(user=>({companyId:id,userId:user.id,tokenHash:crypto.createHash('sha256').update(token(user.id,id)).digest('hex'),expiresAt:'2099-01-01'})),team:[{id:1,name:'Synthetic employee',role:'Laborer',crew:'QA',email:'employee@example.invalid',phone:'5551234567',hours:12,site:'QA site'},{id:2,name:'No email',role:'Laborer',crew:'QA'},{id:3,name:'Other crew',role:'Foreman',crew:'Other'},{id:9,name:'Signed in field',role:'Laborer',crew:'QA'}],projects:[{id:1,name:'QA project',estimateItems:[]}],customers:[],assignments:[],reports:[],photos:[],workdays:[],auditLog:[],subcontractors:[]}}
const read=()=>JSON.parse(fs.readFileSync(file));const write=db=>fs.writeFileSync(file,JSON.stringify(db));
fs.mkdirSync(path.join(root,'tenants'));write(fixture());fs.writeFileSync(path.join(root,'tenants',otherId+'.json'),JSON.stringify(fixture(otherId)));fs.writeFileSync(path.join(root,'platform.json'),JSON.stringify({users:[],sessions:[]}));
let child,base,log='';
async function request(method,route,user=1,input,tenant=companyId){const response=await fetch(base+route,{method,headers:{'Content-Type':'application/json','X-PDL-Company':tenant,Authorization:'Bearer '+token(user,tenant)},...(input===undefined?{}:{body:JSON.stringify(input)})});return{status:response.status,data:await response.json()}}
async function run(){
  const env={...process.env,PDL_DB_FILE:file,PDL_PLATFORM_FILE:path.join(root,'platform.json'),PDL_REQUIRE_AUTH:'1',PDL_SUPABASE_ENABLED:'0',PDL_TRANSACTIONAL_DB:'off',PDL_FOUNDER_ENABLED:'0',PDL_EMAIL_DEV_MODE:'1'};
  for(const key of ['SENTRY_DSN','OPENAI_API_KEY','RESEND_API_KEY','STRIPE_SECRET_KEY','STRIPE_WEBHOOK_SECRET'])delete env[key];
  Object.assign(process.env,env);
  for(const key of ['SENTRY_DSN','OPENAI_API_KEY','RESEND_API_KEY','STRIPE_SECRET_KEY','STRIPE_WEBHOOK_SECRET'])delete process.env[key];
  child=require('./server').server;
  await new Promise((resolve,reject)=>{child.once('error',reject);child.listen(0,'127.0.0.1',resolve)});
  base='http://127.0.0.1:'+child.address().port;
  let result=await request('GET','/api/team/1');assert.equal(result.status,200);assert.equal(result.data.employee.phone,'5551234567');assert.deepEqual(result.data.accessRoles,['admin','project_manager','foreman','field']);assert.equal(result.data.account,null);
  result=await request('GET','/api/team/1',2);assert(!result.data.accessRoles.includes('admin'));
  let legacy=read();legacy.users.find(user=>user.id===2).role='office';write(legacy);
  result=await request('GET','/api/team/1',2);assert.equal(result.status,200);assert.deepEqual(result.data.accessRoles,['project_manager','foreman','field']);
  assert.equal((await request('POST','/api/team/1/account',2,{role:'admin'})).status,403);
  legacy=read();legacy.users.find(user=>user.id===2).role='admin';write(legacy);
  assert.equal((await request('GET','/api/team/3',3)).status,404);
  assert.equal((await request('GET','/api/team/3',4)).status,404);
  assert.equal((await request('GET','/api/team/1',4)).status,200);
  assert.equal((await request('POST','/api/team/1/account',3,{role:'field'})).status,403);
  assert.equal((await request('POST','/api/team/1/account',2,{role:'admin'})).status,403);
  assert.equal((await request('POST','/api/team/1/account',1,{role:'owner'})).status,403);
  assert.equal((await request('POST','/api/team/2/account',1,{role:'field'})).status,400);
  assert.equal((await request('POST','/api/team/1/account',1,{role:'field',email:'OWNER@example.invalid '})).status,409);
  assert.equal((await request('POST','/api/team/1/account',1,{role:'project_manager',projectIds:[999]})).status,400);
  assert.equal((await request('POST','/api/team/999/account',1,{role:'field'})).status,404);
  // Exercise the actual endpoint's plan cap, including simultaneous attempts for the last seat.
  const beforeSeats=read(),fullSeats=read();fullSeats.company.plan='starter';
  while(fullSeats.users.length<10)fullSeats.users.push({id:fullSeats.users.length+1,companyId,name:'Synthetic occupied seat',email:'seat'+fullSeats.users.length+'@example.invalid',role:'field',status:'Active'});
  write(fullSeats);const fullBefore=read();
  assert.equal((await request('POST','/api/team/1/account',1,{role:'field'})).status,409);assert.deepEqual(read(),fullBefore);
  fullSeats.users.pop();write(fullSeats);
  const lastSeat=await Promise.all([request('POST','/api/team/1/account',1,{role:'field'}),request('POST','/api/team/2/account',1,{role:'field',email:'last-seat@example.invalid'})]);
  assert.deepEqual(lastSeat.map(row=>row.status).sort(),[201,409]);assert.equal(read().users.filter(user=>user.status==='Active').length,10);assert.deepEqual(read().team,beforeSeats.team);
  write(beforeSeats);
  const employeeBefore=read().team;
  const parallel=await Promise.all([request('POST','/api/team/1/account',2,{role:'field'}),request('POST','/api/team/1/account',2,{role:'foreman'})]);
  assert.deepEqual(parallel.map(row=>row.status).sort(),[201,409]);result=parallel.find(row=>row.status===201);assert(result.data.temporaryPassword);assert(!JSON.stringify(result.data).includes('setupHash'));
  let db=read();assert.equal(db.users.filter(user=>user.memberId===1).length,1);assert.deepEqual(db.team,employeeBefore);assert.equal(db.users.at(-1).companyId,companyId);assert.equal(db.users.at(-1).permissions.manageTime,undefined);assert.equal(db.auditLog.at(-1).type,'employee_account_created');
  const password=result.data.temporaryPassword,newUser=db.users.at(-1);assert(!JSON.stringify(db).includes(password),'plaintext temporary credential is not persisted');assert(newUser.setupHash);assert(newUser.setupSalt);assert.equal(newUser.mustSetPassword,true);assert(Math.abs(Date.parse(newUser.setupExpiresAt)-Date.now()-72*3600000)<10000);
  const summary=await request('GET','/api/team/1');assert.deepEqual(Object.keys(summary.data.account).sort(),['email','id','mustSetPassword','role','status']);assert(!JSON.stringify(summary.data).includes(password));
  const accountId=result.data.account.id;
  result=await request('GET','/api/team/1',4);assert.deepEqual(result.data.account,{status:'Active'});
  db=read();db.users.find(user=>user.id===accountId).status='Deactivated';write(db);
  assert.equal((await request('POST','/api/team/1/account',1,{role:'field'})).status,409);assert.equal((await request('GET','/api/team/1')).data.account.status,'Deactivated');
  // An open dialog does not authorize a later request after the actor is demoted.
  await request('GET','/api/team/2',2);db=read();db.users.find(user=>user.id===2).status='Deactivated';write(db);const deactivatedBefore=read();
  assert.equal((await request('POST','/api/team/2/account',2,{role:'field',email:'new@example.invalid'})).status,401);assert.deepEqual(read(),deactivatedBefore);
  db=read();db.users.find(user=>user.id===2).status='Active';write(db);
  await request('GET','/api/team/2',2);db=read();db.users.find(user=>user.id===2).role='project_manager';write(db);
  assert.equal((await request('POST','/api/team/2/account',2,{role:'field',email:'new@example.invalid'})).status,403);
  db=read();db.users.find(user=>user.id===1).emailVerifiedAt=null;db.company.emailVerificationRequiredAt='2026-01-01';write(db);
  assert.equal((await request('POST','/api/team/2/account',1,{role:'field',email:'new@example.invalid'})).status,403);
  db=read();db.users.find(user=>user.id===1).emailVerifiedAt='2026-01-01';write(db);
  result=await request('POST','/api/team/2/account',1,{role:'project_manager',email:'manager2@example.invalid',companyId:otherId,memberId:3,projectIds:[1],assignedCrews:['QA'],permissions:{manageTime:true,approveDailies:true}});assert.equal(result.status,201);
  db=read();const manager=db.users.find(user=>user.memberId===2);assert.equal(manager.companyId,companyId);assert.equal(manager.permissions.manageTime,false);assert.equal(manager.permissions.approveDailies,false);assert.deepEqual(manager.projectIds,[1]);assert.deepEqual(db.team,employeeBefore);
  // Routine office account edits must not lose the employee identity or permit duplicate access.
  assert.equal(manager.employeeId,2);
  assert.equal((await request('PATCH','/api/users/'+manager.id,1,{name:'Edited manager'})).status,200);
  assert.equal(read().users.find(user=>user.id===manager.id).memberId,null);
  assert.equal((await request('GET','/api/team/2')).data.account.id,manager.id);
  assert.equal((await request('POST','/api/team/2/account',1,{role:'field',email:'duplicate-other@example.invalid'})).status,409);
  const beforeReassign=read();
  assert.equal((await request('PATCH','/api/users/'+manager.id,1,{role:'field',memberId:3})).status,409);assert.deepEqual(read(),beforeReassign);
  assert.equal((await request('PATCH','/api/users/'+manager.id,1,{role:'field',memberId:2})).status,200);
  assert.equal((await request('GET','/api/team/2')).data.account.id,manager.id);
  assert.equal((await request('PATCH','/api/users/'+manager.id,1,{role:'admin',status:'Deactivated'})).status,200);
  assert.equal((await request('GET','/api/team/2')).data.account.status,'Deactivated');
  assert.equal((await request('POST','/api/team/2/account',1,{role:'field',email:'duplicate-other@example.invalid'})).status,409);
  assert.deepEqual(read().team,employeeBefore);
  // Preserve pre-feature field-member linkage on promotion to an office role.
  const existingField=read().users.find(user=>user.id===4);assert.equal(existingField.employeeId,undefined);
  assert.equal((await request('PATCH','/api/users/4',1,{role:'admin'})).status,200);
  assert.equal(read().users.find(user=>user.id===4).employeeId,9);
  assert.equal((await request('GET','/api/team/9')).data.account.id,4);
  assert.equal((await request('POST','/api/team/9/account',1,{role:'field',email:'duplicate-legacy@example.invalid'})).status,409);
  assert.equal((await request('PATCH','/api/users/4',1,{role:'field',memberId:9})).status,200);
  // Tenant lookup never links an account or employee from another workspace.
  assert.equal((await request('GET','/api/team/1',1,undefined,otherId)).data.account,null);
  const mismatch=await fetch(base+'/api/team/1',{headers:{'X-PDL-Company':otherId,Authorization:'Bearer '+token(1)}});assert.equal(mismatch.status,401);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root,'tenants',otherId+'.json'))).users.length,4);
  const limited=fixture(),member=limited.team[0];assert.equal(policy.prepareEmployeeAccount(limited,limited.users[0],member,{role:'field'},{name:'QA',maxUsers:4}).status,409);
  limited.users.push({...limited.users[0],id:8,email:member.email,status:'Deactivated'});assert.equal(policy.prepareEmployeeAccount(limited,limited.users[0],member,{role:'field'},{name:'QA',maxUsers:99}).status,409);
  const source=fs.readFileSync(path.join(__dirname,'app.js'),'utf8'),html=fs.readFileSync(path.join(__dirname,'index.html'),'utf8');assert(source.includes('data-employee-detail="${Number(m.id)}"'));assert(source.includes('if(employeeAccessPending)return'));assert(source.includes("value=\"\">Choose app role"));assert(html.includes('aria-labelledby="employee-detail-title"'));
  console.log('Employee access API/security regressions passed (synthetic, isolated, no external writes).');
}
run().catch(error=>{console.error(error);process.exitCode=1}).finally(async()=>{if(child){child.closeAllConnections();await new Promise(resolve=>child.close(resolve))}fs.rmSync(root,{recursive:true,force:true})});
