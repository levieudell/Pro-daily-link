'use strict';

const assert = require('node:assert/strict');
const portalPolicy = require('./billing-portal-policy');
const {
  STRIPE_PRICE_SPECIFICATIONS,
  checkMonitoring,
  checkPortalConfiguration,
  checkResend,
  checkStripePrice,
  reportFailures
} = require('./scripts/service-smoke-test');

const env = {
  STRIPE_SECRET_KEY: 'rk_live_synthetic',
  STRIPE_PORTAL_CONFIG_STANDARD: 'bpc_standard123',
  STRIPE_PORTAL_CONFIG_FOUNDER: 'bpc_founder123',
  RESEND_API_KEY: 're_synthetic',
  RESEND_FROM: 'Pro Daily Link <support@prodailylink.com>',
  RESEND_REPLY_TO: 'support@prodailylink.com',
  PDL_MONITOR_EMAIL_TO: 'monitor@example.invalid',
  SENTRY_DSN: 'https://0123456789abcdef@sentry.io/123456',
  SENTRY_AUTH_TOKEN: 'sntrys_synthetic',
  SENTRY_ORG: 'pro-daily-link',
  SENTRY_PROJECT: 'node'
};
for (const [key, productKey] of STRIPE_PRICE_SPECIFICATIONS) {
  env[key] = `price_${key.toLowerCase()}`;
  env[productKey] ||= `prod_${productKey.toLowerCase()}`;
}
Object.assign(process.env, env);

function response(value, status = 200) {
  return new Response(value == null ? null : JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}

(async () => {
  assert.equal(STRIPE_PRICE_SPECIFICATIONS.length, 13, 'standard, founder, and setup prices are all monitored');
  const standardPrices = portalPolicy.requiredStandardPriceIds({ starter: {}, growth: {}, pro: {} }, env);
  assert.equal(standardPrices.length, 6);
  const configurations = {
    [env.STRIPE_PORTAL_CONFIG_STANDARD]: { id: env.STRIPE_PORTAL_CONFIG_STANDARD, active: true, livemode: true,
      features: { subscription_update: { enabled: true, default_allowed_updates: ['price'], products: [{ product: 'prod_standard', prices: standardPrices }] } } },
    [env.STRIPE_PORTAL_CONFIG_FOUNDER]: { id: env.STRIPE_PORTAL_CONFIG_FOUNDER, active: true, livemode: true,
      features: { subscription_update: { enabled: false, default_allowed_updates: [], products: [] } } }
  };
  const retrievals = [];
  const stripe = { billingPortal: { configurations: { retrieve: async (id, options) => {
    retrievals.push({ id, options });
    return configurations[id];
  } } } };
  assert.equal((await checkPortalConfiguration(stripe, 'standard', env)).status, 'ready');
  assert.equal((await checkPortalConfiguration(stripe, 'founder', env)).status, 'ready');
  assert.deepEqual(retrievals, [env.STRIPE_PORTAL_CONFIG_STANDARD, env.STRIPE_PORTAL_CONFIG_FOUNDER].map(id => ({
    id,
    options: { expand: ['features.subscription_update.products'] }
  })), 'every portal validation retrieves the expanded price allowlist');
  assert.equal((await checkPortalConfiguration(stripe, 'standard', { ...env, STRIPE_PORTAL_CONFIG_STANDARD: '' })).status, 'blocked');

  const unexpandedStandard = structuredClone(configurations[env.STRIPE_PORTAL_CONFIG_STANDARD]);
  delete unexpandedStandard.features.subscription_update.products;
  const unexpanded = await checkPortalConfiguration({ billingPortal: { configurations: {
    retrieve: async (_id, options) => {
      assert.deepEqual(options, { expand: ['features.subscription_update.products'] });
      return unexpandedStandard;
    }
  } } }, 'standard', env);
  assert.deepEqual(unexpanded, { kind: 'standard', status: 'blocked', reason: 'unsafe-price-change-configuration' },
    'an unexpanded or missing portal allowlist must fail closed');

  configurations[env.STRIPE_PORTAL_CONFIG_FOUNDER].features.subscription_update.enabled = true;
  assert.equal((await checkPortalConfiguration(stripe, 'founder', env)).status, 'blocked');
  configurations[env.STRIPE_PORTAL_CONFIG_FOUNDER].features.subscription_update.enabled = false;
  const denied = await checkPortalConfiguration({ billingPortal: { configurations: { retrieve: async () => { throw Object.assign(new Error('hidden'), { statusCode: 403 }); } } } }, 'standard', env);
  assert.deepEqual(denied, { kind: 'standard', status: 'unknown', reason: 'permission-denied' });

  const setupSpec = STRIPE_PRICE_SPECIFICATIONS.find(([key]) => key === 'STRIPE_PRICE_ASSISTED_SETUP');
  const setupPrice = { id: env[setupSpec[0]], active: true, livemode: true, currency: 'usd', unit_amount: 49900,
    custom_unit_amount: null, billing_scheme: 'per_unit', transform_quantity: null, tiers_mode: null,
    type: 'one_time', recurring: null, product: { id: env[setupSpec[1]], active: true, livemode: true } };
  const setup = await checkStripePrice({ prices: { retrieve: async (id, options) => {
    assert.deepEqual(options, { expand: ['product'] }); return { ...setupPrice, id };
  } } }, setupSpec, true, env);
  assert.equal(setup.ok, true);
  const founderSpec = STRIPE_PRICE_SPECIFICATIONS.find(([key]) => key === 'STRIPE_PRICE_FOUNDER_PRO_ANNUAL');
  const founderPrice = { id: env[founderSpec[0]], active: true, livemode: true, currency: 'usd', unit_amount: 319000,
    custom_unit_amount: null, billing_scheme: 'per_unit', transform_quantity: null, tiers_mode: null,
    type: 'recurring', product: { id: env[founderSpec[1]], active: true, livemode: true },
    recurring: { interval: 'year', interval_count: 1, usage_type: 'licensed', aggregate_usage: null, meter: null } };
  const founder = await checkStripePrice({ prices: { retrieve: async () => founderPrice } }, founderSpec, true, env);
  assert.equal(founder.ok, true);
  for (const changed of [{ billing_scheme: 'tiered' }, { transform_quantity: { divide_by: 10, round: 'up' } },
    { product: { ...founderPrice.product, active: false } }, { product: { ...founderPrice.product, id: 'prod_wrong' } },
    { recurring: { ...founderPrice.recurring, usage_type: 'metered' } }]) {
    assert.equal((await checkStripePrice({ prices: { retrieve: async () => ({ ...founderPrice, ...changed }) } }, founderSpec, true, env)).ok, false,
      'tiered, transformed, metered, wrong, or inactive product prices must fail closed');
  }

  const resendCalls = [];
  const resend = await checkResend(true, { waitImpl: async () => {}, fetchImpl: async (url, options = {}) => {
    resendCalls.push({ url, method: options.method || 'GET' });
    if (url.endsWith('/domains')) return response({ data: [{ name: 'prodailylink.com', status: 'verified' }] });
    if (url.endsWith('/emails')) return response({ id: 'email_synthetic' });
    return response({ id: 'email_synthetic', last_event: 'delivered' });
  } });
  assert.equal(resend.delivery, 'verified');
  assert.equal(JSON.stringify(resend).includes('email_synthetic'), false, 'provider IDs are hashed before output');
  assert.equal(resendCalls.some(call => call.method === 'POST'), true);

  const sentry = await checkMonitoring(true, {
    monitor: { init: () => true, captureVerification: () => 'a'.repeat(32), flush: async () => true },
    waitImpl: async () => {}, fetchImpl: async () => response({ eventID: 'a'.repeat(32) })
  });
  assert.equal(sentry.delivery, 'verified');
  assert.equal(JSON.stringify(sentry).includes('a'.repeat(32)), false);
  const sentryDenied = await checkMonitoring(true, {
    monitor: { init: () => true, captureVerification: () => 'b'.repeat(32), flush: async () => true },
    waitImpl: async () => {}, fetchImpl: async () => response({}, 403)
  });
  assert.equal(sentryDenied.delivery, 'unknown');

  const baseReport = {
    stripe: { configured: true, reachable: true, prices: STRIPE_PRICE_SPECIFICATIONS.map(([key]) => ({ key, ok: true })), webhook: { status: 'ready', officialEndpointCount: 1, missingRequiredEvents: [], obsoleteEnabledPdlEndpoints: [] },
      portals: { standard: { status: 'ready' }, founder: { status: 'ready' } } },
    resend: { configured: true, reachable: true, delivery: 'verified' },
    monitoring: { configured: true, delivery: 'verified' }
  };
  assert.deepEqual(reportFailures(baseReport), []);
  assert.ok(reportFailures({ ...baseReport, stripe: { ...baseReport.stripe, portals: { ...baseReport.stripe.portals, standard: { status: 'unknown' } } } }).includes('stripe.portal-standard-unknown'));
  assert.ok(reportFailures({ ...baseReport, resend: { ...baseReport.resend, delivery: 'not-checked' } }).includes('resend.delivery-not-verified'));
  assert.ok(reportFailures({ ...baseReport, monitoring: { ...baseReport.monitoring, delivery: 'unknown' } }).includes('sentry.delivery-not-verified'));

  console.log('Provider smoke checks passed: portal policy, complete price catalog, Resend delivery, and Sentry ingestion all fail closed.');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
