'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),{review}=require('./schedule-approved-labor');
const projects=[{id:1,name:'Synthetic job',code:'QA'},{id:2,name:'Other job',code:'QB'}],date='2026-10-06';
const assignment=(id,projectId=1,day=date,memberIds=[1])=>({id,projectId,date:day,memberIds,start:'08:00',end:'12:00',activity:'Synthetic work'});
const report=(id,hours,project=0,day=date,memberId=1)=>({id,project,dateIso:day,status:'Approved',laborEntries:[{memberId,hours}]});
let input={projects,assignments:[assignment(1),{...assignment(2),start:'13:00',end:'17:00'}],reports:[report(10,4)],memberIds:[1]},before=JSON.stringify(input),result=review(input);
assert.equal(result.hours,4);assert.equal(result.unallocatedGroups,1);assert.equal(result.groups[0].assignmentCount,2);assert.equal(JSON.stringify(input),before);
assert.equal(review({...input,assignments:[assignment(1),{...assignment(1),start:'13:00',end:'17:00'}]}).unallocatedGroups,1,'duplicate assignment IDs cannot prove a valid shift split');
assert.equal(review({projects,assignments:[assignment(1,1,date,[1,2])],reports:[{...report(10,4),laborEntries:[{memberId:1,hours:4},{memberId:2,hours:4}]}],memberIds:[1,2]}).hours,8,'two people with four hours each retain eight crew-hours');
input.reports=[{...report(10,2),workdayId:20},{...report(11,3),workdayId:21}];assert.equal(review(input).hours,5,'distinct approved shifts/reports retained');assert.equal(review(input).unallocatedGroups,1,'workday IDs do not establish assignment attribution');
input.reports=[report(10,4),report(10,4)];assert.equal(review(input).hours,4,'same source report/person evidence counted once');
input.reports=[{...report(10,4),laborEntries:[{memberId:1,hours:1},{memberId:1,hours:3}]}];assert.equal(review(input).hours,4,'within-report contributions retained');
input.reports=[report(10,4),{...report(11,8),status:'Needs review'},{...report(12,8),deletedAt:'2026-10-07'}];assert.equal(review(input).hours,4);
input={projects,assignments:[assignment(1),assignment(2,2),assignment(3,1,date,[2])],reports:[report(10,4),report(11,3,1),report(12,20,0,date,2)],memberIds:[1]};assert.equal(review(input).hours,7,'crew filter excludes hidden member while preserving both jobs');
assert.equal(review({...input,assignments:input.assignments.filter(row=>row.projectId===2)}).hours,3,'selected project scope');
const boundaryRows=[assignment(1,1,'2026-10-03'),assignment(2,1,'2026-10-04'),assignment(3,1,'2026-10-10'),assignment(4,1,'2026-10-11')],boundaryReports=boundaryRows.map((row,i)=>report(10+i,i+1,0,row.date));
assert.equal(review({projects,assignments:boundaryRows.filter(row=>row.date>='2026-10-04'&&row.date<='2026-10-10'),reports:boundaryReports,memberIds:[1]}).hours,5,'week edges inclusive; neighboring weeks excluded');
assert.equal(review({projects,assignments:boundaryRows.filter(row=>row.date==='2026-10-10'),reports:boundaryReports,memberIds:[1]}).hours,3,'day scope');
assert.equal(review({...input,reports:[{...report(10,4),workdayId:null}]}).hours,4,'missing workday linkage keeps matching approved labor');
assert.equal(review({...input,reports:[{...report(10,4),project:null}]}).hours,0,'unknown project cannot be attributed');
const missingId={...report(10,2)};delete missingId.id;assert.equal(review({...input,reports:[missingId,{...missingId}]}).hours,4,'unknown report identity is not silently merged');

const app=fs.readFileSync(__dirname+'/app.js','utf8'),lines=app.split('\n'),nodes=new Map(),blocks=[];
function node(id){if(!nodes.has(id))nodes.set(id,{value:'',checked:false,hidden:false,innerHTML:'',textContent:'',dataset:{},classList:{toggle(){},add(){},remove(){}},setAttribute(){}});return nodes.get(id)}
function code(name){const start=lines.findIndex(line=>line.startsWith('function '+name+'('));assert.ok(start>=0,name);if(lines[start].trimEnd().endsWith('}'))return lines[start];const end=lines.findIndex((line,i)=>i>start&&line.trimEnd()==='}');return lines.slice(start,end+1).join('\n')}
const c={$:node,$$:selector=>selector==='[data-assignment]'?blocks:[],reports:[report(10,4)],projects,team:[{id:1,name:'Synthetic visible',initials:'SV',crew:'Visible',role:'field'},{id:2,name:'Hidden person',crew:'Hidden',role:'field'}],assignments:[assignment(1),assignment(2)],workdays:[],
 scheduleView:'week',preferredLanguage:'en',scheduleAvailabilityStatus:'ready',currentUser:{role:'project_manager',preferences:{}},canManageSchedule:()=>false,isOfficeMember:()=>false,localDateIso:()=> '2026-10-08',
 schedulePeriodDays:()=>[{date,label:'TUE 6'}],scheduleDate:()=>new Date('2026-10-06T12:00:00Z'),scheduleWeekStart:()=>new Date('2026-10-04T12:00:00Z'),
 scheduleLeaveMarkup:()=>'',scheduleDayLeaveMarkup:()=>'',scheduleUnavailableSummary:()=>'',scheduleUnavailable:()=>false,formatDate:value=>value,displayTime:value=>value,escapeHtml:value=>String(value).replaceAll('<','&lt;'),
 window:{PDLScheduleApprovedLabor:{review},PDLLocale:{refresh(){}}},openScheduledWork:(id,memberId)=>c.opened={id,memberId},openAssignment(){}};
node('#schedule-crew-filter').value='Visible';c.EmployeeRoster=require('./employee-roster');vm.createContext(c);for(const name of ['shiftHours','assignmentActualHours','scheduleMobileMarkup','renderSchedule'])vm.runInContext(code(name),c);
c.renderSchedule();assert.match(node('#schedule-summary').innerHTML,/<small>APPROVED DAILY HOURS<\/small><strong>4\.0<\/strong>/);assert.match(node('#schedule-summary').innerHTML,/unallocated between assignments/);assert.match(node('#schedule-summary').innerHTML,/<strong>1<\/strong>/);
assert.equal((node('#schedule-board').innerHTML.match(/assignment split unallocated/g)||[]).length,2);assert.ok(!node('#schedule-board').innerHTML.includes('4.0 actual'),'no daily total repeated as individual actual hours');assert.ok(!node('#schedule-board').innerHTML.includes('Hidden person'));
c.assignments=[assignment(1)];c.renderSchedule();assert.match(node('#schedule-board').innerHTML,/4\.0h approved for day/);assert.doesNotMatch(node('#schedule-board').innerHTML,/assignment split unallocated/);
c.assignments=[assignment(1),assignment(2)];c.preferredLanguage='es';c.renderSchedule();assert.match(node('#schedule-board').innerHTML,/reparto sin asignar/);assert.match(node('#schedule-summary').innerHTML,/sin distribuir/);
c.scheduleView='month';c.renderSchedule();assert.match(node('#schedule-summary').innerHTML,/<strong>4\.0<\/strong>/);assert.match(node('#schedule-board').innerHTML,/schedule-mobile-agenda/);
const target={dataset:{assignment:'1',member:'1'},classList:{add(){},remove(){}}};blocks.push(target);c.scheduleView='day';c.renderSchedule();target.onclick({stopPropagation(){}});assert.deepEqual(c.opened,{id:1,memberId:1});c.opened=null;target.onkeydown({key:'Enter',preventDefault(){},stopPropagation(){}});assert.deepEqual(c.opened,{id:1,memberId:1});
assert.match(fs.readFileSync(__dirname+'/index.html','utf8'),/schedule-approved-labor\.js[\s\S]*app\.js/);
console.log('Schedule approved labor passed: counted source evidence once, separate shifts/reports, crew/project/date/week scopes, missing linkage, no guessing, English/Spanish real week/day/month/mobile rendering and read-only click/keyboard handlers. Browser/device visual QA not claimed.');
