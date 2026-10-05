const Stripe = require('stripe');
const standardResubscription = require('./standard-resubscription');

const EVENTS = new Set([
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.paid',
  'invoice.payment_failed',
]);

function failure(message, statusCode) {
  return Object.assign(new Error(message), { statusCode });
}

async function readRawBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) throw failure('Webhook payload too large', 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function verifyEvent(payload, signature, env = process.env) {
  if (!env.STRIPE_WEBHOOK_SECRET) throw failure('Stripe webhook is not configured', 503);
  let event;
  try {
    event = Stripe.webhooks.constructEvent(payload, signature, env.STRIPE_WEBHOOK_SECRET);
  } catch {
    // Never log the payload, signature, or signing secret.
    throw failure('Invalid Stripe webhook signature or payload', 400);
  }
  if (!event.id || !event.type || !event.data?.object || !Number.isFinite(event.created)) {
    throw failure('Invalid Stripe event', 400);
  }
  const key = env.STRIPE_SECRET_KEY || '';
  if (/^(sk|rk)_test_/.test(key) && event.livemode !== false ||
      /^(sk|rk)_live_/.test(key) && event.livemode !== true) {
    throw failure('Stripe mode mismatch', 400);
  }
  return event;
}

const idOf = value => typeof value === 'string' ? value : value?.id;

async function processEvent(event, { stripeRequest, withCompany, applySubscription, persist, processEnterprise }) {
  if (processEnterprise && await processEnterprise(event)) return { received: true };
  if (!EVENTS.has(event.type)) return { received: true, ignored: true };
  const object = event.data.object;
  const details = object.parent?.subscription_details || object.subscription_details;
  const subscriptionId = event.type.startsWith('customer.subscription.')
    ? object.id : idOf(object.subscription) || idOf(details?.subscription);
  if (!subscriptionId) return { received: true, ignored: true };

  // Retrieve current state: Stripe may retry or deliver events out of order.
  const subscription = await stripeRequest(`/subscriptions/${encodeURIComponent(subscriptionId)}`, null, 'GET');
  const companyId = String(subscription.metadata?.company_id || '').trim();
  if (!companyId) return { received: true, ignored: true };
  const eventCompany = object.metadata?.company_id || details?.metadata?.company_id || object.client_reference_id;
  if (eventCompany && eventCompany !== companyId) throw failure('Stripe company mismatch', 400);
  if (subscription.id !== subscriptionId ||
      (idOf(object.customer) && idOf(object.customer) !== idOf(subscription.customer))) {
    throw failure('Stripe subscription mismatch', 400);
  }

  await withCompany(companyId, async db => {
    if (String(db.company.id) !== companyId) throw failure('Company mismatch', 400);
    if (db.company.stripeCustomerId && db.company.stripeCustomerId !== idOf(subscription.customer)) {
      throw failure('Stripe customer mismatch', 400);
    }
    if (standardResubscription.isRetired(db.company, subscriptionId) ||
        (db.company.stripeResubscription?.retiredCheckoutAttempts || []).includes(subscription.metadata?.checkout_attempt)) return;
    if (db.company.stripeSubscriptionId && db.company.stripeSubscriptionId !== subscriptionId) {
      // Events for a superseded subscription must not cancel the current one.
      return;
    }
    const seen = db.company.stripeWebhookEvents || [];
    if (!seen.includes(event.id)) {
      await applySubscription(db, subscription);
      db.company.stripeWebhookEvents = [...seen, event.id].slice(-200);
    }
    // Repeat persistence on retries in case an earlier local save succeeded but cloud save failed.
    await persist(db);
  });
  return { received: true };
}

module.exports = { EVENTS, readRawBody, verifyEvent, processEvent };
