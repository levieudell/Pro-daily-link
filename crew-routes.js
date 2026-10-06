'use strict';
const crypto=require('node:crypto');
const policy=require('./restricted-field-access');
function createCrewHandler({readDb,writeDb,body,json,timeCardsEnabled,nextId,companyDateIso,timeCardOverlap,upsertTimeCard,presentTimeCard,savePhoto,assertCurrent,lockedPeriod}){
  return async function(req,res,url){
    if(!url.pathname.startsWith('/api/crew/'))return false;
    const user=req.auth?.user;
    if(!policy.restricted(user)){json(res,403,{error:'Restricted crew access required'});return true}
    if(req.method==='GET'&&url.pathname==='/api/crew/photos'){
      const db=readDb(),id=Number(url.searchParams.get('projectId'));
      if(id&&!policy.projectIds(db,user).has(id)){json(res,404,{error:'Assigned job not found'});return true}
      json(res,200,policy.photos(db,user).filter(row=>!id||Number(db.projects[row.project].id)===id).map(row=>policy.photoView(row)));return true;
    }
    if(req.method!=='POST'||!['/api/crew/clock-in','/api/crew/photos'].includes(url.pathname)){json(res,403,{error:'This action is unavailable for crew access'});return true}
    const input=await body(req),db=readDb(),actor=assertCurrent(db,req),project=(db.projects||[]).find(row=>Number(row.id)===Number(input?.projectId));
    if(!actor||!project||!policy.projectIds(db,actor).has(Number(project.id))){json(res,403,{error:'This job is no longer assigned to your account'});return true}
    if(url.pathname==='/api/crew/clock-in'){
      if(!timeCardsEnabled(db.company)){json(res,409,{error:'Company time cards must be enabled before clocking in'});return true}
      if(!input||Object.keys(input).some(key=>key!=='projectId')){json(res,400,{error:'Choose your assigned job; the person and start time are set by the server'});return true}
      const now=new Date().toISOString(),memberId=Number(actor.memberId);
      if(lockedPeriod(db,{memberId,inAt:now})){json(res,409,{error:'This pay period is closed. Ask your office time administrator.'});return true}
      if((db.workdays||[]).some(day=>day.status==='active'&&(day.memberIds||[]).map(Number).includes(memberId))||timeCardOverlap(db,{memberId,inAt:now,outAt:null})){json(res,409,{error:'You already have an open time record. End or correct it before clocking in again.'});return true}
      const row={id:nextId(db.timeCards||[]),projectId:project.id,memberId,date:companyDateIso(db.company,new Date(now)),inAt:now,outAt:null,hours:null,breaks:[],status:'draft',workdayId:null,reportId:null,history:[{action:'Opened',by:actor.name,at:now}]};
      upsertTimeCard(db,row);writeDb(db);json(res,201,presentTimeCard(db.company,row,actor));return true;
    }
    if(!input||Object.keys(input).some(key=>!['projectId','files'].includes(key))||!Array.isArray(input.files)||!input.files.length||input.files.length>8){json(res,400,{error:'Choose an assigned job and up to 8 photos. Daily report linkage is unavailable.'});return true}
    const types={'image/jpeg':'jpg','image/png':'png','image/webp':'webp'},files=[],identities=new Map();
    for(const file of input.files){const match=String(file?.data||'').match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/),bytes=match?Buffer.from(match[2],'base64'):null;
      if(!types[file?.type]||!match||match[1]!==file.type||!bytes?.length||bytes.length>6000000||!/^\w{8}-\w{4}-\w{4}-\w{4}-\w{12}$/.test(String(file.uploadId))||!/^[0-9a-f-]{36}$/i.test(file.uploadId)){json(res,400,{error:'Use JPG, PNG, or WebP photos up to 6 MB with a valid upload identity'});return true}
      const digest=crypto.createHash('sha256').update(bytes).digest('hex');if(identities.has(file.uploadId)){if(identities.get(file.uploadId)!==digest){json(res,409,{error:'Duplicate photo identity has different contents'});return true}continue}identities.set(file.uploadId,digest);files.push({file,bytes,digest});
    }
    // Validate every retry before storage or record mutation. The tenant queue
    // serializes requests; persistence revision checks protect external writers.
    const owner=String(actor.id),index=db.projects.indexOf(project);db.photos ||= [];
    for(const item of files){item.prior=db.photos.find(row=>row.uploadOwner===owner&&row.uploadId===item.file.uploadId);if(item.prior&&(item.prior.uploadDigest!==item.digest||Number(item.prior.project)!==index||item.prior.reportId||item.prior.workdayId)){json(res,409,{error:'This photo retry belongs to different contents or a different work record'});return true}}
    const staged=[],created=[];
    for(const item of files){const duplicate=created.find(row=>row.uploadId===item.file.uploadId);if(duplicate){if(duplicate.uploadDigest!==item.digest){json(res,409,{error:'Duplicate photo identity has different contents'});return true}continue}
      if(item.prior){created.push(item.prior);continue}
      const stored=await savePhoto(db,owner,item.file.uploadId,types[item.file.type],item.bytes,item.file.type);
      const current=assertCurrent(db,req);if(!current||!policy.projectIds(db,current).has(Number(project.id))){json(res,403,{error:'Access changed while uploading. No photo record was linked.'});return true}
      const at=new Date().toISOString(),photo={id:nextId([...db.photos,...staged]),project:index,source:'field',caption:'',tags:[],reportId:null,workdayId:null,uploadId:item.file.uploadId,uploadOwner:owner,uploadDigest:item.digest,uploader:current.name,createdAt:at,capturedAt:at,url:stored.url,storageBucket:stored.bucket,storageKey:stored.objectKey};staged.push(photo);created.push(photo);
    }
    if(!assertCurrent(db,req)){json(res,403,{error:'Access changed while uploading. No photo record was linked.'});return true}
    db.photos.push(...staged);if(staged.length)writeDb(db);json(res,201,created.map(row=>policy.photoView(row)));return true;
  };
}
module.exports={createCrewHandler};
