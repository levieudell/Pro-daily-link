'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const candidate=__dirname,source=fs.readFileSync(path.join(candidate,'app.js'),'utf8');
const handler=source.split('\n').find(line=>line.startsWith("$('#ai-convert').onclick=async()=>"));
async function probe(mode){
 const nodes=new Map(),defaults={'#field-notes':'Started stairs.','#report-project':'0','#report-language':'en-US'},classList={toggle(){},add(){}};
 const $=key=>{if(!nodes.has(key))nodes.set(key,{value:defaults[key]||'',open:key==='#report-modal',textContent:'',innerHTML:'',children:[],classList,querySelector(){return {textContent:''}}});return nodes.get(key)};
 let release,applied=0,step=0;const delayed=new Promise(resolve=>{release=resolve});
 const context={$,reportAnalyzeSequence:0,editingReportId:1,reports:[{id:1},{id:2}],projects:[{id:101,estimateItems:[{id:1,name:'Stairs',unit:'LF'}]},{id:202,estimateItems:[{id:2,name:'Other Stairs',unit:'LF'}]}],company:{id:'synthetic-company'},currentUser:{id:1},signedInCompanyId:()=> 'synthetic-company',extractedDraft:null,api:()=>delayed,renderReportCustomFields(){},currentReportTemplateFields:()=>[],addProductionRow(row){applied++;$('#production-rows').children.push(row)},unmeasuredWorkSuggestions:()=>[],applyNoteLaborEvidence(){},applyAiCustomFieldSuggestions(){},escapeHtml:text=>text,showReportStep(value){step=value},applyReportLanguage(){},notify(){}};
 vm.createContext(context);vm.runInContext(handler,context);const pending=$('#ai-convert').onclick();
 if(mode==='closed')$('#report-modal').open=false;else{context.editingReportId=2;$('#report-project').value='1'}
 release({source:'local',summary:'Synthetic delayed original report',productions:[{description:'Started stairs.',quantity:null,unit:'',laborHours:0,needsScopeConfirmation:true,needsLaborConfirmation:true}]});
 const result=await pending,observation={head:process.env.PDL_REVIEW_HEAD||'working tree',case:mode,applied:result===true,rowsApplied:applied,step,currentReportId:context.editingReportId,currentProject:$('#report-project').value,modalOpen:$('#report-modal').open};
 if(true){assert.equal(result,false,mode+' completion must be discarded');assert.equal(applied,0)}return observation;
}
(async()=>{console.log(JSON.stringify(await Promise.all(['closed','replacement'].map(probe)),null,2))})().catch(error=>{console.error(error);process.exitCode=1});
