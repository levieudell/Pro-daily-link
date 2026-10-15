'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const html=fs.readFileSync(__dirname+'/index.html','utf8'),source=fs.readFileSync(__dirname+'/app.js','utf8'),lines=source.split('\n');
assert.match(html,/id="report-more"/);
assert.match(html,/Problem or issue \(optional\)/);
assert.doesNotMatch(html,/id="add-report-labor-member"/);
assert.match(html,/Sends these notes to AI\. Nothing is added until you accept each suggestion\./);
assert.match(html,/data-page="fieldday"[^>]*>\s*<span>◷<\/span> Clock/);
assert.doesNotMatch(html,/field-only" data-page="timecards"/);
assert.match(html,/id="field-clock-hours"/);
assert.match(html,/<h1>Time cards<\/h1>/);
assert.match(html,/id="timecard-bulk-approve"/);
assert.match(html,/CSV export/);
assert.match(html,/Choose Save draft or Submit to office to save this signature\./);
assert.match(html,/id="start-day-button"/);
assert.match(html,/id="company-clock"/);
assert.doesNotMatch(source,/Currently allocated:/);
const next=lines.find(line=>line.includes("$('#report-next-step').onclick"));
assert.ok(next,'next step handler');
assert.doesNotMatch(next,/ai-convert/);
assert.match(next,/showReportStep\(2\)/);
const handler=lines.find(line=>line.startsWith("$('#ai-convert').onclick=async()=>"));
assert.ok(handler);
assert.doesNotMatch(handler,/addProductionRow/);
assert.ok(handler.indexOf('if(!isCurrent())return false')<handler.indexOf('renderAiSuggestions'));

function declaration(name){
  const start=lines.findIndex(line=>line.startsWith('function '+name+'(')||line.startsWith('async function '+name+'('));
  assert.ok(start>=0,name);
  if(lines[start].trimEnd().endsWith('}'))return lines[start];
  const end=lines.findIndex((line,index)=>index>start&&line.trimEnd()==='}');
  assert.ok(end>start,name);
  return lines.slice(start,end+1).join('\n');
}

const optionContext={projects:[{estimateItems:[{id:7,name:'Slab on grade',unit:'SF'}]}],$:()=>({value:'0'}),escapeHtml:value=>String(value)};
vm.createContext(optionContext);
vm.runInContext(declaration('productionOptions')+'\nthis.html=productionOptions(7)',optionContext);
assert.match(optionContext.html,/>Slab on grade</);
assert.doesNotMatch(optionContext.html,/done/);

const signatureContext={currentUser:{memberId:2,role:'Carpenter'},team:[{id:2,role:'Carpenter'},{id:1,role:'General Foreman'}],currentRole:'office'};
vm.createContext(signatureContext);
vm.runInContext(declaration('reportSignatureRequired'),signatureContext);
assert.equal(signatureContext.reportSignatureRequired(),true,'office still requires a signature');
delete signatureContext.currentRole;
assert.equal(signatureContext.reportSignatureRequired(),true,'missing role keeps the existing signature requirement');
signatureContext.currentRole='field';
assert.equal(signatureContext.reportSignatureRequired(),false,'a craftsperson can submit without a foreman signature');
signatureContext.currentUser={memberId:4,accessRole:'foreman',role:'Field'};
assert.equal(signatureContext.reportSignatureRequired(),true,'a foreman still signs');
signatureContext.currentUser={memberId:1,role:'Field team member'};
assert.equal(signatureContext.reportSignatureRequired(),true,'a general foreman job title still signs');

(async()=>{
  const applied=[];
  const nodes=new Map();
  const make=id=>{
    if(!nodes.has(id))nodes.set(id,{id,value:'',open:id==='#report-modal',textContent:'',innerHTML:'',hidden:false,dataset:{},children:[],classList:{toggle(){},add(){}},querySelector(){return {textContent:''}},querySelectorAll(){return []}});
    return nodes.get(id);
  };
  make('#field-notes').value='poured 12 yards and washed the pump';
  make('#report-language').value='en-US';
  make('#report-project').value='0';
  make('#report-date').value='2026-10-15';
  make('#ai-suggestion-list');
  make('#ai-preview');
  make('#production-rows');
  const context={
    $:id=>make(id),$$:()=>[],reportAnalyzeSequence:0,editingReportId:null,reports:[],pendingAiDraft:null,extractedDraft:null,
    projects:[{id:1,estimateItems:[{id:9,name:'Slab on grade',unit:'SF'}]}],company:{id:'northstar'},currentUser:{id:1},currentRole:'field',
    signedInCompanyId:()=>'northstar',renderReportCustomFields(){},currentReportTemplateFields:()=>[],
    addProductionRow(row){applied.push(row)},suggestReportHourSplit(){},applyNoteLaborEvidence(){},applyAiCustomFieldSuggestions(){},
    renderSafetyItems(){},updateReportGaps(){},escapeHtml:value=>String(value??''),showReportStep(){},applyReportLanguage(){},notify(){},
    api:async()=>({source:'openai',originalLanguage:'en',productions:[
      {description:'Pump washout',custom:true,quantity:1,unit:'EA',potentialExtraWork:true},
      {description:'Slab on grade',estimateItemId:9,quantity:12,unit:'YD'}
    ]})
  };
  vm.createContext(context);
  vm.runInContext([declaration('aiProductionPreview'),declaration('renderAiSuggestions'),declaration('acceptAiSuggestion'),handler].join('\n'),context);
  const result=await make('#ai-convert').onclick();
  assert.equal(result,true);
  assert.equal(applied.length,0,'suggestions stay out of the report until accepted');
  assert.match(make('#ai-suggestion-list').innerHTML,/Not on the estimate/);
  assert.match(make('#ai-suggestion-list').innerHTML,/Notes say 12 YD/);
  assert.match(make('#ai-suggestion-list').innerHTML,/SF/);
  context.acceptAiSuggestion('skip-production',0);
  assert.equal(applied.length,0,'skipping a suggestion does not add it');
  context.acceptAiSuggestion('production',1);
  assert.equal(applied.length,1);
  assert.equal(applied[0].estimateItemId,9);
  assert.equal(applied[0].unit,'YD');
  console.log('Field daily friction checks passed.');
})().catch(error=>{console.error(error);process.exitCode=1});
