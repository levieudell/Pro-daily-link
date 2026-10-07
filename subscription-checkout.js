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
  let recovering = false;
  const check = async id => {
    const subscription = verifySubscription(await request('/subscriptions/' + encodeURIComponent(id), null, 'GET'), id, { ...company, stripeCustomerId: customer }, env);
    if (!terminal(subscription)) throw fail('Use Manage billing for an existing subscription.');
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
    delete company.stripeSubscriptionId;
  }
  return previous;
}

function trialParameters(company, founder, now = Date.now()) {
  const end = Date.parse(company.trialEndsAt);
  if (founder || company.stripeTrialUsed || !Number.isFinite(end) || end <= now) return {};
  // Checkout requires >=48h at creation. Expire before that boundary, with
  // one minute of margin and Checkout's minimum 30-minute session lifetime.
  const expires = Math.min(Math.floor(now / 1000) + 86400, Math.floor(end / 1000) - 48 * 3600 - 60);
  if (expires < Math.floor(now / 1000) + 1800) {
    throw fail('Your remaining free trial is preserved. Checkout opens when your trial ends; please return then to choose a paid plan.');
  }
  return { 'subscription_data[trial_end]': Math.floor(end / 1000), expires_at: expires };
}

function projectCapacityError(db, limit) {
  return limit != null && (db.projects || []).filter(row => !row.archived).length >= limit
    ? `Your plan includes ${limit} active projects. Archive a project or manage your plan.` : null;
}

module.exports = { prepareCheckout, trialParameters, projectCapacityError, verifySubscription };
