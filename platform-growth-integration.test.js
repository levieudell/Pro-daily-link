'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const {
  TRANSITIONS,
  CSS,
  minorUnitsFromInput,
  minorUnitsToInput,
  localDateTime,
  isoDateTime,
  safeUrl,
  errorMessage,
  commonPayload,
  createGrowthIntegration
} = require('./platform-growth-integration');

assert.deepEqual(TRANSITIONS.proposal, ['demo_held', 'won', 'lost']);
assert.deepEqual(TRANSITIONS.won, []);
assert.equal(minorUnitsFromInput('199.00', 'USD'), 19900);
assert.equal(minorUnitsFromInput('3990', 'jpy'), 3990);
assert.equal(minorUnitsFromInput('12.345', 'bhd'), 12345);
assert.equal(minorUnitsFromInput('', ''), null);
assert.throws(() => minorUnitsFromInput('10.001', 'usd'), /no more than 2/);
assert.throws(() => minorUnitsFromInput('10', ''), /amount and a three-letter/);
assert.equal(minorUnitsToInput(19900, 'usd'), '199.00');
assert.equal(minorUnitsToInput(12345, 'bhd'), '12.345');
assert.equal(safeUrl('/pricing', { relative: true }), '/pricing');
assert.equal(safeUrl('https://example.com/from?q=1'), 'https://example.com/from?q=1');
assert.throws(() => safeUrl('javascript:alert(1)'), /safe http/);
assert.throws(() => safeUrl('https://user:secret@example.com'), /embedded credentials/);
assert.match(localDateTime('2026-10-20T18:30:00.000Z'), /^2026-10-20T/);
assert.equal(isoDateTime('2026-10-20T12:30'), new Date('2026-10-20T12:30').toISOString());
assert.equal(errorMessage(Object.assign(new Error('DATABASE PASSWORD'), { code: 'busy' })), 'This update is already running. Wait a moment and try again.');
assert.doesNotMatch(errorMessage(new Error('DATABASE PASSWORD')), /DATABASE PASSWORD/);

const baseValues = {
  companyName: '  Acme Concrete ', contactName: ' Pat ', email: ' PAT@EXAMPLE.COM ', phone: '(503) 555-1212',
  ownerUserId: '', source: ' Website ', medium: '', campaign: '', referrer: 'https://example.com/ref', landingPage: '/pricing',
  plan: ' Growth ', expectedMrr: '199.00', currency: 'USD', linkedCompanyId: '', nextAction: 'Call Pat',
  nextActionDueAt: '2026-10-21T09:30', note: '<script>plain text only</script>'
};
assert.deepEqual(commonPayload(baseValues, { includeNextAction: true, includeNote: true }), {
  companyName: 'Acme Concrete', contactName: 'Pat', email: 'pat@example.com', phone: '(503) 555-1212', ownerUserId: null,
  source: 'Website', medium: null, campaign: null, referrer: 'https://example.com/ref', landingPage: '/pricing', plan: 'Growth',
  expectedMrrMinor: 19900, currency: 'usd', linkedCompanyId: null, nextAction: 'Call Pat',
  nextActionDueAt: new Date('2026-10-21T09:30').toISOString(), note: '<script>plain text only</script>'
});
assert.throws(() => commonPayload({ ...baseValues, companyName: '', contactName: '', email: '', phone: '' }), /Add a company/);
assert.throws(() => commonPayload({ ...baseValues, email: 'bad' }), /valid email/);
assert.throws(() => commonPayload({ ...baseValues, phone: '123' }), /valid phone/);
assert.throws(() => commonPayload({ ...baseValues, nextActionDueAt: '' }, { includeNextAction: true }), /both a description and due date/);

class Element {
  constructor(tag, document) {
    this.tagName = String(tag).toUpperCase(); this.ownerDocument = document; this.children = []; this.attrs = {}; this.events = {}; this.classes = new Set();
    this.hidden = false; this.disabled = false; this.required = false; this.open = false; this.value = ''; this.type = ''; this.name = ''; this.text = '';
  }
  set className(value) { this.classes = new Set(String(value).split(/\s+/).filter(Boolean)); }
  get className() { return [...this.classes].join(' '); }
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return this.text + this.children.map(child => child.textContent).join(' '); }
  append(...items) { this.children.push(...items); }
  replaceChildren(...items) { this.text = ''; this.children = [...items]; }
  setAttribute(name, value) { this.attrs[name] = String(value); if (name === 'open') this.open = true; }
  getAttribute(name) { return this.attrs[name]; }
  removeAttribute(name) { delete this.attrs[name]; if (name === 'open') this.open = false; }
  addEventListener(name, listener) { (this.events[name] ||= []).push(listener); }
  removeEventListener(name, listener) { this.events[name] = (this.events[name] || []).filter(item => item !== listener); }
  async emit(name, extra = {}) { for (const listener of this.events[name] || []) await listener({ preventDefault() {}, key: '', shiftKey: false, ...extra }); }
  focus() { this.ownerDocument.activeElement = this; }
  showModal() { this.open = true; this.attrs.open = ''; }
  close() { this.open = false; delete this.attrs.open; }
  remove() { this.ownerDocument.body.children = this.ownerDocument.body.children.filter(item => item !== this); }
  checkValidity() { return true; }
  reportValidity() { this.reported = true; }
}

const descendants = element => [element, ...element.children.flatMap(descendants)];
function fakeDocument() {
  const listeners = {};
  const document = {
    activeElement: null,
    createElement(tag) { return new Element(tag, document); },
    getElementById(id) { return [...descendants(document.head), ...descendants(document.body)].find(item => item.id === id) || null; },
    addEventListener(name, listener) { (listeners[name] ||= []).push(listener); },
    removeEventListener(name, listener) { listeners[name] = (listeners[name] || []).filter(item => item !== listener); },
    async emit(name, detail) { for (const listener of listeners[name] || []) await listener(detail); }
  };
  document.head = new Element('head', document); document.body = new Element('body', document);
  return document;
}

const opportunity = {
  id: 'opp-1', version: 4, stage: 'proposal', companyName: '<img onerror=alert(1)> Builders', contactName: 'Mia',
  email: 'mia@example.com', phone: '5035551212', ownerUserId: 'owner-1', plan: 'Growth', expectedMrrMinor: 19900, currency: 'usd',
  linkedCompanyId: null, nextAction: 'Send proposal', nextActionDueAt: '2026-10-21T17:00:00.000Z',
  attribution: { source: '<svg onload=x>', medium: 'email', campaign: null, referrer: null, landingPage: '/pricing' }
};

function setup(overrides = {}) {
  const document = fakeDocument(), calls = [], keys = []; let createNumber = 0, releaseUpdate;
  const updateGate = overrides.blockUpdate ? new Promise(resolve => { releaseUpdate = resolve; }) : null;
  const actions = {
    async create(payload, options) { calls.push({ action: 'create', payload, options }); if (createNumber++ === 0 && overrides.failFirstCreate) throw new Error('SECRET PROVIDER FAILURE'); return { id: 'new' }; },
    async update(id, version, payload) { calls.push({ action: 'update', id, version, payload }); if (updateGate) await updateGate; },
    async transition(id, version, payload) { calls.push({ action: 'transition', id, version, payload }); },
    async setNextAction(id, version, payload) { calls.push({ action: 'next', id, version, payload }); },
    async completeNextAction(id, version) { calls.push({ action: 'complete', id, version }); },
    async addNote(id, version, value) { calls.push({ action: 'note', id, version, value }); }
  };
  const growthConsole = { actions, getOpportunity: id => id === 'opp-1' ? structuredClone(opportunity) : null, getOwners: () => [{ id: 'owner-1', name: '<Admin>' }] };
  const ui = { createIdempotencyKey() { const key = `growth:test-key-${keys.length + 1}`; keys.push(key); return key; } };
  const window = { PDLGrowthConsole: growthConsole, PDLGrowthUI: ui };
  const integration = createGrowthIntegration({ document, window, ui, growthConsole });
  const form = descendants(integration.dialog).find(item => item.tagName === 'FORM');
  const input = name => descendants(integration.dialog).find(item => item.name === name);
  return { document, window, integration, calls, keys, form, input, releaseUpdate };
}

(async () => {
  { // Create validates locally, keeps entries on failure, and reuses its idempotency key for an unchanged retry.
    const h = setup({ failFirstCreate: true });
    assert.equal(h.integration.open({ action: 'create', opportunityId: null, version: null }), true);
    assert.match(h.integration.dialog.textContent, /Capture only what you know/);
    await h.form.emit('submit'); assert.match(h.integration.dialog.textContent, /Add a company/); assert.equal(h.calls.length, 0);
    h.input('companyName').value = '<script>Acme</script>';
    h.input('expectedMrr').value = '199.00'; h.input('currency').value = 'usd'; h.input('note').value = '<img onerror=alert(1)>';
    await h.form.emit('submit');
    assert.equal(h.calls.length, 1); assert.equal(h.integration.dialog.hidden, false); assert.doesNotMatch(h.integration.dialog.textContent, /SECRET PROVIDER/);
    assert.equal(descendants(h.integration.dialog).some(item => ['SCRIPT', 'IMG', 'SVG'].includes(item.tagName)), false);
    await h.form.emit('submit');
    assert.equal(h.calls.length, 2); assert.equal(h.calls[0].options.idempotencyKey, h.calls[1].options.idempotencyKey); assert.equal(h.keys.length, 1);
    assert.equal(h.integration.dialog.hidden, true); assert.equal(h.calls[1].payload.expectedMrrMinor, 19900);
  }

  { // Editing is prefilled and uses the optimistic version from the clicked card.
    const h = setup(); h.integration.open({ action: 'edit', opportunityId: 'opp-1', version: 4 });
    assert.equal(h.input('companyName').value, opportunity.companyName); assert.match(h.integration.dialog.textContent, /<img onerror=alert\(1\)> Builders/);
    h.input('companyName').value = 'Safer Builders'; await h.form.emit('submit');
    assert.deepEqual({ action: h.calls[0].action, id: h.calls[0].id, version: h.calls[0].version, companyName: h.calls[0].payload.companyName }, { action: 'update', id: 'opp-1', version: 4, companyName: 'Safer Builders' });
  }

  { // Stage loss requires a reason and sends only the stage fields.
    const h = setup(); h.integration.open({ action: 'stage', opportunityId: 'opp-1', version: 4 });
    h.input('stage').value = 'lost'; await h.input('stage').emit('change'); await h.form.emit('submit');
    assert.match(h.integration.dialog.textContent, /loss reason/i); assert.equal(h.calls.length, 0);
    h.input('lossReason').value = 'Budget changed'; await h.form.emit('submit');
    assert.deepEqual(h.calls[0], { action: 'transition', id: 'opp-1', version: 4, payload: { stage: 'lost', reason: null, lossReason: 'Budget changed' } });
  }

  { // Replacing a follow-up requires an explicit reason and timezone-aware due date.
    const h = setup(); h.integration.open({ action: 'next_action', opportunityId: 'opp-1', version: 4 });
    assert.equal(h.input('description').value, 'Send proposal'); await h.form.emit('submit'); assert.equal(h.calls.length, 0);
    h.input('replaceReason').value = 'Customer requested Friday'; await h.form.emit('submit');
    assert.equal(h.calls[0].action, 'next'); assert.equal(h.calls[0].payload.replaceReason, 'Customer requested Friday'); assert.match(h.calls[0].payload.dueAt, /Z$/);
  }

  { // Notes and completion have working submit paths; there are no decorative CTAs.
    const note = setup(); note.integration.open({ action: 'note', opportunityId: 'opp-1', version: 4 }); note.input('text').value = '<b>Called customer</b>'; await note.form.emit('submit');
    assert.deepEqual(note.calls[0], { action: 'note', id: 'opp-1', version: 4, value: '<b>Called customer</b>' });
    const complete = setup(); complete.integration.open({ action: 'complete_next_action', opportunityId: 'opp-1', version: 4 }); await complete.form.emit('submit');
    assert.deepEqual(complete.calls[0], { action: 'complete', id: 'opp-1', version: 4 });
  }

  { // The public event opens the dialog, and a pending save disables controls and rejects double submit.
    const eventDriven = setup();
    await eventDriven.document.emit('pdl:growth-action', { detail: { action: 'note', opportunityId: 'opp-1', version: 4 } });
    assert.equal(eventDriven.integration.dialog.hidden, false); assert.match(eventDriven.integration.dialog.textContent, /Notes become part/);

    const h = setup({ blockUpdate: true }); h.integration.open({ action: 'edit', opportunityId: 'opp-1', version: 4 }); h.input('companyName').value = 'Busy Builders';
    const pending = h.form.emit('submit'); await Promise.resolve();
    assert.equal(h.integration.dialog.getAttribute('aria-busy'), 'true'); assert.equal(h.input('companyName').disabled, true); assert.equal(h.calls.length, 1);
    await h.form.emit('submit'); assert.equal(h.calls.length, 1, 'A double submit cannot start a second write');
    h.releaseUpdate(); await pending; assert.equal(h.integration.dialog.hidden, true);
  }

  { // Missing/stale controller state gives a recoverable dialog rather than a dead click.
    const h = setup(); assert.equal(h.integration.open({ action: 'edit', opportunityId: 'missing', version: 1 }), false);
    assert.equal(h.integration.dialog.hidden, false); assert.match(h.integration.dialog.textContent, /no longer in the loaded pipeline/i);
    assert.equal(h.integration.open({ action: 'made_up' }), false);
  }

  assert.match(CSS, /min-height:44px/); assert.match(CSS, /focus-visible/); assert.match(CSS, /\[data-theme="dark"\]/);
  const source = fs.readFileSync('platform-growth-integration.js', 'utf8');
  assert.doesNotMatch(source, /\.innerHTML\s*=|insertAdjacentHTML|\.outerHTML\s*=|\beval\s*\(|localStorage|sessionStorage/);
  console.log('Growth integration: accessible working dialogs, validation, optimistic writes, safe errors, text-only rendering and retry-stable create idempotency passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
