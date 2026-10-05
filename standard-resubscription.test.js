const assert = require('node:assert/strict');
const billing = require('./standard-resubscription');
const founderBilling = require('./founder-billing');

const plans = { starter: { price: 99, annualPrice: 990 }, growth: { price: 199, annualPrice: 1990 }, pro: { price: 399, annualPrice: 3990 } };
const env = { STRIPE_SECRET_KEY: 'sk_test_synthetic' };
for (const plan of Object.keys(plans)) for (const cycle of ['monthly', 'annual']) for (const founder of [false, true]) {
  env[founderBilling.priceKey(plan, cycle, founder)] = `price_${plan}_${cycle}_${founder}`;
}
const copy = value => structuredClone(value);
const originalCompany = () => ({ id: 'company_test', plan: 'starter', stripeCustomerId: 'cus_test',
  stripeSubscriptionId: 'sub_previous', subscriptionStatus: 'Cancelled', nextBillingAt: '2026-11-01T00:00:00.000Z' });
const originalSubscription = () => ({ id: 'sub_previous', customer: 'cus_test', status: 'canceled', livemode: false,
  metadata: { company_id: 'company_test', offer: 'standard' },
  items: { data: [{ price: { id: env.STRIPE_PRICE_STARTER } }] } });
const originalSession = () => ({ id: 'cs_previous', customer: 'cus_test', subscription: 'sub_previous',
  mode: 'subscription', status: 'complete', livemode: false, client_reference_id: 'company_test',
  metadata: { company_id: 'company_test', offer: 'standard' } });
const originalInvoice = () => ({ id: 'in_paid', subscription: 'sub_replacement', customer: 'cus_test',
  livemode: false, status: 'paid', paid: true });

function provider(subscription = originalSubscription(), session = originalSession(), invoice = originalInvoice()) {
  const calls = [];
  const request = async (path, params, method) => {
    calls.push({ path, params, method });
    assert.equal(params, null);
    assert.equal(method, 'GET', 'Policy verification must never change Stripe state');
    if (path.startsWith('/subscriptions/')) return copy(subscription);
    if (path.startsWith('/checkout/sessions/')) return copy(session);
    if (path.startsWith('/invoices/')) return copy(invoice);
    throw new Error('Unexpected synthetic request');
  };
  request.calls = calls;
  return request;
}

let rejected = 0;
async function rejectsWithoutMutation(company, action, statusCode) {
  const before = copy(company);
  await assert.rejects(action, error => {
    assert.equal(error.statusCode, statusCode);
    assert.equal(/cus_test|sub_previous|company_test|sensitive-provider-detail/.test(error.message), false);
    rejected++;
    return true;
  });
  assert.deepEqual(company, before, 'Rejected verification must not change company state');
}

async function replacementCompany() {
  const company = originalCompany();
  const proof = await billing.prepareRetirement(company, provider(), plans, env);
  billing.retire(company, proof, '2026-10-05T06:00:00.000Z');
  company.pendingCheckout = { id: 'cs_replacement', attempt: 'attempt_current', plan: 'growth', cycle: 'annual', status: 'open' };
  return company;
}

function replacementSubscription() {
  return { ...originalSubscription(), id: 'sub_replacement', status: 'active', latest_invoice: 'in_paid',
    metadata: { company_id: 'company_test', offer: 'standard', checkout_attempt: 'attempt_current', replaces_subscription: 'sub_previous' },
    items: { data: [{ price: { id: env.STRIPE_PRICE_GROWTH_ANNUAL } }] } };
}

function replacementSession() {
  return { ...originalSession(), id: 'cs_replacement', subscription: 'sub_replacement',
    metadata: copy(replacementSubscription().metadata) };
}

function replacementParams() {
  return { mode: 'subscription', customer: 'cus_test', client_reference_id: 'company_test',
    'metadata[company_id]': 'company_test', 'metadata[checkout_attempt]': 'attempt_current',
    'metadata[replaces_subscription]': 'sub_previous', 'subscription_data[metadata][company_id]': 'company_test',
    'subscription_data[metadata][checkout_attempt]': 'attempt_current', 'subscription_data[metadata][replaces_subscription]': 'sub_previous',
    'subscription_data[metadata][plan]': 'growth', 'subscription_data[metadata][billing_cycle]': 'annual',
    'line_items[0][price]': env.STRIPE_PRICE_GROWTH_ANNUAL, 'line_items[0][quantity]': 1 };
}

async function run() {
  assert.equal(await billing.prepareRetirement({}, () => { throw new Error('No request expected'); }, plans, env), null);
  assert.equal(billing.isRetired({}, 'sub_previous'), false);
  assert.equal(billing.hasRetirement({}), false);
  assert.equal(billing.hasRetirement({ stripeRetiredSubscriptionIds: [] }), false);
  assert.equal(billing.hasRetirement({ stripeRetiredSubscriptionIds: 'corrupt' }), true, 'Corrupt evidence must not bypass validation');
  for (const status of ['canceled', 'incomplete_expired']) {
    const company = originalCompany(), request = provider({ ...originalSubscription(), status }), before = copy(company);
    const proof = await billing.prepareRetirement(company, request, plans, env);
    assert.deepEqual(company, before, 'Preparing retirement must be read-only');
    assert.equal(proof.subscriptionId, 'sub_previous');
    assert.equal(proof.terminalStatus, status);
    assert.equal(proof.plan, 'starter');
    assert.equal(proof.cycle, 'monthly');
    assert.deepEqual(request.calls, [{ path: '/subscriptions/sub_previous', params: null, method: 'GET' }]);
    company.stripeRetiredSubscriptionIds = Array.from({ length: 500 }, (_, i) => `sub_old_${i}`);
    const retired = billing.retire(company, proof, '2026-10-05T06:00:00.000Z');
    assert.equal(retired.verifiedTerminalAt, '2026-10-05T06:00:00.000Z');
    assert.equal(retired.customerId, 'cus_test');
    assert.equal(company.stripeRetiredSubscriptionIds.length, 501, 'No old subscription ID may be evicted');
    assert.equal(billing.isRetired(company, 'sub_old_0'), true);
    assert.equal(billing.isRetired(company, 'sub_previous'), true);
    assert.equal(billing.isRetired(company, ''), false);
    assert.equal(billing.hasRetirement(company), true);
    assert.equal(Object.hasOwn(company, 'stripeSubscriptionId'), false);
    assert.equal(company.subscriptionStatus, 'Cancelled');
    assert.equal(company.nextBillingAt, null);
    assert.equal(company.stripeCustomerId, 'cus_test');
    await rejectsWithoutMutation(company, () => Promise.resolve().then(() => billing.retire(company, proof)), 409);
  }
  for (const status of ['active', 'trialing', 'past_due', 'unpaid', 'paused', 'incomplete', 'unknown', '', null]) {
    for (const cancel_at_period_end of [false, true]) {
      const company = originalCompany();
      await rejectsWithoutMutation(company, () => billing.prepareRetirement(company,
        provider({ ...originalSubscription(), status, cancel_at_period_end }), plans, env), 409);
    }
  }
  for (const change of [{ id: 'sub_other' }, { customer: 'cus_other' }, { customer: null },
    { metadata: {} }, { metadata: { company_id: 'company_other' } }, { livemode: true }, { livemode: undefined }]) {
    const company = originalCompany();
    await rejectsWithoutMutation(company, () => billing.prepareRetirement(company,
      provider({ ...originalSubscription(), ...change }), plans, env), 400);
  }
  for (const change of [{ founder: { requested: true } }, { demo: true }, { id: 'northstar' },
    { billingExempt: true }, { plan: 'enterprise' }, { accountType: 'enterprise' }]) {
    const company = { ...originalCompany(), ...change }, request = provider();
    await rejectsWithoutMutation(company, () => billing.prepareRetirement(company, request, plans, env), 409);
    assert.equal(request.calls.length, 0);
  }
  for (const stripeCustomerId of [undefined, null, '', ' ', ' cus_test ']) {
    const company = { ...originalCompany(), stripeCustomerId };
    await rejectsWithoutMutation(company, () => billing.prepareRetirement(company, provider(), plans, env), 400);
  }
  for (const subscription of [{ ...originalSubscription(), metadata: { company_id: 'company_test', offer: 'founder' } },
    { ...originalSubscription(), items: { data: [{ price: { id: env.STRIPE_PRICE_FOUNDER_STARTER } }] } }]) {
    const company = originalCompany();
    await rejectsWithoutMutation(company, () => billing.prepareRetirement(company, provider(subscription), plans, env), 409);
  }
  for (const items of [undefined, { data: [] }, { data: [{ price: { id: 'price_unknown' } }] },
    { data: [{ price: { id: env.STRIPE_PRICE_STARTER } }, { price: { id: env.STRIPE_PRICE_FOUNDER_STARTER } }] },
    { data: [{ price: { id: env.STRIPE_PRICE_STARTER } }], has_more: true }]) {
    const company = originalCompany();
    await rejectsWithoutMutation(company, () => billing.prepareRetirement(company,
      provider({ ...originalSubscription(), items }), plans, env), 503);
  }
  {
    const company = originalCompany();
    await rejectsWithoutMutation(company, () => billing.prepareRetirement(company, provider(), plans,
      { ...env, STRIPE_PRICE_FOUNDER_STARTER: env.STRIPE_PRICE_STARTER }), 409);
    await rejectsWithoutMutation(company, () => billing.prepareRetirement(company,
      async () => { throw new Error('sensitive-provider-detail'); }, plans, env), 503);
    await rejectsWithoutMutation(company, () => billing.prepareRetirement(company, provider(), plans, {}), 503);
    const live = await billing.prepareRetirement(company, provider({ ...originalSubscription(), livemode: true }), plans,
      { ...env, STRIPE_SECRET_KEY: 'rk_live_synthetic' });
    assert.equal(live.subscriptionId, 'sub_previous');
    const expanded = await billing.prepareRetirement(company,
      provider({ ...originalSubscription(), customer: { id: 'cus_test' } }), plans, env);
    assert.equal(expanded.customerId, 'cus_test');
  }

  // Authoritatively clear only the old completed Checkout or a safe expired Checkout.
  for (const change of [{}, { subscription: { id: 'sub_previous' } }, { status: 'expired', subscription: null },
    { status: 'expired', subscription: 'sub_previous' }]) {
    const company = { ...originalCompany(), pendingCheckout: { id: 'cs_previous', attempt: 'old_attempt' } };
    const before = copy(company), request = provider(originalSubscription(), { ...originalSession(), ...change });
    const proof = await billing.prepareRetirement(company, request, plans, env);
    assert.deepEqual(company, before);
    assert.equal(request.calls.length, 2);
    billing.retire(company, proof);
    assert.equal(Object.hasOwn(company, 'pendingCheckout'), false);
  }
  for (const pendingCheckout of [{ status: 'creating', attempt: 'uncertain' }, {}, { id: '' }]) {
    const company = { ...originalCompany(), pendingCheckout };
    await rejectsWithoutMutation(company, () => billing.prepareRetirement(company, provider(), plans, env), 409);
  }
  for (const change of [{ status: 'open' }, { status: 'unknown' }, { subscription: null },
    { subscription: 'sub_other' }, { status: 'expired', subscription: 'sub_other' },
    { status: 'expired', subscription: {} }]) {
    const company = { ...originalCompany(), pendingCheckout: { id: 'cs_previous' } };
    await rejectsWithoutMutation(company, () => billing.prepareRetirement(company,
      provider(originalSubscription(), { ...originalSession(), ...change }), plans, env), 409);
  }
  for (const change of [{ id: 'cs_other' }, { customer: 'cus_other' }, { mode: 'payment' },
    { client_reference_id: 'company_other' }, { metadata: {} }, { livemode: true }]) {
    const company = { ...originalCompany(), pendingCheckout: { id: 'cs_previous' } };
    await rejectsWithoutMutation(company, () => billing.prepareRetirement(company,
      provider(originalSubscription(), { ...originalSession(), ...change }), plans, env), 400);
  }
  for (const change of [{ stripeSubscriptionId: 'sub_changed' }, { stripeCustomerId: 'cus_changed' },
    { id: 'company_changed' }, { pendingCheckout: { id: 'cs_new' } }]) {
    const company = originalCompany(), proof = await billing.prepareRetirement(company, provider(), plans, env);
    Object.assign(company, change);
    await rejectsWithoutMutation(company, () => Promise.resolve().then(() => billing.retire(company, proof)), 409);
  }
  {
    const company = { ...originalCompany(), pendingCheckout: { id: 'cs_previous', attempt: 'attempt_previous' } };
    const proof = await billing.prepareRetirement(company, provider(), plans, env);
    company.pendingCheckout.attempt = 'changed_in_place';
    await rejectsWithoutMutation(company, () => Promise.resolve().then(() => billing.retire(company, proof)), 409);
  }

  // Exact replacement bindings are required for both Checkout and subscription reads.
  {
    const company = await replacementCompany(), before = copy(company), session = replacementSession();
    assert.deepEqual(billing.validateReplacementSession(company, session, env), session);
    const request = provider(), info = await billing.assertReplacementSubscription(company, replacementSubscription(), request, env);
    assert.equal(info.plan, 'growth');
    assert.equal(info.cycle, 'annual');
    assert.deepEqual(company, before);
    assert.deepEqual(request.calls, [{ path: '/invoices/in_paid', params: null, method: 'GET' }]);
  }
  for (const change of [{ id: 'cs_other' }, { mode: 'payment' }, { livemode: true }, { customer: 'cus_other' },
    { client_reference_id: 'company_other' }, { subscription: {} },
    { metadata: { ...replacementSession().metadata, company_id: 'company_other' } },
    { metadata: { ...replacementSession().metadata, checkout_attempt: 'attempt_old' } },
    { metadata: { ...replacementSession().metadata, replaces_subscription: 'sub_other' } }]) {
    const company = await replacementCompany();
    await rejectsWithoutMutation(company, () => Promise.resolve().then(() =>
      billing.validateReplacementSession(company, { ...replacementSession(), ...change }, env)), 400);
  }
  {
    const company = await replacementCompany();
    await rejectsWithoutMutation(company, () => Promise.resolve().then(() => billing.validateReplacementSession(company,
      { ...replacementSession(), subscription: 'sub_previous' }, env)), 409);
    delete company.pendingCheckout.id;
    await rejectsWithoutMutation(company, () => Promise.resolve().then(() =>
      billing.validateReplacementSession(company, replacementSession(), env)), 400);
    company.pendingCheckout.status = 'creating';
    await billing.assertReplacementSubscription(company, replacementSubscription(), provider(), env);
  }
  for (const change of [{ customer: 'cus_other' }, { livemode: true }, { metadata: {} },
    { metadata: { ...replacementSubscription().metadata, checkout_attempt: 'old_attempt' } },
    { metadata: { ...replacementSubscription().metadata, replaces_subscription: 'sub_other' } },
    { items: { data: [{ price: { id: env.STRIPE_PRICE_STARTER } }] } }]) {
    const company = await replacementCompany();
    await rejectsWithoutMutation(company, () => billing.assertReplacementSubscription(company,
      { ...replacementSubscription(), ...change }, provider(), env), 400);
  }
  for (const change of [{ id: 'sub_previous' }, { id: '' },
    { metadata: { ...replacementSubscription().metadata, offer: 'founder' } },
    { items: { data: [{ price: { id: env.STRIPE_PRICE_FOUNDER_GROWTH_ANNUAL } }] } }]) {
    const company = await replacementCompany();
    await rejectsWithoutMutation(company, () => billing.assertReplacementSubscription(company,
      { ...replacementSubscription(), ...change }, provider(), env), 409);
  }
  {
    const company = await replacementCompany();
    await rejectsWithoutMutation(company, () => billing.assertReplacementSubscription(company,
      { ...replacementSubscription(), items: { data: [{ price: { id: 'price_unknown' } }] } }, provider(), env), 503);
  }
  for (const change of [{ stripeResubscription: null }, { stripeRetiredSubscriptionIds: [] }, { pendingCheckout: null },
    { stripeSubscriptionId: 'sub_unrelated' }, { founder: { requested: true } }, { demo: true },
    { billingExempt: true }, { plan: 'enterprise' }]) {
    const company = Object.assign(await replacementCompany(), change);
    await rejectsWithoutMutation(company, () => billing.assertReplacementSubscription(company, replacementSubscription(), provider(), env), 409);
  }
  for (const change of [{ terminalStatus: 'active' }, { customerId: 'cus_other' }, { verifiedTerminalAt: 'invalid' },
    { retiredCheckoutAttempts: ['attempt_current'] }, { retiredCheckoutAttempts: {} }]) {
    const company = await replacementCompany();
    Object.assign(company.stripeResubscription, change);
    await rejectsWithoutMutation(company, () => billing.assertReplacementSubscription(company, replacementSubscription(), provider(), env), 409);
  }
  for (const status of ['trialing', 'past_due', 'unpaid', 'paused', 'incomplete', 'canceled', 'incomplete_expired']) {
    const company = await replacementCompany(), before = copy(company), request = provider();
    await billing.assertReplacementSubscription(company, { ...replacementSubscription(), status, latest_invoice: null }, request, env);
    assert.equal(request.calls.length, 0, 'Locked nonactive states do not require payment');
    assert.deepEqual(company, before, 'Nonactive validation never grants access');
    assert.equal(company.subscriptionStatus, 'Cancelled');
  }

  // Pending Checkout can reveal a subscription before any subscription webhook is applied.
  {
    const company = await replacementCompany(), before = copy(company);
    const noSubscription = { ...replacementSession(), subscription: null, status: 'open' };
    const emptyRequest = provider();
    assert.equal(await billing.inspectPendingSubscription(company, noSubscription, emptyRequest, env), null);
    assert.equal(emptyRequest.calls.length, 0);
    for (const status of ['active', 'trialing', 'incomplete', 'past_due', 'unpaid', 'paused', 'canceled', 'incomplete_expired']) {
      const subscription = { ...replacementSubscription(), status, latest_invoice: null }, request = provider(subscription);
      const session = { ...replacementSession(), subscription: { id: 'sub_replacement' } };
      assert.deepEqual(await billing.inspectPendingSubscription(company, session, request, env), subscription);
      assert.deepEqual(request.calls, [{ path: '/subscriptions/sub_replacement', params: null, method: 'GET' }]);
      assert.deepEqual(company, before, 'Pending inspection must neither assign a subscription nor grant access');
      assert.equal(company.subscriptionStatus, 'Cancelled');
    }
    for (const change of [{ id: 'sub_other' }, { customer: 'cus_other' }, { livemode: true }, { metadata: {} },
      { metadata: { ...replacementSubscription().metadata, checkout_attempt: 'old_attempt' } },
      { metadata: { ...replacementSubscription().metadata, replaces_subscription: 'sub_unrelated' } },
      { items: { data: [{ price: { id: env.STRIPE_PRICE_STARTER } }] } }]) {
      await rejectsWithoutMutation(company, () => billing.inspectPendingSubscription(company, replacementSession(),
        provider({ ...replacementSubscription(), ...change }), env), 400);
    }
    await rejectsWithoutMutation(company, () => billing.inspectPendingSubscription(company, replacementSession(),
      provider({ ...replacementSubscription(), items: { data: [{ price: { id: 'price_unknown' } }] } }), env), 503);
    await rejectsWithoutMutation(company, () => billing.inspectPendingSubscription(company, replacementSession(),
      provider({ ...replacementSubscription(), items: { data: [{ price: { id: env.STRIPE_PRICE_FOUNDER_GROWTH_ANNUAL } }] } }), env), 409);
    for (const change of [{ id: 'cs_other' }, { mode: 'payment' }, { customer: 'cus_other' },
      { metadata: {} }, { livemode: true }, { subscription: {} }]) {
      const request = provider(replacementSubscription());
      await rejectsWithoutMutation(company, () => billing.inspectPendingSubscription(company,
        { ...replacementSession(), ...change }, request, env), 400);
      assert.equal(request.calls.length, 0, 'Invalid Checkout is rejected before a subscription request');
    }
    const retiredRequest = provider(replacementSubscription());
    await rejectsWithoutMutation(company, () => billing.inspectPendingSubscription(company,
      { ...replacementSession(), subscription: 'sub_previous' }, retiredRequest, env), 409);
    assert.equal(retiredRequest.calls.length, 0);
    await rejectsWithoutMutation(company, () => billing.inspectPendingSubscription(company, replacementSession(),
      async () => { throw new Error('sensitive-provider-detail'); }, env), 503);
  }

  // Frozen replacement requests are checked before any provider POST may occur.
  {
    const company = await replacementCompany(), params = replacementParams();
    delete company.pendingCheckout.id;
    company.pendingCheckout.status = 'creating';
    company.pendingCheckout.params = copy(params);
    const before = copy(company);
    assert.equal(billing.assertReplacementCheckout(company, params, env).plan, 'growth');
    assert.deepEqual(company, before);
    for (const change of [{ mode: 'payment' }, { customer: 'cus_other' }, { client_reference_id: 'company_other' },
      { 'metadata[company_id]': 'company_other' }, { 'metadata[checkout_attempt]': 'old_attempt' },
      { 'metadata[replaces_subscription]': 'sub_other' }, { 'subscription_data[metadata][company_id]': 'company_other' },
      { 'subscription_data[metadata][checkout_attempt]': 'old_attempt' }, { 'subscription_data[metadata][replaces_subscription]': 'sub_other' },
      { 'subscription_data[metadata][plan]': 'starter' }, { 'subscription_data[metadata][billing_cycle]': 'monthly' },
      { 'line_items[0][price]': env.STRIPE_PRICE_STARTER }, { 'line_items[0][quantity]': 2 },
      { 'line_items[1][price]': env.STRIPE_PRICE_STARTER }, { customer_email: 'unrelated@example.test' }]) {
      const changed = { ...params, ...change };
      company.pendingCheckout.params = copy(changed);
      await rejectsWithoutMutation(company, () => Promise.resolve().then(() => billing.assertReplacementCheckout(company, changed, env)), 400);
    }
    for (const change of [{ 'metadata[offer]': 'founder' }, { 'subscription_data[metadata][offer]': 'founder' },
      { 'line_items[0][price]': env.STRIPE_PRICE_FOUNDER_GROWTH_ANNUAL }]) {
      const changed = { ...params, ...change };
      company.pendingCheckout.params = copy(changed);
      await rejectsWithoutMutation(company, () => Promise.resolve().then(() => billing.assertReplacementCheckout(company, changed, env)), 409);
    }
    const unknown = { ...params, 'line_items[0][price]': 'price_unknown' };
    company.pendingCheckout.params = copy(unknown);
    await rejectsWithoutMutation(company, () => Promise.resolve().then(() => billing.assertReplacementCheckout(company, unknown, env)), 503);
    company.pendingCheckout.params = copy(params);
    await rejectsWithoutMutation(company, () => Promise.resolve().then(() =>
      billing.assertReplacementCheckout(company, { ...params, success_url: 'https://changed.example/' }, env)), 400);
    company.stripeSubscriptionId = 'sub_replacement';
    await rejectsWithoutMutation(company, () => Promise.resolve().then(() => billing.assertReplacementCheckout(company, params, env)), 409);
    delete company.stripeSubscriptionId;
    company.pendingCheckout.id = 'cs_replacement';
    await rejectsWithoutMutation(company, () => Promise.resolve().then(() => billing.assertReplacementCheckout(company, params, env)), 409);
  }

  // A declined incomplete replacement can reopen only its original bound Checkout.
  {
    const company = await replacementCompany();
    assert.equal(await billing.resumeIncompleteCheckout(company, {}, provider(), env), null);
    company.stripeSubscriptionId = 'sub_replacement';
    const subscription = { ...replacementSubscription(), status: 'incomplete', latest_invoice: null };
    const session = { ...replacementSession(), status: 'open', url: 'https://checkout.stripe.com/c/pay/synthetic' };
    const input = { plan: 'growth', billingCycle: 'annual' }, before = copy(company);
    const request = provider(subscription, session);
    assert.deepEqual(await billing.resumeIncompleteCheckout(company, input, request, env), { url: session.url });
    assert.deepEqual(company, before);
    assert.deepEqual(request.calls.map(call => call.path), ['/subscriptions/sub_replacement', '/checkout/sessions/cs_replacement']);
    // Resuming never retires incomplete state or enables a fresh checkout.
    await rejectsWithoutMutation(company, () => billing.prepareRetirement(company, provider(subscription, session), plans, env), 409);
    for (const status of ['active', 'trialing', 'past_due', 'unpaid', 'paused', 'canceled', 'incomplete_expired']) {
      const otherRequest = provider({ ...subscription, status }, session);
      assert.equal(await billing.resumeIncompleteCheckout(company, input, otherRequest, env), null);
      assert.equal(otherRequest.calls.length, 1);
    }
    for (const requestInput of [{ plan: 'starter', billingCycle: 'annual' }, { plan: 'growth', billingCycle: 'monthly' }]) {
      await rejectsWithoutMutation(company, () => billing.resumeIncompleteCheckout(company, requestInput, provider(subscription, session), env), 409);
    }
    for (const change of [{ status: 'complete' }, { status: 'expired' }, { subscription: null },
      { url: 'http://checkout.stripe.com/c/pay/example' }, { url: 'https://checkout.stripe.com.evil.example/c/pay/example' },
      { url: 'https://evil.example/c/pay/example' }, { url: 'https://user:password@checkout.stripe.com/c/pay/example' },
      { url: 'https://checkout.stripe.com:8443/c/pay/example' }, { url: 'javascript:alert(1)' }, { url: 'not-a-url' }]) {
      await rejectsWithoutMutation(company, () => billing.resumeIncompleteCheckout(company, input,
        provider(subscription, { ...session, ...change }), env), 409);
    }
    for (const change of [{ id: 'cs_unrelated' }, { customer: 'cus_other' }, { metadata: {} }, { livemode: true }]) {
      await rejectsWithoutMutation(company, () => billing.resumeIncompleteCheckout(company, input,
        provider(subscription, { ...session, ...change }), env), 400);
    }
    await rejectsWithoutMutation(company, () => billing.resumeIncompleteCheckout(company, input,
      provider({ ...subscription, id: 'sub_other' }, session), env), 400);
    await rejectsWithoutMutation(company, () => billing.resumeIncompleteCheckout(company, input,
      provider({ ...subscription, metadata: {} }, session), env), 400);
    await rejectsWithoutMutation(company, () => billing.resumeIncompleteCheckout(company, input,
      provider(subscription, { ...session, subscription: 'sub_other' }), env), 409);
    delete company.pendingCheckout.id;
    assert.equal(await billing.resumeIncompleteCheckout(company, input, provider(), env), null);
  }

  // Current paid invoices must bind to exactly this customer and replacement subscription.
  for (const change of [{ status: 'open', paid: false }, { status: 'draft' }, { status: 'void' },
    { status: 'uncollectible' }, { paid: false }]) {
    const company = await replacementCompany();
    await rejectsWithoutMutation(company, () => billing.assertReplacementSubscription(company, replacementSubscription(),
      provider(undefined, undefined, { ...originalInvoice(), ...change }), env), 503);
  }
  for (const change of [{ id: 'in_other' }, { subscription: 'sub_other' }, { subscription: null },
    { customer: 'cus_other' }, { livemode: true }, { livemode: undefined },
    { parent: { subscription_details: { subscription: 'sub_other' } } }]) {
    const company = await replacementCompany();
    await rejectsWithoutMutation(company, () => billing.assertReplacementSubscription(company, replacementSubscription(),
      provider(undefined, undefined, { ...originalInvoice(), ...change }), env), 400);
  }
  for (const invoice of [{ ...originalInvoice(), subscription: undefined, paid: undefined,
    parent: { subscription_details: { subscription: 'sub_replacement' } } },
    { ...originalInvoice(), subscription: { id: 'sub_replacement' }, customer: { id: 'cus_test' } }]) {
    const company = await replacementCompany();
    await billing.assertReplacementSubscription(company, { ...replacementSubscription(), latest_invoice: { id: 'in_paid' } },
      provider(undefined, undefined, invoice), env);
  }
  {
    const company = await replacementCompany();
    for (const latest_invoice of [null, '', {}]) await rejectsWithoutMutation(company, () =>
      billing.assertReplacementSubscription(company, { ...replacementSubscription(), latest_invoice }, provider(), env), 503);
    await rejectsWithoutMutation(company, () => billing.assertReplacementSubscription(company, replacementSubscription(),
      async () => { throw new Error('sensitive-provider-detail'); }, env), 503);
    company.stripeSubscriptionId = 'sub_replacement';
    await billing.assertReplacementSubscription(company, replacementSubscription(), provider(), env);
    company.stripeResubscription.retiredCheckoutAttempts = ['ancient_attempt'];
    const ended = { ...replacementSubscription(), status: 'canceled' };
    const endedSession = { ...replacementSession(), subscription: 'sub_replacement' };
    const proof = await billing.prepareRetirement(company, provider(ended, endedSession), plans, env);
    billing.retire(company, proof);
    assert.deepEqual(company.stripeRetiredSubscriptionIds, ['sub_previous', 'sub_replacement']);
    assert.deepEqual(company.stripeResubscription.retiredCheckoutAttempts, ['ancient_attempt']);
    assert.equal(billing.isRetired(company, 'sub_previous'), true);
    assert.equal(billing.isRetired(company, 'sub_replacement'), true);
  }
  console.log(`Standard re-subscription policy passed (${rejected} rejected unsafe cases; synthetic GET-only providers, no live API calls).`);
}

module.exports = run;
if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });
