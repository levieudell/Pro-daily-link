'use strict';
// Synthetic integration harness only. Never connected to server routes, cron or a real provider.
const crypto=require('node:crypto'),email=require('./help-email');
const conflict=error=>error?.code==='PDL_REVISION_CONFLICT'||/PDL_REVISION_CONFLICT|40001/.test(String(error?.message));
function createFakeEmailIntegration({store,provider,enabled=()=>false,now=()=>new Date(),unsubscribeKey,unsubscribeBase='https://example.invalid/api/help-unsubscribe'}){
  if(!store?.load||!store?.save)throw Error('A durable compare-and-swap store is required');
  function day(db){const parts=new Intl.DateTimeFormat('en-US',{timeZone:db.company.timezone||'UTC',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now()),part=type=>parts.find(p=>p.type===type).value;return `${part('year')}-${part('month')}-${part('day')}`}
  const valid=(loaded,companyId)=>loaded?.snapshot?.company?.id===companyId&&Number.isSafeInteger(loaded.revision)&&loaded.revision>=0;
  async function reserve(companyId,userId,tipId){
    for(let tries=0;tries<3;tries++){
      const loaded=await store.load(companyId);if(!valid(loaded,companyId))return {status:'unavailable'};
      const db=loaded.snapshot,user=(db.users||[]).find(row=>row.id===userId);if(!user)return {status:'ineligible'};
      const result=email.reserve(db,user,tipId,day(db));if(!result)return {status:'ineligible'};
      if(result.duplicate)return {status:'duplicate',key:result.receipt.key};
      try{await store.save(db,loaded.revision);return {status:'reserved',key:result.receipt.key}}catch(error){if(!conflict(error))throw error}
    }
    return {status:'conflict'};
  }
  async function settle(companyId,key,attemptId,outcome,providerId){
    for(let tries=0;tries<3;tries++){
      const loaded=await store.load(companyId),receipt=loaded?.snapshot?.helpEmailReceipts?.find(row=>row.key===key);
      if(!valid(loaded,companyId)||!receipt||receipt.status!=='sending'||receipt.attemptId!==attemptId)return false;
      email.recordOutcome(loaded.snapshot,key,outcome,providerId,attemptId);
      try{await store.save(loaded.snapshot,loaded.revision);return true}catch(error){if(!conflict(error))return false}
    }
    return false;
  }
  async function attempt(companyId,key){
    if(!enabled())return {status:'disabled'};
    if(provider?.isFake!==true||typeof provider.send!=='function')throw Error('Only a declared fake provider is allowed');
    const loaded=await store.load(companyId),db=loaded?.snapshot,receipt=db?.helpEmailReceipts?.find(row=>row.key===key);
    if(!valid(loaded,companyId)||!receipt)return {status:'unavailable'};
    if(!email.recheck(db,receipt,day(db)))return {status:receipt.status==='reserved'?'ineligible':'already-attempted'};
    const user=db.users.find(row=>row.id===receipt.userId);
    if(!/^[^\s@]+@example\.invalid$/i.test(user.email))throw Error('Only synthetic example.invalid recipients are allowed');
    const token=email.tokenFor(db,user,unsubscribeKey),unsubscribeUrl=unsubscribeBase+'?token='+encodeURIComponent(token);
    const header=email.headers(unsubscribeUrl);
    const attemptId=crypto.randomUUID();receipt.status='sending';receipt.attemptId=attemptId;receipt.attemptedAt=now().toISOString();
    // Exclusive CAS claim before any external side effect. No lease expiry/takeover: crashes remain blocked.
    try{await store.save(db,loaded.revision)}catch(error){if(conflict(error))return {status:'conflict'};throw error}
    let current,claimed;
    try{current=await store.load(companyId);claimed=current?.snapshot?.helpEmailReceipts?.find(row=>row.key===key)}catch{return {status:'unknown',providerCalled:false}}
    if(!valid(current,companyId)||!claimed||claimed.status!=='sending'||claimed.attemptId!==attemptId||!email.eligible(current.snapshot,claimed,day(current.snapshot))){
      const recorded=await settle(companyId,key,attemptId,'cancelled');return {status:recorded?'cancelled':'unknown',providerCalled:false};
    }
    const freshUser=current.snapshot.users.find(row=>row.id===claimed.userId);
    if(!/^[^\s@]+@example\.invalid$/i.test(freshUser.email))return {status:'unknown',providerCalled:false};
    const preview=email.emailTip({...current.snapshot,helpEmailReceipts:current.snapshot.helpEmailReceipts.filter(row=>row.key!==key)},freshUser,day(current.snapshot));
    let outcome='unknown',providerId=null;
    try{const response=await provider.send({to:freshUser.email,subject:preview.subject,body:preview.body,headers:header,idempotencyKey:key});if(typeof response?.id==='string'&&response.id){outcome='delivered';providerId=response.id}}catch{}
    const recorded=await settle(companyId,key,attemptId,outcome,providerId);
    return {status:recorded?outcome:'unknown',providerCalled:true};
  }
  return {reserve,attempt};
}
module.exports={createFakeEmailIntegration};
