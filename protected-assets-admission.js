'use strict';
const daily=require('./daily-access');
const {types}=require('./resource-assets');
const fail=(statusCode,message)=>{throw Object.assign(Error(message),{statusCode});};
function route(method,path){return method==='GET'&&(/^\/api\/files\/(?:project-photos|estimate-documents|project-tickets)\/.+$/.test(path)||/^\/api\/local-files\/.+$/.test(path));}
function location(url,companyId){
  if(url.search||/%(?:2f|5c|2e|00)/i.test(url.pathname))fail(400,'Use the original protected file URL.');let path;try{path=decodeURIComponent(url.pathname);}catch{fail(400,'Invalid file URL.');}
  if(path.includes('\\')||path.includes('\0')||path.includes('//')||path.split('/').some(part=>part==='..'||part==='.'))fail(400,'Invalid file URL.');
  if(path.startsWith('/api/local-files/'))return {url:'/uploads/'+path.slice('/api/local-files/'.length),local:path.slice('/api/local-files/'.length)};
  const parts=path.split('/'),bucket=parts[3],key=parts.slice(4).join('/');if(!key.startsWith(companyId+'/'))fail(404,'File not found.');return {url:path,bucket,key};
}
function authorized(db,user,ref,h){
  if(ref.kind==='import'){
    const row=ref.row;return ['owner','admin','project_manager'].includes(user.role)&&h.canViewPricing(db,user)&&(row.projectId!=null?h.canAccessProject(db,user,row.projectId):user.role!=='project_manager'||row.createdByUserId===user.id);
  }
  const row=ref.row,id=ref.projectId;if(!h.canAccessProject(db,user,id))return false;
  if(ref.kind==='proposal')return ref.sourceActorId===user.id||['owner','admin','project_manager'].includes(user.role)&&h.canViewPricing(db,user);
  if(ref.kind!=='photo')return true;
  if(!daily.access(db,user).viewReports||!daily.projectAllowed(db,user,id))return false;
  const report=row.reportId==null?null:db.reports.find(value=>value.id===row.reportId),day=row.workdayId==null?null:db.workdays.find(value=>value.id===row.workdayId);
  if(row.reportId!=null&&(!report||db.projects[report.project]?.id!==id||!daily.reportInScope(db,user,report)))return false;
  if(row.workdayId!=null&&(!day||day.projectId!==id||!daily.workdayInScope(db,user,day)))return false;
  return true;
}
function references(db,where){
  const match=row=>row.url===where.url||where.bucket&&(row.bucket===where.bucket&&row.objectKey===where.key||row.storageBucket===where.bucket&&row.storageKey===where.key);
  const refs=[];for(const row of db.photos||[])if(match(row))refs.push({kind:'photo',row,projectId:db.projects[row.project]?.id??row.projectId});
  for(const [name,kind]of [['projectPlans','plan'],['projectTickets','ticket']])for(const row of db[name]||[])if(!row.deletedAt&&match(row))refs.push({kind,row,projectId:row.projectId});
  for(const row of db.estimateImports||[])if(match(row))refs.push({kind:'import',row});
  for(const project of db.projects||[])for(const row of project.estimateProposals||[])if(row.sourceFile&&match(row.sourceFile))refs.push({kind:'proposal',row:row.sourceFile,projectId:project.id});
  return refs;
}
function retainedReference(db,stored,refs){
  const receipt=(db.resourceReceipts||[]).find(row=>row.operation.kind===stored.kind&&row.operation.path===stored.path&&(row.operation.details.files||[row.operation.details]).some(file=>file.assetId===stored.id));
  if(!receipt)fail(409,'File receipt needs reconciliation.');
  for(const ref of refs){
    if(['photoUpload','reportPhotoCreate','reportPhotoEdit'].includes(stored.kind)){
      const original=receipt.result.files?.find(row=>row.url===require('./resource-assets').url(db,stored));
      if(ref.kind!=='photo'||!original||['id','project','workdayId','phase','source','url','storageBucket','storageKey'].some(key=>ref.row[key]!==original[key])||ref.row.reportId!==original.reportId&&!(ref.row.reportId===null&&original.reportId!=null&&(db.resourceReceipts||[]).some(row=>row.operation.kind==='reportRemove'&&row.operation.path==='/api/reports/'+original.reportId&&row.retained?.report?.id===original.reportId&&row.retained.report.project===original.project&&row.retained.photos?.some(photo=>photo.id===original.id&&photo.url===original.url&&photo.reportId===original.reportId))))fail(409,'Photo reference needs reconciliation.');
    }else if(stored.kind==='planUpload'){
      const original=receipt.result.files?.find(row=>row.url===require('./resource-assets').url(db,stored));
      if(ref.kind!=='plan'||!original||['id','projectId','url','bucket','objectKey'].some(key=>ref.row[key]!==original[key]))fail(409,'Plan reference needs reconciliation.');
    }else if(stored.kind==='estimatePdfIntake'){
      if(ref.kind!=='import'||ref.row.id!==receipt.result.id||ref.row.url!==receipt.result.url||ref.row.filename!==receipt.result.filename||ref.row.createdByUserId!==stored.actorId)fail(409,'PDF intake reference needs reconciliation.');
    }else if(stored.kind==='estimatePdfProposal'&&(ref.kind!=='proposal'||ref.projectId!==Number(stored.path.split('/')[3])))fail(409,'PDF proposal reference needs reconciliation.');
  }
}
function createHandler(h){return async(req,res,url)=>{
  if(!route(req.method,url.pathname))return false;
  try{
    const db=h.readDb(),where=location(url,db.company.id),auth=await h.assertCurrent(req),refs=references(db,where);
    const stored=h.assetCustody.valid(db).find(row=>require('./resource-assets').url(db,row)===where.url);
    if(stored?.kind==='estimatePdfProposal')refs.forEach(ref=>ref.sourceActorId=stored.actorId);
    if(!refs.length||refs.some(ref=>!authorized(db,auth.user,ref,h)))fail(404,'File not found.');
    let result;if(stored){
      retainedReference(db,stored,refs);
      result={bytes:Buffer.from(stored.bytes,'base64'),type:stored.type};
    }else{
      if(typeof h.readAsset!=='function')fail(503,'Existing file delivery needs its explicit synthetic custody adapter.');
      result=await h.readAsset({...where,companyId:db.company.id});
    }
    await h.assertCurrent(req);if(!result||!Buffer.isBuffer(result.bytes)||!result.bytes.length||result.bytes.length>15000000||!types[result.type])fail(409,'File delivery could not be verified.');
    h.raw(res,{status:200,headers:{'Content-Type':result.type,'Content-Length':String(result.bytes.length),'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Content-Disposition':'inline'},raw:Buffer.from(result.bytes)});return true;
  }catch(error){if(![400,401,402,403,404,409,503].includes(error.statusCode))throw error;h.json(res,error.statusCode,{error:error.message});return true;}
};}
module.exports={route,location,authorized,references,retainedReference,createHandler};
