'use strict';

const assert = require('node:assert/strict');
const {
  REQUIRED_STRIPE_WEBHOOK_EVENTS,
  STRIPE_PRICE_SPECIFICATIONS,
  checkStripeWebhookEndpoints,
  inspectStripeWebhookInventory,
  reportFailures
} = require('./scripts/service-smoke-test');

const expectedUrl = 'https://app.prodailylink.com/api/billing/webhook';

function endpoint(id, url, enabledEvents = REQUIRED_STRIPE_WEBHOOK_EVENTS, description = '') {
  return { id, url, status: 'enabled', enabled_events: [...enabledEvents], description };
}

function report(webhook) {
  return {
    stripe: { configured: true, reachable: true, prices: STRIPE_PRICE_SPECIFICATIONS.map(([key]) => ({ key, ok: true })), webhook,
      portals: { standard: { status: 'ready' }, founder: { status: 'ready' } } },
    resend: { configured: true, reachable: true, delivery: 'verified', domains: [{ name: 'mail.prodailylink.com', status: 'verified' }] },
    monitoring: { configured: true, delivery: 'verified' }
  };
}

(async () => {
  const ready = inspectStripeWebhookInventory({
    data: [endpoint('we_official', expectedUrl)],
    has_more: false
  }, expectedUrl);
  assert.equal(ready.status, 'ready');
  assert.equal(ready.inventory, 'complete');
  assert.deepEqual(ready.missingRequiredEvents, []);
  assert.deepEqual(reportFailures(report(ready)), []);

  const missingAsyncSuccess = inspectStripeWebhookInventory({
    data: [endpoint('we_official', expectedUrl,
      REQUIRED_STRIPE_WEBHOOK_EVENTS.filter(event => event !== 'checkout.session.async_payment_succeeded'))],
    has_more: false
  }, expectedUrl);
  assert.equal(missingAsyncSuccess.status, 'blocked');
  assert.deepEqual(missingAsyncSuccess.missingRequiredEvents, ['checkout.session.async_payment_succeeded']);
  assert.ok(reportFailures(report(missingAsyncSuccess)).includes('stripe.webhook-not-ready'));
  assert.ok(reportFailures(report(missingAsyncSuccess)).includes('stripe.webhook-required-events-incomplete'));

  const missingAsyncFailure = inspectStripeWebhookInventory({
    data: [endpoint('we_official', expectedUrl,
      REQUIRED_STRIPE_WEBHOOK_EVENTS.filter(event => event !== 'checkout.session.async_payment_failed'))],
    has_more: false
  }, expectedUrl);
  assert.equal(missingAsyncFailure.status, 'blocked');
  assert.deepEqual(missingAsyncFailure.missingRequiredEvents, ['checkout.session.async_payment_failed']);

  const duplicate = inspectStripeWebhookInventory({
    data: [endpoint('we_one', expectedUrl), endpoint('we_two', expectedUrl)],
    has_more: false
  }, expectedUrl);
  assert.equal(duplicate.status, 'blocked');
  assert.equal(duplicate.officialEndpointCount, 2);
  assert.equal(duplicate.duplicateOfficialEndpoints.length, 2);
  assert.ok(reportFailures(report(duplicate)).includes('stripe.official-webhook-duplicate'));

  const obsolete = inspectStripeWebhookInventory({
    data: [
      endpoint('we_official', expectedUrl),
      endpoint('we_supabase', 'https://izhjrpplvlxescoocodf.supabase.co/functions/v1/stripe-webhook'),
      endpoint('we_base44', 'https://pro-daily-link-6a8263c4.base44.app/api/functions/stripeWebhook')
    ],
    has_more: false
  }, expectedUrl);
  assert.equal(obsolete.status, 'blocked');
  assert.deepEqual(obsolete.obsoleteEnabledPdlEndpoints.map(value => value.classification), ['legacy-supabase', 'legacy-base44']);
  assert.ok(reportFailures(report(obsolete)).includes('stripe.obsolete-pdl-webhook-enabled'));
  assert.equal(JSON.stringify(obsolete).includes('/functions/v1/'), false, 'nonofficial webhook paths must not be exposed');

  const partial = inspectStripeWebhookInventory({ data: [endpoint('we_official', expectedUrl)], has_more: true }, expectedUrl);
  assert.equal(partial.status, 'unknown');
  assert.equal(partial.reason, 'provider-pagination-incomplete');
  assert.ok(reportFailures(report(partial)).includes('stripe.webhook-inventory-unknown'));

  const permissionUnknown = await checkStripeWebhookEndpoints({
    webhookEndpoints: { list: async () => { throw Object.assign(new Error('do not disclose'), { statusCode: 403 }); } }
  }, expectedUrl);
  assert.equal(permissionUnknown.status, 'unknown');
  assert.equal(permissionUnknown.inventory, 'unavailable');
  assert.equal(permissionUnknown.reason, 'permission-denied');
  assert.equal(permissionUnknown.found, null);
  assert.ok(reportFailures(report(permissionUnknown)).includes('stripe.webhook-inventory-unknown'));

  await assert.rejects(() => checkStripeWebhookEndpoints({
    webhookEndpoints: { list: async () => { throw Object.assign(new Error('provider unavailable'), { statusCode: 500 }); } }
  }, expectedUrl), /provider unavailable/);

  console.log('Stripe service monitoring passed: required events, duplicate/legacy endpoints, and provider-unknown states all fail closed.');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
