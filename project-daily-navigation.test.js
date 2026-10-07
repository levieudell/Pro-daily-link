'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('app.js','utf8'),lines=source.split('\n');
function harness(){
  const nodes=new Map();const node=s=>{if(!nodes.has(s))nodes.set(s,{value:'all',hidden:true,dataset:{},open:false,innerHTML:'',click(){this.clicked=true},setAttribute(){},focus(){this.focused=true},scrollIntoView(){this.scrolled=true},close(){this.open=false}});return nodes.get(s)};
  const button={dataset:{openProjectReport:'12'}};
  const context={projects:[{id:1,name:'A'},{id:2,name:'B'}],reports:[{id:21,project:1,status:'Needs review',dateIso:'2026-10-06'},{id:12,project:0,status:'Approved',dateIso:'2026-10-05'},{id:11,project:0,status:'Draft',dateIso:'2026-10-04'}],p:{id:1},$:node,$$:()=>[button],reportReturnProjectId:null,notify:msg=>context.message=msg,showPage:page=>{context.page=page},openProject:id=>{context.reopened=id},renderReportsBeforeListTools:id=>{context.selected=id;node('#report-detail').innerHTML='Report '+id},requestAnimationFrame:fn=>{context.queued=fn},innerWidth:390,matchMedia:()=>({matches:true})};
  node('#project-detail-modal').open=true;node('#project-detail-modal').dataset.projectId='1';node('#report-sort').value='newest';
  vm.createContext(context);vm.runInContext(lines.find(l=>l.startsWith('function filteredDailyReports(')),context);vm.runInContext(lines.find(l=>l.startsWith('renderReports=function(selected){const allReports=reports')),context);
  const start=lines.findIndex(l=>l.startsWith('function openProjectDailyReport('));if(start>=0){const end=lines.findIndex((l,i)=>i>start&&l.trim()==='}');vm.runInContext(lines.slice(start,end+1).join('\n'),context)}
  vm.runInContext(lines.find(l=>l.includes("$$('[data-open-project-report]').forEach")),context);
  vm.runInContext(lines.find(l=>l.startsWith("$('#close-report-view').onclick=")),context);
  return{context,node,button,click:()=>button.onclick()};
}
(async()=>{
let h=harness();h.click();assert.equal(h.context.selected,12);assert.equal(h.node('#report-detail').scrolled,true,'project link must present the tapped daily detail in the mobile viewport');assert.equal(h.node('#report-detail').focused,true);assert.equal(h.context.reportReturnProjectId,1);assert.equal(h.node('#project-detail-modal').open,false);assert.equal(h.node('#close-report-view').hidden,false);
h=harness();h.node('#report-status-filter').value='Needs review';h.click();assert.equal(h.context.selected,12,'a prior list filter must not silently open another report');assert.equal(h.node('#report-status-filter').value,'all');assert.equal(h.node('#report-sort').value,'newest');
for(const id of ['21','999','NaN']){h=harness();h.button.dataset.openProjectReport=id;h.click();assert.equal(h.context.selected,undefined,'missing or other-project report must not fall back to the first report');assert.equal(h.node('#project-detail-modal').open,true);assert.ok(h.context.message);assert.equal(h.context.page,undefined)}
h=harness();h.context.reports=h.context.reports.filter(r=>r.id!==12);h.click();assert.equal(h.context.selected,undefined,'deleted/inaccessible reports stay unavailable');
h=harness();h.node('#project-detail-modal').dataset.projectId='2';h.click();assert.equal(h.context.page,undefined,'stale old-project controls cannot navigate from a newer project');
h=harness();h.node('#project-detail-modal').open=false;h.click();assert.equal(h.context.page,undefined,'closed views cannot initiate navigation');
h=harness();h.click();assert.equal(h.context.queued,undefined,'direct opening queues no stale scroll callback');h.context.showPage('dashboard');assert.equal(h.context.page,'dashboard','subsequent navigation stays in place');
h=harness();h.context.p.id=2;h.node('#project-detail-modal').dataset.projectId='2';h.button.dataset.openProjectReport='21';h.click();assert.equal(h.context.selected,21);assert.equal(h.context.reportReturnProjectId,2);
h=harness();h.click();await h.node('#close-report-view').onclick();assert.equal(h.context.page,'projects');assert.equal(h.context.reopened,1,'back returns to the originating project');assert.equal(h.context.reportReturnProjectId,null);assert.equal(h.node('#close-report-view').hidden,true);
h=harness();h.context.renderReports(21);assert.equal(h.context.selected,21,'ordinary daily list selection still works');h.node('#report-status-filter').value='Draft';h.context.renderReports();assert.equal(h.context.selected,11,'legitimate list filtering remains');
console.log('Project daily navigation passed: exact report, phone detail focus/scroll, prior filters, multi-project/deleted/inaccessible/stale controls, subsequent navigation and legitimate list filtering. Synthetic DOM; browser QA pending.');

})().catch(error=>{console.error(error);process.exitCode=1});
