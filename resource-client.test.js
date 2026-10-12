'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const A='b0576860-a3d9-4bb6-aae2-b5e7186cbb71',before='a'.repeat(64),after='b'.repeat(64),session='c'.repeat(64);
async function main(){
  let next={companyId:A,actorId:1,role:'owner',revision:10,authority:before,sessionBinding:session,expiresAt:new Date(Date.now()+600000).toISOString(),locked:false},retired=0,pending=null;
  const box={window:{addEventListener(){},pdlResourceActions:{pending:()=>pending,draw(){}}},document:{querySelectorAll:()=>[],getElementById:()=>null,querySelector:()=>null},localStorage:{getItem:()=>A},Date,Error,URL,atob:value=>Buffer.from(value,'base64').toString('binary'),fetch:async()=>({ok:true,json:async()=>next})};
  vm.createContext(box);vm.runInContext(fs.readFileSync('workspace-actions-ui.js','utf8'),box);const actions=box.window.pdlWorkspaceActions;
  const configure=async()=>{next={...next,role:'owner',authority:before,sessionBinding:session};actions.configure({compatibilityAccount:{workspace:true,companyId:A}},{id:1,role:'owner',accountSessionBinding:session},()=>retired++);await actions.identity();};
  const tuple={companyId:A,actorId:1,role:'owner',sessionBinding:session,authority:before,method:'POST',path:'/api/projects',token:'12345678-1234-4234-8234-123456789012',version:'d'.repeat(64),requestId:'synthetic-save-request'};
  const link={purpose:'workspace-resource-save-v1',receiptId:'12345678-1234-4234-8234-123456789013',token:tuple.token,version:tuple.version,requestId:tuple.requestId,method:tuple.method,path:tuple.path,companyId:A,actorId:1,sessionBinding:session,originalAuthority:before,from:before,to:after};
  const response=row=>({ok:true,headers:{get:name=>name==='X-PDL-Workspace-Revision'?'10':name==='X-PDL-Workspace-Authority'?after:name==='X-PDL-Resource-Receipt'&&row?Buffer.from(JSON.stringify(row)).toString('base64url'):null}});
  await configure();pending=tuple;const binding=actions.capture();next={...next,authority:after};await actions.verifyResponse(response(link),'/api/projects',binding);assert.equal((await actions.identity()).authority,after);
  await configure();pending=tuple;next={...next,authority:after};actions.configure({compatibilityAccount:{workspace:true,companyId:A}},{id:1,role:'owner',accountSessionBinding:session},()=>retired++);await actions.identity();const original=actions.capture();await actions.verifyResponse(response({...link,purpose:'workspace-resource-outcome-v1',from:after}),'/api/resources/original-result',original);
  for(const [row,path,custody]of [[{...link,requestId:'another-save-request'},'/api/projects',tuple],[link,'/api/customers',tuple],[link,'/api/projects',null],[null,'/api/projects',tuple]]){
    await configure();pending=custody;const captured=actions.capture();next={...next,authority:after};await assert.rejects(actions.verifyResponse(response(row),path,captured),/receipt/);
  }
  await configure();pending=tuple;const changedSession=actions.capture();next={...next,authority:after,sessionBinding:'e'.repeat(64)};await assert.rejects(actions.verifyResponse(response(link),'/api/projects',changedSession),/Sign in again/);
  await configure();pending=tuple;const roleChanged=actions.capture();next={...next,role:'admin',authority:after};await assert.rejects(actions.verifyResponse(response(link),'/api/projects',roleChanged),/Sign in again/);
  await configure();pending=tuple;const unexpected=actions.capture();next={...next,authority:'f'.repeat(64)};await assert.rejects(actions.verifyResponse(response(link),'/api/projects',unexpected),/receipt does not match/);
  await configure();pending=null;const held=actions.capture();actions.resourceChanged();await assert.rejects(actions.verifyResponse({ok:true,headers:{get:()=>null}},'/api/state',held),/earlier load/);
  assert.ok(retired>=7);console.log('resource client: exact confirmed and recovery custody accepts current after-authority; missing/forged/foreign/role/session/held responses deny');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
