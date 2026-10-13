'use strict';
const crypto=require('node:crypto');
const {AsyncLocalStorage}=require('node:async_hooks');
const {canonicalHash}=require('./transactional-repository');
const {uuid}=require('./roles-snapshot-repository');
const {collect}=require('./managed-backup-assets');
const BUCKET='tenant-backups',PART_RAW=6000000,PART_MAX=8100000,META_MAX=4000000,SNAPSHOT_MAX=160000000,TOTAL_MAX=256000000;
const DEADLINE_MS=300000;
const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const integer=(n,max)=>Number.isSafeInteger(n)&&n>=0&&n<=max;
const iso=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
const equal=(a,b)=>canonicalHash(a)===canonicalHash(b);
const keys=(v,names)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===names.split(',').sort().join(',');
function fail(code='PDL_MANAGED_BACKUP_INVALID'){throw Object.assign(Error('The original managed recovery set needs review.'),{code});}
function createEngine({key,repository,storage,admission,allowed,validate=require('../roles-production-evidence').validate,now=()=>Date.now()}){
  if(!Buffer.isBuffer(key)||key.length!==32||typeof allowed!=='function'||!admission||typeof admission.admit!=='function'||typeof admission.get!=='function'||typeof admission.list!=='function')fail();
  const signingKey=crypto.createHmac('sha256',key).update('pdl-managed-backup-signing-v1').digest();
  const keyId=crypto.createHmac('sha256',signingKey).update('key-id').digest('hex').slice(0,16);
  const operation=new AsyncLocalStorage();
  function remaining(){const deadline=operation.getStore();if(!Number.isFinite(deadline)||deadline<=now())fail('PDL_MANAGED_BACKUP_DEADLINE');return deadline-now();}
  async function bounded(task){const budget=Math.min(30000,remaining());let timer;try{return await Promise.race([Promise.resolve().then(task),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Object.assign(Error('Original managed backup deadline expired.'),{code:'PDL_MANAGED_BACKUP_DEADLINE'})),budget);})]);}finally{clearTimeout(timer);}}
  const run=task=>operation.run(now()+DEADLINE_MS,task);
  const proof=(purpose,value)=>crypto.createHmac('sha256',signingKey).update(purpose+':'+canonicalHash(value)).digest('hex');
  const sign=(purpose,value)=>({...value,proof:proof(purpose,value)});
  function evidence(snapshot){
    validate(snapshot);
    for(const [,,prefix,,controller]of require('../capability-registry').families)if(controller.required(snapshot))controller.validatePolicy(snapshot.company[prefix+'RolePolicy']);
    if(require('../role-profiles').required(snapshot))require('../role-profiles').read(snapshot);
    require('../role-policy-api').ledger(snapshot,key);
  }
  async function privateBucket(){
    const bucket=await bounded(()=>storage.bucket());
    if(bucket?.id!==BUCKET||bucket.public!==false||!Number.isSafeInteger(bucket.file_size_limit)||bucket.file_size_limit<PART_MAX||!Array.isArray(bucket.allowed_mime_types)||!bucket.allowed_mime_types.includes('application/json'))fail('PDL_MANAGED_BACKUP_STORAGE');
  }
  function authenticate(purpose,value){
    if(!value||!hash(value.proof))fail();const unsigned={...value};delete unsigned.proof;
    if(value.keyId!==keyId||!crypto.timingSafeEqual(Buffer.from(value.proof,'hex'),Buffer.from(proof(purpose,unsigned),'hex')))fail();return unsigned;
  }
  async function authority(companyId,source){
    if(!uuid(companyId)||!allowed(companyId))fail('PDL_MANAGED_BACKUP_AUTHORITY');
    remaining();const row=await bounded(()=>repository.load(companyId));remaining();
    if(!allowed(companyId)||row?.snapshot?.company?.id!==companyId||!integer(row.revision,Number.MAX_SAFE_INTEGER-1)||!hash(row.contentHash)||canonicalHash(row.snapshot)!==row.contentHash)fail('PDL_MANAGED_BACKUP_AUTHORITY');
    evidence(row.snapshot);
    if(source&&(row.revision<source.sourceRevision||row.revision===source.sourceRevision&&row.contentHash!==source.canonicalSha256))fail('PDL_MANAGED_BACKUP_AUTHORITY');
    return row;
  }
  const root=c=>`${c.companyId}/managed-v1/${c.capturedAt.slice(0,10)}-${c.sourceRevision}-${c.snapshot.sha256}`;
  function baseValid(companyId,base){if(!uuid(companyId)||typeof base!=='string'||!new RegExp('^'+companyId+'/managed-v1/\\d{4}-\\d{2}-\\d{2}-(?:0|[1-9]\\d*)-[a-f0-9]{64}$').test(base))fail();}
  function targetValid(companyId,bucket,path){
    if(bucket!==BUCKET){require('./managed-backup-assets').location(bucket,path,companyId);return;}
    if(typeof path!=='string')fail();const match=/^(.*)\/(?:job\.json|manifest\.json|parts\/[0-9]{6}\.json)$/.exec(path);if(!match)fail();baseValid(companyId,match[1]);
  }
  async function originalJob(companyId,base,source){baseValid(companyId,base);await authority(companyId,source);const value=await bounded(()=>admission.get(companyId,base));await authority(companyId,source);return value;}
  async function read(companyId,bucket,path,max,source){targetValid(companyId,bucket,path);await authority(companyId,source);const bytes=await bounded(()=>storage.read(bucket,path,max));if(!Buffer.isBuffer(bytes)||bytes.length>max)fail();await authority(companyId,source);return bytes;}
  async function json(companyId,path,source){return JSON.parse((await read(companyId,BUCKET,path,META_MAX,source)).toString());}
  function coreValid(c,companyId){
    if(!keys(c,'companyId,sourceRevision,capturedAt,canonicalSha256,snapshot,objects')||c.companyId!==companyId||!uuid(companyId)||!integer(c.sourceRevision,Number.MAX_SAFE_INTEGER-1)||!iso(c.capturedAt)||Date.parse(c.capturedAt)>now()||!hash(c.canonicalSha256)||!Array.isArray(c.objects)||c.objects.length>2048)fail();
    let total=0,partCount=0;const partKeys=new Set(),locations=new Set();
    const item=(v,max)=>{
      if(!keys(v,'bytes,sha256,parts')||!integer(v.bytes,max)||!v.bytes||!hash(v.sha256)||!Array.isArray(v.parts)||v.parts.length!==Math.ceil(v.bytes/PART_RAW))fail();
      let size=0;for(const [i,p]of v.parts.entries()){
        if(!keys(p,'name,bytes,sha256,encodedBytes,encodedSha256')||p.name!==String(partCount++).padStart(6,'0')+'.json'||partKeys.has(p.name)||!integer(p.bytes,PART_RAW)||!p.bytes||i<v.parts.length-1&&p.bytes!==PART_RAW||!hash(p.sha256)||!integer(p.encodedBytes,PART_MAX)||!p.encodedBytes||!hash(p.encodedSha256))fail();partKeys.add(p.name);size+=p.bytes;
      }if(size!==v.bytes||(total+=size)>TOTAL_MAX)fail();
    };
    item(c.snapshot,SNAPSHOT_MAX);
    let last='';let refs=0;
    for(const object of c.objects){
      if(!keys(object,'reference,contentType,data')||!keys(object.reference,'bucket,key,custodyId,sources')||!Array.isArray(object.reference.sources)||!object.reference.sources.length||object.reference.sources.some(s=>typeof s!=='string'||s.length>180)||new Set(object.reference.sources).size!==object.reference.sources.length||(refs+=object.reference.sources.length)>10000||object.reference.custodyId!==null&&(!uuid(object.reference.custodyId))||!['image/jpeg','image/png','image/webp','application/pdf'].includes(object.contentType))fail();
      require('./managed-backup-assets').location(object.reference.bucket,object.reference.key,companyId);
      const id=object.reference.bucket+'/'+object.reference.key;if(locations.has(id)||last&&last.localeCompare(id)>=0)fail();locations.add(id);last=id;item(object.data,15000000);
    }
    return c;
  }
  function jobValid(value,companyId){
    const job=authenticate('job',value);
    if(!keys(job,'format,keyId,writerNonce,core')||job.format!=='pdl-managed-backup-job-v1'||!uuid(job.writerNonce))fail();coreValid(job.core,companyId);return job;
  }
  function manifestValid(value,job,companyId){
    const manifest=authenticate('manifest',value);
    if(!keys(manifest,'format,keyId,writerNonce,core,sealedAt')||manifest.format!=='pdl-managed-backup-manifest-v1'||manifest.writerNonce!==job.writerNonce||!equal(manifest.core,job.core)||!iso(manifest.sealedAt)||Date.parse(manifest.sealedAt)<Date.parse(job.core.capturedAt)||Date.parse(manifest.sealedAt)>Date.parse(job.core.capturedAt)+DEADLINE_MS||Date.parse(manifest.sealedAt)>now())fail();coreValid(manifest.core,companyId);return manifest;
  }
  async function assemble(companyId,base,item,source){
    const chunks=[];
    for(const p of item.parts){
      const encoded=await read(companyId,BUCKET,base+'/parts/'+p.name,PART_MAX,source);
      if(encoded.length!==p.encodedBytes||digest(encoded)!==p.encodedSha256)fail();
      const part=JSON.parse(encoded.toString());if(!keys(part,'format,bytes,sha256,data')||part.format!=='pdl-managed-backup-part-v1'||part.bytes!==p.bytes||part.sha256!==p.sha256||typeof part.data!=='string')fail();
      const decoded=Buffer.from(part.data,'base64');if(decoded.toString('base64')!==part.data||decoded.length!==p.bytes||digest(decoded)!==p.sha256)fail();chunks.push(decoded);
    }
    const raw=Buffer.concat(chunks);if(raw.length!==item.bytes||digest(raw)!==item.sha256)fail();return raw;
  }
  async function verify(companyId,base){
    baseValid(companyId,base);
    await authority(companyId);
    await privateBucket();await authority(companyId);
    const original=jobValid(await originalJob(companyId,base),companyId);
    const job=jobValid(await json(companyId,base+'/job.json'),companyId);
    if(!equal(original,job))fail();
    if(base!==root(job.core))fail();
    const manifest=manifestValid(await json(companyId,base+'/manifest.json',job.core),job,companyId),c=job.core;
    const snapshotBytes=await assemble(companyId,base,c.snapshot,c),snapshot=JSON.parse(snapshotBytes.toString());
    if(snapshot?.company?.id!==companyId||canonicalHash(snapshot)!==c.canonicalSha256)fail();evidence(snapshot);
    const references=collect(snapshot,key);if(!equal(references,c.objects.map(o=>o.reference)))fail();
    const custody=require('../resource-assets').createCustody({key}).valid(snapshot),objects=[];
    for(const object of c.objects){
      const raw=await assemble(companyId,base,object.data,c);
      if(object.reference.custodyId){const stored=custody.find(r=>r.id===object.reference.custodyId);if(!stored||stored.type!==object.contentType||stored.sha256!==digest(raw)||stored.bytes!==raw.toString('base64'))fail();}
      objects.push({reference:object.reference,contentType:object.contentType,bytes:raw});
    }
    await privateBucket();await authority(companyId,c);
    return {snapshot,objects,manifest,base}; // Private verification only; no restore/writeback.
  }
  async function immutable(companyId,path,body,source){
    targetValid(companyId,BUCKET,path);
    await authority(companyId,source);await privateBucket();await authority(companyId,source);
    try{await bounded(()=>storage.write(path,body));}catch{
      // Unknown ACK/duplicate: only exact original-byte readback establishes acceptance.
      try{const existing=await read(companyId,BUCKET,path,Math.max(body.length,META_MAX),source);if(existing.equals(body))return;}catch{}
      fail('PDL_MANAGED_BACKUP_UNKNOWN');
    }
    const restored=await read(companyId,BUCKET,path,Math.max(body.length,META_MAX),source);
    if(!restored.equals(body))fail('PDL_MANAGED_BACKUP_UNKNOWN');
  }
  async function capture(companyId){
    const capturedAt=new Date(now()).toISOString(),row=await authority(companyId),snapshot=structuredClone(row.snapshot),snapshotBytes=Buffer.from(JSON.stringify(snapshot));
    if(!snapshotBytes.length||snapshotBytes.length>SNAPSHOT_MAX)fail('PDL_MANAGED_BACKUP_CAPACITY');
    const source={sourceRevision:row.revision,canonicalSha256:row.contentHash};
    const expectedBase=root({companyId,...source,capturedAt,snapshot:{sha256:digest(snapshotBytes)}});
    const pending=await originalJob(companyId,expectedBase,source);
    if(pending!==null){const original=jobValid(pending,companyId);if(root(original.core)!==expectedBase)fail();try{return await verify(companyId,expectedBase);}catch(error){if(error.code==='PDL_MANAGED_BACKUP_AUTHORITY')throw error;fail('PDL_MANAGED_BACKUP_UNKNOWN');}}
    const references=collect(snapshot,key),custody=require('../resource-assets').createCustody({key}).valid(snapshot),objects=[],parts=[];
    let total=snapshotBytes.length;
    const describe=raw=>{
      const item={bytes:raw.length,sha256:digest(raw),parts:[]};
      for(let offset=0;offset<raw.length;offset+=PART_RAW){
        remaining();
        const bytes=raw.subarray(offset,offset+PART_RAW),body=Buffer.from(JSON.stringify({format:'pdl-managed-backup-part-v1',bytes:bytes.length,sha256:digest(bytes),data:bytes.toString('base64')}));
        if(body.length>PART_MAX)fail('PDL_MANAGED_BACKUP_CAPACITY');
        const name=String(parts.length).padStart(6,'0')+'.json';item.parts.push({name,bytes:bytes.length,sha256:digest(bytes),encodedBytes:body.length,encodedSha256:digest(body)});parts.push({name,body});
      }return item;
    };
    const snapshotDescription=describe(snapshotBytes);
    for(const reference of references){
      const stored=reference.custodyId?custody.find(r=>r.id===reference.custodyId):null;
      const raw=stored?Buffer.from(stored.bytes,'base64'):await read(companyId,reference.bucket,reference.key,15000000,source);
      if(!raw.length||raw.length>15000000||(total+=raw.length)>TOTAL_MAX)fail('PDL_MANAGED_BACKUP_CAPACITY');
      const ext=reference.key.split('.').pop().toLowerCase(),contentType=stored?.type||({jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',webp:'image/webp',pdf:'application/pdf'})[ext];
      if(!contentType)fail('PDL_MANAGED_BACKUP_ASSETS');objects.push({reference,contentType,data:describe(raw)});
    }
    const c={companyId,...source,capturedAt,snapshot:snapshotDescription,objects};coreValid(c,companyId);
    const base=root(c),writerNonce=crypto.randomUUID(),job=sign('job',{format:'pdl-managed-backup-job-v1',keyId,writerNonce,core:c}),jobBytes=Buffer.from(JSON.stringify(job));
    if(jobBytes.length>META_MAX)fail('PDL_MANAGED_BACKUP_CAPACITY');
    await privateBucket();await authority(companyId,source);
    // Never take over an original job: even a lost initial acknowledgement is
    // reconciled under its original nonce, not a new key or duplicate upload.
    await authority(companyId,source);
    const retained=await originalJob(companyId,base,source);
    let original=retained===null?null:jobValid(retained,companyId);
    if(original){if(root(original.core)!==base)fail();try{return await verify(companyId,base);}catch(error){if(error.code==='PDL_MANAGED_BACKUP_AUTHORITY')throw error;fail('PDL_MANAGED_BACKUP_UNKNOWN');}}
    // Durable SQL admission is first: the unique original exists independently
    // of the first provider ACK. Other workers only reconcile its sealed set.
    await authority(companyId,source);
    let admitted;
    try{admitted=await bounded(()=>admission.admit(companyId,base,job));}catch{
      try{admitted=await originalJob(companyId,base,source);}catch{}
      if(!admitted)fail('PDL_MANAGED_BACKUP_UNKNOWN');
    }
    original=jobValid(admitted,companyId);if(root(original.core)!==base)fail();
    if(original.writerNonce!==writerNonce){try{return await verify(companyId,base);}catch{fail('PDL_MANAGED_BACKUP_UNKNOWN');}}
    if(!equal(original,jobValid(job,companyId)))fail();await authority(companyId,source);
    await immutable(companyId,base+'/job.json',jobBytes,source);
    for(const part of parts)await immutable(companyId,base+'/parts/'+part.name,part.body,source);
    // Original physical files must still match; deletion/mutation before seal
    // fails completeness. Subsequent deletions do not invalidate this historical copy.
    for(const object of objects)if(!object.reference.custodyId){const r=object.reference,raw=await read(companyId,r.bucket,r.key,15000000,source);if(raw.length!==object.data.bytes||digest(raw)!==object.data.sha256)fail('PDL_MANAGED_BACKUP_ASSETS');}
    const manifest=sign('manifest',{format:'pdl-managed-backup-manifest-v1',keyId,writerNonce,core:c,sealedAt:new Date(now()).toISOString()}),manifestBytes=Buffer.from(JSON.stringify(manifest));
    if(manifestBytes.length>META_MAX)fail();await immutable(companyId,base+'/manifest.json',manifestBytes,source);
    return verify(companyId,base);
  }
  async function discover(companyId){
    await authority(companyId);const names=await bounded(()=>admission.list(companyId));await authority(companyId);
    if(!Array.isArray(names)||names.length>=3200||new Set(names).size!==names.length)fail();for(const base of names)baseValid(companyId,base);
    const candidates=[];
    for(const base of names){try{const job=jobValid(await originalJob(companyId,base),companyId);if(root(job.core)!==base)fail();candidates.push({base,job});}catch(error){if(['PDL_MANAGED_BACKUP_AUTHORITY','PDL_MANAGED_BACKUP_DEADLINE'].includes(error.code))throw error;/* An incomplete/corrupt job never establishes proof. */}}
    candidates.sort((a,b)=>b.job.core.sourceRevision-a.job.core.sourceRevision||Date.parse(b.job.core.capturedAt)-Date.parse(a.job.core.capturedAt));
    for(const candidate of candidates)try{return await verify(companyId,candidate.base);}catch(error){if(['PDL_MANAGED_BACKUP_AUTHORITY','PDL_MANAGED_BACKUP_DEADLINE'].includes(error.code))throw error;}
    return null;
  }
  function receipt(result){return sign('receipt',{format:'pdl-managed-backup-receipt-v1',keyId,companyId:result.manifest.core.companyId,sourceRevision:result.manifest.core.sourceRevision,base:result.base,capturedAt:result.manifest.core.capturedAt,sealedAt:result.manifest.sealedAt,verifiedAt:new Date(now()).toISOString(),manifestHash:canonicalHash(result.manifest)});}
  function validReceipt(value,companyId){const r=authenticate('receipt',value);if(!keys(r,'format,keyId,companyId,sourceRevision,base,capturedAt,sealedAt,verifiedAt,manifestHash')||r.format!=='pdl-managed-backup-receipt-v1'||r.companyId!==companyId||!integer(r.sourceRevision,Number.MAX_SAFE_INTEGER-1)||!hash(r.manifestHash)||!iso(r.capturedAt)||!iso(r.sealedAt)||!iso(r.verifiedAt)||Date.parse(r.capturedAt)>Date.parse(r.sealedAt)||Date.parse(r.sealedAt)>Date.parse(r.verifiedAt)||Date.parse(r.verifiedAt)>now()||typeof r.base!=='string'||!r.base.startsWith(companyId+'/managed-v1/'+r.capturedAt.slice(0,10)+'-'+r.sourceRevision+'-')||!new RegExp('^'+companyId+'/managed-v1/\\d{4}-\\d{2}-\\d{2}-(?:0|[1-9]\\d*)-[a-f0-9]{64}$').test(r.base))fail();return r;}
  const eligible=id=>{try{return uuid(id)&&allowed(id)===true;}catch{return false;}};
  return {capture:id=>run(()=>capture(id)),discover:id=>run(()=>discover(id)),verify:(id,base)=>run(()=>verify(id,base)),receipt,validReceipt,eligible};
}
module.exports={createEngine,PART_RAW,PART_MAX,META_MAX,SNAPSHOT_MAX,TOTAL_MAX,DEADLINE_MS,digest};
