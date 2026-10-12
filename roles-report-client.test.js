'use strict';
// Deterministic client VM fixtures only: actual form collector and app wrappers,
// fake transport/FileReader, no browser, listener, database, provider or upload.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), crypto = require('node:crypto');
const intake = require('./roles-report-intake');
const { workspaceSnapshot } = require('./compat-workspace-fixture');
const appSource = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
const clientSource = fs.readFileSync(path.join(__dirname, 'roles-report-client.js'), 'utf8');
const client = require('./roles-report-client');
const Recovery = require('./original-operation-recovery');
const { A, B } = require('./compat-account-fixture');
const clone = value => JSON.parse(JSON.stringify(value));
const tests = [], test = (name, run) => tests.push({ name, run });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const flush = async () => { await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve)); };
async function until(predicate) { const end = Date.now() + 3000; while (!predicate()) { assert.ok(Date.now() < end, 'Actual asynchronous journal/transport stage did not arrive.'); await flush(); } }
const actualLine = prefix => { const line = appSource.split('\n').find(row => row.startsWith(prefix)); assert.ok(line, 'Missing actual app source: ' + prefix); return line; };
const atomicStart = appSource.indexOf('let atomicPhotoStatus=');
assert.ok(atomicStart > 0, 'Actual report/photo transaction wrapper must exist.');

class Node {
  constructor(tag, document) { this.tagName = tag; this.document = document; this.children = []; this.attributes = {}; this.dataset = {}; this.listeners = {}; this.value = ''; this.name = ''; this.type = 'text'; this.checked = false; this.files = []; this.open = false; this.hidden = false; this.disabled = false; this.style = {}; this._text = ''; }
  set id(value) { this.attributes.id = String(value); this.document.ids.set(String(value), this); }
  get id() { return this.attributes.id || ''; }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(row => row.textContent).join(''); }
  set innerHTML(value) { this._text = String(value).replace(/<[^>]+>/g, ''); this.children = []; for (const match of String(value).matchAll(/<([a-z][\w-]*)([^>]*)>/gi)) { const child = new Node(match[1], this.document); for (const attr of match[2].matchAll(/([\w-]+)(?:="([^"]*)")?/g)) child.setAttribute(attr[1], attr[2] || ''); this.append(child); } }
  get innerHTML() { return this._text; }
  get classList() { return { add() {}, remove() {}, toggle() {}, contains: () => false }; }
  setAttribute(key, value) { if (key === 'id') this.id = value; else this.attributes[key] = String(value); if (key.startsWith('data-')) this.dataset[key.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = String(value); }
  getAttribute(key) { return this.attributes[key] ?? null; }
  append(...nodes) { for (const node of nodes) { if (node.parentNode) node.parentNode.children = node.parentNode.children.filter(row => row !== node); node.parentNode = this; this.children.push(node); } }
  prepend(node) { node.parentNode = this; this.children.unshift(node); }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(row => row !== this); if (this.id) this.document.ids.delete(this.id); }
  replaceChildren(...nodes) { this.children = []; this._text = ''; this.append(...nodes); }
  insertAdjacentHTML(position, text) { assert.equal(position, 'beforeend'); const node = new Node('div', this.document); node.innerHTML = text; this.append(node); }
  matches(selector) { if (selector.includes(',')) return selector.split(',').some(part => this.matches(part.trim())); if (selector.startsWith('#')) return this.id === selector.slice(1); const attr = /^\[([^=\]]+)(?:="([^"]*)")?\]$/.exec(selector); return attr ? this.attributes[attr[1]] !== undefined && (attr[2] === undefined || this.attributes[attr[1]] === attr[2]) : this.tagName === selector; }
  querySelectorAll(selector) { const rows = []; for (const node of this.children) { if (node.matches(selector)) rows.push(node); rows.push(...node.querySelectorAll(selector)); } return rows; }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  async click() { if (this.disabled) return; const event = { target: this, preventDefault() {}, stopImmediatePropagation() {} }; for (const fn of this.listeners.click || []) await fn(event); return this.onclick?.(event); }
  showModal() { this.open = true; }
  close() { this.open = false; }
}
function documentFixture() {
  const document = { ids: new Map(), createElement(tag) { return new Node(tag, this); }, getElementById(id) { return this.ids.get(id) || null; }, querySelector(selector) { return selector.startsWith('#') ? this.getElementById(selector.slice(1)) : this.body.querySelector(selector); }, querySelectorAll(selector) { return this.body.querySelectorAll(selector); }, addEventListener() {} };
  document.body = document.createElement('body'); return document;
}
const image = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from('synthetic-client-image')]);
const photo = overrides => ({ name: 'synthetic.png', type: 'image/png', size: image.length, lastModified: 7, dataURL: 'data:image/png;base64,' + image.toString('base64'), ...overrides });
const identity = () => ({ companyId: A, actorId: 2, role: 'field', sessionBinding: 'a'.repeat(64) });
function harness({ files = [], editing = null, normal = true, extracted = {}, transport, deferEncoding = false } = {}) {
  const document = documentFixture(), messages = [], calls = [], state = { identity: identity(), encoded: 0, encodingCallbacks: [], standaloneUploads: 0, originalCreates: 0, sequence: 0, rendered: [], identityCalls: 0, retired: 0 };
  const field = (id, value = '') => { const node = document.createElement(id.includes('modal') ? 'dialog' : 'input'); node.id = id; node.value = value; document.body.append(node); return node; };
  for (const [id, value] of Object.entries({ 'report-project': '0', 'report-date': '2026-10-12', 'report-language': 'en-US', 'field-notes': 'Synthetic installed wall tile', 'report-signature': 'Synthetic Field', 'report-crew': 'Synthetic Crew', 'report-summary': 'Synthetic reviewed summary', 'report-next': 'Synthetic next step', 'report-weather': 'Clear', 'report-temperature': '70', 'report-materials': 'Synthetic tile', 'report-equipment': 'Synthetic lift', 'report-delays': 'Synthetic access delay', 'report-safety': 'Synthetic controlled edge', 'report-type': 'daily', 'report-photo-tags': ' FIELD, field, SYNTHETIC ', 'project-search': '' })) field(id, value);
  const photoField = field('report-photos'); photoField.files = files; photoField.type = 'file'; const modal = field('report-modal'); modal.open = true;
  for (const node of [...document.body.children]) if (node !== modal && node.id !== 'project-search') modal.append(node);
  field('report-sent-modal'); field('report-sent-summary'); const saveButton = field('save-report'); saveButton.tagName = 'button'; saveButton.textContent = 'Submit';
  const productionInputs = Object.fromEntries(Object.entries({ '.production-item': '1', '.custom-description': '', '.production-quantity': '10', '.production-unit': 'SF', '.production-hours': '2' }).map(([key, value]) => [key, { value }]));
  const production = { dataset: {}, querySelector: selector => productionInputs[selector] || null }, labor = { dataset: { laborMember: '12' }, value: '2' };
  const db = workspaceSnapshot(); db.projects.push({ ...clone(db.projects[0]), id: 102, name: 'Synthetic other project' });
  const storage = new Map();
  const context = {
    console, document, crypto: { randomUUID: () => `00000000-0000-4000-8000-${String(++state.sequence).padStart(12, '0')}` },
    $: selector => document.querySelector(selector), $$: selector => selector === '.production-entry' ? [production] : selector === '[data-labor-member]' ? [labor] : [],
    projects: clone(db.projects), reports: editing ? [clone(db.reports[0])] : [], photos: [], company: { id: A }, currentUser: { id: 2, name: 'Synthetic Field', role: 'field' }, currentRole: 'field',
    editingReportId: editing, extractedDraft: clone(extracted), reportSourceAssignmentId: null, reportAnalyzeSequence: 1, activeNoteLaborEvidence: null,
    signedInCompanyId: () => context.company.id, timeCardsOn: () => false, templatesOn: () => false,
    reportLaborTotals: () => ({ crew: 2, allocated: 2, balanced: true }), noteLaborUnassigned: () => 0, reportLaborReviewWarnings: () => [], dailyTemplatePayload: () => ({}), reportWorkSuggestions: () => [],
    offlineReportDraftKey: project => 'synthetic-project-' + (project ?? 0), offlineReportStorageKey: key => key, localStorage: { get length() { return storage.size; }, key: index => [...storage.keys()][index] ?? null, removeItem: key => storage.delete(key), setItem: (key, value) => storage.set(key, value), getItem: key => storage.get(key) ?? null }, sessionStorage: { removeItem: key => storage.delete(key), setItem: (key, value) => storage.set(key, value), getItem: key => storage.get(key) ?? null },
    showReportMessage: message => messages.push(message), notify: message => messages.push(message), renderReports: id => state.rendered.push(id), renderProjectCards() {}, showPage() {}, syncActionCenter: async () => {}, reportWorkDate: report => report.dateIso,
    uploadPhotos: async options => { if (options.files.length) state.standaloneUploads++; return []; },
    fetch: async () => { throw Error('External transport forbidden'); },
    FileReader: class { readAsDataURL(file) { state.encoded++; this.result = file.dataURL; if (deferEncoding) state.encodingCallbacks.push(() => this.onload()); else queueMicrotask(() => this.onload()); } },
    pdlProductionRoles: { enabled: () => normal, identity: async () => { state.identityCalls++; return clone(state.identity); }, clear: () => { state.retired++; } }, pdlWorkspaceActions: { enabled: () => false },
    OriginalOperationRecovery: { create: get => Recovery.create(get, { crypto: crypto.webcrypto }) },
    openReport: report => { state.openedReport = clone(report); document.getElementById('report-modal').open = true; }, loadRole: async () => {}, signedInUserId: () => context.currentUser.id,
  };
  context.window = context;
  const completed = (report = {}) => ({ operationId: calls.find(row => row.options.headers?.['X-PDL-Operation'])?.options.headers['X-PDL-Operation'], complete: true, state: 'complete', retryAllowed: false, reportId: editing || 51, intake: { state: 'complete', complete: true, retryAllowed: false }, report: { id: editing || 51, projectId: 101, dateIso: '2026-10-12', status: 'Needs review', notes: 'Synthetic installed wall tile', ...(state.lastReport || {}), ...report }, files: [{ id: 71, reportId: editing || 51, projectId: 101, caption: 'Daily report field photos' }] });
  const api = async (route, options = {}) => {
    const call = { route, options: clone(options) }; calls.push(call);
    if (transport) return transport(call, { state, context, completed, db, calls });
    if (route.startsWith('/api/company/report-intakes/')) return completed();
    if (/^\/api\/reports(?:\/\d+)?$/.test(route)) {
      const body = JSON.parse(options.body), compound = Object.hasOwn(body, 'report');
      const parsed = compound ? intake.parseCompound(body, db, options.method, route).operation : intake.normalizeReport(body, db, { action: options.method === 'PATCH' ? 'editReport' : 'createReport', ...(options.method === 'PATCH' ? { id: editing } : {}) });
      state.originalCreates++; const report = { id: editing || 51, ...parsed.details, projectId: 101 }; state.lastReport = clone(report);
      return compound ? { ...completed(report), complete: undefined } : report;
    }
    throw Error('Unexpected client request: ' + route);
  };
  context.api = api; context.apiBeforeTemplatePhotoTransaction = api;
  vm.createContext(context);
  vm.runInContext(clientSource, context, { filename: 'roles-report-client.js' });
  vm.runInContext(actualLine('async function encodeFiles(') + '\n' + actualLine('const photoTags=') + '\n' + actualLine('async function saveDailyReport('), context, { filename: 'app.js:actual-normal-form' });
  vm.runInContext('const apiBeforeSuperintendent=api;\n' + actualLine('api=async function(url,options={})'), context, { filename: 'app.js:actual-superintendent-api' });
  context.apiBeforeTemplatePhotoTransaction = context.api;
  vm.runInContext(appSource.slice(atomicStart), context, { filename: 'app.js:actual-report-photo-wrapper' });
  return { context, state, calls, messages, db, document, completed, storage, journal: () => Recovery.create(context.localStorage, { crypto: crypto.webcrypto }), field: id => document.getElementById(id), save: status => context.saveDailyReport(status), mutations: () => calls.filter(row => ['POST', 'PATCH', 'DELETE'].includes(row.options.method)), lookups: () => calls.filter(row => row.route.startsWith('/api/company/report-intakes/')) };
}

test('finite projection drops account, policy, history, financial and raw extraction bindings', () => {
  const raw = { project: 0, projectId: 101, status: 'Draft', notes: 'Synthetic notes', signature: 'Synthetic Field', role: 'owner', permissions: { everything: true }, companyId: 'other', actorId: 1, history: [{ action: 'Approved' }], rateSnapshot: { laborRate: 999 }, originalLanguage: 'es', englishTranslation: 'Synthetic translated text', extracted: { summary: 'Synthetic summary', originalLanguage: 'es', englishTranslation: 'Synthetic translated text', status: 'Approved', projectId: 999, role: 'owner', permission: true, nested: {} } };
  assert.deepEqual(client.body(raw), { project: 0, projectId: 101, status: 'Draft', notes: 'Synthetic notes', signature: 'Synthetic Field', englishTranslation: 'Synthetic translated text', extracted: { summary: 'Synthetic summary', originalLanguage: 'es', englishTranslation: 'Synthetic translated text' } });
  assert.deepEqual(client.text({ summary: {}, labor: 4, next: 'Synthetic next', warning: 'Synthetic warning' }), { next: 'Synthetic next', warning: 'Synthetic warning' });
});
test('finite projection preserves all seven Superintendent and nine observation fields', () => {
  const raw = { reportType: 'superintendent', safetyItems: [{ observation: 'Synthetic edge', location: 'Synthetic north stair', company: 'Synthetic employer', notified: 'Synthetic contact', action: 'Synthetic guard', owner: 'Synthetic follow-up', dueDate: '2026-10-13', status: 'verified', verification: 'Synthetic evidence' }], safetyTalk: 'Synthetic discussion', safetyTalkAttendees: 'Synthetic attendees', safetyInspection: 'Synthetic inspection', safetyIncident: 'Synthetic near miss', noSafetyObservations: false };
  assert.deepEqual(client.body(raw, { status: 'Needs review' }), { ...raw, status: 'Needs review', extracted: {} });
});
test('form fingerprint reads actual finite report controls and changes with unsaved text, checked state and selected file facts', () => {
  const h = harness({ files: [photo()] }), root = h.field('report-modal'), before = client.form(root);
  assert.ok(JSON.parse(before).some(row => row[0] === 'field-notes' && row[3] === 'Synthetic installed wall tile'));
  h.field('field-notes').value = 'Synthetic changed notes'; assert.notEqual(client.form(root), before); h.field('field-notes').value = 'Synthetic installed wall tile'; assert.equal(client.form(root), before);
  h.field('report-photos').files = [photo({ size: 99 })]; assert.notEqual(client.form(root), before); h.field('report-photos').files = [photo()];
  h.field('report-signature').checked = true; assert.notEqual(client.form(root), before); h.field('report-signature').checked = false;
  h.field('project-search').value = 'Unrelated outside form'; assert.equal(client.form(root), before);
});
test('actual new form projection is accepted by normal server parser and retains reviewed field text', async () => {
  const h = harness({ extracted: { labor: '2 hours', quantity: '10 SF', issue: 'Synthetic issue', originalLanguage: 'es', englishTranslation: 'Synthetic translated notes', role: 'owner', actorId: 999, rateSnapshot: { laborRate: 999 }, productions: [{ raw: 'provider' }] } });
  await h.save('Needs review'); assert.equal(h.messages.length, 0); assert.equal(h.mutations().length, 1); const body = JSON.parse(h.mutations()[0].options.body);
  assert.equal(body.projectId, 101); assert.equal(body.status, 'Needs review'); assert.equal(body.signature, 'Synthetic Field'); assert.equal(body.notes, 'Synthetic installed wall tile'); assert.equal(body.extracted.originalLanguage, 'es'); assert.equal(body.extracted.role, undefined); assert.equal(body.role, undefined); assert.equal(body.actorId, undefined); assert.equal(body.rateSnapshot, undefined);
  const parsed = intake.normalizeReport(body, h.db); assert.equal(parsed.details.noteLanguage, 'es'); assert.equal(parsed.details.englishTranslation, 'Synthetic translated notes'); assert.equal(parsed.details.productionEntries[0].quantity, 10); assert.equal(parsed.details.laborEntries[0].memberId, 12); assert.equal(h.field('report-modal').open, false);
});
test('actual edit form uses current saved binding and one PATCH without create', async () => {
  const h = harness({ editing: 1 }); await h.save('Draft'); assert.equal(h.messages.length, 1); assert.equal(h.messages[0], 'Daily report draft saved'); assert.deepEqual(h.mutations().map(row => [row.route, row.options.method]), [['/api/reports/1', 'PATCH']]); assert.equal(h.context.reports.length, 1);
});
test('normal Superintendent no-photo edit must not chain a second safety mutation', async () => {
  const h = harness({ editing: 1, extracted: { reportType: 'superintendent', safetyItems: [], safetyTalk: 'Synthetic discussion', safetyTalkAttendees: 'Synthetic attendees', safetyInspection: 'Synthetic inspection', safetyIncident: '', noSafetyObservations: true } });
  await h.save('Draft'); assert.deepEqual(h.mutations().map(row => row.route), ['/api/reports/1']); const body = JSON.parse(h.mutations()[0].options.body); assert.deepEqual(body.files, []); assert.equal(body.report.safetyTalkAttendees, 'Synthetic attendees'); assert.equal(h.context.reports[0].safetyTalkAttendees, 'Synthetic attendees'); assert.equal(h.state.encoded, 0);
});
test('actual form with selected photos sends one compound final-status intent and no standalone upload or status PATCH', async () => {
  const h = harness({ files: [photo()] }); await h.save('Needs review'); assert.equal(h.messages.length, 0); assert.equal(h.mutations().length, 1); const call = h.mutations()[0], body = JSON.parse(call.options.body);
  assert.equal(call.route, '/api/reports'); assert.match(call.options.headers['X-PDL-Operation'], /^[a-f0-9-]{36}$/); assert.equal(body.report.status, 'Needs review'); assert.equal(body.report.signature, 'Synthetic Field'); assert.deepEqual(body.tags, ['field', 'synthetic']); assert.equal(body.files.length, 1); assert.equal(h.state.encoded, 1); assert.equal(h.state.standaloneUploads, 0); assert.equal(h.context.photos.length, 1); assert.equal(h.context.photos[0].reportId, 51); assert.equal(h.field('report-modal').open, false);
});
test('compound edit retains edit route and cannot create a replacement report', async () => {
  const h = harness({ files: [photo()], editing: 1 }); await h.save('Draft'); assert.deepEqual(h.mutations().map(row => [row.route, row.options.method]), [['/api/reports/1', 'PATCH']]); assert.equal(JSON.parse(h.mutations()[0].options.body).report.status, 'Draft'); assert.equal(h.context.reports.length, 1); assert.equal(h.state.standaloneUploads, 0);
});
function uncertain({ lookup = 'pending', files = [photo()], editing = null } = {}) {
  return harness({ files, editing, transport: async (call, h) => {
    if (call.route.startsWith('/api/company/report-intakes/')) { if (lookup instanceof Error) throw lookup; return lookup === 'complete' ? h.completed() : { operationId: call.route.split('/').at(-1), reportId: editing || 51, complete: false, retryAllowed: false, state: 'pending' }; }
    if (call.options.headers?.['X-PDL-Operation']) { h.state.originalCreates++; throw Object.assign(Error('Synthetic lost acknowledgement'), { status: 503, code: 'synthetic_ack_lost' }); }
    throw Error('Unexpected resend or upload: ' + call.route);
  } });
}
test('lost ACK immediately reads the original operation and applies completed result without repeating save or upload', async () => {
  const h = uncertain({ lookup: 'complete' }); await h.save('Needs review'); assert.equal(h.mutations().length, 1); assert.equal(h.lookups().length, 2); assert.equal(h.state.originalCreates, 1); assert.equal(h.state.encoded, 1); assert.equal(h.state.standaloneUploads, 0); assert.equal(h.context.reports.length, 1); assert.equal(h.context.photos.length, 1); assert.equal(h.field('report-modal').open, false); assert.equal(h.messages.length, 0); assert.equal(h.journal().entries('report').length, 0); assert.ok(h.lookups().every(row => row.route === '/api/company/report-intakes/' + h.mutations()[0].options.headers['X-PDL-Operation']), 'Known current-form success is reviewed by one further fresh original GET.');
});
test('pending original intake blocks ordinary retry and permits explicit read-only original recovery without clearing custody', async () => {
  const h = uncertain(); await h.save('Needs review'); const original = h.mutations()[0].options.headers['X-PDL-Operation']; assert.equal(h.field('report-modal').open, true); assert.match(h.messages.at(-1), new RegExp(original)); assert.equal(h.context.reports.length, 0); assert.equal(h.context.photos.length, 0);
  await h.save('Needs review'); assert.equal(h.mutations().length, 1); assert.equal(h.lookups().length, 1); assert.equal(h.state.encoded, 1); assert.equal(h.state.standaloneUploads, 0); assert.match(h.messages.at(-1), /Review a previous save/i);
  const value = await h.context.PDLOriginalReportRecovery.recoverOriginal(original); assert.equal(value.complete, false); assert.equal(h.lookups().length, 2); assert.equal(h.journal().entries('report')[0].operationId, original); await assert.rejects(h.context.PDLOriginalReportRecovery.reviewOriginal(original, { confirmed: true })); assert.equal(h.mutations().length, 1); assert.equal(h.journal().entries('report').length, 1);
});
test('clearing selected photos cannot bypass pending intake custody with a new plain report save', async () => {
  const h = uncertain(); await h.save('Needs review'); const before = h.calls.length; h.field('report-photos').files = []; await h.save('Needs review'); assert.equal(h.calls.length, before); assert.equal(h.mutations().length, 1); assert.equal(h.state.encoded, 1); assert.equal(h.context.reports.length, 0); assert.equal(h.context.photos.length, 0); assert.equal(h.field('report-modal').open, true); assert.match(h.messages.at(-1), /original report intake/i);
});
test('pending intake retains the original form fingerprint even for a changed language control outside the current projected body', async () => {
  const h = uncertain(); await h.save('Needs review'); const before = h.calls.length; h.field('report-language').value = 'es-MX'; await h.save('Needs review'); assert.equal(h.calls.length, before); assert.equal(h.mutations().length, 1); assert.equal(h.state.encoded, 1); assert.equal(h.field('report-modal').open, true); assert.match(h.messages.at(-1), /original report intake/i);
});
for (const [name, change] of [
  ['notes', h => { h.field('field-notes').value = 'Synthetic different daily'; }],
  ['signature', h => { h.field('report-signature').value = 'Synthetic other signer'; }],
  ['selected project', h => { h.field('report-project').value = '1'; }],
  ['date', h => { h.field('report-date').value = '2026-10-13'; }],
  ['final status', () => {}],
  ['photo name', h => { h.field('report-photos').files = [photo({ name: 'different.png' })]; }],
  ['photo type', h => { h.field('report-photos').files = [photo({ type: 'image/jpeg' })]; }],
  ['photo size', h => { h.field('report-photos').files = [photo({ size: 70 })]; }],
  ['photo modification time', h => { h.field('report-photos').files = [photo({ lastModified: 8 })]; }],
  ['photo tags', h => { h.field('report-photo-tags').value = 'different'; }],
  ['create versus edit', h => { h.context.editingReportId = 1; h.context.reports = [clone(h.db.reports[0])]; }],
]) test('durable pending original blocks changed ' + name + ' before original lookup, save or re-encoding', async () => {
  const h = uncertain(); await h.save('Needs review'); const calls = h.calls.length, original = h.journal().entries('report'); change(h); await h.save(name === 'final status' ? 'Draft' : 'Needs review'); assert.equal(h.calls.length, calls); assert.equal(h.state.encoded, 1); assert.equal(h.mutations().length, 1); assert.equal(h.field('report-modal').open, true); assert.match(h.messages.at(-1), /original report intake.*before saving another daily/i); assert.deepEqual(h.journal().entries('report'), original);
});
for (const [name, key, next] of [['company', 'companyId', B], ['actor', 'actorId', 3], ['role', 'role', 'admin'], ['session', 'sessionBinding', 'b'.repeat(64)]]) test('pending intake rejects changed current ' + name + ' before original lookup or new write', async () => {
  const h = uncertain(); await h.save('Needs review'); const calls = h.calls.length, original = h.journal().entries('report'); h.state.identity[key] = next; await h.save('Needs review'); assert.equal(h.calls.length, calls); assert.equal(h.state.encoded, 1); assert.match(h.messages.at(-1), /Review a previous save/i); assert.equal(h.field('report-modal').open, true); await assert.rejects(h.context.PDLOriginalReportRecovery.recoverOriginal(original[0].operationId), value => value.code === 'PDL_ORIGINAL_REPORT_REVIEW'); assert.equal(h.calls.length, calls); assert.deepEqual(h.journal().entries('report'), original); assert.ok(h.state.retired > 0);
});
test('concurrent submit cannot launch a second compound report or encode photos twice', async () => {
  const wait = deferred(), h = harness({ files: [photo()], transport: async (call, fixture) => call.route.startsWith('/api/company/report-intakes/') ? fixture.completed() : wait.promise });
  const first = h.save('Needs review'); await until(() => h.mutations().length === 1); await h.save('Needs review'); assert.equal(h.mutations().length, 1); assert.equal(h.state.encoded, 1); assert.match(h.messages.at(-1), /Finish the current daily review/); wait.resolve(h.completed()); await first; assert.equal(h.state.standaloneUploads, 0); assert.equal(h.journal().entries('report').length, 0);
});
test('unavailable original lookup retains operation custody and does not allow blind retry', async () => {
  const h = uncertain({ lookup: Object.assign(Error('Synthetic lookup unavailable'), { status: 503 }) }); await h.save('Needs review'); const operation = h.mutations()[0].options.headers['X-PDL-Operation']; await h.save('Needs review'); assert.equal(h.lookups().length, 1); await assert.rejects(h.context.PDLOriginalReportRecovery.recoverOriginal(operation), value => value.status === 503); assert.equal(h.mutations().length, 1); assert.equal(h.lookups().length, 2); assert.ok(h.lookups().every(row => row.route.endsWith(operation))); assert.equal(h.state.encoded, 1); assert.equal(h.field('report-modal').open, true); assert.equal(h.journal().entries('report')[0].operationId, operation);
});
for (const status of [401, 403]) test('original lookup denial ' + status + ' retains custody without resend or re-encoding', async () => {
  const h = uncertain({ lookup: Object.assign(Error('Synthetic current access denied'), { status }) }); await h.save('Needs review'); await h.save('Needs review'); assert.equal(h.lookups().length, 1); const original = h.journal().entries('report'); await assert.rejects(h.context.PDLOriginalReportRecovery.recoverOriginal(original[0].operationId), value => value.status === status); assert.equal(h.mutations().length, 1); assert.equal(h.lookups().length, 2); assert.equal(h.state.encoded, 1); assert.equal(h.context.reports.length, 0); assert.equal(h.context.photos.length, 0); assert.equal(h.field('report-modal').open, true); assert.deepEqual(h.journal().entries('report'), original);
});
for (const [name, change] of [['form notes', h => { h.field('field-notes').value = 'Synthetic newer form contents'; }], ['session', h => { h.state.identity.sessionBinding = 'b'.repeat(64); }], ['role', h => { h.state.identity.role = 'admin'; }], ['actor', h => { h.state.identity.actorId = 3; }], ['company', h => { h.state.identity.companyId = B; }]]) test('late explicit original lookup after changed ' + name + ' cannot apply, close, resend or upload into current form', async () => {
  let retry = false; const wait = deferred(), h = harness({ files: [photo()], transport: async (call, fixture) => {
    if (call.route.startsWith('/api/company/report-intakes/')) return retry ? wait.promise : { operationId: call.route.split('/').at(-1), reportId: 51, state: 'pending', complete: false, retryAllowed: false };
    throw Object.assign(Error('Synthetic lost acknowledgement'), { status: 503 });
  } });
  await h.save('Needs review'); const operation = h.mutations()[0].options.headers['X-PDL-Operation'], original = h.journal().entries('report'), openingForm = client.form(h.field('report-modal')); retry = true; const checking = h.context.PDLOriginalReportRecovery.recoverOriginal(operation, { accept: () => openingForm === client.form(h.field('report-modal')) }).then(value => ({ value }), error => ({ error })); await until(() => h.lookups().length === 2); change(h); wait.resolve(h.completed()); const outcome = await checking;
  assert.equal(outcome.error?.code, 'PDL_ORIGINAL_REPORT_REVIEW'); assert.equal(outcome.value, undefined); assert.equal(h.mutations().length, 1); assert.equal(h.state.encoded, 1); assert.equal(h.state.standaloneUploads, 0); assert.equal(h.context.reports.length, 0); assert.equal(h.context.photos.length, 0); assert.deepEqual(h.state.rendered, []); assert.equal(h.field('report-modal').open, true); assert.deepEqual(h.journal().entries('report'), original); assert.ok(h.state.retired > 0);
});
test('form change while selected bytes are encoding prevents the first mutation', async () => {
  const h = harness({ files: [photo()], deferEncoding: true, transport: async () => ({ complete: false, retryAllowed: false }) });
  const saving = h.save('Needs review'); await flush(); assert.equal(h.state.encodingCallbacks.length, 1); h.field('field-notes').value = 'Synthetic changed before upload'; for (const resolve of h.state.encodingCallbacks) resolve(); await saving;
  assert.equal(h.mutations().length, 0); assert.equal(h.state.standaloneUploads, 0); assert.equal(h.context.reports.length, 0); assert.equal(h.context.photos.length, 0); assert.equal(h.field('report-modal').open, true); assert.match(h.messages.at(-1), /daily form changed before dispatch/i); assert.equal(h.journal().entries('report').length, 0);
});
test('late successful original ACK cannot overwrite a newer form or launch a replacement operation', async () => {
  const wait = deferred(), h = harness({ files: [photo()], transport: async () => wait.promise });
  const saving = h.save('Needs review'); await until(() => h.mutations().length === 1); const original = h.journal().entries('report'); h.field('field-notes').value = 'Synthetic newer edit'; wait.resolve(h.completed()); await saving;
  assert.equal(h.context.reports.length, 0); assert.equal(h.context.photos.length, 0); assert.equal(h.field('report-modal').open, true); assert.match(h.messages.at(-1), /original report intake/i); assert.deepEqual(h.journal().entries('report'), original); assert.ok(h.state.retired > 0);
  await h.save('Needs review'); assert.equal(h.mutations().length, 1); assert.equal(h.state.encoded, 1); assert.match(h.messages.at(-1), /before saving another daily/i);
});

(async () => {
  let failed = 0;
  for (const { name, run } of tests) { try { await run(); } catch (error) { failed++; console.error('FAIL:', name); console.error(error); } }
  const evidence = { passed: failed === 0, checks: tests.length, failed, syntheticOnly: true, runtime: 'Node VM; actual app form collector and report/photo wrappers', externalCalls: 0, providerCalls: 0, realUploads: 0, sourceHashes: Object.fromEntries([['app.js', appSource], ['roles-report-client.js', clientSource]].map(([name, text]) => [name, crypto.createHash('sha256').update(text).digest('hex')])) };
  console.log(JSON.stringify(evidence)); if (failed) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
