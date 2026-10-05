'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('platform-sales-demo.js','utf8');
assert.match(fs.readFileSync('platform.js','utf8'),/c\.demoResetAvailable\?`<button class="small" data-demo-reset=/);
const id='ad1de000-d300-4000-8000-000000000001';
function fixture({role='platform_owner',confirm=true,delayGet=false,errorPost=false}={}){
 let listener,release;const calls=[],alerts=[],host={children:[],querySelector(){return null},append(x){this.children.push(x)}};
 const button={dataset:{prepareSalesDemo:id},isConnected:true,disabled:false,parentElement:host};
 const context={platformUser:{role},data:{companies:[{id,name:'DEMO | Alder Ridge Builders'}]},currentView:'customers',viewVersion:1,confirm:()=>confirm,alert:x=>alerts.push(x),reload:async()=>{},document:{addEventListener:(_name,fn)=>{listener=fn},querySelector:()=>button,createElement:tag=>({tag,dataset:{},children:[],append(x){this.children.push(x)}})},api:async(url,options)=>{calls.push({url,options});if(!options){if(delayGet)await new Promise(resolve=>release=resolve);return{companyName:'DEMO | Alder Ridge Builders',expectedRevision:1,asOf:'2026-10-05',alreadyPrepared:false};}if(errorPost)throw Error('Synthetic persistence error');return{counts:{projects:3,reports:60,timeCards:160}};}};
 vm.runInNewContext(source,context);return{context,calls,alerts,host,button,click:()=>listener({target:{closest:()=>button}}),release:()=>release()};
}
(async()=>{
 let f=fixture({role:'support'});await f.click();assert.equal(f.calls.length,0);
 f=fixture({confirm:false});await f.click();assert.equal(f.calls.length,1);assert.equal(f.button.disabled,false);assert.equal(f.host.children.length,0);
 f=fixture({delayGet:true});const pending=f.click();await f.click();assert.equal(f.calls.length,1);f.context.viewVersion++;f.release();await pending;assert.equal(f.calls.length,1);assert.equal(f.alerts.length,0);
 f=fixture();await f.click();assert.equal(f.calls.length,2);assert.equal(f.host.children.length,1);assert.equal(f.host.children[0].children[0].href,'/app?tenant='+id);assert.equal(f.host.children[0].children[0].target,'_blank');assert.equal(f.button.disabled,false);assert.equal(f.alerts.length,0);
 f=fixture({errorPost:true});await f.click();assert.equal(f.host.children.length,0);assert.match(f.alerts[0],/persistence error/);assert.equal(f.button.disabled,false);
 assert.doesNotMatch(source,/innerHTML|localStorage|support-access|owner-reset|password|token/i);
 console.log('Sales demo UI: owner-only, cancel, repeated click, stale navigation, saved link and failed-save behavior passed.');
})().catch(error=>{console.error(error);process.exitCode=1;});
