'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Stripe = require('stripe');
const policy = require('./subscription-checkout');
const offerPolicy=require('./annual-upfront');
let coupon={id:'coupon_once',livemode:false,valid:true,duration:'once',percent_off:10,amount_off:null},invoices=new Map();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-subscription-repair-'));
for (const key of Object.keys(process.env)) if (/STRIPE|SUPABASE|OPENAI|RESEND|SENTRY|DATABASE_URL/.test(key)) delete process.env[key];
Object.assign(process.env, { PDL_DB_FILE: path.join(temp, 'db.json'), PDL_PLATFORM_FILE: path.join(temp, 'platform.json'),
  PDL_SUPABASE_ENABLED: '0', PDL_TRANSACTIONAL_DB: 'off', PDL_REQUIRE_AUTH: '1', PDL_FOUNDER_ENABLED: '0',
  STRIPE_SECRET_KEY: 'sk_test_synthetic', STRIPE_WEBHOOK_SECRET: 'whsec_local_only', PDL_PUBLIC_URL: 'http://localhost' });
process.env.STRIPE_FIRST_YEAR_ANNUAL_COUPON='coupon_once';
const prices = {};
for (const [plan, amount] of Object.entries({ starter: 99, growth: 199, pro: 399 })) {
  for (const cycle of ['monthly', 'annual']) {
    const id = `price_${plan}_${cycle}`;
    process.env[`STRIPE_PRICE_${plan.toUpperCase()}${cycle === 'annual' ? '_ANNUAL' : ''}`] = id;
    prices[id] = { id, active: true, livemode: false, currency: 'usd', unit_amount: amount * (cycle === 'annual' ? 1000 : 100),
      type: 'recurring', recurring: { interval: cycle === 'annual' ? 'year' : 'month', interval_count: 1 } };
  }
}
fs.copyFileSync(path.join(__dirname, 'data/db.json'), process.env.PDL_DB_FILE);
fs.copyFileSync(path.join(__dirname, 'data/platform.json'), process.env.PDL_PLATFORM_FILE);
const subscriptions = new Map(), sessions = new Map(), attempts = new Map(), calls = [];
let failAfterCreate = false, providerOutage = false, corruptSubscription = false, historyMore = false, created = 0;
const realFetch = global.fetch;
global.fetch = async (url, options = {}) => {
  const target = new URL(url);
  if (target.hostname === '127.0.0.1') return realFetch(url, options);
  assert.equal(target.origin, 'https://api.stripe.com', 'no unmocked external service');
  const pathname = target.pathname.slice(3), params = Object.fromEntries(new URLSearchParams(options.body));
  calls.push({ pathname, method: options.method, params, key: options.headers?.['Idempotency-Key'] });
  const reply = (value, status = 200) => new Response(JSON.stringify(value), { status });
  if (providerOutage) return reply({ error: { message: 'Synthetic outage' } }, 503);
  if(pathname.startsWith('/coupons/'))return reply(coupon);
  if(pathname.startsWith('/invoices/'))return reply(invoices.get(pathname.split('/').pop())||null);
  if(pathname.startsWith('/customers/'))return reply({id:pathname.split('/').pop(),livemode:false,balance:0,discounts:[]});
  if (pathname.startsWith('/prices/')) return reply(prices[pathname.split('/').pop()]);
  if (pathname === '/subscriptions') return reply({ data: [...subscriptions.values()].filter(s => s.customer === target.searchParams.get('customer')), has_more: historyMore });
  if (pathname.startsWith('/subscriptions/')) {
    const subscription = subscriptions.get(pathname.split('/').pop());
    return reply(corruptSubscription === 'mode' ? { ...subscription, livemode: true }
      : corruptSubscription ? { ...subscription, metadata: { company_id: 'wrong' } } : subscription);
  }
  if (pathname === '/checkout/sessions') {
    const key = options.headers['Idempotency-Key'];
    let session = attempts.get(key);
    if (session) assert.deepEqual(session.params, params, 'provider retry parameters must be byte-equivalent');
    else {
      if (params['subscription_data[billing_cycle_anchor]']) assert.ok(Number(params['subscription_data[billing_cycle_anchor]']) * 1000 - Date.now() > 0);
      session = { id: 'cs_mock_' + (++created), client_reference_id: params.client_reference_id, livemode: false,
        status: 'open', customer: params.customer || null, url: 'https://checkout.example.invalid/' + created, params };
      attempts.set(key, session); sessions.set(session.id, session);
    }
    if (failAfterCreate) { failAfterCreate = false; return reply({ error: { message: 'Synthetic lost response' } }, 503); }
    return reply(session);
  }
  const sessionMatch = pathname.match(/^\/checkout\/sessions\/(cs_mock_\d+)(\/expire)?$/);
  if (sessionMatch) {
    const session = sessions.get(sessionMatch[1]);
    if (sessionMatch[2]) session.status = 'expired';
    return reply(session);
  }
  throw new Error('Unexpected mocked route: ' + pathname);
};
const { server } = require('./server');
let base, index = 0;
function customerClient() {
  let cookie = '', file, companyId;
  const request = async (route, method = 'GET', input) => {
    const response = await realFetch(base + route, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
    if (response.headers.getSetCookie().length) cookie = response.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
    const result = { status: response.status, data: await response.json() };
    if (route === '/api/signup' && response.status === 201) {
      companyId = result.data.company.id; file = path.join(temp, 'tenants', companyId + '.json');
    }
    return result;
  };
  return { request, get id() { return companyId; }, read: () => JSON.parse(fs.readFileSync(file)),
    mutate: fn => { const db = JSON.parse(fs.readFileSync(file)); fn(db); fs.writeFileSync(file, JSON.stringify(db)); } };
}
async function signup(plan = 'starter') {
  const client = customerClient();
  assert.equal((await client.request('/api/signup', 'POST', { companyName: 'Synthetic billing ' + (++index), ownerName: 'Synthetic Owner',
    email: `billing-${index}@example.invalid`, password: 'SyntheticPassword!42', legalAccepted: true, plan })).status, 201);
  return client;
}
function providerSubscription(client, status, id = 'sub_mock_' + client.id, price = 'price_starter_monthly') {
  const s = { id, customer: 'cus_mock_' + client.id, status, livemode: false, metadata: { company_id: client.id },
    items: { data: [{ price: { id: price }, current_period_end: Math.floor(Date.now() / 1000) + 86400 * 30 }] } };
  subscriptions.set(id, s); return s;
}
async function webhook(subscription, suffix) {
  const payload = JSON.stringify({ id: 'evt_mock_' + suffix, type: 'customer.subscription.updated', created: Math.floor(Date.now() / 1000),
    livemode: false, data: { object: subscription } });
  return realFetch(base + '/api/billing/webhook', { method: 'POST', body: payload,
    headers: { 'stripe-signature': Stripe.webhooks.generateTestHeaderString({ payload, secret: process.env.STRIPE_WEBHOOK_SECRET }) } });
}


async function newAnnual(plan='starter',extra={}){const c=customerClient();const result=await c.request('/api/signup','POST',{companyName:'Synthetic upfront '+(++index),ownerName:'Synthetic Owner',email:`upfront-${index}@example.invalid`,password:'SyntheticPassword!42',legalAccepted:true,plan,billingCycle:'annual',annualUpfront:true,annualUpfrontTermsAccepted:true,...extra});return {c,result};}
function invoice(sub,plan,first=true){const a=offerPolicy.amounts[plan],discount=first?(a.renewal-a.first)*100:0;return {id:'in_mock_'+sub.id+'_'+(first?'first':'renew'),customer:sub.customer,subscription:sub.id,livemode:false,status:'paid',currency:'usd',billing_reason:first?'subscription_create':'subscription_cycle',subtotal:a.renewal*100,total_excluding_tax:(first?a.first:a.renewal)*100,amount_paid:(first?a.first:a.renewal)*100,amount_remaining:0,total_discount_amounts:discount?[{amount:discount}]:[]};}
(async()=>{await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base='http://127.0.0.1:'+server.address().port;
try{
  for(const plan of ['starter','growth','pro']){
    const {c,result}=await newAnnual(plan);assert.equal(result.status,201);assert.equal(c.read().company.trialEndsAt,null);assert.equal(c.read().company.subscriptionStatus,'Incomplete');
    let r=await c.request('/api/billing/checkout','POST',{plan,billingCycle:'annual'});assert.equal(r.status,200);const p=c.read().company.pendingCheckout;
    assert.equal(p.params['discounts[0][coupon]'],'coupon_once');assert.equal(p.params['line_items[0][price]'],`price_${plan}_annual`);assert.equal(p.params['subscription_data[billing_cycle_anchor]'],undefined);assert.equal(p.params['subscription_data[trial_end]'],undefined);assert.equal(p.params.allow_promotion_codes,undefined);assert.match(p.params['custom_text[submit][message]'],/today.*No free trial.*Renews automatically/);assert.doesNotMatch(p.params['custom_text[submit][message]'],/No charge before/);
    const count=created;const concurrent=await Promise.all([1,2,3].map(()=>c.request('/api/billing/checkout','POST',{plan,billingCycle:'annual'})));assert.ok(concurrent.every(x=>x.status===200));assert.equal(created,count);
    const sub=providerSubscription(c,'active','sub_upfront_'+plan,`price_${plan}_annual`);sub.metadata.offer=offerPolicy.VERSION;sub.latest_invoice='in_missing';
    delete sub.metadata.offer;assert.equal((await webhook(sub,'missing_offer_'+plan)).status,409);sub.metadata.offer='wrong';assert.equal((await webhook(sub,'wrong_offer_'+plan)).status,409);sub.metadata.offer=offerPolicy.VERSION;
    assert.equal((await webhook(sub,'unpaid_'+plan)).status,409);assert.equal(c.read().company.subscriptionStatus,'Incomplete');
    const earlyRenewal=invoice(sub,plan,false);invoices.set(earlyRenewal.id,earlyRenewal);sub.latest_invoice=earlyRenewal.id;assert.equal((await webhook(sub,'missing_first_'+plan)).status,409);assert.equal(c.read().company.subscriptionStatus,'Incomplete');
    const first=invoice(sub,plan);invoices.set(first.id,first);sub.latest_invoice=first.id;
    first.currency='eur';assert.equal((await webhook(sub,'wrong_currency_'+plan)).status,409);first.currency='usd';
    first.total_excluding_tax++;assert.equal((await webhook(sub,'wrong_amount_'+plan)).status,409);first.total_excluding_tax--;
    assert.equal((await webhook(sub,'paid_'+plan)).status,200);assert.equal(c.read().company.subscriptionStatus,'Active');assert.equal(c.read().company.planPrice,offerPolicy.amounts[plan].first);assert.equal(c.read().company.annualUpfront.used,true);assert.equal(c.read().company.trialEndsAt,null);
    assert.equal((await webhook(sub,'paid_'+plan)).status,200);
    const renewal=invoice(sub,plan,false);invoices.set(renewal.id,renewal);sub.latest_invoice=renewal.id;assert.equal((await webhook(sub,'renew_'+plan)).status,200);assert.equal(c.read().company.planPrice,offerPolicy.amounts[plan].renewal);
    renewal.total_discount_amounts=[{amount:100}];assert.equal((await webhook(sub,'stacked_renew_'+plan)).status,409);renewal.total_discount_amounts=[];
    sub.items.data[0].price.id='price_growth_monthly';assert.equal((await webhook(sub,'portal_away_'+plan)).status,200);sub.items.data[0].price.id=`price_${plan}_annual`;const prorated={...renewal,id:'in_proration_'+plan,billing_reason:'subscription_update',subtotal:100,total_excluding_tax:100,amount_paid:100};invoices.set(prorated.id,prorated);sub.latest_invoice=prorated.id;assert.equal((await webhook(sub,'portal_return_'+plan)).status,200);assert.equal(c.read().company.plan,plan);assert.equal(c.read().company.billingCycle,'annual');
    sub.items.data[0].price.id='price_growth_monthly';sub.status='past_due';assert.equal((await webhook(sub,'changed_past_due_'+plan)).status,200);assert.equal(c.read().company.subscriptionStatus,'Past due');assert.equal(c.read().company.plan,'growth');
    sub.status='canceled';assert.equal((await webhook(sub,'cancel_'+plan)).status,200);assert.equal(c.read().company.subscriptionStatus,'Cancelled');r=await c.request('/api/billing/checkout','POST',{plan,billingCycle:'annual'});assert.equal(r.status,200);assert.equal(c.read().company.pendingCheckout.params['discounts[0][coupon]'],undefined);assert.equal(c.read().company.pendingCheckout.params['subscription_data[billing_cycle_anchor]'],undefined);
  }
  for(const extra of [{annualUpfrontTermsAccepted:false},{billingCycle:'monthly'},{founderCode:'not-a-real-invitation'},{discountPercent:5},{promotionCode:'OTHER'},{assistedSetup:true}])assert.equal((await newAnnual('starter',extra)).result.status,400);
  const {c}=await newAnnual();assert.equal((await c.request('/api/billing/checkout','POST',{plan:'growth',billingCycle:'annual'})).status,409);assert.equal((await c.request('/api/billing/checkout','POST',{plan:'starter',billingCycle:'monthly'})).status,409);
  const good={...coupon};for(const bad of [{duration:'forever'},{percent_off:20},{livemode:true},{max_redemptions:5},{redeem_by:1800000000},{valid:false},{amount_off:99},{applies_to:{products:['foreign']}}]){coupon={...good,...bad};assert.equal((await c.request('/api/billing/checkout','POST',{plan:'starter',billingCycle:'annual'})).status,503);}coupon=good;
  prices.price_starter_annual.currency='eur';assert.equal((await c.request('/api/billing/checkout','POST',{plan:'starter',billingCycle:'annual'})).status,503);prices.price_starter_annual.currency='usd';
  failAfterCreate=true;assert.equal((await c.request('/api/billing/checkout','POST',{plan:'starter',billingCycle:'annual'})).status,502);const attempt=c.read().company.pendingCheckout.attempt;assert.equal((await c.request('/api/billing/checkout','POST',{plan:'starter',billingCycle:'annual'})).status,200);assert.equal(c.read().company.pendingCheckout.attempt,attempt);
  delete process.env.STRIPE_FIRST_YEAR_ANNUAL_COUPON;assert.equal((await newAnnual()).result.status,503);const normal=await signup();assert.ok(normal.read().company.trialEndsAt);assert.equal((await normal.request('/api/billing/checkout','POST',{plan:'starter',billingCycle:'annual'})).status,200);assert.equal(normal.read().company.pendingCheckout.params['discounts[0][coupon]'],undefined);
  const html=fs.readFileSync(path.join(__dirname,'signup.html'),'utf8'),js=fs.readFileSync(path.join(__dirname,'signup.js'),'utf8');assert.match(html,/automatic renewal at the regular annual price/);assert.match(js,/Annual upfront.*pay today, no free trial/);assert.match(js,/annualUpfrontTermsAccepted/);
  console.log('PASS annual upfront HTTP/provider mocks: all three first invoices and regular renewals; no trial, verified payment entitlements, duplicate webhooks, cancellation/no repeat discount, non-stacking, owner consent, currency/plan/coupon mismatch, concurrent/lost-response idempotency, normal trial preservation and truthful copy. No actual provider invoice/renewal acceptance claimed.');
}finally{global.fetch=realFetch;await new Promise(resolve=>server.close(resolve));fs.rmSync(temp,{recursive:true,force:true});}})().catch(e=>{console.error(e);process.exitCode=1;server.close();});
