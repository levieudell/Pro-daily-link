'use strict';
const fs=require('node:fs'),path=require('node:path'),verification=require('./backup-verification');
const MAX_BYTES=65536;
const receiptObjectKey=companyId=>String(companyId)+'/_receipt.json';
const plain=value=>Boolean(value)&&typeof value==='object'&&!Array.isArray(value);
const timestamp=(value,now)=>typeof value==='string'&&value.length>0&&value.length<=64&&Number.isFinite(Date.parse(value))&&Date.parse(value)<=now;
function normalize(raw,companyId,now=Date.now()){
  if(!plain(raw)||raw.version!==1||raw.companyId!==String(companyId)||Object.keys(raw).some(k=>!['version','companyId','attempt','verification'].includes(k)))return null;
  let attempt=null,proof=null;
  if(plain(raw.attempt)&&timestamp(raw.attempt.at,now)&&['pending','verified','failed'].includes(raw.attempt.status)&&typeof raw.attempt.id==='string'&&raw.attempt.id.length>0&&raw.attempt.id.length<=128&&Object.keys(raw.attempt).every(k=>['id','at','status','error'].includes(k))){
    attempt={id:raw.attempt.id,at:raw.attempt.at,status:raw.attempt.status};
    if(typeof raw.attempt.error==='string')attempt.error=raw.attempt.error.slice(0,2000);
  }
  const value=raw.verification;
  if(plain(value)&&Object.keys(value).every(k=>['method','verifiedAt','bucket','objectKey','sha256','bytes','sourceRevision'].includes(k))&&value.method==='upload-download-sha256'&&timestamp(value.verifiedAt,now)&&value.bucket==='tenant-backups'&&typeof value.objectKey==='string'&&value.objectKey.length<=512&&value.objectKey.startsWith(String(companyId)+'/')&&!value.objectKey.includes('..')&&/^[a-f0-9]{64}$/.test(value.sha256||'')&&Number.isSafeInteger(value.bytes)&&value.bytes>0&&Number.isSafeInteger(value.sourceRevision)&&value.sourceRevision>=0)proof={method:value.method,verifiedAt:value.verifiedAt,bucket:value.bucket,objectKey:value.objectKey,sha256:value.sha256,bytes:value.bytes,sourceRevision:value.sourceRevision};
  if(raw.verification!=null&&!proof||raw.attempt!=null&&!attempt||!attempt&&!proof)return null;
  return {version:1,companyId:String(companyId),attempt,verification:proof};
}
async function boundedBytes(response){
  const length=Number(response.headers?.get?.('content-length'));if(Number.isFinite(length)&&length>MAX_BYTES)throw Error('Receipt metadata exceeds capacity.');
  if(response.body?.getReader){const reader=response.body.getReader(),parts=[];let size=0;try{while(true){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>MAX_BYTES)throw Error('Receipt metadata exceeds capacity.');parts.push(Buffer.from(part.value));}return Buffer.concat(parts);}finally{await reader.cancel().catch(()=>{});}}
  const bytes=Buffer.from(await response.arrayBuffer());if(bytes.length>MAX_BYTES)throw Error('Receipt metadata exceeds capacity.');return bytes;
}
function create({directory,transport,assertAllowed}){
  if(!directory||!transport||typeof assertAllowed!=='function')throw Error('Receipt metadata requires a fixed current tenant guard.');
  const mirrors=new Map();
  async function restore(companyId){
    if(!transport.configured()||!companyId)return false;
    try{
      await assertAllowed(companyId);
      const file=verification.receiptFile(directory,companyId);if(fs.existsSync(file))return false;
      const response=await transport.download('tenant-backups',receiptObjectKey(companyId)),bytes=await boundedBytes(response),receipt=normalize(JSON.parse(bytes.toString('utf8')),companyId);if(!receipt)return false;
      await assertAllowed(companyId);if(fs.existsSync(file))return false;
      fs.mkdirSync(directory,{recursive:true,mode:0o700});fs.writeFileSync(file,JSON.stringify(receipt),{flag:'wx',mode:0o600});return true;
    }catch{return false;}
  }
  function mirror(companyId){
    if(!transport.configured()||!companyId)return Promise.resolve(false);
    const prior=mirrors.get(String(companyId))||Promise.resolve();
    const work=prior.catch(()=>{}).then(async()=>{try{
      await assertAllowed(companyId);const file=verification.receiptFile(directory,companyId);if(!fs.existsSync(file)||fs.statSync(file).size>MAX_BYTES)return false;
      const receipt=normalize(JSON.parse(fs.readFileSync(file,'utf8')),companyId);if(!receipt)return false;
      await assertAllowed(companyId);
      await transport.upload('tenant-backups',receiptObjectKey(companyId),Buffer.from(JSON.stringify(receipt)),'application/json',true);return true;
    }catch{return false;}});
    mirrors.set(String(companyId),work);work.finally(()=>{if(mirrors.get(String(companyId))===work)mirrors.delete(String(companyId));}).catch(()=>{});return work;
  }
  return {restore,mirror};
}
module.exports={create,normalize,receiptObjectKey,MAX_BYTES};
