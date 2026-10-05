'use strict';
// Read-only Stripe reporting. The server remains the authority for owner access.
(function () {
  const DAY_MS = 86400000;
  const CASH_FIELDS = [
    ['receiptsMinor', 'Payment receipts'],
    ['paymentReversalsMinor', 'Payment reversals'],
    ['refundDebitsMinor', 'Refund debits'],
    ['refundReversalsMinor', 'Refund reversals'],
    ['netBeforeFeesMinor', 'Payments net movement (before fees)']
  ];
  const REFUND_STATES = [
    ['succeeded', 'Succeeded'], ['pending', 'Pending'], ['failed', 'Failed'],
    ['canceled', 'Canceled'], ['requires_action', 'Requires action'], ['unknown', 'Unknown']
  ];

  function defaultPeriod(now) {
    const today = new Date(now).toISOString().slice(0, 10);
    return { start: today.slice(0, 8) + '01', end: today };
  }
  function dateValue(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return NaN;
    const time = Date.parse(value + 'T00:00:00.000Z');
    return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value ? time : NaN;
  }
  function periodError(start, end) {
    const first = dateValue(start), last = dateValue(end);
    if (!Number.isFinite(first) || !Number.isFinite(last)) return 'Choose valid start and end dates.';
    if (first > last) return 'The start date must be on or before the end date.';
    if ((last - first) / DAY_MS + 1 > 366) return 'Choose a date range of 366 days or fewer, including both dates.';
    return '';
  }
  function money(amount, currency, exponent) {
    const code = String(currency || '').toUpperCase();
    if (!/^[A-Z]{3}$/.test(code) || !Number.isInteger(exponent) || exponent < 0 || exponent > 3 ||
        typeof amount !== 'number' || !Number.isFinite(amount) || Math.abs(amount) > Number.MAX_SAFE_INTEGER) return 'Unavailable';
    // Use the API's Stripe exponent, including ISK/UGX's two-digit representation.
    return code + ' ' + (amount / (10 ** exponent)).toLocaleString('en-US', {
      minimumFractionDigits: exponent, maximumFractionDigits: exponent
    });
  }
  function count(value) { return Number.isSafeInteger(value) && value >= 0 ? value.toLocaleString('en-US') : 'Unavailable'; }
  function timeText(value) {
    const date = new Date(value);
    return value && Number.isFinite(date.valueOf()) ? date.toISOString().replace('T', ' ').slice(0, 19) + ' UTC' : 'Time unavailable';
  }
  function currentOwner(user) { return user?.role === 'platform_owner' && user.revenueAccess === true; }
  function reportErrorMessage(code) {
    // Only recognized codes select local copy. Provider/server messages never reach the UI.
    switch (code) {
      case 'incomplete': return 'The report reached its safe read limit. No partial totals are shown. Try a smaller payment date range. Current subscription limits may still require support.';
      case 'invalid_period': return 'Choose valid UTC start and end dates, no later than today, within a range of 366 days or fewer.';
      case 'busy': return 'Other Stripe reports are still loading. Please retry shortly.';
      default: return 'Stripe reporting is temporarily unavailable. Select Refresh to try again.';
    }
  }
  function validReport(report, start, end) {
    return report?.status === 'ready' && report.period?.startDate === start && report.period?.endDate === end &&
      report.period?.timezone === 'UTC' && ['cash', 'recurring', 'companies', 'activity', 'warnings'].every(key => Array.isArray(report[key]));
  }

  function createRevenueConsole(env) {
    const document = env.document, window = env.window;
    const root = document.getElementById('platform-revenue');
    const view = document.getElementById('subscriptions-view');
    if (!root || !view || root.__pdlRevenueMounted) return null;
    root.__pdlRevenueMounted = true;
    root.hidden = true;
    let sequence = 0, controller = null, controls = null, wasActive = false, revoked = false;
    const dates = defaultPeriod(env.now ? env.now() : Date.now());

    function node(tag, text, className) {
      const item = document.createElement(tag);
      if (text !== undefined) item.textContent = String(text ?? '');
      if (className) item.className = className;
      return item;
    }
    function labeledInput(labelText, id, value) {
      const label = node('label', labelText);
      const input = node('input'); input.type = 'date'; input.id = id; input.value = value; input.required = true;
      input.setAttribute('aria-describedby', 'platform-revenue-period-help');
      label.append(input);
      return { label, input };
    }
    function invalidate() {
      sequence += 1;
      if (controller) controller.abort();
      controller = null;
      if (controls) controls.results.replaceChildren();
      root.setAttribute('aria-busy', 'false');
    }
    function hide() {
      invalidate();
      root.hidden = true;
      root.replaceChildren();
      controls = null;
    }
    function status(text, error) {
      if (!controls) return;
      controls.status.textContent = text;
      controls.status.classList.toggle('is-error', Boolean(error));
    }
    function mount() {
      if (controls) return;
      root.classList.add('platform-revenue');
      root.setAttribute('aria-labelledby', 'platform-revenue-title');
      const heading = node('div', undefined, 'revenue-heading');
      const titleGroup = node('div');
      const eyebrow = node('p', 'OWNER · READ ONLY', 'revenue-eyebrow');
      const title = node('h2', 'Stripe payment activity'); title.id = 'platform-revenue-title';
      titleGroup.append(eyebrow, title, node('p', 'Account-wide payment balance activity and current subscription estimates from Stripe. Company totals are listed in this report.'));
      heading.append(titleGroup);
      const form = node('form', undefined, 'revenue-filters'); form.noValidate = true;
      const start = labeledInput('Start date (UTC)', 'platform-revenue-start', dates.start);
      const end = labeledInput('End date (UTC)', 'platform-revenue-end', dates.end);
      const refresh = node('button', 'Refresh', 'secondary'); refresh.type = 'submit';
      form.append(start.label, end.label, refresh);
      const help = node('p', 'Both dates are included. Maximum 366 days. Date filters apply to payment activity, not the current MRR snapshot.', 'revenue-note');
      help.id = 'platform-revenue-period-help';
      const state = node('p', '', 'revenue-status'); state.setAttribute('role', 'status'); state.setAttribute('aria-live', 'polite'); state.setAttribute('aria-atomic', 'true');
      const results = node('div', undefined, 'revenue-results');
      root.append(heading, form, help, state, results);
      controls = { start: start.input, end: end.input, refresh, status: state, results };
      form.addEventListener('submit', event => { event.preventDefault(); void refreshReport(); });
      for (const input of [start.input, end.input]) input.addEventListener('input', () => {
        dates.start = controls.start.value; dates.end = controls.end.value;
        invalidate();
        status('Dates changed. Select Refresh to load this period.');
      });
    }
    function currencyName(row) { return /^[a-z]{3}$/i.test(String(row?.currency || '')) ? String(row.currency).toUpperCase() : 'Unknown currency'; }
    function amount(row, key) { return money(row?.[key], row?.currency, row?.minorUnitExponent); }
    function definition(list, label, value, emphasized) {
      const pair = node('div', undefined, emphasized ? 'revenue-definition revenue-total' : 'revenue-definition');
      pair.append(node('dt', label), node('dd', value)); list.append(pair);
    }
    function cashCards(rows) {
      const list = node('div', undefined, 'revenue-currency-grid');
      for (const row of rows) {
        const card = node('section', undefined, 'revenue-currency-card');
        card.append(node('h4', currencyName(row)));
        const values = node('dl');
        for (const [key, label] of CASH_FIELDS) definition(values, label, amount(row, key), key === 'netBeforeFeesMinor');
        card.append(values); list.append(card);
      }
      return list;
    }
    function recurringCards(rows) {
      const list = node('div', undefined, 'revenue-currency-grid');
      for (const row of rows) {
        const card = node('section', undefined, 'revenue-currency-card');
        card.append(node('h4', currencyName(row)));
        const values = node('dl');
        definition(values, 'Estimated gross MRR', amount(row, 'grossMrrMinor'), true);
        definition(values, 'Past-due portion of MRR', amount(row, 'pastDueMrrMinor'));
        definition(values, 'Included subscriptions', count(row?.subscriptionCount));
        definition(values, 'Annual subscriptions (normalized ÷ 12)', count(row?.annualSubscriptionCount));
        card.append(values); list.append(card);
      }
      return list;
    }
    function section(title) {
      const result = node('section', undefined, 'revenue-section'); result.append(node('h3', title)); return result;
    }
    function render(report) {
      const result = node('div');
      const meta = node('div', undefined, 'revenue-snapshot');
      const mode = report.mode === 'live' ? 'Live mode' : report.mode === 'test' ? 'Test mode' : 'Mode unknown';
      const badge = node('strong', mode, 'revenue-mode' + (report.mode === 'live' ? '' : ' revenue-mode-caution'));
      meta.append(badge, node('span', 'As of ' + timeText(report.asOf)), node('span', report.period.startDate + ' through ' + report.period.endDate + ' · UTC'));
      result.append(meta);
      if (report.mode !== 'live') result.append(node('p', report.mode === 'test' ?
        'Test mode: these figures are test data.' : 'Stripe mode is unverified. Do not treat these figures as verified live payments.', 'revenue-caution'));
      const cash = section('Payments in the selected period');
      cash.append(node('p', 'Receipts are amounts posted to the Stripe payment balance. Refund debits can include pending refunds; refund reversals are shown separately. Net movement excludes fees, disputes, payouts and other adjustments. These figures are not bank deposits or accounting revenue.', 'revenue-note'));
      cash.append(report.cash.length ? cashCards(report.cash) : node('p', 'No Stripe payment balance activity in this period.', 'revenue-empty'));
      cash.append(node('p', 'Settlement currencies are kept separate; no currency conversion or combined currency total is applied. An annual upfront payment stays at its full amount in payment activity.', 'revenue-note'));
      result.append(cash);
      const recurring = section('Estimated gross MRR');
      recurring.append(node('p', 'Current subscription snapshot, independent of the date filter. Gross before discounts, excluding tax. Includes active and past-due fixed monthly or yearly licensed items. Annual amounts are normalized by dividing by 12. Trials, canceled subscriptions and unsupported items are excluded.', 'revenue-note'));
      recurring.append(report.recurring.length ? recurringCards(report.recurring) : node('p', 'No eligible current recurring subscriptions.', 'revenue-empty'));
      recurring.append(node('p', 'Excluded subscription items: ' + count(report.coverage?.excludedSubscriptionItems) + '. MRR is an estimate, not collected payments. Currency totals and company estimates are rounded independently, so small rounding differences are possible.', 'revenue-note'));
      result.append(recurring);
      const outcomes = section('Payment attempts and refund statuses');
      const failure = node('p', undefined, 'revenue-failed-attempts');
      failure.append(node('strong', count(report.failedPayments?.count) + ' failed payment attempts'));
      outcomes.append(failure, node('p', 'Historical failed charge attempts in the selected period. A later retry may have succeeded. This is not a count of unpaid invoices or unique customers.', 'revenue-note'));
      outcomes.append(node('p', 'Current statuses of refunds created in the selected period, excluding partial-capture adjustments. These counts can differ from payment-balance refund movements when refunds were initiated earlier or reversed later.', 'revenue-note'));
      const refunds = node('dl', undefined, 'revenue-refund-statuses');
      for (const [key, label] of REFUND_STATES) definition(refunds, label, count(report.refundStatuses?.[key]));
      outcomes.append(refunds); result.append(outcomes);
      const companies = section('By company');
      companies.append(node('p', 'Payment movement uses the selected period. MRR remains a current estimate. Unmatched Stripe activity is kept visible rather than assigned to a company.', 'revenue-note'));
      if (!report.companies.length) companies.append(node('p', 'No company payment activity or eligible current subscriptions.', 'revenue-empty'));
      for (const company of report.companies) {
        const card = node('section', undefined, 'revenue-company');
        const head = node('div', undefined, 'revenue-company-heading');
        head.append(node('h4', company?.name || (company?.linked ? 'Unnamed company' : 'Unmatched Stripe activity')),
          node('span', company?.linked ? 'Linked company' : 'Unmatched activity', 'revenue-company-link'));
        card.append(head);
        const cashRows = Array.isArray(company?.cash) ? company.cash : [], mrrRows = Array.isArray(company?.recurring) ? company.recurring : [];
        if (cashRows.length) { card.append(node('h5', 'Stripe payment movement')); card.append(cashCards(cashRows)); }
        else card.append(node('p', 'No payment balance activity in this period.', 'revenue-note'));
        if (mrrRows.length) { card.append(node('h5', 'Current estimated gross MRR')); card.append(recurringCards(mrrRows)); }
        card.append(node('p', 'Failed payment attempts: ' + count(company?.failedPaymentCount), 'revenue-note'));
        companies.append(card);
      }
      result.append(companies);
      const activity = section('Recent Stripe activity');
      const limit = Number.isSafeInteger(report.coverage?.activityLimit) ? Math.min(100, Math.max(0, report.coverage.activityLimit)) : 100;
      const rows = report.activity.slice(0, limit);
      activity.append(node('p', 'Showing ' + rows.length + ' of ' + count(report.coverage?.activityTotal) + ' activity records in this period. Recent activity is limited to 100 records; totals above cover the full selected period.', 'revenue-note'));
      if (!rows.length) activity.append(node('p', 'No Stripe activity in this period.', 'revenue-empty'));
      else {
        const wrap = node('div', undefined, 'revenue-table-scroll'); wrap.tabIndex = 0; wrap.setAttribute('role', 'region'); wrap.setAttribute('aria-label', 'Recent Stripe activity; scroll horizontally for all columns');
        const table = node('table', undefined, 'revenue-table');
        const caption = node('caption', 'Recent Stripe activity in the selected UTC period');
        const head = node('thead'), header = node('tr');
        for (const label of ['Date (UTC)', 'Company', 'Type', 'Amount', 'Status']) { const cell = node('th', label); cell.scope = 'col'; header.append(cell); }
        head.append(header); const body = node('tbody');
        for (const item of rows) {
          const row = node('tr');
          for (const value of [timeText(item?.date), item?.name || 'Unmatched activity', String(item?.type || 'Unknown').replace(/_/g, ' '), amount(item, 'amountMinor'), String(item?.status || 'Unknown').replace(/_/g, ' ')]) row.append(node('td', value));
          body.append(row);
        }
        table.append(caption, head, body); wrap.append(table); activity.append(wrap);
      }
      result.append(activity);
      const coverage = section('Coverage notes');
      coverage.append(node('p', 'Unmatched activity records: ' + count(report.coverage?.unmatchedActivity) + '. Other balance transactions excluded from payment movement: ' + count(report.coverage?.otherBalanceTransactions) + '.', 'revenue-note'));
      if (report.warnings.length) {
        const warnings = node('ul', undefined, 'revenue-warnings');
        for (const warning of report.warnings) if (typeof warning === 'string') warnings.append(node('li', warning));
        coverage.append(warnings);
      }
      result.append(coverage);
      controls.results.replaceChildren(result);
    }
    async function refreshReport() {
      if (revoked || !view.classList.contains('active') || document.visibilityState === 'hidden') return;
      if (controls) { dates.start = controls.start.value; dates.end = controls.end.value; }
      invalidate();
      const error = periodError(dates.start, dates.end);
      if (error) { status(error, true); return; }
      const start = dates.start, end = dates.end, request = sequence;
      const Abort = env.AbortController || window.AbortController;
      controller = new Abort();
      const options = { method: 'GET', credentials: 'include', cache: 'no-store', headers: { Accept: 'application/json' }, signal: controller.signal };
      const current = () => request === sequence && !revoked && view.classList.contains('active') && document.visibilityState !== 'hidden';
      root.setAttribute('aria-busy', 'true');
      status('Checking owner access…');
      let verified = false;
      try {
        const access = await env.fetch('/api/platform/auth/me', options);
        if (!current()) return;
        if (!access.ok) { hide(); return; }
        const user = await access.json();
        if (!current()) return;
        if (!currentOwner(user)) { hide(); return; }
        verified = true;
        mount(); root.hidden = false; root.setAttribute('aria-busy', 'true');
        status('Loading Stripe payment activity…');
        const response = await env.fetch('/api/platform/revenue?start=' + encodeURIComponent(start) + '&end=' + encodeURIComponent(end), options);
        if (!current()) return;
        if (response.status === 401 || response.status === 403) { hide(); return; }
        const report = await response.json();
        if (!current()) return;
        if (!response.ok || report?.status === 'error') { status(reportErrorMessage(report?.code), true); return; }
        if (report?.status === 'unconfigured') { status('Stripe is not configured. Payment activity and recurring estimates are unavailable.'); return; }
        if (!validReport(report, start, end)) throw new Error('Report unavailable');
        render(report);
        status('Stripe report refreshed.');
      } catch (_error) {
        if (!current()) return;
        if (!verified) { hide(); return; }
        controls.results.replaceChildren();
        status(reportErrorMessage(), true);
      } finally {
        if (current()) { controller = null; root.setAttribute('aria-busy', 'false'); }
      }
    }
    function sync() {
      const active = view.classList.contains('active') && document.visibilityState !== 'hidden';
      if (!active) { if (wasActive || controls || controller) hide(); wasActive = false; return; }
      if (!wasActive && !revoked) { wasActive = true; void refreshReport(); }
    }
    const Observer = env.MutationObserver || window.MutationObserver;
    if (Observer) new Observer(sync).observe(view, { attributes: true, attributeFilter: ['class'] });
    document.addEventListener('click', event => {
      if (event.target?.closest('#platform-logout')) { revoked = true; hide(); return; }
      // Runs after the existing platform navigation's handlers, without replacing them.
      if (event.target?.closest('[data-view], [data-view-link]')) Promise.resolve().then(sync);
    }, true);
    document.addEventListener('visibilitychange', sync);
    window.addEventListener('hashchange', sync);
    window.addEventListener('pagehide', () => { hide(); wasActive = false; });
    window.addEventListener('pageshow', sync);
    sync();
    return { refresh: refreshReport, sync };
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { defaultPeriod, periodError, money, currentOwner, validReport, createRevenueConsole };
  else {
    const start = () => createRevenueConsole({ document, window, fetch: window.fetch.bind(window) });
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
    else start();
  }
})();
