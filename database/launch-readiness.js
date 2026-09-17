const path = require('node:path');
const supabase = require('./supabase');

supabase.loadLocalEnv(path.resolve(__dirname, '..'));

const checks = [
  ['Production mode', process.env.NODE_ENV === 'production', 'NODE_ENV=production'],
  ['Authentication enforcement', process.env.PDL_REQUIRE_AUTH === '1', 'PDL_REQUIRE_AUTH=1'],
  ['Supabase enabled', process.env.PDL_SUPABASE_ENABLED === '1', 'PDL_SUPABASE_ENABLED=1'],
  ['Supabase credentials', Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SECRET_KEY), 'SUPABASE_URL and SUPABASE_SECRET_KEY'],
  ['Public HTTPS URL', /^https:\/\//.test(process.env.PDL_PUBLIC_URL || ''), 'PDL_PUBLIC_URL=https://...'],
  ['Stripe secret', Boolean(process.env.STRIPE_SECRET_KEY), 'STRIPE_SECRET_KEY'],
  ['Stripe webhook verification', Boolean(process.env.STRIPE_WEBHOOK_SECRET), 'STRIPE_WEBHOOK_SECRET'],
  ['Stripe plan prices', ['STRIPE_PRICE_STARTER','STRIPE_PRICE_GROWTH','STRIPE_PRICE_PRO'].every(key => process.env[key]), 'all three STRIPE_PRICE_* values'],
  ['Password-reset email', Boolean(process.env.RESEND_API_KEY && process.env.RESEND_FROM), 'RESEND_API_KEY and RESEND_FROM'],
  ['AI extraction', Boolean(process.env.OPENAI_API_KEY), 'OPENAI_API_KEY'],
  ['Error monitoring', Boolean(process.env.SENTRY_DSN), 'SENTRY_DSN']
];

(async () => {
  const cloud = await supabase.health();
  checks.push(['Supabase reachable', cloud.configured && cloud.reachable, 'working Supabase connection']);
  const required = new Set(['Production mode','Authentication enforcement','Supabase enabled','Supabase credentials','Public HTTPS URL','Supabase reachable']);
  for (const [name, ok, help] of checks) console.log(`${ok ? 'PASS' : required.has(name) ? 'FAIL' : 'TODO'}  ${name}${ok ? '' : ` — configure ${help}`}`);
  const failures = checks.filter(([name, ok]) => required.has(name) && !ok);
  const optional = checks.filter(([name, ok]) => !required.has(name) && !ok);
  console.log(`\n${failures.length ? 'NOT READY' : optional.length ? 'PILOT READY' : 'PUBLIC LAUNCH READY'}: ${failures.length} blocking, ${optional.length} launch-service item(s) remaining.`);
  process.exitCode = failures.length ? 1 : 0;
})().catch(error => { console.error(`FAIL  Readiness check — ${error.message}`); process.exitCode = 1; });
