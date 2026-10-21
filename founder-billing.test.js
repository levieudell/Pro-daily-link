const assert = require('node:assert/strict');
const billing = require('./founder-billing');
const stripePricePolicy = require('./stripe-price-policy');
async function run(){
  const env={PDL_FOUNDER_ENABLED:'1',PDL_FOUNDER_CODE:'TEST-INVITE',STRIPE_SECRET_KEY:'sk_test_synthetic',STRIPE_WEBHOOK_SECRET:'synthetic'};
  const plans={starter:{price:99,annualPrice:990},growth:{price:199,annualPrice:1990},pro:{price:399,annualPrice:3990}};
  for(const plan of Object.keys(plans))for(const cycle of ['monthly','annual'])for(const founder of [true,false])env[billing.priceKey(plan,cycle,founder)]='price_'+plan+'_'+cycle+'_'+founder;
  env.STRIPE_PRICE_ASSISTED_SETUP='price_setup';
  for(const key of stripePricePolicy.PRODUCT_KEYS)env[key]='prod_'+key.toLowerCase();
  assert.equal(billing.validCode(' test-invite ',env),true);
  assert.equal(billing.validCode('wrong',env),false);
  assert.equal(billing.validCode('TEST-INVITE',{...env,PDL_FOUNDER_ENABLED:'0'}),false);
  assert.equal(billing.enroll({plan:'starter'},env),null);
  assert.throws(()=>billing.enroll({founderCode:'wrong'},env),/invalid/);
  assert.throws(()=>billing.enroll({founderCode:'TEST-INVITE',plan:'starter'},env),/Accept/);
  const input={founderCode:'TEST-INVITE',plan:'starter',billingCycle:'monthly',founderTermsAccepted:true,assistedSetup:true};
  const enrollment=billing.enroll(input,env),company={id:'company_test',founder:enrollment};
  assert.equal(enrollment.assistedSetup,true);
  assert.equal(JSON.stringify(enrollment).includes('TEST-INVITE'),false);
  const choice=billing.checkout(company,input,env);
  assert.equal(choice.priceId,env.STRIPE_PRICE_FOUNDER_STARTER);
  assert.equal(choice.amount,79);
  assert.equal(choice.setup,true);
  assert.throws(()=>billing.checkout({...company,stripeSubscriptionId:'sub_existing'},input,env),/existing/);
  assert.throws(()=>billing.checkout(company,{...input,plan:'pro'},env),/selected at signup/);
  assert.equal(billing.checkout({},input,env).founder,false);
  for(const plan of Object.keys(plans))for(const cycle of ['monthly','annual']){
    const id=env[billing.priceKey(plan,cycle,true)],info=billing.identify(id,plans,env);
    assert.equal(info.plan,plan);assert.equal(info.cycle,cycle);assert.equal(info.amount,billing.PRICES[plan][cycle]);
  }
  assert.equal(billing.identify('unknown',plans,env),null);
  const founderStarter=env.STRIPE_PRICE_FOUNDER_STARTER;
  const good={id:founderStarter,active:true,livemode:false,currency:'usd',unit_amount:7900,custom_unit_amount:null,
    billing_scheme:'per_unit',transform_quantity:null,tiers_mode:null,type:'recurring',
    product:{id:env.STRIPE_PRODUCT_FOUNDER_STARTER,active:true,livemode:false},
    recurring:{interval:'month',interval_count:1,usage_type:'licensed',aggregate_usage:null,meter:null}};
  await billing.validatePrice(async()=>good,founderStarter,79,'monthly',env);
  for(const changed of [{livemode:true},{unit_amount:9900},{active:false},{currency:'eur'},{billing_scheme:'tiered'},
    {transform_quantity:{divide_by:10,round:'up'}},{product:{...good.product,active:false}},
    {product:{...good.product,id:'prod_wrong'}},{recurring:{...good.recurring,interval:'year'}},
    {recurring:{...good.recurring,usage_type:'metered'}}]){
    await assert.rejects(billing.validatePrice(async()=>({...good,...changed}),founderStarter,79,'monthly',env),/configuration/);
  }
  const leap=Date.UTC(2024,1,29)/1000;
  assert.equal(new Date(billing.addMonths(leap,24)*1000).toISOString().slice(0,10),'2026-02-28');
  for(const cycle of ['monthly','annual']){
    const db={company:{id:'company_test',founder:{...enrollment,billingCycle:cycle}}};
    const priceId=env[billing.priceKey('starter',cycle,true)];
    const subscription={id:'sub_test_'+cycle,status:'active',customer:'cus_test',metadata:{company_id:'company_test',offer:'founder'},items:{data:[{price:{id:priceId}}]},latest_invoice:'in_test'};
    const calls=[],start=Date.UTC(2026,8,28)/1000;
    const request=async(path,params,method,key)=>{
      calls.push({path,params,method,key});
      if(path==='/invoices/in_test')return {status:'paid'};
      if(path==='/subscription_schedules')return {id:'sched_test',current_phase:{start_date:start}};
      if(path==='/subscription_schedules/sched_test')return {id:'sched_test',metadata:{pdl_founder_configured:'1'},phases:[{start_date:start}]};
      throw Error('Unexpected request '+path);
    };
    await billing.prepareSubscription(db,subscription,plans,request,env);
    assert.equal(db.company.accountType,'early_adopter');
    assert.equal(db.company.founder.protectedUntil,'2028-09-28T00:00:00.000Z');
    const update=calls.find(call=>call.path==='/subscription_schedules/sched_test');
    assert.equal(update.params.end_behavior,'cancel');
    assert.equal(Object.keys(update.params).some(key=>key.startsWith('phases[1]')),false);
    assert.equal(update.params['phases[0][end_date]'],Date.UTC(2028,8,28)/1000);
    assert.ok(update.key);
    calls.length=0;
    await billing.prepareSubscription(db,{...subscription,schedule:'sched_test'},plans,request,env);
    assert.equal(calls.some(call=>call.method==='POST'),false);
    await assert.rejects(billing.prepareSubscription(db,{...subscription,metadata:{company_id:'other',offer:'founder'}},plans,request,env),/does not match/);
    await assert.rejects(billing.prepareSubscription(db,subscription,plans,async(path,...args)=>path==='/invoices/in_test'?{status:'open'}:request(path,...args),env),/Waiting/);
  }
  {
    const end=Date.parse('2028-09-28T00:00:00.000Z'),reviewCompany={subscriptionStatus:'Active',founder:{requested:true,renewalReviewRequired:true,protectedUntil:new Date(end).toISOString()}};
    const atDays=days=>new Date(end-days*86400000);
    assert.deepEqual(billing.renewalReview({},atDays(89)),{eligible:false});
    assert.equal(billing.renewalReview(reviewCompany,atDays(91)).status,'scheduled');
    assert.equal(billing.renewalReview(reviewCompany,atDays(91)).nextReminderDays,90);
    const ninety=billing.queueRenewalReview(reviewCompany,atDays(89));
    assert.equal(ninety.days,90);assert.equal(ninety.attempt,1);
    assert.equal(billing.queueRenewalReview(reviewCompany,new Date(atDays(89).valueOf()+3600000)),null,'pending reminders retry at most daily');
    assert.equal(billing.settleRenewalReview(reviewCompany,90,{sent:true},atDays(89)),true);
    assert.equal(reviewCompany.founder.renewalReminders['90'].status,'sent');
    const sixty=billing.queueRenewalReview(reviewCompany,atDays(59));
    assert.equal(sixty.days,60);
    billing.settleRenewalReview(reviewCompany,60,{sent:false,reason:'email-not-configured'},atDays(59));
    assert.equal(reviewCompany.founder.renewalReminders['60'].status,'pending');
    const thirty=billing.queueRenewalReview(reviewCompany,atDays(29));
    assert.equal(thirty.days,30,'a missed reminder window advances to the most urgent milestone without sending a stack of stale emails');
    assert.equal(reviewCompany.founder.renewalReminders['60'].status,'superseded');
    billing.settleRenewalReview(reviewCompany,30,{sent:false,reason:'disabled'},atDays(29));
    assert.equal(reviewCompany.founder.renewalReminders['30'].status,'suppressed');
    assert.equal(billing.renewalReview(reviewCompany,new Date(end+1000)).status,'overdue');
  }
  console.log('Founder billing policy and mocked Stripe checks passed (no live API calls).');
}
module.exports=run;
if(require.main===module)run().catch(error=>{console.error(error);process.exitCode=1});
