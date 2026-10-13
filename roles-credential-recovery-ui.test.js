'use strict';
// Actual UI module in a deterministic DOM/VM. Transport is synthetic only;
// no browser, network, account changes, credentials, provider or email delivery.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), crypto = require('node:crypto');
const source = fs.readFileSync(path.join(__dirname, 'roles-credential-recovery-ui.js'), 'utf8');
const tests = [], test = (name, run) => tests.push({ name, run });
const clone = value => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const flush = async () => { await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve)); };
const decode = text => String(text).replace(/&(amp|lt|gt|quot|#39);/g, (_, key) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" }[key]));
const dataKey = name => name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
class Element {
  constructor(tag, document) { this.tagName = tag; this.document = document; this.children = []; this.attributes = {}; this.dataset = {}; this.listeners = {}; this.value = ''; this.checked = false; this.disabled = false; this.open = false; this._text = ''; }
  get isConnected() { return this === this.document.body || Boolean(this.parentNode?.isConnected); }
  setAttribute(name, value = '') { this.attributes[name] = String(value); if (name.startsWith('data-')) this.dataset[dataKey(name)] = String(value); if (name === 'disabled') this.disabled = true; if (name === 'value') this.value = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  append(...nodes) { for (const node of nodes) { node.remove(); node.parentNode = this; this.children.push(node); } }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(row => row !== this); this.parentNode = null; }
  replaceChildren(...nodes) { for (const child of this.children) child.parentNode = null; this.children = []; this._text = ''; this.append(...nodes); }
  set textContent(value) { this.replaceChildren(); this._text = String(value); }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  set innerHTML(value) { this.replaceChildren(); parse(String(value), this); }
  get innerHTML() { return this.children.map(child => child.tagName === '#text' ? child._text : '<' + child.tagName + '>' + child.innerHTML + '</' + child.tagName + '>').join(''); }
  matches(selector) { if (selector.includes(',')) return selector.split(',').some(part => this.matches(part.trim())); if (selector.startsWith('#')) return this.attributes.id === selector.slice(1); const match = /^\[([^=\]]+)(?:="([^"]*)")?\]$/.exec(selector); return match ? this.attributes[match[1]] !== undefined && (match[2] === undefined || this.attributes[match[1]] === match[2]) : this.tagName === selector; }
  closest(selector) { for (let node = this; node; node = node.parentNode) if (node.matches(selector)) return node; return null; }
  querySelectorAll(selector) { const found = []; for (const child of this.children) { if (child.matches(selector)) found.push(child); found.push(...child.querySelectorAll(selector)); } return found; }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  showModal() { this.open = true; }
  close() { if (!this.open) return; this.open = false; this.document.queuedCloses.push(() => this.document.dispatch('close', this)); }
  click() { return this.disabled ? Promise.resolve() : this.document.dispatch('click', this); }
}
function parse(html, parent) {
  const stack = [parent], voids = new Set(['input', 'br', 'img', 'hr']);
  for (const match of html.matchAll(/<\/[a-z][^>]*>|<[a-z][^>]*>|[^<]+/gi)) {
    const value = match[0];
    if (value.startsWith('</')) { const tag = value.slice(2, -1).trim(); while (stack.length > 1) if (stack.pop().tagName === tag) break; }
    else if (value.startsWith('<')) { const [, tag, attrs] = value.match(/^<([a-z][\w-]*)([\s\S]*?)\/?\s*>$/i), node = new Element(tag, parent.document); for (const attr of attrs.matchAll(/([\w-]+)(?:="([^"]*)")?/g)) node.setAttribute(attr[1], decode(attr[2] || '')); stack.at(-1).append(node); if (!voids.has(tag)) stack.push(node); }
    else { const node = new Element('#text', parent.document); node._text = decode(value); stack.at(-1).append(node); }
  }
}
function documentFixture() {
  const document = {
    listeners: {}, queuedCloses: [], createElement(tag) { return new Element(tag, this); }, addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }, querySelector: selector => document.body.querySelector(selector), querySelectorAll: selector => document.body.querySelectorAll(selector),
    async dispatch(type, target) { const event = { target, preventDefault() {}, stopPropagation() {} }, promises = []; for (let node = target; node; node = node.parentNode) { if (typeof node['on' + type] === 'function') promises.push(node['on' + type](event)); for (const listener of node.listeners[type] || []) promises.push(listener(event)); } if (target.isConnected) for (const listener of this.listeners[type] || []) promises.push(listener(event)); await Promise.all(promises); },
    async flushClose() { for (const close of this.queuedCloses.splice(0)) await close(); },
  };
  document.body = new Element('body', document); return document;
}
const attempts = () => [
  { id: 'synthetic-attempt-a', operationId: 'synthetic-operation-a', accountId: 2, kind: 'email', purpose: 'password-reset', status: 'unknown', token: 'PRIVATE_LINK_TOKEN', secret: 'PRIVATE_PROVIDER_KEY' },
  { id: 'synthetic-attempt-b', operationId: 'synthetic-operation-b', accountId: 3, kind: 'email', purpose: 'email-verification', status: 'unknown' },
  { id: 'synthetic-invalidated', operationId: 'synthetic-operation-c', accountId: 4, kind: 'email', purpose: 'password-reset', status: 'unknown', invalidated: true },
  { id: 'synthetic-sent', accountId: 5, kind: 'email', purpose: 'password-reset', status: 'sent' },
  { id: 'synthetic-other-provider', kind: 'upload', status: 'unknown' },
];
function harness({ companyRole = 'owner', platformRole = 'platform_owner', lostAck = false, receipt = 'complete' } = {}) {
  const document = documentFixture(), calls = [], notices = [], gates = { list: [], preview: [], confirm: [], receipt: [], identity: [] };
  const state = { company: { companyId: 'synthetic-company-a', actorId: 1, role: companyRole, sessionBinding: 'synthetic-current-session' }, platform: { id: 71, role: platformRole, email: 'synthetic-platform@example.invalid' }, list: attempts(), receipt, lostAck, confirmations: 0, requestId: null, identityCalls: 0 };
  const currentIdentity = async platform => { state.identityCalls++; const gate = gates.identity.shift(); if (gate) await gate.promise; return clone(platform ? state.platform : state.company); };
  const transport = async (route, options = {}) => {
    calls.push({ route, options: clone(options) });
    if (route === '/api/platform/auth/me') return currentIdentity(true);
    if (/provider-operations$/.test(route)) { const gate = gates.list.shift(); return gate ? gate.promise : clone(state.list); }
    if (route.endsWith('/invalidation/preview')) {
      const body = JSON.parse(options.body); if (!body.reason?.trim()) throw Object.assign(Error('A reason is required.'), { status: 400 }); const gate = gates.preview.shift(); if (gate) return gate.promise;
      return { proof: 'synthetic-server-preview-proof', accountId: 2, expectedRevision: 7, consequence: 'Invalidate this exact account link. Original delivery remains unknown.' };
    }
    if (route.endsWith('/invalidation/confirm')) { const body = JSON.parse(options.body); assert.equal(body.proof, 'synthetic-server-preview-proof'); assert.equal(body.confirmed, true); state.confirmations++; state.requestId = body.requestId; const gate = gates.confirm.shift(); if (gate) await gate.promise; if (state.lostAck) throw Object.assign(Error('Synthetic lost acknowledgement'), { status: 503 }); return { saved: true }; }
    if (route.endsWith('/invalidation')) { const gate = gates.receipt.shift(); if (gate) return gate.promise; if (state.receipt === 'unavailable') throw Object.assign(Error('Synthetic receipt unavailable'), { status: 503 }); return state.receipt === 'pending' ? { found: false } : { found: true, requestId: state.receipt === 'other' ? 'other-request-id' : state.requestId, invalidatedAt: '2026-10-12T12:00:00.000Z', reason: 'Synthetic reviewed reason', actorId: 1 }; }
    throw Error('Unexpected synthetic request: ' + route);
  };
  const context = { document, workspaceApi: transport, api: transport, crypto: { randomUUID: () => '00000000-0000-4000-8000-000000000051' }, pdlProductionRoles: { identity: () => currentIdentity(false) }, toast: message => notices.push(message), fetch: async () => { throw Error('Network forbidden in credential UI fixture'); }, console };
  context.window = context; vm.createContext(context); vm.runInContext(source, context, { filename: 'roles-credential-recovery-ui.js' });
  const dialog = () => document.querySelector('dialog');
  const query = selector => dialog()?.querySelector(selector);
  const defer = kind => { const gate = deferred(); gates[kind].push(gate); return gate; };
  const click = selector => { const node = query(selector); assert.ok(node, 'Visible control exists: ' + selector); return node.click(); };
  const open = platform => context.PDLCredentialRecovery.open({ platform: Boolean(platform) });
  const select = async (id = 'synthetic-attempt-a') => { await click('[data-attempt="' + id + '"]'); };
  const preview = async (reason = 'Synthetic reviewed reason') => { await select(); query('[data-reason]').value = reason; await click('[data-action="preview"]'); };
  const confirm = async () => { const checkbox = query('[data-confirm]'); assert.ok(checkbox); checkbox.checked = true; await document.dispatch('change', checkbox); await click('[data-action="confirm"]'); };
  return { state, context, calls, notices, document, dialog, query, defer, click, open, select, preview, confirm, confirms: () => calls.filter(row => row.route.endsWith('/invalidation/confirm')), previews: () => calls.filter(row => row.route.endsWith('/invalidation/preview')), receipts: () => calls.filter(row => row.route.endsWith('/invalidation')), message: () => query('[data-message]')?.textContent || '' };
}

for (const platform of [false, true]) {
  const scope = platform ? 'platform' : 'company', prefix = '/api/' + scope + '/provider-operations';
  test(scope + ' existing delegated entry opens only its finite uncertain links without token/provider data', async () => {
    const h = harness(), entry = h.document.createElement('button'); entry.setAttribute('data-credential-recovery', scope); h.document.body.append(entry); await entry.click(); await flush(); assert.equal(h.dialog().open, true); assert.equal(h.query('[data-links]').querySelectorAll('[data-attempt]').length, 3); assert.equal(h.query('[data-attempt="synthetic-invalidated"]').disabled, true); assert.ok(h.calls.some(row => row.route === prefix)); assert.ok(!h.document.body.textContent.includes('PRIVATE_LINK_TOKEN')); assert.ok(!h.document.body.textContent.includes('PRIVATE_PROVIDER_KEY')); assert.ok(!h.document.body.textContent.includes('synthetic-sent'));
  });
  test(scope + ' preview carries reviewed reason; checkbox refusal makes no confirmation; explicit checked action makes one POST and read-only receipt', async () => {
    const h = harness(); await h.open(platform); await h.preview(); assert.equal(JSON.parse(h.previews()[0].options.body).reason, 'Synthetic reviewed reason'); assert.equal(h.previews()[0].route, prefix + '/synthetic-attempt-a/invalidation/preview'); assert.match(h.query('[data-preview]').textContent, /exact account link/); assert.match(h.query('[data-preview]').textContent, /Current revision 7/);
    assert.equal(h.query('[data-confirm]').checked, false); assert.equal(h.query('[data-action="confirm"]').disabled, true); await h.click('[data-action="confirm"]'); assert.equal(h.confirms().length, 0); await h.confirm(); assert.equal(h.confirms().length, 1); assert.equal(h.receipts().length, 1); assert.equal(h.state.confirmations, 1); assert.match(h.query('[data-preview]').textContent, /Original review 00000000/); assert.match(h.message(), /delivery remains unknown/i);
  });
  test(scope + ' lost confirmation ACK recovers original receipt without repeating the POST', async () => {
    const h = harness({ lostAck: true }); await h.open(platform); await h.preview(); await h.confirm(); assert.equal(h.confirms().length, 1); assert.equal(h.state.confirmations, 1); assert.equal(h.receipts().length, 1); assert.match(h.message(), /Saved/); assert.equal(h.query('[data-action="confirm"]'), null);
  });
  for (const receipt of ['pending', 'unavailable', 'other']) test(scope + ' ' + receipt + ' receipt retains original confirmation; explicit lookup never submits it again', async () => {
    const h = harness({ lostAck: true, receipt }); await h.open(platform); await h.preview(); await h.confirm(); assert.equal(h.confirms().length, 1); assert.ok(h.query('[data-action="lookup"]')); assert.match(h.query('[data-preview]').textContent, /will not be submitted again/); await h.click('[data-action="lookup"]'); assert.equal(h.confirms().length, 1); assert.equal(h.receipts().length, 2); await h.select('synthetic-attempt-b'); assert.equal(h.previews().length, 1); assert.match(h.message(), /Read the original confirmation/); h.state.receipt = 'complete'; await h.click('[data-action="lookup"]'); assert.equal(h.confirms().length, 1); assert.equal(h.receipts().length, 3); assert.match(h.message(), /delivery remains unknown/i);
  });
  test(scope + ' changed current actor before confirmation blocks business mutation', async () => {
    const h = harness(); await h.open(platform); await h.preview(); if (platform) h.state.platform.id = 72; else h.state.company.actorId = 2; await h.confirm(); assert.equal(h.confirms().length, 0); assert.match(h.message(), /Current Owner account changed/);
  });
  test(scope + ' late uncertain-link list after account change cannot render old account links', async () => {
    const h = harness(), wait = h.defer('list'), opening = h.open(platform); await flush(); if (platform) h.state.platform.id = 72; else h.state.company.companyId = 'synthetic-company-b'; wait.resolve(attempts()); await opening; assert.equal(h.query('[data-attempt]'), null); assert.match(h.message(), /Current Owner account changed/);
  });
  test(scope + ' late preview after close initiation cannot render a confirm control before the native close event', async () => {
    const h = harness(); await h.open(platform); await h.select(); h.query('[data-reason]').value = 'Synthetic reason'; const wait = h.defer('preview'), previewing = h.click('[data-action="preview"]'); await flush(); const dialog = h.dialog(); dialog.close(); assert.equal(dialog.isConnected, true); wait.resolve({ proof: 'synthetic-server-preview-proof', accountId: 2, expectedRevision: 7, consequence: 'STALE PREVIEW MUST NOT RENDER' }); await previewing; assert.equal(dialog.querySelector('[data-confirm]'), null); assert.ok(!dialog.textContent.includes('STALE PREVIEW MUST NOT RENDER')); await h.document.flushClose(); assert.equal(dialog.isConnected, false);
  });
  test(scope + ' close during confirmation identity await prevents the old confirmation POST', async () => {
    const h = harness(); await h.open(platform); await h.preview(); const wait = h.defer('identity'), confirming = h.confirm(); await flush(); const dialog = h.dialog(); dialog.close(); assert.equal(dialog.isConnected, true); wait.resolve(); await confirming; assert.equal(h.confirms().length, 0); await h.document.flushClose(); assert.equal(dialog.isConnected, false);
  });
}
for (const role of ['admin', 'project_manager', 'foreman', 'field', 'platform_owner']) test('company recovery rejects fixed non-Owner role ' + role + ' before mounting or provider list', async () => {
  const h = harness({ companyRole: role }); await assert.rejects(h.open(false), /Current Owner access required/); assert.equal(h.dialog(), null); assert.equal(h.calls.length, 0);
});
for (const role of ['platform_admin', 'owner', 'admin', 'field']) test('platform recovery rejects role ' + role + ' before mounting or provider list', async () => {
  const h = harness({ platformRole: role }); await assert.rejects(h.open(true), /Current Owner access required/); assert.equal(h.dialog(), null); assert.equal(h.calls.filter(row => /provider-operations/.test(row.route)).length, 0);
});
test('empty reason displays server rejection and offers no confirmation control', async () => {
  const h = harness(); await h.open(false); await h.select(); await h.click('[data-action="preview"]'); assert.match(h.message(), /reason is required/); assert.equal(h.query('[data-action="confirm"]'), null); assert.equal(h.confirms().length, 0);
});
test('preview reason is rendered as literal text without creating a markup or script element', async () => {
  const h = harness(); await h.open(false); const text = 'Synthetic <img src=x onerror=alert(1)> <script>secret()</script>'; await h.preview(text); assert.ok(h.query('[data-preview]').textContent.includes(text)); assert.equal(h.dialog().querySelector('img'), null); assert.equal(h.dialog().querySelector('script'), null);
});
test('current account session or role change after preview blocks confirmation without widening editable role flags', async () => {
  for (const change of [h => { h.state.company.sessionBinding = 'synthetic-new-session'; }, h => { h.state.company.role = 'admin'; h.state.company.permissions = { credentialRecovery: true }; }]) { const h = harness(); await h.open(false); await h.preview(); change(h); await h.confirm(); assert.equal(h.confirms().length, 0); assert.match(h.message(), /Owner/); }
});

(async () => {
  let failed = 0; for (const { name, run } of tests) { try { await run(); } catch (error) { failed++; console.error('FAIL:', name); console.error(error); } }
  console.log(JSON.stringify({ passed: failed === 0, checks: tests.length, failed, syntheticOnly: true, runtime: 'Node VM with parsed DOM, bubbling events and queued native-like dialog close', sourceSha256: crypto.createHash('sha256').update(source).digest('hex'), externalCalls: 0, providerCalls: 0, realCredentialChanges: 0, realEmailDelivery: 0 })); if (failed) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
