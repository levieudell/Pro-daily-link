'use strict';
// Existing platform company operations keep immutable platform-owner authority.
// Their tenant data uses the same managed snapshot CAS as normal routes.
const {canonicalHash}=require('./database/transactional-repository');
const fail=(statusCode,message)=>{throw Object.assign(Error(message),{statusCode});};
function createHandler(h){
  return async function handle(req,res,url){
    const match=/^\/api\/platform\/companies\/([^/]+)\/(roles-authority|features|owner-reset|subscription|demo-reset)$/.exec(url.pathname);
    if(!match)return false;
    const companyId=decodeURIComponent(match[1]),service=h.service();
    if(!service?.has(companyId)){await h.assertUnmanaged(companyId);if(match[2]==='roles-authority'){h.json(res,200,{managed:false});return true;}return false;}
    const opening=h.platformIdentity(req);if(!opening)fail(403,'Active platform owner permission required');
    const current=()=>{const value=h.platformIdentity(req);if(!value||canonicalHash(value)!==canonicalHash(opening))fail(403,'Current platform owner permission required');return value;};
    const row=await service.repository.load(companyId);current();
    if(match[2]==='roles-authority'&&req.method==='GET'){h.json(res,200,{managed:true,companyId,expectedRevision:row.revision,authorizedUntil:opening.expiresAt});return true;}
    const methods={features:'PATCH','owner-reset':'POST',subscription:'PATCH','demo-reset':'POST'};
    if(req.method!==methods[match[2]])fail(405,'Method not allowed');
    const input=await h.body(req);current();
    if(!input||Array.isArray(input)||!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<0)fail(409,'Refresh the current company revision before changing it');
    const kind={features:'platform-features','owner-reset':'platform-owner-reset',subscription:'platform-commercial','demo-reset':'platform-demo-reset'}[match[2]];
    const result=await service.system(companyId,kind,async db=>{
      let result;
      if(match[2]==='features'){
        if(Object.keys(input).some(key=>!['expectedRevision','timeCards','templates'].includes(key))||!['timeCards','templates'].some(key=>typeof input[key]==='boolean')||['timeCards','templates'].some(key=>Object.hasOwn(input,key)&&typeof input[key]!=='boolean'))fail(400,'Choose a typed feature switch');
        db.company.features={...db.company.features};for(const key of ['timeCards','templates'])if(Object.hasOwn(input,key))db.company.features[key]=input[key];
        result={id:companyId,timeCards:db.company.features.timeCards===true,templates:db.company.features.templates===true};
      }else if(match[2]==='owner-reset'){
        if(Object.keys(input).some(key=>key!=='expectedRevision'))fail(400,'Owner reset accepts no account overrides');
        const owners=db.users.filter(user=>user.role==='owner'&&user.status==='Active');if(owners.length!==1)fail(409,'Active company owner needs reconciliation');
        const owner=owners[0],issued=h.ownerCredential();Object.assign(owner,issued.fields);delete owner.passwordHash;delete owner.passwordSalt;
        db.sessions=(db.sessions||[]).filter(session=>session.userId!==owner.id);
        result={companyId,email:owner.email,setupCode:issued.code,expiresAt:owner.setupExpiresAt};
      }else if(match[2]==='subscription'){
        const fields=['plan','planPrice','status','nextBillingAt','accountType','billingExempt','cohort','discountPercent','commercialNote'];
        if(Object.keys(input).some(key=>!fields.includes(key)&&key!=='expectedRevision'))fail(400,'Unsupported commercial field');
        for(const key of ['plan','nextBillingAt','cohort','commercialNote'])if(Object.hasOwn(input,key)&&typeof input[key]!=='string')fail(400,'Commercial text must be a string');
        for(const key of ['planPrice','discountPercent'])if(Object.hasOwn(input,key)&&(typeof input[key]!=='number'||!Number.isFinite(input[key])||input[key]<0||key==='discountPercent'&&input[key]>100))fail(400,'Enter a valid commercial amount');
        if(Object.hasOwn(input,'status')&&!['Trial','Active','Past due','Paused','Cancelled'].includes(input.status)||Object.hasOwn(input,'accountType')&&!['standard','early_adopter','legacy'].includes(input.accountType)||Object.hasOwn(input,'billingExempt')&&typeof input.billingExempt!=='boolean')fail(400,'Enter valid account settings');
        for(const key of fields)if(Object.hasOwn(input,key))db.company[key==='status'?'subscriptionStatus':key]=typeof input[key]==='string'?input[key].slice(0,({plan:40,nextBillingAt:10,cohort:80,commercialNote:500}[key]||40)):input[key];
        const company=db.company;result={id:companyId,plan:company.plan,planPrice:company.planPrice,status:h.accountAccess(company).status,accountType:company.accountType||'standard',billingExempt:Boolean(company.billingExempt),cohort:company.cohort||'',discountPercent:Number(company.discountPercent)||0,nextBillingAt:company.nextBillingAt||null};
      }else fail(409,'Managed tenant demo replacement requires a separately reviewed retention operation');
      const at=new Date().toISOString();db.auditLog||=[];db.auditLog.push({id:h.uuid(),type:kind,platformActorId:opening.actorId,at,expectedRevision:input.expectedRevision});h.writeDb(db);
      return result;
    },{expectedRevision:input.expectedRevision,authority:current,authorizedUntil:opening.expiresAt});
    current();h.json(res,200,result);return true;
  };
}
module.exports={createHandler};
