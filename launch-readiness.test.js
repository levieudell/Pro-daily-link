'use strict';
const assert = require('node:assert/strict');
const { checksFor, main, STANDARD_PRICES } = require('./database/launch-readiness');
const env = {
  NODE_ENV: 'production', PDL_REQUIRE_AUTH: '1', PDL_SUPABASE_ENABLED: '1',
  SUPABASE_URL: 'https://example.invalid', SUPABASE_SECRET_KEY: 'synthetic-private-value',
  PDL_PUBLIC_URL: 'https://example.invalid', STRIPE_SECRET_KEY: 'synthetic-stripe-value',
  STRIPE_WEBHOOK_SECRET: 'synthetic-webhook-value', RESEND_API_KEY: 'synthetic-email-value',
  RESEND_FROM: 'QA <qa@example.invalid>', OPENAI_API_KEY: 'synthetic-ai-value', SENTRY_DSN: 'synthetic-monitor-value'
};
for (const key of STANDARD_PRICES) env[key] = 'synthetic-price';
const cloud = { configured: true, reachable: true };
const check = (values, name) => checksFor(values, cloud).find(row => row[0] === name)[1];
(async () => {
  const output = [];
  assert.equal(await main({ env, health: async () => cloud, log: line => output.push(line) }), 0);
  assert.ok(output.some(line => line.trimStart().startsWith('CONFIGURATION COMPLETE')));
  assert.ok(output.some(line => line.startsWith('LAUNCH ACCEPTANCE UNVERIFIED')));
  assert.ok(!output.some(line => /PUBLIC LAUNCH READY|PILOT READY/.test(line)));
  for (const [key, value] of Object.entries(env)) if (/SECRET|API_KEY|DSN/.test(key)) {
    assert.ok(!output.join('\n').includes(value), `${key} must remain private`);
  }
  for (const key of STANDARD_PRICES) assert.equal(check({ ...env, [key]: '' }, 'Stripe plan prices'), false, key);
  assert.equal(check({ ...env, STRIPE_SECRET_KEY: '   ' }, 'Stripe secret'), false);
  for (const url of ['https://', 'http://example.invalid', 'https://user:password@example.invalid']) {
    assert.equal(check({ ...env, PDL_PUBLIC_URL: url }, 'Public HTTPS URL'), false);
  }
  const founder = { ...env, PDL_FOUNDER_ENABLED: '1' };
  assert.equal(check(founder, 'Founder invitation'), false);
  assert.equal(check(founder, 'Founder plan prices'), false);
  founder.PDL_FOUNDER_CODE = 'synthetic-invite';
  for (const key of STANDARD_PRICES) founder[key.replace('STRIPE_PRICE_', 'STRIPE_PRICE_FOUNDER_')] = 'synthetic-founder-price';
  assert.equal(await main({ env: founder, health: async () => cloud, log: () => {} }), 0);
  for (const key of STANDARD_PRICES) {
    const founderKey = key.replace('STRIPE_PRICE_', 'STRIPE_PRICE_FOUNDER_');
    assert.equal(check({ ...founder, [founderKey]: '' }, 'Founder plan prices'), false, founderKey);
  }
  assert.equal(await main({ env, health: async () => ({ configured: true, reachable: false }), log: () => {} }), 1);
  assert.equal(await main({ env: { ...env, SENTRY_DSN: '' }, health: async () => cloud, log: () => {} }), 1);
  await assert.rejects(main({ env, health: async () => { throw new Error('provider unavailable'); }, log: () => {} }));
  console.log('Launch configuration regression tests passed (mocked providers, no external calls).');
})().catch(error => { console.error(error); process.exitCode = 1; });
