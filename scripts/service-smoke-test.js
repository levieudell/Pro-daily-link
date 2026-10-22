'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const Stripe = require('stripe');
const supabase = require('../database/supabase');
const monitoring = require('../monitoring');
const portalPolicy = require('../billing-portal-policy');
const providerReadiness = require('../provider-readiness');
const stripePricePolicy = require('../stripe-price-policy');

supabase.loadLocalEnv(path.resolve(__dirname, '..'));

const REQUIRED_STRIPE_WEBHOOK_EVENTS = Object.freeze([
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'checkout.session.async_payment_failed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.paid',
  'invoice.payment_failed'
]);

const KNOWN_OBSOLETE_PDL_WEBHOOK_HOSTS = Object.freeze(new Map([
  ['izhjrpplvlxescoocodf.supabase.co', 'legacy-supabase'],
  ['pro-daily-link-6a8263c4.base44.app', 'legacy-base44']
]));
const PORTAL_PLANS = Object.freeze({ starter: {}, growth: {}, pro: {} });
const STRIPE_PRICE_SPECIFICATIONS = stripePricePolicy.CATALOG;

function endpointHost(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return 'invalid-url'; }
}

function summarizeEndpoint(endpoint, classification) {
  return {
    id: String(endpoint?.id || 'unknown'),
    host: endpointHost(endpoint?.url),
    classification
  };
}

function isPdlEndpoint(endpoint, expectedUrl) {
  if (endpoint?.url === expectedUrl) return true;
  const host = endpointHost(endpoint?.url);
  if (KNOWN_OBSOLETE_PDL_WEBHOOK_HOSTS.has(host)) return true;
  return /(?:pro[ -]?daily[ -]?link|prodailylink|\bpdl\b)/i.test(String(endpoint?.description || '')) ||
    /(?:pro-daily-link|prodailylink)/i.test(host);
}

function inspectStripeWebhookInventory(list, expectedUrl) {
  const all = Array.isArray(list?.data) ? list.data : [];
  const enabled = all.filter(endpoint => endpoint?.status === 'enabled');
  const official = enabled.filter(endpoint => endpoint?.url === expectedUrl);
  const enabledEvents = official.length === 1 && Array.isArray(official[0].enabled_events)
    ? official[0].enabled_events.slice().sort()
    : [];
  const acceptsAllEvents = enabledEvents.includes('*');
  const missingRequiredEvents = official.length !== 1
    ? null
    : (acceptsAllEvents ? [] : REQUIRED_STRIPE_WEBHOOK_EVENTS.filter(event => !enabledEvents.includes(event)));
  const duplicateOfficialEndpoints = official.length > 1
    ? official.map(endpoint => summarizeEndpoint(endpoint, 'duplicate-official'))
    : [];
  const obsoleteEnabledPdlEndpoints = enabled
    .filter(endpoint => endpoint?.url !== expectedUrl && isPdlEndpoint(endpoint, expectedUrl))
    .map(endpoint => {
      const host = endpointHost(endpoint?.url);
      return summarizeEndpoint(endpoint, KNOWN_OBSOLETE_PDL_WEBHOOK_HOSTS.get(host) || 'unexpected-pdl-endpoint');
    });
  const inventoryComplete = list?.has_more === false;
  const blocked = official.length !== 1 || (missingRequiredEvents?.length || 0) > 0 ||
    duplicateOfficialEndpoints.length > 0 || obsoleteEnabledPdlEndpoints.length > 0;

  return {
    expectedUrl,
    status: blocked ? 'blocked' : (inventoryComplete ? 'ready' : 'unknown'),
    inventory: inventoryComplete ? 'complete' : 'partial',
    reason: inventoryComplete ? null : 'provider-pagination-incomplete',
    found: official.length > 0,
    officialEndpointCount: official.length,
    requiredEvents: REQUIRED_STRIPE_WEBHOOK_EVENTS.slice(),
    enabledEvents,
    missingRequiredEvents,
    duplicateOfficialEndpoints,
    obsoleteEnabledPdlEndpoints
  };
}

function providerAccessFailure(error) {
  const status = Number(error?.statusCode || error?.raw?.statusCode || 0);
  const type = String(error?.type || error?.rawType || '');
  if (status === 403 || type === 'StripePermissionError') return 'permission-denied';
  if (status === 401 || type === 'StripeAuthenticationError') return 'authentication-failed';
  return null;
}

function unavailableStripeWebhookInventory(expectedUrl, reason) {
  return {
    expectedUrl,
    status: 'unknown',
    inventory: 'unavailable',
    reason,
    found: null,
    officialEndpointCount: null,
    requiredEvents: REQUIRED_STRIPE_WEBHOOK_EVENTS.slice(),
    enabledEvents: [],
    missingRequiredEvents: null,
    duplicateOfficialEndpoints: null,
    obsoleteEnabledPdlEndpoints: null
  };
}

async function checkStripeWebhookEndpoints(stripe, expectedUrl) {
  try {
    const endpoints = await stripe.webhookEndpoints.list({ limit: 100 });
    return inspectStripeWebhookInventory(endpoints, expectedUrl);
  } catch (error) {
    const reason = providerAccessFailure(error);
    if (!reason) throw error;
    return unavailableStripeWebhookInventory(expectedUrl, reason);
  }
}

function unavailablePortal(kind, reason) {
  return { kind, status: 'unknown', reason };
}

async function checkPortalConfiguration(stripe, kind, env = process.env) {
  const company = kind === 'founder' ? { founder: { requested: true } } : {};
  let policy;
  try { policy = portalPolicy.select(company, env); }
  catch { return { kind, status: 'blocked', reason: 'configuration-id-invalid' }; }
  if (!policy.configurationId) return { kind, status: 'blocked', reason: 'configuration-id-missing' };
  let configuration;
  try {
    configuration = await stripe.billingPortal.configurations.retrieve(policy.configurationId, {
      expand: portalPolicy.CONFIGURATION_EXPAND
    });
  }
  catch (error) {
    const reason = providerAccessFailure(error);
    if (reason) return unavailablePortal(kind, reason);
    throw error;
  }
  try {
    portalPolicy.validate(configuration, policy, PORTAL_PLANS, env);
    return { kind, status: 'ready', priceChanges: kind === 'standard' ? 'exact-standard-catalog' : 'disabled' };
  } catch {
    return { kind, status: 'blocked', reason: kind === 'standard' ? 'unsafe-price-change-configuration' : 'founder-price-changes-enabled' };
  }
}

async function checkStripePrice(stripe, specification, liveExpected, env = process.env) {
  const [key, productKey] = specification;
  const id = String(env[key] || '').trim();
  if (!id || !String(env[productKey] || '').trim()) return { key, ok: false, reason: 'missing' };
  let price;
  try { price = await stripe.prices.retrieve(id, { expand: ['product'] }); }
  catch (error) {
    const reason = providerAccessFailure(error);
    if (reason) return { key, ok: false, reason };
    throw error;
  }
  const ok = stripePricePolicy.matches(price, specification, env, liveExpected);
  return { key, ok, active: price.active === true, livemode: price.livemode === true, amount: price.unit_amount,
    currency: price.currency, type: price.type, recurring: price.recurring?.interval || null,
    productActive: price.product?.active === true, billingScheme: price.billing_scheme || null,
    usageType: price.recurring?.usage_type || null };
}

async function checkStripe() {
  if (!process.env.STRIPE_SECRET_KEY) return { configured: false };
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  // Stripe restricted keys use rk_live_; they are the safer production choice
  // and should not be mistaken for test-mode credentials.
  const liveExpected = /^(?:sk|rk)_live_/.test(process.env.STRIPE_SECRET_KEY);
  const balance = await stripe.balance.retrieve();
  const prices = [];
  for (const specification of STRIPE_PRICE_SPECIFICATIONS) prices.push(await checkStripePrice(stripe, specification, liveExpected));
  const publicUrl = String(process.env.PDL_PUBLIC_URL || '').replace(/\/$/, '');
  const expectedUrl = `${publicUrl}/api/billing/webhook`;
  const webhook = await checkStripeWebhookEndpoints(stripe, expectedUrl);
  const portals = {
    standard: await checkPortalConfiguration(stripe, 'standard'),
    founder: await checkPortalConfiguration(stripe, 'founder')
  };
  return { configured: true, reachable: Boolean(balance), liveMode: liveExpected, prices, webhook, portals };
}

function wait(milliseconds) { return new Promise(resolve => setTimeout(resolve, milliseconds)); }
function opaqueReference(value) { return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 16); }
function resendSenderDomain(value) {
  const match = String(value || '').trim().match(/(?:<)?[^<>\s@]+@([^<>\s@]+)>?$/);
  return match ? match[1].toLowerCase() : null;
}

async function checkResend(active, { fetchImpl = fetch, waitImpl = wait } = {}) {
  if (!process.env.RESEND_API_KEY) return { configured: false };
  const headers = { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json', 'User-Agent': 'ProDailyLink/1.0' };
  const result = { configured: true, reachable: null, domainVerification: 'not-checked', delivery: active ? 'pending' : 'not-checked' };
  const domainResponse = await fetchImpl('https://api.resend.com/domains', { headers });
  if (domainResponse.ok) {
    const domains = (await domainResponse.json()).data || [];
    result.reachable = true;
    result.domainVerification = 'read-from-resend';
    result.domains = domains.map(domain => ({ name: domain.name, status: domain.status }));
  } else if (domainResponse.status === 401 || domainResponse.status === 403) {
    // Production intentionally uses a sending-only key. It can deliver mail but
    // cannot enumerate account domains; do not weaken the key just for a probe.
    result.domainVerification = 'sending-key-cannot-read-domains';
  } else {
    throw new Error(`Resend domain check failed (${domainResponse.status})`);
  }
  if (active) {
    const to = String(process.env.PDL_MONITOR_EMAIL_TO || '').trim();
    if (!to) throw new Error('PDL_MONITOR_EMAIL_TO is required with --send-email');
    const from = String(process.env.RESEND_FROM || '').trim();
    if (!resendSenderDomain(from)) throw new Error('RESEND_FROM must contain a valid sender address');
    const response = await fetchImpl('https://api.resend.com/emails', { method: 'POST', headers, body: JSON.stringify({ from, reply_to: process.env.RESEND_REPLY_TO || 'support@prodailylink.com', to: [to], subject: 'Pro Daily Link email monitoring test', html: '<p>Pro Daily Link production email delivery verification.</p>' }) });
    if (!response.ok) {
      // Provider messages can echo the destination address or request details;
      // CI evidence needs only the status class, never provider response text.
      throw new Error(`Resend delivery test failed (${response.status})`);
    }
    result.reachable = true;
    const messageId = String((await response.json()).id || '');
    if (!messageId) throw new Error('Resend did not return a message identifier');
    result.messageReference = opaqueReference(messageId);
    for (let attempt = 0; attempt < 6; attempt++) {
      if (attempt) await waitImpl(2000);
      const deliveryResponse = await fetchImpl(`https://api.resend.com/emails/${encodeURIComponent(messageId)}`, { headers });
      if (deliveryResponse.status === 401 || deliveryResponse.status === 403) { result.delivery = 'unknown'; result.deliveryReason = 'permission-denied'; break; }
      if (!deliveryResponse.ok) { result.delivery = 'unknown'; result.deliveryReason = `provider-${deliveryResponse.status}`; break; }
      const delivery = await deliveryResponse.json();
      const event = String(delivery.last_event || '').toLowerCase();
      if (event === 'delivered') { result.delivery = 'verified'; break; }
      if (['bounced', 'complained', 'failed', 'canceled'].includes(event)) { result.delivery = 'failed'; result.deliveryReason = event; break; }
    }
  }
  return result;
}

async function checkMonitoring(active, { monitor = monitoring, fetchImpl = fetch, waitImpl = wait } = {}) {
  if (!monitor.init(process.env)) return { configured: false, delivery: 'not-checked' };
  if (!active) return { configured: true, delivery: 'not-checked' };
  const token = String(process.env.SENTRY_AUTH_TOKEN || '').trim();
  const organization = String(process.env.SENTRY_ORG || '').trim();
  const project = String(process.env.SENTRY_PROJECT || '').trim();
  if (!token || !/^[a-z0-9_-]{1,64}$/i.test(organization) || !/^[a-z0-9_-]{1,64}$/i.test(project)) {
    return { configured: true, delivery: 'unknown', reason: 'verification-access-missing' };
  }
  const eventId = monitor.captureVerification();
  if (!eventId || !(await monitor.flush(10_000))) return { configured: true, delivery: 'failed', reason: 'ingest-flush-failed' };
  const url = `https://sentry.io/api/0/projects/${encodeURIComponent(organization)}/${encodeURIComponent(project)}/events/${encodeURIComponent(eventId)}/`;
  for (let attempt = 0; attempt < 6; attempt++) {
    if (attempt) await waitImpl(2000);
    const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'ProDailyLink/1.0' } });
    if (response.ok) return { configured: true, delivery: 'verified', eventReference: opaqueReference(eventId) };
    if (response.status === 401 || response.status === 403) return { configured: true, delivery: 'unknown', reason: 'permission-denied' };
    if (response.status !== 404) return { configured: true, delivery: 'unknown', reason: `provider-${response.status}` };
  }
  return { configured: true, delivery: 'unknown', reason: 'event-not-observed' };
}

function reportFailures(report) {
  const failures = [];
  const stripe = report?.stripe || {}, resend = report?.resend || {}, sentry = report?.monitoring || {};
  if (!stripe.configured) {
    failures.push('stripe.not-configured');
  } else {
    if (!stripe.reachable) failures.push('stripe.unreachable');
    if (!Array.isArray(stripe.prices) || stripe.prices.length !== STRIPE_PRICE_SPECIFICATIONS.length || stripe.prices.some(price => !price.ok)) failures.push('stripe.price-mismatch');
    const webhook = stripe.webhook;
    if (!webhook || webhook.status === 'unknown') failures.push('stripe.webhook-inventory-unknown');
    else if (webhook.status !== 'ready') failures.push('stripe.webhook-not-ready');
    if (webhook?.officialEndpointCount === 0) failures.push('stripe.official-webhook-missing');
    if ((webhook?.officialEndpointCount || 0) > 1) failures.push('stripe.official-webhook-duplicate');
    if (Array.isArray(webhook?.missingRequiredEvents) && webhook.missingRequiredEvents.length) {
      failures.push('stripe.webhook-required-events-incomplete');
    }
    if (Array.isArray(webhook?.obsoleteEnabledPdlEndpoints) && webhook.obsoleteEnabledPdlEndpoints.length) {
      failures.push('stripe.obsolete-pdl-webhook-enabled');
    }
    for (const kind of ['standard', 'founder']) {
      const portal = stripe.portals?.[kind];
      if (!portal || portal.status === 'unknown') failures.push(`stripe.portal-${kind}-unknown`);
      else if (portal.status !== 'ready') failures.push(`stripe.portal-${kind}-not-ready`);
    }
  }
  if (!resend.configured || resend.reachable === false) failures.push('resend.unavailable');
  if (resend.delivery !== 'verified') failures.push('resend.delivery-not-verified');
  if (resend.domains?.some(domain => domain.name === 'mail.prodailylink.com' && domain.status !== 'verified')) {
    failures.push('resend.domain-unverified');
  }
  if (!sentry.configured) failures.push('sentry.not-configured');
  else if (sentry.delivery !== 'verified') failures.push('sentry.delivery-not-verified');
  return failures;
}

async function main() {
  const publish = process.argv.includes('--publish-readiness');
  const active = publish || process.argv.includes('--active') || process.argv.includes('--send-email');
  const report = { checkedAt: new Date().toISOString(), stripe: await checkStripe(), resend: await checkResend(active), monitoring: await checkMonitoring(active) };
  const failures = reportFailures(report);
  report.failures = failures;
  if (publish && !failures.length) report.readiness = await providerReadiness.publish({ report, upload: supabase.upload, download: supabase.download });
  console.log(JSON.stringify(report, null, 2));
  if (failures.length) process.exitCode = 1;
}

if (require.main === module) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}

module.exports = {
  REQUIRED_STRIPE_WEBHOOK_EVENTS,
  STRIPE_PRICE_SPECIFICATIONS,
  checkMonitoring,
  checkPortalConfiguration,
  checkResend,
  checkStripePrice,
  checkStripeWebhookEndpoints,
  inspectStripeWebhookInventory,
  providerAccessFailure,
  reportFailures,
  unavailableStripeWebhookInventory
};
