'use strict';
// Generated receipt metadata, owned local files and closed fake transport only.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {create,MAX_BYTES}=require('./database/backup-receipt-cloud');
const backup=require('./database/backup-verification');
const id='d1d1d1d1-d1d1-4d1d-8d1d-d1d1d1d1d1d1',other='e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1e1';
const gate=()=>{let release;const promise=new Promise(r=>{release=r});return{promise,release};};
const receipt=(revision=1)=>{const at=new Date(Date.now()-1000).toISOString();return{version:1,companyId:id,attempt:{id:'synthetic-'+revision,at,status:'verified'},verification:{method:'upload-download-sha256',verifiedAt:at,bucket:'tenant-backups',objectKey:id+'/synthetic-'+revision+'.json',sha256:'a'.repeat(64),bytes:42,sourceRevision:revision}};};
async function main(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'pdl-backup-merge-synthetic-'));let checks=0;
  const dir=label=>path.join(root,label),write=(directory,value)=>{fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(backup.receiptFile(directory,id),JSON.stringify(value));};
  const transport={configured:()=>true,download:async()=>({arrayBuffer:async()=>Buffer.from(JSON.stringify(receipt()))}),upload:async()=>{}};
  const allowed=async()=>{};
  const positive=create({directory:dir('positive'),transport,assertAllowed:allowed});assert.equal(await positive.restore(id),true);assert.equal(backup.publicStatus(dir('positive'),id).fresh,true);checks++;
  const delayed=gate(),entered=gate(),raceDir=dir('race'),newer=receipt(2);
  const racing=create({directory:raceDir,assertAllowed:allowed,transport:{...transport,download:async()=>{entered.release();await delayed.promise;return{arrayBuffer:async()=>Buffer.from(JSON.stringify(receipt()))};}}});
  const pending=racing.restore(id);await entered.promise;write(raceDir,newer);const original=fs.readFileSync(backup.receiptFile(raceDir,id));delayed.release();assert.equal(await pending,false);assert.deepEqual(fs.readFileSync(backup.receiptFile(raceDir,id)),original);checks++;
  for(const [label,value] of [['foreign',{...receipt(),companyId:other}],['unknown',{...receipt(),records:[{private:true}]}],['future',{...receipt(),verification:{...receipt().verification,verifiedAt:new Date(Date.now()+60000).toISOString()}}],['bad-hash',{...receipt(),verification:{...receipt().verification,sha256:'bad'}}],['oversize','x'.repeat(MAX_BYTES+1)]]){
    const testDir=dir(label),valueBytes=Buffer.from(typeof value==='string'?value:JSON.stringify(value)),reader=create({directory:testDir,assertAllowed:allowed,transport:{...transport,download:async()=>({arrayBuffer:async()=>valueBytes})}});assert.equal(await reader.restore(id),false);assert.equal(fs.existsSync(backup.receiptFile(testDir,id)),false);checks++;
  }
  for(const field of ['attempt','verification'])for(const value of [0,[receipt().verification.verifiedAt],'2026-01-01'+' '.repeat(65)]){
    const testDir=dir('timestamp-'+field+'-'+checks),invalid=receipt();invalid[field][field==='attempt'?'at':'verifiedAt']=value;
    const reader=create({directory:testDir,assertAllowed:allowed,transport:{...transport,download:async()=>({arrayBuffer:async()=>Buffer.from(JSON.stringify(invalid))})}});
    assert.equal(await reader.restore(id),false);assert.equal(fs.existsSync(backup.receiptFile(testDir,id)),false);checks++;
  }
  let bodyRead=false;const oversized=create({directory:dir('declared-size'),assertAllowed:allowed,transport:{...transport,download:async()=>({headers:{get:()=>String(MAX_BYTES+1)},arrayBuffer:async()=>{bodyRead=true;return Buffer.alloc(0);}})}});assert.equal(await oversized.restore(id),false);assert.equal(bodyRead,false);checks++;
  let managed=false,downloads=0;const revoked=create({directory:dir('revoked'),assertAllowed:async()=>{if(managed)throw Error('Managed');},transport:{...transport,download:async()=>{downloads++;managed=true;return{arrayBuffer:async()=>Buffer.from(JSON.stringify(receipt()))};}}});assert.equal(await revoked.restore(id),false);assert.equal(downloads,1);assert.equal(fs.existsSync(backup.receiptFile(dir('revoked'),id)),false);checks++;
  const mirrorDir=dir('mirror'),uploadEntered=gate(),uploadRelease=gate(),uploaded=[];write(mirrorDir,receipt(1));const serial=create({directory:mirrorDir,assertAllowed:allowed,transport:{...transport,upload:async(bucket,key,bytes,type,upsert)=>{assert.equal(bucket,'tenant-backups');assert.equal(key,id+'/_receipt.json');assert.equal(type,'application/json');assert.equal(upsert,true);uploaded.push(JSON.parse(bytes));if(uploaded.length===1){uploadEntered.release();await uploadRelease.promise;}}}});
  let settled=false;const one=serial.mirror(id).then(v=>{settled=true;return v;});await uploadEntered.promise;assert.equal(settled,false);write(mirrorDir,receipt(2));const two=serial.mirror(id);uploadRelease.release();assert.equal(await one,true);assert.equal(await two,true);assert.deepEqual(uploaded.map(r=>r.verification.sourceRevision),[1,2]);checks++;
  managed=false;let uploads=0;const deniedMirror=create({directory:mirrorDir,assertAllowed:async()=>{if(managed)throw Error('Managed');managed=true;},transport:{...transport,upload:async()=>{uploads++;}}});assert.equal(await deniedMirror.mirror(id),false);assert.equal(uploads,0);checks++;
  // Exercise real server helper/guard/upload wrapper, not only the module.
  const serverRoot=dir('server'),dbFile=path.join(serverRoot,'db.json');fs.mkdirSync(serverRoot,{recursive:true});fs.writeFileSync(dbFile,JSON.stringify({company:{id,name:'Synthetic backup tenant',demo:true,timezone:'UTC',persistence:{revision:1}},projects:[],team:[],assignments:[],workdays:[],timeCards:[],timeOffRequests:[],reports:[],photos:[],auditLog:[],customers:[],users:[{id:1,name:'Synthetic Owner',role:'owner',status:'Active',companyId:id}],sessions:[]}));fs.writeFileSync(path.join(serverRoot,'platform.json'),'{"users":[],"sessions":[]}');
  for(const key of ['PDL_ROLES_COMPANIES','PDL_ROLE_POLICY_KEY','PDL_PLATFORM_COMPANY_ID','OPENAI_API_KEY','RESEND_API_KEY','STRIPE_SECRET_KEY','STRIPE_WEBHOOK_SECRET','SENTRY_DSN'])delete process.env[key];
  Object.assign(process.env,{NODE_ENV:'test',PDL_DB_FILE:dbFile,PDL_PLATFORM_FILE:path.join(serverRoot,'platform.json'),PDL_REQUIRE_AUTH:'1',PDL_SUPABASE_ENABLED:'1',SUPABASE_URL:'https://synthetic.invalid',SUPABASE_SECRET_KEY:'synthetic-only',PDL_TRANSACTIONAL_DB:'off',PDL_WEEKLY_DIGEST:'0'});
  const realFetch=global.fetch;global.fetch=async()=>{throw Error('External provider/network forbidden.');};const supabase=require('./database/supabase');supabase.loadLocalEnv=()=>{};let flags={roles_managed:false,platform_managed:false},reads=0,storageCalls=[];
  supabase.request=async()=>({json:async()=>[{...flags}]});supabase.download=async()=>{reads++;return{arrayBuffer:async()=>Buffer.from(JSON.stringify(receipt()))};};supabase.upload=async(...args)=>{storageCalls.push(args);return{};};let created=0;supabase.createVerifiedBackup=async()=>{created++;throw Error('Should not back up managed state.');};
  try{
    const server=require('./server'),serverDir=path.join(serverRoot,'.backup-verification');await server.restoreBackupReceipt(id);await server.mirrorBackupReceipt(id);assert.equal(storageCalls.length,1);assert.equal(storageCalls[0][4],true);checks++;
    await supabase.upload('photos',id+'/immutable.png',Buffer.from('synthetic'),'image/png');assert.equal(storageCalls.at(-1)[4],false);await assert.rejects(supabase.upload('photos',id+'/immutable.png',Buffer.from('synthetic'),'image/png',true),e=>e.code==='PDL_BACKUP_RECEIPT_TARGET');checks++;
    flags.roles_managed=true;reads=0;storageCalls=[];fs.unlinkSync(backup.receiptFile(serverDir,id));assert.equal(await server.restoreBackupReceipt(id),false);assert.equal(await server.mirrorBackupReceipt(id),false);const skipped=await server.startBackupSelfHeal();assert.equal(skipped.skipped,1);assert.equal(reads,0);assert.equal(storageCalls.length,0);assert.equal(created,0);checks++;
    flags={roles_managed:false,platform_managed:true};assert.equal(await server.restoreBackupReceipt(id),false);assert.equal(reads,0);checks++;
  }finally{global.fetch=realFetch;}
  console.log(JSON.stringify({passed:true,checks,generatedFixturesOnly:true,productionWrites:0,externalCalls:0,managedLegacyBackupsAdmitted:false}));
}
main().catch(e=>{console.error(e);process.exitCode=1;});
