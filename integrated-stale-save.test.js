'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(__dirname+'/app.js','utf8');
const core=source.split('\n').find(line=>line.startsWith('async function saveDailyReport(status)'));
const labor=source.split('\n').find(line=>line.startsWith('saveDailyReport=async function(status){const laborSaveScope='));
const recovery=source.slice(source.indexOf('const saveDailyReportBeforeRecovery=saveDailyReport;'),source.indexOf('function restoreRecoveredReportFields('));
assert(core&&labor,'test actual integrated core and labor wrapper');
async function staleCase(code,change,{refreshWait=false}={}){
  let resolve,formReads=0,delegates=0,refreshes=0;
  const waiting=new Promise(done=>resolve=done);
  const context={company:{id:'synthetic-company'},currentUser:{id:1},signedInCompanyId:()=>context.company.id,dailyReviewGeneration:1,editingReportId:null,timeCardsOn:()=>true,reportLaborLoadedKey:'old',reportLaborSelectionKey:()=> 'current',reportLaborLookupPromise:refreshWait?null:waiting,noteLaborUnassigned:()=>0,
    refreshReportLaborFromTimeCards:async()=>{refreshes++;if(refreshWait)await waiting},saveDailyReportBeforeLaborGuard:async()=>{delegates++},$:()=>{formReads++;throw Error('Stale save reached live form')},showReportMessage:()=>{throw Error('Unexpected message')},notify:()=>{},api:()=>{throw Error('Stale save reached API')}};
  vm.createContext(context);vm.runInContext(code,context);const saving=context.saveDailyReport('Draft');change(context);resolve();await saving;
  assert.equal(formReads,0);assert.equal(delegates,0);assert.equal(refreshes,refreshWait?1:0);
}
(async()=>{
  for(const code of [core,labor])for(const change of [ctx=>{ctx.currentUser={id:2}},ctx=>{ctx.company={id:'another-synthetic-company'}},ctx=>{ctx.dailyReviewGeneration++}]){
    await staleCase(code,change);await staleCase(code,change,{refreshWait:true});
  }
  let delegates=0;const stable={company:{id:'synthetic-company'},currentUser:{id:1},signedInCompanyId:()=> 'synthetic-company',dailyReviewGeneration:1,editingReportId:null,timeCardsOn:()=>true,reportLaborLoadedKey:'current',reportLaborSelectionKey:()=> 'current',reportLaborLookupPromise:null,noteLaborUnassigned:()=>0,saveDailyReportBeforeLaborGuard:async()=>{delegates++}};
  vm.createContext(stable);vm.runInContext(labor,stable);await stable.saveDailyReport('Draft');assert.equal(delegates,1,'current form still delegates legitimate save');
  // Execute the real core + recovery wrapper and storage cleanup helpers.
  let release,apiCalls=0;const pending=new Promise(resolve=>release=resolve),notesKey='pdl-draft-synthetic-company:1:project-101',marker='pdl-active-report-recovery-v1',stored=new Map([[notesKey,'Exact unsaved notes and safety facts'],[marker,'Exact active draft marker']]);
  const modal={open:true},ctx={company:{id:'synthetic-company'},currentUser:{id:1},projects:[{id:101}],signedInCompanyId:()=> 'synthetic-company',dailyReviewGeneration:1,editingReportId:null,timeCardsOn:()=>true,reportLaborLoadedKey:'old',reportLaborSelectionKey:()=> 'current',reportLaborLookupPromise:pending,offlineReportDraftKey:()=> '0',ACTIVE_REPORT_RECOVERY_KEY:marker,
    localStorage:{removeItem:key=>stored.delete(key)},sessionStorage:{removeItem:key=>stored.delete(key)},$:selector=>{if(selector==='#report-modal')return modal;throw Error('Aborted core read a live form')},showReportMessage:()=>{},api:()=>{apiCalls++;throw Error('Aborted core wrote data')}};
  const storageFunction=source.split('\n').find(line=>line.startsWith('function offlineReportStorageKey(')),clearFunction=source.slice(source.indexOf('function clearActiveReportRecovery('),source.indexOf("$('#field-notes').addEventListener('input',rememberActiveReport)"));
  vm.createContext(ctx);vm.runInContext(storageFunction+'\n'+clearFunction+'\n'+core+'\n'+recovery,ctx);const aborted=ctx.saveDailyReport('Draft');modal.open=false;ctx.dailyReviewGeneration++;release();await aborted;
  assert.equal(apiCalls,0);assert.equal(stored.get(notesKey),'Exact unsaved notes and safety facts');assert.equal(stored.get(marker),'Exact active draft marker');
  // The wrapper preserves the core result and its explicitly confirmed cleanup.
  const confirmed={saveDailyReport:async()=>{stored.delete(notesKey);stored.delete(marker);return {saved:true}}};vm.createContext(confirmed);vm.runInContext(recovery,confirmed);const confirmation=await confirmed.saveDailyReport('Draft');assert.equal(confirmation.saved,true);assert.equal(stored.size,0);
  console.log('Integrated stale-save regression passed: tenant/user/form changes after time-card preparation never read a replacement form or delegate writes.');
})().catch(error=>{console.error(error);process.exitCode=1});
