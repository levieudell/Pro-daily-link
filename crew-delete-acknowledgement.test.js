'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('app.js','utf8'),handler=source.match(/^\$\('#delete-crew'\)\.onclick=[^\r\n]+/m)?.[0];assert.ok(handler);
async function journey(role,{deleteFailure=false,accountFailure=false}={}){
 const calls=[],messages=[],nodes=new Map();let renders=0,closed=0;
 const node=id=>{if(!nodes.has(id))nodes.set(id,{value:id==='#crew-id'?'7':'',textContent:'',close(){closed++}});return nodes.get(id)};
 const result={crews:[],team:[{id:1,name:'Synthetic worker',crew:'Unassigned'}]};
 const c={$:node,currentUser:{role},crews:[{id:7,name:'Synthetic crew'}],team:[],users:[{id:2,assignedCrews:['Synthetic crew']}],confirm:()=>true,renderTeamDirectory(){renders++},setupScheduleFilters(){},populateReportCrews(){},notify:message=>messages.push(message),api:async(route,options)=>{calls.push({route,method:options?.method||'GET'});if(route==='/api/crews/7'){if(deleteFailure)throw Error('Synthetic delete denied');return result}if(route==='/api/users'){if(accountFailure)throw Error('Synthetic directory refresh unavailable');return [{id:2,assignedCrews:[]}]}throw Error('Unexpected route')}};
 vm.createContext(c);vm.runInContext(handler,c);await node('#delete-crew').onclick();return {c,calls,messages,warning:node('#crew-warning').textContent,renders,closed};
}
(async()=>{
 const admin=await journey('admin');assert.deepEqual(admin.calls,[{route:'/api/crews/7',method:'DELETE'}]);assert.equal(admin.closed,1);assert.equal(admin.warning,'');assert.equal(admin.c.team[0].crew,'Unassigned');assert.deepEqual(admin.messages,['Crew deleted and team members moved to Unassigned']);
 const owner=await journey('owner');assert.deepEqual(owner.calls,[{route:'/api/crews/7',method:'DELETE'},{route:'/api/users',method:'GET'}]);assert.equal(owner.c.users[0].assignedCrews.length,0);assert.equal(owner.warning,'');
 const lostRefresh=await journey('owner',{accountFailure:true});assert.equal(lostRefresh.closed,1);assert.equal(lostRefresh.warning,'','an acknowledged delete must not be shown as a failed mutation');assert.equal(lostRefresh.c.users.length,0,'retire stale account directory after committed scope removal');assert.deepEqual(lostRefresh.messages,['Crew deleted and team members moved to Unassigned','Crew deleted. Reload Team before changing account access.']);
 const denied=await journey('admin',{deleteFailure:true});assert.equal(denied.closed,0);assert.equal(denied.warning,'Synthetic delete denied');assert.equal(denied.messages.length,0);assert.equal(denied.calls.length,1);
 console.log('Crew delete acknowledgement regression passed: Admin finite readback, Owner directory refresh, committed delete with failed refresh, and genuine denial.');
})().catch(error=>{console.error(error);process.exitCode=1});
