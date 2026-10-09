'use strict';
// Synthetic-only subscription refresh. Provider operations are finite named
// contracts, admitted durably before an attempt. No keys or network adapter.
const crypto=require('node:crypto');
const {canonicalHash}=require('./database/transactional-repository');
const {validateAccounts}=require('./account-evidence');
const {validateWorkspace}=require('./compat-workspace-evidence');
const {actorBinding}=require('./compat-workspace-delivery');
const founder=require('./founder-billing');
const jobs='workspaceBillingJobs',purpose='stored-subscription-refresh-v1';
const fail=(message='Billing refresh needs explicit reconciliation.')=>{throw Object.assign(Error(message),{statusCode:409});};
const closed=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).every(k=>keys.includes(k));
const identifier=(v,prefix)=>typeof v==='string'&&new RegExp('^'+prefix+'_[a-zA-Z0-9_]{1,100}$').test(v);
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
const instant=v=>typeof v==='string'&&Number.isFinite(Date.parse(v));
const equal=(a,b)=>canonicalHash(a??null)===canonicalHash(b??null);
const platformDescriptor=source=>({companyId:source.companyId,companyName:source.name,subscriptionId:source.subscriptionId,id:'assisted-setup-'+source.subscriptionId,package:'Assisted Setup'});
function syntheticPrices(plans) {const env={};for(const plan of Object.keys(plans))for(const cycle of ['monthly','annual'])for(const isFounder of [false,true])env[founder.priceKey(plan,cycle,isFounder)]='price_synthetic_'+(isFounder?'founder_':'')+plan+'_'+cycle;return env;}
function binding(company) {return {companyId:company.id,name:company.name,subscriptionId:company.stripeSubscriptionId,customerId:company.stripeCustomerId,founder:company.founder??null,trialEndsAt:company.trialEndsAt??null};}
const stateHash=company=>canonicalHash(Object.fromEntries(['plan','billingCycle','planPrice','stripeSubscriptionId','stripeTrialUsed','stripeCustomerId','subscriptionStatus','stripeFreePeriod','nextBillingAt','founder','accountType','cohort'].map(k=>[k,company[k]??null])));
function subscription(value,source,plans,env) {
  const allowed=['id','livemode','customer','metadata','status','items','current_period_start','current_period_end','latest_invoice','schedule','billing_cycle_anchor'];
  if(!closed(value,allowed)||value.id!==source.subscriptionId||value.customer!==source.customerId||value.livemode!==false||!closed(value.metadata,['company_id','offer','original_trial_end'])||value.metadata.company_id!==source.companyId||!['active','trialing','past_due','unpaid','paused','canceled','incomplete','incomplete_expired'].includes(value.status)||!closed(value.items,['data'])||!Array.isArray(value.items.data)||value.items.data.length!==1)fail('Subscription ownership could not be verified.');
  const item=value.items.data[0];if(!closed(item,['price','quantity','current_period_start','current_period_end'])||!closed(item.price,['id'])||!identifier(item.price.id,'price')||item.quantity!==1||!founder.identify(item.price.id,plans,env))fail('Subscription price could not be verified.');
  for(const v of [value.current_period_start,value.current_period_end,value.billing_cycle_anchor,item.current_period_start,item.current_period_end])if(v!==undefined&&(!Number.isSafeInteger(v)||v<=0||v>253402300799))fail();
  if(value.latest_invoice!=null&&!identifier(value.latest_invoice,'in')||value.schedule!=null&&!identifier(value.schedule,'sub_sched')||value.metadata.original_trial_end!==undefined&&!/^[1-9]\d{0,11}$/.test(value.metadata.original_trial_end))fail();
  require('./subscription-checkout').verifySubscription(value,source.subscriptionId,{id:source.companyId,stripeCustomerId:source.customerId},env);
  return structuredClone(value);
}
function schedule(value,descriptor) {
  if(!closed(value,['id','livemode','subscription','customer','metadata','phases','current_phase','end_behavior','proration_behavior'])||!identifier(value.id,'sub_sched')||descriptor.scheduleId&&value.id!==descriptor.scheduleId||value.subscription!==descriptor.subscriptionId||value.customer!==descriptor.customerId||value.livemode!==false||!closed(value.metadata,['company_id','pdl_founder_configured'])||value.metadata.company_id!==undefined&&value.metadata.company_id!==descriptor.companyId||!Array.isArray(value.phases)||value.phases.length!==1)fail('Founder schedule ownership could not be verified.');
  const phase=value.phases[0];if(!closed(phase,['start_date','end_date','items','proration_behavior'])||!Number.isSafeInteger(phase.start_date)||phase.start_date<=0||phase.end_date!==undefined&&(!Number.isSafeInteger(phase.end_date)||phase.end_date<=phase.start_date)||!Array.isArray(phase.items)||phase.items.length!==1||!closed(phase.items[0],['price','quantity'])||!identifier(phase.items[0].price,'price')||phase.items[0].quantity!==1)fail();
  if(descriptor.priceId&&phase.items[0].price!==descriptor.priceId||value.metadata.pdl_founder_configured==='1'&&(value.metadata.company_id!==descriptor.companyId||phase.end_date!==founder.addMonths(phase.start_date,24)||value.end_behavior!=='cancel'||phase.proration_behavior!=='none'))fail('Founder schedule terms could not be verified.');
  if(value.current_phase!==undefined&&(!closed(value.current_phase,['start_date','end_date'])||value.current_phase.start_date!==phase.start_date||value.current_phase.end_date!==undefined&&value.current_phase.end_date!==phase.end_date))fail();
  if(descriptor.kind==='configurePhases'&&(value.metadata.company_id!==descriptor.companyId||value.metadata.pdl_founder_configured!=='1'||phase.start_date!==descriptor.start||phase.end_date!==descriptor.end||phase.items[0].price!==descriptor.priceId||value.end_behavior!=='cancel'||value.proration_behavior!=='none'||phase.proration_behavior!=='none'))fail('Founder phase result could not be verified.');
  return structuredClone(value);
}
function result(value,descriptor,plans,env) {
  if(descriptor.kind==='subscription')return subscription(value,descriptor,plans,env);
  if(descriptor.kind==='invoice') {if(!closed(value,['id','livemode','customer','subscription','status'])||value.id!==descriptor.invoiceId||value.customer!==descriptor.customerId||value.subscription!==descriptor.subscriptionId||value.livemode!==false||!['paid','open','draft','void','uncollectible'].includes(value.status))fail('Founder invoice ownership could not be verified.');return structuredClone(value);}
  return schedule(value,descriptor);
}
function createBilling({repository,companyId,provider,platformSink,journal,authenticateSession,key,plans,apply,clock=Date.now}) {
  if(typeof provider!=='function'||typeof authenticateSession!=='function'||typeof apply!=='function'||!journal||typeof journal.record!=='function'||typeof journal.read!=='function'||!Buffer.isBuffer(key)||key.length!==32)throw Error('Explicit synthetic billing contracts required.');
  const env=syntheticPrices(plans);
  const sign=row=>{const copy={...row};delete copy.proof;row.proof=crypto.createHmac('sha256',key).update(purpose+':'+canonicalHash(copy)).digest('hex');return row;};
  function valid(db) {
    validateAccounts(db);validateWorkspace(db);const values=db[jobs]===undefined?[]:db[jobs],ids=new Set();
    if(!Array.isArray(values)||values.length>10000||Buffer.byteLength(JSON.stringify(values))>5000000)fail();
    for(const row of values) {
      if(!closed(row,['id','purpose','companyId','actorId','sessionHash','authority','source','sourceHash','status','createdAt','expiresAt','steps','proof','finishedAt','platformStep','platformReceipt','appliedCompanyHash'])||!uuid(row.id)||ids.has(row.id)||row.purpose!==purpose||row.companyId!==companyId||!Number.isSafeInteger(row.actorId)||![row.sessionHash,row.authority,row.sourceHash,row.proof].every(hash)||!instant(row.createdAt)||!instant(row.expiresAt)||Date.parse(row.expiresAt)<=Date.parse(row.createdAt)||Date.parse(row.expiresAt)>Date.parse(row.createdAt)+600000||!['queued','running','accepted','rejected','unknown','cancelled'].includes(row.status)||!closed(row.source,['companyId','name','subscriptionId','customerId','founder','trialEndsAt'])||row.source.companyId!==companyId||!identifier(row.source.subscriptionId,'sub')||!identifier(row.source.customerId,'cus')||canonicalHash(row.source)!==row.sourceHash||!Array.isArray(row.steps)||row.steps.length>5||row.appliedCompanyHash!==undefined&&!hash(row.appliedCompanyHash))fail();
      const copy={...row};delete copy.proof;if(!crypto.timingSafeEqual(Buffer.from(row.proof,'hex'),Buffer.from(crypto.createHmac('sha256',key).update(purpose+':'+canonicalHash(copy)).digest('hex'),'hex')))fail();
      const kinds=new Set();for(const step of row.steps){if(!closed(step,['kind','descriptor','idempotencyKey','status','attemptId','result','finishedAt'])||!['subscription','invoice','scheduleRead','scheduleCreate','configurePhases'].includes(step.kind)||kinds.has(step.kind)||!uuid(step.attemptId)||!['sending','accepted','rejected','unknown'].includes(step.status)||step.idempotencyKey!==companyId+':'+row.source.subscriptionId+':'+step.kind||!closed(step.descriptor,['kind','companyId','subscriptionId','customerId','invoiceId','scheduleId','priceId','start','end'])||step.descriptor.kind!==step.kind||step.descriptor.companyId!==companyId||step.descriptor.subscriptionId!==row.source.subscriptionId||step.descriptor.customerId!==row.source.customerId)fail();if(step.status==='accepted'){if(!step.result)fail();result(step.result,step.descriptor,plans,env);}else if(step.result!==undefined)fail();kinds.add(step.kind);}
      if(row.platformReceipt!==undefined&&(!closed(row.platformReceipt,['id','companyId','subscriptionId','sourceHash','status'])||row.platformReceipt.companyId!==companyId||row.platformReceipt.subscriptionId!==row.source.subscriptionId||row.platformReceipt.id!=='assisted-setup-'+row.source.subscriptionId||!hash(row.platformReceipt.sourceHash)||row.platformReceipt.status!=='accepted'))fail();
      if(row.platformStep!==undefined&&(!closed(row.platformStep,['attemptId','descriptor','status'])||Object.keys(row.platformStep).length!==3||!uuid(row.platformStep.attemptId)||!equal(row.platformStep.descriptor,platformDescriptor(row.source))||!['sending','accepted'].includes(row.platformStep.status)||row.platformStep.status==='accepted'&&!row.platformReceipt||row.platformReceipt&&row.platformReceipt.sourceHash!==canonicalHash(row.platformStep.descriptor)))fail();
      if(row.platformReceipt!==undefined&&!row.platformStep)fail();
      ids.add(row.id);
    }
    return values;
  }
  function current(db,job) {valid(db);const auth=authenticateSession(db,job.sessionHash);return auth&&auth.companyId===companyId&&auth.user.id===job.actorId&&auth.user.role==='owner'&&Date.parse(auth.session.expiresAt)>clock()&&Date.parse(job.expiresAt)>clock()&&actorBinding(db,auth)===job.authority&&equal(binding(db.company),job.source)?auth:null;}
  function stage(db,req,force=false) {
    const ledger=valid(db),source=binding(db.company);if(!source.subscriptionId)return null;
    if(!identifier(source.subscriptionId,'sub')||!identifier(source.customerId,'cus'))fail('Stored subscription ownership needs reconciliation.');
    const auth=authenticateSession(db,req.auth.session.tokenHash);if(!auth||auth.user.role!=='owner'||auth.companyId!==companyId||actorBinding(db,auth)!==actorBinding(db,req.auth)||Date.parse(auth.session.expiresAt)<=clock())fail();
    const pending=ledger.find(row=>row.source.subscriptionId===source.subscriptionId&&['queued','running','unknown'].includes(row.status));
    if(pending)return pending.id;
    // Every ordinary billing opening observes the stored subscription again.
    // Only an unresolved attempt is reused; local state cannot certify the
    // provider's current status indefinitely.
    const at=clock(),job=sign({id:crypto.randomUUID(),purpose,companyId,actorId:auth.user.id,sessionHash:auth.session.tokenHash,authority:actorBinding(db,auth),source,sourceHash:canonicalHash(source),status:'queued',createdAt:new Date(at).toISOString(),expiresAt:new Date(Math.min(at+600000,Date.parse(auth.session.expiresAt))).toISOString(),steps:[]});
    ledger.push(job);db[jobs]=ledger;valid(db);return job.id;
  }
  async function load(expected){const loaded=await repository.load(companyId);if(!loaded||loaded.contentHash!==canonicalHash(loaded.snapshot)||expected&&(loaded.revision!==expected.revision||loaded.contentHash!==expected.contentHash))fail();valid(loaded.snapshot);return loaded;}
  async function commit(db,revision,deadline){const saved=await repository.commit(db,revision,deadline?{deadline}:undefined);if(saved.revision!==revision+1||saved.contentHash!==canonicalHash(db))fail();return saved;}
  async function dispatch(id,expected,recover=false) {
    let loaded=await load(expected),db=loaded.snapshot,job=valid(db).find(r=>r.id===id);if(!job)fail();
    if(['accepted','rejected','unknown','cancelled'].includes(job.status))return {status:job.status,revision:loaded.revision,contentHash:loaded.contentHash};
    const pending=job.steps.find(s=>s.status==='sending'||s.status==='unknown');
    if(pending){
      const fact=await journal.read(companyId,pending.attemptId);
      if(fact&&(fact.jobId!==job.id||fact.kind!==pending.kind||fact.descriptorHash!==canonicalHash(pending.descriptor)||fact.admissionHash!==canonicalHash(job)))fail('Billing observation does not match its admitted attempt.');
      if(!recover)return {status:'unknown',observed:fact?.status||'unknown',jobId:job.id,revision:loaded.revision,contentHash:loaded.contentHash};
      if(!current(db,job)||!fact||fact.status!=='accepted')fail('This outcome cannot be resumed by the current originating owner session.');
      result(fact.value,pending.descriptor,plans,env);pending.status='accepted';pending.result=fact.value;pending.finishedAt=new Date(clock()).toISOString();sign(job);
      expected=await commit(db,loaded.revision,new Date(Math.min(Date.parse(job.expiresAt),Date.parse(authenticateSession(db,job.sessionHash).session.expiresAt))).toISOString());loaded=await load(expected);db=loaded.snapshot;job=valid(db).find(r=>r.id===id);
    }
    if(job.platformStep?.status==='sending'){
      if(!platformSink||typeof platformSink.read!=='function')fail('Platform setup needs its independent observation contract.');
      const receipt=await platformSink.read(job.platformStep.descriptor);
      if(!recover)return {status:'unknown',observed:receipt?'accepted':'unknown',jobId:job.id,revision:loaded.revision,contentHash:loaded.contentHash};
      const auth=current(db,job);if(!auth||!receipt)fail('This setup outcome cannot be resumed by the current originating owner session.');
      job.platformStep.status='accepted';job.platformReceipt=receipt;sign(job);expected=await commit(db,loaded.revision,new Date(Math.min(Date.parse(job.expiresAt),Date.parse(auth.session.expiresAt))).toISOString());loaded=await load(expected);db=loaded.snapshot;job=valid(db).find(r=>r.id===id);
    }
    let auth=current(db,job);if(!auth){job.status='cancelled';sign(job);return {status:'cancelled',...await commit(db,loaded.revision)};}
    const deadline=new Date(Math.min(Date.parse(auth.session.expiresAt),Date.parse(job.expiresAt))).toISOString();
    async function invoke(descriptor) {
      loaded=await load(expected);db=loaded.snapshot;job=valid(db).find(r=>r.id===id);if(!current(db,job))fail();
      let step=job.steps.find(r=>r.kind===descriptor.kind);
      if(step){if(!equal(step.descriptor,descriptor)||step.status!=='accepted')fail();return structuredClone(step.result);}
      step={kind:descriptor.kind,descriptor:structuredClone(descriptor),idempotencyKey:companyId+':'+job.source.subscriptionId+':'+descriptor.kind,status:'sending',attemptId:crypto.randomUUID()};job.status='running';job.steps.push(step);sign(job);expected=await commit(db,loaded.revision,deadline);
      const admissionHash=canonicalHash(job);
      loaded=await load(expected);db=loaded.snapshot;job=valid(db).find(r=>r.id===id);if(!current(db,job))fail();
      let receipt;try{receipt=await provider(structuredClone(descriptor),{idempotencyKey:step.idempotencyKey});}catch{receipt={status:'unknown'};}
      let outcome='unknown',value;
      if(closed(receipt,['status','value'])&&receipt.status==='accepted'&&Object.keys(receipt).length===2){try{value=result(receipt.value,descriptor,plans,env);outcome='accepted';}catch{/* Contradictory/foreign acceptance is an unknown outcome. */}}
      else if(closed(receipt,['status'])&&Object.keys(receipt).length===1&&['rejected','unknown'].includes(receipt.status))outcome=receipt.status;
      await journal.record({jobId:job.id,attemptId:step.attemptId,companyId,kind:step.kind,descriptorHash:canonicalHash(descriptor),admissionHash,status:outcome,value:outcome==='accepted'?value:null});
      // Preserve known provider acceptance separately from business activation.
      // CAS ownership loss leaves the durable sending marker; it never resends.
      loaded=await load(expected);db=loaded.snapshot;job=valid(db).find(r=>r.id===id);step=job.steps.find(r=>r.kind===descriptor.kind);if(!step||step.status!=='sending')fail();
      step.status=outcome;step.finishedAt=new Date(clock()).toISOString();if(outcome==='accepted')step.result=value;else job.status=outcome;sign(job);expected=await commit(db,loaded.revision);
      if(outcome!=='accepted')throw Object.assign(Error('Billing provider outcome requires review.'),{billingOutcome:outcome});
      if(!current(db,job))fail();return value;
    }
    const base={companyId,subscriptionId:job.source.subscriptionId,customerId:job.source.customerId};
    try {
      const sub=await invoke({kind:'subscription',...base});
      loaded=await load(expected);db=loaded.snapshot;job=valid(db).find(r=>r.id===id);const candidate=structuredClone(db),nonCompany=canonicalHash(Object.fromEntries(Object.entries(candidate).filter(([k])=>k!=='company')));
      const adapter=async(path,params,method='POST')=>{
        if(method==='GET'&&path==='/invoices/'+sub.latest_invoice)return invoke({kind:'invoice',...base,invoiceId:sub.latest_invoice});
        if(method==='GET'&&path==='/subscription_schedules/'+sub.schedule)return invoke({kind:'scheduleRead',...base,scheduleId:sub.schedule,priceId:sub.items.data[0].price.id});
        if(method==='POST'&&path==='/subscription_schedules'&&equal(params,{from_subscription:sub.id}))return invoke({kind:'scheduleCreate',...base,priceId:sub.items.data[0].price.id});
        const scheduleId=path.startsWith('/subscription_schedules/')?path.slice('/subscription_schedules/'.length):null;
        const wanted={end_behavior:'cancel',proration_behavior:'none','metadata[pdl_founder_configured]':'1','metadata[company_id]':companyId,'phases[0][start_date]':params?.['phases[0][start_date]'],'phases[0][end_date]':params?.['phases[0][end_date]'],'phases[0][items][0][price]':sub.items.data[0].price.id,'phases[0][items][0][quantity]':1,'phases[0][proration_behavior]':'none'};
        if(method==='POST'&&identifier(scheduleId,'sub_sched')&&equal(params,wanted)&&Number.isSafeInteger(wanted['phases[0][start_date]'])&&wanted['phases[0][end_date]']===founder.addMonths(wanted['phases[0][start_date]'],24))return invoke({kind:'configurePhases',...base,scheduleId,priceId:sub.items.data[0].price.id,start:wanted['phases[0][start_date]'],end:wanted['phases[0][end_date]']});
        fail('Unclassified billing operation.');
      };
      const info=await founder.prepareSubscription(candidate,sub,plans,adapter,env),contract={info,assistedSetup:false};await apply(candidate,sub,contract);
      loaded=await load(expected);db=loaded.snapshot;job=valid(db).find(r=>r.id===id);if(!current(db,job))fail();
      if(nonCompany!==canonicalHash(Object.fromEntries(Object.entries(candidate).filter(([k])=>k!=='company'))))fail('Billing helper changed unrelated company data.');
      // The local helper may change company billing fields only. Its input copy
      // predates provider receipts; copy just company into the current snapshot.
      const sourceCompany=structuredClone(db.company), nextCompany=candidate.company;
      const allowed=['plan','billingCycle','planPrice','stripeSubscriptionId','stripeTrialUsed','stripeCustomerId','subscriptionStatus','stripeFreePeriod','nextBillingAt','founder','accountType','cohort'];
      for(const name of new Set([...Object.keys(sourceCompany),...Object.keys(nextCompany)]))if(!allowed.includes(name)&&!equal(sourceCompany[name],nextCompany[name]))fail('Unsupported billing state change.');
      if(contract.assistedSetup) {
        if(!platformSink||typeof platformSink.ensure!=='function'||typeof platformSink.read!=='function')fail('Assisted Setup needs its independent reviewed sink.');
        const descriptor=platformDescriptor(job.source);
        if(!job.platformStep){job.platformStep={attemptId:crypto.randomUUID(),descriptor,status:'sending'};sign(job);expected=await commit(db,loaded.revision,deadline);loaded=await load(expected);db=loaded.snapshot;job=valid(db).find(r=>r.id===id);if(!current(db,job))fail();}
        if(job.platformStep.status!=='accepted'){
          const receipt=await platformSink.ensure(descriptor,{idempotencyKey:descriptor.id,deadline,assertCurrent:async()=>{const l=await load(expected);if(!current(l.snapshot,valid(l.snapshot).find(r=>r.id===id)))fail();}});
          if(!closed(receipt,['id','companyId','subscriptionId','sourceHash','status'])||receipt.status!=='accepted'||receipt.id!==descriptor.id||receipt.companyId!==companyId||receipt.subscriptionId!==sub.id||receipt.sourceHash!==canonicalHash(descriptor))fail('Platform setup receipt could not be verified.');
          loaded=await load(expected);db=loaded.snapshot;job=valid(db).find(r=>r.id===id);if(!current(db,job))fail();job.platformStep.status='accepted';job.platformReceipt=receipt;
        }
      }
      db.company=nextCompany;job.status='accepted';job.appliedCompanyHash=stateHash(db.company);job.finishedAt=new Date(clock()).toISOString();sign(job);db.auditLog||=[];db.auditLog.push({id:crypto.randomUUID(),type:'billing_subscription_refreshed',actorId:job.actorId,at:job.finishedAt});expected=await commit(db,loaded.revision,deadline);
      return {status:'accepted',...expected};
    } catch(error) {
      if(error.billingOutcome)return {status:error.billingOutcome,...expected};throw error;
    }
  }
  return {stage,dispatch,valid};
}
module.exports={createBilling,syntheticPrices,subscription,schedule,jobs};
