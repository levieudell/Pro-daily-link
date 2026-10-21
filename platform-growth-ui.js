'use strict';

/*
  Pro Daily Link back-office Growth workspace (standalone browser module).

  Integration contract (no existing platform files are changed by this module):
  1. Add a capability-gated nav target for #growth and a view with
     <section id="growth-view"><div id="platform-growth" hidden></div></section>.
  2. Load this file after platform.js. The authenticated /auth/me response must
     include capabilities containing growth:read and, for mutations, growth:write.
  3. GET /api/platform/growth?start=YYYY-MM-DD&end=YYYY-MM-DD returns the shape
     accepted by validGrowthReport(). Dates are inclusive UTC calendar dates.
  4. Load platform-growth-integration.js after this file for the complete,
     accessible create/edit/stage/follow-up/note dialogs. Custom hosts may
     instead consume `pdl:growth-action` or pass env.onAction and submit through
     console.actions.*. Keep one createIdempotencyKey() per create payload and
     reuse it when the same submission is retried after an uncertain response.
  5. Every API route must independently enforce growth:read/growth:write. UI
     capability checks are presentation safeguards, never authorization.
*/
(function growthModule() {
  const DAY_MS = 86400000;
  const STAGES = Object.freeze(['new', 'contacted', 'qualified', 'demo_scheduled', 'demo_held', 'proposal', 'won', 'lost']);
  const STAGE_LABELS = Object.freeze({
    new: 'New', contacted: 'Contacted', qualified: 'Qualified', demo_scheduled: 'Demo scheduled',
    demo_held: 'Demo held', proposal: 'Proposal', won: 'Won', lost: 'Lost'
  });
  const ATTRIBUTION_LABELS = Object.freeze({ source: 'Lead source', medium: 'Channel', campaign: 'Campaign', plan: 'Plan interest' });
  const ZERO_DECIMAL = new Set('bif clp djf gnf jpy kmf krw mga pyg rwf vnd vuv xaf xof xpf'.split(' '));
  const THREE_DECIMAL = new Set(['bhd', 'jod', 'kwd', 'omr', 'tnd']);
  const GROWTH_CSS = `
    .pdl-growth{--growth-ink:var(--ink,#151916);--growth-muted:var(--muted,#66706a);--growth-surface:var(--card,#fff);--growth-line:var(--line,#dce1dc);--growth-soft:var(--soft,#f3f5f2);--growth-accent:var(--orange,#ff6b1a);--growth-danger:#9f211a;display:grid;gap:16px;color:var(--growth-ink)}
    .pdl-growth *{box-sizing:border-box}.pdl-growth button,.pdl-growth input,.pdl-growth select{font:inherit}.pdl-growth button,.pdl-growth input,.pdl-growth select{min-height:44px}
    .pdl-growth__hero,.pdl-growth__section,.pdl-growth__card{background:var(--growth-surface);border:1px solid var(--growth-line);border-radius:16px}
    .pdl-growth__hero,.pdl-growth__section{padding:16px}.pdl-growth__heading{display:grid;gap:12px}.pdl-growth__heading h2,.pdl-growth__section h3,.pdl-growth__card h4{margin:0}.pdl-growth__heading p,.pdl-growth__section p{margin:4px 0;color:var(--growth-muted)}
    .pdl-growth__filters{display:grid;gap:10px}.pdl-growth__filters label{display:grid;gap:5px;font-size:.85rem;font-weight:700}.pdl-growth__filters input{width:100%;padding:9px 10px;border:1px solid var(--growth-line);border-radius:10px;background:var(--growth-surface);color:var(--growth-ink)}
    .pdl-growth__button{border:1px solid var(--growth-line);border-radius:10px;padding:9px 13px;background:var(--growth-surface);color:var(--growth-ink);font-weight:750;cursor:pointer}.pdl-growth__button--primary{background:var(--growth-accent);border-color:var(--growth-accent);color:#15120f}.pdl-growth__button:disabled{opacity:.5;cursor:not-allowed}.pdl-growth__button:focus-visible,.pdl-growth input:focus-visible{outline:3px solid #1769e0;outline-offset:2px}
    .pdl-growth__status{min-height:24px;margin:0;color:var(--growth-muted)}.pdl-growth__status.is-error{color:var(--growth-danger)}
    .pdl-growth__grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.pdl-growth__kpi{padding:14px;min-width:0}.pdl-growth__kpi span{display:block;color:var(--growth-muted);font-size:.78rem;text-transform:uppercase;letter-spacing:.06em}.pdl-growth__kpi strong{display:block;margin-top:7px;font-size:1.35rem;line-height:1.15;overflow-wrap:anywhere}.pdl-growth__kpi small{display:block;margin-top:5px;color:var(--growth-muted)}
    .pdl-growth__section-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:12px}.pdl-growth__section-head small{color:var(--growth-muted);text-align:right}
    .pdl-growth__funnel{display:grid;gap:8px}.pdl-growth__funnel-row{display:grid;grid-template-columns:minmax(108px,1fr) auto;gap:8px;align-items:center}.pdl-growth__track{grid-column:1/-1;height:8px;background:var(--growth-soft);border-radius:999px;overflow:hidden}.pdl-growth__fill{height:100%;background:var(--growth-accent);border-radius:inherit}.pdl-growth__funnel-value{text-align:right}.pdl-growth__funnel-value small{display:block;color:var(--growth-muted)}
    .pdl-growth__attribution{display:grid;gap:14px}.pdl-growth__breakdown{border-top:1px solid var(--growth-line);padding-top:12px}.pdl-growth__breakdown:first-child{border-top:0;padding-top:0}.pdl-growth__breakdown h4{margin:0 0 8px}.pdl-growth__definition{display:flex;justify-content:space-between;gap:12px;padding:6px 0}.pdl-growth__definition dt,.pdl-growth__definition dd{margin:0}.pdl-growth__definition dt{overflow-wrap:anywhere}.pdl-growth__definition dd{font-variant-numeric:tabular-nums;font-weight:750}
    .pdl-growth__cards{display:grid;gap:10px}.pdl-growth__card{padding:14px;min-width:0}.pdl-growth__card-head{display:flex;justify-content:space-between;align-items:flex-start;gap:10px}.pdl-growth__card-head div{min-width:0}.pdl-growth__card-head h4,.pdl-growth__card-head p{overflow-wrap:anywhere}.pdl-growth__pill{flex:none;padding:5px 8px;border-radius:999px;background:var(--growth-soft);font-size:.75rem;font-weight:800;text-transform:uppercase}.pdl-growth__facts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin:12px 0}.pdl-growth__fact{min-width:0}.pdl-growth__fact span{display:block;color:var(--growth-muted);font-size:.75rem}.pdl-growth__fact strong{display:block;margin-top:3px;overflow-wrap:anywhere}.pdl-growth__actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}.pdl-growth__actions .pdl-growth__button{flex:1 1 110px}
    .pdl-growth__attention{border-left:4px solid var(--growth-accent)}.pdl-growth__empty{padding:18px;border:1px dashed var(--growth-line);border-radius:12px;color:var(--growth-muted);text-align:center}.pdl-growth__note{font-size:.82rem;color:var(--growth-muted)}
    @media (min-width:760px){.pdl-growth{gap:20px}.pdl-growth__hero,.pdl-growth__section{padding:20px}.pdl-growth__heading{grid-template-columns:minmax(0,1fr) auto;align-items:end}.pdl-growth__filters{grid-template-columns:repeat(2,minmax(140px,1fr)) auto auto;align-items:end}.pdl-growth__grid{grid-template-columns:repeat(4,minmax(0,1fr))}.pdl-growth__attribution{grid-template-columns:repeat(2,minmax(0,1fr))}.pdl-growth__breakdown:nth-child(2){border-top:0;padding-top:0}.pdl-growth__cards{grid-template-columns:repeat(2,minmax(0,1fr))}}
    @media (min-width:1120px){.pdl-growth__grid{grid-template-columns:repeat(5,minmax(0,1fr))}.pdl-growth__cards--pipeline{grid-template-columns:repeat(3,minmax(0,1fr))}}
    [data-theme="dark"] .pdl-growth,.theme-dark .pdl-growth,.dark .pdl-growth{--growth-ink:#f7f8f7;--growth-muted:#c0c8c3;--growth-surface:#202622;--growth-line:#475149;--growth-soft:#303833;--growth-danger:#ffb4ab}
    @media (prefers-reduced-motion:reduce){.pdl-growth *{scroll-behavior:auto!important;transition:none!important}}
  `;

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
  }

  function safeCount(value) {
    return Number.isSafeInteger(value) && value >= 0 ? value.toLocaleString('en-US') : 'Unavailable';
  }

  function safePercent(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100
      ? value.toLocaleString('en-US', { maximumFractionDigits: 2 }) + '%'
      : 'Unavailable';
  }

  function minorExponent(currency) {
    const code = String(currency || '').toLowerCase();
    if (!/^[a-z]{3}$/.test(code)) return null;
    if (ZERO_DECIMAL.has(code)) return 0;
    if (THREE_DECIMAL.has(code)) return 3;
    return 2;
  }

  function minorMoney(amount, currency) {
    const exponent = minorExponent(currency);
    if (exponent == null || !Number.isSafeInteger(amount) || amount < 0) return 'Unavailable';
    return String(currency).toUpperCase() + ' ' + (amount / (10 ** exponent)).toLocaleString('en-US', {
      minimumFractionDigits: exponent,
      maximumFractionDigits: exponent
    });
  }

  function moneyRows(rows, unknownCount = 0) {
    if (!Array.isArray(rows)) return 'Unavailable';
    const amounts = rows.map(row => minorMoney(row?.amountMinor, row?.currency));
    if (amounts.some(value => value === 'Unavailable') || !Number.isSafeInteger(unknownCount) || unknownCount < 0) return 'Unavailable';
    if (unknownCount) amounts.push(`${safeCount(unknownCount)} not entered`);
    return amounts.length ? amounts.join(' · ') : 'Not entered';
  }

  function durationMinutes(value) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 'Unavailable';
    const minutes = Math.round(value);
    if (minutes < 60) return `${minutes} min`;
    const hours = Math.floor(minutes / 60), remainder = minutes % 60;
    return remainder ? `${hours} hr ${remainder} min` : `${hours} hr`;
  }

  function dateTime(value) {
    if (!value || !Number.isFinite(Date.parse(value))) return 'Unavailable';
    return new Date(value).toLocaleString([], { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
  }

  function defaultPeriod(now) {
    const today = new Date(now).toISOString().slice(0, 10);
    return { start: today.slice(0, 8) + '01', end: today };
  }

  function dateValue(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return NaN;
    const parsed = Date.parse(`${value}T00:00:00.000Z`);
    return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value ? parsed : NaN;
  }

  function periodError(start, end, today) {
    const first = dateValue(start), last = dateValue(end), current = dateValue(today);
    if (![first, last, current].every(Number.isFinite)) return 'Choose valid start and end dates.';
    if (first > last) return 'The start date must be on or before the end date.';
    if (last > current) return 'The end date cannot be in the future.';
    if ((last - first) / DAY_MS + 1 > 366) return 'Choose a date range of 366 days or fewer.';
    return '';
  }

  function hasCapability(user, capability) {
    return Boolean(user?.active === true && Array.isArray(user.capabilities) && user.capabilities.includes(capability));
  }

  function objectValue(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  function nonnegativeInteger(value) {
    return Number.isSafeInteger(value) && value >= 0;
  }

  function finitePercent(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
  }

  function metricRate(value, numerator, denominator) {
    if (!nonnegativeInteger(numerator) || !nonnegativeInteger(denominator) || numerator > denominator) return false;
    if (denominator === 0) return value === null;
    const expected = Math.round(numerator / denominator * 10000) / 100;
    return finitePercent(value) && Math.abs(value - expected) < 0.0051;
  }

  function validMoneyMetric(rows, unknownCount, maximumRecords) {
    if (!Array.isArray(rows) || rows.length > 200 || !nonnegativeInteger(unknownCount) ||
        unknownCount > maximumRecords || rows.length + unknownCount > maximumRecords) return false;
    const currencies = new Set();
    for (const row of rows) {
      const currency = row?.currency;
      if (!objectValue(row) || typeof currency !== 'string' || !/^[a-z]{3}$/.test(currency) ||
          !nonnegativeInteger(row.amountMinor) || currencies.has(currency)) return false;
      currencies.add(currency);
    }
    return true;
  }

  function validBreakdown(rows, cohortSize) {
    if (!Array.isArray(rows) || rows.length > 1000) return false;
    const buckets = new Set();
    let total = 0;
    for (const row of rows) {
      if (!objectValue(row) || typeof row.bucket !== 'string' || !row.bucket.trim() || row.bucket.length > 2048 ||
          !Number.isSafeInteger(row.count) || row.count <= 0 || buckets.has(row.bucket)) return false;
      buckets.add(row.bucket);
      total += row.count;
      if (!Number.isSafeInteger(total) || total > cohortSize) return false;
    }
    return total === cohortSize;
  }

  function validLeaderboard(rows, cohortSize, funnel) {
    if (!Array.isArray(rows) || rows.length > 10000) return false;
    const owners = new Set();
    const totals = { opportunitiesCreated: 0, demosHeld: 0, wins: 0, losses: 0, responses: 0 };
    for (const row of rows) {
      if (!objectValue(row) || typeof row.ownerUserId !== 'string' || !row.ownerUserId || owners.has(row.ownerUserId)) return false;
      owners.add(row.ownerUserId);
      for (const key of ['opportunitiesCreated', 'demosHeld', 'wins', 'losses']) {
        if (!nonnegativeInteger(row[key])) return false;
        totals[key] += row[key];
        if (!Number.isSafeInteger(totals[key])) return false;
      }
      if (!metricRate(row.winRate, row.wins, row.wins + row.losses) ||
          !validMoneyMetric(row.wonMrr, row.wonMrrUnknownCount, row.wins)) return false;
      const response = row.responseTime;
      if (!objectValue(response) || !nonnegativeInteger(response.respondedCount) || !nonnegativeInteger(response.awaitingResponseCount) ||
          !nonnegativeInteger(response.unknownCount) || (response.respondedCount === 0 ? response.averageMinutes !== null :
            typeof response.averageMinutes !== 'number' || !Number.isFinite(response.averageMinutes) || response.averageMinutes < 0)) return false;
      totals.responses += response.respondedCount + response.awaitingResponseCount + response.unknownCount;
      if (!Number.isSafeInteger(totals.responses)) return false;
      const follow = row.followUpReliability;
      if (!objectValue(follow) || ['dueCount', 'completedOnTime', 'completedLate', 'overdue', 'cancelled'].some(key => !nonnegativeInteger(follow[key]))) return false;
      const tracked = follow.completedOnTime + follow.completedLate + follow.overdue;
      if (follow.dueCount !== tracked || !metricRate(follow.rate, follow.completedOnTime, tracked)) return false;
    }
    return totals.opportunitiesCreated === cohortSize && totals.responses === cohortSize &&
      totals.demosHeld === funnel.demo_held && totals.wins === funnel.won && totals.losses === funnel.lost;
  }

  function validGrowthReport(report, start, end) {
    const metrics = report?.metrics;
    const startDate = dateValue(start), endDate = dateValue(end);
    if (report?.status !== 'ready' || report.period?.startDate !== start || report.period?.endDate !== end ||
        report.period?.timezone !== 'UTC' || !Number.isFinite(Date.parse(report.asOf)) || !objectValue(metrics) ||
        !nonnegativeInteger(metrics.cohortSize) || !objectValue(metrics.funnel) || !objectValue(metrics.attribution) ||
        !objectValue(metrics.pipeline) || !objectValue(metrics.overdue) || !Array.isArray(metrics.leaderboard) ||
        !Array.isArray(report.opportunities) || report.opportunities.length > 200 || !nonnegativeInteger(report.opportunityTotal) ||
        report.opportunityTotal < report.opportunities.length || metrics.pipeline.count !== report.opportunityTotal ||
        !Array.isArray(report.owners) || report.owners.length > 10000 || !Number.isFinite(startDate) || !Number.isFinite(endDate) ||
        startDate > endDate || Date.parse(report.asOf) < endDate) return false;

    const funnel = metrics.funnel;
    if (STAGES.some(stage => !nonnegativeInteger(funnel[stage]) || funnel[stage] > metrics.cohortSize) ||
        funnel.new !== metrics.cohortSize || funnel.won + funnel.lost > metrics.cohortSize) return false;
    if (Object.keys(ATTRIBUTION_LABELS).some(key => !validBreakdown(metrics.attribution[key], metrics.cohortSize))) return false;
    if (!nonnegativeInteger(metrics.pipeline.count) || !validMoneyMetric(metrics.pipeline.expectedMrr,
      metrics.pipeline.expectedMrrUnknownCount, metrics.pipeline.count)) return false;

    const overdue = metrics.overdue;
    if (!nonnegativeInteger(overdue.count) || !Array.isArray(overdue.items) || overdue.count !== overdue.items.length || overdue.items.length > 10000) return false;
    const overdueIds = new Set();
    for (const item of overdue.items) {
      if (!objectValue(item) || typeof item.id !== 'string' || !item.id || overdueIds.has(item.id) ||
          typeof item.ownerUserId !== 'string' || !item.ownerUserId || !Number.isFinite(Date.parse(item.dueAt))) return false;
      overdueIds.add(item.id);
    }
    if (!validLeaderboard(metrics.leaderboard, metrics.cohortSize, funnel)) return false;

    const ownerIds = new Set();
    for (const owner of report.owners) {
      if (!objectValue(owner) || typeof owner.id !== 'string' || !owner.id || ownerIds.has(owner.id) ||
          typeof owner.name !== 'string' || !owner.name.trim()) return false;
      ownerIds.add(owner.id);
    }
    const opportunityIds = new Set();
    for (const opportunity of report.opportunities) {
      if (!objectValue(opportunity) || typeof opportunity.id !== 'string' || !opportunity.id || opportunityIds.has(opportunity.id) ||
          !nonnegativeInteger(opportunity.version) || opportunity.version < 1 || !STAGES.includes(opportunity.stage) ||
          ![opportunity.companyName, opportunity.contactName, opportunity.ownerUserId, opportunity.nextAction, opportunity.nextActionDueAt,
            opportunity.plan, opportunity.currency].every(value => value == null || typeof value === 'string') ||
          (opportunity.expectedMrrMinor != null && !nonnegativeInteger(opportunity.expectedMrrMinor)) ||
          !objectValue(opportunity.attribution) || Object.values(opportunity.attribution).some(value => value != null && typeof value !== 'string')) return false;
      opportunityIds.add(opportunity.id);
    }
    return true;
  }

  function apiErrorMessage(code) {
    switch (code) {
      case 'invalid_period': return 'Choose a valid reporting period.';
      case 'revision_conflict': return 'This opportunity changed. Refresh before saving your changes.';
      case 'duplicate_opportunity': return 'An active opportunity already matches that email, phone, or company contact.';
      case 'busy': return 'Growth data is already updating. Try again shortly.';
      default: return 'Growth data is temporarily unavailable. Refresh to try again.';
    }
  }

  function injectStyles(document) {
    if (!document?.head || document.getElementById('pdl-growth-styles')) return;
    const style = document.createElement('style');
    style.id = 'pdl-growth-styles';
    style.textContent = GROWTH_CSS;
    document.head.append(style);
  }

  function node(document, tag, text, className) {
    const item = document.createElement(tag);
    if (text !== undefined) item.textContent = String(text ?? '');
    if (className) item.className = className;
    return item;
  }

  function section(document, title, note) {
    const host = node(document, 'section', undefined, 'pdl-growth__section');
    const head = node(document, 'div', undefined, 'pdl-growth__section-head');
    head.append(node(document, 'h3', title));
    if (note) head.append(node(document, 'small', note));
    host.append(head);
    return host;
  }

  function kpi(document, label, value, note) {
    const card = node(document, 'article', undefined, 'pdl-growth__card pdl-growth__kpi');
    card.append(node(document, 'span', label), node(document, 'strong', value));
    if (note) card.append(node(document, 'small', note));
    return card;
  }

  function button(document, label, action, opportunity, primary = false) {
    const control = node(document, 'button', label, `pdl-growth__button${primary ? ' pdl-growth__button--primary' : ''}`);
    control.type = 'button';
    control.dataset.growthAction = action;
    if (opportunity) {
      control.dataset.opportunityId = String(opportunity.id || '');
      control.dataset.opportunityVersion = String(Number.isSafeInteger(opportunity.version) ? opportunity.version : '');
      const name = opportunity.companyName || opportunity.contactName || 'unnamed opportunity';
      control.setAttribute('aria-label', `${label} ${name}`);
    }
    return control;
  }

  function ownerName(ownerUserId, owners) {
    if (!ownerUserId || ownerUserId === 'unassigned') return 'Unassigned';
    const owner = owners.find(item => String(item?.id) === String(ownerUserId));
    return owner?.name || `Unknown owner (${ownerUserId})`;
  }

  function metricTotal(rows, key) {
    if (!Array.isArray(rows)) return null;
    let total = 0;
    for (const row of rows) {
      if (!Number.isSafeInteger(row?.[key]) || row[key] < 0) return null;
      total += row[key];
      if (!Number.isSafeInteger(total)) return null;
    }
    return total;
  }

  function renderFunnel(document, metrics) {
    const host = section(document, 'Funnel', 'Reached stages; no skipped stage is inferred');
    const list = node(document, 'div', undefined, 'pdl-growth__funnel');
    const cohort = Number.isSafeInteger(metrics.cohortSize) && metrics.cohortSize >= 0 ? metrics.cohortSize : null;
    for (const stage of STAGES) {
      const count = metrics.funnel?.[stage], valid = Number.isSafeInteger(count) && count >= 0;
      const row = node(document, 'div', undefined, 'pdl-growth__funnel-row');
      row.append(node(document, 'strong', STAGE_LABELS[stage]));
      const value = node(document, 'span', undefined, 'pdl-growth__funnel-value');
      value.append(node(document, 'b', safeCount(count)));
      value.append(node(document, 'small', valid && cohort > 0 ? safePercent(count / cohort * 100) + ' of cohort' : 'Conversion unavailable'));
      row.append(value);
      const track = node(document, 'div', undefined, 'pdl-growth__track');
      const fill = node(document, 'div', undefined, 'pdl-growth__fill');
      fill.style.width = valid && cohort > 0 && count <= cohort ? `${Math.round(count / cohort * 10000) / 100}%` : '0%';
      track.append(fill); row.append(track); list.append(row);
    }
    host.append(list);
    return host;
  }

  function renderAttribution(document, metrics) {
    const host = section(document, 'Attribution', 'Unknown means the source was not captured');
    const grid = node(document, 'div', undefined, 'pdl-growth__attribution');
    for (const [key, label] of Object.entries(ATTRIBUTION_LABELS)) {
      const block = node(document, 'section', undefined, 'pdl-growth__breakdown');
      block.append(node(document, 'h4', label));
      const allRows = Array.isArray(metrics.attribution?.[key]) ? metrics.attribution[key] : [];
      const rows = allRows.slice(0, 20);
      if (!rows.length) block.append(node(document, 'p', 'No recorded data for this period.', 'pdl-growth__empty'));
      else {
        const list = node(document, 'dl');
        for (const row of rows) {
          const pair = node(document, 'div', undefined, 'pdl-growth__definition');
          pair.append(node(document, 'dt', row?.bucket === 'unknown' || !row?.bucket ? 'Unknown' : row.bucket), node(document, 'dd', safeCount(row?.count)));
          list.append(pair);
        }
        block.append(list);
        if (allRows.length > rows.length) block.append(node(document, 'p', `Showing the first ${safeCount(rows.length)} of ${safeCount(allRows.length)} recorded buckets.`, 'pdl-growth__note'));
      }
      grid.append(block);
    }
    host.append(grid);
    return host;
  }

  function renderLeaderboard(document, report) {
    const total = report.metrics.leaderboard.length;
    const host = section(document, 'Outcome leaderboard', total > 100 ? `Measured outcomes only · showing first 100 of ${safeCount(total)}` : 'Measured outcomes only · no activity score');
    const cards = node(document, 'div', undefined, 'pdl-growth__cards');
    const rows = report.metrics.leaderboard.slice(0, 100);
    if (!rows.length) cards.append(node(document, 'p', 'No measured sales outcomes in this period.', 'pdl-growth__empty'));
    for (const row of rows) {
      const card = node(document, 'article', undefined, 'pdl-growth__card');
      const heading = node(document, 'div', undefined, 'pdl-growth__card-head');
      heading.append(node(document, 'h4', ownerName(row?.ownerUserId, report.owners)), node(document, 'span', `${safeCount(row?.wins)} won`, 'pdl-growth__pill'));
      card.append(heading);
      const facts = node(document, 'div', undefined, 'pdl-growth__facts');
      const wonMrr = moneyRows(row?.wonMrr, row?.wonMrrUnknownCount);
      const response = row?.responseTime || {}, follow = row?.followUpReliability || {};
      const entries = [
        ['Won MRR', wonMrr], ['Demos held', safeCount(row?.demosHeld)], ['Win rate', safePercent(row?.winRate)],
        ['Avg. first response', durationMinutes(response.averageMinutes)], ['On-time follow-up', safePercent(follow.rate)],
        ['Overdue follow-ups', safeCount(follow.overdue)]
      ];
      for (const [label, value] of entries) {
        const fact = node(document, 'div', undefined, 'pdl-growth__fact');
        fact.append(node(document, 'span', label), node(document, 'strong', value)); facts.append(fact);
      }
      card.append(facts);
      card.append(node(document, 'p', `${safeCount(response.respondedCount)} responses measured · ${safeCount(response.awaitingResponseCount)} awaiting · ${safeCount(response.unknownCount)} unknown`, 'pdl-growth__note'));
      card.append(node(document, 'p', `${safeCount(follow.completedOnTime)} on time · ${safeCount(follow.completedLate)} late · ${safeCount(follow.cancelled)} cancelled`, 'pdl-growth__note'));
      cards.append(card);
    }
    host.append(cards);
    return host;
  }

  function renderFollowUps(document, report) {
    const overdue = report.metrics.overdue;
    const host = section(document, 'Follow-up queue', overdue?.count > 100 ? `${safeCount(overdue.count)} overdue · showing first 100` : `${safeCount(overdue?.count)} overdue`);
    const cards = node(document, 'div', undefined, 'pdl-growth__cards');
    const opportunities = new Map(report.opportunities.map(row => [String(row?.id), row]));
    const items = Array.isArray(overdue?.items) ? overdue.items.slice(0, 100) : [];
    if (!items.length) cards.append(node(document, 'p', 'No overdue follow-ups.', 'pdl-growth__empty'));
    for (const item of items) {
      const opportunity = opportunities.get(String(item?.id));
      const card = node(document, 'article', undefined, 'pdl-growth__card pdl-growth__attention');
      card.append(node(document, 'h4', opportunity?.companyName || opportunity?.contactName || 'Unknown opportunity'));
      card.append(node(document, 'p', opportunity?.nextAction || 'Next action not available'));
      card.append(node(document, 'p', `Due ${dateTime(item?.dueAt)} · ${ownerName(item?.ownerUserId, report.owners)}`, 'pdl-growth__note'));
      cards.append(card);
    }
    host.append(cards);
    return host;
  }

  function opportunityMrr(opportunity) {
    if (opportunity?.expectedMrrMinor == null && !opportunity?.currency) return 'Not entered';
    return minorMoney(opportunity?.expectedMrrMinor, opportunity?.currency);
  }

  function renderPipeline(document, report, canWrite) {
    const shown = report.opportunities.slice(0, 200);
    const total = Number.isSafeInteger(report.opportunityTotal) && report.opportunityTotal >= shown.length ? report.opportunityTotal : null;
    const note = total == null ? `Showing ${safeCount(shown.length)}; total unavailable` : `Showing ${safeCount(shown.length)} of ${safeCount(total)}`;
    const host = section(document, 'Pipeline', note);
    const cards = node(document, 'div', undefined, 'pdl-growth__cards pdl-growth__cards--pipeline');
    if (!shown.length) cards.append(node(document, 'p', 'No opportunities match this period and view.', 'pdl-growth__empty'));
    for (const opportunity of shown) {
      const card = node(document, 'article', undefined, 'pdl-growth__card');
      const heading = node(document, 'div', undefined, 'pdl-growth__card-head');
      const names = node(document, 'div');
      names.append(node(document, 'h4', opportunity?.companyName || opportunity?.contactName || 'Unnamed opportunity'));
      if (opportunity?.companyName && opportunity?.contactName) names.append(node(document, 'p', opportunity.contactName));
      const stage = STAGES.includes(opportunity?.stage) ? STAGE_LABELS[opportunity.stage] : 'Stage unavailable';
      heading.append(names, node(document, 'span', stage, 'pdl-growth__pill')); card.append(heading);
      const facts = node(document, 'div', undefined, 'pdl-growth__facts');
      for (const [label, value] of [
        ['Owner', ownerName(opportunity?.ownerUserId, report.owners)], ['Expected MRR', opportunityMrr(opportunity)],
        ['Next action', opportunity?.nextAction || 'Not entered'], ['Due', opportunity?.nextActionDueAt ? dateTime(opportunity.nextActionDueAt) : 'Not entered']
      ]) {
        const fact = node(document, 'div', undefined, 'pdl-growth__fact'); fact.append(node(document, 'span', label), node(document, 'strong', value)); facts.append(fact);
      }
      card.append(facts);
      const source = opportunity?.attribution?.source || 'Unknown';
      card.append(node(document, 'p', `Source: ${source} · Plan: ${opportunity?.plan || 'Unknown'}`, 'pdl-growth__note'));
      if (canWrite) {
        const actions = node(document, 'div', undefined, 'pdl-growth__actions');
        actions.append(button(document, 'Edit', 'edit', opportunity));
        if (!['won', 'lost'].includes(opportunity?.stage)) actions.append(button(document, 'Move stage', 'stage', opportunity), button(document, 'Next action', 'next_action', opportunity));
        actions.append(button(document, 'Add note', 'note', opportunity));
        if (opportunity?.nextAction) actions.append(button(document, 'Complete follow-up', 'complete_next_action', opportunity));
        card.append(actions);
      }
      cards.append(card);
    }
    host.append(cards);
    return host;
  }

  function renderGrowthReport(document, root, report, options = {}) {
    if (!validGrowthReport(report, report?.period?.startDate, report?.period?.endDate)) throw new Error('Invalid growth report');
    injectStyles(document);
    root.classList.add('pdl-growth');
    const metrics = report.metrics;
    const content = node(document, 'div', undefined, 'pdl-growth');
    const wins = metricTotal(metrics.leaderboard, 'wins');
    const kpis = node(document, 'section', undefined, 'pdl-growth__grid');
    kpis.setAttribute('aria-label', 'Growth key performance indicators');
    kpis.append(
      kpi(document, 'New opportunities', safeCount(metrics.cohortSize), 'Created in this period'),
      kpi(document, 'Open pipeline', safeCount(metrics.pipeline?.count), 'Current active opportunities'),
      kpi(document, 'Expected MRR', moneyRows(metrics.pipeline?.expectedMrr, metrics.pipeline?.expectedMrrUnknownCount), 'Currencies remain separate'),
      kpi(document, 'Wins', safeCount(wins), 'Closed won in this period'),
      kpi(document, 'Overdue', safeCount(metrics.overdue?.count), 'Next actions needing attention')
    );
    content.append(kpis, renderFunnel(document, metrics), renderAttribution(document, metrics), renderFollowUps(document, report), renderLeaderboard(document, report), renderPipeline(document, report, options.canWrite === true));
    root.replaceChildren(content);
    return content;
  }

  function formValues(form, allowedFields) {
    if (!form?.elements || !Array.isArray(allowedFields)) throw new TypeError('A form and allowed field list are required');
    const result = {};
    for (const name of allowedFields) {
      if (typeof name !== 'string' || !/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) throw new TypeError('Unsafe form field name');
      const control = form.elements.namedItem(name);
      if (!control || control.disabled) continue;
      if (control.type === 'checkbox') result[name] = Boolean(control.checked);
      else if (typeof control.value === 'string') result[name] = control.value.trim();
    }
    return result;
  }

  function validOpportunityId(value) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$/.test(value)) throw new TypeError('Invalid opportunity ID');
    return value;
  }

  function validVersion(value) {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError('Invalid opportunity version');
    return value;
  }

  function safePayload(value, allowedFields) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Growth form data must be an object');
    const unexpected = Object.keys(value).filter(key => !allowedFields.includes(key));
    if (unexpected.length) throw new TypeError(`Unsupported growth fields: ${unexpected.sort().join(', ')}`);
    const result = {};
    for (const key of allowedFields) if (Object.hasOwn(value, key)) {
      const item = value[key];
      if (item !== null && !['string', 'number', 'boolean'].includes(typeof item)) throw new TypeError(`Invalid growth field: ${key}`);
      if (typeof item === 'number' && !Number.isFinite(item)) throw new TypeError(`Invalid growth field: ${key}`);
      result[key] = item;
    }
    return result;
  }

  function createIdempotencyKey(cryptoSource = typeof globalThis !== 'undefined' ? globalThis.crypto : null) {
    if (typeof cryptoSource?.randomUUID === 'function') return `growth:${cryptoSource.randomUUID()}`;
    if (typeof cryptoSource?.getRandomValues !== 'function') throw new Error('Secure random values are unavailable');
    const bytes = new Uint8Array(16); cryptoSource.getRandomValues(bytes);
    return `growth:${[...bytes].map(value => value.toString(16).padStart(2, '0')).join('')}`;
  }

  function validIdempotencyKey(value) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{7,199}$/.test(value)) throw new TypeError('Invalid idempotency key');
    return value;
  }

  function createGrowthActions({ request, canWrite = () => false, onChanged = () => {} } = {}) {
    if (typeof request !== 'function') throw new TypeError('Growth actions require a request function');
    const pending = new Set();
    const createFields = ['companyName', 'contactName', 'email', 'phone', 'ownerUserId', 'source', 'medium', 'campaign', 'referrer', 'landingPage', 'plan', 'expectedMrrMinor', 'currency', 'nextAction', 'nextActionDueAt', 'note', 'linkedCompanyId'];
    const updateFields = ['companyName', 'contactName', 'email', 'phone', 'ownerUserId', 'source', 'medium', 'campaign', 'referrer', 'landingPage', 'plan', 'expectedMrrMinor', 'currency', 'linkedCompanyId'];
    async function write(key, path, method, payload, extraHeaders = {}) {
      if (!canWrite()) throw Object.assign(new Error('You do not have permission to change growth records.'), { code: 'growth_write_denied' });
      if (pending.has(key)) throw Object.assign(new Error('This growth update is already running.'), { code: 'busy' });
      pending.add(key);
      try {
        const result = await request(path, { method, body: JSON.stringify(payload), headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...extraHeaders } });
        await onChanged(result);
        return result;
      } finally { pending.delete(key); }
    }
    const opportunityPath = id => `/api/platform/growth/opportunities/${encodeURIComponent(validOpportunityId(id))}`;
    return Object.freeze({
      create: (payload, options = {}) => {
        const optionPayload = safePayload(options, ['idempotencyKey']);
        const key = validIdempotencyKey(optionPayload.idempotencyKey);
        return write(`create:${key}`, '/api/platform/growth/opportunities', 'POST', safePayload(payload, createFields), { 'Idempotency-Key': key });
      },
      update: (id, version, payload) => write(`update:${id}`, opportunityPath(id), 'PATCH', { ...safePayload(payload, updateFields), expectedVersion: validVersion(version) }),
      transition: (id, version, payload) => write(`stage:${id}`, `${opportunityPath(id)}/stage`, 'POST', { ...safePayload(payload, ['stage', 'reason', 'lossReason']), expectedVersion: validVersion(version) }),
      setNextAction: (id, version, payload) => write(`next:${id}`, `${opportunityPath(id)}/next-action`, 'POST', { ...safePayload(payload, ['description', 'dueAt', 'replaceReason']), expectedVersion: validVersion(version) }),
      completeNextAction: (id, version) => write(`next:${id}`, `${opportunityPath(id)}/next-action/complete`, 'POST', { expectedVersion: validVersion(version) }),
      cancelNextAction: (id, version, reason) => write(`next:${id}`, `${opportunityPath(id)}/next-action/cancel`, 'POST', { ...safePayload({ reason }, ['reason']), expectedVersion: validVersion(version) }),
      addNote: (id, version, text) => write(`note:${id}`, `${opportunityPath(id)}/notes`, 'POST', { ...safePayload({ text }, ['text']), expectedVersion: validVersion(version) })
    });
  }

  function createGrowthConsole(env) {
    const document = env.document, window = env.window;
    const root = document.getElementById('platform-growth'), view = document.getElementById('growth-view');
    if (!root || !view || root.__pdlGrowthMounted) return null;
    root.__pdlGrowthMounted = true;
    root.hidden = true;
    injectStyles(document);
    let sequence = 0, controller = null, controls = null, activeBefore = false, revoked = false, user = null, lastReport = null;
    const dates = defaultPeriod(env.now ? env.now() : Date.now());
    const fetcher = env.fetch || window.fetch.bind(window);

    function requireSignIn() {
      const destination = '/platform-login.html';
      if (typeof env.onAuthRequired === 'function') env.onAuthRequired(destination);
      else if (typeof window.location?.assign === 'function') window.location.assign(destination);
      else if (window.location) window.location.href = destination;
    }

    function showAccessDenied() {
      user = null; lastReport = null; mount(); syncWriteAccess(); root.hidden = false;
      controls.results.replaceChildren(); root.setAttribute('aria-busy', 'false');
      status('You no longer have access to Growth. Choose another back-office section or ask a platform owner to update your role.', true);
    }

    async function request(path, options = {}) {
      const response = await fetcher(path, { credentials: 'include', cache: 'no-store', ...options });
      let result = {};
      try { result = await response.json(); } catch { /* Use local error copy only. */ }
      if (response.status === 401) {
        revoked = true; hide(); requireSignIn();
        throw Object.assign(new Error('Your platform session expired.'), { status: 401, code: 'session_expired' });
      }
      if (response.status === 403) throw Object.assign(new Error('You no longer have permission to change growth records.'), { status: 403, code: 'growth_write_denied' });
      if (!response.ok) throw Object.assign(new Error(apiErrorMessage(result?.code)), { status: response.status, code: result?.code });
      return result;
    }

    function invalidate() {
      sequence++;
      if (controller) controller.abort();
      controller = null;
      root.setAttribute('aria-busy', 'false');
    }

    function hide() {
      invalidate(); root.hidden = true; root.replaceChildren(); controls = null; user = null; lastReport = null;
    }

    function status(message, error = false) {
      if (!controls) return;
      controls.status.textContent = message;
      controls.status.classList.toggle('is-error', error);
    }

    function emitAction(detail) {
      if (!hasCapability(user, 'growth:write')) return null;
      const safe = Object.freeze({ action: String(detail.action || ''), opportunityId: detail.opportunityId || null, version: Number.isSafeInteger(detail.version) ? detail.version : null });
      const failed = () => status('This action could not be opened. Refresh and try again.', true);
      const safelySettle = result => { if (result && typeof result.then === 'function') result.catch(failed); };
      const Event = env.CustomEvent || window.CustomEvent;
      if (Event && root.dispatchEvent) {
        try { safelySettle(root.dispatchEvent(new Event('pdl:growth-action', { detail: safe, bubbles: true }))); } catch { failed(); }
      }
      if (typeof env.onAction === 'function') {
        try { safelySettle(env.onAction(safe, actions)); } catch { failed(); }
      }
      return safe;
    }

    function mount() {
      if (controls) return;
      root.classList.add('pdl-growth'); root.setAttribute('aria-labelledby', 'platform-growth-title');
      const hero = node(document, 'section', undefined, 'pdl-growth__hero');
      const heading = node(document, 'div', undefined, 'pdl-growth__heading');
      const copy = node(document, 'div');
      const title = node(document, 'h2', 'Growth command center'); title.id = 'platform-growth-title';
      copy.append(title, node(document, 'p', 'Prioritize follow-ups and measure demos, wins, response time, and recurring revenue without vanity scores.'));
      const filters = node(document, 'form', undefined, 'pdl-growth__filters'); filters.noValidate = true;
      const makeDate = (labelText, id, value) => {
        const label = node(document, 'label', labelText), input = node(document, 'input');
        input.id = id; input.type = 'date'; input.value = value; input.required = true; label.append(input); return { label, input };
      };
      const start = makeDate('Start date (UTC)', 'growth-start', dates.start), end = makeDate('End date (UTC)', 'growth-end', dates.end);
      const refresh = button(document, 'Refresh', 'refresh'); refresh.type = 'submit'; delete refresh.dataset.growthAction;
      const createButton = button(document, 'New opportunity', 'create', null, true);
      filters.append(start.label, end.label, refresh, createButton);
      heading.append(copy, filters); hero.append(heading);
      const state = node(document, 'p', '', 'pdl-growth__status'); state.setAttribute('role', 'status'); state.setAttribute('aria-live', 'polite'); state.setAttribute('aria-atomic', 'true');
      const results = node(document, 'div'); hero.append(state); root.append(hero, results);
      controls = { start: start.input, end: end.input, refresh, createButton, status: state, results };
      syncWriteAccess();
      filters.addEventListener('submit', event => { event.preventDefault(); void refreshReport(); });
      for (const input of [start.input, end.input]) input.addEventListener('input', () => {
        dates.start = controls.start.value; dates.end = controls.end.value; invalidate(); lastReport = null; controls.results.replaceChildren(); status('Dates changed. Select Refresh to load this period.');
      });
    }

    function syncWriteAccess() {
      if (!controls) return;
      const allowed = hasCapability(user, 'growth:write');
      controls.createButton.hidden = !allowed;
      controls.createButton.disabled = !allowed;
    }

    async function refreshReport() {
      if (revoked || !view.classList.contains('active') || document.visibilityState === 'hidden') return;
      if (controls) { dates.start = controls.start.value; dates.end = controls.end.value; }
      invalidate();
      const today = new Date(env.now ? env.now() : Date.now()).toISOString().slice(0, 10), error = periodError(dates.start, dates.end, today);
      if (error) { status(error, true); return; }
      lastReport = null;
      if (controls) controls.results.replaceChildren();
      const requestSequence = sequence, start = dates.start, end = dates.end;
      const Abort = env.AbortController || window.AbortController;
      controller = new Abort();
      const current = () => requestSequence === sequence && !revoked && view.classList.contains('active') && document.visibilityState !== 'hidden';
      const options = { method: 'GET', credentials: 'include', cache: 'no-store', headers: { Accept: 'application/json' }, signal: controller.signal };
      let accessVerified = false;
      root.setAttribute('aria-busy', 'true'); status('Checking access…');
      try {
        const accessResponse = await fetcher('/api/platform/auth/me', options);
        if (!current()) return;
        if (accessResponse.status === 401) { revoked = true; hide(); requireSignIn(); return; }
        if (accessResponse.status === 403) { showAccessDenied(); return; }
        if (!accessResponse.ok) throw new Error('Access service unavailable');
        let access;
        try { access = await accessResponse.json(); } catch { throw new Error('Invalid access response'); }
        if (!current()) return;
        if (!hasCapability(access, 'growth:read')) { showAccessDenied(); return; }
        accessVerified = true;
        user = access; mount(); syncWriteAccess(); root.hidden = false; root.setAttribute('aria-busy', 'true'); status('Loading growth outcomes…');
        const response = await fetcher(`/api/platform/growth?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`, options);
        if (!current()) return;
        if (response.status === 401) { revoked = true; hide(); requireSignIn(); return; }
        if (response.status === 403) { showAccessDenied(); return; }
        let report = {};
        try { report = await response.json(); } catch { /* Local unavailable state below. */ }
        if (!current()) return;
        if (!response.ok || report?.status === 'error') { lastReport = null; controls.results.replaceChildren(); status(apiErrorMessage(report?.code), true); return; }
        if (report?.status === 'unavailable') { lastReport = null; controls.results.replaceChildren(); status('Growth reporting is not configured yet. No metrics are shown.'); return; }
        if (!validGrowthReport(report, start, end)) throw new Error('Invalid growth report');
        lastReport = report;
        const rendered = node(document, 'div');
        renderGrowthReport(document, rendered, report, { canWrite: hasCapability(user, 'growth:write') });
        controls.results.replaceChildren(...rendered.children);
        status(`Growth refreshed as of ${dateTime(report.asOf)}.`);
      } catch (_error) {
        if (!current()) return;
        if (!accessVerified) {
          user = null; lastReport = null; mount(); syncWriteAccess(); root.hidden = false; controls.results.replaceChildren();
          status('Growth access could not be verified. Check your connection and select Refresh to retry.', true);
          return;
        }
        lastReport = null; controls.results.replaceChildren(); status(apiErrorMessage(), true);
      } finally {
        if (current()) { controller = null; root.setAttribute('aria-busy', 'false'); }
      }
    }

    const actions = createGrowthActions({ request, canWrite: () => hasCapability(user, 'growth:write'), onChanged: () => refreshReport() });
    root.addEventListener('click', event => {
      const target = event.target?.closest?.('[data-growth-action]');
      if (!target) return;
      emitAction({ action: target.dataset.growthAction, opportunityId: target.dataset.opportunityId || null, version: Number(target.dataset.opportunityVersion) || null });
    });
    function sync() {
      const active = view.classList.contains('active') && document.visibilityState !== 'hidden';
      if (!active) { if (activeBefore || controls || controller) hide(); activeBefore = false; return; }
      if (!activeBefore && !revoked) { activeBefore = true; void refreshReport(); }
    }
    const Observer = env.MutationObserver || window.MutationObserver;
    if (Observer) new Observer(sync).observe(view, { attributes: true, attributeFilter: ['class'] });
    document.addEventListener('click', event => {
      if (event.target?.closest?.('#platform-logout')) { revoked = true; hide(); return; }
      if (event.target?.closest?.('[data-view], [data-view-link]')) Promise.resolve().then(sync);
    }, true);
    document.addEventListener('visibilitychange', sync);
    window.addEventListener('hashchange', sync);
    window.addEventListener('pagehide', () => { hide(); activeBefore = false; });
    window.addEventListener('pageshow', sync);
    sync();
    const cloneValue = value => value == null ? null : JSON.parse(JSON.stringify(value));
    return Object.freeze({
      refresh: refreshReport,
      sync,
      actions,
      emitAction,
      getUser: () => cloneValue(user),
      getOpportunity: id => cloneValue(lastReport?.opportunities?.find(item => String(item?.id) === String(id))),
      getOwners: () => cloneValue(lastReport?.owners || [])
    });
  }

  const exported = Object.freeze({
    STAGES, STAGE_LABELS, GROWTH_CSS, escapeHtml, safeCount, safePercent, minorMoney, moneyRows,
    durationMinutes, defaultPeriod, periodError, hasCapability, validGrowthReport, apiErrorMessage,
    injectStyles, renderGrowthReport, formValues, safePayload, createIdempotencyKey, createGrowthActions, createGrowthConsole
  });
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
  else {
    window.PDLGrowthUI = exported;
    const start = () => { window.PDLGrowthConsole = createGrowthConsole({ document, window, fetch: window.fetch.bind(window) }); };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
    else start();
  }
})();
