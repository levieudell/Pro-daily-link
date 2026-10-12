'use strict';
// Revoke one admitted credential generation. This never marks delivery known,
// creates a credential, sends mail or retries an original provider operation.
const crypto=require('node:crypto');
const {canonicalHash}=require('./database/transactional-repository');
const collection='rolesCredentialInvalidations';
const fields={'password-reset':['resetTokenHash','resetExpiresAt','resetRequestedAt'],'email-verification':['emailVerificationTokenHash','emailVerificationExpiresAt']};
const fail=(statusCode,message)=>{throw Object.assign(Error(message),{statusCode,code:'PDL_CREDENTIAL_INVALIDATION'});};
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const sign=(key,value)=>crypto.createHmac('sha256',key).update(canonicalHash(value)).digest('hex');
function validKey(key){if(!Buffer.isBuffer(key)||key.length!==32)fail(503,'Reviewed signing-key custody is required.');}
function records(db){const rows=Object.hasOwn(db,collection)?db[collection]:[];if(!Array.isArray(rows)||rows.length>10000)fail(409,'Credential recovery records need review.');return rows;}
function attempt(db,id){const rows=(db.rolesProviderAttempts||[]).filter(row=>row.id===id);if(rows.length!==1||rows[0].kind!=='email'||rows[0].status!=='unknown'||!uuid(id))fail(409,'Select the original unknown credential operation.');const row=rows[0],c=row.credential;if(!object(c)||Object.keys(c).some(key=>!['purpose','userId','tokenHash'].includes(key))||!fields[c.purpose]||!Number.isSafeInteger(c.userId)||c.userId<1||!/^[a-f0-9]{64}$/.test(c.tokenHash))fail(409,'The original credential generation lacks evidence. Independently review it before any invalidation.');return row;}
function scope(identity){if(!identity||!['owner','platform_owner'].includes(identity.role)||typeof identity.companyId!=='string'||!Number.isSafeInteger(identity.actorId)||typeof identity.sessionBinding!=='string'||typeof identity.authority!=='string'||!Number.isSafeInteger(identity.revision))fail(403,'Current Owner authority is required.');return Object.fromEntries(['companyId','actorId','role','sessionBinding','authority'].map(name=>[name,identity[name]]));}
function validReceipt(row,key){if(!object(row)||Object.keys(row).some(name=>!['requestId','previewId','proofHash','scope','attemptId','attemptHash','credential','reason','invalidatedAt','signature'].includes(name)))return false;const {signature,...data}=row;return /^[a-f0-9]{64}$/.test(signature||'')&&signature===sign(key,data)&&uuid(row.requestId)&&uuid(row.previewId)&&uuid(row.attemptId);}
function invalidated(db,row,key){validKey(key);const matched=records(db).filter(record=>record.attemptId===row.id);if(matched.length>1||matched.some(record=>!validReceipt(record,key)||record.scope?.companyId!==db.company?.id||row.companyId!=null&&row.companyId!==db.company?.id||!db.users?.some(user=>user.id===row.credential?.userId&&(user.companyId==null||user.companyId===db.company?.id))))fail(409,'Original credential recovery receipt needs review.');return matched.length===1&&matched[0].attemptHash===canonicalHash(row)&&canonicalHash(matched[0].credential)===canonicalHash(row.credential);}
function preview(db,identity,key,{attemptId,reason}){
 validKey(key);const bound=scope(identity),row=attempt(db,attemptId);
 if(invalidated(db,row,key))fail(409,'This original generation is already invalidated.');
 if(typeof reason!=='string'||!reason.trim()||reason.length>500)fail(400,'Provide an invalidation reason of at most 500 characters.');
 const user=db.users?.find(user=>user.id===row.credential.userId);
 if(!user||user.status!=='Active'||user.companyId!=null&&user.companyId!==identity.companyId)fail(409,'Current credential account needs review.');
 const tokenField=fields[row.credential.purpose][0];
 if(user[tokenField]!==undefined&&user[tokenField]!==row.credential.tokenHash)fail(409,'A different credential generation exists. Refresh and review it separately.');
 const data={version:1,previewId:crypto.randomUUID(),scope:bound,revision:identity.revision,snapshotHash:canonicalHash(db),attemptId,attemptHash:canonicalHash(row),credential:row.credential,reason:reason.trim(),expiresAt:new Date(Math.min(Date.now()+600000,Date.parse(identity.expiresAt))).toISOString()};
 const proof=Buffer.from(JSON.stringify(data)).toString('base64url')+'.'+sign(key,data);
 return {previewId:data.previewId,proof,expiresAt:data.expiresAt,expectedRevision:data.revision,accountId:user.id,purpose:row.credential.purpose,operationId:row.operationId,linkPresent:user[tokenField]!==undefined,consequence:'Invalidate this exact link generation. Its delivery remains unknown. A later request requires a new generation and new provider admission.'};
}
function confirm(db,identity,key,input){
 validKey(key);const current=scope(identity);
 if(!object(input)||Object.keys(input).some(name=>!['proof','requestId','confirmed'].includes(name))||input.confirmed!==true||!uuid(input.requestId)||typeof input.proof!=='string'||input.proof.length>6000)fail(400,'Explicit confirmation of the original preview is required.');
 const [encoded,signature,...extra]=input.proof.split('.');let proof;try{proof=JSON.parse(Buffer.from(encoded,'base64url').toString('utf8'));}catch{fail(400,'Invalid credential preview.');}
 if(extra.length||!object(proof)||signature!==sign(key,proof)||proof.version!==1||!uuid(proof.previewId)||canonicalHash(proof.scope)!==canonicalHash(current))fail(403,'This preview belongs to different current authority.');
 const proofHash=canonicalHash(input.proof),prior=records(db).filter(row=>row.requestId===input.requestId||row.previewId===proof.previewId);
 if(prior.length){if(prior.length!==1||!validReceipt(prior[0],key)||prior[0].requestId!==input.requestId||prior[0].proofHash!==proofHash)fail(409,'Original invalidation result needs review.');return {snapshot:db,result:{committed:true,replayed:true,requestId:input.requestId,previewId:proof.previewId,attemptId:proof.attemptId,purpose:prior[0].credential.purpose,invalidatedAt:prior[0].invalidatedAt}};}
 if(Date.parse(proof.expiresAt)<=Date.now()||proof.revision!==identity.revision||proof.snapshotHash!==canonicalHash(db))fail(409,'Credential preview expired or current records changed.');
 const row=attempt(db,proof.attemptId);if(canonicalHash(row)!==proof.attemptHash||invalidated(db,row,key))fail(409,'Original operation changed.');
 const next=structuredClone(db),user=next.users.find(user=>user.id===row.credential.userId),keys=fields[row.credential.purpose];
 if(!user||user[keys[0]]!==undefined&&user[keys[0]]!==row.credential.tokenHash)fail(409,'A different current credential generation needs review.');
 for(const name of keys)delete user[name];
 const receipt={requestId:input.requestId,previewId:proof.previewId,proofHash,scope:current,attemptId:row.id,attemptHash:proof.attemptHash,credential:row.credential,reason:proof.reason,invalidatedAt:new Date().toISOString()};receipt.signature=sign(key,receipt);
 next[collection]=[...records(next),receipt];
 return {snapshot:next,result:{committed:true,replayed:false,requestId:input.requestId,previewId:proof.previewId,attemptId:row.id,purpose:row.credential.purpose,invalidatedAt:receipt.invalidatedAt}};
}
function validateDelta(before,after,proof){if(canonicalHash(after)!==canonicalHash(proof.snapshot))fail(409,'Credential invalidation changes only its signed exact generation.');const old=structuredClone(proof.snapshot);const receipt=old[collection].at(-1);old[collection]=old[collection].slice(0,-1);if(!Object.hasOwn(before,collection))delete old[collection];const user=old.users.find(row=>row.id===receipt.credential.userId),prior=before.users.find(row=>row.id===user.id);for(const name of fields[receipt.credential.purpose])if(Object.hasOwn(prior,name))user[name]=prior[name];if(canonicalHash(before)!==canonicalHash(old))fail(409,'Credential invalidation crossed its exact scope.');}
module.exports={collection,fields,preview,confirm,invalidated,validateDelta};
