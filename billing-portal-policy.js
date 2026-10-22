'use strict';

const CONFIGURATION_ID = /^bpc_[A-Za-z0-9]{8,100}$/;
const CONFIGURATION_EXPAND = Object.freeze(['features.subscription_update.products']);

function failure(message, statusCode = 503) {
  return Object.assign(new Error(message), { statusCode });
}

function founderAccount(company) {
  return company?.founder?.requested === true;
}

function select(company, env = process.env) {
  const founder = founderAccount(company);
  const key = founder ? 'STRIPE_PORTAL_CONFIG_FOUNDER' : 'STRIPE_PORTAL_CONFIG_STANDARD';
  const configurationId = String(env[key] || '').trim();
  if (configurationId && !CONFIGURATION_ID.test(configurationId)) {
    throw failure('Billing management is not configured safely. Contact support.');
  }
  return {
    kind: founder ? 'founder' : 'standard',
    configurationId: configurationId || null,
    planChanges: founder ? 'protected' : configurationId ? 'portal' : 'support',
    message: founder
      ? 'Founder pricing and its 24-month terms are protected. Contact support before changing plans.'
      : configurationId
        ? 'Change plans securely in the Stripe billing portal.'
        : 'Contact support to change plans while self-service plan changes are being configured.'
  };
}

function priceIds(plans, env = process.env, founder = false) {
  const prefix = founder ? 'STRIPE_PRICE_FOUNDER_' : 'STRIPE_PRICE_';
  const ids = [];
  for (const plan of Object.keys(plans || {})) {
    const upper = plan.toUpperCase();
    for (const suffix of ['', '_ANNUAL']) {
      const id = String(env[`${prefix}${upper}${suffix}`] || '').trim();
      if (id) ids.push(id);
    }
  }
  return ids;
}

function requiredStandardPriceIds(plans, env = process.env) {
  const planNames = Object.keys(plans || {});
  const expectedCount = planNames.length * 2;
  const ids = priceIds(plans, env, false);
  if (!expectedCount || ids.length !== expectedCount || new Set(ids).size !== expectedCount) {
    throw failure('All current monthly and annual plan prices must be configured before self-service plan changes are enabled.');
  }
  return ids;
}

function portalPriceIds(configuration) {
  return new Set((configuration?.features?.subscription_update?.products || [])
    .flatMap(product => product?.prices || [])
    .map(price => typeof price === 'string' ? price : price?.id)
    .filter(Boolean));
}

function validate(configuration, policy, plans, env = process.env) {
  const live = /^(?:sk|rk)_live_/.test(String(env.STRIPE_SECRET_KEY || ''));
  if (!configuration || configuration.id !== policy.configurationId || configuration.active !== true || configuration.livemode !== live) {
    throw failure('Billing management configuration could not be verified. Contact support.');
  }
  const update = configuration.features?.subscription_update;
  if (policy.kind === 'founder') {
    if (update?.enabled !== false) throw failure('Founder billing protection could not be verified. Contact support.');
    return policy;
  }
  if (update?.enabled !== true || !(update.default_allowed_updates || []).includes('price')) {
    throw failure('Self-service plan changes are not configured safely. Contact support.');
  }
  const expected = requiredStandardPriceIds(plans, env);
  const configured = portalPriceIds(configuration);
  if (configured.size !== expected.length || expected.some(id => !configured.has(id))) {
    throw failure('The billing portal must include exactly the current Pro Daily Link plans. Contact support.');
  }
  const founderPrices = new Set(priceIds(plans, env, true));
  if ([...configured].some(id => founderPrices.has(id))) {
    throw failure('Founder prices cannot be exposed through standard plan changes. Contact support.');
  }
  return policy;
}

function summary(company, env = process.env) {
  try {
    const policy = select(company, env);
    return { mode: policy.planChanges, message: policy.message, configured: Boolean(policy.configurationId) };
  } catch {
    return { mode: 'support', message: 'Contact support to manage plan changes.', configured: false };
  }
}

module.exports = { CONFIGURATION_EXPAND, CONFIGURATION_ID, failure, founderAccount, portalPriceIds, priceIds, requiredStandardPriceIds, select, summary, validate };
