'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync('app.js','utf8');
const save=source.split('\n').find(line=>line.startsWith('async function saveDailyReport('));
const nodes=new Map();
const node=key=>{if(!nodes.has(key))nodes.set(key,{value:'',textContent:'Submit',files:[],close(){this.closed=true},showModal(){},open:true});return nodes.get(key)};
node('#field-notes').value='Synthetic report with photo';node('#report-signature').value='QA';node('#report-project').value='0';node('#report-date').value='2026-10-04';
node('#report-photos').files=[{name:'synthetic.jpg'}];
const calls=[];let uploadFails=true,recoveryId;
const draftStorage=new Map([['scoped-project-1','Synthetic report with photo'],['pdl-draft-0','Unattributed legacy draft']]);
const context={$:node,$$:()=>[],timeCardsOn:()=>false,editingReportId:null,reportLaborTotals:()=>({crew:0,allocated:0,balanced:true}),noteLaborUnassigned:()=>0,templatesOn:()=>false,
  projects:[{id:1}],reports:[],photos:[],extractedDraft:null,currentUser:{name:'QA'},activeNoteLaborEvidence:null,
  dailyTemplatePayload:()=>({}),api:async(route,options)=>{calls.push({route,method:options.method});return{id:10,project:0,status:'Needs review',notes:'Synthetic report with photo'}},
  uploadPhotos:async()=>{if(uploadFails)throw new Error('Synthetic upload failure');return[{id:1,reportId:10}]},
  offlineReportDraftKey:()=>context.editingReportId?`report-${context.editingReportId}`:'project-1',offlineReportStorageKey:key=>'scoped-'+key,
  rememberActiveReport:()=>{recoveryId=context.editingReportId;draftStorage.set('scoped-report-'+recoveryId,'Synthetic report with photo')},
  clearActiveReportRecovery:key=>draftStorage.delete('scoped-'+key),reportWorkDate:()=> 'Oct 4',localStorage:{removeItem:key=>draftStorage.delete(key)},
  renderReports:()=>{},renderProjectCards:()=>{},showPage:()=>{},syncActionCenter:async()=>{},notify:()=>{},showReportMessage:message=>{context.message=message}};
vm.createContext(context);vm.runInContext(save,context);
(async()=>{
  await context.saveDailyReport('Needs review');
  assert.match(context.message,/upload failure/);assert.equal(node('#report-modal').closed,undefined);
  assert.equal(context.editingReportId,10,'failed photo upload retains server report identity');
  assert.equal(recoveryId,10,'device recovery marker refers to the saved report');
  assert.equal(draftStorage.has('scoped-project-1'),false,'persisted report draft replaces old project draft only after recovery save');
  assert.equal(draftStorage.has('scoped-report-10'),true);
  assert.equal(node('#report-photos').files.length,1,'failed upload retains current browser file selection');
  uploadFails=false;await context.saveDailyReport('Needs review');
  assert.deepEqual(calls,[{route:'/api/reports',method:'POST'},{route:'/api/reports/10',method:'PATCH'}],'retry updates the persisted report rather than submitting a duplicate');
  assert.equal(context.reports.length,1);assert.equal(context.photos.length,1);assert.equal(node('#report-modal').closed,true);
  assert.equal(context.editingReportId,null);
  assert.equal(draftStorage.size,1,'successful retry does not leave a stale scoped project or report draft');
  assert.equal(draftStorage.get('pdl-draft-0'),'Unattributed legacy draft','success must not delete unattributed legacy data');
  // Existing upload semantics fail explicitly offline; no background queue is claimed.
  const upload=source.split('\n').find(line=>line.startsWith('async function uploadPhotos('));
  const offline=vm.createContext({...context,navigator:{onLine:false},preferredLanguage:'en'});vm.runInContext(upload,offline);
  await assert.rejects(offline.uploadPhotos({files:[{name:'synthetic.jpg'}],project:0}),/need a connection/);
  console.log('Photo retry tests passed: production save preserves server identity, retries with PATCH, keeps device selection, and explicitly rejects offline upload (VM fixture).');
})().catch(error=>{console.error(error);process.exitCode=1});
