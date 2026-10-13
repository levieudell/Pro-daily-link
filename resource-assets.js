'use strict';
// Named synthetic upload custody. Bytes and parsed drafts are retained privately
// by the existing tenant transaction, never written to legacy disk or providers.
const crypto=require('node:crypto');
const {canonicalHash}=require('./database/transactional-repository');
const daily=require('./daily-access');
const {pdfText,estimateDraft}=require('./estimate-pdf');
const collection='workspaceAssetCustody',purpose='workspace-asset-custody-v1';
const types={'image/jpeg':'jpg','image/png':'png','image/webp':'webp','application/pdf':'pdf'};
const equal=(a,b)=>canonicalHash(a??null)===canonicalHash(b??null);
const omit=(row,keys)=>Object.fromEntries(Object.entries(row).filter(([key])=>!keys.includes(key)));
const next=rows=>Math.max(0,...rows.map(row=>Number(row.id)||0))+1;
const input=()=>require('./resource-inputs');
const fail=(code,message)=>input().fail(code,message);
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
function route(method,path,details){
  if(details?.files&&details?.report&&(method==='POST'&&path==='/api/reports'||method==='PATCH'&&/^\/api\/reports\/[1-9]\d*$/.test(path)))return method==='POST'?'reportPhotoCreate':'reportPhotoEdit';
  if(method!=='POST')return null;
  if(path==='/api/photos')return 'photoUpload';
  if(path==='/api/estimate-imports/analyze')return 'estimatePdfIntake';
  if(/^\/api\/projects\/[1-9]\d*\/plans$/.test(path))return 'planUpload';
  if(/^\/api\/projects\/[1-9]\d*\/estimate-proposals$/.test(path)&&details&&(Object.hasOwn(details,'data')||Object.hasOwn(details,'assetId')))return 'estimatePdfProposal';
  return null;
}
function file(raw,kind,i){
  if(!i.object(raw,['name','type','data','lastModified','assetId'])||!types[raw.type]||(kind==='photoUpload'||kind.startsWith('reportPhoto'))&&raw.type==='application/pdf'||typeof raw.name!=='string'||raw.name.length>180||!raw.name.trim())fail(400,'Choose bounded JPG, PNG, WebP or PDF files.');
  const value={name:raw.name,type:raw.type};
  if(Object.hasOwn(raw,'lastModified')){if(!Number.isSafeInteger(raw.lastModified)||raw.lastModified<0||raw.lastModified>8640000000000000)fail(400,'Invalid capture date.');value.lastModified=raw.lastModified;}
  if(Object.hasOwn(raw,'assetId')){if(!uuid(raw.assetId)||Object.hasOwn(raw,'data'))fail(400,'Invalid retained file identity.');value.assetId=raw.assetId;}
  else {if(typeof raw.data!=='string'||raw.data.length>20000100)fail(400,'Choose a bounded file.');value.data=raw.data;}
  return value;
}
function parse(op,i=input()){
  if(!i.object(op,['kind','method','path','details'])||Object.keys(op).length!==4||route(op.method,op.path,op.details)!==op.kind)fail(400,'Choose a supported file intake.');
  const d=op.details;let details;
  if(op.kind.startsWith('reportPhoto')){
    if(!i.object(d,['report','files','caption','tags']))fail(400,'Review only the existing daily and its selected photos.');const parsed=require('./daily-admission').parse({action:op.kind==='reportPhotoCreate'?'createReport':'editReport',...(op.kind==='reportPhotoEdit'?{id:Number(op.path.split('/')[3])}:{}),details:d.report});
    if(!Array.isArray(d.tags)||d.tags.length>12||d.tags.some(value=>typeof value!=='string'||value.length>80))fail(400,'Choose bounded photo tags.');details={report:parsed.details,caption:i.text(d.caption||'',500),tags:[...new Set(d.tags.map(value=>value.trim().toLowerCase()).filter(Boolean))]};
  }else if(op.kind==='photoUpload'){
    if(!i.object(d,['files','project','projectId','source','caption','tags','reportId','workdayId','phase','changeId'])||Object.hasOwn(d,'changeId')&&d.changeId!==null||!i.id(d.projectId)||!Number.isSafeInteger(d.project)||d.project<0||!['field','office'].includes(d.source)||!Array.isArray(d.tags)||d.tags.length>12||d.tags.some(tag=>typeof tag!=='string'||tag.length>80))fail(400,'Choose the current project and bounded photo details.');
    details={project:d.project,projectId:d.projectId,source:d.source,caption:i.text(d.caption||'',500),tags:[...new Set(d.tags.map(tag=>tag.trim().toLowerCase()).filter(Boolean))],reportId:d.reportId??null,workdayId:d.workdayId??null,phase:d.phase??null};
    for(const key of ['reportId','workdayId'])if(details[key]!==null&&!i.id(details[key]))fail(400,'Choose a current linked record.');
    if(details.phase!==null&&!['start','end','progress'].includes(details.phase))fail(400,'Choose a supported photo phase.');
  }else if(op.kind==='planUpload'){
    if(!i.object(d,['files','note']))fail(400,'Only selected plan files and note may be submitted.');details={note:i.text(d.note||'',750)};
  }else{
    if(Object.hasOwn(d||{},'assetId')&&Object.hasOwn(d,'data'))fail(400,'Choose uploaded bytes or one retained file identity.');
    if(!i.object(d,['filename','data','assetId'])||typeof d.filename!=='string'||!d.filename.trim()||d.filename.length>180)fail(400,'Choose one named PDF.');
    details={filename:d.filename,...file({name:d.filename,type:'application/pdf',...(d.assetId?{assetId:d.assetId}:{data:d.data})},op.kind,i)};delete details.name;delete details.type;
    return {...op,details};
  }
  if(!Array.isArray(d.files)||!d.files.length||d.files.length>8)fail(400,'Choose one to eight files.');details.files=d.files.map(raw=>file(raw,op.kind,i));return {...op,details};
}
function authorizeActor(auth,op){if(!auth?.user||auth.user.status!=='Active'||!['owner','admin','project_manager','foreman','field'].includes(auth.user.role)||['planUpload','estimatePdfIntake'].includes(op.kind)&&!['owner','admin','project_manager'].includes(auth.user.role))fail(403,'Current upload permission required.');}
function authorize(db,auth,op,h){
  authorizeActor(auth,op);const user=auth.user,d=op.details;
  if(auth.companyId!==db.company.id||user.companyId!=null&&user.companyId!==db.company.id)fail(403,'Current company required.');
  if(op.kind.startsWith('reportPhoto')){require('./daily-admission').authorize(db,user,dailyOperation(op));return;}
  if(op.kind==='estimatePdfIntake'){if(!h.canViewPricing(db,user))fail(403,'Existing pricing permission required.');return;}
  const projectId=op.kind==='photoUpload'?d.projectId:Number(op.path.split('/')[3]),project=db.projects.find(row=>row.id===projectId);
  if(!project||!h.canAccessProject(db,user,projectId))fail(404,'Project not found.');
  if(op.kind==='photoUpload'){
    if(!daily.projectAllowed(db,user,projectId))fail(404,'Project not found.');
    const report=d.reportId===null?null:db.reports.find(row=>row.id===d.reportId),day=d.workdayId===null?null:db.workdays.find(row=>row.id===d.workdayId);
    if(d.reportId!==null&&(!report||db.projects[report.project]?.id!==projectId||!daily.reportInScope(db,user,report,'editReports'))||d.workdayId!==null&&(!day||day.projectId!==projectId||!daily.workdayInScope(db,user,day,'runWorkdays'))||report&&day&&(report.workdayId!=null&&report.workdayId!==day.id||day.reportId!=null&&day.reportId!==report.id))fail(403,'Current linked daily or workday permission required.');
    if(!report&&!day&&!daily.access(db,user).createReports)fail(403,'Current daily creation permission required.');
  }
}
function createCustody(h){
  const signature=row=>crypto.createHmac('sha256',h.key).update(purpose+':'+canonicalHash(omit(row,['proof']))).digest('hex');
  function valid(db){
    const rows=db[collection]===undefined?[]:db[collection];if(!Array.isArray(rows)||rows.length>50000||Buffer.byteLength(JSON.stringify(rows))>120000000)fail(409,'File custody capacity needs review.');const ids=new Set();
    for(const row of rows){
      if(!row||!uuid(row.id)||ids.has(row.id)||row.purpose!==purpose||row.companyId!==db.company.id||!input().id(row.actorId)||!['owner','admin','project_manager','foreman','field'].includes(row.actorRole)||!/^[a-f0-9]{64}$/.test(row.sessionHash)||!types[row.type]||typeof row.bytes!=='string'||row.bytes.length>20000000||typeof row.proof!=='string'||!/^[a-f0-9]{64}$/.test(row.proof)||row.proof!==signature(row)||!Number.isFinite(Date.parse(row.createdAt))||!equal(Object.keys(row).sort(),['id','purpose','companyId','actorId','actorRole','sessionHash','kind','path','name','type','bytes','sha256','analysis','extractionMethod','createdAt','proof'].sort())||crypto.createHash('sha256').update(Buffer.from(row.bytes,'base64')).digest('hex')!==row.sha256)fail(409,'Private file custody proof needs reconciliation.');ids.add(row.id);
    }return rows;
  }
  function selected(db,auth,op){return files(op).map(value=>{const row=valid(db).find(row=>row.id===value.assetId);if(!row||row.actorId!==auth.user.id||row.actorRole!==auth.user.role||row.sessionHash!==auth.session.tokenHash||row.kind!==op.kind||row.path!==op.path||row.name!==(value.name||value.filename)||row.type!==(value.type||'application/pdf'))fail(409,'Use files retained by the originating preview.');return row;});}
  async function prepareOperation(db,auth,op,req){
    authorize(db,auth,op,h);if(op.kind==='photoUpload')op.details.project=db.projects.findIndex(row=>row.id===op.details.projectId);valid(db);let total=0;
    for(const value of files(op)){
      if(value.assetId){if((db.resourceReceipts||[]).some(row=>(row.operation.details.files||[row.operation.details]).some(file=>file.assetId===value.assetId)))fail(409,'Already committed files require a new upload, not retained preview reuse.');const retained=valid(db).find(row=>row.id===value.assetId);if(!retained)fail(409,'Retained file missing.');total+=Buffer.from(retained.bytes,'base64').length;if(total>15000000)fail(400,'A file selection is limited to 15 MB.');continue;}
      const type=value.type||'application/pdf',match=value.data.match(/^data:([^;]+);base64,([A-Za-z0-9+/]+={0,2})$/);
      if(!match||match[1]!==type||match[2].length%4)fail(400,'File MIME and canonical base64 must match.');const bytes=Buffer.from(match[2],'base64');
      if(bytes.toString('base64')!==match[2]||!bytes.length||bytes.length>(op.kind.startsWith('reportPhoto')?6000000:{photoUpload:6000000,planUpload:10000000}[op.kind]||15000000)||(total+=bytes.length)>15000000)fail(400,'Each photo is limited to 6 MB, each plan to 10 MB, PDFs to 15 MB, and a selection to 15 MB.');
      if(type==='application/pdf'&&!bytes.subarray(0,5).equals(Buffer.from('%PDF-'))||type==='image/jpeg'&&!(bytes[0]===255&&bytes[1]===216&&bytes[2]===255)||type==='image/png'&&!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))||type==='image/webp'&&!(bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP'))fail(400,'File contents do not match the selected type.');
      let analysis=null,extractionMethod=null;
      if(['estimatePdfIntake','estimatePdfProposal'].includes(op.kind)){
        const extracted=pdfText(bytes);analysis=estimateDraft(extracted);analysis.estimateNumber=extracted.match(/(?:estimate|quote)\s*(?:#|no\.?|number)?\s*([A-Z0-9-]{2,30})/i)?.[1]||'';extractionMethod='embedded_text';
        if((analysis.requiresOcr||analysis.requiresAiReview)&&h.pdfAnalyze){await h.assertCurrent(req);analysis=await h.pdfAnalyze(Buffer.from(bytes),value.filename);extractionMethod='synthetic_ai_ocr';await h.assertCurrent(req);}
        if(!analysis||!Array.isArray(analysis.lines)||analysis.lines.length>500)fail(400,'PDF draft needs manual review.');
        analysis=projectDraft(analysis);if(Buffer.byteLength(JSON.stringify(analysis))>1000000)fail(400,'PDF draft exceeds the review limit.');
      }
      const row={id:crypto.randomUUID(),purpose,companyId:db.company.id,actorId:auth.user.id,actorRole:auth.user.role,sessionHash:auth.session.tokenHash,kind:op.kind,path:op.path,name:value.name||value.filename,type,bytes:bytes.toString('base64'),sha256:crypto.createHash('sha256').update(bytes).digest('hex'),analysis,extractionMethod,createdAt:new Date().toISOString()};row.proof=signature(row);db[collection]||=[];db[collection].push(row);value.assetId=row.id;delete value.data;
    }valid(db);selected(db,auth,op);if(new Set(files(op).map(file=>file.assetId)).size!==files(op).length)fail(400,'Select each retained file once.');return op;
  }
  return {valid,selected,prepareOperation};
}
function files(op){return op.details.files||[op.details];}
function projectDraft(raw){
  if(!raw||typeof raw!=='object'||Array.isArray(raw)||!Array.isArray(raw.lines)||raw.lines.length>500)fail(400,'PDF draft needs manual review.');
  const draft={lines:raw.lines.map(line=>{
    if(!line||typeof line!=='object'||Array.isArray(line)||typeof line.description!=='string'||line.description.length>500||typeof line.unit!=='string'||line.unit.length>20)fail(400,'PDF lines need bounded descriptions and units.');
    const out={description:line.description,unit:line.unit,confidence:'low'};for(const key of ['quantity','amount','budgetHours','unitPrice','internalCost'])if(Object.hasOwn(line,key)){if(line[key]!==null&&(typeof line[key]!=='number'||!Number.isFinite(line[key])||line[key]<0||line[key]>1e12))fail(400,'PDF numbers need manual review.');out[key]=line[key];}
    if(Object.hasOwn(line,'confidence')){if(!['low','medium','high'].includes(line.confidence))fail(400,'Invalid PDF confidence.');out.confidence=line.confidence;}return out;
  })};
  for(const key of ['estimateNumber'])if(Object.hasOwn(raw,key)){if(typeof raw[key]!=='string'||raw[key].length>180)fail(400,'Invalid PDF identity.');draft[key]=raw[key];}
  for(const key of ['documentTotal','lineTotal'])if(Object.hasOwn(raw,key)){if(raw[key]!==null&&(typeof raw[key]!=='number'||!Number.isFinite(raw[key])||raw[key]<0||raw[key]>1e12))fail(400,'PDF totals need manual review.');draft[key]=raw[key];}
  for(const key of ['reconciled','requiresOcr','requiresAiReview'])if(Object.hasOwn(raw,key)){if(typeof raw[key]!=='boolean')fail(400,'Invalid PDF review state.');draft[key]=raw[key];}
  if(Object.hasOwn(raw,'reviewWarnings')){if(!Array.isArray(raw.reviewWarnings)||raw.reviewWarnings.length>100||raw.reviewWarnings.some(value=>typeof value!=='string'||value.length>1000))fail(400,'PDF warnings need manual review.');draft.reviewWarnings=[...raw.reviewWarnings];}return draft;
}
function url(db,row){return '/api/files/'+(row.kind==='photoUpload'||row.kind.startsWith('reportPhoto')?'project-photos':'estimate-documents')+'/'+db.company.id+'/compat/'+row.id+'.'+types[row.type];}
function dailyOperation(op){return require('./daily-admission').parse({action:op.kind==='reportPhotoCreate'?'createReport':'editReport',...(op.kind==='reportPhotoEdit'?{id:Number(op.path.split('/')[3])}:{}),details:op.details.report});}
async function execute(db,auth,op,h,req){
  if(!op.kind.startsWith('reportPhoto'))return build(db,auth,op,h);
  authorize(db,auth,op,h);const dailyOp=dailyOperation(op),rows=h.assetCustody.selected(db,auth,op),candidate=structuredClone(db),reportId=op.kind==='reportPhotoCreate'?next(db.reports):Number(op.path.split('/')[3]),projectId=op.kind==='reportPhotoCreate'?Number(op.details.report.projectId):db.projects[db.reports.find(row=>row.id===reportId).project].id,project=db.projects.findIndex(row=>row.id===projectId),oldPhotos=db.photos||[],start=next(oldPhotos);
  const photos=rows.map((row,index)=>({id:start+index,project,reportId,workdayId:null,phase:null,source:daily.field(auth.user)?'field':'office',caption:op.details.caption,tags:op.details.tags,capturedAt:op.details.files[index].lastModified?new Date(op.details.files[index].lastModified).toISOString():row.createdAt,uploader:auth.user.name,createdAt:row.createdAt,url:url(db,row),storageBucket:'project-photos',storageKey:db.company.id+'/compat/'+row.id+'.'+types[row.type]}));
  candidate.photos=[...oldPhotos,...photos];const result=await require('./daily-admission').executeReport({auth,headers:req.headers},dailyOp,(actor,operation,source)=>h.run(actor,{method:operation.method,path:operation.path,details:operation.details},source),h.presentReport,candidate);if(result.response.status>=400)fail(result.response.status,result.response.data?.error||'Daily with photos could not be validated.');
  const dailyCandidate=structuredClone(result.candidate);dailyCandidate.photos=structuredClone(db.photos);require('./daily-admission').validateDelta(db,dailyCandidate,auth.user,dailyOp);if(!equal(result.candidate.photos,candidate.photos))fail(409,'Daily photo effects need reconciliation.');
  return {candidate:result.candidate,response:{status:op.kind==='reportPhotoCreate'?201:200,data:{report:require('./daily-admission').reportProjection(result.candidate,auth.user,result.response.data,h.presentReport),files:photos}},dirty:true};
}
function build(db,auth,op,h){
  authorize(db,auth,op,h);const rows=h.assetCustody.selected(db,auth,op),candidate=structuredClone(db),d=op.details,at=new Date().toISOString();let data;
  if(op.kind==='photoUpload'){
    candidate.photos||=[];const created=rows.map((row,index)=>({id:next(candidate.photos)+index,project:d.project,reportId:d.reportId,workdayId:d.workdayId,phase:d.phase,source:d.source,caption:d.caption,tags:d.tags,capturedAt:d.files[index].lastModified?new Date(d.files[index].lastModified).toISOString():at,uploader:auth.user.name,createdAt:at,url:url(db,row),storageBucket:'project-photos',storageKey:db.company.id+'/compat/'+row.id+'.'+types[row.type]}));candidate.photos.push(...created);data={files:created};
  }else if(op.kind==='planUpload'){
    candidate.projectPlans||=[];const created=rows.map((row,index)=>({id:next(candidate.projectPlans)+index,projectId:Number(op.path.split('/')[3]),name:row.name,type:row.type,size:Buffer.from(row.bytes,'base64').length,note:d.note,uploadedBy:auth.user.name,createdAt:at,url:url(db,row),bucket:'estimate-documents',objectKey:db.company.id+'/compat/'+row.id+'.'+types[row.type]}));candidate.projectPlans.push(...created);data={files:created};
  }else if(op.kind==='estimatePdfIntake'){
    const row=rows[0],draft=h.enrichEstimateDraft(structuredClone(row.analysis),db.catalog||[]);candidate.estimateImports||=[];
    const created={...draft,id:next(candidate.estimateImports),filename:row.name,url:url(db,row),estimateNumber:draft.estimateNumber||'',status:'Draft',createdByUserId:auth.user.id,createdAt:at,textPreview:'',extractionMethod:row.extractionMethod,duplicate:Boolean(draft.estimateNumber&&(db.estimateImports||[]).some(value=>value.estimateNumber===draft.estimateNumber))};candidate.estimateImports.push(created);data=require('./resource-estimates').importDTO(created);
  }else{
    const row=rows[0],lines=row.analysis.lines.map(line=>({name:String(line.description||'').trim(),plannedQuantity:Number(line.quantity),unit:String(line.unit||'').trim().toUpperCase()}));
    if(!lines.length||lines.some(line=>!line.name||line.name.length>500||!Number.isFinite(line.plannedQuantity)||line.plannedQuantity<=0||line.plannedQuantity>1e12||!line.unit||line.unit.length>20))fail(400,'PDF scope needs quantity and unit review before creating proposals.');
    const project=candidate.projects.find(row=>row.id===Number(op.path.split('/')[3]));project.estimateProposals||=[];for(const line of lines)project.estimateProposals.push({id:next(project.estimateProposals),...line,sourceFile:{name:row.name,url:url(db,row)},createdBy:auth.user.name,createdAt:at,status:'Needs office review'});data={created:lines.length,proposals:project.estimateProposals.map(require('./resource-estimates').proposalDTO)};
  }return {candidate,response:{status:201,data},dirty:true};
}
function validate(before,after,op,auth,h){
  if(op.kind.startsWith('reportPhoto')){
    authorize(before,auth,op,h);const candidate=structuredClone(after),old=before.photos||[],added=(after.photos||[]).slice(old.length),rows=h.assetCustody.selected(before,auth,op),reportId=op.kind==='reportPhotoCreate'?next(before.reports):Number(op.path.split('/')[3]),report=after.reports.find(row=>row.id===reportId),project=report?.project;
    if(!report||added.length!==rows.length||!equal(after.photos.slice(0,old.length),old))fail(409,'Daily photo effects need reconciliation.');
    const expected=rows.map((row,index)=>({id:next(old)+index,project,reportId,workdayId:null,phase:null,source:daily.field(auth.user)?'field':'office',caption:op.details.caption,tags:op.details.tags,capturedAt:op.details.files[index].lastModified?new Date(op.details.files[index].lastModified).toISOString():row.createdAt,uploader:auth.user.name,createdAt:row.createdAt,url:url(before,row),storageBucket:'project-photos',storageKey:before.company.id+'/compat/'+row.id+'.'+types[row.type]}));if(!equal(added,expected))fail(409,'Daily photo effects need reconciliation.');candidate.photos=structuredClone(before.photos);require('./daily-admission').validateDelta(before,candidate,auth.user,dailyOperation(op));return {data:{report:require('./daily-admission').reportProjection(after,auth.user,report,h.presentReport),files:added},retained:{}};
  }
  const expected=build(before,auth,op,h),name={photoUpload:'photos',planUpload:'projectPlans',estimatePdfIntake:'estimateImports',estimatePdfProposal:'projects'}[op.kind];
  // Handlers only generate timestamps. Compare the complete expected business
  // effect using the actual newly-created timestamp, including all old rows.
  const generated=op.kind==='estimatePdfProposal'?after.projects.find(row=>row.id===Number(op.path.split('/')[3])).estimateProposals.at(-1):after[name]?.at(-1);if(!generated||!Number.isFinite(Date.parse(generated.createdAt)))fail(409,'Upload effects need reconciliation.');
  const replace=value=>{if(Array.isArray(value))return value.map(replace);if(!value||typeof value!=='object')return value;return Object.fromEntries(Object.entries(value).map(([key,child])=>[key,['createdAt','capturedAt'].includes(key)&&child===expected.response.data.files?.[0]?.createdAt?generated.createdAt:replace(child)]));};
  // Normalize only timestamps on newly appended rows; existing source is exact.
  if(op.kind==='estimatePdfProposal'){const project=expected.candidate.projects.find(row=>row.id===Number(op.path.split('/')[3])),count=expected.response.data.created;project.estimateProposals.slice(-count).forEach(row=>row.createdAt=generated.createdAt);}
  else {const count=op.kind==='estimatePdfIntake'?1:expected.response.data.files.length;expected.candidate[name].slice(-count).forEach((row,index)=>{const previous=row.createdAt;row.createdAt=generated.createdAt;if(row.capturedAt===previous&&!op.details.files[index].lastModified)row.capturedAt=generated.createdAt;});}
  if(!equal(expected.candidate,after))fail(409,'Upload effects need reconciliation.');return {data:op.kind==='estimatePdfProposal'?{created:expected.response.data.created,proposals:after.projects.find(row=>row.id===Number(op.path.split('/')[3])).estimateProposals.map(require('./resource-estimates').proposalDTO)}:op.kind==='estimatePdfIntake'?require('./resource-estimates').importDTO(after[name].at(-1)):{files:after[name].slice(-expected.response.data.files.length)},retained:{}};
}
function currentResult(db,auth,receipt,first,h){authorize(db,auth,receipt.operation,h);return first?receipt.result:{receiptId:receipt.id,ids:receipt.result.files?.map(row=>row.id)||[receipt.result.id].filter(Boolean)};}
function publicDetails(op){return {...omit(op.details,['data','assetId','files']),...(op.details.files?{files:op.details.files.map(file=>omit(file,['data','assetId']))}:{filename:op.details.filename})};}
module.exports={route,parse,authorizeActor,authorize,createCustody,build,execute,validate,currentResult,publicDetails,projectDraft,collection,types,url};
