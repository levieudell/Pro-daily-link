'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync('app.js','utf8');
function code(name){
  const lines=source.split('\n'),start=lines.findIndex(line=>line.startsWith(`function ${name}(`)||line.startsWith(`async function ${name}(`));
  assert.ok(start>=0,name);
  if(lines[start].trimEnd().endsWith('}'))return lines[start];
  const end=lines.findIndex((line,index)=>index>start&&line.trimEnd()==='}');
  return lines.slice(start,end+1).join('\n');
}
const nodes=new Map();
const node=key=>{if(!nodes.has(key))nodes.set(key,{innerHTML:'',value:'all',hidden:false,textContent:'',querySelectorAll:()=>[]});return nodes.get(key)};
const attack='<img src=x onerror="globalThis.attack=1">';
const context={$:node,$$:()=>[],location:{origin:'https://example.invalid'},URL,
  projects:[{id:1,name:attack,code:attack,customer:attack,site:attack,status:attack,color:attack,progress:attack,production:0,budget:attack,crew:attack}],
  team:[{id:1,name:attack,initials:attack,role:attack,crew:attack,hours:attack}],
  workdays:[{status:'active',memberIds:[1],projectId:1}],
  photos:[{project:0,url:'javascript:alert(1)',caption:attack}],
  projectView:'active',todayProjectPeople:()=>0,projectHealth:()=> 'Healthy',liveTimeEntries:()=>[],statusClass:()=>'',
  actionCenter:{counts:{},items:[{id:attack,title:attack,detail:attack,severity:attack}]},
  catalog:[{id:1,name:attack,category:attack,description:attack,unit:attack,targetHoursPerUnit:1,history:{actualHoursPerUnit:2}}],
  localStorage:new Map(),sessionStorage:new Map(),company:{id:'tenant-a'},currentUser:{id:1},
  signedInCompanyId:()=>context.company.id,reports:[],restoringActiveReport:false,ACTIVE_REPORT_RECOVERY_KEY:'active',
  notify:()=>{},openReport:()=>{context.opened=true},applyOfflineReportDraft:()=>{},restoreRecoveredReportFields:()=>{},
  renderReportCustomFields:()=>{},activeReportRecovery:()=>JSON.parse(context.sessionStorage.get('active')||'null')};
for(const store of [context.localStorage,context.sessionStorage]){
  store.getItem=key=>store.get(key)||null;store.setItem=(key,value)=>store.set(key,value);store.removeItem=key=>store.delete(key);
}
vm.createContext(context);
for(const name of ['escapeHtml','projectBadgeColor','projectProgress','projectPhotoUrl','renderTable','renderProjectCards','renderTeam','renderActionCenter','renderCatalog','importLineMarkup','offlineReportStorageKey','hasOfflineReportContent','readOfflineDraft','restoreInterruptedReport'])vm.runInContext(code(name),context);
for(const name of ['renderTable','renderProjectCards','renderTeam','renderActionCenter','renderCatalog']){
  context[name]();
  for(const [key,element] of nodes)assert.ok(!element.innerHTML.includes(attack),name+' must escape injected markup in '+key+': '+element.innerHTML.slice(Math.max(0,element.innerHTML.indexOf(attack)-50),element.innerHTML.indexOf(attack)+100));
}
assert.equal(context.projectPhotoUrl('javascript:alert(1)'),'');
assert.equal(context.projectPhotoUrl('data:image/svg+xml;base64,PHN2Zz4='),'');
assert.equal(context.projectPhotoUrl('https://user:pass@example.invalid/photo.jpg'),'');
assert.equal(context.projectPhotoUrl('/uploads/photo.jpg'),'https://example.invalid/uploads/photo.jpg');
assert.equal(context.projectProgress('100; background:url(x)'),0);
const imported=context.importLineMarkup({description:attack,unit:attack,quantity:attack,amount:attack,confidence:attack,catalogSuggestions:[{id:1,name:attack,targetHoursPerUnit:attack,score:attack}]},0);
assert.ok(!imported.includes(attack),'imported text and numeric attribute contexts must escape markup');

(async()=>{
  const originalKey=context.offlineReportStorageKey(0);
  context.localStorage.setItem(originalKey,JSON.stringify({notes:'',summary:'Structured work retained',photoNames:['photo.jpg'],laborEntries:[{memberId:1,hours:8}]}));
  assert.equal(context.hasOfflineReportContent(context.readOfflineDraft(0)),true);
  context.company.id='tenant-b';assert.notEqual(context.offlineReportStorageKey(0),originalKey);
  assert.equal(context.readOfflineDraft(0).notes,'');
  context.company.id='tenant-a';context.currentUser.id=2;assert.equal(context.readOfflineDraft(0).notes,'');
  context.currentUser.id=1;
  context.projects.unshift({id:99});assert.equal(context.offlineReportStorageKey(1),originalKey,'project reordering preserves stable draft identity');
  context.sessionStorage.setItem('active',JSON.stringify({companyId:'tenant-a',userId:1,projectId:1,key:'0'}));
  await context.restoreInterruptedReport();assert.equal(context.opened,true,'structured draft without notes must resume');
  context.opened=false;context.sessionStorage.setItem('active',JSON.stringify({companyId:'tenant-b',userId:1,projectId:1,key:'0'}));
  await context.restoreInterruptedReport();assert.equal(context.opened,false,'foreign tenant recovery cannot open');
  context.sessionStorage.setItem('active',JSON.stringify({companyId:'tenant-a',userId:2,projectId:1,key:'0'}));
  await context.restoreInterruptedReport();assert.equal(context.opened,false,'another user recovery cannot open');
  assert.ok(context.localStorage.has(originalKey),'foreign recovery handling must not delete original draft');
  console.log('Browser safety tests passed: injected rendering, image/CSS contexts, tenant/user/project draft scoping and structured-only recovery.');
})().catch(error=>{console.error(error);process.exitCode=1});
