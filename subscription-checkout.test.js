'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Stripe = require('stripe');
const policy = require('./subscription-checkout');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-subscription-repair-'));
for (const key of Object.keys(process.env)) if (/STRIPE|SUPABASE|OPENAI|RESEND|SENTRY|DATABASE_URL/.test(key)) delete process.env[key];
Object.assign(process.env, { PDL_DB_FILE: path.join(temp, 'db.json'), PDL_PLATFORM_FILE: path.join(temp, 'platform.json'),
  PDL_SUPABASE_ENABLED: '0', PDL_TRANSACTIONAL_DB: 'off', PDL_REQUIRE_AUTH: '1', PDL_FOUNDER_ENABLED: '0',
  STRIPE_SECRET_KEY: 'sk_test_synthetic', STRIPE_WEBHOOK_SECRET: 'whsec_local_only', PDL_PUBLIC_URL: 'http://localhost' });
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

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); base = 'http://127.0.0.1:' + server.address().port;
  try {
    // Every standard price and period preserves the same absolute deadline.
    for (const plan of ['starter', 'growth', 'pro']) for (const billingCycle of ['monthly', 'annual']) {
      const c = await signup(plan), end = c.read().company.trialEndsAt;
      const result = await c.request('/api/billing/checkout', 'POST', { plan, billingCycle });
      assert.equal(result.status, 200); const pending = c.read().company.pendingCheckout;
      assert.equal(Number(pending.params['subscription_data[billing_cycle_anchor]']), Math.ceil(Date.parse(end) / 1000));
      assert.equal(c.read().company.trialEndsAt, end); assert.equal((await c.request('/api/billing')).data.status, 'Trial');
      assert.equal(pending.params['line_items[0][price]'], `price_${plan}_${billingCycle}`);
    }
    const c = await signup(), end = c.read().company.trialEndsAt;
    process.env.PDL_CHECKOUT_DISABLED = '1'; const disabledCount = created;
    assert.equal((await c.request('/api/billing/checkout', 'POST', { plan: 'starter' })).status, 503);
    assert.equal(created, disabledCount); delete process.env.PDL_CHECKOUT_DISABLED;
    failAfterCreate = true; const before = created;
    assert.equal((await c.request('/api/billing/checkout', 'POST', { plan: 'starter' })).status, 502);
    const attempt = c.read().company.pendingCheckout.attempt;
    prices.price_rebound = { ...prices.price_starter_monthly, id: 'price_rebound' };
    process.env.STRIPE_PRICE_STARTER = 'price_rebound';
    assert.equal((await c.request('/api/billing/checkout', 'POST', { plan: 'starter' })).status, 409, 'changed configured price cannot replay different provider parameters');
    process.env.STRIPE_PRICE_STARTER = 'price_starter_monthly';
    process.env.STRIPE_SECRET_KEY='sk_live_synthetic';
    assert.equal((await c.request('/api/billing/checkout','POST',{plan:'starter'})).status,503,'ambiguous checkout never replays in another provider mode');
    prices.price_starter_monthly.livemode=true;
    assert.equal((await c.request('/api/billing/checkout','POST',{plan:'starter'})).status,409,'stored creation attempt is bound to its provider mode');
    prices.price_starter_monthly.livemode=false;
    process.env.STRIPE_SECRET_KEY='sk_test_synthetic';
    assert.equal((await c.request('/api/billing/checkout', 'POST', { plan: 'growth' })).status, 409);
    const recovered = await Promise.all(Array.from({ length: 4 }, () => c.request('/api/billing/checkout', 'POST', { plan: 'starter' })));
    assert.ok(recovered.every(r => r.status === 200 && r.data.url === recovered[0].data.url));
    assert.equal(created, before + 1); assert.equal(c.read().company.pendingCheckout.attempt, attempt);
    assert.equal(c.read().company.trialEndsAt, end);
    let session = sessions.get(c.read().company.pendingCheckout.id);
    assert.equal((await c.request('/api/billing/confirm?session_id=' + session.id)).status, 409);
    assert.equal(c.read().company.stripeSubscriptionId, undefined);
    session.status = 'expired';
    assert.equal((await c.request('/api/billing/checkout', 'POST', { plan: 'growth' })).status, 200);
    const changed = c.read().company.pendingCheckout;
    assert.equal(changed.plan, 'growth'); assert.equal(changed.params['subscription_data[billing_cycle_anchor]'], Math.ceil(Date.parse(end) / 1000));
    const trialing = providerSubscription(c, 'active', 'sub_mock_trialing', 'price_growth_monthly');
    Object.assign(trialing,{billing_cycle_anchor:Math.ceil(Date.parse(end)/1000),metadata:{company_id:c.id,original_trial_end:String(Math.ceil(Date.parse(end)/1000))}});
    session = sessions.get(changed.id); Object.assign(session, { status: 'complete', customer: trialing.customer, subscription: trialing.id });
    assert.equal((await c.request('/api/billing/confirm?session_id=' + session.id)).status, 200);
    assert.equal(c.read().company.subscriptionStatus, 'Active'); assert.equal((await c.request('/api/billing')).data.status,'Trial'); assert.equal(c.read().company.plan, 'growth');
    assert.equal(c.read().company.trialEndsAt, end, 'provider trial confirmation keeps original local deadline');

    // Final 48h and the last seconds use the same no-proration anchor.
    for (const remaining of [48*3600000,36*3600000,1000]) {
      const near=await signup(); near.mutate(db=>{db.company.trialEndsAt=new Date(Date.now()+remaining).toISOString()});
      const nearEnd=near.read().company.trialEndsAt;
      assert.equal((await near.request('/api/billing/checkout','POST',{plan:'starter'})).status,200);
      const p=near.read().company.pendingCheckout;
      assert.equal(p.params['subscription_data[billing_cycle_anchor]'],Math.ceil(Date.parse(nearEnd)/1000));
      assert.equal(p.params['subscription_data[proration_behavior]'],'none');
      assert.equal(p.params.payment_method_collection,'always');
      assert.equal(p.params['subscription_data[trial_end]'],undefined);
      assert.equal(near.read().company.trialEndsAt,nearEnd);
    }
    const near=await signup(); near.mutate(db=>{db.company.trialEndsAt=new Date(Date.now()-1000).toISOString()});
    assert.equal((await near.request('/api/billing/checkout','POST',{plan:'starter'})).status,200);
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
    assert.equal((await c.request('/api/billing/checkout','POST',{plan:'starter'})).status,200);
    assert.equal(c.read().company.pendingCheckout.params['subscription_data[billing_cycle_anchor]'],Math.ceil(Date.parse(end)/1000));
    assert.equal(c.read().company.trialEndsAt,end);
    // Missed confirmation/webhook still recovers provider-verified original free eligibility.
    const missed=await signup(); assert.equal((await missed.request('/api/billing/checkout','POST',{plan:'starter'})).status,200);
    const missedPending=missed.read().company.pendingCheckout, missedSub=providerSubscription(missed,'canceled');
    Object.assign(missedSub,{billing_cycle_anchor:missedPending.params['subscription_data[billing_cycle_anchor]'],metadata:{company_id:missed.id,original_trial_end:missedPending.params['subscription_data[metadata][original_trial_end]']}});
    Object.assign(sessions.get(missedPending.id),{status:'complete',customer:missedSub.customer,subscription:missedSub.id});
    assert.equal(missed.read().company.stripeFreePeriod,undefined);
    assert.equal((await missed.request('/api/billing/checkout','POST',{plan:'growth'})).status,200);
    assert.equal(missed.read().company.pendingCheckout.params['subscription_data[billing_cycle_anchor]'],missedPending.params['subscription_data[billing_cycle_anchor]']);
    assert.equal(missed.read().company.pendingCheckout.params['subscription_data[proration_behavior]'],'none');
    // Known open checkout is reused after deadline; a new plan starts normal billing then.
    const crossing=await signup(); crossing.mutate(db=>{db.company.trialEndsAt=new Date(Date.now()+1000).toISOString()});
    assert.equal((await crossing.request('/api/billing/checkout','POST',{plan:'starter'})).status,200);
    const crossingSession=crossing.read().company.pendingCheckout.id;
    await new Promise(resolve=>setTimeout(resolve,1100));
    assert.equal((await crossing.request('/api/billing/checkout','POST',{plan:'starter'})).status,200);
    assert.equal(crossing.read().company.pendingCheckout.id,crossingSession);
    assert.equal((await crossing.request('/api/billing/checkout','POST',{plan:'growth'})).status,200);
    assert.equal(sessions.get(crossingSession).status,'expired');
    assert.equal(crossing.read().company.pendingCheckout.params['subscription_data[billing_cycle_anchor]'],undefined);
    // Completing the selected anchored checkout after its deadline activates normally.
    const completed=await signup(); completed.mutate(db=>{db.company.trialEndsAt=new Date(Date.now()+1000).toISOString()});
    assert.equal((await completed.request('/api/billing/checkout','POST',{plan:'starter'})).status,200);
    const completePending=completed.read().company.pendingCheckout, completeSub=providerSubscription(completed,'active');
    Object.assign(completeSub,{billing_cycle_anchor:completePending.params['subscription_data[billing_cycle_anchor]'],metadata:{company_id:completed.id,original_trial_end:completePending.params['subscription_data[metadata][original_trial_end]']}});
    await new Promise(resolve=>setTimeout(resolve,2100));
    Object.assign(sessions.get(completePending.id),{status:'complete',customer:completeSub.customer,subscription:completeSub.id});
    assert.equal((await completed.request('/api/billing/confirm?session_id='+completePending.id)).status,200);
    assert.equal((await completed.request('/api/billing')).data.status,'Active');
    completeSub.status='canceled'; await webhook(completeSub,'canceled_after_deadline');
    assert.equal((await completed.request('/api/billing/checkout','POST',{plan:'starter'})).status,200);
    assert.equal(completed.read().company.pendingCheckout.params['subscription_data[billing_cycle_anchor]'],undefined);
    // An unresolved creation crossing its anchor fails closed, without a new charge attempt.
    const ambiguous=await signup(); ambiguous.mutate(db=>{db.company.trialEndsAt=new Date(Date.now()+1000).toISOString()});
    failAfterCreate=true; assert.equal((await ambiguous.request('/api/billing/checkout','POST',{plan:'starter'})).status,502);
    const ambiguousAttempt=ambiguous.read().company.pendingCheckout.attempt, callsBefore=calls.length;
    await new Promise(resolve=>setTimeout(resolve,2100));
    assert.equal((await ambiguous.request('/api/billing/checkout','POST',{plan:'starter'})).status,409);
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
    assert.equal((await returning.request('/api/billing/checkout', 'POST', { plan: 'starter' })).status, 503);
    assert.equal(returning.read().company.stripeSubscriptionId, old.id); corruptSubscription = false;
    corruptSubscription = 'mode';
    assert.equal((await returning.request('/api/billing/checkout', 'POST', { plan: 'starter' })).status, 503);
    assert.equal(returning.read().company.stripeSubscriptionId, old.id); corruptSubscription = false;
    providerOutage = true; assert.equal((await returning.request('/api/billing/checkout', 'POST', { plan: 'starter' })).status, 502);
    assert.equal(returning.read().company.stripeSubscriptionId, old.id); providerOutage = false;
    historyMore = true; assert.equal((await returning.request('/api/billing/checkout', 'POST', { plan: 'starter' })).status, 503); historyMore = false;
    const recoveredCount = created;
    const retry = await Promise.all([1, 2, 3].map(() => returning.request('/api/billing/checkout', 'POST', { plan: 'starter' })));
    assert.ok(retry.every(r => r.status === 200 && r.data.url === retry[0].data.url)); assert.equal(created, recoveredCount + 1);
    assert.equal(returning.read().company.stripeCustomerId, old.customer); assert.equal(returning.read().company.stripeSubscriptionId, undefined);
    assert.equal(returning.read().company.pendingCheckout.params['subscription_data[billing_cycle_anchor]'], undefined, 'never grant returning subscriber another trial');
    assert.ok(returning.read().company.retiredStripeSubscriptionIds.includes(old.id));
    assert.equal((await webhook(old, 'old_before_new')).status, 200); assert.equal(returning.read().company.stripeSubscriptionId, undefined);
    assert.equal((await returning.request('/api/billing/confirm?session_id=' + oldSession.id)).status, 409);
    const fresh = providerSubscription(returning, 'active', 'sub_mock_replacement');
    assert.equal((await webhook(fresh, 'new')).status, 200); assert.equal(returning.read().company.stripeSubscriptionId, fresh.id);
    assert.equal((await webhook(old, 'old_after_new')).status, 200); assert.equal(returning.read().company.subscriptionStatus, 'Active');
    assert.equal((await returning.request('/api/billing/checkout', 'POST', { plan: 'starter' })).status, 409);

    for (const status of ['active', 'trialing', 'past_due', 'unpaid', 'paused', 'incomplete']) {
      const a = await signup(), sub = providerSubscription(a, status);
      a.mutate(db => Object.assign(db.company, { stripeSubscriptionId: sub.id, stripeCustomerId: sub.customer, subscriptionStatus: 'Cancelled' }));
      assert.equal((await a.request('/api/billing/checkout', 'POST', { plan: 'starter' })).status, 409);
      assert.equal(a.read().company.stripeSubscriptionId, sub.id);
    }
    const missing = await signup(), hidden = providerSubscription(missing, 'active');
    missing.mutate(db => { db.company.stripeCustomerId = hidden.customer; });
    assert.equal((await missing.request('/api/billing/checkout', 'POST', { plan: 'starter' })).status, 409, 'provider history protects a lost local subscription ID');
    const expired = await signup(), expiredSub = providerSubscription(expired, 'incomplete_expired');
    expired.mutate(db => Object.assign(db.company, { stripeSubscriptionId: expiredSub.id, stripeCustomerId: expiredSub.customer, subscriptionStatus: 'Cancelled' }));
    assert.equal((await expired.request('/api/billing/checkout', 'POST', { plan: 'starter' })).status, 200);
    const founder = await signup(), founderSub = providerSubscription(founder, 'canceled');
    const founderTerms = { requested: true, plan: 'starter', billingCycle: 'monthly', assistedSetup: true,
      paidAt: '2026-09-28T00:00:00Z', protectedUntil: '2028-09-28T00:00:00Z' };
    founder.mutate(db => Object.assign(db.company, { stripeSubscriptionId: founderSub.id, stripeCustomerId: founderSub.customer,
      subscriptionStatus: 'Cancelled', founder: founderTerms }));
    const founderResult = await founder.request('/api/billing/checkout', 'POST', { plan: 'starter' });
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
