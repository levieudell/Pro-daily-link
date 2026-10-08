'use strict';
const crypto=require('node:crypto'),guidance=require('./help-guidance');
const hash=value=>crypto.createHash('sha256').update(String(value)).digest('hex');
const effective=user=>({...user,role:user.role==='office'?'admin':user.role});
function emailTip(db,user,day){const attempted=(db.helpEmailReceipts||[]).filter(row=>row.userId===user.id).map(row=>row.tipId);return guidance.emailPreview(db,{...effective(user),helpGuidance:{...user.helpGuidance,dismissed:[...(user.helpGuidance?.dismissed||[]),...attempted],inApp:true,seenIds:[],shownDay:null,shownTip:null}},day)}
function reserve(db,user,tipId,day){
  user=effective(user);
  if(user.status!=='Active'||!['owner','admin'].includes(user.role)||user.helpGuidance?.emailTips!==true||!user.emailVerifiedAt||!/^\S+@\S+\.\S+$/.test(user.email||'')||user.companyId!=null&&user.companyId!==db.company.id||!guidance.TIPS.some(t=>t.id===tipId&&t.roles.includes(user.role)))return null;
  db.helpEmailReceipts ||= [];
  const key=JSON.stringify([db.company.id,user.id,'help-v1',tipId]),existing=db.helpEmailReceipts.find(row=>row.key===key);if(existing)return {duplicate:true,receipt:existing};
  const preview=emailTip(db,user,day);if(!preview||preview.dedupeKey!==key)return null;
  const mine=db.helpEmailReceipts.filter(row=>row.userId===user.id);
  if(mine.length>=3||mine.some(row=>row.day===day))return null;
  const receipt={key:preview.dedupeKey,companyId:db.company.id,userId:user.id,recipientHash:hash(user.email.toLowerCase()),tipId,day,status:'reserved',at:new Date().toISOString()};db.helpEmailReceipts.push(receipt);
  return {duplicate:false,receipt};
}
function eligible(db,receipt,day){const user=(db.users||[]).find(u=>u.id===receipt.userId),preview=user&&emailTip({...db,helpEmailReceipts:(db.helpEmailReceipts||[]).filter(row=>row.key!==receipt.key)},user,day);return Boolean(user&&user.status==='Active'&&user.emailVerifiedAt&&/^\S+@\S+\.\S+$/.test(user.email||'')&&(user.companyId==null||user.companyId===db.company.id)&&receipt.companyId===db.company.id&&receipt.day===day&&receipt.recipientHash===hash(user.email?.toLowerCase())&&preview?.dedupeKey===receipt.key)}
function recheck(db,receipt,day){const stored=(db.helpEmailReceipts||[]).find(row=>row.key===receipt.key);return eligible(db,receipt,day)&&receipt.status==='reserved'&&stored?.status==='reserved'}
function recordOutcome(db,key,outcome,providerId=null,attemptId=null){const receipt=(db.helpEmailReceipts||[]).find(row=>row.key===key);if(!receipt||!['reserved','sending'].includes(receipt.status)||receipt.status==='sending'&&receipt.attemptId!==attemptId||!['delivered','unknown','cancelled'].includes(outcome)||outcome==='delivered'&&!providerId)throw Error('Invalid email receipt transition');receipt.status=outcome;receipt.providerId=outcome==='delivered'?String(providerId).slice(0,160):null;}
function tokenFor(db,user,key){if(typeof key!=='string'||key.length<32)throw Error('Unsubscribe signing is unavailable');const value=Buffer.from(JSON.stringify({version:1,purpose:'help-tips-unsubscribe',companyId:db.company.id,userId:user.id,recipientHash:hash(user.email?.toLowerCase())})).toString('base64url');return value+'.'+crypto.createHmac('sha256',key).update(value).digest('base64url')}
function verifyToken(token,key){try{if(typeof key!=='string'||key.length<32||typeof token!=='string'||token.length>1600)throw Error();const [value,signature,...rest]=token.split('.'),expected=crypto.createHmac('sha256',key).update(value).digest(),actual=Buffer.from(signature||'','base64url');if(rest.length||actual.length!==expected.length||!crypto.timingSafeEqual(actual,expected))throw Error();const payload=JSON.parse(Buffer.from(value,'base64url').toString());if(payload.version!==1||payload.purpose!=='help-tips-unsubscribe'||typeof payload.companyId!=='string'||!Number.isSafeInteger(payload.userId)||typeof payload.recipientHash!=='string')throw Error();return payload}catch{return null}}
function unsubscribe(db,payload){if(!payload||payload.companyId!==db.company.id)return false;const user=(db.users||[]).find(row=>row.id===payload.userId&&hash(row.email?.toLowerCase())===payload.recipientHash);if(!user)return false;user.helpGuidance ||= {};user.helpGuidance.emailTips=false;for(const receipt of db.helpEmailReceipts||[])if(receipt.userId===user.id&&receipt.status==='reserved')receipt.status='cancelled';return true}
function headers(url){if(!/^https:\/\//.test(url))throw Error('Use HTTPS unsubscribe URL');return {'List-Unsubscribe':`<${url}>`,'List-Unsubscribe-Post':'List-Unsubscribe=One-Click'}}
// No delivery adapter or scheduler. Mutations must run inside the existing durable tenant queue.
module.exports={emailTip,reserve,eligible,recheck,recordOutcome,tokenFor,verifyToken,unsubscribe,headers};
