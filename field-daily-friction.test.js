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
assert.match(html,/Choose Save draft or Send to office to save this signature\./);
assert.match(html,/id="start-day-button"/);
assert.match(html,/id="company-clock"/);
assert.doesNotMatch(source,/Currently allocated:/);
const next=lines.find(line=>line.includes("$('#report-next-step').onclick"));
assert.ok(next,'next step handler');
assert.doesNotMatch(next,/ai-convert/);
assert.match(next,/showReportStep\(2\)/);
assert.doesNotMatch(next,/before continuing/);
assert.doesNotMatch(source,/Add a quick note about what happened today before continuing/);
assert.doesNotMatch(source,/Needs acknowledgement/);
assert.match(source,/New assignment/);
assert.match(source,/upcomingCard\|\|ack\?'':`<button type="button" class="secondary acknowledge-assignment"/);
assert.match(source,/const fieldHours=typeof currentRole!=='undefined'&&currentRole==='field',scheduled=fieldHours\|\|total\?\[]:scheduledReportLabor/);
assert.match(source,/fieldOfflineDraftAction\(draft/);
assert.match(source,/action==='discard'\)/);
assert.match(source,/row\.source!=='schedule'/);
assert.match(source,/Number\(saved\?\.hours\)>0\?saved\.hours:''/);
assert.doesNotMatch(html,/AI will draft this summary/);
assert.match(html,/Summary for the office\. Leave blank if the quantities are enough\./);
assert.doesNotMatch(html,/id="field-notes"[^>]*required/);
const styles=fs.readFileSync(__dirname+'/styles.css','utf8');
assert.match(styles,/\.field-mode #report-modal \.weather-row/);
assert.match(styles,/#report-modal\.report-field-compact \.verify-banner:not\(\.report-edit-warning\)/);
assert.match(styles,/#report-modal\.report-field-compact #report-gaps\{display:none\}/);
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
})().then(async()=>{
  const weather=declaration('loadReportWeather');
  const label=declaration('weatherLabel');
  function harness({role,site,api}){
    const calls=[];
    const fields={
      '#report-project':{value:'0'},
      '#report-weather':{value:'stale'},
      '#report-temperature':{value:'99'},
      '#manual-weather':{hidden:false},
      '#load-weather':{disabled:false,textContent:'↻ Refresh weather'},
      '#weather-summary':{textContent:'Loading from the job address…',classList:{classes:new Set(),add(c){this.classes.add(c)},remove(c){this.classes.delete(c)},contains(c){return this.classes.has(c)}}}
    };
    const row={hidden:false};
    const context={
      currentRole:role,projects:[{site}],$:id=>fields[id],weatherLabel:null,api:async(route)=>{calls.push(route);return api(route)},
      document:{querySelector:()=>row}
    };
    vm.createContext(context);
    vm.runInContext(label+'\n'+weather,context);
    return {context,fields,row,calls,run:()=>context.loadReportWeather({silent:true})};
  }
  const missing=harness({role:'field',site:'Address not entered',api(){throw new Error('should not fetch')}});
  await missing.run();
  assert.equal(missing.calls.length,0,'field weather waits for a real address');
  assert.equal(missing.fields['#report-weather'].value,'','a placeholder address leaves weather off the daily');
  assert.equal(missing.fields['#weather-summary'].textContent,'Loading from the job address…','field fetch does not rewrite the hidden summary');
  assert.equal(missing.row.hidden,true);
  const failed=harness({role:'field',site:'100 Division Street',api(){throw new Error('offline')}});
  await failed.run();
  assert.equal(failed.calls.length,1);
  assert.equal(failed.fields['#report-weather'].value,'');
  assert.equal(failed.fields['#report-temperature'].value,'');
  assert.equal(failed.fields['#weather-summary'].classList.contains('weather-error'),false,'a failed field fetch stays invisible');
  const loaded=harness({role:'field',site:'100 Division Street',api:async()=>({weather_code:0,temperature_2m:71.4,wind_speed_10m:4})});
  await loaded.run();
  assert.equal(loaded.fields['#report-weather'].value,'Clear');
  assert.equal(loaded.fields['#report-temperature'].value,71);
  const office=harness({role:'office',site:'',api(){throw new Error('should not fetch')}});
  await office.run();
  assert.equal(office.fields['#weather-summary'].classList.contains('weather-error'),true,'office can still add weather when the address is missing');
  assert.match(office.fields['#weather-summary'].textContent,/enter the weather manually/);
  console.log('Field weather stays quiet.');
}).then(()=>{
  const context={
    currentRole:'field',
    projects:[{id:1}],
    assignments:[{id:4,projectId:1,date:'2026-10-15',start:'07:00',end:'15:30',memberIds:[1,2]}],
    $:id=>id==='#report-project'?{value:'0'}:id==='#report-date'?{value:'2026-10-15'}:null
  };
  vm.createContext(context);
  vm.runInContext([declaration('reportAssignmentsOnDate'),declaration('scheduledReportLabor'),declaration('fieldOfflineDraftAction'),declaration('fieldDraftLabor')].join('\n'),context);
  assert.deepEqual(context.scheduledReportLabor(1,'2026-10-15').map(row=>row.hours),[8.5,8.5]);
  const draft={dateIso:'2026-10-15',notes:'poured the east wall',laborEntries:[
    {memberId:1,hours:8.5},{memberId:1,hours:8.5,source:'schedule'},{memberId:2,hours:8.5,source:'entered'},{memberId:3,hours:6,source:'timecard'}
  ]};
  assert.equal(context.fieldOfflineDraftAction(draft,'2026-10-15'),'resume');
  assert.equal(context.fieldOfflineDraftAction({...draft,dateIso:'2026-10-14',notes:'yesterday'},'2026-10-15'),'discard');
  assert.equal(context.fieldOfflineDraftAction({notes:''},'2026-10-15'),'resume');
  context.hasOfflineReportContent=value=>Boolean(String(value?.notes||'').trim());
  assert.equal(context.fieldOfflineDraftAction({notes:''},'2026-10-15'),'ignore');
  const kept=context.fieldDraftLabor(draft);
  assert.deepEqual(kept.map(row=>[row.memberId,row.hours,row.source||'']),[[2,8.5,'entered'],[3,6,'timecard']]);
  assert.equal(context.fieldDraftLabor({dateIso:'2026-10-14',notes:'old',laborEntries:[{memberId:1,hours:8.5,source:'entered'}]}).length,0);
  console.log('Field hours and drafts stay quiet.');
}).catch(error=>{console.error(error);process.exitCode=1});
