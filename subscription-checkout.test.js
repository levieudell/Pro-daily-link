'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Stripe = require('stripe');
const policy = require('./subscription-checkout');
const portalPolicy = require('./billing-portal-policy');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-subscription-repair-'));
for (const key of Object.keys(process.env)) if (/STRIPE|SUPABASE|OPENAI|RESEND|SENTRY|DATABASE_URL/.test(key)) delete process.env[key];
Object.assign(process.env, { PDL_DB_FILE: path.join(temp, 'db.json'), PDL_PLATFORM_FILE: path.join(temp, 'platform.json'),
  PDL_SUPABASE_ENABLED: '0', PDL_TRANSACTIONAL_DB: 'off', PDL_REQUIRE_AUTH: '1', PDL_FOUNDER_ENABLED: '0',
  STRIPE_SECRET_KEY: 'sk_test_synthetic', STRIPE_WEBHOOK_SECRET: 'whsec_local_only', PDL_PUBLIC_URL: 'http://localhost' });
const prices = {};
for (const [plan, amount] of Object.entries({ starter: 99, growth: 199, pro: 399 })) {
  process.env[`STRIPE_PRODUCT_${plan.toUpperCase()}`] = `prod_${plan}`;
  for (const cycle of ['monthly', 'annual']) {
    const id = `price_${plan}_${cycle}`;
    process.env[`STRIPE_PRICE_${plan.toUpperCase()}${cycle === 'annual' ? '_ANNUAL' : ''}`] = id;
    prices[id] = { id, active: true, livemode: false, currency: 'usd', unit_amount: amount * (cycle === 'annual' ? 1000 : 100),
      custom_unit_amount: null, billing_scheme: 'per_unit', transform_quantity: null, tiers_mode: null,
      product: { id: `prod_${plan}`, active: true, livemode: false }, type: 'recurring',
      recurring: { interval: cycle === 'annual' ? 'year' : 'month', interval_count: 1, usage_type: 'licensed', aggregate_usage: null, meter: null } };
  }
}
fs.copyFileSync(path.join(__dirname, 'data/db.json'), process.env.PDL_DB_FILE);
fs.copyFileSync(path.join(__dirname, 'data/platform.json'), process.env.PDL_PLATFORM_FILE);
const invoices = new Map();
const subscriptions = new Map(), sessions = new Map(), attempts = new Map(), portalConfigurations = new Map(), calls = [];
let failAfterCreate = false, providerOutage = false, corruptSubscription = false, historyMore = false, created = 0;
const realFetch = global.fetch;
global.fetch = async (url, options = {}) => {
  const target = new URL(url);
  if (target.hostname === '127.0.0.1') return realFetch(url, options);
  if (target.origin === 'https://in.heycatch.ai') return new Response(null, { status: 204 });
  assert.equal(target.origin, 'https://api.stripe.com', 'no unmocked external service');
  const pathname = target.pathname.slice(3), params = Object.fromEntries(new URLSearchParams(options.body));
  calls.push({ pathname, method: options.method, params, query: Object.fromEntries(target.searchParams), key: options.headers?.['Idempotency-Key'] });
  const reply = (value, status = 200) => new Response(JSON.stringify(value), { status });
  if (providerOutage) return reply({ error: { message: 'Synthetic outage' } }, 503);
  if (pathname.startsWith('/payment_methods/')) return reply({id:pathname.split('/').pop(),type:'card',customer:target.searchParams.get('customer')||[...subscriptions.values()].find(s=>s.default_payment_method===pathname.split('/').pop())?.customer,livemode:false});
  if (pathname.startsWith('/customers/')) return reply({id:pathname.split('/').pop(),livemode:false,invoice_settings:{}});
  if (pathname === '/subscription_schedules') return reply({id:'sched_founder',metadata:{pdl_founder_configured:'1'},current_phase:{start_date:Math.floor(Date.now()/1000)}});
  if (pathname.startsWith('/invoices/')) return reply(invoices.get(pathname.split('/').pop()));
  if (pathname.startsWith('/prices/')) return reply(prices[pathname.split('/').pop()]);
  if (pathname.startsWith('/billing_portal/configurations/')) return reply(portalConfigurations.get(pathname.split('/').pop()) || { error: { message: 'Missing portal configuration' } }, portalConfigurations.has(pathname.split('/').pop()) ? 200 : 404);
  if (pathname === '/billing_portal/sessions') return reply({ id: 'bps_test', url: 'https://billing.example.invalid/session' });
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
async function signup(plan = 'starter', existingTrial = true, extra = {}) {
  const client = customerClient();
  assert.equal((await client.request('/api/signup', 'POST', { companyName: 'Synthetic billing ' + (++index), ownerName: 'Synthetic Owner',
    email: `billing-${index}@example.invalid`, password: 'SyntheticPassword!42', legalAccepted: true, plan, paymentRequired:false,subscriptionStatus:'Active',trialEndsAt:'2099-01-01T00:00:00Z',...extra })).status, 201);
  if(existingTrial)client.mutate(db=>{delete db.company.paymentRequired;delete db.company.cardTrialDays;delete db.company.subscriptionStatus;db.company.trialEndsAt=new Date(Date.now()+14*86400000).toISOString();});
  return client;
}
function providerSubscription(client, status, id = 'sub_mock_' + client.id, price = 'price_starter_monthly') {
  const s = { id, customer: 'cus_mock_' + client.id, status, livemode: false, metadata: { company_id: client.id },
    items: { data: [{ price: { id: price }, current_period_end: Math.floor(Date.now() / 1000) + 86400 * 30 }] } };
  subscriptions.set(id, s); return s;
}
async function webhook(subscription, suffix, type='customer.subscription.updated') {
  const payload = JSON.stringify({ id: 'evt_mock_' + suffix, type, created: Math.floor(Date.now() / 1000),
    livemode: false, data: { object: subscription } });
  return realFetch(base + '/api/billing/webhook', { method: 'POST', body: payload,
    headers: { 'stripe-signature': Stripe.webhooks.generateTestHeaderString({ payload, secret: process.env.STRIPE_WEBHOOK_SECRET }) } });
}

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); base = 'http://127.0.0.1:' + server.address().port;
  try {
    const defaultAnnual=await signup('starter',false);
    assert.equal(defaultAnnual.read().company.billingCycle,'annual');
    assert.equal((await defaultAnnual.request('/api/billing/checkout','POST',{plan:'starter'})).status,200);
    assert.equal(defaultAnnual.read().company.pendingCheckout.cycle,'annual');
    assert.equal(policy.remainingAnchoredTrial({subscriptionStatus:'Active'}),false,'legacy active accounts without a provider marker remain compatible');
    assert.equal(policy.remainingAnchoredTrial({subscriptionStatus:'Active',stripeSubscriptionId:'sub_legacy'}),false);
    // Valid founder enrollment stays pay-first in both billing cycles.
    process.env.PDL_FOUNDER_ENABLED='1';process.env.PDL_FOUNDER_CODE='TEST-FOUNDER';
    process.env.STRIPE_PRODUCT_FOUNDER_STARTER='prod_founder_starter';
    for(const cycle of ['monthly','annual']){
      const priceId='price_founder_starter_'+cycle;
      process.env['STRIPE_PRICE_FOUNDER_STARTER'+(cycle==='annual'?'_ANNUAL':'')]=priceId;
      prices[priceId]={...structuredClone(prices['price_starter_'+cycle]),id:priceId,unit_amount:cycle==='annual'?79000:7900,product:{id:'prod_founder_starter',active:true,livemode:false}};
      const founderClient=await signup('starter',false,{founderCode:'TEST-FOUNDER',founderTermsAccepted:true,billingCycle:cycle});
      assert.equal(founderClient.read().company.cardTrialDays,undefined,'founder signup never receives trial eligibility');
      assert.equal((await founderClient.request('/api/billing/checkout','POST',{plan:'starter',billingCycle:cycle})).status,200);
      const pending=founderClient.read().company.pendingCheckout;
      assert.equal(pending.params['line_items[0][price]'],priceId);
      assert.ok(!Object.keys(pending.params).some(key=>/trial_period_days|trial_settings|billing_cycle_anchor/.test(key)));
      assert.match(pending.params['custom_text[submit][message]'],/No free trial/);
      founderClient.mutate(db=>{db.company.pendingCheckout.status='creating';db.company.pendingCheckout.params['subscription_data[trial_period_days]']=7;});
      assert.equal((await founderClient.request('/api/billing/checkout','POST',{plan:'starter',billingCycle:cycle})).status,409,'old ambiguous trial checkout cannot be replayed for a founder');
      founderClient.mutate(db=>db.company.pendingCheckout=pending);
      const sub=providerSubscription(founderClient,'trialing',undefined,priceId);
      sub.metadata.offer='founder';sub.default_payment_method='pm_'+founderClient.id;sub.trial_end=Math.floor(Date.now()/1000)+604800;
      founderClient.mutate(db=>{db.company.cardTrialDays=7;db.company.cardTrial={subscriptionId:sub.id,end:sub.trial_end};});
      const session=sessions.get(pending.id);Object.assign(session,{status:'complete',customer:sub.customer,subscription:sub.id});
      assert.equal((await founderClient.request('/api/billing/confirm?session_id='+session.id)).data.locked,true,'even a stale founder trial with a card cannot open access');
      sub.status='active';sub.latest_invoice='in_'+founderClient.id;
      const invoice={id:sub.latest_invoice,subscription:sub.id,customer:sub.customer,livemode:false,status:'open',amount_paid:0};invoices.set(invoice.id,invoice);
      assert.equal((await founderClient.request('/api/billing/confirm?session_id='+session.id)).status,409);
      assert.equal((await founderClient.request('/api/state')).status,402,'unpaid founder stays locked');
      invoice.status='paid';invoice.amount_paid=prices[priceId].unit_amount;
      assert.equal((await founderClient.request('/api/billing/confirm?session_id='+session.id)).data.locked,false);
      assert.ok(founderClient.read().company.initialPaymentConfirmedAt);
      assert.equal((await founderClient.request('/api/state')).status,200,'paid founder receives access');
      assert.equal((await webhook(sub,'founder-paid-'+cycle)).status,200);
    }
    process.env.PDL_FOUNDER_ENABLED='0';
    // New accounts pay first; legacy trial fixtures below retain their deadline.
    for(const plan of ['starter','growth','pro'])for(const billingCycle of ['monthly','annual']){
      const paid=await signup(plan,false);
      assert.equal(paid.read().company.trialEndsAt,null);
      assert.equal((await paid.request('/api/state')).status,402);
      delete process.env.PDL_REQUIRE_AUTH;assert.equal((await paid.request('/api/state?billing=success')).status,402,'no environment flag or success query bypass');process.env.PDL_REQUIRE_AUTH='1';
      assert.equal((await paid.request('/api/account-access')).data.locked,true);
      assert.equal((await paid.request('/api/billing/checkout','POST',{plan,billingCycle})).status,200);
      const pending=paid.read().company.pendingCheckout;
      assert.equal(pending.params['line_items[0][price]'],`price_${plan}_${billingCycle}`);
      assert.equal(pending.params['subscription_data[trial_period_days]'],7);
      assert.equal(pending.params.payment_method_collection,'always');
      assert.deepEqual(pending.params.payment_method_types,['card']);
      assert.equal(pending.params['subscription_data[trial_settings][end_behavior][missing_payment_method]'],'cancel');
      assert.equal((await paid.request('/api/billing/checkout','POST',{plan,billingCycle})).status,200);
      assert.equal(paid.read().company.pendingCheckout.id,pending.id,'cancel/retry reuses the open checkout');
      const sub=providerSubscription(paid,'active',undefined,`price_${plan}_${billingCycle}`);
      sub.status='trialing';sub.trial_end=Math.floor(Date.now()/1000)+7*86400;
      const trialSession=sessions.get(pending.id);Object.assign(trialSession,{status:'complete',customer:sub.customer,subscription:sub.id});
      assert.equal((await paid.request('/api/billing/confirm?session_id='+trialSession.id)).data.locked,true,'no saved card stays locked');
      sub.status='canceled';assert.equal((await webhook(sub,'no-card-canceled-'+paid.id)).status,200);
      assert.equal((await paid.request('/api/state')).status,402,'trial canceled without card stays locked');
      sub.status='trialing';
      sub.default_payment_method='pm_'+paid.id;
      assert.equal((await paid.request('/api/billing/confirm?session_id='+trialSession.id)).data.locked,false,'direct Stripe trial confirmation opens workspace');
      assert.equal((await paid.request('/api/state')).status,200);
      for(const role of ['field','foreman']){
        paid.mutate(db=>db.users.find(u=>u.role==='owner'||u.role==='field').role=role);
        assert.equal((await paid.request('/api/state')).status,200,role+' can enter a card-confirmed trial');
      }
      paid.mutate(db=>db.users.find(u=>u.role==='foreman').role='owner');
      assert.equal((await webhook(sub,'trial-'+paid.id)).status,200);
      assert.equal((await webhook(sub,'ending-'+paid.id,'customer.subscription.trial_will_end')).status,200);
      assert.equal((await webhook(sub,'ending-'+paid.id,'customer.subscription.trial_will_end')).status,200);
      const trialBefore=paid.read().company.cardTrial;
      assert.equal((await webhook(sub,'trial-'+paid.id)).status,200);
      assert.deepEqual(paid.read().company.cardTrial,trialBefore,'trial replay is safe');
      sub.status='past_due';assert.equal((await webhook(sub,'trial-due-'+paid.id)).status,200);
      assert.equal((await paid.request('/api/state')).status,402,'past due closes trial access');
      sub.status='active';

      sub.latest_invoice='in_'+paid.id;
      const invoice={id:sub.latest_invoice,subscription:sub.id,customer:sub.customer,livemode:false,status:'open',amount_paid:0};
      invoices.set(invoice.id,invoice);
      const session=sessions.get(pending.id);Object.assign(session,{status:'complete',customer:sub.customer,subscription:sub.id,payment_status:'unpaid'});
      assert.equal((await paid.request('/api/billing/confirm?session_id='+session.id)).data.locked,true,'active subscription alone is not payment');
      assert.equal((await paid.request('/api/state')).status,402);
      assert.equal((await webhook(sub,'pending-'+paid.id)).status,200);
      assert.equal((await paid.request('/api/account-access')).data.locked,true,'unpaid signed webhook stays locked');
      const other=await signup('starter',false);
      assert.equal((await other.request('/api/billing/confirm?session_id='+session.id)).status,404);
      invoice.status='paid';
      assert.equal((await paid.request('/api/billing/confirm?session_id='+session.id)).data.locked,true,'zero-dollar invoice does not count as first payment');
      invoice.amount_paid=prices[`price_${plan}_${billingCycle}`].unit_amount;
      invoice.customer='cus_wrong';
      assert.equal((await paid.request('/api/billing/confirm?session_id='+session.id)).status,503);
      assert.equal((await paid.request('/api/account-access')).data.locked,true);
      invoice.customer=sub.customer;
      if(billingCycle==='annual')assert.equal((await paid.request('/api/billing/confirm?session_id='+session.id)).data.locked,false,'verified checkout return can activate before webhook delivery');
      assert.equal((await webhook(sub,'paid-'+paid.id)).status,200);
      assert.ok(paid.read().company.initialPaymentConfirmedAt);
      assert.equal((await paid.request('/api/state')).status,200);
      assert.equal((await webhook(sub,'paid-'+paid.id)).status,200,'signed webhook replay is safe');
      assert.equal((await paid.request('/api/billing/confirm?session_id='+session.id)).data.locked,false);
    }
    // Every standard price and period preserves the same absolute deadline.
    for (const plan of ['starter', 'growth', 'pro']) for (const billingCycle of ['monthly', 'annual']) {
      const c = await signup(plan), end = c.read().company.trialEndsAt;
      const result = await c.request('/api/billing/checkout', 'POST', { plan, billingCycle });
      assert.equal(result.status, 200); const pending = c.read().company.pendingCheckout;
      assert.equal(Number(pending.params['subscription_data[billing_cycle_anchor]']), Math.ceil(Date.parse(end) / 1000));
      assert.equal(c.read().company.trialEndsAt, end); assert.equal((await c.request('/api/billing')).data.status, 'Trial');
      assert.equal(pending.params['line_items[0][price]'], `price_${plan}_${billingCycle}`);
      assert.equal(Object.keys(pending.params).some(key => key.startsWith('payment_method_types')), false,
        'Checkout leaves eligible payment methods to Stripe so delayed methods can be reconciled by webhooks');
    }
    const c = await signup(), end = c.read().company.trialEndsAt;
    process.env.PDL_CHECKOUT_DISABLED = '1'; const disabledCount = created;
    assert.equal((await c.request('/api/billing/checkout', 'POST', { plan: 'starter', billingCycle:'monthly'})).status, 503);
    assert.equal(created, disabledCount); delete process.env.PDL_CHECKOUT_DISABLED;
    failAfterCreate = true; const before = created;
    assert.equal((await c.request('/api/billing/checkout', 'POST', { plan: 'starter', billingCycle:'monthly'})).status, 502);
    const attempt = c.read().company.pendingCheckout.attempt;
    prices.price_rebound = { ...prices.price_starter_monthly, id: 'price_rebound' };
    process.env.STRIPE_PRICE_STARTER = 'price_rebound';
    assert.equal((await c.request('/api/billing/checkout', 'POST', { plan: 'starter', billingCycle:'monthly'})).status, 409, 'changed configured price cannot replay different provider parameters');
    process.env.STRIPE_PRICE_STARTER = 'price_starter_monthly';
    process.env.STRIPE_SECRET_KEY='sk_live_synthetic';
    assert.equal((await c.request('/api/billing/checkout','POST',{plan:'starter', billingCycle:'monthly'})).status,503,'ambiguous checkout never replays in another provider mode');
    prices.price_starter_monthly.livemode=true;
    prices.price_starter_monthly.product.livemode=true;
    assert.equal((await c.request('/api/billing/checkout','POST',{plan:'starter', billingCycle:'monthly'})).status,409,'stored creation attempt is bound to its provider mode');
    prices.price_starter_monthly.product.livemode=false;
    prices.price_starter_monthly.livemode=false;
    process.env.STRIPE_SECRET_KEY='sk_test_synthetic';
    assert.equal((await c.request('/api/billing/checkout', 'POST', { plan: 'growth', billingCycle:'monthly'})).status, 409);
    const recovered = await Promise.all(Array.from({ length: 4 }, () => c.request('/api/billing/checkout', 'POST', { plan: 'starter', billingCycle:'monthly'})));
    assert.ok(recovered.every(r => r.status === 200 && r.data.url === recovered[0].data.url));
    assert.equal(created, before + 1); assert.equal(c.read().company.pendingCheckout.attempt, attempt);
    assert.equal(c.read().company.trialEndsAt, end);
    let session = sessions.get(c.read().company.pendingCheckout.id);
    assert.equal((await c.request('/api/billing/confirm?session_id=' + session.id)).status, 409);
    assert.equal(c.read().company.stripeSubscriptionId, undefined);
    session.status = 'expired';
    assert.equal((await c.request('/api/billing/checkout', 'POST', { plan: 'growth', billingCycle:'monthly'})).status, 200);
    const changed = c.read().company.pendingCheckout;
    assert.equal(changed.plan, 'growth'); assert.equal(changed.params['subscription_data[billing_cycle_anchor]'], Math.ceil(Date.parse(end) / 1000));
    const trialing = providerSubscription(c, 'active', 'sub_mock_trialing', 'price_growth_monthly');
    Object.assign(trialing,{billing_cycle_anchor:Math.ceil(Date.parse(end)/1000),metadata:{company_id:c.id,original_trial_end:String(Math.ceil(Date.parse(end)/1000))}});
    session = sessions.get(changed.id); Object.assign(session, { status: 'complete', customer: trialing.customer, subscription: trialing.id });
    assert.equal((await c.request('/api/billing/confirm?session_id=' + session.id)).status, 200);
    assert.equal(c.read().company.subscriptionStatus, 'Active'); assert.equal((await c.request('/api/billing')).data.status,'Trial'); assert.equal(c.read().company.plan, 'growth');
    assert.equal(c.read().company.trialEndsAt, end, 'provider trial confirmation keeps original local deadline');

    // Standard and founder accounts use different, verified portal
    // configurations so a global Dashboard toggle cannot expose protected
    // founder prices or silently remove standard self-service plan changes.
    assert.equal((await c.request('/api/billing')).data.planChange.mode, 'support');
    const standardConfigId = 'bpc_standard123', founderConfigId = 'bpc_founder123';
    process.env.STRIPE_PORTAL_CONFIG_STANDARD = standardConfigId;
    process.env.STRIPE_PORTAL_CONFIG_FOUNDER = founderConfigId;
    const portalPlans = { starter: {}, growth: {}, pro: {} }, standardPriceIds = portalPolicy.priceIds(portalPlans, process.env, false);
    portalConfigurations.set(standardConfigId, { id: standardConfigId, active: true, livemode: false,
      features: { subscription_update: { enabled: true, default_allowed_updates: ['price'], products: [{ product: 'prod_standard', prices: standardPriceIds }] } } });
    portalConfigurations.set(founderConfigId, { id: founderConfigId, active: true, livemode: false,
      features: { subscription_update: { enabled: false, default_allowed_updates: [], products: [] } } });
    assert.equal((await c.request('/api/billing')).data.planChange.mode, 'portal');
    const portal = await c.request('/api/billing/portal', 'POST', {});
    assert.equal(portal.status, 200); assert.equal(portal.data.url, 'https://billing.example.invalid/session');
    const portalConfigurationCall = calls.findLast(call => call.pathname === `/billing_portal/configurations/${standardConfigId}`);
    assert.deepEqual(portalConfigurationCall.query, { 'expand[]': 'features.subscription_update.products' },
      'runtime portal validation retrieves the expanded price allowlist');
    const portalSessionCall = calls.findLast(call => call.pathname === '/billing_portal/sessions');
    assert.equal(portalSessionCall.params.configuration, standardConfigId);
    assert.equal(portalSessionCall.params.customer, trialing.customer);
    const founderSelection = portalPolicy.select({ founder: { requested: true } }, process.env);
    assert.equal(founderSelection.kind, 'founder'); assert.equal(founderSelection.planChanges, 'protected');
    assert.doesNotThrow(() => portalPolicy.validate(portalConfigurations.get(founderConfigId), founderSelection, { starter: {}, growth: {}, pro: {} }, process.env));
    assert.throws(() => portalPolicy.validate({ ...portalConfigurations.get(founderConfigId), features: { subscription_update: { enabled: true } } }, founderSelection, portalPlans, process.env), /Founder billing protection/);
    const missingStandardPrice = process.env.STRIPE_PRICE_PRO_ANNUAL;
    delete process.env.STRIPE_PRICE_PRO_ANNUAL;
    assert.throws(() => portalPolicy.validate(portalConfigurations.get(standardConfigId), portalPolicy.select({}, process.env), portalPlans, process.env), /All current monthly and annual plan prices/);
    process.env.STRIPE_PRICE_PRO_ANNUAL = missingStandardPrice;
    process.env.STRIPE_PRICE_FOUNDER_STARTER = 'price_founder_private';
    const unsafeStandard = structuredClone(portalConfigurations.get(standardConfigId));
    unsafeStandard.features.subscription_update.products[0].prices.push(process.env.STRIPE_PRICE_FOUNDER_STARTER);
    assert.throws(() => portalPolicy.validate(unsafeStandard, portalPolicy.select({}, process.env), portalPlans, process.env), /exactly the current/);
    delete process.env.STRIPE_PRICE_FOUNDER_STARTER;
    const expandedProducts = portalConfigurations.get(standardConfigId).features.subscription_update.products;
    delete portalConfigurations.get(standardConfigId).features.subscription_update.products;
    assert.equal((await c.request('/api/billing/portal', 'POST', {})).status, 503,
      'missing or unexpanded portal products fail closed before session creation');
    portalConfigurations.get(standardConfigId).features.subscription_update.products = expandedProducts;
    portalConfigurations.get(standardConfigId).features.subscription_update.enabled = false;
    assert.equal((await c.request('/api/billing/portal', 'POST', {})).status, 503, 'misconfigured standard portal fails closed before session creation');
    portalConfigurations.get(standardConfigId).features.subscription_update.enabled = true;

    // Final 48h and the last seconds use the same no-proration anchor.
    for (const remaining of [48*3600000,36*3600000,1000]) {
      const near=await signup(); near.mutate(db=>{db.company.trialEndsAt=new Date(Date.now()+remaining).toISOString()});
      const nearEnd=near.read().company.trialEndsAt;
      assert.equal((await near.request('/api/billing/checkout','POST',{plan:'starter', billingCycle:'monthly'})).status,200);
      const p=near.read().company.pendingCheckout;
      assert.equal(p.params['subscription_data[billing_cycle_anchor]'],Math.ceil(Date.parse(nearEnd)/1000));
      assert.equal(p.params['subscription_data[proration_behavior]'],'none');
      assert.equal(p.params.payment_method_collection,'always');
      assert.equal(p.params['subscription_data[trial_end]'],undefined);
      assert.equal(near.read().company.trialEndsAt,nearEnd);
    }
    const near=await signup(); near.mutate(db=>{db.company.trialEndsAt=new Date(Date.now()-1000).toISOString()});
    assert.equal((await near.request('/api/billing/checkout','POST',{plan:'starter', billingCycle:'monthly'})).status,200);
    assert.equal(near.read().company.pendingCheckout.params['subscription_data[billing_cycle_anchor]'],undefined);
    assert.deepEqual(policy.trialParameters({trialEndsAt:end,stripeTrialUsed:true},false),{});
    assert.deepEqual(policy.trialParameters({trialEndsAt:end},true),{});
    // Active can show a free period; adverse provider states always win.
    for(const status of ['past_due','unpaid','paused','canceled','incomplete']) {
      trialing.status=status;
      assert.equal((await webhook(trialing,'adverse_'+status)).status,200);
      const b=(await c.request('/api/billing')).data;
      assert.notEqual(b.status,'Trial'); assert.equal(b.locked,true);
    }
    trialing.status='active';
    assert.equal((await webhook(trialing,'restored_active')).status,200);
    assert.equal((await c.request('/api/account-access')).data.status,'Trial');
    // The original deadline elapses dynamically without waiting for a webhook.
    assert.equal(policy.remainingAnchoredTrial(c.read().company,Date.parse(end)+1),false);
    assert.equal(policy.anchoredFreePeriod(trialing,c.read().company,Date.parse(end)+1000),null);

    // Cancellation of the original anchored free period never forfeits its deadline.
    trialing.status='canceled'; await webhook(trialing,'initial_trial_cancel');
    assert.equal((await c.request('/api/billing/checkout','POST',{plan:'starter', billingCycle:'monthly'})).status,200);
    assert.equal(c.read().company.pendingCheckout.params['subscription_data[billing_cycle_anchor]'],Math.ceil(Date.parse(end)/1000));
    assert.equal(c.read().company.trialEndsAt,end);
    // Missed confirmation/webhook still recovers provider-verified original free eligibility.
    const missed=await signup(); assert.equal((await missed.request('/api/billing/checkout','POST',{plan:'starter', billingCycle:'monthly'})).status,200);
    const missedPending=missed.read().company.pendingCheckout, missedSub=providerSubscription(missed,'canceled');
    Object.assign(missedSub,{billing_cycle_anchor:missedPending.params['subscription_data[billing_cycle_anchor]'],metadata:{company_id:missed.id,original_trial_end:missedPending.params['subscription_data[metadata][original_trial_end]']}});
    Object.assign(sessions.get(missedPending.id),{status:'complete',customer:missedSub.customer,subscription:missedSub.id});
    assert.equal(missed.read().company.stripeFreePeriod,undefined);
    assert.equal((await missed.request('/api/billing/checkout','POST',{plan:'growth', billingCycle:'monthly'})).status,200);
    assert.equal(missed.read().company.pendingCheckout.params['subscription_data[billing_cycle_anchor]'],missedPending.params['subscription_data[billing_cycle_anchor]']);
    assert.equal(missed.read().company.pendingCheckout.params['subscription_data[proration_behavior]'],'none');
    // Known open checkout is reused after deadline; a new plan starts normal billing then.
    const crossing=await signup(); crossing.mutate(db=>{db.company.trialEndsAt=new Date(Date.now()+1000).toISOString()});
    assert.equal((await crossing.request('/api/billing/checkout','POST',{plan:'starter', billingCycle:'monthly'})).status,200);
    const crossingSession=crossing.read().company.pendingCheckout.id;
    await new Promise(resolve=>setTimeout(resolve,1100));
    assert.equal((await crossing.request('/api/billing/checkout','POST',{plan:'starter', billingCycle:'monthly'})).status,200);
    assert.equal(crossing.read().company.pendingCheckout.id,crossingSession);
    assert.equal((await crossing.request('/api/billing/checkout','POST',{plan:'growth', billingCycle:'monthly'})).status,200);
    assert.equal(sessions.get(crossingSession).status,'expired');
    assert.equal(crossing.read().company.pendingCheckout.params['subscription_data[billing_cycle_anchor]'],undefined);
    // Completing the selected anchored checkout after its deadline activates normally.
    const completed=await signup(); completed.mutate(db=>{db.company.trialEndsAt=new Date(Date.now()+1000).toISOString()});
    assert.equal((await completed.request('/api/billing/checkout','POST',{plan:'starter', billingCycle:'monthly'})).status,200);
    const completePending=completed.read().company.pendingCheckout, completeSub=providerSubscription(completed,'active');
    Object.assign(completeSub,{billing_cycle_anchor:completePending.params['subscription_data[billing_cycle_anchor]'],metadata:{company_id:completed.id,original_trial_end:completePending.params['subscription_data[metadata][original_trial_end]']}});
    await new Promise(resolve=>setTimeout(resolve,2100));
    Object.assign(sessions.get(completePending.id),{status:'complete',customer:completeSub.customer,subscription:completeSub.id});
    assert.equal((await completed.request('/api/billing/confirm?session_id='+completePending.id)).status,200);
    assert.equal((await completed.request('/api/billing')).data.status,'Active');
    completeSub.status='canceled'; await webhook(completeSub,'canceled_after_deadline');
    assert.equal((await completed.request('/api/billing/checkout','POST',{plan:'starter', billingCycle:'monthly'})).status,200);
    assert.equal(completed.read().company.pendingCheckout.params['subscription_data[billing_cycle_anchor]'],undefined);
    // An unresolved creation crossing its anchor fails closed, without a new charge attempt.
    const ambiguous=await signup(); ambiguous.mutate(db=>{db.company.trialEndsAt=new Date(Date.now()+1000).toISOString()});
    failAfterCreate=true; assert.equal((await ambiguous.request('/api/billing/checkout','POST',{plan:'starter', billingCycle:'monthly'})).status,502);
    const ambiguousAttempt=ambiguous.read().company.pendingCheckout.attempt, callsBefore=calls.length;
    await new Promise(resolve=>setTimeout(resolve,2100));
    assert.equal((await ambiguous.request('/api/billing/checkout','POST',{plan:'starter', billingCycle:'monthly'})).status,409);
    assert.equal(ambiguous.read().company.pendingCheckout.attempt,ambiguousAttempt);
    assert.equal(calls.slice(callsBefore).filter(call=>call.pathname==='/checkout/sessions').length,0);

    // Provider authority, retained customer, retired session, and duplicate guard.
    const returning = await signup(), old = providerSubscription(returning, 'canceled');
    const oldSession = { id: 'cs_mock_' + (++created), status: 'complete', customer: old.customer, subscription: old.id,
      client_reference_id: returning.id, livemode: false };
    sessions.set(oldSession.id, oldSession);
    returning.mutate(db => Object.assign(db.company, { stripeSubscriptionId: old.id, stripeCustomerId: old.customer,
      subscriptionStatus: 'Cancelled', pendingCheckout: { id: oldSession.id, plan: 'starter', cycle: 'monthly', status: 'open' } }));
    const billing = (await returning.request('/api/billing')).data;
    assert.equal(billing.hasSubscription, false); assert.equal(billing.hasBillingCustomer, true);
    corruptSubscription = true;
    assert.equal((await returning.request('/api/billing/checkout', 'POST', { plan: 'starter', billingCycle:'monthly'})).status, 503);
    assert.equal(returning.read().company.stripeSubscriptionId, old.id); corruptSubscription = false;
    corruptSubscription = 'mode';
    assert.equal((await returning.request('/api/billing/checkout', 'POST', { plan: 'starter', billingCycle:'monthly'})).status, 503);
    assert.equal(returning.read().company.stripeSubscriptionId, old.id); corruptSubscription = false;
    providerOutage = true; assert.equal((await returning.request('/api/billing/checkout', 'POST', { plan: 'starter', billingCycle:'monthly'})).status, 502);
    assert.equal(returning.read().company.stripeSubscriptionId, old.id); providerOutage = false;
    historyMore = true; assert.equal((await returning.request('/api/billing/checkout', 'POST', { plan: 'starter', billingCycle:'monthly'})).status, 503); historyMore = false;
    const recoveredCount = created;
    const retry = await Promise.all([1, 2, 3].map(() => returning.request('/api/billing/checkout', 'POST', { plan: 'starter', billingCycle:'monthly'})));
    assert.ok(retry.every(r => r.status === 200 && r.data.url === retry[0].data.url)); assert.equal(created, recoveredCount + 1);
    assert.equal(returning.read().company.stripeCustomerId, old.customer); assert.equal(returning.read().company.stripeSubscriptionId, undefined);
    assert.equal(returning.read().company.pendingCheckout.params['subscription_data[billing_cycle_anchor]'], undefined, 'never grant returning subscriber another trial');
    assert.ok(returning.read().company.retiredStripeSubscriptionIds.includes(old.id));
    assert.equal((await webhook(old, 'old_before_new')).status, 200); assert.equal(returning.read().company.stripeSubscriptionId, undefined);
    assert.equal((await returning.request('/api/billing/confirm?session_id=' + oldSession.id)).status, 409);
    const fresh = providerSubscription(returning, 'active', 'sub_mock_replacement');
    assert.equal((await webhook(fresh, 'new')).status, 200); assert.equal(returning.read().company.stripeSubscriptionId, fresh.id);
    assert.equal((await webhook(old, 'old_after_new')).status, 200); assert.equal(returning.read().company.subscriptionStatus, 'Active');
    assert.equal((await returning.request('/api/billing/checkout', 'POST', { plan: 'starter', billingCycle:'monthly'})).status, 409);

    for (const status of ['active', 'trialing', 'past_due', 'unpaid', 'paused', 'incomplete']) {
      const a = await signup(), sub = providerSubscription(a, status);
      a.mutate(db => Object.assign(db.company, { stripeSubscriptionId: sub.id, stripeCustomerId: sub.customer, subscriptionStatus: 'Cancelled' }));
      assert.equal((await a.request('/api/billing/checkout', 'POST', { plan: 'starter', billingCycle:'monthly'})).status, 409);
      assert.equal(a.read().company.stripeSubscriptionId, sub.id);
    }
    const missing = await signup(), hidden = providerSubscription(missing, 'active');
    missing.mutate(db => { db.company.stripeCustomerId = hidden.customer; });
    assert.equal((await missing.request('/api/billing/checkout', 'POST', { plan: 'starter', billingCycle:'monthly'})).status, 409, 'provider history protects a lost local subscription ID');
    const expired = await signup(), expiredSub = providerSubscription(expired, 'incomplete_expired');
    expired.mutate(db => Object.assign(db.company, { stripeSubscriptionId: expiredSub.id, stripeCustomerId: expiredSub.customer, subscriptionStatus: 'Cancelled' }));
    assert.equal((await expired.request('/api/billing/checkout', 'POST', { plan: 'starter', billingCycle:'monthly'})).status, 200);
    const founder = await signup(), founderSub = providerSubscription(founder, 'canceled');
    const founderTerms = { requested: true, plan: 'starter', billingCycle: 'monthly', assistedSetup: true,
      paidAt: '2026-09-28T00:00:00Z', protectedUntil: '2028-09-28T00:00:00Z' };
    founder.mutate(db => Object.assign(db.company, { stripeSubscriptionId: founderSub.id, stripeCustomerId: founderSub.customer,
      subscriptionStatus: 'Cancelled', founder: founderTerms }));
    const founderResult = await founder.request('/api/billing/checkout', 'POST', { plan: 'starter', billingCycle:'monthly'});
    assert.equal(founderResult.status, 409); assert.match(founderResult.data.error, /original pricing and setup terms/);
    assert.deepEqual(founder.read().company.founder, founderTerms);
    assert.equal(founder.read().company.stripeSubscriptionId, founderSub.id);

    // Same tenant queue gives creation and restore one shared capacity boundary.
    const projects = await signup(); const ids = [];
    for (let i = 0; i < 5; i++) { const p = await projects.request('/api/projects', 'POST', { name: 'Synthetic ' + i }); assert.equal(p.status, 201); ids.push(p.data.id); }
    assert.equal((await projects.request('/api/projects', 'POST', { name: 'Blocked' })).status, 409);
    assert.equal((await projects.request('/api/projects/' + ids[0] + '/archive', 'PATCH', { archived: true })).status, 200);
    assert.equal((await projects.request('/api/projects', 'POST', { name: 'Replacement' })).status, 201);
    assert.equal((await projects.request('/api/projects/' + ids[0] + '/archive', 'PATCH', { archived: false })).status, 409);
    assert.equal(projects.read().projects.find(p => p.id === ids[0]).archived, true);
    assert.equal((await projects.request('/api/projects/' + ids[1] + '/archive', 'PATCH', { archived: true })).status, 200);
    const racing = await Promise.all([projects.request('/api/projects/' + ids[0] + '/archive', 'PATCH', { archived: false }),
      projects.request('/api/projects/' + ids[1] + '/archive', 'PATCH', { archived: false }), projects.request('/api/projects', 'POST', { name: 'Race' })]);
    assert.equal(racing.filter(r => r.status === 200 || r.status === 201).length, 1);
    assert.equal(projects.read().projects.filter(p => !p.archived).length, 5);
    const activeId = projects.read().projects.find(p => !p.archived).id;
    assert.equal((await projects.request('/api/projects/' + activeId + '/archive', 'PATCH', { archived: false })).status, 200, 'idempotent restore at capacity');
    projects.mutate(db => { db.company.plan = 'pro'; });
    assert.equal((await projects.request('/api/projects/' + ids[1] + '/archive', 'PATCH', { archived: false })).status, 200);
    console.log('Subscription repair runtime checks passed: six standard prices, original trial/near-end/expired/founder rules, failed and concurrent idempotent checkout, canceled recovery/provider authority/late webhook+confirm, duplicate protection and concurrent project caps. All provider traffic mocked.');
  } finally {
    global.fetch = realFetch; await new Promise(resolve => server.close(resolve)); fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; server.close(); });
