'use strict';
const roles=['platform_owner','customer_success','onboarding','support','billing','engineering'];
const fail=()=>{throw Object.assign(Error('Shared platform records need reconciliation.'),{statusCode:503,code:'PDL_PLATFORM_EVIDENCE'});};
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const id=value=>Number.isSafeInteger(value)&&value>0;
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const nonce=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const iso=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
const scalar=value=>value===null||typeof value==='string'||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value);
function collection(p,name,key){const rows=Object.hasOwn(p,name)?p[name]:[];if(!Array.isArray(rows)||rows.length>50000||rows.some(row=>!object(row))||new Set(rows.map(row=>row[key])).size!==rows.length)fail();return rows;}
function validate(p){
 if(!object(p))fail();const users=collection(p,'users','id'),sessions=collection(p,'sessions','tokenHash'),grants=collection(p,'supportGrants','id');
 const attempts=collection(p,'rolesProviderAttempts','id'),operations=new Set();
 for(const row of attempts){
  const keys=['id','operationId','ordinal','kind','digest','status','at','finishedAt','credential'],operation=row.operationId+':'+row.ordinal;
  if(Object.keys(row).some(name=>!keys.includes(name))||!nonce(row.id)||!nonce(row.operationId)||!Number.isSafeInteger(row.ordinal)||row.ordinal<1||!['email','ai','stripe-write'].includes(row.kind)||!hash(row.digest)||!['unknown','accepted','rejected'].includes(row.status)||!iso(row.at)||operations.has(operation)||row.status==='unknown'&&Object.hasOwn(row,'finishedAt')||row.status!=='unknown'&&(!iso(row.finishedAt)||Date.parse(row.finishedAt)<Date.parse(row.at)))fail();
  if(Object.hasOwn(row,'credential')){const c=row.credential;if(row.kind!=='email'||!object(c)||Object.keys(c).sort().join(',')!=='purpose,tokenHash,userId'||!['password-reset','email-verification'].includes(c.purpose)||!id(c.userId)||!hash(c.tokenHash))fail();}
  operations.add(operation);
 }
 if(Object.hasOwn(p,'notes')&&!Array.isArray(p.notes)||users.some(row=>!id(row.id)||!roles.includes(row.role)||!['Active','Inactive','Deactivated'].includes(row.status)||typeof row.name!=='string'||row.name.length>500||typeof row.email!=='string'||row.email.length>320||!/^\S+@\S+\.\S+$/.test(row.email)||Object.values(row).some(value=>!scalar(value))))fail();
 const userIds=new Set(users.map(row=>row.id));if(new Set(users.map(row=>row.email.trim().toLowerCase())).size!==users.length)fail();
 for(const row of users){if(row.mustSetPassword!==undefined&&typeof row.mustSetPassword!=='boolean')fail();for(const key of ['setupExpiresAt','resetExpiresAt','createdAt','resetRequestedAt'])if(row[key]!==undefined&&!iso(row[key]))fail();for(const key of ['resetTokenHash'])if(row[key]!==undefined&&!hash(row[key]))fail();}
 if(sessions.some(row=>!uuid(row.id)||!id(row.userId)||!userIds.has(row.userId)||!hash(row.tokenHash)||!iso(row.expiresAt)||row.createdAt!==undefined&&!iso(row.createdAt)||Object.values(row).some(value=>!scalar(value)))||new Set(sessions.map(row=>row.id)).size!==sessions.length)fail();
 if(grants.some(row=>!uuid(row.id)||!uuid(row.companyId)||!id(row.actorUserId)||!userIds.has(row.actorUserId)||!hash(row.tokenHash)||!iso(row.expiresAt)||!['Active','Revoked','Expired'].includes(row.status)||['actorName','reason','companyName'].some(key=>typeof row[key]!=='string'||row[key].length>10000)||Object.values(row).some(value=>!scalar(value)))||new Set(grants.map(row=>row.tokenHash)).size!==grants.length)fail();
 return p;
}
function staff(row){return Object.fromEntries(['id','name','email','role','status','mustSetPassword','setupExpiresAt','createdAt'].filter(key=>row[key]!==undefined).map(key=>[key,row[key]]));}
function audit(row){const keys=['id','action','actorName','reason','companyId','at','actorUserId','grantId'];if(!object(row)||keys.some(key=>row[key]!==undefined&&!scalar(row[key])))fail();return Object.fromEntries(keys.filter(key=>row[key]!==undefined).map(key=>[key,row[key]]));}
module.exports={validate,staff,audit};
