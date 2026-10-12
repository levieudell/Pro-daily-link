'use strict';
const {canonicalHash}=require('./database/transactional-repository'),schedule=require('./scheduling-access');
const same=(a,b)=>canonicalHash(a??null)===canonicalHash(b??null);
const fail=()=>{throw Object.assign(Error('Current scheduling consequences exceed their admitted scope.'),{statusCode:403});};
function validate(before,after,user,url,operation){
 const {action,id,input}=operation;
 if(!schedule.access(before,user)[action])fail();
 const untouched=db=>{const value={...db};delete value.assignments;return value;};if(!same(untouched(before),untouched(after)))fail();
 const old=before.assignments||[],next=after.assignments||[],original=id==null?null:old.find(row=>row.id===id);
 if(id!=null&&(!original||!schedule.inScope(before,user,original,action)))fail();
 if(action==='acknowledge'){
   const expected=structuredClone(before),row=expected.assignments.find(row=>row.id===id),current=next.find(row=>row.id===id),ack=current?.acknowledgements?.[user.memberId];
   if(!ack||ack.status!=='acknowledged'||ack.by!==user.name||!Number.isFinite(Date.parse(ack.at))||Object.keys(ack).some(key=>!['status','at','by'].includes(key)))fail();
   row.acknowledgements={...row.acknowledgements,[user.memberId]:ack};if(!same(expected,after))fail();return;
 }
 if(action==='remove'){
   const expected=structuredClone(before),member=Number(url.searchParams.get('memberId'));
   expected.assignments=expected.assignments.flatMap(row=>{if(row.id!==id)return [row];if(!member)return [];const remaining=row.memberIds.filter(value=>value!==member);return remaining.length?[{...row,memberIds:remaining}]:[];});if(!same(expected,after))fail();return;
 }
 for(const row of old){const current=next.find(value=>value.id===row.id);if(same(row,current))continue;if(action==='create'||row.id!==id||!current||!schedule.inScope(after,user,current,'edit'))fail();}
 for(const row of next){const prior=old.find(value=>value.id===row.id);if(same(prior,row))continue;const consequence=prior?'edit':'create';if(!schedule.access(before,user)[consequence]||!schedule.inScope(after,user,row,consequence))fail();if(!prior&&(row.projectId!==Number(input.projectId??original?.projectId)||row.memberIds.some(value=>!(input.edit===true||action==='create'?input.memberIds:[input.targetMemberId]).includes(value))))fail();}
}
module.exports={validate};
