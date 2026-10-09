'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const A='b0576860-a3d9-4bb6-aae2-b5e7186cbb71',B='ba19a156-1cac-4c8a-b921-6bc356df97ef',hash='a'.repeat(64),other='b'.repeat(64);
const identity=(companyId=A,role='owner')=>({companyId,actorId:1,role,revision:10,authority:companyId===A?hash:other,sessionBinding:companyId===A?hash:other,expiresAt:new Date(Date.now()+60000).toISOString(),locked:false,effectiveCapabilities:{},features:{}});
async function main(){
 let company=A,next=identity(),retired=0,hold,started;const events={};
 const box={window:{addEventListener:(name,fn)=>events[name]=fn},document:{querySelectorAll:()=>[],getElementById:()=>null,querySelector:()=>null},localStorage:{getItem:()=>company},Date,Error,URL,fetch:async()=>({ok:true,json:async()=>{if(hold){started?.();await hold;}return next;}})};
 vm.createContext(box);vm.runInContext(fs.readFileSync('workspace-actions-ui.js','utf8'),box);const actions=box.window.pdlWorkspaceActions;
 const configure=(role='owner')=>actions.configure({compatibilityAccount:{workspace:true,companyId:company}},{id:1,role:role==='foreman'?'field':role,accessRole:role,accountSessionBinding:company===A?hash:other},()=>retired++);
 configure();await actions.identity();
 let release;hold=new Promise(resolve=>release=resolve);let begun;const ready=new Promise(resolve=>begun=resolve);started=begun;
 const old=actions.identity();await ready;company=B;configure();release();await assert.rejects(old,/changed while checking/);hold=null;next=identity(B);await actions.identity();assert.equal(retired,1);
 await assert.rejects(actions.verifyResponse({ok:true,headers:{get:key=>key.includes('Revision')?'10':hash}},'/api/production'),/changed while loading/);assert.equal(retired,2);
 company=A;configure('foreman');next=identity(A,'foreman');assert.equal((await actions.identity()).role,'foreman');
 next={...next,locked:true};await assert.rejects(actions.identity(),/access changed/);assert.ok(retired>=3);
 await assert.rejects(actions.verifyResponse({ok:false,status:402,headers:{get:()=>null}},'/api/time-cards.csv'),error=>error.status===402);
 const reviewBox={window:{},location:{origin:'http://127.0.0.1'},URL,crypto:require('node:crypto').webcrypto};vm.createContext(reviewBox);vm.runInContext(fs.readFileSync('workspace-action-review.js','utf8'),reviewBox);
 const operation=reviewBox.window.pdlWorkspaceReview.operation;
 const clock=operation('/api/time-cards/1/clock-out',{method:'POST',body:'{}'});assert.equal(clock.preview.action,'clockOut');assert.equal(clock.action,'clockCards');assert.equal(operation('/api/time-cards/approve',{method:'POST',body:'{"ids":[1]}'}).action,'approveCards');
 const source=fs.readFileSync('app.js','utf8'),begin=source.indexOf('async function api(path,options={})'),end=source.indexOf('\nconst workspaceApi=api;',begin);assert.ok(begin>0&&end>begin);
 let ack=0,posts=0,clears=0,refreshStatus=503;const notices=[];
 const apiBox={window:{pdlWorkspaceActions:{enabled:()=>true,clear:()=>clears++,verifyResponse:async()=>{}}},signedInCompanyId:()=>A,wakeService:async()=>{},fetch:async(path,request)=>{if(request.method==='PATCH')posts++;const status=path==='/api/state'?refreshStatus:200;return {ok:status===200,status,headers:{get:()=> 'application/json'},json:async()=>status===200?{id:501,status:'Approved'}:{error:'Synthetic refresh failure'}};},notify:value=>notices.push(value),location:{},Error};
 vm.createContext(apiBox);vm.runInContext(source.slice(begin,end),apiBox);
 assert.equal((await apiBox.api('/api/reports/501/approve',{method:'PATCH',onAcknowledged:()=>ack++})).id,501);assert.equal(ack,1);assert.equal(posts,1);assert.ok(notices.some(value=>value.startsWith('Saved.')));
 refreshStatus=403;await assert.rejects(apiBox.api('/api/reports/501/approve',{method:'PATCH',onAcknowledged:()=>ack++}),error=>error.saved===true&&error.message.startsWith('Saved.'));assert.equal(ack,2);assert.equal(clears,1);
 console.log('workspace client: tenant/configure epoch, Foreman, natural lock, denied CSV, clock/bulk routing and known-save refresh failures passed');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
