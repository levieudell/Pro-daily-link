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
const known=markup({description:'Work',quantity:1,unit:'EA',amount:0,budgetHours:0,scopeStatus:'included',catalogSuggestions:[]},1);assert.ok(known.includes('data-import-amount="1" type="number" value="0"'));assert.ok(known.includes('data-import-include="1" checked'));

const handlerSource=source.find(line=>line.startsWith("$('#approve-estimate-import').onclick="));
const controls=new Map(),get=selector=>{if(!controls.has(selector))controls.set(selector,{});return controls.get(selector)};
for(let index=0;index<2;index++)for(const [field,value] of Object.entries({description:'Scope '+index,quantity:'10',unit:'SF',amount:index?'':'100',catalog:'',hours:index?'18':'0'}))get(`[data-import-${field}="${index}"]`).value=value;
get('[data-import-include="0"]').checked=false;get('[data-import-include="1"]').checked=true;get('#estimate-import-project').value='1';get('#estimate-import-modal').close=()=>{};
let captured;const project={id:1,estimateItems:[]};const api=async(route,options)=>{captured={route,...JSON.parse(options.body)};return {items:[]}};
const handler=new Function('$','api','projects','notify','estimateImportDraft',handlerSource+"\nreturn $('#approve-estimate-import').onclick;")(get,api,[project],()=>{},{id:7,lines:[{},{}]});
handler().then(async()=>{
  assert.equal(captured.lines.length,1);assert.equal(captured.lines[0].description,'Scope 1');assert.equal(captured.lines[0].amount,null);assert.equal(captured.lines[0].budgetHours,18);
  get('#estimate-pdf').files=[{name:'synthetic-failure.pdf'}]; get('#approve-estimate-import').style={};
  const analyzeSource=source.find(line=>line.startsWith("$('#analyze-estimate').onclick="));
  const failedDraft={requiresAiReview:true,lines:[],reviewWarnings:[],ocrWarning:'<img src=x onerror=alert(1)>',documentTotal:null,lineTotal:0,reconciled:false};
  const analyze=new Function('$','api','projects','notify','estimateImportDraft','fileAsData','importLineMarkup','bindImportReview','escapeHtml','estimateImportProjectId',analyzeSource+"\nreturn $('#analyze-estimate').onclick;")(get,async()=>failedDraft,[project],()=>{},null,async()=>'',markup,()=>{},new Function(escapeSource+';return escapeHtml;')(),1);
  await analyze();
  const failureHtml=get('#estimate-import-review').innerHTML; assert.ok(failureHtml.includes('&lt;img')); const failureTree=parse5.parseFragment(failureHtml); const unsafe=[];function check(node){if(node.tagName==='img')unsafe.push(node);for(const child of node.childNodes||[])check(child)}check(failureTree);assert.equal(unsafe.length,0);
  console.log('Estimate review DOM/submission: unknown versus zero, inclusion, explicit hours, document and assisted-failure escaping passed');
}).catch(error=>{console.error(error);process.exitCode=1});
