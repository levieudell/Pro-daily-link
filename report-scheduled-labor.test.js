'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('app.js','utf8');const nodes={'#report-project':{value:'0'},'#report-date':{value:'2026-10-06'}};
const context={projects:[{id:10},{id:20}],team:[{id:1,crew:'Same'},{id:2,crew:'Same'},{id:3,crew:'Other'},{id:4,status:'Inactive'},{id:5,archivedAt:'2026-01-01'},{id:6},{id:7}],assignments:[{projectId:10,date:'2026-10-06',start:'11:00',end:'17:00',memberIds:[1,3,4,5,6,7]},{projectId:20,date:'2026-10-06',memberIds:[1,2]},{projectId:10,date:'2026-10-05',memberIds:[2]}],scheduleAvailability:[{memberId:6,startDate:'2026-10-06',endDate:'2026-10-06'},{memberId:7,startDate:'2026-10-06',endDate:'2026-10-06',allDay:false,startTime:'08:00',endTime:'10:00'}],$:key=>nodes[key],$$:()=>context.inputs||[]};vm.createContext(context);
for(const name of ['reportLaborMembers','currentReportLaborEntries'])vm.runInContext(source.split('\n').find(line=>line.startsWith(`function ${name}(`)),context);
const ids=entries=>Array.from(context.reportLaborMembers(entries),row=>row.id);
assert.deepEqual(ids([]),[1,3,7],'date/project schedule includes 11AM starts, all crews, partial-day available work; excludes inactive/archive/full-day leave');
nodes['#report-date'].value='2026-10-05';assert.deepEqual(ids([]),[2],'historical date, not today');
nodes['#report-date'].value='2026-10-07';assert.deepEqual(ids([]),[],'no schedule means no default labor');
assert.deepEqual(ids([{memberId:4,hours:7},{memberId:6,hours:3},{memberId:99,hours:4}]),[4,6,99],'historical/inactive/unavailable/missing members retain actual saved rows');
nodes['#report-date'].value='2026-10-06';nodes['#report-project'].value='1';assert.deepEqual(ids([]),[1,2],'same-day multi-job scopes members to selected job');
context.inputs=[{value:'0',dataset:{laborMember:'1'}},{value:'5.5',dataset:{laborMember:'3'}},{value:'0',dataset:{laborMember:'2',laborExplicit:'true'}}];
assert.deepEqual(Array.from(context.currentReportLaborEntries(),row=>[row.memberId,row.hours]),[[3,5.5],[2,0]],'date changes drop stale default zero rows but retain entered hours and explicit additions');
assert.match(source,/populateReportLabor\(report\?\.laborEntries\|\|currentReportLaborEntries\(\)\)/,'open report refreshes defaults after assigned project selection');
assert.match(source,/chooseAssigned:!editingReportId\}\);refreshReportLaborFromTimeCards\(\)/,'date change refreshes after field project selection');
// Execute the actual renderer and reproduce the original crew-roster behavior.
context.escapeHtml=value=>String(value||'');context.wireSteppers=()=>{};
nodes['#report-crew']={value:'Same'};nodes['#report-labor-list']={innerHTML:''};nodes['#report-add-labor-member']=null;
vm.runInContext(source.split('\n').find(line=>line.startsWith('function populateReportLabor(')),context);
nodes['#report-project'].value='0';nodes['#report-date'].value='2026-10-07';context.populateReportLabor([]);
assert.doesNotMatch(nodes['#report-labor-list'].innerHTML,/data-labor-member=/,'new draft with no schedule is empty');
// Optional baseline reproduction uses the untouched main source.
const baselinePath=require('node:path').join(__dirname,'baseline-app.tmp');
if(fs.existsSync(baselinePath)){const old=fs.readFileSync(baselinePath,'utf8').split('\n').find(line=>line.startsWith('function populateReportLabor('));vm.runInContext(old,context);context.populateReportLabor([]);assert.match(nodes['#report-labor-list'].innerHTML,/data-labor-member="1"/,'baseline reproduces unscheduled crew roster');assert.match(nodes['#report-labor-list'].innerHTML,/data-labor-member="2"/,'baseline reproduces other-project member');vm.runInContext(source.split('\n').find(line=>line.startsWith('function populateReportLabor(')),context);}
context.populateReportLabor([{memberId:99,hours:6.5}]);assert.match(nodes['#report-labor-list'].innerHTML,/value="6.5" data-labor-member="99"/,'missing historical member hours rendered without loss');
context.populateReportLabor([{memberId:2,hours:0}]);assert.match(nodes['#report-labor-list'].innerHTML,/data-labor-member="2" data-labor-explicit="true"/,'saved historical zero row is retained and marked explicit');
context.inputs=[{value:'0',dataset:{laborMember:'2',laborExplicit:'true'}}];assert.equal(context.currentReportLaborEntries().length,1,'saved zero row survives date/project refresh');
console.log('Daily report scheduled labor regression checks passed');
