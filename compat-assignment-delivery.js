'use strict';
// Assignment email has its own immutable source/recipient contract. Staging is
// part of the reviewed assignment save; every fake attempt follows native CAS.
const crypto=require('node:crypto');
const {canonicalHash}=require('./database/transactional-repository');
const {validateAccounts}=require('./account-evidence');
const {validateWorkspace}=require('./compat-workspace-evidence');
const {actorBinding}=require('./compat-workspace-delivery');
const access=require('./scheduling-access');
const jobs='workspaceAssignmentJobs',purpose='assignment-email-v1';
const fail=()=>{throw Object.assign(Error('Assignment delivery needs reconciliation.'),{statusCode:409});};
const closed=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&Object.keys(v).every(k=>keys.includes(k));
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
function descriptor(db,user,ids) {
  const assignments=ids.map(id=>(db.assignments||[]).filter(r=>r.id===id));if(assignments.some(rows=>rows.length!==1))fail();
  const rows=assignments.map(rows=>rows[0]),project=(db.projects||[]).find(p=>p.id===rows[0]?.projectId);
  if(!project||rows.some(row=>row.projectId!==project.id||!row.memberIds.includes(user.memberId)))fail();
  return {companyId:db.company.id,companyName:db.company.name,recipientId:user.id,memberId:user.memberId,to:user.email,name:user.name,projectId:project.id,projectName:project.name,assignments:rows.map(row=>({id:row.id,projectId:row.projectId,memberIds:row.memberIds,date:row.date,start:row.start,end:row.end,activity:row.activity}))};
}
function validateSource(source,companyId) {
  if(!closed(source,['companyId','companyName','recipientId','memberId','to','name','projectId','projectName','assignments'])||source.companyId!==companyId||![source.recipientId,source.memberId,source.projectId].every(v=>Number.isSafeInteger(v)&&v>0)||![source.companyName,source.to,source.name,source.projectName].every(v=>typeof v==='string'&&v.length<=500)||!/^\S+@\S+\.\S+$/.test(source.to)||!Array.isArray(source.assignments)||!source.assignments.length||source.assignments.length>91)fail();
  const seen=new Set();for(const row of source.assignments){if(!closed(row,['id','projectId','memberIds','date','start','end','activity'])||!Number.isSafeInteger(row.id)||row.id<1||seen.has(row.id)||row.projectId!==source.projectId||!Array.isArray(row.memberIds)||!row.memberIds.includes(source.memberId)||row.memberIds.some(id=>!Number.isSafeInteger(id)||id<1)||new Set(row.memberIds).size!==row.memberIds.length||!require('./schedule-availability').validDate(row.date)||!require('./schedule-availability').validTime(row.start)||!require('./schedule-availability').validTime(row.end)||row.start>=row.end||typeof row.activity!=='string'||row.activity.length>120)fail();seen.add(row.id);}
}
function createDelivery({repository,companyId,send,authenticateSession,accountAccess,key,clock=Date.now}) {
  if(typeof send!=='function'||typeof authenticateSession!=='function'||!Buffer.isBuffer(key)||key.length!==32)throw Error('Explicit synthetic assignment contracts required.');
  const sign=row=>{const copy={...row};delete copy.proof;row.proof=crypto.createHmac('sha256',key).update(purpose+':'+canonicalHash(copy)).digest('hex');return row;};
  function valid(db) {
    validateAccounts(db);validateWorkspace(db);const rows=db[jobs]===undefined?[]:db[jobs],seen=new Set();if(!Array.isArray(rows)||rows.length>50000||Buffer.byteLength(JSON.stringify(rows))>5000000)fail();
    for(const row of rows){const keys=['id','purpose','companyId','actorId','sessionHash','authority','source','sourceHash','status','createdAt','expiresAt','proof',...(row.attemptId!==undefined?['attemptId']:[]),...(row.finishedAt!==undefined?['finishedAt']:[])];if(!closed(row,keys)||!uuid(row.id)||seen.has(row.id)||row.companyId!==companyId||row.purpose!==purpose||!Number.isSafeInteger(row.actorId)||![row.sessionHash,row.authority,row.sourceHash,row.proof].every(hash)||!['queued','sending','sent','rejected','uncertain','cancelled'].includes(row.status)||!Number.isFinite(Date.parse(row.createdAt))||!Number.isFinite(Date.parse(row.expiresAt))||Date.parse(row.expiresAt)<=Date.parse(row.createdAt)||Date.parse(row.expiresAt)>Date.parse(row.createdAt)+600000||row.attemptId!==undefined&&!uuid(row.attemptId)||['sending','sent','rejected','uncertain'].includes(row.status)&&!row.attemptId||row.finishedAt!==undefined&&!Number.isFinite(Date.parse(row.finishedAt)))fail();const copy={...row};delete copy.proof;if(row.proof!==crypto.createHmac('sha256',key).update(purpose+':'+canonicalHash(copy)).digest('hex'))fail();validateSource(row.source,companyId);if(canonicalHash(row.source)!==row.sourceHash)fail();seen.add(row.id);}
    return rows;
  }
  function current(db,job){valid(db);const auth=authenticateSession(db,job.sessionHash),users=db.users.filter(u=>u.id===job.source.recipientId&&u.status==='Active');if(users.length!==1)return null;let source;try{source=descriptor(db,users[0],job.source.assignments.map(r=>r.id));}catch{return null;}
    return auth&&auth.companyId===companyId&&auth.user.id===job.actorId&&Date.parse(auth.session.expiresAt)>clock()&&Date.parse(job.expiresAt)>clock()&&actorBinding(db,auth)===job.authority&&!accountAccess(db.company).locked&&access.access(db,auth.user).create&&job.source.assignments.every(row=>access.inScope(db,auth.user,row,'create'))&&canonicalHash(source)===job.sourceHash?auth:null;
  }
  function stage(db,req,ids){const ledger=valid(db),at=clock(),rows=ids.map(id=>db.assignments.find(r=>r.id===id));if(rows.some(r=>!r)||!access.access(db,req.auth.user).create||rows.some(r=>!access.inScope(db,req.auth.user,r,'create')))fail();const memberIds=new Set(rows.flatMap(r=>r.memberIds));
    for(const user of db.users.filter(u=>u.status==='Active'&&memberIds.has(u.memberId)&&u.email)){const source=descriptor(db,user,ids);validateSource(source,companyId);const sourceHash=canonicalHash(source);if(ledger.some(j=>j.sourceHash===sourceHash))continue;ledger.push(sign({id:crypto.randomUUID(),purpose,companyId,actorId:req.auth.user.id,sessionHash:req.auth.session.tokenHash,authority:actorBinding(db,req.auth),source,sourceHash,status:'queued',createdAt:new Date(at).toISOString(),expiresAt:new Date(Math.min(at+600000,Date.parse(req.auth.session.expiresAt))).toISOString()}));for(const row of rows){row.notifications||={};row.notifications[user.memberId]||={};row.notifications[user.memberId].emailStatus='queued';}}
    db[jobs]=ledger;valid(db);return ledger.filter(j=>j.status==='queued'&&ids.includes(j.source.assignments[0].id)).map(j=>j.id);
  }
  async function load(expected){const l=await repository.load(companyId);if(!l||l.contentHash!==canonicalHash(l.snapshot)||expected&&(l.revision!==expected.revision||l.contentHash!==expected.contentHash))fail();valid(l.snapshot);return l;}
  async function commit(db,revision,deadline){const saved=await repository.commit(db,revision,deadline?{deadline}:undefined);if(saved.revision!==revision+1||saved.contentHash!==canonicalHash(db))fail();return saved;}
  async function dispatch(id,expected){let loaded=await load(expected),db=loaded.snapshot,job=valid(db).find(j=>j.id===id);if(!job)fail();if(job.status!=='queued')return {status:job.status==='sending'?'uncertain':job.status,revision:loaded.revision,contentHash:loaded.contentHash};const auth=current(db,job);if(!auth){job.status='cancelled';sign(job);return {status:'cancelled',...await commit(db,loaded.revision)};}
    const deadline=new Date(Math.min(Date.parse(auth.session.expiresAt),Date.parse(job.expiresAt),accountAccess(db.company).status==='Trial'?Date.parse(db.company.trialEndsAt):Infinity)).toISOString();job.status='sending';job.attemptId=crypto.randomUUID();sign(job);const claim=canonicalHash(job),claimed=await commit(db,loaded.revision,deadline);loaded=await load(claimed);db=loaded.snapshot;job=valid(db).find(j=>j.id===id);if(canonicalHash(job)!==claim||!current(db,job))fail();
    let receipt;try{receipt=await send(structuredClone(job.source),{idempotencyKey:job.id});}catch{receipt={status:'unknown'};}const outcome=closed(receipt,['status'])&&['accepted','rejected','unknown'].includes(receipt.status)?receipt.status:'unknown';
    loaded=await load(claimed);db=loaded.snapshot;job=valid(db).find(j=>j.id===id);if(canonicalHash(job)!==claim)fail();job.status=outcome==='accepted'&&current(db,job)?'sent':outcome==='rejected'?'rejected':'uncertain';job.finishedAt=new Date(clock()).toISOString();sign(job);
    if(job.status==='sent'||job.status==='rejected')for(const record of job.source.assignments){const row=db.assignments.find(r=>r.id===record.id);row.notifications||={};row.notifications[job.source.memberId]||={};row.notifications[job.source.memberId].emailStatus=job.status==='sent'?'sent':'failed';}
    return {status:job.status,...await commit(db,loaded.revision,job.status==='sent'?deadline:undefined)};
  }
  return {stage,dispatch,valid};
}
module.exports={createDelivery,descriptor,validateSource,jobs};
