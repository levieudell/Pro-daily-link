'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const DAY=86400000,FRESH=129600000,RETRY=60000;
function createWorker({engine,directory,now=()=>Date.now(),runDetached=task=>task()}){
  const inFlight=new Map(),attempts=new Map();
  const file=id=>path.join(directory,crypto.createHash('sha256').update(id).digest('hex')+'.json');
  function read(id){try{const f=file(id),stat=fs.statSync(f);if(!stat.isFile()||stat.size>65536)return null;return engine.validReceipt(JSON.parse(fs.readFileSync(f,'utf8')),id);}catch{return null;}}
  function save(id,result){
    const receipt=engine.receipt(result),current=read(id);
    if(current&&(current.sourceRevision>receipt.sourceRevision||current.sourceRevision===receipt.sourceRevision&&Date.parse(current.capturedAt)>Date.parse(receipt.capturedAt)))return;
    fs.mkdirSync(directory,{recursive:true,mode:0o700});const target=file(id),temp=target+'.'+crypto.randomUUID()+'.tmp';
    try{fs.writeFileSync(temp,JSON.stringify(receipt),{flag:'wx',mode:0o600});fs.renameSync(temp,target);}finally{if(fs.existsSync(temp))fs.unlinkSync(temp);}
  }
  function due(id){const proof=read(id);return !proof||now()-Date.parse(proof.capturedAt)>=DAY;}
  function check(id,{force=false}={}){
    if(!engine.eligible(id))return Promise.reject(Object.assign(Error('Current managed recovery authority required.'),{code:'PDL_MANAGED_BACKUP_AUTHORITY'}));
    if(inFlight.has(id))return inFlight.get(id);
    if(!force&&(!due(id)||now()-(attempts.get(id)?.at||0)<RETRY))return Promise.resolve(null);
    const task=runDetached(async()=>{
      attempts.set(id,{at:now(),status:'pending'});
      try{
        const recovered=await engine.discover(id);if(recovered)save(id,recovered);
        if(!due(id)){attempts.set(id,{at:now(),status:'verified'});return recovered;}
        const result=await engine.capture(id);save(id,result);attempts.set(id,{at:now(),status:'verified'});return result;
      }catch(error){attempts.set(id,{at:now(),status:error.code==='PDL_MANAGED_BACKUP_UNKNOWN'?'unknown':'failed'});throw error;}
    });
    const tracked=Promise.resolve(task).finally(()=>inFlight.delete(id));inFlight.set(id,tracked);return tracked;
  }
  function status(id){const eligible=engine.eligible(id),receipt=eligible?read(id):null,attempt=attempts.get(id);return {scope:'managed-tenant-captured-revision-and-referenced-assets',eligible,lastAttemptAt:attempt?new Date(attempt.at).toISOString():null,lastAttemptStatus:attempt?.status||null,lastVerifiedAt:receipt?.verifiedAt||null,capturedAt:receipt?.capturedAt||null,sourceRevision:receipt?.sourceRevision??null,fresh:Boolean(receipt&&now()-Date.parse(receipt.capturedAt)<FRESH),integrity:receipt?'verified':'not-checked',independentCopy:'not-checked',restore:'not-checked'};}
  return {check,status};
}
module.exports={createWorker};
