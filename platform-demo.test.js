'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const elements=Object.fromEntries(['#demo-request-count','#demo-requests','#demo-queue-status','#demo-queue-retry'].map(id=>[id,{innerHTML:id==='#demo-requests'?'Loading demo requests.':'',addEventListener(event,callback){this[event]=callback;}}]));
let handler,mode='http-error';
const rows=[{id:'synthetic-id',company:'Synthetic <Contractor>',name:'Synthetic Buyer',email:'buyer@example.test',status:'New',preferredTime:'2026-10-12T09:30'},
  {id:'synthetic-timed',company:'Timed contractor',status:'Contacted',preferredTime:'2026-10-12T09:30',preferredTimeZone:'America/Chicago',preferredTimeUtc:'2026-10-12T14:30:00.000Z'}];
const context={document:{createElement:()=>({}),querySelector:selector=>elements[selector]||{prepend(){}},addEventListener:(event,callback)=>{handler=callback;}},fetch:async(url,options)=>{
  if(mode==='network-error')throw new Error('Synthetic disconnected network');
  if(options.method==='PATCH')return {ok:mode!=='save-error'};
  return {ok:mode!=='http-error',json:async()=>mode==='bad-json'?{}:rows};
}};
vm.createContext(context);vm.runInContext(fs.readFileSync('platform-demo.js','utf8'),context);
(async()=>{
  await context.loadDemoRequests();
  assert.match(elements['#demo-queue-status'].textContent,/Could not load/);
  assert.equal(elements['#demo-requests'].innerHTML,'');
  assert.equal(elements['#demo-queue-retry'].hidden,false);
  for(mode of ['network-error','bad-json']){await context.loadDemoRequests();assert.equal(elements['#demo-queue-retry'].hidden,false);}
  mode='success';await elements['#demo-queue-retry'].click();
  assert.equal(elements['#demo-queue-retry'].hidden,true);
  assert.match(elements['#demo-requests'].innerHTML,/Synthetic &lt;Contractor&gt;/);
  assert.match(elements['#demo-requests'].innerHTML,/2026-10-12 09:30 \(time zone not provided; confirm with requester\)/);
  assert.match(elements['#demo-requests'].innerHTML,/America\/Chicago/);
  const select={dataset:{demoRequest:'synthetic-id'},value:'Scheduled',disabled:false};
  mode='save-error';await handler({target:select});
  assert.equal(select.disabled,false);assert.match(elements['#demo-queue-status'].textContent,/Could not confirm/);
  mode='network-error';await handler({target:select});assert.equal(elements['#demo-queue-retry'].hidden,false);
  mode='success';await elements['#demo-queue-retry'].click();assert.equal(elements['#demo-queue-status'].textContent,'');
  console.log('Demo queue passed: HTTP/network/data failures, retry recovery, saved-status errors, escaped contacts, and explicit requester time zones.');
})().catch(error=>{console.error(error);process.exitCode=1;});
