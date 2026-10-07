'use strict';
const assert = require('node:assert/strict'), crypto = require('node:crypto');
const { fixture, companyA, companyB } = require('./fixtures/project-assistant');
const { memoryStore, changes, utterances } = require('./fixtures/assistant-ai');
const { createAIHandler } = require('./project-assistant-ai');
const { createProjectAssistantHandler } = require('./project-assistant');
const { PRICE, interpretOpenAI, createIntentService } = require('./project-assistant-intent');
const { createBudget } = require('./project-assistant-budget');
function harness(options = {}) {
  let db = fixture(), calls = [], writes = 0, time = new Date('2026-10-07T16:00:00Z');
  db.projects[0].name='Market Street Reno';db.team[0].name='Chloe';db.team[1].name='Andi';db.reports=[{secret:'EXCLUDED_REPORT'}];db.customers=[{email:'EXCLUDED_CUSTOMER'}];
  const store=memoryStore(), auth=req=>db.users.find(row=>row.id===(req.userId||2)), json=(res,status,data)=>Object.assign(res,{status,data}), common={readDb:()=>db,readFreshDb:()=>db,authenticatedUser:auth,accountAccess:()=>({locked:false}),body:async req=>req.input,json,now:()=>time};
  const ai=createAIHandler({...common,store,enabled:()=>true,signingKey:()=> 'synthetic-signing-only',adapter:async payload=>{calls.push(payload);if(options.adapter)return options.adapter(payload);const input=JSON.parse(payload.input);return {changes:changes(utterances[input.request]||{}),usage:{input_tokens:2000,output_tokens:300}};}});
  const manual=createProjectAssistantHandler({...common,writeDb:()=>writes++});
  const sessionId=crypto.randomUUID();
  async function request(path,input,userId=2){const req={method:input?'POST':'GET',input,userId},res={};if(!await ai(req,res,new URL('http://synthetic'+path)))await manual(req,res,new URL('http://synthetic'+path));return res;}
  const turn=(text,state,extra={})=>request('/api/assistant/interpret',{text,state,sessionId,turnId:crypto.randomUUID(),...extra});
  return {request,turn,store,calls,get db(){return db;},get writes(){return writes;},set time(value){time=new Date(value);},sessionId};
}
async function main(){
  const h=harness(),before=JSON.stringify(h.db);let r=await h.turn('Schedule Chloe Andy at market Street tomorrow');assert.equal(r.status,200);assert.equal(r.data.source,'ai');assert.match(r.data.message,/Did you mean Chloe.*Andi/);assert.equal(r.data.draft.date,'2026-10-08');assert.equal(h.calls.length,1);
  const firstPayload=JSON.parse(h.calls[0].input);assert.ok(firstPayload.projectNames);assert.equal(firstPayload.memberNames,undefined);assert.equal(h.calls[0].store,false);assert.equal(h.calls[0].service_tier,'default');assert.equal(h.calls[0].tools,undefined);
  const named=harness();let clarification=await named.turn('Schedule Chloe Andy at market Street tomorrow');clarification=await named.turn('Chloe and Andi',clarification.data.state);assert.doesNotMatch(JSON.parse(named.calls[1].input).lastQuestion,/\(ID \d+\)/,'display-only clarification IDs never enter generated provider context');assert.deepEqual(clarification.data.draft.memberIds,[11,12]);
  r=await h.turn('yes',r.data.state);assert.equal(h.calls.length,1);assert.deepEqual(r.data.draft.memberIds,[11,12]);assert.match(r.data.message,/start time/);
  for(const text of ['8 AM','4 PM','Frame the west wall','Check the layout with the supervisor.'])r=await h.turn(text,r.data.state);
  assert.equal(r.data.ready,true);assert.equal(h.calls.length,5);assert.equal(h.writes,0);assert.equal(JSON.stringify(h.db),before);
  const fields=JSON.parse(h.calls.at(-1).input);assert.deepEqual(fields.memberNames,['Chloe','Andi']);assert.equal(fields.draft.people,'Chloe and Andi');assert.equal(fields.draft.memberIds,undefined);for(const marker of ['EXCLUDED_REPORT','EXCLUDED_CUSTOMER','Private member','Private synthetic site','example.invalid','crew'])assert.ok(!JSON.stringify(fields).includes(marker),marker);
  const preview=await h.request('/api/projects/101/assistant/preview',r.data.draft);assert.ok(preview.data.token);assert.equal(h.writes,0);
  const confirm={token:preview.data.token,version:preview.data.version,confirmed:true};assert.equal((await h.request('/api/projects/101/assistant/confirm',confirm)).status,201);assert.equal(h.writes,1);assert.equal((await h.request('/api/projects/101/assistant/confirm',confirm)).data.repeated,true);assert.equal(h.writes,1);
  h.time='2026-10-08T08:01:00Z';const expired=await h.turn('Actually finish at 3 PM',r.data.state);assert.equal(expired.data.source,'form');assert.equal(h.calls.length,5);
  const exact=harness();const initial={text:Object.keys(utterances).find(text=>text.startsWith('Put ')),sessionId:exact.sessionId,turnId:crypto.randomUUID()};let full=await exact.request('/api/assistant/interpret',initial);assert.equal(full.data.ready,true);assert.equal(exact.writes,0);
  const repeated=await exact.request('/api/assistant/interpret',initial);assert.equal(exact.calls.length,1);assert.equal(repeated.data.ready,true);exact.db.team[0].crew='B';const restricted=await exact.request('/api/assistant/interpret',initial);assert.equal(exact.calls.length,1);assert.ok(!restricted.data.context.members.some(row=>row.id===11));assert.equal(restricted.data.draft.memberIds,undefined);assert.equal(restricted.data.ready,false);
  const correction=harness();let c=await correction.turn(initial.text);c=await correction.turn('Actually finish at 3 PM',c.data.state);assert.equal(c.data.draft.end,'15:00');assert.equal(c.data.draft.instructions,'verify the layout');c=await correction.turn('change task',c.data.state);assert.match(c.data.message,/What task/);assert.equal(correction.calls.length,2);
  for(const field of ['start date','end date','weekdays','person','people']){const edit=harness();let result=await edit.turn(initial.text);result=await edit.turn('change '+field,result.data.state);assert.equal(result.data.ready,false,field);assert.equal(edit.calls.length,1);}
  const midnight=harness();midnight.time='2026-10-08T06:59:50Z';let anchored=await midnight.turn(initial.text);assert.equal(anchored.data.draft.startDate,'2026-10-08');midnight.time='2026-10-08T07:00:10Z';anchored=await midnight.turn('Frame the west wall',anchored.data.state);assert.equal(anchored.data.draft.startDate,'2026-10-08');anchored=await midnight.turn('Make that tomorrow instead',anchored.data.state);assert.equal(anchored.data.draft.startDate,'2026-10-09');
  const legacy=harness();delete legacy.db.users[1].companyId;assert.equal((await legacy.request('/api/assistant/context')).status,200,'verified session permits legacy stored-user shape');
  for(const zone of ['', 'not/a-zone']){const unknownZone=harness();unknownZone.db.company.timezone=zone;const ask=await unknownZone.turn(initial.text);assert.equal(ask.data.source,'form');assert.match(ask.data.message,/owner.*confirm.*company timezone/);assert.equal(unknownZone.calls.length,0);}
  const role=harness();let p=await role.turn(initial.text);role.db.users[1].permissions.scheduleCrews=false;const lost=await role.turn('Actually finish at 3 PM',p.data.state);assert.equal(lost.data.source,'form');assert.equal(role.calls.length,1);assert.equal((await role.request('/api/assistant/interpret',initial,4)).status,403);
  const injection=harness({adapter:()=>({changes:{...changes({action:'schedule'}),sql:'delete everything'},usage:{input_tokens:100,output_tokens:10}})});assert.equal((await injection.turn(initial.text)).data.source,'form');assert.equal(injection.writes,0);assert.equal(Object.values(injection.store.read().days)[0].total,306300);
  const invented=harness({adapter:()=>({changes:changes({action:'schedule',people:'Private member'}),usage:{input_tokens:100,output_tokens:10}})});assert.equal((await invented.turn(initial.text)).data.source,'form');assert.equal(invented.writes,0);
  const outage=harness({adapter:()=>{throw Error('Synthetic provider timeout');}});const bad={...initial,sessionId:outage.sessionId};assert.equal((await outage.request('/api/assistant/interpret',bad)).data.source,'form');await outage.request('/api/assistant/interpret',bad);assert.equal(outage.calls.length,1);assert.equal(Object.values(outage.store.read().days)[0].total,306300);
  const saved=process.env.OPENAI_MODEL;process.env.OPENAI_MODEL='unapproved-model';const unknown=harness();assert.equal((await unknown.turn(initial.text)).data.source,'form');assert.equal(unknown.calls.length,0);if(saved==null)delete process.env.OPENAI_MODEL;else process.env.OPENAI_MODEL=saved;
  await assert.rejects(()=>interpretOpenAI({},async()=>({ok:true,json:async()=>({status:'incomplete'})})),/did not finish/);
  let active=true,paid=0;const cancelledStore=memoryStore(),swap=cancelledStore.compareAndSwap;
  cancelledStore.compareAndSwap=async(...args)=>{const result=await swap(...args);active=false;return result;};
  const cancelled=createIntentService({budget:createBudget(cancelledStore,()=>new Date('2026-10-07T16:00:00Z')),contextFor:async()=>({projects:[{id:101,name:'Market Street Reno'}],today:'2026-10-07',timezone:'America/Los_Angeles'}),refresh:async()=>({}),enabled:()=>true,signingKey:()=> 'synthetic-only',now:()=>new Date('2026-10-07T16:00:00Z'),active:()=>active,adapter:async()=>{paid++;return {};}});
  assert.equal((await cancelled.turn({text:initial.text,sessionId:crypto.randomUUID(),turnId:crypto.randomUUID()},{})).source,'form');assert.equal(paid,0,'cancellation after reservation suppresses later provider dispatch');
  console.log('AI-first synthetic vertical slice passed: natural owner request, literal grounded fields, one-question clarification, minimal context, zero writes, preview/Confirm replay, corrections, stale roles, expired sessions, private crew replay, injection, unknown model and conservative timeout accounting.');
}
main().catch(error=>{console.error(error);process.exitCode=1});
module.exports={harness};
