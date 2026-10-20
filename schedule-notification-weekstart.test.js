'use strict';

const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');

const root=fs.mkdtempSync(path.join(os.tmpdir(),'pdl-schedule-notify-'));
const companyId='ce77ce77-ce77-4e77-8e77-ce77ce77ce77';
const ownerToken='schedule-notification-owner';
const tokenHash=token=>crypto.createHash('sha256').update(token).digest('hex');
const notifications=(ids,status='sent')=>Object.fromEntries(ids.map(id=>[id,{inAppAt:'2026-10-01T12:00:00.000Z',emailStatus:status}]));
const acknowledgements=ids=>Object.fromEntries(ids.map(id=>[id,{status:'acknowledged',at:'2026-10-01T12:30:00.000Z'}]));

const db={
  company:{id:companyId,name:'Monday Builders',demo:true,timezone:'UTC',weekStart:'monday'},
  projects:[{id:101,name:'North Ridge'},{id:102,name:'South Yard'}],
  team:[
    {id:7,name:'Chloe',crew:'A'},
    {id:8,name:'Andi',crew:'B'},
    {id:9,name:'Ben',crew:'C'},
    {id:10,name:'Failed Mail',crew:'D'},
    {id:11,name:'No Login',crew:'E'}
  ],
  assignments:[
    {id:1,projectId:101,date:'2026-10-05',start:'06:00',end:'14:00',crew:'A',memberIds:[7],activity:'Monday source'},
    {id:2,projectId:102,date:'2026-10-11',start:'07:00',end:'15:00',crew:'B',memberIds:[8],activity:'Sunday source'},
    {id:3,projectId:101,date:'2026-10-04',start:'09:00',end:'10:00',crew:'C',memberIds:[9],activity:'Outside Monday source week'},
    {id:10,projectId:101,date:'2026-11-02',start:'06:00',end:'14:00',crew:'A',memberIds:[7],activity:'Original',notifications:{...notifications([7]),...notifications([99])},acknowledgements:{...acknowledgements([7]),...acknowledgements([99])}},
    {id:11,projectId:101,date:'2026-11-03',start:'06:00',end:'14:00',crew:'A',memberIds:[7],activity:'Move one',notifications:{...notifications([7]),...notifications([99])},acknowledgements:{...acknowledgements([7]),...acknowledgements([99])}},
    {id:12,projectId:101,date:'2026-11-04',start:'06:00',end:'14:00',crew:'A',memberIds:[7,8],activity:'Split move',notifications:{...notifications([7]),...notifications([8]),...notifications([99])},acknowledgements:{...acknowledgements([7]),...acknowledgements([8]),...acknowledgements([99])}},
    {id:13,projectId:102,date:'2026-11-07',start:'07:00',end:'15:00',crew:'D',memberIds:[10],activity:'Provider failure',notifications:notifications([10]),acknowledgements:acknowledgements([10])},
    {id:14,projectId:102,date:'2026-11-08',start:'07:00',end:'15:00',crew:'E',memberIds:[11],activity:'No account',notifications:{...notifications([11]),...notifications([99])},acknowledgements:{...acknowledgements([11]),...acknowledgements([99])}},
    {id:15,projectId:101,date:'2026-11-12',start:'06:30',end:'14:30',crew:'A',memberIds:[7,8],activity:'Edit roster safely',notifications:notifications([7,8]),acknowledgements:acknowledgements([7,8])},
    {id:16,projectId:101,date:'2026-11-13',start:'06:30',end:'14:30',crew:'A',memberIds:[7,8],activity:'Remove one safely',notifications:notifications([7,8]),acknowledgements:acknowledgements([7,8])},
    {id:17,projectId:101,date:'2026-11-14',start:'07:00',end:'11:00',crew:'C',memberIds:[9],activity:'Cancel whole assignment',notifications:notifications([9]),acknowledgements:acknowledgements([9])},
    {id:18,projectId:102,date:'2026-11-15',start:'07:00',end:'11:00',crew:'E',memberIds:[11],activity:'No email cancellation',notifications:notifications([11]),acknowledgements:acknowledgements([11])}
  ],
  users:[
    {id:1,name:'Synthetic owner',email:'owner@example.com',role:'owner',status:'Active',companyId},
    {id:2,name:'Chloe',email:'chloe@example.com',role:'field',status:'Active',companyId,memberId:7},
    {id:3,name:'Andi',email:'andi@example.com',role:'field',status:'Active',companyId,memberId:8},
    {id:4,name:'Ben',email:'ben@example.com',role:'field',status:'Active',companyId,memberId:9},
    {id:5,name:'Failed Mail',email:'fail@example.com',role:'field',status:'Active',companyId,memberId:10}
  ],
  sessions:[{companyId,userId:1,tokenHash:tokenHash(ownerToken),expiresAt:'2099-01-01'}],
  crews:[],workdays:[],timeCards:[],timeOffRequests:[],reports:[],photos:[],auditLog:[],customers:[],changes:[],catalog:[]
};

const file=path.join(root,'db.json'),platformFile=path.join(root,'platform.json');
fs.writeFileSync(file,JSON.stringify(db));
fs.writeFileSync(platformFile,JSON.stringify({users:[],sessions:[]}));
Object.assign(process.env,{PDL_DB_FILE:file,PDL_PLATFORM_FILE:platformFile,PDL_REQUIRE_AUTH:'1',PDL_SUPABASE_ENABLED:'0',PDL_TRANSACTIONAL_DB:'off',PDL_STAGING:'0',PDL_EMAIL_DEV_MODE:'0',RESEND_API_KEY:'re_test_schedule',PDL_PUBLIC_URL:'https://app.prodailylink.test'});
for(const name of ['OPENAI_API_KEY','SENTRY_DSN','STRIPE_SECRET_KEY','STRIPE_WEBHOOK_SECRET'])delete process.env[name];
require('./database/supabase').loadLocalEnv=()=>{};

const nativeFetch=global.fetch,emailCalls=[];
global.fetch=async(input,options={})=>{
  const target=String(input);
  if(target==='https://api.resend.com/emails'){
    const message=JSON.parse(options.body);emailCalls.push(message);
    const rejected=(message.to||[]).includes('fail@example.com');
    return {ok:!rejected,status:rejected?503:200,json:async()=>({id:'email-'+emailCalls.length})};
  }
  return nativeFetch(input,options);
};

const {server}=require('./server');
const serverSource=fs.readFileSync('server.js','utf8');
assert.match(serverSource,/weekStartDay=db\.company\.weekStart==='sunday'\?0:1/,'a missing preference defaults to Monday on the repeat-week API too');

(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+server.address().port;
  const call=(method,route,input)=>nativeFetch(base+route,{method,signal:AbortSignal.timeout(10000),headers:{Authorization:'Bearer '+ownerToken,'Content-Type':'application/json','x-pdl-company':companyId},...(input===undefined?{}:{body:JSON.stringify(input)})}).then(async response=>({status:response.status,data:await response.json()}));
  const keys=value=>Object.keys(value||{}).sort();
  try{
    const repeated=await call('POST','/api/schedule/repeat-week',{targetStart:'2026-10-14',assignmentIds:[1,2,3]});
    assert.equal(repeated.status,200);
    assert.equal(repeated.data.created,2,'Monday through Sunday is the configured target week');
    assert.deepEqual(repeated.data.createdRows.map(row=>row.date).sort(),['2026-10-12','2026-10-18'],'Monday and Sunday retain their weekday in the next Monday-start week');
    assert.equal(repeated.data.skipped.length,1);
    assert.equal(repeated.data.skipped[0].reason,'Does not belong to the source week','the prior Sunday is not mistaken for part of a Monday-start source week');
    assert.equal(repeated.data.createdRows.find(row=>row.memberIds.includes(7)).notifications[7].emailStatus,'sent');
    assert.equal(repeated.data.createdRows.find(row=>row.memberIds.includes(8)).notifications[8].emailStatus,'sent');

    const beforeEditEmails=emailCalls.length;
    const edited=await call('PATCH','/api/assignments/10',{edit:true,projectId:101,memberIds:[7],crew:'A',date:'2026-11-02',start:'06:00',end:'14:00',activity:'Revised activity'});
    assert.equal(edited.status,200);
    assert.deepEqual(keys(edited.data.assignment.notifications),['7'],'material edit removes stale notification recipients');
    assert.deepEqual(keys(edited.data.assignment.acknowledgements),[],'material edit requires a fresh acknowledgement');
    assert.equal(edited.data.assignment.notifications[7].emailStatus,'sent','material edit records successful delivery');
    assert.equal(emailCalls.length,beforeEditEmails+1);
    assert.deepEqual(emailCalls.at(-1).to,['chloe@example.com']);
    assert.match(emailCalls.at(-1).subject,/^Schedule updated/);

    const beforeRosterEmails=emailCalls.length;
    const rosterEdit=await call('PATCH','/api/assignments/15',{edit:true,projectId:101,memberIds:[8],crew:'B',date:'2026-11-12',start:'06:30',end:'14:30',activity:'Edit roster safely'});
    assert.equal(rosterEdit.status,200);
    assert.deepEqual(rosterEdit.data.assignment.memberIds,[8]);
    assert.deepEqual(keys(rosterEdit.data.assignment.notifications),['8'],'removed members are not left in live notification state');
    const rosterEmails=emailCalls.slice(beforeRosterEmails);
    assert.equal(rosterEmails.length,2,'the removed member and remaining assignee each receive the correct notice');
    const rosterCancellation=rosterEmails.find(message=>message.to.includes('chloe@example.com')),rosterUpdate=rosterEmails.find(message=>message.to.includes('andi@example.com'));
    assert.match(rosterCancellation.subject,/^Assignment cancelled/);
    assert.match(rosterCancellation.html,/Edit roster safely/);
    assert.doesNotMatch(rosterCancellation.html,/Andi|South Yard/,'a removed recipient sees only their former assignment');
    assert.match(rosterUpdate.subject,/^Schedule updated/);

    const movedOne=await call('PATCH','/api/assignments/11',{memberId:7,targetMemberId:8,date:'2026-11-05'});
    assert.equal(movedOne.status,200);
    assert.deepEqual(movedOne.data.assignment.memberIds,[8]);
    assert.deepEqual(keys(movedOne.data.assignment.notifications),['8'],'single-person move replaces the old recipient state');
    assert.deepEqual(keys(movedOne.data.assignment.acknowledgements),[]);
    assert.equal(movedOne.data.assignment.notifications[8].emailStatus,'sent');
    assert.deepEqual(emailCalls.at(-1).to,['andi@example.com'],'the new assignee receives the move email');
    assert.match(emailCalls.at(-2).subject,/^Assignment cancelled/,'the replaced assignee is told the old shift was removed');
    assert.deepEqual(emailCalls.at(-2).to,['chloe@example.com']);

    const beforeDuplicateMoveEmails=emailCalls.length;
    const duplicateMove=await call('PATCH','/api/assignments/12',{memberId:7,targetMemberId:8,date:'2026-11-04'});
    assert.equal(duplicateMove.status,409,'moving onto another member in the same assignment is rejected');
    assert.match(duplicateMove.data.error,/already on this assignment/);
    assert.equal(emailCalls.length,beforeDuplicateMoveEmails,'a rejected move sends no email');
    const duplicateStored=JSON.parse(fs.readFileSync(file,'utf8')).assignments.find(row=>row.id===12);
    assert.deepEqual(duplicateStored.memberIds,[7,8],'a rejected move cannot create a duplicate overlapping row');

    const splitMove=await call('PATCH','/api/assignments/12',{memberId:7,targetMemberId:9,date:'2026-11-06'});
    assert.equal(splitMove.status,200);
    assert.deepEqual(splitMove.data.sourceAssignment.memberIds,[8]);
    assert.deepEqual(keys(splitMove.data.sourceAssignment.notifications),['8'],'split source retains only the remaining member notification');
    assert.deepEqual(keys(splitMove.data.sourceAssignment.acknowledgements),['8'],'split source retains only the remaining member acknowledgement');
    assert.deepEqual(splitMove.data.assignment.memberIds,[9]);
    assert.deepEqual(keys(splitMove.data.assignment.notifications),['9'],'split destination has only its new assignee');
    assert.equal(splitMove.data.assignment.notifications[9].emailStatus,'sent');
    assert.deepEqual(emailCalls.at(-1).to,['ben@example.com']);
    assert.match(emailCalls.at(-2).subject,/^Assignment cancelled/);
    assert.deepEqual(emailCalls.at(-2).to,['chloe@example.com']);

    const rejected=await call('PATCH','/api/assignments/13',{edit:true,projectId:102,memberIds:[10],crew:'D',date:'2026-11-07',start:'07:00',end:'15:00',activity:'Provider failure changed'});
    assert.equal(rejected.status,200,'email provider trouble does not discard a valid schedule edit');
    assert.equal(rejected.data.assignment.notifications[10].emailStatus,'failed','provider rejection is reported truthfully');

    const noLogin=await call('PATCH','/api/assignments/14',{edit:true,projectId:102,memberIds:[11],crew:'E',date:'2026-11-08',start:'07:00',end:'15:00',activity:'No account changed'});
    assert.equal(noLogin.status,200);
    assert.deepEqual(keys(noLogin.data.assignment.notifications),['11']);
    assert.equal(noLogin.data.assignment.notifications[11].emailStatus,'not_available','a member without an active email account is not reported as sent');

    const beforeCreatedEmails=emailCalls.length;
    const created=await call('POST','/api/assignments',{projectId:101,memberIds:[7],crew:'A',date:'2026-11-10',endDate:'2026-11-11',includeWeekends:true,start:'08:00',end:'12:00',activity:'Fresh multi-day assignment'});
    assert.equal(created.status,201);
    assert.equal(created.data.assignments.length,2);
    assert.ok(created.data.assignments.every(row=>row.notifications[7].emailStatus==='sent'),'manual create uses the same centralized delivery path');
    assert.equal(emailCalls.length,beforeCreatedEmails+1,'rows for one project are delivered in one message');
    const multiDayEmail=emailCalls.at(-1);
    assert.match(multiDayEmail.html,/Tue, Nov 10/);
    assert.match(multiDayEmail.html,/Wed, Nov 11/);
    assert.equal((multiDayEmail.html.match(/08:00–12:00 · Fresh multi-day assignment/g)||[]).length,2,'each date keeps its own shift and activity details');

    const beforeRemoveOneEmails=emailCalls.length;
    for(const suffix of ['?memberId=abc','?memberId=999']){
      const invalidRemoval=await call('DELETE',`/api/assignments/16${suffix}`);
      assert.ok([400,404].includes(invalidRemoval.status),'a malformed or nonmember removal is rejected');
      assert.deepEqual(JSON.parse(fs.readFileSync(file,'utf8')).assignments.find(row=>row.id===16).memberIds,[7,8],'an invalid person selector cannot become a whole-assignment delete');
      assert.equal(emailCalls.length,beforeRemoveOneEmails,'a rejected removal sends no cancellation');
    }
    const removedOne=await call('DELETE','/api/assignments/16?memberId=7');
    assert.equal(removedOne.status,200);
    assert.equal(emailCalls.length,beforeRemoveOneEmails+1);
    assert.match(emailCalls.at(-1).subject,/^Assignment cancelled/);
    assert.deepEqual(emailCalls.at(-1).to,['chloe@example.com']);
    let afterRemoval=JSON.parse(fs.readFileSync(file,'utf8'));
    assert.deepEqual(afterRemoval.assignments.find(row=>row.id===16).memberIds,[8]);
    assert.deepEqual(keys(afterRemoval.assignments.find(row=>row.id===16).notifications),['8']);

    const beforeRemoveAllEmails=emailCalls.length;
    const removedAll=await call('DELETE','/api/assignments/17');
    assert.equal(removedAll.status,200);
    assert.equal(emailCalls.length,beforeRemoveAllEmails+1);
    assert.match(emailCalls.at(-1).subject,/^Assignment cancelled/);
    assert.deepEqual(emailCalls.at(-1).to,['ben@example.com']);
    assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).assignments.some(row=>row.id===17),false);

    const beforeUnavailableCancellation=emailCalls.length;
    assert.equal((await call('DELETE','/api/assignments/18')).status,200);
    assert.equal(emailCalls.length,beforeUnavailableCancellation,'a member without an active email account is not reported as emailed');

    const stored=JSON.parse(fs.readFileSync(file,'utf8'));
    assert.deepEqual(keys(stored.assignments.find(row=>row.id===10).notifications),['7'],'cleaned edit recipients persist');
    assert.deepEqual(keys(stored.assignments.find(row=>row.id===12).notifications),['8'],'cleaned split recipients persist');
    const cancellationAudit=stored.auditLog.filter(row=>row.type==='assignment_notification');
    assert.ok(cancellationAudit.some(row=>row.event==='removed'&&row.memberId===7&&row.emailStatus==='sent'),'successful cancellation delivery is recorded truthfully');
    assert.ok(cancellationAudit.some(row=>row.event==='removed'&&row.memberId===11&&row.emailStatus==='not_available'),'missing email access remains not_available');
    console.log('Schedule notification/week-start passed: Monday weeks, exact multi-row messages, conflict-safe moves, truthful updates/cancellations, and stale-recipient cleanup.');
  }finally{
    global.fetch=nativeFetch;
    server.closeAllConnections();
    await new Promise(resolve=>server.close(resolve));
    fs.rmSync(root,{recursive:true,force:true});
  }
})().catch(error=>{console.error(error);process.exitCode=1;try{server.close()}catch{}});
