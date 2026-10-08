'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),parse5=require('parse5');
const source=fs.readFileSync(__dirname+'/app.js','utf8'),lines=source.split('\n');
const one=prefix=>{const line=lines.find(line=>line.startsWith(prefix));assert.ok(line,prefix);return line};
function declaration(name){
 const start=lines.findIndex(line=>line.startsWith('function '+name+'(')||line.startsWith('async function '+name+'('));
 assert.ok(start>=0,name);if(lines[start].trimEnd().endsWith('}'))return lines[start];
 const end=lines.findIndex((line,i)=>i>start&&line.trimEnd()==='}');assert.ok(end>start,name);return lines.slice(start,end+1).join('\n');
}
const nodes=new Map(),listeners=new Map(),requests=[],messages=[],storage=new Map();
const node=id=>{
 if(!nodes.has(id))nodes.set(id,{id:id.slice(1),value:'',textContent:'',innerHTML:'',open:false,files:[],children:[],dataset:{},hidden:false,
  classList:{toggle(){},contains:kind=>kind==='close-button'&&id==='#close-report'},showModal(){this.open=true},close(){this.open=false},focus(){},scrollIntoView(){},
  getAttribute(){return null},setAttribute(){},closest(selector){if(selector==='dialog')return node('#report-modal');if(selector==='.close-button')return id==='#close-report'?this:null;return ['#close-report','#cancel-report'].includes(id)?this:null},
  querySelectorAll(){return id==='#report-modal'?[node('#close-report'),node('#cancel-report')]:[]},
  addEventListener(kind,handler,capture){const key=id+':'+kind;listeners.set(key,[...(listeners.get(key)||[]),{handler,capture}])},
  insertAdjacentHTML(where,html){this.innerHTML+=html},querySelector(selector){
   if(id==='#report-detail'&&selector==='[data-edit-report]'){const match=this.innerHTML.match(/data-edit-report="(\d+)"/);return match?{dataset:{editReport:match[1]}}:null}
   if(id==='#report-detail'&&selector==='.data-sections')return {insertAdjacentHTML:(where,html)=>this.innerHTML+=html};
   return null;
  }});
 return nodes.get(id);
};
let allowDiscard=false,apiFailure=false,photoFailure=false,confirmations=0;
const $=id=>{if(id==='[data-approve-report]'){const match=node('#report-detail').innerHTML.match(/data-approve-report="(\d+)"/);if(!match)return null;const approve=node(id);approve.dataset.approveReport=match[1];return approve}return node(id)};
const c={$,$$:selector=>selector==='dialog'?[node('#report-modal')]:[],document:{getElementById:id=>node('#'+id),addEventListener:(kind,handler,capture)=>node('#document').addEventListener(kind,handler,capture)},window:{confirm(){confirmations++;return allowDiscard}},
 projects:[{id:101,name:'Synthetic job',code:'SYN'}],reports:[],photos:[],team:[],preferredLanguage:'en',
 currentUser:{id:1,name:'Synthetic author'},company:{id:'synthetic'},signedInCompanyId:()=> 'synthetic',
 editingReportId:null,reportAnalyzeSequence:0,extractedDraft:null,activeNoteLaborEvidence:null,reportSavedNotes:'',suppressReportOpenUntil:0,
 localDateIso:()=> '2026-10-01',updateReportReviewDateBanner(){},applyReportLanguage(){},populateReportLabor(){},
 renderReportCustomFields(){},showReportStep(){},offerOfflineReportDraft(){},unmeasuredWorkSuggestions:()=>[],
 addProductionRow(){},DailyWorkExtraction:{groundReviewSuggestions:rows=>rows},statusClass:()=>'',reportWorkDate:()=> 'Oct 1',
 reportWorkLong:()=> 'October 1, 2026',reportSubmittedOn:()=>null,timeCardsOn:()=>false,templatesOn:()=>false,
 reportLaborTotals:()=>({crew:0,allocated:0,balanced:true}),noteLaborUnassigned:()=>0,dailyTemplatePayload:()=>({}),
 reportWorkSuggestions:()=>[],offlineReportDraftKey:()=> 'report-1',offlineReportStorageKey:key=>key,
 localStorage:{removeItem:key=>storage.delete(key)},clearActiveReportRecovery(){},rememberActiveReport(){},
 renderProjectCards(){},showPage(){},syncActionCenter:async()=>{},notify(){},
 showReportMessage:message=>messages.push(message),applyReportType(){},
 api:async(route,options)=>{if(route.endsWith('/approve'))return {...c.reports[0],status:'Approved'};const payload=JSON.parse(options.body);requests.push({route,payload});if(apiFailure)throw Error('Synthetic offline');
  return {...payload,id:1,project:0,history:[],signature:payload.signature};},
 uploadPhotos:async()=>{if(photoFailure)throw Error('Synthetic photo failure');return[];}
};
vm.createContext(c);
const approvalStart=source.indexOf('const renderReportsWithRefreshBase='),approvalEnd=source.indexOf('function notify(',approvalStart);
vm.runInContext([
 one("$$('dialog').forEach(dialog=>"),one("document.addEventListener('pointerup',event=>{const button="),
 declaration('escapeHtml'),declaration('openReport'),
 'const openReportBeforeDraftProtection=openReport;',one('openReport=function(report=null,context={}){reportSavedNotes='),
 one('reportHasUnsavedInput=function(){const modal='),declaration('confirmReportDiscard'),
 one("$('#report-modal').addEventListener('click',event=>{const cancel="),
 one("$('#report-modal').addEventListener('cancel',event=>{if(confirmReportDiscard())"),
 lines.find(line=>line.includes('function renderReports(selected=')),
 source.slice(approvalStart,approvalEnd),
 declaration('reportRecoverySnapshot'),declaration('restoreRecoveredReportFields'),declaration('saveDailyReport'),
 source.slice(source.indexOf('// Show the saved typed signature independently'))
].join('\n'),c);
const report={id:1,project:0,dateIso:'2026-10-01',foreman:'Synthetic author',status:'Draft',notes:'Synthetic work',
 signature:'Synthetic signer',productionEntries:[],laborEntries:[],history:[]};c.reports=[report];c.renderReports(1);
assert.ok(node('#report-detail').innerHTML.includes('FOREMAN SIGNATURE'));
assert.ok(node('#report-detail').innerHTML.includes('Synthetic signer'),'stored signature appears independently of author');
assert.ok(c.reportSignatureMarkup({...report,signature:''}).includes('Not recorded'));
assert.ok(!c.reportSignatureMarkup({...report,signature:''}).includes('Synthetic author'),'blank signature is never filled from author');
assert.ok(c.reportSignatureMarkup({...report,signature:'<img src=x onerror=attack()> & Person'}).includes('&lt;img'));
assert.ok(!c.reportSignatureMarkup({...report,signature:'<img src=x onerror=attack()>'}).includes('<img'),'signature must be escaped');
c.preferredLanguage='es';assert.ok(c.reportSignatureMarkup({...report,signature:''}).includes('No registrada'));c.preferredLanguage='en';

function event(target){return {target,prevented:false,stopped:false,preventDefault(){this.prevented=true},stopPropagation(){},stopImmediatePropagation(){this.stopped=true}}}
function emit(id,kind,event){for(const entry of listeners.get(id+':'+kind)||[]){entry.handler(event);if(event.stopped)break}return event}
c.openReport(report);assert.equal(node('#report-signature').value,report.signature);assert.equal(c.reportHasUnsavedInput(),false);
node('#report-signature').value='Changed signer';assert.equal(c.reportHasUnsavedInput(),true,'signature-only edits are protected');
const closeTarget=node('#close-report');
emit('#document','pointerup',event(closeTarget));assert.equal(node('#report-modal').open,true,'touch/mouse pointerup must defer to guarded report click');assert.equal(confirmations,0);
let click=emit('#report-modal','click',event(closeTarget));if(!click.stopped)node('#close-report').onclick(click);
assert.equal(click.prevented,true);assert.equal(node('#report-modal').open,true);assert.equal(confirmations,1);
let escape=emit('#report-modal','cancel',event(node('#report-modal')));assert.equal(escape.prevented,true,'Escape uses the same discard guard');
const nativeSubmit=emit('#report-form','submit',event(node('#report-form')));assert.equal(nativeSubmit.prevented,true);
assert.equal(node('#report-modal').open,true,'native submission cannot close the report');assert.equal(requests.length,0);
const snapshot=c.reportRecoverySnapshot();assert.equal(snapshot.signature,'Changed signer');
node('#report-signature').value='';c.restoreRecoveredReportFields(snapshot);assert.equal(node('#report-signature').value,'Changed signer');
allowDiscard=true;click=emit('#report-modal','click',event(closeTarget));if(!click.stopped)node('#close-report').onclick(click);
assert.equal(node('#report-modal').open,false,'explicit accepted close still works');allowDiscard=false;
c.openReport(report);assert.equal(c.reportHasUnsavedInput(),false,'reopening restores the stored baseline');
click=emit('#report-modal','click',event(node('#cancel-report')));if(!click.stopped)node('#cancel-report').onclick(click);assert.equal(node('#report-modal').open,false,'unchanged explicit Cancel works');
const otherDialog={id:'synthetic-other',open:true,close(){this.open=false}},otherClose={closest:selector=>selector==='dialog'?otherDialog:otherClose};
emit('#document','pointerup',event(otherClose));assert.equal(otherDialog.open,false,'other dialogs retain their existing pointer close behavior');

const html=fs.readFileSync(__dirname+'/index.html','utf8'),document=parse5.parse(html);
const attr=(n,key)=>n.attrs?.find(a=>a.name===key)?.value;
function all(n,p){return [...(p(n)?[n]:[]),...(n.childNodes||[]).flatMap(child=>all(child,p))]}
const form=all(document,n=>attr(n,'id')==='report-form')[0],buttons=all(form,n=>n.nodeName==='button');
assert.equal(buttons.filter(n=>!attr(n,'type')||attr(n,'type')==='submit').length,0,'form has no implicit default submit/cancel button');
assert.equal(attr(all(form,n=>attr(n,'id')==='close-report')[0],'type'),'button');
assert.ok(html.includes('Choose Save draft or Submit to office to save this signature.'));

(async()=>{
 c.openReport(report);node('#report-signature').value='  Saved synthetic signer  ';await c.saveDailyReport('Draft');
 assert.equal(requests.at(-1).payload.signature,'Saved synthetic signer');assert.equal(c.reports[0].signature,'Saved synthetic signer');
 c.openReport(c.reports[0]);assert.equal(node('#report-signature').value,'Saved synthetic signer');
 node('#report-signature').value='';const before=requests.length;await c.saveDailyReport('Needs review');assert.equal(requests.length,before);
 assert.match(messages.at(-1),/signature/,'submission requires explicit signature on a report with activity');
 node('#report-signature').value='Retry signer';apiFailure=true;await c.saveDailyReport('Needs review');
 assert.equal(node('#report-modal').open,true);assert.equal(node('#report-signature').value,'Retry signer');apiFailure=false;
 node('#report-photos').files=[{name:'synthetic.jpg'}];photoFailure=true;await c.saveDailyReport('Needs review');
 assert.equal(node('#report-modal').open,true);assert.equal(requests.at(-1).payload.signature,'Retry signer');
 photoFailure=false;await c.saveDailyReport('Needs review');assert.equal(requests.at(-1).payload.status,'Needs review');
 assert.equal(requests.at(-1).payload.signature,'Retry signer');assert.equal(c.reports[0].signature,'Retry signer');
 c.openReport(c.reports[0]);assert.equal(node('#report-signature').value,'Retry signer');
 c.renderReports(1);await $('[data-approve-report]').onclick();assert.equal(c.reports[0].status,'Approved');
 assert.ok(node('#report-detail').innerHTML.includes('FOREMAN SIGNATURE'),'approval refresh keeps the signature card');
 assert.ok(node('#report-detail').innerHTML.includes('Retry signer'));assert.equal($('[data-approve-report]'),null);
 console.log('Report signature lifecycle passed: stored display/escaping, empty/Spanish state, signature-only close protection, native submit, device recovery, draft save/reopen, missing signature, failed save/photo retry and submission.');
})().catch(error=>{console.error(error);process.exitCode=1});
