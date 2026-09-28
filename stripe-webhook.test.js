const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Stripe = require('stripe');
const { verifyEvent, processEvent } = require('./stripe-webhook');

const secret = 'whsec_local_test_only';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-webhook-'));
Object.assign(process.env, {
  PDL_DB_FILE: path.join(temp, 'db.json'), PDL_PLATFORM_FILE: path.join(temp, 'platform.json'),
  PDL_SUPABASE_ENABLED: '0', PDL_REQUIRE_AUTH: '1', STRIPE_WEBHOOK_SECRET: secret,
  STRIPE_SECRET_KEY: 'sk_test_local_only', STRIPE_PRICE_STARTER: 'price_starter',
});
const seed = JSON.parse(fs.readFileSync(path.join(__dirname, 'data/db.json')));
seed.company.id = '11111111-1111-4111-8111-111111111111';
seed.company.subscriptionStatus = 'Cancelled';
delete seed.company.stripeCustomerId;
delete seed.company.stripeSubscriptionId;
fs.writeFileSync(process.env.PDL_DB_FILE, JSON.stringify(seed));
const otherId = '22222222-2222-4222-8222-222222222222';
fs.mkdirSync(path.join(temp, 'tenants'));
fs.writeFileSync(path.join(temp, 'tenants', `${otherId}.json`), JSON.stringify({ ...seed, company: { ...seed.company, id: otherId } }));
let current = { id: 'sub_test', customer: 'cus_test', metadata: { company_id: seed.company.id },
  status: 'active', items: { data: [{ price: { id: 'price_starter' }, current_period_end: 1800000000 }] } };
const realFetch = global.fetch;
let failStripe = false;
let stripeCalls = 0;
global.fetch = async (url, options) => {
  if (String(url).startsWith('https://api.stripe.com/')) {
    stripeCalls++;
    if (failStripe) return new Response(JSON.stringify({ error: { message: 'Test outage' } }), { status: 503 });
    assert.equal(options.method, 'GET');
    return new Response(JSON.stringify(current));
  }
  return realFetch(url, options);
};
const { server } = require('./server');
const event = (id, type = 'customer.subscription.updated', object = current) => ({
  id, type, created: Math.floor(Date.now() / 1000), livemode: false, data: { object },
});
const sign = (payload, timestamp) => Stripe.webhooks.generateTestHeaderString({ payload, secret, timestamp });
const read = () => JSON.parse(fs.readFileSync(process.env.PDL_DB_FILE));

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const send = async (value, signature, headers = {}) => {
    const payload = typeof value === 'string' ? value : JSON.stringify(value);
    return realFetch(`${base}/api/billing/webhook`, { method: 'POST', body: payload,
      headers: { 'content-type': 'application/json', 'stripe-signature': signature ?? sign(payload), ...headers } });
  };
  try {
    const payload = JSON.stringify(event('evt_signature'));
    assert.throws(() => verifyEvent(Buffer.from(payload), sign(payload), {}), /not configured/);
    assert.equal((await send(payload, '')).status, 400);
    assert.equal((await send(payload + ' ', sign(payload))).status, 400);
    assert.equal((await send(payload, sign(payload, Math.floor(Date.now() / 1000) - 600))).status, 400);
    assert.equal((await send('{bad json')).status, 400);
    assert.equal((await send({ ...event('evt_live'), livemode: true })).status, 400);
    assert.equal(stripeCalls, 0, 'reject forged/malformed events before Stripe API calls');
    assert.equal((await send(event('evt_ignore', 'charge.succeeded'))).status, 200);
    assert.equal(stripeCalls, 0);

    // Authentication and an unrelated tenant header/cookie cannot select the webhook tenant.
    const result = await send(event('evt_active'), undefined, { 'x-pdl-company': otherId, cookie: `pdl_company=${otherId}` });
    assert.equal(result.status, 200);
    assert.equal(read().company.subscriptionStatus, 'Active');
    assert.equal(read().company.plan, 'starter');
    assert.equal(read().company.nextBillingAt, new Date(1800000000 * 1000).toISOString());
    assert.equal(JSON.parse(fs.readFileSync(path.join(temp, 'tenants', `${otherId}.json`))).company.subscriptionStatus, 'Cancelled');
    assert.equal((await send(event('evt_active'))).status, 200);
    assert.equal(read().company.stripeWebhookEvents.filter(id => id === 'evt_active').length, 1);

    current.status = 'past_due';
    const invoice = { id: 'in_test', customer: 'cus_test', parent: { subscription_details: { subscription: 'sub_test' } } };
    assert.equal((await send(event('evt_invoice', 'invoice.payment_failed', invoice))).status, 200);
    assert.equal(read().company.subscriptionStatus, 'Past due');
    current.status = 'active';
    assert.equal((await send(event('evt_invoice_old', 'invoice.paid', { ...invoice, parent: undefined, subscription: 'sub_test' }))).status, 200);
    assert.equal(read().company.subscriptionStatus, 'Active');
    current.status = 'canceled';
    assert.equal((await send(event('evt_cancel', 'customer.subscription.deleted'))).status, 200);
    // An older active snapshot must not reactivate a canceled subscription.
    assert.equal((await send(event('evt_late', 'customer.subscription.updated', { ...current, status: 'active' }))).status, 200);
    assert.equal(read().company.subscriptionStatus, 'Cancelled');

    failStripe = true;
    assert.equal((await send(event('evt_retry'))).status, 500);
    assert.ok(!read().company.stripeWebhookEvents.includes('evt_retry'));
    failStripe = false;
    assert.equal((await send(event('evt_retry'))).status, 200, 'queue and server survive failed delivery');
    const rotationHeader = `${sign(payload)},v1=${'0'.repeat(64)}`;
    assert.equal((await send(payload, rotationHeader)).status, 200);
    current.customer = 'cus_wrong';
    assert.equal((await send(event('evt_wrong_customer'))).status, 400);
    current.customer = 'cus_test';
    current.metadata.company_id = '33333333-3333-4333-8333-333333333333';
    assert.equal((await send(event('evt_missing_company'))).status, 500);
    current.metadata.company_id = seed.company.id;

    // A cloud failure after local persistence must be retried, including duplicate event IDs.
    const db = { company: { id: seed.company.id } };
    let saves = 0;
    const deps = { stripeRequest: async () => current, withCompany: async (_, task) => task(db),
      applySubscription: target => { target.company.subscriptionStatus = 'Cancelled'; },
      persist: async () => { if (++saves === 1) throw new Error('Cloud unavailable'); } };
    await assert.rejects(processEvent(event('evt_cloud'), deps), /Cloud unavailable/);
    await processEvent(event('evt_cloud'), deps);
    assert.equal(saves, 2);
    assert.equal(db.company.stripeWebhookEvents.length, 1);
    console.log('Stripe webhook tests passed: signatures, rotation, mode, tenant isolation, current state, invoices, duplicates and retries');
  } finally {
    global.fetch = realFetch;
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
