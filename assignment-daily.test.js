'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('app.js','utf8').replace(/\r/g,''),serverSource=fs.readFileSync('server.js','utf8').replace(/\r/g,'');
function declaration(text,name){const start=text.indexOf(`function ${name}(`);assert.ok(start>=0);const first=text.indexOf('\n',start);if(text.slice(start,first).trimEnd().endsWith('}'))return text.slice(start,first);const end=text.indexOf('\n}',first);return text.slice(start,end+2);}
const nodes=new Map(),$=id=>{if(!nodes.has(id))nodes.set(id,{value:'',options:[{}],innerHTML:'',dataset:{},files:[],open:false,focus(){},insertAdjacentHTML(_,html){this.innerHTML+=html;}});return nodes.get(id);};
const date='2026-10-08',rows=[{id:1,projectId:11,date,crew:'Crew A',activity:'First scope',start:'07:00',end:'12:00',memberIds:[7]},
 {id:2,projectId:11,date,crew:'Crew B',activity:'Second scope',start:'12:00',end:'16:00',memberIds:[7]},
 {id:3,projectId:22,date,crew:'Other crew',activity:'Restricted scope',memberIds:[8]}];
let opens=0,messages=[];
const context={$,$$:()=>[],projects:[{id:11,name:'Synthetic Job'}],assignments:structuredClone(rows),currentRole:'field',currentUser:{id:1,memberId:7,role:'field'},team:[],editingReportId:null,reportSourceAssignmentId:null,
 companyTodayIso:()=>date,escapeHtml:String,displayTime:String,populateReportLabor(){},reportWorkSuggestions:()=>[],
 openReportBeforeSimpleFieldUx(report,options){opens++;$('#report-modal').open=true;$('#report-project').value=String(report?.project??options.projectIndex??0);$('#report-date').value=report?.dateIso||options.dateIso||date;},
 updateReportReviewDateBanner(){},addReportMapLink(){},clearTimeCardDerivedReportLabor(){},refreshReportLaborFromTimeCards(){},loadReportWeather(){},notify(message){messages.push(message);},
 applyReportType(){},applyReportLanguage(){},document:{getElementById:id=>$('#'+id)},DailyWorkExtraction:{groundReviewSuggestions:x=>x},addProductionRow(){},showReportMessage(){}};
vm.createContext(context);vm.runInContext(['reportAssignmentsForDate','reportAssignmentForContext','renderReportJobContext','openDailyForAssignment','reportRecoverySnapshot','restoreRecoveredReportFields'].map(n=>declaration(source,n)).join('\n')+'\n'+source.match(/^openReport=function\(report=null,context=\{\}\)\{reportSourceAssignmentId=.*$/m)[0],context);
context.openDailyForAssignment(rows[1]);assert.equal(context.reportSourceAssignmentId,2);assert.equal($('#report-crew').value,'Crew B');assert.match($('#report-job-context').innerHTML,/Second scope/);assert.doesNotMatch($('#report-job-context').innerHTML,/First scope/);
$('#field-notes').value='User edited notes';$('#report-crew').value='Edited crew';context.renderReportJobContext();assert.equal($('#report-crew').value,'Edited crew');
context.openDailyForAssignment(rows[0]);assert.equal(opens,1);assert.equal($('#field-notes').value,'User edited notes');assert.equal(context.reportSourceAssignmentId,2,'repeated/different assignment clicks preserve the open form');
const draft=context.reportRecoverySnapshot();assert.equal(draft.sourceAssignmentId,2);assert.equal(draft.crew,'Edited crew');
$('#report-modal').open=false;context.openReport(null,{projectIndex:0,dateIso:date,assignmentId:draft.sourceAssignmentId,preserveAssignmentEdits:true});context.restoreRecoveredReportFields(draft);assert.equal(context.reportSourceAssignmentId,2);assert.equal($('#report-crew').value,'Edited crew');assert.match($('#report-job-context').innerHTML,/Second scope/);
context.restoreRecoveredReportFields({...draft,crew:''});assert.equal($('#report-crew').value,'','explicitly cleared crew survives recovery');
context.restoreRecoveredReportFields(draft);
context.assignments=context.assignments.filter(row=>row.id!==2);context.renderReportJobContext();assert.match($('#report-job-context').innerHTML,/no longer available/);assert.doesNotMatch($('#report-job-context').innerHTML,/First scope/);assert.equal($('#report-crew').value,'Edited crew');
$('#report-modal').open=false;const before=opens;context.openDailyForAssignment(rows[1]);assert.equal(opens,before,'deleted assignment cannot open another shift');
for(const bad of [rows[2],{...rows[0],id:99}]){context.openDailyForAssignment(bad);assert.equal(opens,before);}
context.currentUser.memberId=null;context.openDailyForAssignment(rows[0]);assert.equal(opens,before);context.currentUser.memberId=7;context.currentRole='office';context.openDailyForAssignment(rows[0]);assert.equal(opens,before);
context.currentRole='field';context.openDailyForAssignment(rows[0]);assert.equal(context.reportSourceAssignmentId,1);assert.equal($('#report-crew').value,'Crew A','close/reopen starts from the newly selected assignment');
$('#report-modal').open=false;context.assignments=structuredClone(rows);context.openReport();assert.equal(context.reportSourceAssignmentId,null);assert.doesNotMatch($('#report-job-context').innerHTML,/First scope|Second scope/,'ambiguous generic daily never picks the first shift');
// Same source validator used by both POST and PATCH; never an authorization bypass.
for(const crew of ['Saved edited crew','']){context.openReport({project:0,dateIso:date,sourceAssignmentId:2,crew});assert.equal($('#report-crew').value,crew,'saved explicit crew survives report reopen');}
const validator={fieldRole:u=>['field','foreman'].includes(u?.role),managerAssignmentAllowed:()=>false};vm.createContext(validator);vm.runInContext(declaration(serverSource,'reportSourceAssignment'),validator);
const db={projects:[{id:11},{id:22}],assignments:rows},user={role:'field',memberId:7},input={sourceAssignmentId:2,dateIso:date};
assert.equal(validator.reportSourceAssignment(db,user,input,0).id,2);
for(const bad of [{sourceAssignmentId:3},{sourceAssignmentId:99},{sourceAssignmentId:2,dateIso:'2026-10-09'},{sourceAssignmentId:0}])assert.ok(validator.reportSourceAssignment(db,user,{...input,...bad},0).error);
assert.equal(validator.reportSourceAssignment(db,{role:'field',memberId:8},input,0).status,403);assert.equal(validator.reportSourceAssignment(db,{role:'foreman',memberId:8},input,0).status,403);assert.equal(validator.reportSourceAssignment(db,{role:'project_manager'},input,0).status,403);
const saved={sourceAssignmentId:99,dateIso:date};assert.equal(validator.reportSourceAssignment(db,user,{sourceAssignmentId:99,dateIso:date},0,saved).id,99,'deleted saved reference is retained without selecting another row');
assert.equal(validator.reportSourceAssignment(db,user,{sourceAssignmentId:null},0,saved).id,null);
assert.equal(validator.reportSourceAssignment(db,user,{},0,saved).id,99,'cached client keeps unchanged reference');
assert.equal(validator.reportSourceAssignment(db,user,{dateIso:'2026-10-09'},0,saved).id,null,'cached date change clears obsolete reference');
let closed,cleared=0;$('#report-modal').addEventListener=(event,handler)=>{closed=handler;};context.activeReportRecovery=()=>({key:'synthetic'});context.clearActiveReportRecovery=()=>cleared++;
const closeStart=source.indexOf("$('#report-modal').addEventListener('close',()=>{\n  if($('#report-modal').open)return;");assert.ok(closeStart>=0);vm.runInContext(source.slice(closeStart,source.indexOf('\n});',closeStart)+4),context);
context.reportSourceAssignmentId=2;$('#report-modal').open=true;closed();assert.equal(context.reportSourceAssignmentId,2);assert.equal(cleared,0,'queued old close event cannot clear reopened form');
$('#report-modal').open=false;closed();assert.equal(context.reportSourceAssignmentId,null);assert.equal(cleared,1);
console.log('Assignment daily passed: exact shift, ambiguity/deletion, membership/project/role boundaries, recovery, edited crew and repeated clicks.');
