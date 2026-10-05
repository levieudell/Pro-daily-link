const founderBilling = require('./founder-billing');

const TERMINAL = new Set(['canceled', 'incomplete_expired']);
const KNOWN_PLANS = Object.fromEntries(Object.keys(founderBilling.PRICES).map(plan => [plan, {}]));
const idOf = value => typeof value === 'string' ? value : value?.id;
const nonempty = value => typeof value === 'string' && value.length > 0 && value.trim() === value;
const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const mismatch = () => fail('Billing details could not be verified. Contact support.');
const review = () => fail('This account requires a billing review. Contact support.', 409);
const snapshot = value => JSON.stringify(value ?? null);

function liveMode(env) {
  if (/^(sk|rk)_live_/.test(env.STRIPE_SECRET_KEY || '')) return true;
  if (/^(sk|rk)_test_/.test(env.STRIPE_SECRET_KEY || '')) return false;
  throw fail('Billing verification is not configured. Contact support.', 503);
}

function assertStandardCompany(company) {
  if (!company || company.founder?.requested || company.demo || company.id === 'northstar' ||
      company.billingExempt || company.plan === 'enterprise' || company.accountType === 'enterprise') throw review();
  if (!nonempty(String(company.id || '')) || !nonempty(company.stripeCustomerId)) throw mismatch();
}

function assertBound(company, resource, env) {
  if (!resource || idOf(resource.customer) !== company.stripeCustomerId ||
      String(resource.metadata?.company_id || '') !== String(company.id) ||
      resource.livemode !== liveMode(env)) throw mismatch();
  if (resource.metadata?.offer && resource.metadata.offer !== 'standard') throw review();
}

function standardPrice(subscription, plans, env) {
  const items = subscription.items?.data;
  if (!Array.isArray(items) || items.length !== 1 || subscription.items.has_more) {
    throw fail('The subscription price could not be verified. Contact support.', 503);
  }
  const priceId = idOf(items[0]?.price);
  // A misconfigured shared founder/standard price must not bypass founder protections.
  if (Object.keys(founderBilling.PRICES).some(plan => ['monthly', 'annual'].some(cycle =>
    nonempty(priceId) && env[founderBilling.priceKey(plan, cycle, true)] === priceId))) throw review();
  const info = founderBilling.identify(priceId, plans, env);
  if (!info) throw fail('The subscription price is not connected. Contact support.', 503);
  if (info.founder) throw review();
  return info;
}

async function retrieve(stripeRequest, path) {
  try {
    return await stripeRequest(path, null, 'GET');
  } catch {
    // Provider errors can contain private account details; never expose them to callers.
    throw fail('Billing verification is unavailable. Try again or contact support.', 503);
  }
}

function isRetired(company, subscriptionId) {
  return Boolean(nonempty(subscriptionId) && (
    (Array.isArray(company?.stripeRetiredSubscriptionIds) && company.stripeRetiredSubscriptionIds.includes(subscriptionId)) ||
    company?.stripeResubscription?.previousSubscriptionId === subscriptionId));
}

function hasRetirement(company) {
  return Boolean(company?.stripeResubscription ||
    (company?.stripeRetiredSubscriptionIds != null &&
      (!Array.isArray(company.stripeRetiredSubscriptionIds) || company.stripeRetiredSubscriptionIds.length)));
}

async function prepareRetirement(company, stripeRequest, plans, env = process.env) {
  if (!company?.stripeSubscriptionId) return null;
  assertStandardCompany(company);
  const subscriptionId = company.stripeSubscriptionId;
  if (!nonempty(subscriptionId) || isRetired(company, subscriptionId)) throw review();
  const proof = { companyId: String(company.id), subscriptionId, customerId: company.stripeCustomerId,
    pendingCheckout: snapshot(company.pendingCheckout) };
  const subscription = await retrieve(stripeRequest, '/subscriptions/' + encodeURIComponent(subscriptionId));
  if (subscription?.id !== subscriptionId) throw mismatch();
  assertBound(company, subscription, env);
  const info = standardPrice(subscription, plans, env);
  if (!TERMINAL.has(subscription.status)) {
    throw fail('Manage the existing subscription before starting a new checkout.', 409);
  }

  const pending = JSON.parse(proof.pendingCheckout);
  if (pending) {
    if (!nonempty(pending.id)) throw review();
    const session = await retrieve(stripeRequest, '/checkout/sessions/' + encodeURIComponent(pending.id));
    if (session?.id !== pending.id || session.mode !== 'subscription' ||
        String(session.client_reference_id || '') !== proof.companyId) throw mismatch();
    assertBound(company, session, env);
    const priorSubscriptionId = idOf(session.subscription);
    if (priorSubscriptionId && priorSubscriptionId !== subscriptionId) throw review();
    if (!(session.status === 'complete' && priorSubscriptionId === subscriptionId) &&
        !(session.status === 'expired' && (!session.subscription || priorSubscriptionId === subscriptionId))) throw review();
  }
  return Object.freeze({ ...proof, terminalStatus: subscription.status, plan: info.plan, cycle: info.cycle });
}

function retire(company, proof, now = new Date()) {
  assertStandardCompany(company);
  if (!proof || !TERMINAL.has(proof.terminalStatus) || !nonempty(proof.subscriptionId) ||
      String(company.id) !== proof.companyId || company.stripeSubscriptionId !== proof.subscriptionId ||
      company.stripeCustomerId !== proof.customerId || snapshot(company.pendingCheckout) !== proof.pendingCheckout ||
      isRetired(company, proof.subscriptionId)) {
    throw fail('Billing changed during verification. Refresh and try again.', 409);
  }
  if (company.stripeRetiredSubscriptionIds != null && !Array.isArray(company.stripeRetiredSubscriptionIds)) throw review();
  const timestamp = new Date(now);
  if (!Number.isFinite(timestamp.valueOf())) throw mismatch();
  const retiredCheckoutAttempts = company.stripeResubscription?.retiredCheckoutAttempts;
  company.stripeRetiredSubscriptionIds = [...new Set([...(company.stripeRetiredSubscriptionIds || []), proof.subscriptionId])];
  company.stripeResubscription = { previousSubscriptionId: proof.subscriptionId, customerId: proof.customerId,
    terminalStatus: proof.terminalStatus, verifiedTerminalAt: timestamp.toISOString(), plan: proof.plan, cycle: proof.cycle,
    ...(Array.isArray(retiredCheckoutAttempts) ? { retiredCheckoutAttempts: [...retiredCheckoutAttempts] } : {}) };
  delete company.stripeSubscriptionId;
  delete company.pendingCheckout;
  company.subscriptionStatus = 'Cancelled';
  company.nextBillingAt = null;
  return company.stripeResubscription;
}

function replacementContext(company) {
  assertStandardCompany(company);
  const retirement = company.stripeResubscription, pending = company.pendingCheckout;
  if (!retirement || !nonempty(retirement.previousSubscriptionId) ||
      !Array.isArray(company.stripeRetiredSubscriptionIds) ||
      !company.stripeRetiredSubscriptionIds.includes(retirement.previousSubscriptionId) ||
      retirement.customerId !== company.stripeCustomerId || !TERMINAL.has(retirement.terminalStatus) ||
      !nonempty(retirement.verifiedTerminalAt) || !Number.isFinite(Date.parse(retirement.verifiedTerminalAt)) ||
      !pending || !nonempty(pending.attempt) ||
      (retirement.retiredCheckoutAttempts != null && !Array.isArray(retirement.retiredCheckoutAttempts)) ||
      (retirement.retiredCheckoutAttempts || []).includes(pending.attempt)) throw review();
  return { retirement, pending };
}

function assertReplacementMetadata(company, resource, env) {
  const context = replacementContext(company);
  assertBound(company, resource, env);
  if (resource.metadata?.checkout_attempt !== context.pending.attempt ||
      resource.metadata?.replaces_subscription !== context.retirement.previousSubscriptionId) throw mismatch();
  return context;
}

function validateReplacementSession(company, session, env = process.env) {
  const { pending } = assertReplacementMetadata(company, session, env);
  if (!nonempty(pending.id) || session.id !== pending.id || session.mode !== 'subscription' ||
      String(session.client_reference_id || '') !== String(company.id)) throw mismatch();
  const subscriptionId = idOf(session.subscription);
  if (session.subscription && !nonempty(subscriptionId)) throw mismatch();
  if (subscriptionId && (isRetired(company, subscriptionId) ||
      (company.stripeSubscriptionId && company.stripeSubscriptionId !== subscriptionId))) throw review();
  return session;
}

function assertReplacementCheckout(company, params, env = process.env) {
  const { retirement, pending } = replacementContext(company);
  liveMode(env);
  if (company.stripeSubscriptionId || pending.status !== 'creating' || pending.id) throw review();
  if (!params || typeof params !== 'object' || Array.isArray(params) || !pending.params ||
      snapshot(params) !== snapshot(pending.params) || params.mode !== 'subscription' ||
      params.customer !== company.stripeCustomerId || params.customer_email != null ||
      String(params.client_reference_id || '') !== String(company.id)) throw mismatch();
  for (const prefix of ['metadata', 'subscription_data[metadata]']) {
    if (String(params[prefix + '[company_id]'] || '') !== String(company.id) ||
        params[prefix + '[checkout_attempt]'] !== pending.attempt ||
        params[prefix + '[replaces_subscription]'] !== retirement.previousSubscriptionId) throw mismatch();
    if (params[prefix + '[offer]'] && params[prefix + '[offer]'] !== 'standard') throw review();
  }
  const itemKeys = Object.keys(params).filter(key => key.startsWith('line_items'));
  if (itemKeys.length !== 2 || !itemKeys.includes('line_items[0][price]') ||
      !itemKeys.includes('line_items[0][quantity]') || String(params['line_items[0][quantity]']) !== '1') throw mismatch();
  const info = standardPrice({ items: { data: [{ price: { id: params['line_items[0][price]'] } }] } }, KNOWN_PLANS, env);
  if (info.plan !== pending.plan || info.cycle !== pending.cycle ||
      params['subscription_data[metadata][plan]'] !== pending.plan ||
      params['subscription_data[metadata][billing_cycle]'] !== pending.cycle) throw mismatch();
  return info;
}

function replacementSubscriptionInfo(company, subscription, env) {
  const { pending } = assertReplacementMetadata(company, subscription, env);
  if (!nonempty(subscription.id) || isRetired(company, subscription.id) ||
      (company.stripeSubscriptionId && company.stripeSubscriptionId !== subscription.id)) throw review();
  const info = standardPrice(subscription, KNOWN_PLANS, env);
  if (info.plan !== pending.plan || info.cycle !== pending.cycle) throw mismatch();
  return info;
}

async function inspectPendingSubscription(company, session, stripeRequest, env = process.env) {
  validateReplacementSession(company, session, env);
  const subscriptionId = idOf(session.subscription);
  if (!subscriptionId) return null;
  const subscription = await retrieve(stripeRequest, '/subscriptions/' + encodeURIComponent(subscriptionId));
  if (subscription?.id !== subscriptionId) throw mismatch();
  replacementSubscriptionInfo(company, subscription, env);
  // This is a state inspection only. Paid-invoice verification still gates access separately.
  return subscription;
}

async function resumeIncompleteCheckout(company, input, stripeRequest, env = process.env) {
  if (!hasRetirement(company) || !company.stripeSubscriptionId || !company.pendingCheckout?.id) return null;
  const subscriptionId = company.stripeSubscriptionId;
  const subscription = await retrieve(stripeRequest, '/subscriptions/' + encodeURIComponent(subscriptionId));
  if (subscription?.id !== subscriptionId) throw mismatch();
  replacementSubscriptionInfo(company, subscription, env);
  if (subscription.status !== 'incomplete') return null;
  const pending = company.pendingCheckout, cycle = input.billingCycle === 'annual' ? 'annual' : 'monthly';
  if (pending.plan !== input.plan || pending.cycle !== cycle) throw review();
  const session = await retrieve(stripeRequest, '/checkout/sessions/' + encodeURIComponent(pending.id));
  validateReplacementSession(company, session, env);
  if (session.status !== 'open' || idOf(session.subscription) !== subscriptionId) throw review();
  let url;
  try { url = new URL(session.url); } catch { throw review(); }
  if (url.protocol !== 'https:' || url.host !== 'checkout.stripe.com' || url.username || url.password) throw review();
  return { url: session.url };
}

async function assertReplacementSubscription(company, subscription, stripeRequest, env = process.env) {
  const info = replacementSubscriptionInfo(company, subscription, env);
  // All nonactive states remain locked in the caller, including trialing.
  if (subscription.status !== 'active') return info;
  const invoiceId = idOf(subscription.latest_invoice);
  if (!nonempty(invoiceId)) throw fail('Waiting for confirmed subscription payment.', 503);
  const invoice = await retrieve(stripeRequest, '/invoices/' + encodeURIComponent(invoiceId));
  const invoiceSubscription = idOf(invoice?.subscription);
  const parentSubscription = idOf(invoice?.parent?.subscription_details?.subscription);
  if (!invoice || invoice.id !== invoiceId || invoice.livemode !== liveMode(env) ||
      idOf(invoice.customer) !== company.stripeCustomerId ||
      (!invoiceSubscription && !parentSubscription) ||
      (invoiceSubscription && invoiceSubscription !== subscription.id) ||
      (parentSubscription && parentSubscription !== subscription.id)) throw mismatch();
  if (invoice.status !== 'paid' || invoice.paid === false) throw fail('Waiting for confirmed subscription payment.', 503);
  return info;
}

module.exports = { prepareRetirement, retire, isRetired, hasRetirement,
  validateReplacementSession, assertReplacementSubscription, assertReplacementCheckout, resumeIncompleteCheckout,
  inspectPendingSubscription };
