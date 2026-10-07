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
  const end = Date.parse(company.trialEndsAt);
  const originalFreePeriod = company.stripeFreePeriod?.end === Math.ceil(end / 1000);
  if (founder || company.stripeTrialUsed && !originalFreePeriod || !Number.isFinite(end) || end <= now) return {};
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
  return company.subscriptionStatus === 'Active' && period?.subscriptionId === company.stripeSubscriptionId &&
    period.end === Math.ceil(Date.parse(company.trialEndsAt) / 1000) && period.end > now / 1000 && Date.parse(company.trialEndsAt) > now;
}

function projectCapacityError(db, limit) {
  return limit != null && (db.projects || []).filter(row => !row.archived).length >= limit
    ? `Your plan includes ${limit} active projects. Archive a project or manage your plan.` : null;
}

module.exports = { prepareCheckout, trialParameters, projectCapacityError, verifySubscription, anchoredFreePeriod, remainingAnchoredTrial };
