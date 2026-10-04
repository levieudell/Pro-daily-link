'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('reporting-controls.js','utf8');
const escapeHtml=value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const pure=vm.createContext({module:{exports:{}},escapeHtml});vm.runInContext(source,pure);
const {pdlRateReviewMarkup,pdlExportListMarkup}=pure.module.exports;
const attack='<img src=x onerror=attack()>',project={contractType:'tm'},report={id:1,status:'Approved',rateHistory:[{at:attack,actor:{name:attack},reason:attack,evidenceReference:attack,next:{laborRate:100}}]};
const legacy=pdlRateReviewMarkup(report,project,{role:'owner'});assert.ok(legacy.includes('Historical rate needs review'));assert.ok(legacy.includes('(required)'));assert.ok(!legacy.includes(attack));assert.ok(legacy.includes('value=""'),'legacy form must not guess today’s rate');
assert.equal(pdlRateReviewMarkup(report,project,{role:'field'}),'');
assert.ok(!pdlRateReviewMarkup(report,project,{role:'project_manager'}).includes('data-pdl-rate-review'),'view-only priced manager has no adjustment control');
const record={id:'00000000-0000-0000-0000-000000000001',version:1,filters:{projectId:1,from:'2026-10-01',to:'2026-10-31'},createdBy:{name:attack},createdAt:attack,reason:attack};
assert.ok(!pdlExportListMarkup([record]).includes(attack));
const nodes=new Map(),events=new Map();
function node(id){if(!nodes.has(id))nodes.set(id,{value:'all',hidden:false,innerHTML:'',disabled:false,addEventListener:(event,fn)=>events.set(id+':'+event,fn),insertAdjacentHTML(){insertions++}});return nodes.get(id)}
for(const [id,value] of [['insight-project','1'],['insight-from','2026-10-01'],['insight-to','2026-10-31'],['pdl-report-rate','125'],['pdl-rate-reason','Agreed correction'],['pdl-rate-evidence','Contract rev 2']])node(id).value=value;
const calls=[];let resolvePost,resolveDeferred,deferredRoute;let downloads=0,insertions=0,resolveOpen,deferredOpen=false;
const context={escapeHtml,document:{getElementById:node,addEventListener:(event,fn)=>events.set('document:'+event,fn)},$:selector=>node(selector.slice(1)),
  currentRole:'office',currentUser:{id:1,role:'owner'},company:{id:'tenant-a'},signedInCompanyId:()=>context.company.id,
  reports:[{id:1,project:0}],projects:[{id:1,contractType:'tm'}],canViewCompanyPricing:()=>true,renderReports(){},renderEverything(){},openProject:async()=>{if(deferredOpen)await new Promise(resolve=>{resolveOpen=resolve})},
  api:async(route,options)=>{calls.push({route,options});if(route===deferredRoute)return new Promise(resolve=>{resolveDeferred=resolve});if(route==='/api/reporting-exports'&&!options)return[record];if(route==='/api/reporting-exports')return new Promise(resolve=>{resolvePost=resolve});return{id:1,project:0,rateSnapshot:{laborRate:125}}},
  Blob:function(){downloads++},URL:{createObjectURL:()=>'',revokeObjectURL:()=>{}},prompt:()=> 'Approved correction',notify:()=>{}};
vm.createContext(context);vm.runInContext(source,context);
(async()=>{
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(node('pdl-fixed-exports').hidden,false);assert.ok(node('pdl-export-list').innerHTML.includes('Version 1'));
  const button=node('pdl-capture-export'),handler=events.get('pdl-capture-export:click');
  const pending=handler({currentTarget:button});await new Promise(resolve=>setImmediate(resolve));
  await handler({currentTarget:button});assert.equal(calls.filter(row=>row.options?.method==='POST').length,1,'repeated capture clicks during save do not post twice');
  const payload=JSON.parse(calls.find(row=>row.options?.method==='POST').options.body);assert.equal(payload.supersedesId,record.id);assert.equal(payload.reason,'Approved correction');
  resolvePost({id:'new'});await pending;assert.equal(button.disabled,false);
  const rateButton={disabled:false,dataset:{pdlRateReview:'1'}};
  await events.get('document:click')({target:{closest:selector=>selector==='[data-pdl-rate-review]'?rateButton:null}});
  const review=calls.find(row=>row.route==='/api/reports/1/rate');assert.equal(review.options.method,'PATCH');assert.deepEqual(JSON.parse(review.options.body),{laborRate:'125',reason:'Agreed correction',evidenceReference:'Contract rev 2'});
  const click=events.get('document:click');
  for(const [selector,dataset,route,response] of [
    ['[data-pdl-rate-review]',{pdlRateReview:'1'},'/api/reports/1/rate',{id:1,project:0,rateSnapshot:{laborRate:999}}],
    ['[data-pdl-default-rate]',{pdlDefaultRate:'1'},'/api/projects/1/rate-settings',{id:1,contractType:'tm',tmSettings:{defaultLaborRate:999}}],
    ['[data-pdl-export-json]',{pdlExportJson:record.id},'/api/reporting-exports/'+record.id,record]
  ]){
    context.currentUser={id:1,role:'owner'};context.currentRole='office';context.company.id='tenant-a';
    context.reports=[{id:1,project:0}];context.projects=[{id:1,contractType:'tm'}];context.renderEverything();await new Promise(resolve=>setImmediate(resolve));deferredRoute=route;
    const pendingClick=click({target:{closest:value=>value===selector?{disabled:false,dataset}:null}});
    await new Promise(resolve=>setImmediate(resolve));
    context.company.id='tenant-b';context.currentUser={id:2,role:'owner'};context.renderEverything();
    assert.equal(node('pdl-export-list').innerHTML,'','context switch clears old financial export DOM immediately');
    resolveDeferred(response);await pendingClick;
    assert.equal(context.reports[0].rateSnapshot,undefined,'old tenant report response cannot populate matching new tenant ID');
    assert.equal(context.projects[0].tmSettings,undefined,'old tenant project response cannot populate matching new tenant ID');
    assert.equal(downloads,0,'old tenant JSON response cannot trigger download');deferredRoute=undefined;
  }
  context.currentUser={id:1,role:'owner'};context.currentRole='office';context.company.id='tenant-a';
  deferredRoute='/api/reports/1/rate';
  const sameTenantClick=click({target:{closest:value=>value==='[data-pdl-rate-review]'?{disabled:false,dataset:{pdlRateReview:'1'}}:null}});
  await new Promise(resolve=>setImmediate(resolve));context.currentUser={id:2,role:'owner'};
  resolveDeferred({id:1,rateSnapshot:{laborRate:999}});await sameTenantClick;
  assert.equal(context.reports[0].rateSnapshot,undefined,'same tenant different account invalidates pending financial response');
  deferredRoute=undefined;
  context.currentUser={id:1,role:'owner'};context.currentRole='office';context.company.id='tenant-a';
  const insertionsBefore=insertions;deferredOpen=true;const pendingOpen=context.openProject(1);await new Promise(resolve=>setImmediate(resolve));
  context.company.id='tenant-b';resolveOpen();await pendingOpen;
  assert.equal(insertions,insertionsBefore,'project wrapper cannot append old tenant rate controls after awaited navigation');
  deferredOpen=false;
  context.currentUser={role:'field'};context.currentRole='field';context.company.id='tenant-b';context.renderEverything();assert.equal(node('pdl-fixed-exports').hidden,true,'account/role switch hides export controls');
  console.log('Reporting control fixtures passed: escaped history, no guessed legacy rate, read-only manager, version reason/lineage, duplicate-click guard, rate-review payload and role switch. Real browser QA remains open.');
})().catch(error=>{console.error(error);process.exitCode=1});
