'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const Stripe = require('stripe');
const enterprise = require('./enterprise-billing');
const { fixture, input, epoch, env, COMPANY, OTHER } = require('./fixtures/enterprise-billing');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-enterprise-api-'));
const hash = token => crypto.createHash('sha256').update(token).digest('hex');
const token = role => 'enterprise-synthetic-' + role;
const expiresAt = new Date(Date.now() + 86400000).toISOString();
const seed = JSON.parse(fs.readFileSync(path.join(__dirname, 'data/db.json')));
seed.company = { ...seed.company, id: COMPANY, name: 'Enterprise API synthetic', plan: 'starter', subscriptionStatus: 'Active', features: { templates: false, timeCards: false }, demo: false, billingExempt: false };
for (const key of ['stripeSubscriptionId', 'stripeCustomerId', 'pendingCheckout', 'founder', 'enterpriseActiveQuoteId', 'enterpriseQuotes']) delete seed.company[key];
seed.users = ['owner', 'admin', 'project_manager', 'field'].map((role, i) => ({ id: i + 1, companyId: COMPANY, role, name: role, email: role + '@synthetic.example', status: 'Active', memberId: role === 'field' ? 1 : null }));
seed.sessions = seed.users.map(user => ({ userId: user.id, companyId: COMPANY, tokenHash: hash(token(user.role)), expiresAt }));
seed.projects = []; seed.team = [{ id: 1, name: 'Synthetic field', email: 'field@synthetic.example', crew: 'Synthetic' }]; seed.reports = []; seed.assignments = [];
Object.assign(process.env, env, { PDL_DB_FILE: path.join(tmp, 'db.json'), PDL_PLATFORM_FILE: path.join(tmp, 'platform.json'), PDL_SUPABASE_ENABLED: '0', PDL_TRANSACTIONAL_DB: 'off', PDL_PLATFORM_KEY: 'pdl-synthetic-platform-key-32-characters' });
fs.writeFileSync(process.env.PDL_DB_FILE, JSON.stringify(seed)); fs.mkdirSync(path.join(tmp, 'tenants'));
const other = structuredClone(seed); other.company.id = OTHER; other.company.name = 'Other synthetic tenant'; other.users.forEach(u => u.companyId = OTHER); other.sessions = [];
fs.writeFileSync(path.join(tmp, 'tenants', OTHER + '.json'), JSON.stringify(other));
const platform = { users: [{ id: 1, role: 'platform_owner', name: 'Synthetic Owner', status: 'Active' }, { id: 2, role: 'support', name: 'Synthetic support', status: 'Active' }],
  sessions: [{ userId: 1, tokenHash: hash(token('platform_owner')), expiresAt }, { userId: 2, tokenHash: hash(token('support')), expiresAt }] };
fs.writeFileSync(process.env.PDL_PLATFORM_FILE, JSON.stringify(platform));
const f = fixture(), originalService = enterprise.createService;
enterprise.createService = options => originalService({ ...options, client: f.client, now: () => Date.now() });
const { server } = require('./server');
enterprise.createService = originalService;
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const route = '/api/platform/companies/' + COMPANY + '/enterprise-quotes';
  const ownerRoute = '/api/billing/enterprise-quotes';
  async function request(url, role, method = 'GET', value, company = COMPANY) {
    const platformRole = ['platform_owner', 'support'].includes(role);
    const response = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', 'X-PDL-Company': company,
      ...(role ? { cookie: (platformRole ? 'pdl_platform=' : 'pdl_session=') + token(role) + '; pdl_company=' + company } : {}) }, ...(value ? { body: JSON.stringify(value) } : {}) });
    return { status: response.status, data: await response.json() };
  }
  const read = () => JSON.parse(fs.readFileSync(process.env.PDL_DB_FILE));
  try {
    assert.equal((await request(route)).status, 401);
    assert.equal((await request(route, 'support')).status, 403);
    assert.equal((await request(route, 'owner')).status, 401);
    const key = await fetch(base + route, { headers: { 'x-pdl-platform-key': process.env.PDL_PLATFORM_KEY } }); assert.equal(key.status, 403, 'bootstrap key cannot manage commercial quotes');
    for (const role of ['admin', 'project_manager', 'field']) assert.equal((await request(ownerRoute, role)).status, 403);
    const created = await request(route, 'platform_owner', 'POST', input({ expiresAt: new Date(Date.now() + 7 * 86400000).toISOString() }));
    assert.equal(created.status, 201, JSON.stringify(created.data)); const q = created.data;
    assert.equal(q.status, 'draft'); assert.equal((await request(ownerRoute, 'owner')).data.quotes.length, 0);
    assert.equal(read().company.plan, 'starter');
    const state = await request('/api/state', 'owner'); assert.equal(state.status, 200); assert.equal(state.data.company.enterpriseQuotes, undefined);
    assert.equal((await request(route + '/' + q.id + '/issue', 'support', 'POST', { revision: 1, termsDigest: q.termsDigest, commercialApproved: true })).status, 403);
    assert.equal((await request(route + '/' + q.id + '/issue', 'platform_owner', 'POST', { revision: 1, termsDigest: q.termsDigest, commercialApproved: true })).status, 200);
    assert.equal((await request(ownerRoute, 'owner')).data.quotes.length, 1);
    assert.equal((await request(ownerRoute, 'owner', 'GET', null, OTHER)).data.companyId, COMPANY, 'tenant hint cannot move owner token to another company');
    const checkoutInput = { revision: 1, termsDigest: q.termsDigest, termsAccepted: true };
    const paid = await request(ownerRoute + '/' + q.id + '/checkout', 'owner', 'POST', checkoutInput);
    assert.equal(paid.status, 200, JSON.stringify(paid.data)); assert.ok(paid.data.url.startsWith('https://checkout.stripe.com/'));
    assert.equal((await request('/api/billing/checkout', 'owner', 'POST', { plan: 'starter' })).status, 409);
    assert.equal((await request('/api/billing/confirm?session_id=' + f.session().id, 'owner')).data.plan, 'starter', 'return page cannot grant access');
    const piMetadata = { ...f.session().metadata };
    Object.assign(f.session(), { status: 'complete', payment_status: 'paid', customer: 'cus_synthetic', payment_intent: {
      id: 'pi_synthetic', customer: 'cus_synthetic', status: 'succeeded', livemode: false, amount: q.totalAmount, amount_received: q.totalAmount, currency: q.currency, metadata: piMetadata,
      latest_charge: { id: 'ch_synthetic', payment_intent: 'pi_synthetic', amount: q.totalAmount, currency: q.currency, paid: true, livemode: false, created: Math.floor(Date.now() / 1000), amount_refunded: 0, disputed: false }
    } });
    const event = { id: 'evt_enterprise_signed', type: 'checkout.session.completed', created: Math.floor(Date.now() / 1000), livemode: false, data: { object: f.session() } };
    async function webhook(value, signature) {
      const payload = JSON.stringify(value); return fetch(base + '/api/billing/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'x-pdl-company': OTHER,
        'stripe-signature': signature || Stripe.webhooks.generateTestHeaderString({ payload, secret: env.STRIPE_WEBHOOK_SECRET }) }, body: payload });
    }
    assert.equal((await webhook(event, 'bad')).status, 400); assert.equal(read().company.plan, 'starter');
    assert.equal((await webhook(event)).status, 200); assert.equal(read().company.plan, 'enterprise');
    assert.equal(read().company.features.timeCards, true, 'features survive actual writeDb persistence');
    assert.equal(JSON.parse(fs.readFileSync(path.join(tmp, 'tenants', OTHER + '.json'))).company.plan, 'starter');
    const bill = await request('/api/billing', 'owner'); assert.equal(bill.status, 200); assert.equal(bill.data.plan, 'enterprise'); assert.equal(bill.data.limits.activeProjects, null);
    assert.equal((await request('/api/billing/confirm?session_id=' + f.session().id, 'owner')).data.plan, 'enterprise');
    assert.equal((await request('/api/billing/confirm?session_id=cs_old_subscription', 'owner')).status,404,'old subscription return cannot replace Enterprise customer/subscription binding');
    assert.equal((await request('/api/billing/checkout', 'owner', 'POST', { plan: 'starter' })).status, 409);
    f.session().payment_intent.latest_charge.amount_refunded = q.totalAmount;
    assert.equal((await webhook({ ...event, id: 'evt_enterprise_refunded', type: 'charge.refunded', data: { object: f.session().payment_intent.latest_charge } })).status, 200);
    assert.equal((await request('/api/account-access', 'owner')).data.locked, true);
    assert.equal((await request('/api/state', 'owner')).status, 402); assert.equal((await request(ownerRoute, 'owner')).status, 200, 'locked owner retains quote review');
    assert.equal((await fetch(base + '/enterprise-billing.js')).status, 404); assert.equal((await fetch(base + '/enterprise-routes.js')).status, 404);
    assert.equal((await fetch(base + '/enterprise-ui.js')).status, 200);
    console.log('Enterprise API tests passed: real auth, commercial owner controls, private drafts, tenant binding, signed webhook activation, limits/features, refund lock and billing recovery.');
  } finally { await new Promise(resolve => server.close(resolve)); fs.rmSync(tmp, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
