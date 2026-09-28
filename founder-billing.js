const crypto = require('node:crypto');

// No keys, invitation codes, or live price IDs are stored in source.
const PRICES = Object.freeze({
  starter: { monthly: 79, annual: 790 },
  growth: { monthly: 159, annual: 1590 },
  pro: { monthly: 319, annual: 3190 },
});
function fail(message, statusCode = 400) { return Object.assign(new Error(message), { statusCode }); }
function enabled(env = process.env) { return env.PDL_FOUNDER_ENABLED === '1'; }
function priceKey(plan, cycle, founder = false) {
  if (!PRICES[plan] || !['monthly', 'annual'].includes(cycle)) throw fail('Choose a valid plan and billing period.');
  return 'STRIPE_PRICE_' + (founder ? 'FOUNDER_' : '') + plan.toUpperCase() + (cycle === 'annual' ? '_ANNUAL' : '');
}
function validCode(code, env = process.env) {
  if (!enabled(env) || !env.PDL_FOUNDER_CODE || typeof code !== 'string' || code.length > 128) return false;
  const digest = value => crypto.createHash('sha256').update(value.trim().toUpperCase()).digest();
  return crypto.timingSafeEqual(digest(code), digest(env.PDL_FOUNDER_CODE));
}
function offer(env = process.env) {
  return { enabled: enabled(env), prices: PRICES, setupPrice: 499, protectionMonths: 24,
    setupAvailable: enabled(env) && Boolean(env.STRIPE_PRICE_ASSISTED_SETUP),
    termsVersion: 'founder-2026-09-28' };
}
function enroll(input, env = process.env) {
  if (!String(input.founderCode || '').trim()) return null;
  if (!validCode(input.founderCode, env)) throw fail('This founder invitation code is invalid or unavailable.');
  if (input.founderTermsAccepted !== true) throw fail('Accept the founder payment and renewal terms to continue.');
  const cycle = input.billingCycle === 'annual' ? 'annual' : 'monthly';
  if (!PRICES[input.plan]) throw fail('Choose a valid founder plan.');
  if (!env.STRIPE_SECRET_KEY || !env.STRIPE_WEBHOOK_SECRET ||
      !env[priceKey(input.plan, cycle, true)] || !env[priceKey(input.plan, cycle)]) {
    throw fail('Founder checkout is not connected yet. Please contact support.', 503);
  }
  if (input.assistedSetup === true && !env.STRIPE_PRICE_ASSISTED_SETUP) throw fail('Assisted Setup is not connected yet.', 503);
  return { requested: true, plan: input.plan, billingCycle: cycle,
    assistedSetup: input.assistedSetup === true, termsVersion: 'founder-2026-09-28',
    acceptedAt: new Date().toISOString() };
}
function isFounder(company) { return company.founder?.requested === true; }
function checkout(company, input, env = process.env) {
  const founder = isFounder(company), cycle = input.billingCycle === 'annual' ? 'annual' : 'monthly';
  if (company.stripeSubscriptionId) throw fail('Use Manage billing for an existing subscription.', 409);
  if (founder && !enabled(env)) throw fail('Founder checkout is temporarily unavailable.', 503);
  if (founder && (input.plan !== company.founder.plan || cycle !== company.founder.billingCycle)) {
    throw fail('Continue with the founder plan and billing period selected at signup.');
  }
  const priceId = env[priceKey(input.plan, cycle, founder)];
  if (!priceId) throw fail('The selected billing price is not connected.', 503);
  const setup = founder && company.founder.assistedSetup;
  if (setup && !env.STRIPE_PRICE_ASSISTED_SETUP) throw fail('Assisted Setup is not connected.', 503);
  return { priceId, founder, setup, cycle, amount: founder ? PRICES[input.plan][cycle] : null };
}
function identify(priceId, plans, env = process.env) {
  if (!priceId) return null;
  for (const plan of Object.keys(plans)) for (const cycle of ['monthly', 'annual']) {
    for (const founder of [false, true]) if (env[priceKey(plan, cycle, founder)] === priceId) {
      return { plan, cycle, founder, amount: founder ? PRICES[plan][cycle] : cycle === 'annual' ? plans[plan].annualPrice : plans[plan].price };
    }
  }
  return null;
}
function addMonths(timestamp, months) {
  const date = new Date(timestamp * 1000), day = date.getUTCDate();
  date.setUTCDate(1); date.setUTCMonth(date.getUTCMonth() + months);
  const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth()+1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, last));
  return Math.floor(date.valueOf()/1000);
}
async function validatePrice(stripeRequest, id, amount, cycle, env = process.env) {
  const price = await stripeRequest('/prices/' + encodeURIComponent(id), null, 'GET');
  const live = /^(sk|rk)_live_/.test(env.STRIPE_SECRET_KEY || '');
  if (price.id !== id || price.active !== true || price.livemode !== live ||
      price.currency !== 'usd' || price.unit_amount !== amount * 100 ||
      (cycle ? price.type !== 'recurring' || price.recurring?.interval !== (cycle === 'annual' ? 'year' : 'month') || price.recurring?.interval_count !== 1 : price.type !== 'one_time')) {
    throw fail('Stripe price configuration does not match this offer. Contact support.', 503);
  }
}
async function prepareSubscription(db, subscription, plans, stripeRequest, env = process.env) {
  const info = identify(subscription.items?.data?.[0]?.price?.id, plans, env);
  if (!info) throw fail('Unrecognized subscription price.', 503);
  if (!info.founder || subscription.status !== 'active') return info;
  if (!isFounder(db.company) || String(subscription.metadata?.company_id) !== String(db.company.id) ||
      subscription.metadata?.offer !== 'founder' ||
      info.plan !== db.company.founder.plan || info.cycle !== db.company.founder.billingCycle) {
    throw fail('Founder subscription does not match the company offer.', 400);
  }
  const invoiceId = typeof subscription.latest_invoice === 'string' ? subscription.latest_invoice : subscription.latest_invoice?.id;
  const invoice = invoiceId ? await stripeRequest('/invoices/' + encodeURIComponent(invoiceId), null, 'GET') : null;
  if (!invoice || invoice.status !== 'paid') throw fail('Waiting for confirmed founder payment.', 409);
  const standardPrice = env[priceKey(info.plan, info.cycle)];
  await validatePrice(stripeRequest, standardPrice, info.cycle === 'annual' ? plans[info.plan].annualPrice : plans[info.plan].price, info.cycle, env);
  let scheduleId = typeof subscription.schedule === 'string' ? subscription.schedule : subscription.schedule?.id;
  let schedule = scheduleId ? await stripeRequest('/subscription_schedules/' + encodeURIComponent(scheduleId), null, 'GET') :
    await stripeRequest('/subscription_schedules', { from_subscription: subscription.id }, 'POST', 'founder-schedule-' + subscription.id);
  const start = schedule.phases?.[0]?.start_date || schedule.current_phase?.start_date;
  if (!Number.isFinite(start)) throw fail('Founder renewal schedule could not be verified.', 503);
  const end = addMonths(start, 24);
  if (schedule.metadata?.pdl_founder_configured !== '1') {
    schedule = await stripeRequest('/subscription_schedules/' + encodeURIComponent(schedule.id), {
      end_behavior: 'release', proration_behavior: 'none',
      'metadata[pdl_founder_configured]': '1', 'metadata[company_id]': db.company.id,
      'phases[0][start_date]': start, 'phases[0][end_date]': end,
      'phases[0][items][0][price]': subscription.items.data[0].price.id,
      'phases[0][items][0][quantity]': 1, 'phases[0][proration_behavior]': 'none',
      'phases[1][start_date]': end, 'phases[1][end_date]': addMonths(end, info.cycle === 'annual' ? 12 : 1),
      'phases[1][items][0][price]': standardPrice,
      'phases[1][items][0][quantity]': 1, 'phases[1][proration_behavior]': 'none'
    }, 'POST', 'founder-phases-' + subscription.id);
  }
  db.company.founder = { ...db.company.founder, scheduleId: schedule.id,
    startsAt: new Date(start*1000).toISOString(), protectedUntil: new Date(end*1000).toISOString(),
    paidAt: db.company.founder.paidAt || new Date().toISOString() };
  db.company.accountType = 'early_adopter'; db.company.cohort = 'founder-2026';
  return info;
}
module.exports = { validatePrice, prepareSubscription, PRICES, enabled, priceKey, validCode, offer, enroll, isFounder, checkout, identify, addMonths, fail };
