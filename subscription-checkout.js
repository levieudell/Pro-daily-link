'use strict';

const fail = (message, statusCode = 409) => Object.assign(new Error(message), { statusCode });
const idOf = value => typeof value === 'string' ? value : value?.id;
const terminal = subscription => ['canceled', 'incomplete_expired'].includes(subscription.status);

function verifySubscription(subscription, id, company, env = process.env) {
  const live = /^(sk|rk)_live_/.test(env.STRIPE_SECRET_KEY || '');
  if (subscription.id !== id || subscription.metadata?.company_id !== String(company.id) ||
      subscription.livemode !== live || !idOf(subscription.customer) ||
      company.stripeCustomerId && company.stripeCustomerId !== idOf(subscription.customer)) {
    throw fail('Subscription ownership could not be verified. Contact support.', 503);
  }
  return subscription;
}

async function prepareCheckout(company, request, env = process.env) {
  const retired = new Set(company.retiredStripeSubscriptionIds || []);
  let customer = company.stripeCustomerId;
  let previous = company.pendingCheckout;
  let recovering = false, originalFreePeriod = company.stripeFreePeriod;
  const check = async id => {
    const subscription = verifySubscription(await request('/subscriptions/' + encodeURIComponent(id), null, 'GET'), id, { ...company, stripeCustomerId: customer }, env);
    if (!terminal(subscription)) throw fail('Use Manage billing for an existing subscription.');
    const freeEnd = anchoredFreePeriod(subscription, company);
    if (freeEnd) originalFreePeriod = { subscriptionId: subscription.id, end: freeEnd };
    retired.add(id); customer ||= idOf(subscription.customer); recovering = true;
  };
  if (company.stripeSubscriptionId) await check(company.stripeSubscriptionId);
  if (previous?.id) {
    const session = await request('/checkout/sessions/' + encodeURIComponent(previous.id), null, 'GET');
    const live = /^(sk|rk)_live_/.test(env.STRIPE_SECRET_KEY || '');
    if (session.id !== previous.id || session.client_reference_id !== String(company.id) || session.livemode !== live ||
        customer && idOf(session.customer) && idOf(session.customer) !== customer) {
      throw fail('Checkout ownership could not be verified. Contact support.', 503);
    }
    if (session.status === 'complete') {
      if (!idOf(session.subscription)) throw fail('Payment is being confirmed. Refresh billing before trying again.');
      await check(idOf(session.subscription)); previous = null;
    } else if (session.status === 'expired') previous = null;
    else if (session.status === 'open') previous = { ...previous, session };
    else throw fail('Checkout state could not be verified. Contact support.', 503);
  }
  // A stale local ID or missed webhook must not permit a second subscription.
  if (customer) {
    const list = await request('/subscriptions?customer=' + encodeURIComponent(customer) + '&status=all&limit=100', null, 'GET');
    if (!Array.isArray(list.data) || list.has_more !== false) throw fail('Subscription history could not be verified. Contact support.', 503);
    for (const subscription of list.data) {
      verifySubscription(subscription, subscription.id, { ...company, stripeCustomerId: customer }, env);
      if (!terminal(subscription)) throw fail('Use Manage billing for an existing subscription.');
      const freeEnd = anchoredFreePeriod(subscription, company);
      if (freeEnd) originalFreePeriod = { subscriptionId: subscription.id, end: freeEnd };
      retired.add(subscription.id); recovering = true;
    }
  }
  // Commit recovery only after every ownership/status check succeeded.
  if (recovering) {
    // Founder renewal/setup terms are unchanged by standard subscription recovery.
    if (company.founder?.requested) throw fail('Contact support to restore founder billing without changing your original pricing and setup terms.');
    company.retiredStripeSubscriptionIds = [...retired];
    company.stripeCustomerId = customer;
    company.stripeTrialUsed = true;
    if (originalFreePeriod) company.stripeFreePeriod = originalFreePeriod;
    delete company.stripeSubscriptionId;
  }
  return previous;
}

function trialParameters(company, founder, now = Date.now()) {
  if (founder || company.founder?.requested) return {};
  if (company.cardTrialDays === 7 && !company.stripeTrialUsed && !company.initialPaymentConfirmedAt) return {
    'subscription_data[trial_period_days]': 7, payment_method_collection: 'always',
    'subscription_data[trial_settings][end_behavior][missing_payment_method]': 'cancel'
  };
  const end = Date.parse(company.trialEndsAt);
  const originalFreePeriod = company.stripeFreePeriod?.end === Math.ceil(end / 1000);
  if (company.paymentRequired || founder || company.stripeTrialUsed && !originalFreePeriod || !Number.isFinite(end) || end <= now) return {};
  // Hosted Checkout supports a future billing anchor with no initial proration.
  // Keep the original deadline even in the final seconds; never reset the trial.
  const anchor = Math.ceil(end / 1000);
  if (anchor <= Math.floor(now / 1000)) return {};
  return { 'subscription_data[billing_cycle_anchor]': anchor,
    'subscription_data[proration_behavior]': 'none', payment_method_collection: 'always',
    'subscription_data[metadata][original_trial_end]': String(anchor),
    expires_at: Math.floor(now / 1000) + 86400 };
}

function anchoredFreePeriod(subscription, company, now = Date.now()) {
  const end = Number(subscription.metadata?.original_trial_end);
  return Number.isSafeInteger(end) && end > now / 1000 &&
    subscription.billing_cycle_anchor === end && subscription.metadata?.company_id === String(company.id) &&
    Math.ceil(Date.parse(company.trialEndsAt) / 1000) === end ? end : null;
}

function remainingAnchoredTrial(company, now = Date.now()) {
  const period = company.stripeFreePeriod;
  return Boolean(period && company.subscriptionStatus === 'Active' && period.subscriptionId === company.stripeSubscriptionId &&
    period.end === Math.ceil(Date.parse(company.trialEndsAt) / 1000) && period.end > now / 1000 && Date.parse(company.trialEndsAt) > now);
}

function projectCapacityError(db, limit) {
  return limit != null && (db.projects || []).filter(row => !row.archived).length >= limit
    ? `Your plan includes ${limit} active projects. Archive a project or manage your plan.` : null;
}

// New pay-first accounts must have a paid invoice belonging to their subscription.
// Existing trials have no paymentRequired marker and retain their original access.
async function confirmInitialPayment(company, subscription, request) {
  if (!company.paymentRequired || company.initialPaymentConfirmedAt || subscription.status !== 'active') return null;
  const invoiceId = idOf(subscription.latest_invoice);
  if (!invoiceId) return null;
  const invoice = await request('/invoices/' + encodeURIComponent(invoiceId), null, 'GET');
  const invoiceSubscription = idOf(invoice.subscription || invoice.parent?.subscription_details?.subscription);
  if (invoice.id !== invoiceId || invoiceSubscription !== subscription.id ||
      idOf(invoice.customer) !== idOf(subscription.customer) || invoice.livemode !== subscription.livemode) {
    throw fail('Payment ownership could not be verified. Contact support.', 503);
  }
  return invoice.status === 'paid' && Number(invoice.amount_paid) > 0 ? new Date().toISOString() : null;
}

// Only new signups carrying this server-owned marker qualify. Never infer eligibility
// from an old company's status or a request body.
function hasVerifiedCardTrial(company, now = Date.now()) {
  return !company.founder?.requested && company.cardTrialDays === 7 && company.subscriptionStatus === 'Trial' &&
    company.cardTrial?.subscriptionId === company.stripeSubscriptionId &&
    Number(company.cardTrial.end) * 1000 > now;
}
async function confirmCardTrial(company, subscription, request, now = Date.now()) {
  if (company.founder?.requested || company.cardTrialDays !== 7 || subscription.status !== 'trialing' ||
      !Number.isSafeInteger(subscription.trial_end) || subscription.trial_end * 1000 <= now) return null;
  const customerId = idOf(subscription.customer);
  let methodId = idOf(subscription.default_payment_method);
  if (!methodId) {
    const customer = await request('/customers/' + encodeURIComponent(customerId), null, 'GET');
    if (customer.id !== customerId || customer.deleted || customer.livemode !== subscription.livemode)
      throw fail('Trial customer ownership could not be verified.', 503);
    methodId = idOf(customer.invoice_settings?.default_payment_method);
  }
  if (!methodId) return null;
  const method = await request('/payment_methods/' + encodeURIComponent(methodId), null, 'GET');
  if (method.id !== methodId || idOf(method.customer) !== customerId || method.livemode !== subscription.livemode)
    throw fail('Trial payment method ownership could not be verified.', 503);
  if (method.type !== 'card') return null;
  return { subscriptionId: subscription.id, end: subscription.trial_end };
}

module.exports = { confirmCardTrial, hasVerifiedCardTrial, confirmInitialPayment, prepareCheckout, trialParameters, projectCapacityError, verifySubscription, anchoredFreePeriod, remainingAnchoredTrial };
