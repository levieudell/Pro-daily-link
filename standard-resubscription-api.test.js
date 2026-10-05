'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const Stripe = require('stripe');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-standard-resubscription-'));
const companyId = '11111111-1111-4111-8111-111111111111';
const otherId = '22222222-2222-4222-8222-222222222222';
const secret = 'whsec_synthetic_resubscription';
Object.assign(process.env, { PDL_DB_FILE: path.join(temp, 'db.json'), PDL_PLATFORM_FILE: path.join(temp, 'platform.json'),
  PDL_SUPABASE_ENABLED: '0', PDL_TRANSACTIONAL_DB: 'off', PDL_REQUIRE_AUTH: '1', PDL_FOUNDER_ENABLED: '0',
  STRIPE_SECRET_KEY: 'sk_test_synthetic_resubscription', STRIPE_WEBHOOK_SECRET: secret,
  STRIPE_PRICE_STARTER: 'price_starter', STRIPE_PRICE_STARTER_ANNUAL: 'price_starter_annual',
  STRIPE_PRICE_GROWTH: 'price_growth', STRIPE_PRICE_GROWTH_ANNUAL: 'price_growth_annual',
  STRIPE_PRICE_PRO: 'price_pro', STRIPE_PRICE_PRO_ANNUAL: 'price_pro_annual',
  STRIPE_PRICE_FOUNDER_STARTER: 'price_founder', PDL_PUBLIC_URL: 'https://pdl.example.invalid' });
for (const key of ['SENTRY_DSN', 'RESEND_API_KEY', 'OPENAI_API_KEY']) delete process.env[key];
const original = JSON.parse(fs.readFileSync(path.join(__dirname, 'data/db.json'), 'utf8'));
const seed = { ...original, company: { id: companyId, name: 'Synthetic re-subscription', plan: 'starter', billingCycle: 'monthly',
  subscriptionStatus: 'Cancelled', stripeCustomerId: 'cus_owner', stripeSubscriptionId: 'sub_old',
  persistence: { revision: 1 }, demo: false, features: {} }, assignments: [], workdays: [], reports: [], projects: [],
  users: [{ id: 1, companyId, name: 'Owner', email: 'owner@example.invalid', role: 'owner', status: 'Active', emailVerifiedAt: new Date().toISOString() }],
  sessions: [{ id: 'session', companyId, userId: 1, tokenHash: crypto.createHash('sha256').update('synthetic-owner').digest('hex'), expiresAt: '2099-01-01T00:00:00Z' }] };
fs.copyFileSync(path.join(__dirname, 'data/platform.json'), process.env.PDL_PLATFORM_FILE);
const oldSubscription = () => ({ id: 'sub_old', customer: 'cus_owner', status: 'canceled', livemode: false,
  metadata: { company_id: companyId }, items: { data: [{ price: { id: 'price_starter' }, current_period_end: 1900000000 }] } });
const oldSession = () => ({ id: 'cs_old', customer: 'cus_owner', subscription: 'sub_old', mode: 'subscription', livemode: false,
  client_reference_id: companyId, metadata: { company_id: companyId }, status: 'complete', payment_status: 'paid', url: 'https://checkout.stripe.com/c/pay/cs_old' });
let subscriptions, sessions, invoices, creates, expires, createFailure, readFailure, nextSession, byKey, calls, onExpire;
function reset(extra = {}) {
  subscriptions = new Map([['sub_old', oldSubscription()]]); sessions = new Map([['cs_old', oldSession()]]); invoices = new Map();
  creates = 0; expires = 0; createFailure = ''; readFailure = false; nextSession = 1; byKey = new Map(); calls = []; onExpire = null;
  fs.writeFileSync(process.env.PDL_DB_FILE, JSON.stringify({ ...structuredClone(seed), company: { ...structuredClone(seed.company), ...extra } }));
}
reset();
const realFetch = global.fetch;
global.fetch = async (url, options = {}) => {
  const address = String(url);
  if (address.startsWith('http://127.0.0.1:')) return realFetch(url, options);
  assert.ok(address.startsWith('https://api.stripe.com/v1/'), 'no external provider may be contacted');
  const route = address.slice('https://api.stripe.com/v1'.length), method = options.method;
  calls.push({ route, method, body: options.body?.toString(), key: options.headers?.['Idempotency-Key'] });
  const response = value => new Response(JSON.stringify(structuredClone(value)));
  if (method === 'GET') {
    if (readFailure) return new Response(JSON.stringify({ error: { message: 'Synthetic Stripe outage' } }), { status: 503 });
    if (route.startsWith('/subscriptions/')) return response(subscriptions.get(decodeURIComponent(route.slice(15))));
    if (route.startsWith('/checkout/sessions/')) return response(sessions.get(decodeURIComponent(route.slice(19))));
    if (route.startsWith('/invoices/')) return response(invoices.get(decodeURIComponent(route.slice(10))));
    if (route.startsWith('/prices/')) {
      const id = route.slice(8), annual = id.endsWith('_annual');
      const amount = id.includes('growth') ? 19900 : id.includes('pro') ? 39900 : 9900;
      return response({ id, active: true, livemode: false, currency: 'usd', unit_amount: amount * (annual ? 10 : 1),
        type: 'recurring', recurring: { interval: annual ? 'year' : 'month', interval_count: 1 } });
    }
  }
  if (method === 'POST' && route === '/checkout/sessions') {
    creates++;
    const params = new URLSearchParams(options.body), key = options.headers['Idempotency-Key'];
    const previous = byKey.get(key);
    if (previous) { assert.equal(previous.body, options.body.toString(), 'idempotency retries must use identical parameters'); return response(sessions.get(previous.id)); }
    if (createFailure === 'before') return new Response(JSON.stringify({ error: { message: 'Synthetic create outage' } }), { status: 503 });
    const id = 'cs_new_' + nextSession++, metadata = {};
    for (const [name, value] of params) { const match = name.match(/^metadata\[([^\]]+)\]$/); if (match) metadata[match[1]] = value; }
    const session = { id, customer: params.get('customer'), mode: params.get('mode'), livemode: false,
      client_reference_id: params.get('client_reference_id'), metadata, status: 'open', subscription: null,
      payment_status: 'unpaid', url: 'https://checkout.stripe.com/c/pay/' + id };
    sessions.set(id, session); byKey.set(key, { id, body: options.body.toString() });
    if (createFailure === 'after') throw new Error('Synthetic response lost after creation');
    return response(session);
  }
  if (method === 'POST' && route.endsWith('/expire')) {
    expires++; const session = sessions.get(route.split('/')[3]); assert.equal(session.status, 'open'); if (onExpire) onExpire(session); session.status = 'expired'; return response(session);
  }
  throw new Error('Unexpected synthetic Stripe request: ' + method + ' ' + route);
};
const read = () => JSON.parse(fs.readFileSync(process.env.PDL_DB_FILE));
const { server } = require('./server');
const supabase = require('./database/supabase');
let base;
async function request(route, method = 'GET', input, headers = {}) {
  const response = await realFetch(base + route, { method,
    headers: { Authorization: 'Bearer synthetic-owner', 'Content-Type': 'application/json', ...headers },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
  return { status: response.status, data: await response.json() };
}
const checkout = (plan = 'starter', billingCycle = 'monthly') => request('/api/billing/checkout', 'POST', { plan, billingCycle });
function replacement(id = 'sub_new', status = 'active') {
  const db = read(), pending = db.company.pendingCheckout, session = sessions.get(pending.id);
  const subscription = { id, customer: 'cus_owner', status, livemode: false, metadata: { ...session.metadata },
    items: { data: [{ price: { id: pending.params['line_items[0][price]'] }, current_period_end: 1900000000 }] }, latest_invoice: 'in_' + id };
  subscriptions.set(id, subscription);
  invoices.set(subscription.latest_invoice, { id: subscription.latest_invoice, status: 'paid', paid: true, customer: 'cus_owner', subscription: id,
    parent: { subscription_details: { subscription: id } }, livemode: false });
  session.subscription = id; session.status = status === 'incomplete' ? 'open' : 'complete'; session.payment_status = status === 'active' ? 'paid' : 'unpaid';
  return subscription;
}
let eventIndex = 0;
async function webhook(subscription, type = 'customer.subscription.updated', eventId) {
  const event = { id: eventId || 'evt_resub_' + ++eventIndex, type, created: Math.floor(Date.now() / 1000), livemode: false, data: { object: subscription } };
  const payload = JSON.stringify(event);
  return request('/api/billing/webhook', 'POST', event, { 'stripe-signature': Stripe.webhooks.generateTestHeaderString({ payload, secret }), 'x-pdl-company': otherId });
}

(async () => {
  let child;
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = 'http://127.0.0.1:' + server.address().port;
  try {
    for (const status of ['active', 'trialing', 'past_due', 'unpaid', 'paused', 'incomplete']) {
      reset(); subscriptions.get('sub_old').status = status; subscriptions.get('sub_old').cancel_at_period_end = true;
      const result = await checkout(); assert.equal(result.status, 409, status + ': ' + JSON.stringify(result.data));
      assert.equal(creates, 0); assert.equal(read().company.stripeSubscriptionId, 'sub_old'); assert.equal(read().company.stripeRetiredSubscriptionIds, undefined);
      assert.equal((await request('/api/billing')).data.canRestartSubscription, false, 'a local cancellation cannot enable the current-plan button');
    }
    for (const status of ['canceled', 'incomplete_expired']) {
      reset({ pendingCheckout: { id: 'cs_old', attempt: 'old-attempt', status: 'open', plan: 'starter', cycle: 'monthly' } });
      subscriptions.get('sub_old').status = status;
      assert.equal((await request('/api/billing')).data.canRestartSubscription, true, 'only a fresh terminal proof enables restart');
      const result = await checkout(); assert.equal(result.status, 200, status + ': ' + JSON.stringify(result.data));
      assert.equal(creates, 1); assert.deepEqual(read().company.stripeRetiredSubscriptionIds, ['sub_old']);
      assert.equal(read().company.stripeSubscriptionId, undefined); assert.equal((await request('/api/account-access')).data.locked, true);
    }
    reset(); readFailure = true;
    assert.equal((await request('/api/billing')).data.canRestartSubscription, false, 'provider outage cannot reuse stale availability');
    assert.equal((await checkout()).status, 503); assert.equal(read().company.stripeSubscriptionId, 'sub_old'); assert.equal(creates, 0);
    reset({ pendingCheckout: { status: 'creating', attempt: 'unknown-attempt', plan: 'starter', cycle: 'monthly' } });
    assert.equal((await checkout()).status, 409); assert.equal(creates, 0);
    reset({ pendingCheckout: { id: 'cs_old', status: 'open', attempt: 'old-attempt', plan: 'starter', cycle: 'monthly' } });
    sessions.get('cs_old').status = 'open';
    assert.equal((await checkout()).status, 409); assert.equal(creates, 0);

    reset();
    const double = await Promise.all([checkout(), checkout()]);
    assert.ok(double.every(result => result.status === 200)); assert.equal(double[0].data.url, double[1].data.url); assert.equal(creates, 1, 'double-click reopens one session');
    const savedAttempt = read().company.pendingCheckout;
    assert.equal(savedAttempt.params.customer, 'cus_owner');
    assert.equal(savedAttempt.params['subscription_data[metadata][checkout_attempt]'], savedAttempt.attempt);
    assert.equal(savedAttempt.params['subscription_data[metadata][replaces_subscription]'], 'sub_old');
    assert.equal((await request('/api/billing/confirm?session_id=' + savedAttempt.id)).data.locked, true, 'success return alone never grants replacement access');
    assert.equal((await request('/api/billing/confirm?session_id=cs_old')).status, 404);
    assert.equal(read().company.stripeSubscriptionId, undefined);
    const paid = replacement(); invoices.get(paid.latest_invoice).status = 'open'; invoices.get(paid.latest_invoice).paid = false;
    assert.equal((await webhook(paid)).status, 503, 'unpaid active snapshot cannot activate replacement');
    assert.equal(read().company.stripeSubscriptionId, undefined); assert.equal((await request('/api/account-access')).data.locked, true);
    invoices.get(paid.latest_invoice).status = 'paid'; invoices.get(paid.latest_invoice).paid = true;
    paid.metadata.checkout_attempt = 'wrong-attempt'; assert.equal((await webhook(paid)).status, 400);
    paid.metadata.checkout_attempt = savedAttempt.attempt;
    assert.equal((await webhook(paid, undefined, 'evt_paid')).status, 200);
    assert.equal(read().company.stripeSubscriptionId, 'sub_new'); assert.equal((await request('/api/account-access')).data.locked, false);
    assert.equal((await webhook(paid, undefined, 'evt_paid')).status, 200); assert.equal(read().company.stripeWebhookEvents.filter(id => id === 'evt_paid').length, 1);
    subscriptions.get('sub_old').status = 'active'; assert.equal((await webhook(subscriptions.get('sub_old'))).status, 200);
    assert.equal(read().company.stripeSubscriptionId, 'sub_new', 'retired replay cannot replace current subscription');
    const state = await request('/api/state'); assert.equal(state.status, 200);
    for (const key of ['pendingCheckout', 'stripeResubscription', 'stripeRetiredSubscriptionIds']) assert.equal(state.data.company[key], undefined);
    const exported = (await request('/api/company/export')).data;
    for (const key of ['pendingCheckout', 'stripeResubscription', 'stripeRetiredSubscriptionIds']) assert.equal(exported.company[key], undefined);

    // A new process reads exactly the persisted entitlement and retired-ID history.
    await new Promise(resolve => server.close(resolve));
    child = spawn(process.execPath, ['-e', "const {server}=require('./server');server.listen(0,'127.0.0.1',()=>process.stdout.write(String(server.address().port)+'\\n'))"], { cwd: __dirname, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    const port = await new Promise((resolve, reject) => { child.stdout.once('data', value => resolve(Number(String(value).trim()))); child.once('error', reject); child.once('exit', () => reject(Error('Restart process exited early'))); });
    base = 'http://127.0.0.1:' + port;
    assert.equal((await request('/api/account-access')).data.locked, false);
    await new Promise(resolve => { child.once('exit', resolve); child.kill(); }); child = null;
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); base = 'http://127.0.0.1:' + server.address().port;

    reset(); createFailure = 'after';
    assert.equal((await checkout()).status, 502); assert.equal(read().company.pendingCheckout.status, 'creating'); assert.equal(sessions.size, 2);
    const uncertain = read().company.pendingCheckout, firstBody = calls.find(call => call.route === '/checkout/sessions' && call.method === 'POST').body;
    assert.equal((await checkout('growth')).status, 409, 'uncertain creation cannot switch plan and create a duplicate');
    createFailure = ''; assert.equal((await checkout()).status, 200);
    const retryCall = calls.filter(call => call.route === '/checkout/sessions' && call.method === 'POST').at(-1);
    assert.equal(retryCall.body, firstBody); assert.equal(retryCall.key, 'checkout-' + companyId + '-' + uncertain.attempt); assert.equal(sessions.size, 2);
    reset(); createFailure = 'after'; await checkout();
    const stale = read(); stale.company.pendingCheckout.createdAt = new Date(Date.now() - 24 * 3600000).toISOString(); fs.writeFileSync(process.env.PDL_DB_FILE, JSON.stringify(stale));
    createFailure = ''; assert.equal((await checkout()).status, 409); assert.equal(creates, 1, 'expired idempotency window needs review');

    reset(); await checkout(); const incomplete = replacement('sub_retry', 'incomplete');
    assert.equal((await webhook(incomplete)).status, 200); assert.equal((await request('/api/account-access')).data.locked, true);
    const resumeSummary = (await request('/api/billing')).data; assert.equal(resumeSummary.canResumeCheckout, true); assert.equal(resumeSummary.canRestartSubscription, false);
    const beforeResume = creates; const retry = await checkout(); assert.equal(retry.status, 200, JSON.stringify(retry.data)); assert.equal(creates, beforeResume, 'declined payment resumes the same incomplete/open checkout');
    assert.equal((await checkout('growth')).status, 409);
    incomplete.status = 'trialing'; assert.equal((await webhook(incomplete)).status, 200); assert.equal((await request('/api/account-access')).data.locked, true, 'unexpected trial cannot bypass payment');
    assert.equal((await checkout()).status, 409);

    // Stripe may already have a subscription before its webhook stores the local ID.
    reset(); await checkout(); const lagging = replacement('sub_webhook_lag', 'incomplete');
    assert.equal(read().company.stripeSubscriptionId, undefined);
    assert.equal((await checkout('growth')).status, 409); assert.equal(creates, 1); assert.equal(expires, 0, 'nonterminal attached subscription cannot be expired to bypass the gate');
    assert.ok(calls.some(call => call.route === '/subscriptions/sub_webhook_lag' && call.method === 'GET'));
    assert.equal((await checkout()).status, 200); assert.equal(creates, 1, 'same incomplete/open attempt is resumable before its webhook');
    sessions.get(read().company.pendingCheckout.id).status = 'expired';
    assert.equal((await checkout()).status, 409); assert.equal(creates, 1, 'an expired session alone does not make its subscription terminal');
    lagging.status = 'incomplete_expired';
    assert.equal((await checkout()).status, 200); assert.equal(creates, 2); assert.ok(read().company.stripeRetiredSubscriptionIds.includes(lagging.id));

    reset(); await checkout();
    onExpire = () => { replacement('sub_expiry_race', 'incomplete'); };
    assert.equal((await checkout('growth')).status, 409); assert.equal(creates, 1); assert.equal(expires, 1, 're-read after expiry catches a subscription created during the race');
    onExpire = null; subscriptions.get('sub_expiry_race').status = 'incomplete_expired';
    assert.equal((await checkout('growth')).status, 200); assert.equal(creates, 2);

    reset(); await checkout(); const expiredAttempt = read().company.pendingCheckout.attempt; sessions.get(read().company.pendingCheckout.id).status = 'expired';
    assert.equal((await checkout()).status, 200); assert.equal(creates, 2);
    assert.ok(read().company.stripeResubscription.retiredCheckoutAttempts.includes(expiredAttempt));
    const orphan = replacement('sub_orphan'); orphan.metadata.checkout_attempt = expiredAttempt;
    assert.equal((await webhook(orphan)).status, 200); assert.equal(read().company.stripeSubscriptionId, undefined, 'expired-attempt webhook cannot grant current access');

    // Real server persistence barriers with an injected private-storage failure. The
    // fake adapter never contacts Supabase and does not create production records.
    const originals = { configured: supabase.configured, saveCompanySnapshot: supabase.saveCompanySnapshot };
    const originalError = console.error;
    let saveNumber = 0, failAt = 1, durable;
    supabase.configured = () => true;
    supabase.saveCompanySnapshot = async value => {
      saveNumber++;
      if (saveNumber === failAt) throw Error('Synthetic persistence failure with private details');
      durable = structuredClone(value); return true;
    };
    console.error = () => {};
    try {
      reset();
      const firstFailure = await checkout(); assert.equal(firstFailure.status, 502); assert.equal(creates, 0, 'no Stripe creation before retirement/pending persistence');
      assert.equal(JSON.stringify(firstFailure.data).includes('private details'), false);
      failAt = -1;
      assert.equal((await checkout()).status, 200); assert.equal(creates, 1); assert.ok(durable.company.stripeRetiredSubscriptionIds.includes('sub_old'));

      reset(); saveNumber = 0; failAt = 3;
      assert.equal((await checkout()).status, 502, 'saved Checkout ID failure is not acknowledged as complete'); assert.equal(creates, 1);
      failAt = -1; assert.equal((await checkout()).status, 200); assert.equal(creates, 1, 'durable retry reuses already-created Checkout');
      const recovered = replacement('sub_durable');
      failAt = saveNumber + 1;
      assert.equal((await webhook(recovered, undefined, 'evt_durable')).status, 500);
      failAt = -1;
      assert.equal((await webhook(recovered, undefined, 'evt_durable')).status, 200);
      assert.equal(durable.company.stripeSubscriptionId, 'sub_durable');
      assert.equal(durable.company.stripeWebhookEvents.filter(id => id === 'evt_durable').length, 1);
    } finally {
      supabase.configured = originals.configured; supabase.saveCompanySnapshot = originals.saveCompanySnapshot; console.error = originalError;
    }
    console.log('Standard re-subscription HTTP passed: terminal-only retirement, exact bindings, one-session retries, lost-response idempotency, decline resume, verified activation, retired replays, process restart, private state and trial denial. No live Stripe calls.');
  } finally {
    if (child) child.kill();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    global.fetch = realFetch; fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
