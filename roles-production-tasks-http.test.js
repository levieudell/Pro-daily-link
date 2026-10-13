'use strict';
const assert=require('node:assert/strict'),{canonicalHash}=require('./database/transactional-repository');
const fixture=require('./roles-production-http.test'),scheduling=require('./scheduling-access');
async function main(){
 fixture.alter(db=>{
   db.projects[0].startDate='2026-10-05';db.projects[0].estimateItems.push({id:41,name:'Synthetic current estimate',unit:'cy',plannedQuantity:40});
   db.projects.push({id:102,name:'Synthetic separate project',startDate:'2026-10-05',estimateItems:[{id:42,name:'Separate estimate'}]});
   db.projectTasks=[{id:1,projectId:101,name:'Linked task',durationDays:1,predecessorIds:[],memberIds:[],crew:'Office',status:'not-started',estimateItemId:41,startDate:'2026-10-05',endDate:'2026-10-05',createdAt:'2026-10-01T00:00:00.000Z',createdBy:db.users[0].name}];
   db.company.schedulingRolePolicy={version:1,revision:1,roles:Object.fromEntries(scheduling.roles.map(role=>[role,scheduling.ceiling(role)]))};db.company.schedulingPolicyRequired=true;
 });
 await new Promise(resolve=>fixture.server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+fixture.server.address().port;
 async function patch(input){const response=await fetch(origin+'/api/project-tasks/1',{method:'PATCH',signal:AbortSignal.timeout(10000),headers:{'X-PDL-Company':fixture.A,Authorization:'Bearer '+fixture.tokens.get(1),'Content-Type':'application/json'},body:JSON.stringify(input)});return {status:response.status,data:await response.json()};}
 const retained=await patch({name:'Renamed task'});assert.equal(retained.status,200,JSON.stringify(retained.data));assert.equal(retained.data.tasks[0].estimateItemId,41);assert.equal(fixture.read().projectTasks[0].estimateItemId,41);
 const cleared=await patch({estimateItemId:null});assert.equal(cleared.status,200,JSON.stringify(cleared.data));assert.equal(cleared.data.tasks[0].estimateItemId,null);assert.equal(fixture.read().projectTasks[0].estimateItemId,null);
 const before=canonicalHash(fixture.read().projectTasks);const foreign=await patch({estimateItemId:42});assert.equal(foreign.status,400);assert.equal(canonicalHash(fixture.read().projectTasks),before);
 console.log(JSON.stringify({passed:true,checks:8,requests:3,syntheticTransport:true,testInstallerUsed:false,externalCalls:0}));
}
main().then(()=>fixture.server.close()).catch(error=>{console.error(error);fixture.server.close();process.exitCode=1;});
