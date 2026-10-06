'use strict';
const MODE='time_schedule_photos';
const restricted=user=>user?.role==='field'&&user.fieldAccessMode===MODE;
function validMode(role,mode){return mode==null||mode===''||role==='field'&&['standard',MODE].includes(mode)}
function mode(role,input,previous){return role==='field'?(input===undefined?previous||'standard':input||'standard'):null}
function assignments(db,user){const id=Number(user?.memberId);return id>0&&(db.team||[]).some(row=>Number(row.id)===id)?(db.assignments||[]).filter(row=>(row.memberIds||[]).map(Number).includes(id)):[]}
function projectIds(db,user){return new Set(assignments(db,user).map(row=>Number(row.projectId)).filter(id=>(db.projects||[]).some(project=>Number(project.id)===id&&!project.archived)))}
function photoView(photo,project=photo.project){return {id:photo.id,project,url:photo.url,createdAt:photo.createdAt||null,uploader:photo.uploader||'Team member'}}
function timeCardView(card){const keys=['id','projectId','memberId','activityCodeId','activityName','date','inAt','outAt','hours','breaks','status','submittedAt','submittedBy','approvedAt','approvedBy','original','historyLines'];return Object.fromEntries(keys.filter(key=>Object.hasOwn(card,key)).map(key=>[key,card[key]]))}
function photos(db,user){const ids=projectIds(db,user);return (db.photos||[]).filter(row=>ids.has(Number(db.projects?.[Number(row.project)]?.id)))}
function canReadAsset(db,user,asset){return photos(db,user).some(row=>(asset.url&&row.url===asset.url)||(asset.bucket&&row.storageBucket===asset.bucket&&row.storageKey===asset.objectKey))}
function workspace(db,user){
  const ids=projectIds(db,user),pairs=(db.projects||[]).map((project,index)=>({project,index})).filter(row=>ids.has(Number(row.project.id))),indexes=new Map(pairs.map((row,index)=>[row.index,index]));
  const member=(db.team||[]).find(row=>Number(row.id)===Number(user.memberId));
  return {company:{id:db.company.id,name:db.company.name,timezone:db.company.timezone,weekStart:db.company.weekStart,overtimeRule:db.company.overtimeRule,features:{timeCards:db.company.features?.timeCards===true,templates:false}},currentUser:{id:user.id,memberId:user.memberId,name:user.name,email:user.email,role:'field',fieldAccessMode:MODE,preferredLanguage:user.preferredLanguage||'en',preferences:user.preferences||{}},projects:pairs.map(({project})=>({id:project.id,name:project.name,code:project.code,site:project.site,archived:false,estimateItems:[]})),team:member?[{id:member.id,name:member.name,role:member.role,crew:member.crew,initials:member.initials}]:[],assignments:assignments(db,user).filter(row=>ids.has(Number(row.projectId))).map(row=>({id:row.id,projectId:row.projectId,date:row.date,start:row.start,end:row.end,activity:row.activity,memberIds:[Number(user.memberId)]})),photos:photos(db,user).map(row=>photoView(row,indexes.get(Number(row.project)))),reports:[],customers:[],workdays:[],projectPlans:[],projectTickets:[],dailyTemplates:[]};
}
function allowed(method,path){return method==='GET'&&['/api/state','/api/account-access','/api/time-cards','/api/crew/photos'].includes(path)||method==='GET'&&(/^\/api\/files\/project-photos\/.+$/.test(path)||/^\/api\/local-files\/.+$/.test(path))||method==='POST'&&['/api/crew/clock-in','/api/crew/photos'].includes(path)||method==='PATCH'&&/^\/api\/time-cards\/\d+$/.test(path)||method==='POST'&&/^\/api\/time-cards\/\d+\/(?:submit|clock-out)$/.test(path)}
module.exports={MODE,restricted,validMode,mode,assignments,projectIds,photos,photoView,timeCardView,canReadAsset,workspace,allowed};
