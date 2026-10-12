'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),{spawnSync}=require('node:child_process');
const nativeFetch=globalThis.fetch;
globalThis.fetch=async()=>{throw Error('No external provider is available to this closed probe.');};
const preloading=process.env.PDL_PLATFORM_AUTH_PROBE_BOOT==='1';
require('./database/supabase').loadLocalEnv=()=>{};
function bootFixture(){
 const db=require('./compat-workspace-fixture').workspaceSnapshot(),directory=fs.mkdtempSync(path.join(os.tmpdir(),'pdl-roles-config-boot-')),transport=require('./database/supabase');
 Object.assign(process.env,{NODE_ENV:'test',PDL_DB_FILE:path.join(directory,'tenant.json'),PDL_PLATFORM_FILE:path.join(directory,'platform.json'),PDL_ROLE_POLICY_KEY:crypto.randomBytes(32).toString('hex'),PDL_SUPABASE_ENABLED:'0',PDL_TRANSACTIONAL_DB:'off'});
 fs.writeFileSync(process.env.PDL_DB_FILE,JSON.stringify(db));fs.writeFileSync(process.env.PDL_PLATFORM_FILE,JSON.stringify({users:[],notes:[]}));
 transport.configured=()=>true;transport.loadCompanySnapshot=async()=>structuredClone(db);transport.listCompanySnapshots=async()=>[structuredClone(db)];transport.saveCompanySnapshot=async()=>{throw Error('No boot fixture write permitted');};
 const platformFixture=require('./roles-production-platform-fixture').wrap(async()=>new Response(JSON.stringify([{data:structuredClone(db),roles_managed:false,roles_revision:0}])));transport.request=platformFixture.request;
 process.once('exit',()=>{const resolved=path.resolve(directory);assert.ok(resolved.startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(resolved).startsWith('pdl-roles-config-boot-')&&fs.realpathSync(resolved)===resolved);fs.rmSync(resolved,{recursive:true,force:true});});
 return {A:db.company.id,platformFixture};
}
const fixture=preloading?bootFixture():require('./roles-production-http.test'),{PLATFORM_ID}=require('./database/platform-snapshot-repository');
const supabase=require('./database/supabase'),token=crypto.randomBytes(32).toString('base64url');
const managedTransport=supabase.request;
supabase.request=async(relative,options)=>{
 const result=await managedTransport(relative,options);
 if(relative.startsWith('/rest/v1/companies?')&&relative.includes('id=eq.'+fixture.A)){const rows=await result.json();return new Response(JSON.stringify(rows.map(row=>({...row,roles_managed:false}))));}
 return result;
};
delete process.env.PDL_ROLES_COMPANIES;
fixture.platformFixture.alter(p=>{p.users=[{id:1,name:'Generated Platform Owner',email:'owner@example.invalid',role:'platform_owner',status:'Active'}];p.sessions=[{id:crypto.randomUUID(),userId:1,tokenHash:crypto.createHash('sha256').update(token).digest('hex'),createdAt:new Date().toISOString(),expiresAt:'2099-01-01T00:00:00.000Z'}];});
if(preloading){
 if(process.env.PDL_PLATFORM_AUTH_PROBE_VALUE==='missing')delete process.env.PDL_REQUIRE_AUTH;else process.env.PDL_REQUIRE_AUTH='0';
 const closedLoad=supabase.loadCompanySnapshot;supabase.loadCompanySnapshot=id=>id===PLATFORM_ID?Promise.resolve(fixture.platformFixture.read()):closedLoad(id);
 process.env.PORT='0';process.env.PDL_WEEKLY_DIGEST='0';
 // The actual server is the Node entry point after this preload; its startup
 // admission must reject before listen, without creating or activating a row.
}else{
 let origin,requests=0;
 const cleanup=()=>{const target=path.dirname(process.env.PDL_DB_FILE),temporary=path.resolve(os.tmpdir())+path.sep;assert.ok(path.resolve(target).startsWith(temporary)&&path.basename(target).startsWith('pdl-roles-production-http-')&&fs.realpathSync(target)===path.resolve(target));fs.rmSync(target,{recursive:true,force:true});};
 async function run(){
  await new Promise(resolve=>fixture.server.listen(0,'127.0.0.1',resolve));origin='http://127.0.0.1:'+fixture.server.address().port;
  async function call(route,{method='GET',data,auth=false}={}){requests++;const r=await nativeFetch(origin+route,{method,headers:{'X-PDL-Company':fixture.A,'X-PDL-Operation':crypto.randomUUID(),'Content-Type':'application/json',...(auth?{Authorization:'Bearer '+token}:{})},...(data===undefined?{}:{body:JSON.stringify(data)})});return {status:r.status,data:await r.json()};}
  if(process.argv.includes('--flag-off')){
   process.env.PDL_REQUIRE_AUTH='0';supabase.configured=()=>false;
   const result=await call('/api/platform/help');assert.equal(result.status,200);assert.ok(Array.isArray(result.data));
   console.log(JSON.stringify({passed:true,flagOffLegacy:true,requests,externalCalls:0}));return;
  }
  const initialRevision=fixture.platformFixture.revision(),opening=fixture.platformFixture.read();
  const routes=[['GET','/api/platform/overview'],['GET','/api/platform/revenue'],['POST','/api/platform/help',{title:'Denied config write',content:'Synthetic only',status:'Published'}],['POST','/api/platform/users',{name:'Denied staff',email:'denied@example.invalid',role:'support'}]];
  for(const value of [undefined,'0','false']){
   if(value===undefined)delete process.env.PDL_REQUIRE_AUTH;else process.env.PDL_REQUIRE_AUTH=value;
   for(const[method,route,data]of routes){const response=await call(route,{method,data});assert.equal(response.status,503,JSON.stringify(response));assert.equal(response.data.code,'PDL_PLATFORM_AUTH_CONFIG');assert.deepEqual(Object.keys(response.data).sort(),['code','error']);}
   assert.deepEqual(fixture.platformFixture.read(),opening);assert.equal(fixture.platformFixture.revision(),initialRevision);
  }
  process.env.PDL_REQUIRE_AUTH='1';assert.equal((await call('/api/platform/auth/me')).status,401);const me=await call('/api/platform/auth/me',{auth:true});assert.equal(me.status,200);assert.equal(me.data.role,'platform_owner');
  const saved=await call('/api/platform/help',{method:'POST',auth:true,data:{title:'Valid configured write',type:'article',audience:'all',content:'Generated closed source',status:'Published'}});assert.equal(saved.status,201,JSON.stringify(saved));const current=fixture.platformFixture.read(),revision=fixture.platformFixture.revision();assert.ok(revision>initialRevision);assert.equal(current.platform.users.length,1);assert.ok(current.platform.helpItems.some(row=>row.title==='Valid configured write'));
  // Cached authority cannot survive loss of the immutable auth configuration.
  delete process.env.PDL_REQUIRE_AUTH;const retired=await call('/api/platform/overview',{auth:true});assert.equal(retired.status,503);assert.equal(retired.data.code,'PDL_PLATFORM_AUTH_CONFIG');assert.deepEqual(fixture.platformFixture.read(),current);assert.equal(fixture.platformFixture.revision(),revision);
  const env={...process.env,NODE_ENV:'test'};for(const name of ['OPENAI_API_KEY','RESEND_API_KEY','STRIPE_SECRET_KEY','STRIPE_WEBHOOK_SECRET','SUPABASE_SECRET_KEY','PDL_PLATFORM_KEY','SENTRY_DSN'])env[name]='';
  const bootCases=[];
  for(const value of ['missing','off']){const result=spawnSync(process.execPath,['--require',__filename,path.join(__dirname,'server.js')],{cwd:__dirname,env:{...env,PDL_PLATFORM_AUTH_PROBE_BOOT:'1',PDL_PLATFORM_AUTH_PROBE_VALUE:value},encoding:'utf8',timeout:10000});assert.equal(result.status,1,JSON.stringify({status:result.status,error:result.error?.message,stderr:result.stderr}));assert.match(result.stderr,/Current storage admission failed Managed platform authentication must be enabled/);assert.doesNotMatch(result.stdout,/running at/);bootCases.push(value);}
  const legacy=spawnSync(process.execPath,[__filename,'--flag-off'],{cwd:__dirname,env,encoding:'utf8',timeout:10000});assert.equal(legacy.status,0,legacy.stderr);assert.match(legacy.stdout,/"flagOffLegacy":true/);
  console.log(JSON.stringify({passed:true,journeys:7,requests,bootCases,flagOffLegacy:true,managedWithoutRolesEnvironment:true,syntheticTransport:true,externalCalls:0,productionChanges:false}));
 }
 run().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{fixture.server.closeAllConnections();await new Promise(resolve=>fixture.server.close(resolve));cleanup();});
}
