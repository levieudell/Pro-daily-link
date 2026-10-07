'use strict';
const assert=require('node:assert/strict');
const {fixture}=require('./fixtures/project-assistant');
const {createProjectAssistantHandler}=require('./project-assistant');
const {createChat}=require('./project-assistant-chat');
async function main(){
  let db=fixture(),clock=new Date('2026-10-08T01:00:00Z'),writes=0,response;
  db.projects[0].name='Market Street Reno';db.projects[1].name='Market Street Annex';db.team[0].name='Chloe';db.team[1].name='Andi';db.team[2].name='Andy';
  const handler=createProjectAssistantHandler({readDb:()=>db,writeDb:async value=>{db=value;writes++;},body:async req=>req.input,json:(_res,status,data)=>{response={status,data};},authenticatedUser:()=>db.users.find(row=>row.id===2),now:()=>clock,propose:()=>{throw Error('Provider forbidden in natural-request regressions');}});
  async function call(action,input,project=101){response=null;assert.equal(await handler({method:input?'POST':'GET',input},{},new URL('http://synthetic.invalid/api/projects/'+project+'/assistant/'+action)),true);return response;}
  const ctx=(await call('context')).data;assert.equal(ctx.today,'2026-10-07','company day, not UTC/device day');assert.equal(ctx.timezone,'America/Los_Angeles');assert.deepEqual(ctx.members.map(row=>row.name),['Chloe','Andi']);assert.equal((await call('context',null,102)).status,404,'private project not available');
  const chat=createChat({projects:[{id:101,name:'Market Street Reno'}]});assert.equal(chat.consume('Schedule Chloe Andy at market Street tomorrow').needsContext,101);chat.hydrate(ctx);assert.match(chat.question(),/Did you mean Chloe.*Andi/);assert.doesNotMatch(chat.question(),/Andy/,'unauthorized near-name is absent from candidates');assert.equal(chat.draft.date,'2026-10-08');chat.consume('yes');for(const answer of ['8 AM','4 PM','Frame','Check layout'])chat.consume(answer);assert.equal(chat.ready,true);assert.equal(writes,0);
  const exact=JSON.stringify(db),preview=await call('preview',chat.draft);assert.equal(preview.status,200);assert.deepEqual(preview.data.proposal.members.map(row=>row.name),['Chloe','Andi']);assert.deepEqual(preview.data.proposal.dates,['2026-10-08']);assert.equal(JSON.stringify(db),exact,'natural context and preview never write');assert.equal(writes,0);
  const confirmation={token:preview.data.token,version:preview.data.version,confirmed:true};db.projects[0].name='Market Street Reno revised';assert.equal((await call('confirm',confirmation)).status,409,'project changes stale an otherwise valid natural proposal');assert.equal(db.assignments.length,0);db.projects[0].name='Market Street Reno';
  db.team[1].status='Inactive';assert.equal((await call('confirm',confirmation)).status,403,'authorized candidate can lose access before confirmation');assert.equal(db.assignments.length,0);delete db.team[1].status;
  assert.equal((await call('confirm',{...confirmation,confirmed:false})).status,400);assert.equal(db.assignments.length,0);
  assert.equal((await call('confirm',confirmation)).status,201);assert.equal((await call('confirm',confirmation)).status,200);assert.equal(db.assignments.length,1);assert.deepEqual(db.assignments[0].memberIds,[11,12]);assert.equal(writes,1,'confirmed replay cannot duplicate records');
  // A relative correction obtains a fresh server company-day even if the dialog
  // has remained open over midnight; it preserves already clarified people/task.
  chat.consume('change date');assert.equal(chat.consume('tomorrow').needsContext,101);assert.equal(chat.ready,false);clock=new Date('2026-10-09T08:00:00Z');chat.hydrate((await call('context')).data);assert.equal(chat.draft.startDate,'2026-10-10');assert.equal(chat.draft.endDate,'2026-10-10');assert.deepEqual(chat.draft.memberIds,[11,12]);assert.equal(chat.draft.activity,'Frame');assert.equal(chat.ready,true);assert.equal((await call('preview',chat.draft)).status,200);assert.equal(writes,1);
  chat.consume('change date');chat.consume('tomorrow');chat.cancelContextAnswer();assert.equal(chat.ready,false);chat.consume('back');assert.equal(chat.ready,false);chat.consume('cancel');assert.equal(chat.projectId,null);
  for(const timezone of ['Asia/Tokyo','Pacific/Kiritimati','America/Los_Angeles']){db.company.timezone=timezone;clock=new Date('2026-12-31T23:30:00Z');const ctx=(await call('context')).data;const parts=new Intl.DateTimeFormat('en',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(clock);assert.equal(ctx.today,['year','month','day'].map(key=>parts.find(part=>part.type===key).value).join('-'));}
  db.company.timezone='invalid-zone';assert.equal((await call('context')).data.today,'');assert.equal(writes,1);
  console.log('Natural-request actual-handler regressions passed: exact owner sentence, scoped candidates, company date, zero-write context/preview, stale/project/member denial, explicit/idempotent confirm, relative correction refresh and timezone rollover.');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
