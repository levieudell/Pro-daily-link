'use strict';
// Generated closed storage, shared only by synthetic tests. No network/client credentials.
const crypto=require('node:crypto');
const {canonicalHash}=require('./transactional-repository');
const {workspaceSnapshot}=require('../compat-workspace-fixture');
const {createEngine}=require('./managed-backup');
const key=Buffer.alloc(32,49),sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function fixture(){
  const snapshot=workspaceSnapshot(),id=snapshot.company.id,objects=new Map(),writes=[],jobs=new Map();
  const store=(bucket,name,raw)=>objects.set(bucket+'/'+id+'/'+name,Buffer.from(raw));
  snapshot.company.logo={bucket:'company-logos',objectKey:id+'/logo.png',url:'/api/files/company-logos/'+id+'/logo.png'};store('company-logos','logo.png','synthetic logo');
  snapshot.photos=[{id:1,project:0,storageBucket:'project-photos',storageKey:id+'/photo.png',url:'/api/files/project-photos/'+id+'/photo.png'}];store('project-photos','photo.png','synthetic photo');
  snapshot.projectPlans=[{id:1,projectId:101,storageBucket:'estimate-documents',storageKey:id+'/plan.pdf'}];store('estimate-documents','plan.pdf','%PDF-synthetic plan');
  snapshot.projectTickets=[{id:1,projectId:101,bucket:'project-tickets',objectKey:id+'/ticket.png',deletedAt:'2026-01-01T00:00:00.000Z'}];store('project-tickets','ticket.png','synthetic retained ticket');
  snapshot.estimateImports=[{id:1,filename:'intake.pdf',url:'/api/files/estimate-documents/'+id+'/intake.pdf'}];store('estimate-documents','intake.pdf','%PDF-synthetic intake');
  snapshot.projects[0].estimateProposals=[{id:1,sourceFile:{name:'proposal.pdf',url:'/api/files/estimate-documents/'+id+'/proposal.pdf'}}];store('estimate-documents','proposal.pdf','%PDF-synthetic proposal');
  const state={snapshot,revision:7,allowed:true,beforeRead:null,beforeWrite:null,afterWrite:null,bucket:{id:'tenant-backups',public:false,file_size_limit:25000000,allowed_mime_types:['application/json']}};
  const repository={load:async company=>{if(company!==id)throw Error('Foreign repository read forbidden');return {snapshot:structuredClone(state.snapshot),revision:state.revision,contentHash:canonicalHash(state.snapshot)};}};
  const storage={bucket:async()=>state.bucket,read:async(bucket,name,max)=>{if(state.beforeRead)await state.beforeRead(bucket,name);const bytes=objects.get(bucket+'/'+name);if(!bytes)throw Error('Supabase request failed (404): generated missing');if(bytes.length>max)throw Error('Synthetic read capacity');return Buffer.from(bytes);},write:async(name,body)=>{if(state.beforeWrite)await state.beforeWrite(name,body);writes.push(name);if(objects.has('tenant-backups/'+name))throw Error('Supabase request failed (409): immutable');objects.set('tenant-backups/'+name,Buffer.from(body));if(state.afterWrite)await state.afterWrite(name,body);},list:async prefix=>[...new Set([...objects.keys()].filter(k=>k.startsWith('tenant-backups/'+prefix+'/')).map(k=>k.slice(('tenant-backups/'+prefix+'/').length).split('/')[0]))]};
  const admission={get:async(company,base)=>{if(company!==id)throw Error('Foreign admission');return jobs.has(base)?structuredClone(jobs.get(base)):null;},list:async company=>{if(company!==id)throw Error('Foreign admission');return [...jobs.keys()];},admit:async(company,base,value)=>{if(company!==id)throw Error('Foreign admission');if(!jobs.has(base))jobs.set(base,structuredClone(value));return structuredClone(jobs.get(base));}};
  const engine=()=>createEngine({key,repository,storage,admission,allowed:company=>state.allowed&&company===id});
  return {id,state,objects,writes,jobs,admission,repository,storage,engine};
}
function inline(f){
  const id=crypto.randomUUID(),raw=Buffer.from('signed synthetic inline'),stored={id,purpose:'workspace-asset-custody-v1',companyId:f.id,actorId:1,actorRole:'owner',sessionHash:'a'.repeat(64),kind:'planUpload',path:'/api/projects/101/plans',name:'inline.pdf',type:'application/pdf',bytes:raw.toString('base64'),sha256:sha(raw),analysis:null,extractionMethod:null,createdAt:new Date().toISOString()};
  stored.proof=crypto.createHmac('sha256',key).update('workspace-asset-custody-v1:'+canonicalHash(stored)).digest('hex');
  const row={id:2,projectId:101,url:'/api/files/estimate-documents/'+f.id+'/compat/'+id+'.pdf',bucket:'estimate-documents',objectKey:f.id+'/compat/'+id+'.pdf'};
  const operation={kind:stored.kind,method:'POST',path:stored.path,details:{files:[{name:stored.name,type:stored.type,assetId:id}],note:''}};
  const common={purpose:'workspace-resource-save-v1',companyId:f.id,actorId:1,actorRole:'owner',sessionHash:'a'.repeat(64),sessionBinding:'b'.repeat(64),authorityBefore:'c'.repeat(64),createdAt:stored.createdAt};
  const preview={...common,id:crypto.randomUUID(),operation,version:'d'.repeat(64),expiresAt:new Date(Date.parse(stored.createdAt)+300000).toISOString(),reason:'Synthetic inline file review',impact:{kind:stored.kind,details:operation.details,changedCollections:['projectPlans'],affectedMembers:[],affectedAccounts:[],accountScopes:[]},openingRevision:0,reviewRevision:1};
  const receipt={...common,id:crypto.randomUUID(),operation,version:preview.version,previewId:preview.id,requestId:crypto.randomUUID(),reason:preview.reason,status:201,result:{files:[structuredClone(row)]},retained:{},authorityAfter:'e'.repeat(64),reviewRevision:1,committedRevision:2};
  for(const value of [preview,receipt])value.proof=crypto.createHmac('sha256',key).update('workspace-resource-save-v1:'+canonicalHash(value)).digest('hex');
  f.state.snapshot.workspaceAssetCustody=[stored];f.state.snapshot.projectPlans.push(row);f.state.snapshot.resourcePreviews=[preview];f.state.snapshot.resourceReceipts=[receipt];return stored;
}
module.exports={fixture,inline,key};
