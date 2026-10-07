'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),parse5=require('parse5');
const source=fs.readFileSync(__dirname+'/app.js','utf8').split(/\r?\n/);
const escapeSource=source.find(line=>line.startsWith('function escapeHtml('));
const markupSource=source.find(line=>line.startsWith('function importLineMarkup('));
const markup=new Function(escapeSource+'\n'+markupSource+'\nreturn importLineMarkup;')();
const html=markup({description:'<img src=x onerror=alert(1)>',quantity:null,unit:'',amount:null,unitPrice:50,internalCost:30,budgetHours:18,scopeStatus:'uncertain',confidence:'low',catalogSuggestions:[]},0);
const document=parse5.parseFragment(html),elements=[];function visit(node){if(node.tagName)elements.push(node);for(const child of node.childNodes||[])visit(child)}visit(document);
const attrs=node=>Object.fromEntries(node.attrs.map(item=>[item.name,item.value]));
const input=name=>attrs(elements.find(node=>node.tagName==='input'&&node.attrs.some(item=>item.name===name)));
assert.equal(input('data-import-quantity').value,'');assert.equal(input('data-import-amount').value,'');assert.equal(input('data-import-unit').value,'');assert.equal(input('data-import-hours').value,'18');assert.equal(input('data-import-hours')['data-user-edited'],'1');assert.equal(input('data-import-include').checked,undefined);assert.equal(elements.some(node=>node.tagName==='img'),false);assert.ok(html.includes('Printed selling unit rate: 50'));assert.ok(html.includes('Printed internal/builder cost: 30'));
const unknown=markup({description:'Unknown',quantity:1,unit:'EA',amount:null,budgetHours:null,scopeStatus:'included',catalogSuggestions:[]},2);assert.ok(unknown.includes('data-import-hours="2" type="number" min="0" step="0.01" value="" placeholder="Unknown"'));
const known=markup({description:'Work',quantity:1,unit:'EA',amount:0,budgetHours:0,scopeStatus:'included',catalogSuggestions:[]},1);assert.ok(known.includes('data-import-amount="1" type="number" value="0"'));assert.ok(known.includes('data-import-include="1" checked'));

const handlerSource=source.find(line=>line.startsWith("$('#approve-estimate-import').onclick="));
const controls=new Map(),get=selector=>{if(!controls.has(selector))controls.set(selector,{});return controls.get(selector)};
for(let index=0;index<2;index++)for(const [field,value] of Object.entries({description:'Scope '+index,quantity:'10',unit:'SF',amount:index?'':'100',catalog:'',hours:index?'18':'0'}))get(`[data-import-${field}="${index}"]`).value=value;
get('[data-import-include="0"]').checked=false;get('[data-import-include="1"]').checked=true;get('#estimate-import-project').value='1';get('#estimate-import-modal').close=()=>{};
let captured;const project={id:1,estimateItems:[]};const api=async(route,options)=>{captured={route,...JSON.parse(options.body)};return {items:[]}};
const handler=new Function('$','api','projects','notify','estimateImportDraft',handlerSource+"\nreturn $('#approve-estimate-import').onclick;")(get,api,[project],()=>{},{id:7,lines:[{},{}]});
handler().then(async()=>{
  assert.equal(captured.lines.length,1);assert.equal(captured.lines[0].description,'Scope 1');assert.equal(captured.lines[0].amount,null);assert.equal(captured.lines[0].budgetHours,18);
  get('[data-import-hours="1"]').value='';await handler();assert.equal(captured.lines[0].budgetHours,null);
  get('[data-import-hours="1"]').value='0';await handler();assert.equal(captured.lines[0].budgetHours,0);
  get('#estimate-pdf').files=[{name:'synthetic-failure.pdf'}]; get('#approve-estimate-import').style={};
  const analyzeSource=source.find(line=>line.startsWith("$('#analyze-estimate').onclick="));
  const failedDraft={requiresAiReview:true,lines:[],reviewWarnings:[],ocrWarning:'<img src=x onerror=alert(1)>',documentTotal:null,lineTotal:0,reconciled:false};
  const renderSource=source.find(line=>line.startsWith('function renderEstimateImportReview('));
  const recoveryRender=new Function('$','projects','escapeHtml','importLineMarkup','bindImportReview','estimateImportDraft','estimateImportProjectId','collectEstimateImportLines','estimateImportRequestSequence',renderSource+';return renderEstimateImportReview;')(get,[project],new Function(escapeSource+';return escapeHtml;')(),markup,()=>{},failedDraft,1,()=>[],0);
  const analyze=new Function('$','api','projects','notify','estimateImportDraft','fileAsData','importLineMarkup','bindImportReview','escapeHtml','estimateImportProjectId','renderEstimateImportReview','estimateImportRequestSequence',analyzeSource+"\nreturn $('#analyze-estimate').onclick;")(get,async()=>failedDraft,[project],()=>{},null,async()=>'',markup,()=>{},new Function(escapeSource+';return escapeHtml;')(),1,recoveryRender,0);
  await analyze();
  const failureHtml=get('#estimate-import-review').innerHTML; assert.ok(failureHtml.includes('&lt;img'));assert.ok(failureHtml.includes('No scope lines could be read'));assert.equal(get('#save-estimate-import-draft').hidden,false);assert.equal(get('#approve-estimate-import').style.display,'none'); const failureTree=parse5.parseFragment(failureHtml); const unsafe=[];function check(node){if(node.tagName==='img')unsafe.push(node);for(const child of node.childNodes||[])check(child)}check(failureTree);assert.equal(unsafe.length,0);
  const saveSource=source.find(line=>line.startsWith("$('#save-estimate-import-draft').onclick="));let releaseSave;const oldDraft={id:20,lines:[]},newDraft={id:21,lines:[]};const saveContext=new Function('$','api','collectEstimateImportLines','notify','estimateImportDraft',saveSource+";return {save:$('#save-estimate-import-draft').onclick,setDraft(value){estimateImportDraft=value},getDraft(){return estimateImportDraft}};")(get,()=>new Promise(resolve=>{releaseSave=resolve}),()=>[],()=>{},oldDraft);const pendingSave=saveContext.save();saveContext.setDraft(newDraft);releaseSave({id:20,projectId:1,reviewedLines:[],reviewedAt:'fixture'});await pendingSave;assert.equal(saveContext.getDraft(),newDraft,'Late save must not replace another active draft');assert.equal(newDraft.reviewedAt,undefined);
  const manualDraft={lines:[],reviewWarnings:[],documentTotal:100,lineTotal:0,reconciled:false};const manualContext=new Function('$','projects','escapeHtml','importLineMarkup','bindImportReview','estimateImportDraft','estimateImportProjectId','collectEstimateImportLines','estimateImportRequestSequence',renderSource+';return {render:renderEstimateImportReview,getProject(){return estimateImportProjectId}};')(get,[{id:1,name:'One'},{id:2,name:'Two'}],new Function(escapeSource+';return escapeHtml;')(),markup,()=>{},manualDraft,1,()=>[],0);manualContext.render();get('#estimate-import-project').value='2';get('#add-import-manual-line').onclick();assert.equal(manualContext.getProject(),2);assert.ok(get('#estimate-import-review').innerHTML.includes('value="2" selected'));assert.equal(manualDraft.lines[0].budgetHours,null);
  let releaseAnalyze,renderCalls=0;const analyzeContext=new Function('$','api','projects','notify','estimateImportDraft','fileAsData','importLineMarkup','bindImportReview','escapeHtml','estimateImportProjectId','renderEstimateImportReview','estimateImportRequestSequence',analyzeSource+";return {analyze:$('#analyze-estimate').onclick,cancel(){estimateImportRequestSequence++},setDraft(value){estimateImportDraft=value},getDraft(){return estimateImportDraft}};")(get,()=>new Promise(resolve=>{releaseAnalyze=resolve}),[project],()=>{},null,async()=>'',markup,()=>{},new Function(escapeSource+';return escapeHtml;')(),1,()=>{renderCalls++},0);const pendingAnalyze=analyzeContext.analyze();await new Promise(resolve=>setImmediate(resolve));analyzeContext.cancel();analyzeContext.setDraft(newDraft);releaseAnalyze(failedDraft);await pendingAnalyze;assert.equal(analyzeContext.getDraft(),newDraft);assert.equal(renderCalls,0,'Late extraction cannot replace a resumed draft');
  console.log('Estimate review DOM/submission: unknown versus zero, inclusion, explicit hours, document and assisted-failure escaping passed');
}).catch(error=>{console.error(error);process.exitCode=1});

// Execute the actual mobile decorator and project health comparison against saved budgets.
const mobileSource=fs.readFileSync(__dirname+'/estimate-mobile.js','utf8');
const rows=[null,0,18].map(hours=>({dataset:{planned:'100',actual:'10',unit:'SF',budgetHours:hours==null?'':String(hours),budgetHoursKnown:String(hours!=null),actualHours:'3',quantityPercent:'10',laborPercent:hours>0?String(3/hours*100):''},children:[],querySelector:()=>null,appendChild(child){this.summary=child.innerHTML}}));
const doc={querySelectorAll:()=>rows,querySelector:()=>null,createElement:()=>({})};new Function('document',mobileSource+';decorateEstimateRows();')(doc);
assert.match(rows[0].summary,/3 labor hrs · budget not set/);assert.match(rows[1].summary,/3 of 0 labor hrs/);assert.match(rows[2].summary,/3 of 18 labor hrs/);
const healthStart=source.findIndex(line=>line.startsWith('function projectHealthDetails(')),healthEnd=source.findIndex((line,index)=>index>healthStart&&line.startsWith('function projectHealth('));
const metrics={projects:[{projectId:1,items:[{plannedQuantity:100,actualQuantity:10,budgetHours:null,actualLaborHours:30},{plannedQuantity:100,actualQuantity:10,budgetHours:18,actualLaborHours:3}]}]};
const health=new Function('productionData',source.slice(healthStart,healthEnd).join('\n')+';return projectHealthDetails;')(metrics);
assert.match(health({id:1,status:'On track'}).reason,/Add both planned/,'Unknown budget prevents a misleading aggregate labor risk comparison');

const dashboardSource=source.find(line=>line.startsWith('function dashboardProduction('));
class FixtureDate extends Date{constructor(...args){super(...(args.length?args:['2026-10-07T18:00:00Z']))}}const day='2026-10-06';
const daily=[{status:'Approved',dateIso:day,project:0,productionEntries:[{estimateItemId:1,quantity:10,laborHours:3},{estimateItemId:2,quantity:10,laborHours:4}],laborEntries:[]}];
const scopes=[{estimateItems:[{id:1,plannedQuantity:100,budgetHours:18},{id:2,plannedQuantity:100,budgetHours:null}]}];
const dashboard=new Function('reports','projects','Date',dashboardSource+';return dashboardProduction;')(daily,scopes,FixtureDate);
const period=dashboard();assert.equal(period.efficiency,null);assert.equal(period.groups.reduce((sum,row)=>sum+row.actual,0),7);
const chartSource=source.find(line=>line.startsWith('function renderChart('));
const chartControls=new Map();const chartGet=selector=>{if(!chartControls.has(selector))chartControls.set(selector,{classList:{add(){},remove(){}}});return chartControls.get(selector)};
new Function('$','reports','dashboardProduction',chartSource+';renderChart();')(chartGet,daily,dashboard);
assert.match(chartGet('#production-chart').innerHTML,/Labor budget not set/);assert.equal(chartGet('#dashboard-page .chart-summary strong').textContent,'—');

const groupSource=source.find(line=>line.startsWith('function insightGroups('));const group=new Function(groupSource+';return insightGroups;')();
assert.equal(group([{scope:'zero',quantity:10,laborHours:3,targetHoursPerUnit:0}],'scope')[0].efficiency,0);
assert.equal(group([{scope:'unknown',quantity:10,laborHours:3,targetHoursPerUnit:null}],'scope')[0].efficiency,null);

const insightsSource=source.find(line=>line.startsWith('function renderInsights('));
const insightControls=new Map(),insightGet=selector=>{if(!insightControls.has(selector))insightControls.set(selector,{});return insightControls.get(selector)};
const render=new Function('$','insightRecords','insightGroups','helpEscape',insightsSource+';return renderInsights;')(insightGet,()=>[{projectName:'Fixture',scope:'Zero budget',crew:'Crew',quantity:10,laborHours:3,unit:'SF',targetHoursPerUnit:0}],group,String);render();
assert.match(insightGet('#insight-table').innerHTML,/0\.0%/);assert.equal(insightGet('#insight-efficiency').textContent,'0.0%');
