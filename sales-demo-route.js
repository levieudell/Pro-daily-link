'use strict';
const crypto=require('node:crypto');
const {FIXTURE}=require('./sales-demo-data');
const {prepareEmptyDemoTenant}=require('./sales-demo-install');
const ROUTE=/^\/api\/platform\/companies\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/sales-demo$/i;
function createSalesDemoHandler({platformAllowed,withTenantQueue,requestDatabase,freshestTenantSnapshot,primaryCompanyId,readBody,reply,companyToday,contextRun,writeDb,backup}) {
 return async function handleSalesDemo(req,res,url) {
  const match=url.pathname.match(ROUTE);if(!match)return false;
  // Require ordinary authenticated platform owner. API keys, auth-disabled demos,
  // ordinary company owners and platform staff cannot initialize this data.
  if(!platformAllowed(req)||req.platformAuth?.user?.role!=='platform_owner'||!req.platformAuth?.session){reply(res,403,{error:'A signed-in platform owner is required'});return true;}
  if(!['GET','POST'].includes(req.method)){reply(res,405,{error:'Method not allowed'});return true;}
  const companyId=match[1];
  if(companyId===primaryCompanyId()){reply(res,409,{error:'The primary workspace cannot be seeded'});return true;}
  try {
   await withTenantQueue(companyId,async()=>{
    const database=await requestDatabase({headers:{'x-pdl-company':companyId}}),target=database&&freshestTenantSnapshot(database);
    if(!target||target.company.id!==companyId){reply(res,404,{error:'Company not found'});return;}
    const asOf=companyToday(),expectedRevision=Number(target.company.persistence?.revision||0),alreadyPrepared=target.company.demoFixture===FIXTURE;
    if(!Number.isSafeInteger(expectedRevision)||expectedRevision<0)throw Object.assign(new Error('Company revision cannot be verified'),{statusCode:409});
    const describe=db=>({companyId,companyName:db.company.name,asOf,demoAsOf:db.company.demoAsOf||null,expectedRevision,alreadyPrepared,url:`/app?tenant=${encodeURIComponent(companyId)}`,counts:Object.fromEntries(['projects','team','reports','timeCards','assignments'].map(k=>[k,(db[k]||[]).length]))});
    let prepared;
    try {
     if(alreadyPrepared){
      if(target.company.demo!==true||target.company.billingExempt!==true||target.company.name!=='DEMO | Alder Ridge Builders'||target.company.stripeCustomerId||target.company.stripeSubscriptionId)throw new Error('The prepared demo metadata changed; review it before proceeding');
      prepared=target;
     } else {
      const created=Date.parse(target.company.createdAt);if(!Number.isFinite(created)||Date.now()-created>86400000||created>Date.now()+60000)throw new Error('Use a new dedicated demo company created within the last 24 hours');
      prepared=prepareEmptyDemoTenant(target,{expectedCompanyId:companyId,asOf});
     }
    } catch(error){throw Object.assign(error,{statusCode:409});}
    if(req.method==='GET'){reply(res,200,{...describe(target),readyToPrepare:!alreadyPrepared,plannedCounts:describe(prepared).counts});return;}
    const input=await readBody(req);
    if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['expectedRevision','confirmCompanyName','asOf'].includes(k))||input.confirmCompanyName!==target.company.name||input.asOf!==asOf||input.expectedRevision!==expectedRevision){reply(res,409,{error:'Refresh the demo preview and confirm the exact company and current revision'});return;}
    const context={...database,db:target,pending:[],backup:null,deferResponse:true};
    if(!alreadyPrepared){
     // The pre-seed backup must be verified before the first mutation. Never
     // return any owner or session contents in the receipt.
     const receipt=await backup(target);
     prepared.company.demoRecovery={snapshotSha256:receipt.snapshotSha256,createdAt:receipt.createdAt};
     prepared.auditLog.push({id:crypto.randomUUID(),type:'sales_demo_prepared',actor:req.platformAuth.user.name,actorId:req.platformAuth.user.id,at:new Date().toISOString(),detail:'One-time synthetic sales history installed in a separately created empty tenant; existing login and sessions preserved.'});
    }
    await contextRun(context,async()=>{
      writeDb(prepared);
      const outcomes=await Promise.allSettled(context.pending),failed=outcomes.find(outcome=>outcome.status==='rejected');
      if(failed)throw failed.reason;
    });
    // A repeat is a safe persistence retry, never a reset. Current records are
    // preserved, and success is sent only after the normal durable writes finish.
    reply(res,alreadyPrepared?200:201,{...describe(prepared),expectedRevision:Number(prepared.company.persistence?.revision||0),alreadyPrepared,prepared:true});
   });
  } catch(error){reply(res,error.statusCode||503,{error:error.statusCode?error.message:'Demo preparation could not be confirmed. No reset was performed. Refresh and retry this same company.'});}
  return true;
 };
}
module.exports={ROUTE,createSalesDemoHandler};
