// Stripe restricted keys use rk_live_; they are the safer production choice
  // and should not be mistaken for test-mode credentials.
  const liveExpected = /^(?:sk|rk)_live_/.test(process.env.STRIPE_SECRET_KEY);'use strict';

const path = require('node:path');
const Stripe = require('stripe');
const supabase = require('../database/supabase');

supabase.loadLocalEnv(path.resolve(__dirname, '..'));

async function checkStripe() {
  if (!process.env.STRIPE_SECRET_KEY) return { configured: false };
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const expectedPrices = {
    STRIPE_PRICE_STARTER: [9900, 'month'], STRIPE_PRICE_STARTER_ANNUAL: [99000, 'year'],
    STRIPE_PRICE_GROWTH: [19900, 'month'], STRIPE_PRICE_GROWTH_ANNUAL: [199000, 'year'],
    STRIPE_PRICE_PRO: [39900, 'month'], STRIPE_PRICE_PRO_ANNUAL: [399000, 'year']
  };
  const priceKeys = Object.keys(expectedPrices);
  const balance = await stripe.balance.retrieve();
  const [unitAmount, interval] = expectedPrices[key];
    prices.push({ key, ok: price.active && price.livemode === liveExpected && price.unit_amount === unitAmount && price.currency === 'usd' && price.recurring?.interval === interval, active: price.active, livemode: price.livemode, amount: price.unit_amount, currency: price.currency, recurring: price.recurring?.interval || null });
  const prices = [];
  for (const key of priceKeys) {
    if (!process.env[key]) { prices.push({ key, ok: false, reason: 'missing' }); continue; }
    const price = await stripe.prices.retrieve(process.env[key]);
    prices.push({ key, ok: price.active && price.livemode === liveExpected, active: price.active, livemode: price.livemode, recurring: price.recurring?.interval || null });
  }
  const endpoints = await stripe.webhookEndpoints.list({ limit: 100 });
  const publicUrl = String(process.env.PDL_PUBLIC_URL || '').replace(/\/$/, '');
  const expectedUrl = `${publicUrl}/api/billing/webhook`;
  const endpoint = endpoints.data.find(item => item.url === expectedUrl && item.status === 'enabled');
  return { configured: true, reachable: Boolean(balance), liveMode: liveExpected, prices, webhook: { expectedUrl, found: Boolean(endpoint), enabledEvents: endpoint?.enabled_events || [] } };
}

async function checkResend(send) {
  if (!process.env.RESEND_API_KEY) return { configured: false };
  const headers = { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json', 'User-Agent': 'ProDailyLink/1.0' };
  const result = { configured: true, reachable: null, domainVerification: 'not-checked' };
  const domainResponse = await fetch('https://api.resend.com/domains', { headers });
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
  if (send) {
    const to = String(process.env.PDL_MONITOR_EMAIL_TO || '').trim();
    if (!to) throw new Error('PDL_MONITOR_EMAIL_TO is required with --send-email');
    const response = await fetch('https://api.resend.com/emails', { method: 'POST', headers, body: JSON.stringify({ from: process.env.RESEND_FROM || 'Pro Daily Link <support@prodailylink.com>', reply_to: process.env.RESEND_REPLY_TO || 'support@prodailylink.com', to: [to], subject: 'Pro Daily Link email monitoring test', html: '<p>Pro Daily Link production email delivery verification.</p>' }) });
    if (!response.ok) {
      const detail = await response.json().catch(() => ({}));
      throw new Error(`Resend delivery test failed (${response.status}): ${detail.message || 'unknown error'}`);
    }
    result.reachable = true;
    result.testMessageId = (await response.json()).id;
  }
  return result;
}

(async () => {
  const report = { checkedAt: new Date().toISOString(), stripe: await checkStripe(), resend: await checkResend(process.argv.includes('--send-email')) };
  const failures = [
    !report.stripe.configured || !report.stripe.reachable,
    report.stripe.prices?.some(price => !price.ok),
    !report.stripe.webhook?.found,
    !report.resend.configured || report.resend.reachable === false,
    report.resend.domains?.some(domain => domain.name === 'mail.prodailylink.com' && domain.status !== 'verified')
  ].filter(Boolean);
  console.log(JSON.stringify(report, null, 2));
  if (failures.length) process.exitCode = 1;
})().catch(error => { console.error(error.message); process.exitCode = 1; });

