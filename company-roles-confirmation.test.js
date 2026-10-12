'use strict';
// Actual Company Roles module and recovery journal in a deterministic DOM VM.
// Real typed parsing/planning supplies synthetic preview DTOs. No server/browser,
// production policy, accounts, credentials, external transport or provider calls.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), crypto = require('node:crypto');
const registry = require('./capability-registry'), policy = require('./role-policy-api'), profiles = require('./role-profiles');
const recoveryModule = require('./role-save-recovery'), { workspaceSnapshot } = require('./compat-workspace-fixture');
const source = fs.readFileSync(path.join(__dirname, 'company-roles-ui.js'), 'utf8');
const appSource = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
const actualApi = appSource.split('\n').find(line => line.startsWith('async function api(')); assert.ok(actualApi);
const clone = value => JSON.parse(JSON.stringify(value));
const tests = [], test = (name, run) => tests.push({ name, run });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject, entered: false }; };
const flush = async () => { await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve)); };
const decode = text => String(text).replace(/&(amp|lt|gt|quot|#39);/g, (_, key) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" }[key]));
const dataKey = name => name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
class Element {
  constructor(tag, document) { this.tagName = tag; this.document = document; this.children = []; this.attributes = {}; this.dataset = {}; this.listeners = {}; this._value = ''; this.checked = false; this.disabled = false; this.hidden = false; this._text = ''; }
  get id() { return this.attributes.id || ''; }
  set id(value) { this.setAttribute('id', value); }
  get isConnected() { return this === this.document.body || Boolean(this.parentNode?.isConnected); }
  set value(value) { this._value = String(value); }
  get value() { return this._value; }
  setAttribute(name, value = '') { this.attributes[name] = String(value); if (name.startsWith('data-')) this.dataset[dataKey(name)] = String(value); if (name === 'disabled') this.disabled = true; if (name === 'checked') this.checked = true; if (name === 'value') this.value = value; }
  getAttribute(name) { return this.attributes[name] ?? null; }
  append(...nodes) { for (const node of nodes) { node.remove(); node.parentNode = this; this.children.push(node); } }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(row => row !== this); this.parentNode = null; }
  replaceChildren(...nodes) { for (const child of this.children) child.parentNode = null; this.children = []; this._text = ''; this.append(...nodes); }
  set textContent(value) { this.replaceChildren(); this._text = String(value); }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  set innerHTML(value) { this.replaceChildren(); parse(String(value), this); }
  get innerHTML() { return this.textContent; }
  matches(selector) { if (selector.includes(',')) return selector.split(',').some(part => this.matches(part.trim())); if (selector.startsWith('#')) return this.id === selector.slice(1); const attrs = [...selector.matchAll(/\[([^=\]]+)(?:="([^"]*)")?\]/g)]; if (attrs.length) return attrs.every(([, key, value]) => this.attributes[key] !== undefined && (value === undefined || this.attributes[key] === value)); return this.tagName === selector; }
  closest(selector) { for (let node = this; node; node = node.parentNode) if (node.matches(selector)) return node; return null; }
  querySelectorAll(selector) { const found = []; for (const child of this.children) { if (child.matches(selector)) found.push(child); found.push(...child.querySelectorAll(selector)); } return found; }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  scrollIntoView() {}
  click() { return this.disabled ? Promise.resolve() : this.document.dispatch('click', this); }
}
function parse(html, parent) {
  const stack = [parent], voids = new Set(['input', 'br', 'img', 'hr']);
  for (const match of html.matchAll(/<\/[a-z][^>]*>|<[a-z][^>]*>|[^<]+/gi)) {
    const value = match[0];
    if (value.startsWith('</')) { const tag = value.slice(2, -1).trim(); while (stack.length > 1) { const node = stack.pop(); if (node.tagName === 'textarea') node.value = node.textContent; if (node.tagName === tag) break; } }
    else if (value.startsWith('<')) { const [, tag, attrs] = value.match(/^<([a-z][\w-]*)([\s\S]*?)\/?\s*>$/i), node = new Element(tag, parent.document); for (const attr of attrs.matchAll(/([\w-]+)(?:="([^"]*)")?/g)) node.setAttribute(attr[1], decode(attr[2] || '')); stack.at(-1).append(node); if (!voids.has(tag)) stack.push(node); }
    else { const node = new Element('#text', parent.document); node._text = decode(value); stack.at(-1).append(node); }
  }
}
function documentFixture() {
  const document = { listeners: {}, hidden: false, createElement(tag) { return new Element(tag, this); }, getElementById(id) { return this.body.querySelector('#' + id); }, querySelector(selector) { return this.body.querySelector(selector); }, addEventListener(type, listener) { (this.listeners[type] ||= []).push(listener); },
    async dispatch(type, target) { const event = { target, preventDefault() {}, stopPropagation() {} }, pending = []; for (let node = target; node; node = node.parentNode) for (const listener of node.listeners[type] || []) pending.push(listener(event)); if (target?.isConnected || target === this) for (const listener of this.listeners[type] || []) pending.push(listener(event)); await Promise.all(pending); } };
  document.body = new Element('body', document); return document;
}
function harness({ existing = null, identityOverrides = {}, confirmError = null, managed = 'production' } = {}) {
  const document = documentFixture(), root = document.createElement('section'); root.id = 'company-role-editor'; document.body.append(root);
  const db = workspaceSnapshot(); db.team[0].crew = 'Office';
  const state = { db, revision: 100, policyRevision: 0, now: Date.now(), identityOverrides, identityGates: [], wakeGates: [], identityReads: 0, calls: [], previews: [], deliveredProofs: [], remembers: [], storageWrites: 0, businessCommits: 0, uuidCount: 0, confirmError, receipt: null, httpResponses: new Map(), events: [] };
  const ownerIdentity = () => ({ companyId: state.db.company.id, actorId: 1, role: 'owner', sessionBinding: 'a'.repeat(64), revision: state.revision, locked: false, ...state.identityOverrides });
  const storageValues = new Map(), storage = { getItem: key => storageValues.get(key) ?? null, setItem: (key, value) => { state.storageWrites++; storageValues.set(key, value); } };
  const journal = recoveryModule.create(storage), recovery = { ...journal, remember: (route, record) => { state.remembers.push({ route, record: clone(record) }); journal.remember(route, record); } };
  if (existing) {
    const record = { identity: JSON.stringify([db.company.id, 1, 'owner', 'a'.repeat(64)]), kind: 'confirm', route: existing, path: '/api/company/role-policy/confirm', body: { previewId: '00000000-0000-4000-8000-000000000041', version: 'c'.repeat(64), requestId: '00000000-0000-4000-8000-000000000042', confirmed: true } };
    journal.remember(existing, record); state.existingRecord = clone(record); state.remembers = []; state.storageWrites = 0;
  }
  const currentDefaults = () => Object.fromEntries(registry.families.map(([id, , , , controller]) => [id, Object.fromEntries(controller.roles.map(role => [role, controller.ceiling(role)]))]));
  const profileDto = () => ({ version: 1, tenantRevision: state.revision, policyRevision: policy.configuration(state.db).policyRevision, model: profiles.read(state.db), accounts: [{ id: 2, name: 'Synthetic Field', role: 'field', status: 'Active' }], customDefaults: Object.fromEntries(registry.roles.map(role => [role, profiles.defaults(role)])), officeDefaults: profiles.defaults('admin', true) });
  const backend = async (route, options = {}) => {
    state.calls.push({ route, options: { ...options } });
    if (route === '/api/company/role-capabilities') return registry.describe(state.db);
    if (route === '/api/company/role-policy') return { version: 1, tenantRevision: state.revision, ...policy.configuration(state.db), defaults: currentDefaults() };
    if (route === '/api/company/role-policy/profiles') return profileDto();
    if (route.startsWith('/api/company/role-policy/audit')) return { entries: [], offset: 0, total: 0 };
    if (route.endsWith('/preview')) {
      const raw = JSON.parse(options.body), input = route.includes('/profiles/') ? policy.parseProfilePreview(raw) : policy.parsePreview(raw), proposal = input.profileChange ? { profileChange: input.profileChange } : input.policies;
      const planned = policy.planProposal(state.db, proposal); state.revision++;
      const proof = { previewId: input.requestId, version: 'b'.repeat(64), tenantRevision: state.revision, expiresAt: new Date(state.now + 600000).toISOString(), reason: input.reason, before: policy.configuration(state.db), after: policy.configuration(planned.after), impact: policy.impacts(state.db, planned.after, () => true, state.now), confirmationRequired: true };
      state.previews.push({ proof, snapshot: clone(proof), planned }); return proof;
    }
    if (route === '/api/company/role-policy/confirm') {
      const input = policy.parseConfirm(JSON.parse(options.body));
      if (state.existingRecord) assert.deepEqual(input, state.existingRecord.body, 'Existing recovery replays only its original technical envelope.');
      else { const preview = state.previews.at(-1); assert.equal(input.previewId, preview.snapshot.previewId); assert.equal(input.version, preview.snapshot.version); }
      if (!state.existingRecord && !state.receipt) { state.db = state.previews.at(-1).planned.after; state.revision++; state.businessCommits++; }
      const result = { committed: true, requestId: input.requestId, previewId: input.previewId, version: input.version, policyRevision: policy.configuration(state.db).policyRevision, tenantRevision: state.revision };
      state.receipt = result; if (state.confirmError) throw state.confirmError; return result;
    }
    throw Error('Unexpected synthetic Company Roles request: ' + route);
  };
  const context = { document, currentUser: { id: 1, role: 'owner' }, currentRole: 'office', signedInCompanyId: () => state.identityOverrides.companyId || state.db.company.id, RoleSaveRecovery: recovery, structuredClone, console, location: { href: '/synthetic-current-page' },
    wakeService: async () => { const gate = state.wakeGates.shift(); if (gate) { gate.entered = true; await gate.promise; } },
    fetch: async (route, options) => { assert.equal(options.beforeDispatch, undefined, 'Actual API strips the application callback before fetch.'); assert.equal(options.onAcknowledged, undefined); const forced = state.httpResponses.get(route); if (forced) state.calls.push({ route, options }); const result = forced ? forced.body : await backend(route, options), status = forced?.status || 200; return { ok: status < 400, status, headers: { get: key => key === 'content-type' ? 'application/json' : null }, json: async () => { const value = clone(result); if (route.endsWith('/preview')) state.deliveredProofs.push(value); return value; } }; },
    pdlWorkspaceActions: { enabled: () => managed === 'compat', rolePolicies: () => true, verifyResponse: async () => {} },
    crypto: { randomUUID: () => `00000000-0000-4000-8000-${String(++state.uuidCount).padStart(12, '0')}` }, setInterval: () => 0,
    Date: class extends Date { constructor(...args) { super(...(args.length ? args : [state.now])); } static now() { return state.now; } },
    pdlProductionRoles: { enabled: () => managed === 'production', identity: async () => { state.identityReads++; const gate = state.identityGates.shift(); if (gate) { gate.entered = true; await gate.promise; } return ownerIdentity(); } },
    listeners: {}, addEventListener(type, listener) { (this.listeners[type] ||= []).push(listener); } };
  context.pdlWorkspaceActions.identity = context.pdlProductionRoles.identity;
  for (const [client, name] of [[context.pdlProductionRoles, 'production'], [context.pdlWorkspaceActions, 'compat']]) client.clear = () => { state.events.push(name + '.clear'); context.PDLCompanyRoles.retire(); context.currentUser = null; };
  context.window = context; vm.createContext(context); vm.runInContext(actualApi, context, { filename: 'app.js:actual-base-api' }); context.workspaceApi = context.api; vm.runInContext(source, context, { filename: 'company-roles-ui.js' });
  const query = selector => root.querySelector(selector), click = selector => { const node = query(selector); assert.ok(node, 'Existing UI control: ' + selector); return node.click(); };
  const change = async (selector, checked) => { const node = query(selector); assert.ok(node); node.checked = checked; await document.dispatch('change', node); };
  const event = async type => { for (const listener of context.listeners[type] || []) await listener(); };
  const hold = (position = 1) => { for (let n = 1; n < position; n++) state.identityGates.push(null); const gate = deferred(); state.identityGates.push(gate); return gate; };
  const holdWake = () => { const gate = deferred(); state.wakeGates.push(gate); return gate; };
  const confirms = () => state.calls.filter(row => row.route === '/api/company/role-policy/confirm');
  const review = async (mode = 'roles') => { await context.PDLCompanyRoles.open(); if (mode === 'profiles') { await click('[data-role-mode="profiles"]'); await click('[data-role-command="office"]'); } else await change('[data-role-family="scheduling"][data-role="admin"][data-role-action="create"]', false); const reason = query('#role-change-reason'); reason.value = 'Synthetic confirmed intent ' + mode; await document.dispatch('input', reason); await click('[data-role-command="preview"]'); assert.ok(query('#role-explicit-confirm')); assert.equal(query('#role-explicit-confirm').checked, false); await change('#role-explicit-confirm', true); };
  return { state, root, context, document, recovery, journal, storageValues, query, click, change, event, hold, holdWake, confirms, review, ownerIdentity };
}

for (const mode of ['roles', 'profiles']) {
  test(mode + ' positive current checked preview sends one exact confirmation and acknowledges its technical journal', async () => {
    const h = harness(); await h.review(mode); const preview = h.state.previews[0].snapshot; await h.click('[data-role-command="confirm"]'); assert.equal(h.confirms().length, 1); assert.equal(h.state.businessCommits, 1); const body = JSON.parse(h.confirms()[0].options.body); assert.equal(body.previewId, preview.previewId); assert.equal(body.version, preview.version); assert.equal(body.confirmed, true); assert.equal(h.state.remembers.length, 1); assert.equal(h.state.remembers[0].route, mode === 'profiles' ? 'role-profiles' : 'roles'); assert.deepEqual(h.journal.entries(), []); assert.match(h.root.textContent, /Saved policy revision/);
  });
  test(mode + ' unchecked confirmation never starts a save or recovery record', async () => {
    const h = harness(); await h.review(mode); await h.change('#role-explicit-confirm', false); await h.click('[data-role-command="confirm"]'); assert.equal(h.confirms().length, 0); assert.equal(h.state.remembers.length, 0); assert.deepEqual(h.journal.entries(), []);
  });
  for (const [name, invalidate] of [
    ['unchecked control', h => h.change('#role-explicit-confirm', false)],
    ['blur', h => h.event('blur')],
    ['hidden tab', async h => { h.document.hidden = true; await h.document.dispatch('visibilitychange', h.document); }],
    ['retire', h => h.context.PDLCompanyRoles.retire()],
    ['hidden editor', h => { h.root.hidden = true; }],
    ['changed session', h => { h.state.identityOverrides.sessionBinding = 'd'.repeat(64); }],
    ['changed company', h => { h.state.identityOverrides.companyId = 'synthetic-other-company'; }],
    ['changed actor', h => { h.state.identityOverrides.actorId = 2; }],
    ['locked account', h => { h.state.identityOverrides.locked = true; }],
    ['changed revision', h => { h.state.revision++; }],
    ['proof identity', h => { h.state.deliveredProofs[0].previewId = '00000000-0000-4000-8000-000000000099'; }],
    ['proof version', h => { h.state.deliveredProofs[0].version = 'e'.repeat(64); }],
    ['proof impact', h => { h.state.deliveredProofs[0].impact.changedAccounts++; }],
    ['expired proof', h => { h.state.now += 600001; }],
  ]) test(mode + ' changed ' + name + ' during initial identity await cannot dispatch or journal a new confirmation', async () => {
    const h = harness(); await h.review(mode); const gate = h.hold(), saving = h.click('[data-role-command="confirm"]'); await flush(); assert.equal(gate.entered, true); await invalidate(h); gate.resolve(); await saving; assert.equal(h.confirms().length, 0); assert.equal(h.state.businessCommits, 0); assert.equal(h.state.remembers.length, 0); assert.deepEqual(h.journal.entries(), []);
  });
  test(mode + ' locks mode/back controls before identity await and ignores a second confirmation', async () => {
    const h = harness(); await h.review(mode); const gate = h.hold(), saving = h.click('[data-role-command="confirm"]'); await flush(); assert.equal(h.query('[data-role-command="confirm"]').disabled, true); assert.equal(h.query('[data-role-command="edit"]').disabled, true); assert.equal(h.query('[data-role-mode="roles"]').disabled, true); assert.equal(h.query('[data-role-mode="profiles"]').disabled, true); const identityReads = h.state.identityReads; await h.click('[data-role-command="confirm"]'); await h.click('[data-role-command="edit"]'); await h.click('[data-role-mode="' + (mode === 'roles' ? 'profiles' : 'roles') + '"]'); assert.equal(h.state.identityReads, identityReads); assert.equal(h.state.remembers.length, 0); gate.resolve(); await saving; assert.equal(h.confirms().length, 1); assert.equal(h.state.businessCommits, 1); assert.equal(h.state.remembers.length, 1);
  });
  for (const [name, invalidate] of [
    ['unchecked control', h => h.change('#role-explicit-confirm', false)],
    ['blur', h => h.event('blur')],
    ['hidden tab', async h => { h.document.hidden = true; await h.document.dispatch('visibilitychange', h.document); }],
    ['retire', h => h.context.PDLCompanyRoles.retire()],
    ['hidden editor', h => { h.root.hidden = true; }],
    ['proof version', h => { h.state.deliveredProofs[0].version = 'e'.repeat(64); }],
    ['proof impact', h => { h.state.deliveredProofs[0].impact.changedAccounts++; }],
    ['expired proof', h => { h.state.now += 600001; }],
  ]) test(mode + ' changed ' + name + ' while actual wakeService awaits cannot fetch or journal an intent', async () => {
    const h = harness(); await h.review(mode); const gate = h.holdWake(), saving = h.click('[data-role-command="confirm"]'); await flush(); assert.equal(gate.entered, true); assert.equal(h.confirms().length, 0); assert.equal(h.state.remembers.length, 0); assert.deepEqual(h.journal.entries(), []); await invalidate(h); gate.resolve(); await saving; assert.equal(h.confirms().length, 0); assert.equal(h.state.businessCommits, 0); assert.equal(h.state.remembers.length, 0); assert.deepEqual(h.journal.entries(), []);
  });
  test(mode + ' pending wake locks back/mode/double-confirm and dispatches only the original checked review', async () => {
    const h = harness(); await h.review(mode); const proof = clone(h.state.previews[0].snapshot), gate = h.holdWake(), saving = h.click('[data-role-command="confirm"]'); await flush(); assert.equal(gate.entered, true); assert.equal(h.query('[data-role-command="confirm"]').disabled, true); assert.equal(h.query('[data-role-command="edit"]').disabled, true); assert.equal(h.query('[data-role-mode="profiles"]').disabled, true); await h.click('[data-role-command="confirm"]'); await h.click('[data-role-command="edit"]'); await h.click('[data-role-mode="profiles"]'); assert.equal(h.confirms().length, 0); assert.equal(h.state.remembers.length, 0); gate.resolve(); await saving; assert.equal(h.confirms().length, 1); const body = JSON.parse(h.confirms()[0].options.body); assert.equal(body.previewId, proof.previewId); assert.equal(body.version, proof.version); assert.equal(h.state.businessCommits, 1); assert.equal(h.state.remembers.length, 1); assert.deepEqual(h.journal.entries(), []);
  });
  for (const [name, invalidate] of [['blur', h => h.event('blur')], ['retire', h => h.context.PDLCompanyRoles.retire()]]) test(mode + ' changed ' + name + ' at any second pre-dispatch identity await cannot create a request or leave a new recovery record', async () => {
    const h = harness(); await h.review(mode); const gate = h.hold(2), saving = h.click('[data-role-command="confirm"]'); await flush(); assert.equal(gate.entered, true);
    if (h.confirms().length === 0) { await invalidate(h); gate.resolve(); await saving; assert.equal(h.confirms().length, 0); assert.equal(h.state.businessCommits, 0); assert.deepEqual(h.journal.entries(), []); }
    else { gate.resolve(); await saving; assert.equal(h.confirms().length, 1, 'If no second pre-dispatch await exists, only the already-admitted original confirmation can execute.'); assert.equal(h.state.businessCommits, 1); }
  });
}
for (const route of ['roles', 'role-profiles']) {
  test(route + ' existing recovery remains exact original body when the editor view changes', async () => {
    const h = harness({ existing: route }); await h.context.PDLCompanyRoles.open(); const original = clone(h.state.existingRecord.body); await h.click('[data-role-mode="profiles"]'); await h.click('[data-role-mode="roles"]'); await h.click('[data-role-command="recover"]'); assert.equal(h.confirms().length, 1); assert.deepEqual(JSON.parse(h.confirms()[0].options.body), original); assert.equal(h.state.remembers.length, 0); assert.equal(h.state.businessCommits, 0); assert.deepEqual(h.journal.entries(), []);
  });
  test(route + ' retired editor during recovery identity await sends nothing and preserves original journal', async () => {
    const h = harness({ existing: route }); await h.context.PDLCompanyRoles.open(); const original = clone(h.journal.entries()), gate = h.hold(), checking = h.click('[data-role-command="recover"]'); await flush(); h.context.PDLCompanyRoles.retire(); gate.resolve(); await checking; assert.equal(h.confirms().length, 0); assert.deepEqual(h.journal.entries(), original); assert.equal(h.state.uuidCount, 0); assert.equal(h.state.remembers.length, 0);
  });
  test(route + ' changed session cannot replay original receipt as a new permission intent', async () => {
    const h = harness({ existing: route }); await h.context.PDLCompanyRoles.open(); const original = clone(h.journal.entries()), gate = h.hold(), checking = h.click('[data-role-command="recover"]'); await flush(); h.state.identityOverrides.sessionBinding = 'f'.repeat(64); gate.resolve(); await checking; assert.equal(h.confirms().length, 0); assert.equal(h.state.uuidCount, 0); assert.equal(h.state.remembers.length, 0); assert.equal(h.journal.entries()[0].requestId, original[0].requestId); assert.equal(h.journal.entries()[0].previewId, original[0].previewId); assert.equal(h.journal.entries()[0].version, original[0].version);
  });
  test(route + ' retire during actual recovery wake sends nothing and keeps original technical custody', async () => {
    const h = harness({ existing: route }); await h.context.PDLCompanyRoles.open(); const original = clone(h.journal.entries()), gate = h.holdWake(), checking = h.click('[data-role-command="recover"]'); await flush(); assert.equal(gate.entered, true); h.context.PDLCompanyRoles.retire(); gate.resolve(); await checking; assert.equal(h.confirms().length, 0); assert.deepEqual(h.journal.entries(), original); assert.equal(h.state.remembers.length, 0); assert.equal(h.state.businessCommits, 0);
  });
}
test('an uncertain dispatched confirmation keeps one original technical envelope and recovers without a new request ID or policy commit', async () => {
  const h = harness({ confirmError: Object.assign(Error('Synthetic lost acknowledgement'), { status: 503 }) }); await h.review(); await h.click('[data-role-command="confirm"]'); assert.equal(h.confirms().length, 1); assert.equal(h.state.remembers.length, 1); const original = JSON.parse(h.confirms()[0].options.body), journal = clone(h.journal.entries()); assert.equal(journal.length, 1); assert.equal(h.state.businessCommits, 1); h.state.confirmError = null; await h.click('[data-role-command="recover"]'); assert.equal(h.confirms().length, 2); assert.deepEqual(JSON.parse(h.confirms()[1].options.body), original); assert.equal(h.state.remembers.length, 1); assert.equal(h.state.businessCommits, 1, 'A technical receipt replay never applies the policy again.'); assert.deepEqual(h.journal.entries(), []);
});
for (const managed of ['production', 'compat']) {
  test(managed + ' actual API401 clears private checked review before blocked redirect and retains typed expired status', async () => {
    const h = harness({ managed }); await h.review(); const oldConfirm = h.query('[data-role-command="confirm"]'); assert.equal(oldConfirm.disabled, false); const storageBefore = h.state.storageWrites;
    h.state.httpResponses.set('/api/synthetic-expired-session', { status: 401, body: { error: 'Synthetic expired owner session' } });
    Object.defineProperty(h.context.location, 'href', { configurable: true, get: () => '/unchanged', set() { h.state.events.push('blocked.redirect'); assert.equal(h.root.textContent, '', 'Private review is removed before navigation.'); assert.equal(h.query('#role-explicit-confirm'), null); throw Object.assign(Error('Synthetic navigation blocked'), { name: 'SecurityError' }); } });
    await assert.rejects(h.context.api('/api/synthetic-expired-session'), failure => failure.status === 401 && failure.code === 'PDL_SESSION_EXPIRED');
    assert.deepEqual(h.state.events, [managed + '.clear', 'blocked.redirect']); assert.equal(h.root.textContent, ''); assert.equal(h.context.currentUser, null); await oldConfirm.click(); assert.equal(h.confirms().length, 0); assert.equal(h.state.remembers.length, 0); assert.equal(h.state.storageWrites, storageBefore); assert.deepEqual(h.journal.entries(), []);
  });
  test(managed + ' API401 retirement preserves an existing original recovery record without creating new custody', async () => {
    const h = harness({ managed, existing: 'role-profiles' }); await h.context.PDLCompanyRoles.open(); const original = clone(h.journal.entries()), storageBefore = h.state.storageWrites;
    h.state.httpResponses.set('/api/synthetic-expired-session', { status: 401, body: { error: 'Synthetic expired owner session' } });
    Object.defineProperty(h.context.location, 'href', { configurable: true, set() { h.state.events.push('blocked.redirect'); throw Error('Synthetic navigation blocked'); } });
    await assert.rejects(h.context.api('/api/synthetic-expired-session'), failure => failure.status === 401 && failure.code === 'PDL_SESSION_EXPIRED'); assert.deepEqual(h.state.events, [managed + '.clear', 'blocked.redirect']); assert.equal(h.root.textContent, ''); assert.deepEqual(h.journal.entries(), original); assert.equal(h.state.remembers.length, 0); assert.equal(h.state.storageWrites, storageBefore); assert.equal(h.confirms().length, 0);
  });
}

(async () => {
  let failed = 0; for (const { name, run } of tests) { try { await run(); } catch (error) { failed++; console.error('FAIL:', name); console.error(error); } }
  console.log(JSON.stringify({ passed: failed === 0, checks: tests.length, failed, syntheticOnly: true, runtime: 'Actual Company Roles module, app API and recovery journal; typed preview plans; parsed DOM VM', sourceSha256: crypto.createHash('sha256').update(source).digest('hex'), appSourceSha256: crypto.createHash('sha256').update(appSource).digest('hex'), actualApiSha256: crypto.createHash('sha256').update(actualApi).digest('hex'), externalCalls: 0, providerCalls: 0, productionPolicyWrites: 0 })); if (failed) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
