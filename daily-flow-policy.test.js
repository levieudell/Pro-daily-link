'use strict';
const assert=require('node:assert/strict');
const {explicitSafety,previousNextSteps,canEndWorkday}=require('./daily-flow-policy');
assert.equal(explicitSafety('Installed 20 feet of pipe. Tomorrow bring guards.'),'');
assert.match(explicitSafety('Installed pipe. Safety concern: unguarded opening. Tomorrow bring guards.'),/unguarded opening/);
assert.match(explicitSafety('Peligro: abertura sin protección.'),/Peligro/);
const db={projects:[{id:1},{id:2}],reports:[
 {id:1,project:0,dateIso:'2026-10-04',status:'Approved',next:'Old plan'},
 {id:2,project:0,dateIso:'2026-10-05',status:'Needs review',next:'Bring guards'},
 {id:3,project:0,dateIso:'2026-10-06',status:'Approved',next:'Today excluded'},
 {id:4,project:1,dateIso:'2026-10-05',status:'Approved',next:'Other project'},
 {id:5,project:0,dateIso:'2026-10-05',status:'Draft',next:'Unsubmitted excluded'}]};
assert.deepEqual(previousNextSteps(db,1,'2026-10-06'),{reportId:2,date:'2026-10-05',status:'Needs review',text:'Bring guards'});
db.reports.push({id:6,project:0,dateIso:'2026-10-05',status:'Approved',next:''});
assert.equal(previousNextSteps(db,1,'2026-10-06'),null,'do not resurrect superseded instructions');
assert.equal(previousNextSteps(db,99,'2026-10-06'),null);
const day={memberIds:[1],projectId:1};
assert.equal(canEndWorkday(db,{role:'field',memberId:2},day,()=>true),false);
assert.equal(canEndWorkday(db,{role:'field',memberId:1},day,()=>true),true);
assert.equal(canEndWorkday(db,{role:'project_manager',permissions:{manageTime:false}},day,()=>true),false);
assert.equal(canEndWorkday(db,{role:'project_manager',permissions:{manageTime:true}},day,()=>false),false);
assert.equal(canEndWorkday(db,{role:'owner'},day,()=>false),true);
console.log('Daily flow policy passed: explicit safety, dated submitted sources, no resurrection, project boundaries and clock-out authorization.');
