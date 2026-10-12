'use strict';
// Actual public lifecycle module: flag-off codes survive ambient events; managed
// codes retire, and explicit auth denial can retire either. No authority mocks
// are used to claim server/browser acceptance.
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const source=fs.readFileSync(require('node:path').join(__dirname,'original-result-ui.js'),'utf8');let checks=0;
for(const scenario of [{flag:undefined,normal:false,managed:false},{flag:false,normal:false,managed:false},{flag:true,normal:false,managed:true},{flag:undefined,normal:true,managed:true}])for(const event of ['blur','hidden','storage']){
 const handlers={},staff={textContent:'SYNTHETIC-STAFF',replaceChildren(){this.textContent='';}},owner={textContent:'SYNTHETIC-OWNER',replaceChildren(){this.textContent='';}};
 let requests=0,entries=0;const context={console,localStorage:{},platformUser:{role:'platform_owner',manualCredentialCustody:scenario.flag},pdlProductionRoles:{enabled:()=>scenario.normal},PDLManualCredentialRecovery:{originalOperations:()=>{entries++;return[];}},api:async()=>{requests++;throw Error('Empty journal must not query identity');},document:{hidden:false,querySelectorAll:()=>[staff,owner],querySelector:()=>null,createElement:()=>({}),addEventListener:(name,callback)=>handlers['document:'+name]=callback},addEventListener:(name,callback)=>handlers[name]=callback,setTimeout:()=>0};context.window=context;vm.createContext(context);vm.runInContext(source,context,{filename:'original-result-ui.js:actual'});
 if(event==='hidden'){context.document.hidden=true;handlers['document:visibilitychange']();}else if(event==='storage'){handlers.storage({key:null});}else handlers.blur();
 assert.equal(staff.textContent,scenario.managed?'':'SYNTHETIC-STAFF');assert.equal(owner.textContent,scenario.managed?'':'SYNTHETIC-OWNER');assert.equal(requests,0);context.PDLOriginalResultUI.retire();assert.equal(staff.textContent,'');assert.equal(owner.textContent,'');checks++;
}
console.log(JSON.stringify({passed:true,checks,sourceSha256:crypto.createHash('sha256').update(source).digest('hex'),actualSource:true,pureVm:true,externalCalls:0,providerCalls:0,productionChanges:false}));
