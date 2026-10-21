'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const {
  STAGES,
  GROWTH_CSS,
  escapeHtml,
  safeCount,
  safePercent,
  minorMoney,
  moneyRows,
  durationMinutes,
  defaultPeriod,
  periodError,
  hasCapability,
  validGrowthReport,
  apiErrorMessage,
  injectStyles,
  renderGrowthReport,
  formValues,
  safePayload,
  createIdempotencyKey,
  createGrowthActions,
  createGrowthConsole
} = require('./platform-growth-ui');

assert.deepEqual(STAGES, ['new', 'contacted', 'qualified', 'demo_scheduled', 'demo_held', 'proposal', 'won', 'lost']);
assert.equal(escapeHtml(`<img onerror="x"> & '`), '&lt;img onerror=&quot;x&quot;&gt; &amp; &#39;');
assert.equal(safeCount(1234), '1,234');
assert.equal(safeCount(-1), 'Unavailable');
assert.equal(safeCount('4'), 'Unavailable');
assert.equal(safePercent(0), '0%');
assert.equal(safePercent(71.234), '71.23%');
assert.equal(safePercent(null), 'Unavailable');
assert.equal(safePercent(101), 'Unavailable');
assert.equal(minorMoney(19900, 'usd'), 'USD 199.00');
assert.equal(minorMoney(3990, 'jpy'), 'JPY 3,990');
assert.equal(minorMoney(12345, 'bhd'), 'BHD 12.345');
assert.equal(minorMoney(1.5, 'usd'), 'Unavailable');
assert.equal(moneyRows([{ currency: 'usd', amountMinor: 19900 }, { currency: 'eur', amountMinor: 5000 }], 1), 'USD 199.00 · EUR 50.00 · 1 not entered');
assert.equal(moneyRows([], 0), 'Not entered');
assert.equal(moneyRows(null), 'Unavailable');
assert.equal(durationMinutes(59.5), '1 hr');
assert.equal(durationMinutes(125), '2 hr 5 min');
assert.equal(durationMinutes(null), 'Unavailable');
assert.deepEqual(defaultPeriod('2026-10-20T12:00:00.000Z'), { start: '2026-10-01', end: '2026-10-20' });
assert.equal(periodError('2026-10-01', '2026-10-20', '2026-10-20'), '');
assert.match(periodError('2026-10-21', '2026-10-20', '2026-10-20'), /start date/);
assert.match(periodError('2026-10-01', '2026-10-21', '2026-10-20'), /future/);
assert.match(periodError('2025-01-01', '2026-10-20', '2026-10-20'), /366/);
assert.equal(hasCapability({ active: true, capabilities: ['growth:read'] }, 'growth:read'), true);
for (const user of [null, { active: false, capabilities: ['growth:read'] }, { active: true }, { active: true, capabilities: ['growth:write'] }]) assert.equal(hasCapability(user, 'growth:read'), false);
assert.equal(apiErrorMessage('SECRET_PROVIDER_ERROR'), 'Growth data is temporarily unavailable. Refresh to try again.');
assert.match(apiErrorMessage('duplicate_opportunity'), /already matches/i);
assert.equal(createIdempotencyKey({ randomUUID: () => '12345678-1234-1234-1234-123456789abc' }), 'growth:12345678-1234-1234-1234-123456789abc');
assert.equal(createIdempotencyKey({ getRandomValues: bytes => bytes.fill(10) }), 'growth:0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a');
assert.throws(() => createIdempotencyKey({}), /Secure random/);

class Element {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase(); this.children = []; this.attrs = {}; this.events = {}; this.dataset = {}; this.style = {};
    this.classes = new Set(); this.hidden = false; this.value = ''; this.type = ''; this.checked = false; this.disabled = false; this.text = '';
    this.classList = { add: (...names) => names.forEach(name => this.classes.add(name)), toggle: (name, on) => on ? this.classes.add(name) : this.classes.delete(name), contains: name => this.classes.has(name) };
  }
  set className(value) { this.classes = new Set(String(value).split(/\s+/).filter(Boolean)); }
  get className() { return [...this.classes].join(' '); }
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return this.text + this.children.map(child => child.textContent).join(' '); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.text = ''; this.children = [...children]; }
  setAttribute(key, value) { this.attrs[key] = String(value); }
  getAttribute(key) { return this.attrs[key]; }
  addEventListener(name, listener) { (this.events[name] ||= []).push(listener); }
  async emit(name, event = {}) { for (const listener of this.events[name] || []) await listener({ preventDefault() {}, target: this, ...event }); }
  dispatchEvent(event) { return this.emit(event.type, event); }
  closest(selector) { return selector === '[data-growth-action]' && this.dataset.growthAction ? this : null; }
}
const descendants = element => [element, ...element.children.flatMap(descendants)];

function fakeDocument(extra = []) {
  const head = new Element('head'), events = {};
  const document = {
    head,
    visibilityState: 'visible',
    createElement: tag => new Element(tag),
    getElementById(id) { return [...extra.flatMap(descendants), ...descendants(head)].find(element => element.id === id) || null; },
    addEventListener(name, listener) { (events[name] ||= []).push(listener); },
    emit(name, event) { for (const listener of events[name] || []) listener(event); }
  };
  return document;
}

function report(start = '2026-10-01', end = '2026-10-20') {
  return {
    status: 'ready',
    asOf: '2026-10-20T18:30:00.000Z',
    period: { startDate: start, endDate: end, timezone: 'UTC' },
    metrics: {
      cohortSize: 3,
      funnel: { new: 3, contacted: 2, qualified: 2, demo_scheduled: 1, demo_held: 1, proposal: 1, won: 1, lost: 0 },
      attribution: {
        source: [{ bucket: '<img src=x onerror=alert(1)>', count: 2 }, { bucket: 'unknown', count: 1 }],
        medium: [{ bucket: 'cpc', count: 2 }, { bucket: 'unknown', count: 1 }],
        campaign: [{ bucket: 'unknown', count: 3 }],
        plan: [{ bucket: 'growth', count: 2 }, { bucket: 'unknown', count: 1 }]
      },
      pipeline: { count: 3, expectedMrr: [{ currency: 'usd', amountMinor: 29800 }, { currency: 'eur', amountMinor: 5000 }], expectedMrrUnknownCount: 1 },
      overdue: { count: 1, items: [{ id: 'opp-1', ownerUserId: 'owner-1', dueAt: '2026-10-19T17:00:00.000Z' }] },
      leaderboard: [
        {
          ownerUserId: 'owner-1', opportunitiesCreated: 2, demosHeld: 1, wins: 1, losses: 0, winRate: 100,
          wonMrr: [{ currency: 'usd', amountMinor: 19900 }], wonMrrUnknownCount: 0,
          responseTime: { respondedCount: 1, awaitingResponseCount: 1, unknownCount: 0, averageMinutes: 35 },
          followUpReliability: { dueCount: 2, completedOnTime: 1, completedLate: 0, overdue: 1, cancelled: 0, rate: 50 }
        },
        {
          ownerUserId: 'unassigned', opportunitiesCreated: 1, demosHeld: 0, wins: 0, losses: 0, winRate: null,
          wonMrr: [], wonMrrUnknownCount: 0,
          responseTime: { respondedCount: 0, awaitingResponseCount: 1, unknownCount: 0, averageMinutes: null },
          followUpReliability: { dueCount: 0, completedOnTime: 0, completedLate: 0, overdue: 0, cancelled: 0, rate: null }
        }
      ]
    },
    opportunities: [
      {
        id: 'opp-1', version: 4, companyName: '<script>alert(1)</script> Concrete', contactName: 'Mia & Sons', ownerUserId: 'owner-1', stage: 'proposal',
        expectedMrrMinor: 19900, currency: 'usd', nextAction: 'Call <today>', nextActionDueAt: '2026-10-19T17:00:00.000Z', attribution: { source: '<svg onload=x>' }, plan: 'Growth'
      },
      {
        id: 'opp-2', version: 1, companyName: 'Unknown Value Builders', contactName: null, ownerUserId: null, stage: 'new', expectedMrrMinor: null,
        currency: null, nextAction: null, nextActionDueAt: null, attribution: { source: null }, plan: null
      }
    ],
    opportunityTotal: 3,
    owners: [{ id: 'owner-1', name: '<img src=x> Sales Rep' }]
  };
}

assert.equal(validGrowthReport(report(), '2026-10-01', '2026-10-20'), true);
assert.equal(validGrowthReport(report(), '2026-10-02', '2026-10-20'), false);
assert.equal(validGrowthReport({ ...report(), opportunities: null }, '2026-10-01', '2026-10-20'), false);
for (const mutate of [
  value => { value.metrics.funnel.new = 999; },
  value => { value.metrics.pipeline.count = -1; },
  value => { value.metrics.overdue.count = 0; },
  value => { value.metrics.leaderboard[1].winRate = 100; },
  value => { value.metrics.attribution.source[0].count = 1; },
  value => { value.metrics.leaderboard[0].followUpReliability.rate = 100; },
  value => { value.metrics.leaderboard[0].responseTime.respondedCount = 0; },
  value => { value.opportunityTotal = 2; }
]) {
  const impossible = structuredClone(report()); mutate(impossible);
  assert.equal(validGrowthReport(impossible, '2026-10-01', '2026-10-20'), false, 'Contradictory nested metrics are rejected instead of rendered as facts');
}

{ // Pure rendering is text-only, honest about unknowns, multi-currency safe and mobile first.
  const root = new Element('main'), document = fakeDocument([root]);
  renderGrowthReport(document, root, report(), { canWrite: true });
  const text = root.textContent;
  assert.match(text, /Growth key performance indicators|New opportunities/);
  assert.match(text, /USD 298\.00 · EUR 50\.00 · 1 not entered/);
  assert.match(text, /Reached stages; no skipped stage is inferred/);
  assert.match(text, /Unknown means the source was not captured/);
  assert.match(text, /<img src=x onerror=alert\(1\)>/);
  assert.match(text, /<script>alert\(1\)<\/script> Concrete/);
  assert.match(text, /Unavailable/);
  assert.match(text, /Measured outcomes only · no activity score/);
  assert.equal(descendants(root).some(item => ['IMG', 'SCRIPT', 'SVG'].includes(item.tagName)), false, 'Untrusted strings only become text nodes');
  assert.equal(descendants(root).filter(item => item.dataset.growthAction === 'edit').length, 2);
  assert.equal(descendants(root).filter(item => item.dataset.growthAction === 'complete_next_action').length, 1);
  assert.match(descendants(root).find(item => item.dataset.growthAction === 'edit').getAttribute('aria-label'), /Edit <script>alert\(1\)<\/script> Concrete/);
  assert.equal(document.head.children.filter(item => item.id === 'pdl-growth-styles').length, 1);
  injectStyles(document);
  assert.equal(document.head.children.filter(item => item.id === 'pdl-growth-styles').length, 1, 'Styles install once');
  assert.match(GROWTH_CSS, /min-height:44px/);
  assert.match(GROWTH_CSS, /@media \(min-width:760px\)/);
  assert.match(GROWTH_CSS, /grid-template-columns:repeat\(2/);
  assert.match(GROWTH_CSS, /\[data-theme="dark"\]/);
}

{ // Long metric lists say exactly what is omitted instead of looking complete.
  const many = report();
  many.metrics.cohortSize = 21;
  many.metrics.funnel.new = 21;
  many.metrics.attribution.source = Array.from({ length: 21 }, (_, index) => ({ bucket: `source-${index + 1}`, count: 1 }));
  for (const key of ['medium', 'campaign', 'plan']) many.metrics.attribution[key] = [{ bucket: 'unknown', count: 21 }];
  many.metrics.leaderboard[0].opportunitiesCreated = 20;
  many.metrics.leaderboard[0].responseTime.awaitingResponseCount = 19;
  const root = new Element('main'), document = fakeDocument([root]);
  renderGrowthReport(document, root, many);
  assert.match(root.textContent, /Showing the first 20 of 21 recorded buckets/);
}

{ // Read-only users see every metric but no mutation affordances.
  const root = new Element('main'), document = fakeDocument([root]);
  renderGrowthReport(document, root, report(), { canWrite: false });
  assert.equal(descendants(root).some(item => item.dataset.growthAction && !item.hidden), false);
  assert.match(root.textContent, /Outcome leaderboard/);
}

{ // Zero denominators and malformed values display as unavailable rather than fabricated percentages.
  const empty = report();
  empty.metrics.cohortSize = 0;
  empty.metrics.funnel = Object.fromEntries(STAGES.map(stage => [stage, 0]));
  empty.metrics.attribution = Object.fromEntries(['source', 'medium', 'campaign', 'plan'].map(key => [key, []]));
  empty.metrics.pipeline = { count: 0, expectedMrr: [], expectedMrrUnknownCount: 0 };
  empty.metrics.overdue = { count: 0, items: [] };
  empty.metrics.leaderboard = [];
  empty.opportunities = [];
  empty.opportunityTotal = 0;
  const root = new Element('main'), document = fakeDocument([root]);
  renderGrowthReport(document, root, empty);
  assert.match(root.textContent, /Conversion unavailable/);
  assert.match(root.textContent, /No measured sales outcomes/);
  assert.match(root.textContent, /No overdue follow-ups/);
  assert.match(root.textContent, /No opportunities match/);
  assert.doesNotMatch(root.textContent, /NaN|Infinity/);
}

{ // Form extraction and payload allowlists prevent accidental mass assignment and non-scalar payloads.
  const controls = {
    companyName: { value: '  North Star  ', type: 'text', disabled: false },
    billingExempt: { checked: true, type: 'checkbox', disabled: false },
    ignored: { value: 'secret', type: 'text', disabled: false },
    disabled: { value: 'skip', type: 'text', disabled: true }
  };
  const form = { elements: { namedItem: name => controls[name] || null } };
  assert.deepEqual(formValues(form, ['companyName', 'billingExempt', 'disabled']), { companyName: 'North Star', billingExempt: true });
  assert.throws(() => formValues(form, ['__proto__']), /Unsafe/);
  assert.deepEqual(safePayload({ companyName: 'A', ownerUserId: null }, ['companyName', 'ownerUserId']), { companyName: 'A', ownerUserId: null });
  assert.throws(() => safePayload({ stage: 'won' }, ['companyName']), /Unsupported/);
  assert.throws(() => safePayload({ companyName: { html: '<b>' } }, ['companyName']), /Invalid/);
}

const actionTests = (async () => { // Mutation hooks use explicit endpoints, encoded IDs, optimistic versions and capability denial.
  const calls = [], changes = [];
  const actions = createGrowthActions({
    canWrite: () => true,
    request: async (path, options) => { calls.push({ path, options, body: JSON.parse(options.body) }); return { ok: true, id: 'opp-1' }; },
    onChanged: async result => changes.push(result)
  });
  await actions.create({ companyName: 'Acme', source: 'website' }, { idempotencyKey: 'growth:test-create-123' });
  await actions.update('opp:1', 2, { ownerUserId: 'sales-1' });
  await actions.transition('opp:1', 3, { stage: 'qualified', reason: 'Confirmed fit' });
  await actions.setNextAction('opp:1', 4, { description: 'Book demo', dueAt: '2026-10-21T17:00:00.000Z' });
  await actions.completeNextAction('opp:1', 5);
  await actions.cancelNextAction('opp:1', 6, 'Customer rescheduled');
  await actions.addNote('opp:1', 7, '<b>Plain text note</b>');
  assert.deepEqual(calls.map(call => call.path), [
    '/api/platform/growth/opportunities',
    '/api/platform/growth/opportunities/opp%3A1',
    '/api/platform/growth/opportunities/opp%3A1/stage',
    '/api/platform/growth/opportunities/opp%3A1/next-action',
    '/api/platform/growth/opportunities/opp%3A1/next-action/complete',
    '/api/platform/growth/opportunities/opp%3A1/next-action/cancel',
    '/api/platform/growth/opportunities/opp%3A1/notes'
  ]);
  assert.equal(calls[1].body.expectedVersion, 2);
  assert.equal(calls[0].options.headers['Idempotency-Key'], 'growth:test-create-123');
  assert.equal(calls[2].body.stage, 'qualified');
  assert.equal(calls[6].body.text, '<b>Plain text note</b>');
  assert.equal(changes.length, 7);

  const denied = createGrowthActions({ request: async () => assert.fail('Request must not run'), canWrite: () => false });
  await assert.rejects(denied.create({ companyName: 'Nope' }, { idempotencyKey: 'growth:denied-123' }), error => error.code === 'growth_write_denied');
  assert.throws(() => actions.update('../secret', 1, { companyName: 'Nope' }), /Invalid opportunity ID/);
  assert.throws(() => actions.update('opp-1', 0, { companyName: 'Nope' }), /Invalid opportunity version/);
  assert.throws(() => actions.create({ companyName: 'Nope', role: 'platform_owner' }, { idempotencyKey: 'growth:reject-123' }), /Unsupported/);
  assert.throws(() => actions.create({ companyName: 'Nope' }), /Invalid idempotency key/);
  assert.throws(() => actions.create({ companyName: 'Nope' }, { idempotencyKey: 'short' }), /Invalid idempotency key/);

  let release;
  const blocked = createGrowthActions({ canWrite: () => true, request: () => new Promise(resolve => { release = resolve; }) });
  const first = blocked.update('opp-lock', 1, { companyName: 'First' });
  await assert.rejects(blocked.update('opp-lock', 1, { companyName: 'Second' }), error => error.code === 'busy');
  release({ ok: true }); await first;
})();

const flush = async () => { await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve)); };

function harness({ access = { id: 'owner-1', active: true, capabilities: ['growth:read', 'growth:write'] }, response = report(), active = true, status = 200, accessStatus = 200, accessFailure = null, accessMalformed = false, onAction = null } = {}) {
  const root = new Element('section'); root.id = 'platform-growth';
  const view = new Element('section'); view.id = 'growth-view'; view.classList.toggle('active', active);
  const document = fakeDocument([root, view]);
  const windowEvents = {}, calls = [], queue = [], redirects = []; let accessValue = access, reportValue = response, responseStatus = status;
  let authStatus = accessStatus, authFailure = accessFailure, authMalformed = accessMalformed;
  const window = { AbortController, CustomEvent: class { constructor(type, init) { this.type = type; Object.assign(this, init); } }, addEventListener(name, listener) { (windowEvents[name] ||= []).push(listener); } };
  const responseOf = (data, code = 200) => ({ ok: code < 400, status: code, json: async () => data });
  const fetch = async (path, options) => {
    calls.push({ path, options });
    const deferred = queue.shift(); if (deferred) return deferred.promise;
    if (path === '/api/platform/auth/me') {
      if (authFailure) throw authFailure;
      if (authMalformed) return { ok: true, status: 200, json: async () => { throw new Error('Malformed JSON'); } };
      return responseOf(accessValue, authStatus);
    }
    if (path.startsWith('/api/platform/growth?')) return responseOf(reportValue, responseStatus);
    throw new Error(`Unexpected endpoint ${path}`);
  };
  const actionsSeen = [];
  const api = createGrowthConsole({ document, window, fetch, AbortController, CustomEvent: window.CustomEvent, now: () => Date.parse('2026-10-20T20:00:00.000Z'), onAuthRequired: destination => redirects.push(destination), onAction: onAction || (detail => actionsSeen.push(detail)) });
  return {
    root, view, document, window, calls, redirects, api, actionsSeen,
    get: id => document.getElementById(id),
    byClass: className => descendants(root).find(item => item.classes.has(className)),
    setAccess: value => { accessValue = value; },
    setAccessStatus: value => { authStatus = value; },
    setAccessFailure: value => { authFailure = value; },
    setAccessMalformed: value => { authMalformed = value; },
    setReport: (value, code = 200) => { reportValue = value; responseStatus = code; },
    emitDocument: (name, event) => document.emit(name, event),
    emitWindow: name => { for (const listener of windowEvents[name] || []) listener(); },
    defer() { let resolve; const promise = new Promise(done => { resolve = done; }); queue.push({ promise }); return (data, code = 200) => resolve(responseOf(data, code)); }
  };
}

(async () => {
  await actionTests;
  { // Read access is deny-by-default; unauthorized users never receive growth data.
    for (const access of [null, { id: 'support', active: true, capabilities: ['support:read'] }, { id: 'owner', active: false, capabilities: ['growth:read'] }]) {
      const h = harness({ access }); await flush(); assert.equal(h.root.hidden, false); assert.equal(h.calls.length, 1);
      assert.match(h.root.textContent, /no longer have access/i);
      assert.equal(descendants(h.root).some(item => item.dataset.growthAction && !item.hidden), false);
    }
  }
  { // Ready state renders, advertises freshness, and exposes actions only to growth writers.
    const h = harness(); await flush();
    assert.equal(h.root.hidden, false); assert.equal(h.calls.length, 2); assert.match(h.root.textContent, /Growth command center/); assert.match(h.root.textContent, /USD 298\.00/);
    assert.match(h.root.textContent, /Growth refreshed as of/); assert.equal(h.root.getAttribute('aria-busy'), 'false');
    const edit = descendants(h.root).find(item => item.dataset.growthAction === 'edit');
    await h.root.emit('click', { target: edit });
    assert.deepEqual(h.actionsSeen[0], { action: 'edit', opportunityId: 'opp-1', version: 4 });
    const readonly = harness({ access: { id: 'cs-1', active: true, capabilities: ['growth:read'] } }); await flush();
    assert.equal(descendants(readonly.root).some(item => item.dataset.growthAction && !item.hidden), false);
    h.setAccess({ id: 'cs-1', active: true, capabilities: ['growth:read'] }); await h.api.refresh();
    assert.equal(descendants(h.root).some(item => item.dataset.growthAction && !item.hidden), false, 'A capability downgrade removes every visible write affordance');
    assert.equal(h.api.emitAction({ action: 'create' }), null, 'Programmatic action emission is also denied after downgrade');
  }
  { // A transient access-service failure shows a safe retry state; only verified denial hides the view.
    for (const options of [
      { accessStatus: 503 },
      { accessFailure: new Error('network down') },
      { accessMalformed: true }
    ]) {
      const h = harness(options); await flush();
      assert.equal(h.root.hidden, false); assert.match(h.root.textContent, /access could not be verified/i);
      assert.equal(descendants(h.root).some(item => item.dataset.growthAction && !item.hidden), false);
      h.setAccessStatus(200); h.setAccessFailure(null); h.setAccessMalformed(false); await h.api.refresh();
      assert.match(h.root.textContent, /Growth refreshed as of/);
    }
    const denied = harness({ accessStatus: 403 }); await flush();
    assert.equal(denied.root.hidden, false); assert.match(denied.root.textContent, /no longer have access/i);
    assert.equal(descendants(denied.root).some(item => item.dataset.growthAction && !item.hidden), false);
    const expired = harness({ accessStatus: 401 }); await flush();
    assert.equal(expired.root.hidden, true); assert.deepEqual(expired.redirects, ['/platform-login.html']);
    const reportDenied = harness({ status: 403 }); await flush();
    assert.equal(reportDenied.root.hidden, false); assert.match(reportDenied.root.textContent, /no longer have access/i);
    const reportExpired = harness({ status: 401 }); await flush();
    assert.equal(reportExpired.root.hidden, true); assert.deepEqual(reportExpired.redirects, ['/platform-login.html']);
  }
  { // Host action failures cannot prevent the public event or become unhandled rejections.
    let eventCount = 0;
    const h = harness({ onAction: () => { throw new Error('host dialog failed'); } }); await flush();
    h.root.addEventListener('pdl:growth-action', () => { eventCount++; });
    const result = h.api.emitAction({ action: 'create' }); await flush();
    assert.equal(result.action, 'create'); assert.equal(eventCount, 1); assert.match(h.root.textContent, /could not be opened/i);

    const rejected = harness({ onAction: async () => { throw new Error('async dialog failed'); } }); await flush();
    rejected.api.emitAction({ action: 'create' }); await flush(); assert.match(rejected.root.textContent, /could not be opened/i);
  }
  { // Unavailable, malformed and server-error responses clear old numbers and use local copy only.
    const h = harness(); await flush();
    h.setReport({ status: 'unavailable', providerError: 'TOP SECRET' }); await h.api.refresh();
    assert.match(h.root.textContent, /not configured/); assert.doesNotMatch(h.root.textContent, /TOP SECRET/);
    h.setReport({ status: 'error', code: 'busy', error: 'DATABASE SECRET' }, 503); await h.api.refresh();
    assert.match(h.root.textContent, /already updating/); assert.doesNotMatch(h.root.textContent, /DATABASE SECRET/);
    h.setReport({ ...report(), metrics: null }); await h.api.refresh();
    assert.match(h.root.textContent, /temporarily unavailable/); assert.doesNotMatch(h.root.textContent, /USD 298\.00/);
  }
  { // Date edits invalidate visible metrics and future periods never call the API.
    const h = harness(); await flush(); const before = h.calls.length;
    h.get('growth-end').value = '2026-10-21'; await h.get('growth-end').emit('input');
    assert.doesNotMatch(h.root.textContent, /USD 298\.00/); await h.api.refresh(); assert.equal(h.calls.length, before); assert.match(h.root.textContent, /future/);
  }
  { // A late response cannot repopulate a view after navigation.
    const h = harness({ active: false });
    const releaseAuth = h.defer(); h.view.classList.add('active'); h.api.sync(); h.view.classList.toggle('active', false); h.api.sync();
    releaseAuth({ id: 'owner', active: true, capabilities: ['growth:read'] }); await flush();
    assert.equal(h.root.hidden, true); assert.equal(h.calls.length, 1);
  }
  { // Logout revokes the controller for the rest of the page lifecycle.
    const h = harness(); await flush(); const before = h.calls.length;
    h.emitDocument('click', { target: { closest: selector => selector === '#platform-logout' ? {} : null } });
    assert.equal(h.root.hidden, true); await h.api.refresh(); assert.equal(h.calls.length, before);
  }
  assert.equal(createGrowthConsole({ document: { getElementById: () => null }, window: {} }), null);

  const source = fs.readFileSync('platform-growth-ui.js', 'utf8');
  assert.doesNotMatch(source, /\.innerHTML\s*=|insertAdjacentHTML|\.outerHTML\s*=|\beval\s*\(|localStorage|sessionStorage/);
  assert.match(source, /growth:read/); assert.match(source, /growth:write/); assert.match(source, /Every API route must independently enforce/);
  console.log('Growth UI: honest metrics, text-only rendering, unknown states, mobile CSS invariants, capability gating, safe action hooks, lifecycle cancellation and local error copy passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
