'use strict';
const {validateAccounts}=require('./account-evidence');
function validate(db){
  validateAccounts(db);
  try{require('./project-events-access').graph(db);}catch{throw Object.assign(Error('Company project event records need reconciliation.'),{statusCode:503,code:'PDL_ROLES_EVIDENCE'});}
  try{require('./project-messages-access').graph(db);}catch{throw Object.assign(Error('Company project message records need reconciliation.'),{statusCode:503,code:'PDL_ROLES_EVIDENCE'});}
  if(Object.hasOwn(db,'rolesManualCredentialCustody'))require('./roles-manual-credential-custody').createCustody({key:Buffer.from(process.env.PDL_ROLE_POLICY_KEY||'','hex')}).validate(db);
  const bad=()=>{throw Object.assign(Error('Company security records need reconciliation.'),{statusCode:503,code:'PDL_ROLES_EVIDENCE'});};
  const nonce=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value),hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value),iso=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
  const attempts=Object.hasOwn(db,'rolesProviderAttempts')?db.rolesProviderAttempts:[],attemptIds=new Set(),operations=new Set();if(!Array.isArray(attempts)||attempts.length>50000)bad();
  for(const row of attempts){
    const keys=['id','companyId','actorId','operationId','ordinal','kind','digest','status','at','finishedAt','credential'],operation=row?.operationId+':'+row?.ordinal;
    if(!row||typeof row!=='object'||Array.isArray(row)||Object.keys(row).some(name=>!keys.includes(name))||!nonce(row.id)||attemptIds.has(row.id)||row.companyId!==db.company.id||row.actorId!==null&&(!Number.isSafeInteger(row.actorId)||row.actorId<1)||!nonce(row.operationId)||!Number.isSafeInteger(row.ordinal)||row.ordinal<1||operations.has(operation)||!['email','stripe-write','storage-upload','storage-delete','local-upload','local-delete','ai','founder-alert','platform-onboarding','billing-analytics','public-count'].includes(row.kind)||!hash(row.digest)||!['unknown','accepted','rejected','suppressed'].includes(row.status)||row.status==='suppressed'&&row.kind!=='founder-alert'||!iso(row.at)||row.status==='unknown'&&Object.hasOwn(row,'finishedAt')||row.status!=='unknown'&&(!iso(row.finishedAt)||Date.parse(row.finishedAt)<Date.parse(row.at)))bad();
    if(Object.hasOwn(row,'credential')){const c=row.credential;if(row.kind!=='email'||!c||typeof c!=='object'||Array.isArray(c)||Object.keys(c).sort().join(',')!=='purpose,tokenHash,userId'||!['password-reset','email-verification'].includes(c.purpose)||!Number.isSafeInteger(c.userId)||c.userId<1||!hash(c.tokenHash))bad();}
    attemptIds.add(row.id);operations.add(operation);
  }
  for(const name of ['team','projects','crews','reports','workdays','assignments','timeCards','photos']){
    const rows=db[name]||[],ids=new Set();if(!Array.isArray(rows))bad();
    for(const row of rows){if(!row||!Number.isSafeInteger(row.id)||row.id<1||ids.has(row.id)||row.companyId!==undefined&&row.companyId!==db.company.id)bad();ids.add(row.id);}
  }
  for(const user of db.users){
    if(user.memberId!=null&&!(db.team||[]).some(row=>row.id===user.memberId))bad();
    if((user.projectIds||[]).some(id=>!(db.projects||[]).some(row=>row.id===id)))bad();
  }
  const text=value=>typeof value==='string'&&value.length<=500&&!/[\u0000-\u001f]/.test(value);
  const memberIds=value=>Array.isArray(value)&&value.every(id=>Number.isSafeInteger(id)&&id>0&&(db.team||[]).some(row=>row.id===id))&&new Set(value).size===value.length;
  for(const row of db.team||[])if(!text(row.name)||row.crew!=null&&!text(row.crew))bad();
  for(const row of db.crews||[])if(!text(row.name)||row.memberIds!==undefined&&!memberIds(row.memberIds))bad();
  for(const row of db.assignments||[])if(!memberIds(row.memberIds)||!Number.isSafeInteger(row.projectId)||!(db.projects||[]).some(project=>project.id===row.projectId)||row.crew!=null&&!text(row.crew))bad();
  for(const row of db.workdays||[])if(!memberIds(row.memberIds)||!Number.isSafeInteger(row.projectId)||!(db.projects||[]).some(project=>project.id===row.projectId))bad();
  return db;
}
module.exports={validate};
