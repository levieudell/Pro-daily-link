'use strict';

// Runs report date changes through the actual application lifecycle functions.
// Runs actual application lifecycle functions without a browser or network calls.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const candidate=path.resolve(process.argv[2]||__dirname);
const source=fs.readFileSync(path.join(candidate,'app.js'),'utf8');
const lines=source.split(/\r?\n/);

function declaration(name){
  const start=lines.findIndex(line=>line.startsWith(`function ${name}(`)||line.startsWith(`async function ${name}(`));
  assert.ok(start>=0,`Missing real ${name} declaration`);
  if(lines[start].trimEnd().endsWith('}'))return lines[start];
  const end=lines.findIndex((line,index)=>index>start&&line==='}');
  assert.ok(end>start,`Missing end of ${name}`);
  return lines.slice(start,end+1).join('\n');
}
function section(startMarker,endMarker){
  const start=source.indexOf(startMarker),end=source.indexOf(endMarker,start);
  assert.ok(start>=0&&end>start,`Missing source section ${startMarker}`);
  return source.slice(start,end);
}
function oneLine(prefix){
  const line=lines.find(line=>line.startsWith(prefix));
  assert.ok(line,`Missing real handler ${prefix}`);
  return line;
}

const nodes=new Map();
const calls={gaps:0,focus:0,laborPopulate:0};
const $=key=>{
  if(!nodes.has(key)){
    const node={value:'',textContent:'',innerHTML:'',hidden:false,open:false,children:[],dataset:{},className:'',
      classList:{toggle(){},contains(){return false}},
      showModal(){this.open=true},focus(){calls.focus++},insertAdjacentHTML(){},
      querySelector(){return null},querySelectorAll(){return []}};
    nodes.set(key,node);
  }
  return nodes.get(key);
};
const context={
  $,$$:()=>[],document:{getElementById:id=>$('#'+id)},
  reportAnalyzeSequence:0,editingReportId:null,extractedDraft:null,
  projects:[{id:101,name:'Synthetic project'},{id:202,name:'Synthetic second project'}],
  reports:[],team:[],workdays:[],timeCards:[],preferredLanguage:'en',
  reportLaborLookupSequence:0,reportLaborLoadedKey:'',reportLaborLookupPromise:null,
  activeNoteLaborEvidence:null,
  localDateIso:()=> '2026-10-07',escapeHtml:value=>String(value),
  applyReportLanguage(){},populateReportLabor(){calls.laborPopulate++},
  renderReportCustomFields(){},offerOfflineReportDraft(){},
  unmeasuredWorkSuggestions:()=>[],addProductionRow(){},
  reportLaborTotals:()=>({crew:0,allocated:0}),suggestReportHourSplit(){},
  updateReportGaps(){calls.gaps++;$('#report-gaps').className='report-gaps complete';$('#report-gaps').innerHTML='Ready'},
  reportLaborReviewWarnings:()=>[],reportLaborReviewMarkup:()=>'',
  timeCardsOn:()=>false,api(){throw new Error('Lifecycle test must not make network calls')},
  renderReportJobContext(){},addReportMapLink(){},clearTimeCardDerivedReportLabor(){},
  loadReportWeather(){},applyReportType(){},showReportMessage(){}
};
vm.createContext(context);
vm.runInContext([
  declaration('reportReviewDate'),declaration('updateReportReviewDateBanner'),
  declaration('reportLaborSelectionKey'),declaration('refreshReportLaborFromTimeCards'),
  declaration('showReportStep'),declaration('openReport'),
  declaration('openDailyForAssignment'),declaration('restoreRecoveredReportFields'),
  oneLine('const updateReportGapsBeforeLaborReview='),
  oneLine('updateReportGaps=function(){const result=updateReportGapsBeforeLaborReview('),
  section('const openReportBeforeApprovedLabor=openReport;','const reportProjectChangeBeforeApprovedLabor='),
  oneLine('const reportDateChangeBeforeLaborReview='),
  oneLine("$('#report-date').onchange=event=>{reportDateChangeBeforeLaborReview")
].join('\n'),context,{filename:path.join(candidate,'app.js')});

function expectBanner(iso,label){
  assert.equal($('#report-date').value,iso,label+' input');
  assert.ok($('#report-work-date').textContent.includes(context.reportReviewDate(iso)),label+' banner');
}

context.openReport();
expectBanner('2026-10-07','First new step-1 report');
assert.equal(calls.gaps,0,'Opening step 1 must show the date independently of production gap checks');

context.openReport({id:12,project:0,dateIso:'2026-10-06'});
expectBanner('2026-10-06','Existing report');
const gapsBeforeNew=calls.gaps;
context.openReport();
expectBanner('2026-10-07','New report after viewing an older report');
assert.equal(calls.gaps,gapsBeforeNew,'New date must refresh with time cards disabled and no gap check');

context.openDailyForAssignment({projectId:202,date:'2026-10-08'});
expectBanner('2026-10-08','Assigned work date set programmatically');
assert.equal($('#report-project').value,'1','Assignment selects its actual project');

context.restoreRecoveredReportFields({dateIso:'2026-10-09'});
expectBanner('2026-10-09','Recovered draft work date');

$('#report-date').value='2026-10-10';
$('#report-date').onchange({target:$('#report-date')});
expectBanner('2026-10-10','Manual work date change');

context.preferredLanguage='es';
context.openReport({id:13,project:0,dateIso:'2026-10-06'});
expectBanner('2026-10-06','Existing report with Spanish date formatting');

$('#report-date').value='';
context.updateReportReviewDateBanner();
assert.ok($('#report-work-date').textContent.trim(),'Clearing the date shows a prompt');

console.log('Report date lifecycle passed: first open, existing-to-new, assigned date, recovery, manual date, Spanish date, and cleared date; real handlers, no network.');
