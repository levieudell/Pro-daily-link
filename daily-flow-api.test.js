'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'pdl-daily-flow-')),companyId='11111111-1111-4111-8111-111111111111';
const token=id=>`synthetic-daily-user-${id}`,hash=text=>crypto.createHash('sha256').update(text).digest('hex');
const fixture={company:{id:companyId,name:'Synthetic daily QA',demo:true,timezone:'America/Los_Angeles',features:{timeCards:true}},projects:[{id:101,name:'Synthetic project',status:'Active',estimateItems:[]},{id:102,name:'Unrelated project',status:'Active',estimateItems:[]}],customers:[],team:[{id:11,name:'Synthetic worker',crew:'A'},{id:12,name:'Unrelated worker',crew:'B'}],assignments:[{id:1,projectId:101,memberIds:[11],date:'2026-10-06'}],reports:[{id:1,project:0,dateIso:'2026-10-05',status:'Approved',next:'Bring guards',notes:'Synthetic previous daily',laborEntries:[{memberId:11,hours:1}],productionEntries:[],history:[]}],workdays:[],photos:[],catalog:[],subcontractors:[],changes:[],users:[{id:1,role:'owner'},{id:2,role:'field',memberId:11},{id:3,role:'field',memberId:12}],sessions:[]};
fixture.users.forEach(user=>{user.name=`Synthetic user ${user.id}`;user.status='Active';fixture.sessions.push({userId:user.id,companyId,tokenHash:hash(token(user.id)),expiresAt:'2099-01-01T00:00:00Z'})});
const dbFile=path.join(temp,'db.json');fs.writeFileSync(dbFile,JSON.stringify(fixture));fs.mkdirSync(path.join(temp,'tenants'));fs.writeFileSync(path.join(temp,'tenants',companyId+'.json'),JSON.stringify(fixture));fs.writeFileSync(path.join(temp,'platform.json'),JSON.stringify({users:[],sessions:[]}));
let child,base;
async function request(method,route,user=2,input){const response=await fetch(base+route,{method,signal:AbortSignal.timeout(10000),headers:{'Content-Type':'application/json','x-pdl-company':companyId,Authorization:`Bearer ${token(user)}`},...(input?{body:JSON.stringify(input)}:{})});return {status:response.status,data:await response.json()}}
async function expect(status,...args){const result=await request(...args);assert.equal(result.status,status,JSON.stringify(result.data));return result.data}
(async()=>{try{
 const env={...process.env,PDL_DB_FILE:dbFile,PDL_PLATFORM_FILE:path.join(temp,'platform.json'),PDL_SUPABASE_ENABLED:'0',PDL_TRANSACTIONAL_DB:'off',PDL_REQUIRE_AUTH:'1',PDL_EMAIL_DEV_MODE:'1'};
 for(const name of ['SENTRY_DSN','RESEND_API_KEY','OPENAI_API_KEY','STRIPE_SECRET_KEY','STRIPE_WEBHOOK_SECRET'])delete env[name];
 for(const name of ['SENTRY_DSN','RESEND_API_KEY','OPENAI_API_KEY','STRIPE_SECRET_KEY','STRIPE_WEBHOOK_SECRET'])delete process.env[name];Object.assign(process.env,env);
 child=require('./server').server;
 await new Promise((resolve,reject)=>{child.once('error',reject);child.listen(0,'127.0.0.1',resolve)});base='http://127.0.0.1:'+child.address().port;
 for(const asset of ['/daily-photo-store.js','/daily-flow-ui.js'])assert.equal((await fetch(base+asset)).status,200);
 assert.equal((await fetch(base+'/daily-flow-policy.js')).status,404);
 assert.equal((await expect(200,'GET','/api/projects/101/day-instructions?date=2026-10-06')).previousNext.text,'Bring guards');
 await expect(404,'GET','/api/projects/102/day-instructions?date=2026-10-06');
 await expect(404,'GET','/api/projects/101/day-instructions?date=2026-10-06',3);
 const day=await expect(201,'POST','/api/workdays/start',2,{projectId:101,memberIds:[11]});
 await expect(403,'POST',`/api/workdays/${day.id}/end`,3,{notes:'Unauthorized synthetic note'});
 const end=await expect(200,'POST',`/api/workdays/${day.id}/end`,2,{notes:'Installed 20 feet of pipe. Safety concern: unguarded opening. Tomorrow bring guards.'});
 assert.equal(end.workday.status,'complete');assert.equal(end.report.status,'Draft');assert.match(end.report.safety,/unguarded opening/);
 const retry=await expect(200,'POST',`/api/workdays/${day.id}/end`,2,{notes:'Changed retry must not replace saved notes'});
 assert.equal(retry.alreadyEnded,true);assert.equal(retry.report.id,end.report.id);assert.equal(retry.workday.endedAt,end.workday.endedAt);assert.equal(retry.report.notes,end.report.notes);
 const cards=await expect(200,'GET','/api/time-cards',2);assert.ok(cards.some(card=>Number(card.workdayId)===Number(day.id)&&card.outAt),'clock closes independently of photos');
 const extracted=await expect(200,'POST','/api/ai/extract',2,{notes:'Safety concern: unguarded opening. Tomorrow bring guards.'});assert.match(extracted.safety,/unguarded opening/);assert.match(extracted.next,/bring guards/i);
 const photo={files:[{name:'synthetic.png',type:'image/png',data:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4x8AAAAASUVORK5CYII=',uploadId:crypto.randomUUID()}],projectId:101,source:'field',reportId:end.report.id,workdayId:day.id,phase:'end'};
 const first=await expect(201,'POST','/api/photos',2,photo),second=await expect(201,'POST','/api/photos',2,photo);assert.equal(first.length,1);assert.equal(second[0].id,first[0].id,'lost photo response retry is idempotent');
 await expect(409,'POST','/api/photos',2,{...photo,files:[{...photo.files[0],data:'data:image/png;base64,Y2hhbmdlZA=='}]});
 await expect(400,'POST','/api/photos',2,{...photo,files:Array(9).fill(photo.files[0])});
 await expect(409,'POST','/api/photos',2,{...photo,reportId:null});
 const afterFailure=await expect(200,'POST',`/api/workdays/${day.id}/end`,2,{notes:'Retry after rejected photo upload'});assert.equal(afterFailure.workday.endedAt,end.workday.endedAt);
 const edit=await expect(200,'PATCH','/api/reports/'+end.report.id,2,{...end.report,status:'Draft',safety:'Verified guard added; review pending'});assert.match(edit.safety,/Verified guard/);
 console.log('Daily flow API passed: authorized instructions, clock-out and closed time card, explicit safety, safe lost-response retry, editable draft, photo retry identity and public asset boundaries.');
}finally{if(child?.listening){child.closeAllConnections();await new Promise(resolve=>child.close(resolve))}fs.rmSync(temp,{recursive:true,force:true})}})().catch(error=>{console.error(error);process.exitCode=1});
