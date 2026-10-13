'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const inputs=require('./resource-inputs');
const operation=details=>({kind:'projectCreate',method:'POST',path:'/api/projects',details:{name:'Synthetic first project',contractType:'estimated',tmSettings:null,...details}});
const unlinked=inputs.parse(operation({customerId:null,customer:''}));
assert.equal(unlinked.details.customerId,null);assert.equal(unlinked.details.customer,'');
for(const details of [{},{customerId:null},{customerId:0,customer:''},{customerId:'',customer:''},{customerId:null,customer:'Hidden customer'},{customerId:null,customer:' '},{customerId:1,customer:''},{customerId:'1',customer:'Synthetic customer'},{customerId:false,customer:''},{customerId:null,customer:'',companyId:'other'}])assert.throws(()=>inputs.parse(operation(details)),error=>error.statusCode===400);
const linked=inputs.parse(operation({customerId:1,customer:'Synthetic customer'}));assert.equal(linked.details.customerId,1);
const db={company:{id:'synthetic',features:{templates:false}},customers:[{id:1,name:'Synthetic customer'}],team:[],users:[],projects:[]},auth={user:{id:1,status:'Active',role:'field'}},helpers={canViewPricing:()=>false};
inputs.authorize(db,auth,unlinked,helpers);inputs.authorize(db,auth,linked,helpers);
assert.throws(()=>inputs.authorize(db,auth,inputs.parse(operation({customerId:1,customer:'Spoofed customer'})),helpers),error=>error.statusCode===404);
for(const details of [{budget:'$1'},{contractType:'tm',tmSettings:{defaultLaborRate:1,materialMarkup:0,equipmentMarkup:0}},{supervisor:'Foreign employee'},{templateId:'foreign'}])assert.throws(()=>inputs.authorize(db,auth,inputs.parse(operation({customerId:null,customer:'',...details})),helpers),error=>[403,404].includes(error.statusCode));
const source=fs.readFileSync('app.js','utf8'),html=fs.readFileSync('index.html','utf8');
const step=source.split(/\r?\n/).find(line=>line.startsWith('function openSetupStep('));let opened=0,pages=[],notice='';
const tags={value:'stale'};
const box={window:{pdlProductionRoles:{rolePolicies:()=>true}},currentUser:{effectiveCapabilities:{daily:{createReports:false}}},projects:[{id:1}],teamTab:'',notify:value=>{notice=value},showPage:value=>pages.push(value),$:(selector)=>selector==='#report-photo-tags'?tags:{click(){}},syncReportPhotoTagsVisibility(){},openReport(){opened++},renderTeamDirectory(){}};
vm.createContext(box);vm.runInContext(step,box);box.openSetupStep('report');assert.equal(opened,0);assert.equal(pages.length,0);assert.match(notice,/permission/);
box.currentUser={accessRole:'office',effectiveCapabilities:{daily:{createReports:false}}};box.openSetupStep('report');assert.equal(opened,0);
box.currentUser.effectiveCapabilities.daily.createReports=true;box.openSetupStep('report');assert.equal(opened,1);assert.equal(tags.value,'');assert.deepEqual(pages,['reports']);
assert.ok(fs.readFileSync('workspace-controls.js','utf8').includes('[data-setup="report"]'));
assert.match(html,/html:not\(\.workspace-ready\) \.app-shell\{visibility:hidden\}/);assert.match(html,/html\.workspace-ready \.workspace-loader\{display:none\}/);
assert.match(html,/configResponse\.ok/);assert.match(html,/window\.pdlWorkspaceConfig/);
const empty={hidden:true},panels=Object.fromEntries(['.stats-grid','.dashboard-grid','.projects-panel'].map(selector=>['#dashboard-page '+selector,{hidden:false}]));
const dashboard={renderDashboardSummary(){},actionCenter:{counts:{}},renderSetupChecklist:()=>({complete:false}),projects:[],reports:[],$:selector=>selector==='#dashboard-empty'?empty:panels[selector]||null};
vm.createContext(dashboard);vm.runInContext(source.split(/\r?\n/).find(line=>line.startsWith('const renderDashboardSummaryBase=')),dashboard);dashboard.renderDashboardSummary();assert.equal(empty.hidden,false);assert.ok(Object.values(panels).every(node=>node.hidden));dashboard.projects=[{id:1}];dashboard.renderDashboardSummary();assert.equal(empty.hidden,true);assert.ok(Object.values(panels).every(node=>!node.hidden));
const gapTarget={className:'',innerHTML:''},workRow={querySelector:selector=>({value:selector==='.custom-description'?'Synthetic zero-hour observation':''}),classList:{toggle(){}}};
const gaps={$:selector=>selector==='#report-type'?{value:'production'}:selector==='#report-gaps'?gapTarget:null,$$:selector=>selector==='.production-entry'?[workRow]:[],reportLaborTotals:()=>({crew:0,allocated:0,balanced:true}),noteLaborUnassigned:()=>0,refreshNoteLaborStatus(){}};
vm.createContext(gaps);vm.runInContext(source.split(/\r?\n/).find(line=>line.startsWith('function updateReportGaps(')),gaps);gaps.updateReportGaps();assert.equal(gapTarget.className,'report-gaps complete');assert.match(gapTarget.innerHTML,/ready to submit/);
for(const [page,script]of [['signup.html','signup.js'],['login.html','login.js'],['reset-password.html','reset-password.js']]){
 const markup=fs.readFileSync(page,'utf8'),js=fs.readFileSync(script,'utf8');assert.ok(markup.includes(script+'?v=20261013-uxa'));assert.ok(!/id="(?:confirm-password|confirm-email|password-confirm|email-confirm)"/.test(markup));assert.ok(!/getElementById\(['"](?:confirm-password|confirm-email|password-confirm|email-confirm)['"]\)/.test(js));
}
async function verification(search,outcome){
 const elements=Object.fromEntries(['verification-result','verification-next','verification-heading'].map(id=>[id,{textContent:id==='verification-heading'?'Confirming your email':'',hidden:true}]));let resolve,requests=0,stored=0;
 const context={URLSearchParams,location:{search},document:{getElementById:id=>elements[id]},localStorage:{setItem(){stored++}},fetch:()=>{requests++;return new Promise(done=>{resolve=done})}};
 vm.createContext(context);const running=vm.runInContext(fs.readFileSync('verify-email.js','utf8'),context);
 if(!search){await running;assert.equal(requests,0);assert.equal(stored,0);assert.match(elements['verification-heading'].textContent,/could not/);return;}
 assert.equal(elements['verification-heading'].textContent,'Confirming your email');assert.equal(elements['verification-next'].hidden,true);assert.equal(stored,0);
 resolve({ok:outcome,json:async()=>outcome?{email:'synthetic@example.invalid'}:{error:'Synthetic rejected link'}});await running;
 assert.equal(stored,outcome?1:0);assert.equal(elements['verification-next'].hidden,false);assert.equal(elements['verification-heading'].textContent,outcome?'Email confirmed':'We could not confirm your email');
}
async function projectForm(){
 const controls={'#project-name':{value:'Synthetic optional project'},'#project-customer':{value:''},'#project-type':{value:'estimated'},'#project-code':{value:''},'#project-budget':{value:''},'#project-site':{value:''},'#project-start':{value:''},'#project-end':{value:''},'#project-supervisor':{value:''},'#project-contact':{value:''},'#project-modal':{close(){}}};let submitted=null,identityChecks=0;
 const context={$:selector=>controls[selector],customers:[],projects:[],projectCreationCustomer:null,window:{pdlWorkspaceActions:{enabled:()=>true,identity:async()=>{identityChecks++;return {companyId:'synthetic',actorId:1,role:'owner',sessionBinding:'current',authority:'current'}}}},api:async(_route,options)=>{submitted=JSON.parse(options.body);return {...submitted,id:101}},templatesOn:()=>false,renderProjectCards(){},renderCustomers(){},renderTable(){},notify(){},openEstimateImport(){}};
 vm.createContext(context);vm.runInContext(source.split(/\r?\n/).find(line=>line.startsWith('async function saveProject(')),context);await context.saveProject();assert.equal(submitted.customerId,null);assert.equal(submitted.customer,'');assert.equal(identityChecks,0);assert.equal(context.projects.length,0,'Managed readback owns projected project state');
 controls['#project-customer'].value='21';context.projectCreationCustomer={id:21,name:'Synthetic current customer',binding:{companyId:'synthetic',actorId:1,role:'owner',sessionBinding:'current',authority:'current'}};submitted=null;await context.saveProject();assert.equal(submitted.customerId,21);assert.equal(submitted.customer,'Synthetic current customer');assert.equal(identityChecks,1);
 context.projectCreationCustomer={id:21,name:'Synthetic stale customer',binding:{companyId:'synthetic',actorId:1,role:'owner',sessionBinding:'current',authority:'stale'}};submitted=null;await context.saveProject();assert.equal(submitted,null,'Positive customer custody stays bound to fresh authority');assert.equal(identityChecks,2);
}
Promise.all([projectForm(),verification('',false),verification('?tenant=synthetic&token=owned',false),verification('?tenant=synthetic&token=owned',true)]).then(()=>console.log('Main UX integration: canonical optional-customer tuples and fixed financial/reference floors; actual project form and fresh positive-customer custody; restricted checklist; empty dashboard and hidden pre-auth shell; pinned simplified auth; pending/failed/success verification passed')).catch(error=>{console.error(error);process.exitCode=1;});
