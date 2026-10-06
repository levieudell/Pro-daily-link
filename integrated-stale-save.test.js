'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(__dirname+'/app.js','utf8');
const core=source.split('\n').find(line=>line.startsWith('async function saveDailyReport(status)'));
const labor=source.split('\n').find(line=>line.startsWith('saveDailyReport=async function(status){const laborSaveScope='));
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
  console.log('Integrated stale-save regression passed: tenant/user/form changes after time-card preparation never read a replacement form or delegate writes.');
})().catch(error=>{console.error(error);process.exitCode=1});
