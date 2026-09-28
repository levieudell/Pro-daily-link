const assert = require('node:assert/strict');
const billing = require('./founder-billing');
async function run(){
  const env={PDL_FOUNDER_ENABLED:'1',PDL_FOUNDER_CODE:'TEST-INVITE',STRIPE_SECRET_KEY:'sk_test_synthetic',STRIPE_WEBHOOK_SECRET:'synthetic'};
  const plans={starter:{price:99,annualPrice:990},growth:{price:199,annualPrice:1990},pro:{price:399,annualPrice:3990}};
  for(const plan of Object.keys(plans))for(const cycle of ['monthly','annual'])for(const founder of [true,false])env[billing.priceKey(plan,cycle,founder)]='price_'+plan+'_'+cycle+'_'+founder;
  env.STRIPE_PRICE_ASSISTED_SETUP='price_setup';
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
  const good={id:'price_test',active:true,livemode:false,currency:'usd',unit_amount:7900,type:'recurring',recurring:{interval:'month',interval_count:1}};
  await billing.validatePrice(async()=>good,'price_test',79,'monthly',env);
  for(const changed of [{livemode:true},{unit_amount:9900},{active:false},{currency:'eur'},{recurring:{interval:'year',interval_count:1}}]){
    await assert.rejects(billing.validatePrice(async()=>({...good,...changed}),'price_test',79,'monthly',env),/configuration/);
  }
  const leap=Date.UTC(2024,1,29)/1000;
  assert.equal(new Date(billing.addMonths(leap,24)*1000).toISOString().slice(0,10),'2026-02-28');
  for(const cycle of ['monthly','annual']){
    const db={company:{id:'company_test',founder:{...enrollment,billingCycle:cycle}}};
    const priceId=env[billing.priceKey('starter',cycle,true)],standard=env[billing.priceKey('starter',cycle)];
    const subscription={id:'sub_test_'+cycle,status:'active',customer:'cus_test',metadata:{company_id:'company_test',offer:'founder'},items:{data:[{price:{id:priceId}}]},latest_invoice:'in_test'};
    const calls=[],start=Date.UTC(2026,8,28)/1000;
    const request=async(path,params,method,key)=>{
      calls.push({path,params,method,key});
      if(path==='/invoices/in_test')return {status:'paid'};
      if(path==='/prices/'+standard)return {id:standard,active:true,livemode:false,currency:'usd',unit_amount:(cycle==='annual'?990:99)*100,type:'recurring',recurring:{interval:cycle==='annual'?'year':'month',interval_count:1}};
      if(path==='/subscription_schedules')return {id:'sched_test',current_phase:{start_date:start}};
      if(path==='/subscription_schedules/sched_test')return {id:'sched_test',metadata:{pdl_founder_configured:'1'},phases:[{start_date:start}]};
      throw Error('Unexpected request '+path);
    };
    await billing.prepareSubscription(db,subscription,plans,request,env);
    assert.equal(db.company.accountType,'early_adopter');
    assert.equal(db.company.founder.protectedUntil,'2028-09-28T00:00:00.000Z');
    const update=calls.find(call=>call.path==='/subscription_schedules/sched_test');
    assert.equal(update.params['phases[1][items][0][price]'],standard);
    assert.equal(update.params['phases[0][end_date]'],Date.UTC(2028,8,28)/1000);
    assert.ok(update.key);
    calls.length=0;
    await billing.prepareSubscription(db,{...subscription,schedule:'sched_test'},plans,request,env);
    assert.equal(calls.some(call=>call.method==='POST'),false);
    await assert.rejects(billing.prepareSubscription(db,{...subscription,metadata:{company_id:'other',offer:'founder'}},plans,request,env),/does not match/);
    await assert.rejects(billing.prepareSubscription(db,subscription,plans,async(path,...args)=>path==='/invoices/in_test'?{status:'open'}:request(path,...args),env),/Waiting/);
  }
  console.log('Founder billing policy and mocked Stripe checks passed (no live API calls).');
}
module.exports=run;
if(require.main===module)run().catch(error=>{console.error(error);process.exitCode=1});
