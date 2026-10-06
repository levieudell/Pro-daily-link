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
  signedInCompanyId:()=> 'synthetic-tenant',company:{id:'synthetic-tenant'},projects:[{id:1}],reports:[],photos:[],extractedDraft:null,currentUser:{name:'QA'},activeNoteLaborEvidence:null,
  dailyTemplatePayload:()=>({}),api:async(route,options)=>{calls.push({route,method:options.method,status:JSON.parse(options.body).status});return{id:10,project:0,status:JSON.parse(options.body).status,notes:'Synthetic report with photo'}},
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
  assert.deepEqual(calls,[{route:'/api/reports',method:'POST',status:'Draft'},{route:'/api/reports/10',method:'PATCH',status:'Draft'},{route:'/api/reports/10',method:'PATCH',status:'Needs review'}],'retry updates one draft and submits only after photos succeed');
  assert.equal(context.reports.length,1);assert.equal(context.photos.length,1);assert.equal(node('#report-modal').closed,true);
  assert.equal(context.editingReportId,null);
  assert.equal(draftStorage.size,1,'successful retry does not leave a stale scoped project or report draft');
  assert.equal(draftStorage.get('pdl-draft-0'),'Unattributed legacy draft','success must not delete unattributed legacy data');
  // A session replacement after the report save must not start another user's upload.
  node('#report-modal').closed=undefined;context.editingReportId=null;context.currentUser={id:1,name:'QA'};let resolveSave;context.api=()=>new Promise(resolve=>resolveSave=resolve);let uploadCalls=0;context.uploadPhotos=async()=>{uploadCalls++;return[]};const saving=context.saveDailyReport('Draft');await new Promise(resolve=>setImmediate(resolve));context.currentUser={id:2,name:'Other user'};resolveSave({id:11});await saving;assert.equal(uploadCalls,0);assert.equal(context.editingReportId,null);assert.equal(node('#report-modal').closed,undefined);
  context.currentUser={id:1,name:'QA'};context.dailyReviewGeneration=1;context.editingReportId=null;const changedReport=context.saveDailyReport('Draft');await new Promise(resolve=>setImmediate(resolve));context.dailyReviewGeneration=2;context.editingReportId=22;resolveSave({id:11});await changedReport;assert.equal(context.editingReportId,22,'late saved report must not retarget a different open report');assert.equal(uploadCalls,0);
  // Existing upload semantics fail explicitly offline; no background queue is claimed.
  const upload=source.split('\n').find(line=>line.startsWith('async function uploadPhotos('));
  const offline=vm.createContext({...context,navigator:{onLine:false},preferredLanguage:'en'});vm.runInContext(upload,offline);
  await assert.rejects(offline.uploadPhotos({files:[{name:'synthetic.jpg'}],project:0}),/need a connection/);
  console.log('Photo retry tests passed: production save preserves server identity, retries with PATCH, keeps device selection, and explicitly rejects offline upload (VM fixture).');
})().catch(error=>{console.error(error);process.exitCode=1});
