'use strict';

const path = require('node:path');
const Stripe = require('stripe');
const supabase = require('../database/supabase');

supabase.loadLocalEnv(path.resolve(__dirname, '..'));

async function checkStripe() {
  if (!process.env.STRIPE_SECRET_KEY) return { configured: false };
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const liveExpected = process.env.STRIPE_SECRET_KEY.startsWith('sk_live_');
  const balance = await stripe.balance.retrieve();
  const priceKeys = ['STRIPE_PRICE_STARTER','STRIPE_PRICE_STARTER_ANNUAL','STRIPE_PRICE_GROWTH','STRIPE_PRICE_GROWTH_ANNUAL','STRIPE_PRICE_PRO','STRIPE_PRICE_PRO_ANNUAL'];
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
  const domainResponse = await fetch('https://api.resend.com/domains', { headers });
  if (!domainResponse.ok) throw new Error(`Resend domain check failed (${domainResponse.status})`);
  const domains = (await domainResponse.json()).data || [];
  const result = { configured: true, reachable: true, domains: domains.map(domain => ({ name: domain.name, status: domain.status })) };
  if (send) {
    const to = String(process.env.PDL_MONITOR_EMAIL_TO || '').trim();
    if (!to) throw new Error('PDL_MONITOR_EMAIL_TO is required with --send-email');
    const response = await fetch('https://api.resend.com/emails', { method: 'POST', headers, body: JSON.stringify({ from: process.env.RESEND_FROM || 'Pro Daily Link <support@prodailylink.com>', reply_to: process.env.RESEND_REPLY_TO || 'support@prodailylink.com', to: [to], subject: 'Pro Daily Link email monitoring test', html: '<p>Pro Daily Link production email delivery verification.</p>' }) });
    if (!response.ok) throw new Error(`Resend delivery test failed (${response.status})`);
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
    !report.resend.configured || !report.resend.reachable,
    report.resend.domains?.some(domain => domain.name === 'prodailylink.com' && domain.status !== 'verified')
  ].filter(Boolean);
  console.log(JSON.stringify(report, null, 2));
  if (failures.length) process.exitCode = 1;
})().catch(error => { console.error(error.message); process.exitCode = 1; });


