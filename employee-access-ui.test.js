'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(__dirname+'/app.js','utf8');
function nodeList(rows){return Object.assign({length:rows.length,forEach:fn=>rows.forEach(fn),[Symbol.iterator]:()=>rows[Symbol.iterator]()},Object.fromEntries(rows.map((row,index)=>[index,row])))}
function harness(){
  const elements=new Map(),requests=[],notifications=[];
  function element(id){if(!elements.has(id))elements.set(id,{value:'',textContent:'',innerHTML:'',hidden:false,disabled:false,open:false,dataset:{},listeners:{},addEventListener(event,fn){this.listeners[event]=fn},showModal(){this.open=true},close(){this.open=false;this.listeners.close?.()},replaceChildren(){this.innerHTML=''},insertAdjacentHTML(position,html){this.innerHTML+=html},append(node){this.textContent+=node.textContent},reportValidity(){return this.value.includes('@')},focus(){this.focused=true}});return elements.get(id)}
  const context={document:{createElement:()=>({textContent:''})},$:element,$$:selector=>nodeList(selector.includes('input:checked')?[{value:selector.includes('projects')?'1':'QA'}]:[]),projects:[{id:1,name:'<unsafe project>'}],team:[{crew:'QA'}],escapeHtml:value=>String(value).replaceAll('<','&lt;').replaceAll('>','&gt;'),notify:message=>notifications.push(message),temporaryPasswordMarkup:password=>'<input value="'+password+'">',api:async(route,options)=>{requests.push({route,options});return context.response(route,options)},response:async()=>({employee:{id:1,name:'<unsafe name>',role:'Laborer',crew:'QA',email:'employee@example.invalid',hours:0},account:null,accessRoles:['field','project_manager']})};
  vm.createContext(context);vm.runInContext(source.slice(source.indexOf('let employeeDetailRequest='),source.indexOf('function renderTeamDirectory()')),context);
  return{context,element,requests,notifications};
}
(async()=>{
  let h=harness();await h.context.openEmployeeDetail(1);assert.equal(h.element('#employee-detail-title').textContent,'<unsafe name>');assert(h.element('#employee-detail-content').innerHTML.includes('Choose app role'));assert(h.element('#employee-detail-content').innerHTML.includes('<dd>0</dd>'));assert(!h.element('#employee-access-projects').innerHTML.includes('<unsafe project>'));
  await h.element('#employee-grant-access').onclick();assert.equal(h.requests.length,1,'role selection is mandatory');
  h.element('#employee-access-role').value='project_manager';h.element('#employee-access-role').onchange();assert.equal(h.element('#employee-access-scope').hidden,false);
  let resolve;h.context.response=()=>new Promise(done=>{resolve=done});const pending=h.element('#employee-grant-access').onclick();await h.element('#employee-grant-access').onclick();assert.equal(h.requests.length,2,'only one mutation while pending');assert.equal(h.element('#employee-grant-access').disabled,true);
  const payload=JSON.parse(h.requests[1].options.body);assert.deepEqual(payload.projectIds,[1]);assert.deepEqual(payload.assignedCrews,['QA']);assert.equal(payload.role,'project_manager');
  h.element('#employee-detail-close').onclick();assert(h.element('#employee-detail-modal').open,'cannot lose credentials by closing during creation');
  resolve({account:{role:'project_manager'},temporaryPassword:'synthetic-password'});await pending;assert(h.element('#employee-access-result').innerHTML.includes('synthetic-password'));h.element('#employee-detail-close').onclick();assert.equal(h.element('#employee-access-result').innerHTML,'');
  h=harness();h.context.response=async()=>({employee:{id:1,name:'QA'},account:{status:'Deactivated',role:'field'},accessRoles:['field']});await h.context.openEmployeeDetail(1);assert(h.element('#employee-detail-content').textContent.includes('Deactivated'));assert(!h.element('#employee-detail-content').innerHTML.includes('employee-grant-access'));
  h=harness();h.context.response=async()=>({employee:{id:1,name:'QA'},account:null,accessRoles:['field'],emailConflict:true});await h.context.openEmployeeDetail(1);assert(h.element('#employee-detail-content').textContent.includes('already uses'));
  h=harness();let firstResolve;h.context.response=()=>new Promise(done=>{firstResolve=done});const first=h.context.openEmployeeDetail(1);h.context.response=async()=>({employee:{id:2,name:'Second'},account:null,accessRoles:[]});await h.context.openEmployeeDetail(2);firstResolve({employee:{id:1,name:'First'},account:null,accessRoles:[]});await first;assert.equal(h.element('#employee-detail-title').textContent,'Second','stale detail response ignored');
  h=harness();h.context.configureUserFields=()=>{};h.context.team=[{id:1,name:'Linked employee',crew:'QA'},{id:2,name:'Other employee',crew:'QA'}];
  vm.runInContext(source.slice(source.indexOf('function openUserModal('),source.indexOf('async function updateUserStatus(')),h.context);
  h.context.openUserModal({id:7,name:'Office account',employeeId:1,memberId:null,role:'admin'});
  assert(h.element('#user-field-member').innerHTML.includes('value="1" selected'));assert(!h.element('#user-field-member').innerHTML.includes('Other employee'),'durable account identity cannot silently move in edit form');
  h.context.openUserModal();assert(h.element('#user-field-member').innerHTML.includes('Other employee'),'existing generic creation choices remain available');
  console.log('Employee detail UI behavior passed: explicit role, duplicate submits, scope, credentials, existing accounts, conflict and stale responses.');
})().catch(error=>{console.error(error);process.exitCode=1});
