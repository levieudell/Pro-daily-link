const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {linkTeamAccount}=require('./team-account-link'),review=require('./office-review');
const fixture=()=>({team:[{id:3,name:'Worker',email:'person@example.invalid'}],users:[{id:4,name:'Login',email:'PERSON@example.invalid',role:'admin',permissions:{manageTime:true},permissionGrants:['payroll'],passwordHash:'test-only',projectIds:[9],status:'Active',memberId:null}]});
const owner={id:1,name:'Owner',role:'owner'};
let db=fixture(),before=structuredClone(db.users[0]);linkTeamAccount(db,owner,4,3,'2026-11-02T15:00:00Z');
assert.deepEqual(db.users[0],{...before,memberId:3,updatedAt:'2026-11-02T15:00:00Z'});
assert.equal(db.auditLog[0].type,'team_login_linked');linkTeamAccount(db,owner,4,3);assert.equal(db.auditLog.length,1);
for(const [mutate,actor,status] of [
 [()=>{},null,401],[()=>{},{role:'admin'},403],[d=>d.team[0].email='other@example.invalid',owner,400],
 [d=>d.users[0].memberId=77,owner,409],[d=>d.team.push({...d.team[0],id:8}),owner,409],
 [d=>d.users.push({...d.users[0],id:8}),owner,409],[d=>d.users.push({id:8,memberId:3}),owner,409],
 [d=>d.team=[],owner,404]
]) {db=fixture();mutate(db);const snapshot=JSON.stringify(db);assert.throws(()=>linkTeamAccount(db,actor,4,3),e=>e.statusCode===status);assert.equal(JSON.stringify(db),snapshot);}
assert.equal(review.duration(1474.711),'24 min 35 sec');assert.equal(review.duration(3661),'1 h 1 min 1 sec');assert.equal(review.duration(0),'0 sec');assert.equal(review.duration(null),'Not available');
assert.equal(review.date('2026-11-02'),'11/02/2026');assert.equal(review.date(''),'');
const markup=review.warning({id:2,officeReview:{reasons:[{message:'Check <hours>'},{message:'Check <hours>'}],measuredClock:[{memberId:1,seconds:1474.711}],reportedLabor:[{memberId:1,hours:35}]}},[{id:1,name:'<Worker>'}]);
assert.equal((markup.match(/<li>/g)||[]).length,1);assert.match(markup,/Check &lt;hours&gt;/);assert.match(markup,/24 min 35 sec/);assert.match(markup,/<details>/);assert.match(markup,/data-review-daily="2"/);assert(!markup.includes('<Worker>'));
const safety=fs.readFileSync('safety-pm-ui.js','utf8'),start=safety.indexOf('  function hazardMarkup('),end=safety.indexOf('  function dayMarkup(',start);
const ctx={esc:s=>String(s||''),workDate:review.date,dateTime:s=>s,fields:()=>'',hazardStopControl:()=>'',revisionField:()=>1};vm.createContext(ctx);vm.runInContext(safety.slice(start,end),ctx);
const history=ctx.hazardMarkup({date:'2026-10-27',data:{canManage:true}},{status:'voided',date:'2026-10-27',workStopped:true,voidReason:'Wrong job',createdBy:'Recorder',voidedBy:'Owner'});
assert.match(history,/Recorded in error/);assert.match(history,/Wrong job/);assert.match(history,/Recorded by Recorder/);assert(!history.includes('data-safety-hazard-update'));assert(!history.includes('Affected work stopped'));
const {timePeople,payRangePreview}=require('./time-approval-controls');
const people=timePeople([{memberId:1,hours:8,status:'approved',inAt:'2026-11-02T08:00:00Z',outAt:'2026-11-02T16:00:00Z'},{memberId:2,hours:8,status:'submitted',inAt:'2026-11-02T08:00:00Z',outAt:'2026-11-02T16:00:00Z'}],[{id:1,name:'A approved'},{id:2,name:'Z needs approval'}],c=>c.status==='approved');
assert.equal(people[0].id,'2');assert.match(payRangePreview('2026-11-02','2026-11-08','UTC'),/^11\/02\/2026 through 11\/08\/2026/);
console.log('Office review unit tests passed: explicit linking/access preservation/conflicts, evidence/time display, corrected hazard history, dates and approval priority.');

// Generated action-center dates are formatted at their source; user notes stay untouched.
const server=fs.readFileSync('server.js','utf8'),actionStart=server.indexOf('function buildActionCenter('),actionEnd=server.indexOf('\nfunction ',actionStart+10);
const ac={require,companyDateIso:()=> '2026-11-02',companyTime24:()=> '18:00',reportDateLabel:()=> 'Nov 1'};vm.createContext(ac);vm.runInContext(server.slice(actionStart,actionEnd),ac);
const actions=ac.buildActionCenter({company:{},projects:[{id:1,name:'Job'}],reports:[{id:1,project:0,dateIso:'2026-11-01',status:'Needs review',foreman:'Worker'}],assignments:[{id:1,projectId:1,date:'2026-10-30'}]});
assert(actions.items.some(i=>i.detail.includes('11/01/2026')));assert(actions.items.some(i=>i.detail.includes('10/30/2026')));
const {pdlExportTimestamp}=require('./reporting-controls');assert.match(pdlExportTimestamp('2026-11-02T01:00:00Z','America/Los_Angeles'),/^11\/01\/2026/);

const cardStart=safety.indexOf('  function v3HazardCard('),cardEnd=safety.indexOf('  function v3Followup(',cardStart);
Object.assign(ctx,{language:()=> 'en',tr:x=>x});vm.runInContext(safety.slice(cardStart,cardEnd),ctx);
const source=ctx.v3HazardCard({date:'2026-10-27',data:{canVerify:false,day:{revision:1}}},{id:'h1',status:'open',date:'2026-10-27',createdBy:'Recorder',createdAt:'2026-10-27T15:00:00Z',sourceCheckId:'check-1',action:'Actual saved action'});
assert.match(source,/Record source/);assert.match(source,/Recorded by Recorder/);assert.match(source,/Checklist response/);assert.match(source,/10\/27\/2026/);assert.match(source,/Actual saved action/);
