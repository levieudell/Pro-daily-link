'use strict';
const path = require('node:path');
const supabase = require('./supabase');
const STANDARD_PRICES = ['STARTER', 'GROWTH', 'PRO'].flatMap(plan =>
  [`STRIPE_PRICE_${plan}`, `STRIPE_PRICE_${plan}_ANNUAL`]);

function checksFor(env, cloud) {
  const present = key => Boolean(String(env[key] || '').trim());
  let https = false;
  try {
    const url = new URL(env.PDL_PUBLIC_URL);
    https = url.protocol === 'https:' && Boolean(url.hostname) && !url.username && !url.password;
  } catch {}
  const checks = [
    ['Production mode', env.NODE_ENV === 'production', 'NODE_ENV=production'],
    ['Authentication enforcement', env.PDL_REQUIRE_AUTH === '1', 'PDL_REQUIRE_AUTH=1'],
    ['Supabase enabled', env.PDL_SUPABASE_ENABLED === '1', 'PDL_SUPABASE_ENABLED=1'],
    ['Supabase credentials', present('SUPABASE_URL') && present('SUPABASE_SECRET_KEY'), 'SUPABASE_URL and SUPABASE_SECRET_KEY'],
    ['Public HTTPS URL', https, 'valid PDL_PUBLIC_URL=https://... without embedded credentials'],
    ['Supabase reachable', cloud.configured === true && cloud.reachable === true, 'working Supabase connection'],
    ['Stripe secret', present('STRIPE_SECRET_KEY'), 'STRIPE_SECRET_KEY'],
    ['Stripe webhook verification', present('STRIPE_WEBHOOK_SECRET'), 'STRIPE_WEBHOOK_SECRET'],
    ['Stripe plan prices', STANDARD_PRICES.every(present), 'all six monthly and annual STRIPE_PRICE_* values'],
    ['Password-reset email', present('RESEND_API_KEY') && present('RESEND_FROM'), 'RESEND_API_KEY and RESEND_FROM'],
    ['AI extraction', present('OPENAI_API_KEY'), 'OPENAI_API_KEY'],
    ['Error monitoring', present('SENTRY_DSN'), 'SENTRY_DSN']
  ];
  if (env.PDL_FOUNDER_ENABLED === '1') checks.push(
    ['Founder invitation', present('PDL_FOUNDER_CODE'), 'PDL_FOUNDER_CODE'],
    ['Founder plan prices', STANDARD_PRICES.map(key => key.replace('STRIPE_PRICE_', 'STRIPE_PRICE_FOUNDER_')).every(present), 'all six monthly and annual STRIPE_PRICE_FOUNDER_* values']
  );
  return checks;
}

async function main({ env = process.env, health = () => supabase.health(), log = console.log } = {}) {
  const checks = checksFor(env, await health());
  for (const [name, ok, help] of checks) log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ` - configure ${help}`}`);
  if (env.PDL_FOUNDER_ENABLED === '1') log(`INFO  Assisted Setup ${String(env.STRIPE_PRICE_ASSISTED_SETUP || '').trim() ? 'configured' : 'unavailable (optional)'}`);
  const failures = checks.filter(([, ok]) => !ok).length;
  log(`\n${failures ? 'CONFIGURATION INCOMPLETE' : 'CONFIGURATION COMPLETE'}: ${failures} item(s) remaining.`);
  log('LAUNCH ACCEPTANCE UNVERIFIED: configuration does not prove email delivery, Stripe mode/prices/webhook lifecycle, founder renewal safeguards, AI output, alert receipt, tenant isolation, or backup restoration.');
  log('Complete and retain acceptance evidence in docs/ROADMAP-STATUS-2026-10-04.md before approving a public launch.');
  return failures ? 1 : 0;
}

function runCli() {
  supabase.loadLocalEnv(path.resolve(__dirname, '..'));
  return main().then(code => { process.exitCode = code; }).catch(() => {
    console.error('FAIL  Configuration check could not complete. Verify provider connectivity privately; no launch readiness result was established.');
    process.exitCode = 1;
  });
}
if (require.main === module) runCli();
module.exports = { checksFor, main, runCli, STANDARD_PRICES };
