'use strict';
// A closed inventory of currently retained tenant references. Local/remote URLs
// have no provable tenant binding and cannot establish a complete recovery set.
const {uuid}=require('./roles-snapshot-repository');
const assets=require('../resource-assets');
const {retainedReference}=require('../protected-assets-admission');
const fail=()=>{throw Object.assign(Error('Managed attachment inventory needs reconciliation.'),{code:'PDL_MANAGED_BACKUP_ASSETS'});};
const buckets=new Set(['company-logos','project-photos','estimate-documents','project-tickets']);
function location(bucket,key,companyId){
  if(!buckets.has(bucket)||typeof key!=='string'||key.length>1000||!key.startsWith(companyId+'/')||/[\\%\u0000-\u001f?#]/.test(key)||key.split('/').some(part=>!part||part==='.'||part==='..'))fail();
  return {bucket,key};
}
function collect(snapshot,key){
  const companyId=snapshot?.company?.id;if(!uuid(companyId)||!Buffer.isBuffer(key)||key.length!==32)fail();
  require('../resource-admission').createHandler({key}).valid(snapshot);
  const custody=assets.createCustody({key}).valid(snapshot),refs=[];
  const add=(row,source,kind,projectId)=>{
    if(!row||typeof row!=='object'||Array.isArray(row)||row.companyId!==undefined&&row.companyId!==companyId)fail();
    if(kind==='ticket'&&row.purgedAt&&row.url==null&&row.bucket==null&&row.objectKey==null&&row.storageBucket==null&&row.storageKey==null){
      if(typeof row.purgedAt!=='string'||typeof row.deletedAt!=='string'||!Number.isFinite(Date.parse(row.purgedAt))||new Date(row.purgedAt).toISOString()!==row.purgedAt||!Number.isFinite(Date.parse(row.deletedAt))||Date.parse(row.purgedAt)<Date.parse(row.deletedAt))fail();return;
    }
    const pairs=[];
    for(const [b,k]of [['bucket','objectKey'],['storageBucket','storageKey']]){
      if(row[b]!=null||row[k]!=null){if(!row[b]||!row[k])fail();pairs.push(location(row[b],row[k],companyId));}
    }
    if(row.url!=null){
      if(typeof row.url!=='string')fail();
      const m=/^\/api\/files\/([^/]+)\/(.+)$/.exec(row.url);
      if(!m)fail();pairs.push(location(m[1],m[2],companyId));
    }
    if(!pairs.length||pairs.some(p=>p.bucket!==pairs[0].bucket||p.key!==pairs[0].key))fail();
    const where=pairs[0],url='/api/files/'+where.bucket+'/'+where.key;
    const stored=custody.find(value=>assets.url(snapshot,value)===url);
    if(where.key.startsWith(companyId+'/compat/')&&!stored)fail();
    if(stored){
      if(Buffer.from(stored.bytes,'base64').toString('base64')!==stored.bytes)fail();
      retainedReference(snapshot,stored,[{kind,row,projectId}]);
    }
    refs.push({...where,source,custodyId:stored?.id||null});
    if(refs.length>10000)fail();
  };
  if(snapshot.company.logo!=null)add(snapshot.company.logo,'company.logo','logo');
  for(const [name,kind]of [['photos','photo'],['projectPlans','plan'],['projectTickets','ticket'],['estimateImports','import']]){
    const rows=snapshot[name]||[];if(!Array.isArray(rows))fail();
    rows.forEach((row,i)=>add(row,name+':'+i,kind,row.projectId??snapshot.projects?.[row.project]?.id));
  }
  if(!Array.isArray(snapshot.projects||[]))fail();
  for(const [i,project]of (snapshot.projects||[]).entries()){
    if(!Array.isArray(project.estimateProposals||[]))fail();
    for(const [j,row]of (project.estimateProposals||[]).entries())if(row.sourceFile!=null)add(row.sourceFile,'projects:'+i+':estimateProposals:'+j,'proposal',project.id);
  }
  const unique=new Map();
  for(const ref of refs){const id=ref.bucket+'/'+ref.key;let value=unique.get(id);if(!value){value={bucket:ref.bucket,key:ref.key,custodyId:ref.custodyId,sources:[]};unique.set(id,value);}if(value.custodyId!==ref.custodyId)fail();value.sources.push(ref.source);}
  if(unique.size>2048)fail();
  return [...unique.values()].sort((a,b)=>(a.bucket+'/'+a.key).localeCompare(b.bucket+'/'+b.key));
}
module.exports={collect,location};
