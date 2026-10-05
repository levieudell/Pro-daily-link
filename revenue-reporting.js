'use strict';
// Read-only Stripe reporting. No Stripe object is created or changed here.
const Stripe = require('stripe');
const API_VERSION = '2026-08-26.dahlia';
const DAY = 86400000;
const ZERO_DECIMAL = new Set('bif clp djf gnf jpy kmf krw mga pyg rwf vnd vuv xaf xof xpf'.split(' '));
const THREE_DECIMAL = new Set(['bhd', 'jod', 'kwd', 'omr', 'tnd']);
const CASH_CATEGORIES = new Set(['charge', 'partial_capture_reversal', 'charge_failure', 'refund', 'refund_failure']);
class ReportError extends Error { constructor(code) { super(code); this.code = code; } }
const objectId = value => typeof value === 'string' ? value : value?.id || null;
function currencyCode(value) { if (typeof value !== 'string' || !/^[a-z]{3}$/.test(value)) throw new ReportError('invalid_data'); return value; }
function minorUnitExponent(currency) { return ZERO_DECIMAL.has(currency) ? 0 : THREE_DECIMAL.has(currency) ? 3 : 2; }
function amount(value) { if (!Number.isSafeInteger(value)) throw new ReportError('invalid_data'); return value; }
function add(row, key, value) { row[key] += value; if (!Number.isFinite(row[key]) || Math.abs(row[key]) > Number.MAX_SAFE_INTEGER) throw new ReportError('invalid_data'); }
function parsePeriod(params = {}, now = new Date()) {
  const today = now.toISOString().slice(0, 10), startDate = params.start || today.slice(0, 7) + '-01', endDate = params.end || today;
  const parse = value => {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new ReportError('invalid_period');
    const result = Date.parse(value + 'T00:00:00.000Z');
    if (!Number.isFinite(result) || new Date(result).toISOString().slice(0, 10) !== value) throw new ReportError('invalid_period');
    return result;
  };
  const start = parse(startDate), end = parse(endDate) + DAY;
  if (startDate < '2000-01-01' || start > end - DAY || endDate > today || end - start > 366 * DAY) throw new ReportError('invalid_period');
  const until = Math.min(end, Math.floor(now.valueOf() / 1000) * 1000);
  return { startDate, endDate, timezone: 'UTC', startInclusive: new Date(start).toISOString(), endExclusive: new Date(until).toISOString(), created: { gte: start / 1000, lt: until / 1000 } };
}
function safePeriod(period) { const { created, ...rest } = period; return rest; }
function companyResolver(companies) {
  const customers = new Map(), subscriptions = new Map(), known = new Map();
  const index = (map, id, company) => { if (!id) return; if (!map.has(id)) map.set(id, new Set()); map.get(id).add(String(company.id)); };
  for (const company of companies) {
    if (!company?.id) continue;
    known.set(String(company.id), { id: String(company.id), name: String(company.name || 'Company'), linked: true });
    index(customers, company.stripeCustomerId, company); index(subscriptions, company.stripeSubscriptionId, company);
  }
  return (customer, subscription) => {
    const matches = new Set([...(customers.get(objectId(customer)) || []), ...(subscriptions.get(objectId(subscription)) || [])]);
    return matches.size === 1 ? known.get([...matches][0]) : { id: null, name: 'Unmatched Stripe activity', linked: false };
  };
}
function cashBucket(map, currency) {
  currencyCode(currency);
  if (!map.has(currency)) map.set(currency, { currency, minorUnitExponent: minorUnitExponent(currency), receiptsMinor: 0, paymentReversalsMinor: 0, refundDebitsMinor: 0, refundReversalsMinor: 0, netBeforeFeesMinor: 0 });
  return map.get(currency);
}
function recurringBucket(map, currency) {
  currencyCode(currency);
  if (!map.has(currency)) map.set(currency, { currency, minorUnitExponent: minorUnitExponent(currency), grossMrrMinor: 0, pastDueMrrMinor: 0, annualSubscriptionCount: 0, subscriptionCount: 0 });
  return map.get(currency);
}
function applyCash(row, category, value) {
  if (category === 'charge') add(row, 'receiptsMinor', value);
  else if (category === 'partial_capture_reversal' || category === 'charge_failure') add(row, 'paymentReversalsMinor', value);
  else if (category === 'refund') add(row, 'refundDebitsMinor', -value);
  else if (category === 'refund_failure') add(row, 'refundReversalsMinor', value);
  add(row, 'netBeforeFeesMinor', value);
}
const sortedBuckets = map => [...map.values()].sort((a, b) => a.currency.localeCompare(b.currency));
const roundedRecurring = map => sortedBuckets(map).map(row => ({ ...row, grossMrrMinor: Math.round(row.grossMrrMinor), pastDueMrrMinor: Math.round(row.pastDueMrrMinor) }));
function createRevenueReporter({ getSecret = () => process.env.STRIPE_SECRET_KEY, createClient = secret => new Stripe(secret, { apiVersion: API_VERSION, timeout: 5000, maxNetworkRetries: 0, telemetry: false }), now = () => new Date(), maxRequests = 80, maxDurationMs = 20000, cacheMs = 60000 } = {}) {
  const cache = new Map(), inflight = new Map(), operations = new Set();
  let currentSecret;
  async function build(client, period, companies, snapshot, mode, lifecycle) {
    let requests = 0;
    async function request(fn) {
      try {
        lifecycle.check(); if (++requests > maxRequests) throw new ReportError('incomplete');
        const result = await fn({ timeout: Math.max(1, Math.min(5000, lifecycle.deadline - Date.now())), maxNetworkRetries: 0 });
        lifecycle.check(); return result;
      } catch (error) { lifecycle.stop(error); throw error; }
    }
    async function list(fn, params = {}) {
      const rows = new Map(), cursors = new Set(); let cursor;
      for (;;) {
        const page = await request(options => fn({ ...params, limit: 100, ...(cursor ? { starting_after: cursor } : {}) }, options));
        if (!page || !Array.isArray(page.data) || typeof page.has_more !== 'boolean') throw new ReportError('invalid_data');
        for (const row of page.data) { if (!row?.id || typeof row.id !== 'string') throw new ReportError('invalid_data'); if (!rows.has(row.id)) rows.set(row.id, row); }
        if (!page.has_more) return [...rows.values()];
        cursor = page.data.at(-1)?.id;
        if (!cursor || cursors.has(cursor)) throw new ReportError('incomplete'); cursors.add(cursor);
      }
    }
    const guarded = promise => promise.catch(error => { lifecycle.stop(error); throw error; });
    const lists = await Promise.allSettled([
      list((params, options) => client.balanceTransactions.list(params, options), { created: period.created, expand: ['data.source'] }),
      list((params, options) => client.charges.list(params, options), { created: period.created }),
      list((params, options) => client.refunds.list(params, options), { created: period.created }),
      list((params, options) => client.subscriptions.list(params, options), { status: 'all', created: { lt: Math.floor(snapshot.valueOf() / 1000) } })
    ].map(guarded));
    const failed = lists.find(result => result.status === 'rejected'); if (failed) throw failed.reason;
    const [transactions, charges, refunds, subscriptions] = lists.map(result => result.value);
    const cash = new Map(), recurring = new Map(), companiesById = new Map(), resolveCompany = companyResolver(companies);
    const chargeById = new Map(charges.map(row => [row.id, row])), refundById = new Map(refunds.map(row => [row.id, row])), activity = [];
    const coverage = { excludedSubscriptionItems: 0, unmatchedActivity: 0, otherBalanceTransactions: 0, activityTotal: 0, activityLimit: 100 };
    const refundStatuses = { succeeded: 0, pending: 0, failed: 0, canceled: 0, requires_action: 0, unknown: 0 }; let failedCount = 0;
    const companySummary = company => { const key = company.id || ''; if (!companiesById.has(key)) companiesById.set(key, { ...company, cash: new Map(), recurring: new Map(), failedPaymentCount: 0 }); return companiesById.get(key); };
    async function chargeFor(id) { if (!id || !/^(ch|py)_/.test(id)) return null; if (!chargeById.has(id)) chargeById.set(id, await request(options => client.charges.retrieve(id, {}, options))); return chargeById.get(id); }
    async function sourceFor(transaction) {
      const source = transaction.source; if (source && typeof source === 'object') return source;
      const id = objectId(source); if (!id) return null;
      if (/^(ch|py)_/.test(id)) return chargeFor(id);
      if (/^(re|pyr)_/.test(id)) { if (!refundById.has(id)) refundById.set(id, await request(options => client.refunds.retrieve(id, {}, options))); return refundById.get(id); }
      return null;
    }
    const inPeriod = row => { if (!Number.isSafeInteger(row.created)) throw new ReportError('invalid_data'); return row.created >= period.created.gte && row.created < period.created.lt; };
    function addActivity(row, company, type, value, status) {
      if (!company.linked) coverage.unmatchedActivity++;
      activity.push({ id: row.id, type, date: new Date(row.created * 1000).toISOString(), amountMinor: value, currency: currencyCode(row.currency), minorUnitExponent: minorUnitExponent(row.currency), companyId: company.id, name: company.name, status: String(status || 'unknown') });
    }
    for (const transaction of transactions) {
      lifecycle.check(); if (!inPeriod(transaction)) continue;
      const category = transaction.reporting_category;
      if (!CASH_CATEGORIES.has(category)) { coverage.otherBalanceTransactions++; continue; }
      const value = amount(transaction.amount);
      if ((['charge', 'refund_failure'].includes(category) && value < 0) || (['refund', 'charge_failure', 'partial_capture_reversal'].includes(category) && value > 0)) throw new ReportError('invalid_data');
      const source = await sourceFor(transaction), charge = source?.object === 'charge' || /^(ch|py)_/.test(source?.id || '') ? source : await chargeFor(objectId(source?.charge));
      const company = resolveCompany(charge?.customer, null);
      applyCash(cashBucket(cash, transaction.currency), category, value); applyCash(cashBucket(companySummary(company).cash, transaction.currency), category, value);
      addActivity(transaction, company, category, value, source?.status || transaction.status);
    }
    for (const charge of charges) {
      if (!inPeriod(charge) || charge.status !== 'failed') continue;
      const company = resolveCompany(charge.customer, null); failedCount++; companySummary(company).failedPaymentCount++;
      addActivity(charge, company, 'failed_payment_attempt', amount(charge.amount), 'failed');
    }
    for (const refund of refunds) if (inPeriod(refund) && refund.reason !== 'partial_capture') refundStatuses[Object.hasOwn(refundStatuses, refund.status) ? refund.status : 'unknown']++;
    for (const subscription of subscriptions) {
      lifecycle.check(); if (!['active', 'past_due'].includes(subscription.status)) continue;
      if (subscription.trial_end && subscription.trial_end > snapshot.valueOf() / 1000) continue;
      const company = resolveCompany(subscription.customer, subscription.id);
      const items = subscription.items?.has_more ? await list((params, options) => client.subscriptionItems.list(params, options), { subscription: subscription.id }) : subscription.items?.data;
      if (!Array.isArray(items)) throw new ReportError('invalid_data');
      const subscriptionCurrencies = new Set(), annualCurrencies = new Set(), seenItems = new Set();
      for (const item of items) {
        if (!item?.id || typeof item.id !== 'string') throw new ReportError('invalid_data'); if (seenItems.has(item.id)) continue; seenItems.add(item.id);
        const price = item.price, billing = price?.recurring, taxRates = item.tax_rates?.length ? item.tax_rates : subscription.default_tax_rates || [];
        const taxKnown = Array.isArray(taxRates) && taxRates.every(rate => rate && typeof rate === 'object' && rate.inclusive === false) && (!subscription.automatic_tax?.enabled || price?.tax_behavior === 'exclusive');
        const eligible = price && subscription.currency === price.currency && taxKnown && billing?.usage_type === 'licensed' && ['month', 'year'].includes(billing.interval) && Number.isSafeInteger(billing.interval_count) && billing.interval_count > 0 && price.billing_scheme === 'per_unit' && !price.transform_quantity && price.tax_behavior !== 'inclusive' && !item.current_period_trial_end && !item.trial_end && Number.isSafeInteger(item.quantity) && item.quantity >= 0;
        const unitAmount = price?.unit_amount_decimal != null ? Number(price.unit_amount_decimal) : price?.unit_amount;
        if (!eligible || !Number.isFinite(unitAmount) || unitAmount < 0 || subscription.pause_collection) { coverage.excludedSubscriptionItems++; continue; }
        const value = unitAmount * item.quantity / (billing.interval_count * (billing.interval === 'year' ? 12 : 1));
        if (!Number.isFinite(value) || value > Number.MAX_SAFE_INTEGER) throw new ReportError('invalid_data');
        const currency = currencyCode(price.currency);
        for (const bucket of [recurringBucket(recurring, currency), recurringBucket(companySummary(company).recurring, currency)]) { add(bucket, 'grossMrrMinor', value); if (subscription.status === 'past_due') add(bucket, 'pastDueMrrMinor', value); }
        subscriptionCurrencies.add(currency); if (billing.interval === 'year') annualCurrencies.add(currency);
      }
      for (const currency of subscriptionCurrencies) for (const bucket of [recurringBucket(recurring, currency), recurringBucket(companySummary(company).recurring, currency)]) { bucket.subscriptionCount++; if (annualCurrencies.has(currency)) bucket.annualSubscriptionCount++; }
      if (subscriptionCurrencies.size && !company.linked) coverage.unmatchedActivity++;
    }
    activity.sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id)); coverage.activityTotal = activity.length;
    const warnings = [];
    if (coverage.unmatchedActivity) warnings.push('Some Stripe activity is not uniquely linked to a company. Unmatched activity remains included in the totals.');
    if (coverage.excludedSubscriptionItems) warnings.push('Some subscription items are excluded from estimated gross MRR because their pricing, currency, pause, tax, or trial configuration is not supported.');
    if (coverage.otherBalanceTransactions) warnings.push('Other Stripe balance entries are excluded, including fees, disputes, payouts, transfers, and adjustments.');
    return { status: 'ready', mode, asOf: snapshot.toISOString(), period: safePeriod(period), cash: sortedBuckets(cash), recurring: roundedRecurring(recurring), failedPayments: { count: failedCount }, refundStatuses, coverage, warnings, companies: [...companiesById.values()].map(row => ({ ...row, cash: sortedBuckets(row.cash), recurring: roundedRecurring(row.recurring) })).sort((a, b) => Number(b.linked) - Number(a.linked) || a.name.localeCompare(b.name)), activity: activity.slice(0, coverage.activityLimit) };
  }
  return async function report(params, getCompanies) {
    const snapshot = now(); let period;
    try { period = parsePeriod(params, snapshot); } catch { return { status: 'error', code: 'invalid_period', message: 'Choose valid UTC dates, no later than today, within a 366-day range.' }; }
    const secret = getSecret();
    if (secret !== currentSecret) { for (const operation of operations) operation.abort(new ReportError('credential_changed')); cache.clear(); inflight.clear(); currentSecret = secret; }
    if (!secret) return { status: 'unconfigured', period: safePeriod(period), message: 'Stripe reporting is not configured on this server. No payment totals are available.' };
    const key = `${period.startDate}:${period.endDate}`, cached = cache.get(key);
    if (cached && Date.now() - cached.at < cacheMs) return cached.report; if (inflight.has(key)) return inflight.get(key);
    if (inflight.size >= 2) return { status: 'error', code: 'busy', message: 'Other reports are still loading. Please retry shortly.' };
    const pending = (async () => {
      const controller = new AbortController(), deadline = Date.now() + maxDurationMs; let stopped;
      operations.add(controller); const timer = setTimeout(() => controller.abort(new ReportError('incomplete')), maxDurationMs);
      const check = () => { if (getSecret() !== secret) throw new ReportError('credential_changed'); if (controller.signal.aborted) throw controller.signal.reason; if (stopped) throw stopped; if (Date.now() >= deadline) throw new ReportError('incomplete'); };
      const cancelled = new Promise((resolve, reject) => controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true }));
      try {
        const work = (async () => { const companies = await getCompanies({ signal: controller.signal }); check(); const client = createClient(secret); const result = await build(client, period, companies, snapshot, /_live_/.test(secret) ? 'live' : /_test_/.test(secret) ? 'test' : 'unknown', { controller, deadline, check, stop: error => { stopped ||= error; } }); check(); return result; })();
        const result = await Promise.race([work, cancelled]); check(); cache.set(key, { at: Date.now(), report: result }); while (cache.size > 4) cache.delete(cache.keys().next().value); return result;
      } catch (error) {
        controller.abort(error); const incomplete = error instanceof ReportError && error.code === 'incomplete';
        return { status: 'error', code: incomplete ? 'incomplete' : 'unavailable', period: safePeriod(period), message: incomplete ? 'The report reached its safe read limit. No partial totals are shown. Try a smaller date range; large subscription lists may also exceed the limit.' : 'Stripe reporting could not be loaded. No payment totals are available. Check the existing server connection and read permissions, then retry.' };
      } finally { clearTimeout(timer); operations.delete(controller); }
    })();
    inflight.set(key, pending); try { return await pending; } finally { if (inflight.get(key) === pending) inflight.delete(key); }
  };
}
module.exports = { createRevenueReporter, parsePeriod, minorUnitExponent, companyResolver, API_VERSION };
