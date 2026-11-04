'use strict';
const assert=require('node:assert/strict');
const {summarize}=require('./crew-workspace');
const {countedHours}=require('./report-labor-review');
const crew={id:1,name:'Concrete'};
const fixture={today:'2026-10-31',timezone:'America/Los_Angeles',countedHours,
 team:[{id:1,name:'Moved in',crew:'Concrete'},{id:2,name:'Moved out',crew:'Pipe'}],
 projects:[{id:10,name:'Clinic',archived:true},{id:20,name:'School'}],
 assignments:[{id:100,crew:'Concrete',projectId:20,date:'2026-11-02',memberIds:[1]},{id:101,crew:'Pipe',projectId:10,date:'2026-11-01',memberIds:[1]}],
 reports:[{id:1,crew:'Concrete',project:0,dateIso:'2026-10-20',status:'Approved',laborEntries:[{memberId:2,hours:8}]},{id:2,crew:'Pipe',project:0,dateIso:'2026-10-21',status:'Approved',sourceAssignmentId:100,laborEntries:[{memberId:1,hours:10}]},{id:3,crew:'Concrete',project:1,dateIso:'2026-10-22',status:'Draft',laborEntries:[{memberId:1,hours:9}]},{id:4,crew:'Concrete',project:9,dateIso:'2026-10-23',status:'Approved',laborEntries:[{memberId:1,hours:30}]},{id:5,crew:'Concrete',project:0,dateIso:'2026-10-24',status:'Needs review',laborEntries:[{memberId:1,hours:3}]}],
 workdays:[{id:30,crew:'Concrete',projectId:10,startedAt:'2026-10-21T01:00:00Z',endedAt:'2026-10-21T02:00:00Z',memberIds:[2]},{id:31,crew:'Pipe',projectId:20,startedAt:'2026-10-19T14:00:00Z',endedAt:'2026-10-19T20:00:00Z',memberIds:[1]},{id:32,projectId:20,status:'active',memberIds:[1]}]};
const snapshot=JSON.stringify(fixture),result=summarize(crew,fixture);
assert.equal(result.jobs.length,1,'scheduled work, drafts, other crews and inaccessible projects do not become jobs worked');
assert.equal(result.jobs[0].project.id,10);assert.equal(result.jobs[0].days,2,'workday and daily on the same company date count once');
assert.equal(result.jobs[0].dailyCount,2);assert.equal(result.approvedHours,8,'former member work remains with its recorded crew; current members do not import old work');
assert.equal(result.members.length,1);assert.equal(result.working.length,1);assert.equal(result.upcoming.length,1);assert.equal(result.needsReview.length,2);
assert.equal(JSON.stringify(fixture),snapshot,'summary never mutates source records');
assert.equal(summarize(crew,{...fixture,countedHours:null}).approvedHours,0,'no hours without the authorized calculator');
assert.equal(summarize(crew,{...fixture,projects:[]}).jobs.length,0,'only supplied project scope is used');
const linked=summarize(crew,{...fixture,reports:[{id:6,sourceAssignmentId:100,project:1,dateIso:'2026-10-25',status:'Approved',laborEntries:[{memberId:1,hours:4}]}]});
assert(linked.jobs.some(row=>row.project.id===20),'records missing a crew can use their explicit assignment link');
const explicit=summarize(crew,{...fixture,reports:[{id:7,crewId:2,crew:'Concrete',project:0,status:'Approved',laborEntries:[{memberId:1,hours:12}]}],workdays:[]});
assert.equal(explicit.jobs.length,0,'explicit crew identity wins over a matching name');
const duplicate=summarize(crew,{...fixture,reports:[fixture.reports[0],fixture.reports[0]],workdays:[]});assert.equal(duplicate.approvedHours,8);
const excluded=summarize(crew,{...fixture,reports:[{...fixture.reports[0],laborExclusions:[{memberId:2,hours:3}]}],workdays:[]});assert.equal(excluded.approvedHours,5,'daily labor exclusions are respected');
const empty=summarize(crew);assert.equal(empty.jobs.length,0);assert.equal(empty.upcoming.length,0);
console.log('Crew summaries passed: recorded history, moved members, approved hours, draft/scheduled separation, project scope, explicit identity, company dates and deduplication.');
