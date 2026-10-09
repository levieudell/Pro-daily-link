'use strict';
// Preconditions for the named legacy repairs. Reconciliation never gets to
// erase foreign/ambiguous evidence to make a projected workspace appear valid.
const crypto=require('node:crypto');
const {validateAccounts}=require('./account-evidence');
const {validateWorkspace}=require('./compat-workspace-evidence');
const {canonicalHash}=require('./database/transactional-repository');
const fail=()=>{throw Object.assign(Error('Workspace repairs require unambiguous source records.'),{statusCode:409});};
function source(db) {validateAccounts(db);validateWorkspace(db);const owners=db.users.filter(u=>u.role==='owner'&&u.status==='Active');if(!owners.length)return db;const owner=owners[0],linked=db.team.filter(r=>Number(r.id)===Number(owner.memberId)),matching=db.team.filter(r=>r.email&&r.email.toLowerCase()===owner.email.toLowerCase());if(linked.length>1||!linked.length&&matching.length>1)fail();const member=linked[0]||matching[0];if(member&&db.users.some(u=>u.id!==owner.id&&Number(u.memberId)===Number(member.id)))fail();if(owners.length!==1&&(!member||member.role!=='Account Owner'||member.crew!=='Office'||Number(owner.memberId)!==Number(member.id)))fail();return db;}
function candidate(before,after,changed) {
  const allowed=new Set(['customers','projects','reports','photos','workdays','timeCards','assignments','projectPlans','projectTickets','subcontractorLinks','changes','auditLog','users','team']);
  if(changed.some(key=>!allowed.has(key)))fail();validateAccounts(after);validateWorkspace(after);
  // Existing credentials, account roles, PM grants/crews and all non-owner
  // member links remain byte-for-byte. Only removed known-test project IDs and
  // the unique owner's member link are legitimate account reconciliation.
  const testIds=new Set((before.customers||[]).filter(r=>String(r.name||'').trim().toLowerCase()==='abc test'&&String(r.contact||'').trim().toLowerCase()==='tester mctest').map(r=>Number(r.id)));
  const removed=new Set((before.projects||[]).filter(r=>testIds.has(Number(r.customerId))&&!after.projects.some(next=>Number(next.id)===Number(r.id))).map(r=>Number(r.id)));
  const owner=before.users.find(u=>u.role==='owner'&&u.status==='Active'),expectedTeam=structuredClone(before.team);let member=owner&&expectedTeam.find(row=>Number(row.id)===Number(owner.memberId));if(owner&&!member)member=expectedTeam.find(row=>row.email&&row.email.toLowerCase()===owner.email.toLowerCase());
  if(owner&&!member){member={id:Math.max(0,...expectedTeam.map(row=>Number(row.id)||0))+1,companyId:before.company.id,name:owner.name,role:'Account Owner',initials:owner.name.split(/\s+/).filter(Boolean).map(part=>part[0]).join('').slice(0,2).toUpperCase(),crew:'Office',hours:0,site:'Not assigned',email:owner.email||'',phone:''};expectedTeam.push(member);}
  if(member){member.role='Account Owner';member.crew='Office';}if(canonicalHash(expectedTeam)!==canonicalHash(after.team))fail();
  for(const user of before.users){const next=after.users.find(r=>r.id===user.id);if(!next)fail();const expected={...user};if(owner&&user.id===owner.id&&Number(owner.memberId)!==Number(member.id))expected.memberId=member.id;if(Array.isArray(expected.projectIds))expected.projectIds=expected.projectIds.filter(id=>!removed.has(Number(id)));if(canonicalHash(expected)!==canonicalHash(next))fail();}
  if(before.users.length!==after.users.length)fail();return after;
}
const collection='workspaceReconciliations',purpose='legacy-workspace-reconciliation-v1';
const allowed=['customers','projects','reports','photos','workdays','timeCards','assignments','projectPlans','projectTickets','subcontractorLinks','changes','auditLog','users','team'];
function createLedger(key,companyId){
  if(!Buffer.isBuffer(key)||key.length!==32)fail();
  const sign=row=>{const copy={...row};delete copy.proof;row.proof=crypto.createHmac('sha256',key).update(purpose+':'+canonicalHash(copy)).digest('hex');return row;};
  function valid(db){const rows=db[collection]===undefined?[]:db[collection],ids=new Set(),fields=['id','purpose','companyId','actorId','sourceRevision','sourceHash','changed','previous','resultHash','at','proof'];
    if(!Array.isArray(rows)||rows.length>10000||Buffer.byteLength(JSON.stringify(rows))>20000000)fail();
    for(const row of rows){if(!row||Array.isArray(row)||Object.keys(row).length!==fields.length||Object.keys(row).some(k=>!fields.includes(k))||typeof row.id!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(row.id)||ids.has(row.id)||row.purpose!==purpose||row.companyId!==companyId||!Number.isSafeInteger(row.actorId)||row.actorId<1||!Number.isSafeInteger(row.sourceRevision)||row.sourceRevision<1||![row.sourceHash,row.resultHash,row.proof].every(v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v))||!Number.isFinite(Date.parse(row.at))||!Array.isArray(row.changed)||!row.changed.length||new Set(row.changed).size!==row.changed.length||row.changed.some(k=>!allowed.includes(k))||!row.previous||Array.isArray(row.previous)||Object.keys(row.previous).sort().join(',')!==[...row.changed].sort().join(','))fail();const copy={...row};delete copy.proof;const proof=sign(copy).proof;if(!crypto.timingSafeEqual(Buffer.from(proof,'hex'),Buffer.from(row.proof,'hex')))fail();ids.add(row.id);}return rows;
  }
  function append(db,before,user,revision,changed){const rows=valid(db);rows.push(sign({id:crypto.randomUUID(),purpose,companyId,actorId:user.id,sourceRevision:revision,sourceHash:canonicalHash(before),changed,previous:Object.fromEntries(changed.map(k=>[k,before[k]??null])),resultHash:canonicalHash(db),at:new Date().toISOString()}));db[collection]=rows;valid(db);}
  return {valid,append};
}
module.exports={source,candidate,createLedger,collection};
