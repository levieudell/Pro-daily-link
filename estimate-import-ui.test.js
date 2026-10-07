'use strict';
// Execute the actual import handlers with deferred FileReader/API responses.
// This suite does not start a server, write uploads, or contact any provider.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
const sourceLines = source.split('\n');
const find = prefix => {
  const line = sourceLines.find(row => row.startsWith(prefix));
  assert.ok(line, `Missing actual application handler: ${prefix}`);
  return line;
};
const openSource = find('function openEstimateImport(').split('function fileAsData(')[0];
const handlerSource = [
  find("$('#estimate-pdf').onchange="),
  find("$('#analyze-estimate').onclick="),
  find("$('#approve-estimate-import').onclick=")
].join('\n');
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
const draft = (id, projectId) => ({
  id, ...(projectId == null ? {} : { projectId }),
  lines: [{ description: 'Scope ' + id, quantity: 2, unit: 'EA', amount: 10, budgetHours: 4 }],
  requiresOcr: false, documentTotal: 10, lineTotal: 10, reconciled: true,
  extractionMethod: 'embedded_text'
});

function harness() {
  const elements = new Map(), reads = [], calls = [], notifications = [];
  const $ = selector => {
    if (!elements.has(selector)) elements.set(selector, {
      value: '', files: [], style: {}, hidden: true, textContent: '', innerHTML: '',
      disabled: false, open: false,
      showModal() { this.open = true; },
      close() { this.open = false; if (this.onclose) this.onclose(); }
    });
    return elements.get(selector);
  };
  const projects = [{ id: 101, name: 'Project A', estimateItems: [] }, { id: 202, name: 'Project B', estimateItems: [] }];
  let context;
  const get = expression => vm.runInContext(expression, context);
  context = vm.createContext({
    $, projects,
    fileAsData: file => { const pending = deferred(); reads.push({ ...pending, file }); return pending.promise; },
    api: (route, options) => {
      const pending = deferred();
      calls.push({ ...pending, route, body: JSON.parse(options.body) });
      return pending.promise;
    },
    notify: message => notifications.push(message),
    importLineMarkup: line => 'Scope: ' + line.description,
    bindImportReview() {
      const current = get('estimateImportDraft');
      const markup = $('#estimate-import-review').innerHTML;
      const select = $('#estimate-import-project');
      select.disabled = /id="estimate-import-project" disabled/.test(markup);
      select.value = markup.match(/<option value="(\d+)" selected>/)?.[1] || String(projects[0].id);
      current.lines.forEach((line, index) => {
        for (const [key, value] of Object.entries({
          hours: line.budgetHours ?? 0, description: line.description, quantity: line.quantity,
          unit: line.unit, amount: line.amount, catalog: ''
        })) $(`[data-import-${key}="${index}"]`).value = String(value);
      });
    }
  });
  vm.runInContext('let estimateImportDraft=null, estimateImportProjectId=null, estimateImportSequence=0;\n' + openSource + '\n' + handlerSource, context);
  const open = id => get(`openEstimateImport(${id == null ? 'null' : id})`);
  const choose = name => { $('#estimate-pdf').files = [{ name }]; $('#estimate-pdf').onchange(); };
  const analyze = () => $('#analyze-estimate').onclick();
  const approve = () => $('#approve-estimate-import').onclick();
  async function ready(id = 1, projectId = 101) {
    open(projectId); choose('estimate-' + id + '.pdf');
    const running = analyze(); reads.at(-1).resolve('data:application/pdf;base64,c3ludGhldGlj');
    await flush(); calls.at(-1).resolve(draft(id, projectId)); await running;
  }
  return { $, get, projects, reads, calls, notifications, open, choose, analyze, approve, ready };
}

const tests = [];
const test = (name, run) => tests.push({ name, run });
test('project binding is captured and the bound picker remains fixed', async () => {
  const h = harness(); await h.ready();
  assert.equal(h.calls[0].body.projectId, 101);
  assert.equal(h.$('#estimate-import-project').value, '101');
  assert.equal(h.$('#estimate-import-project').disabled, true);
  assert.equal(h.$('#analyze-estimate').disabled, false);
  assert.equal(h.$('#approve-estimate-import').style.display, 'block');
});
test('global analysis stays unbound and permits choosing a destination', async () => {
  const h = harness(); await h.ready(1, null);
  assert.equal(Object.hasOwn(h.calls[0].body, 'projectId'), false);
  assert.equal(h.$('#estimate-import-project').disabled, false);
});
test('close/reopen during FileReader cannot upload the old PDF into the new project', async () => {
  const h = harness(); h.open(101); h.choose('project-a.pdf'); const running = h.analyze();
  h.$('#estimate-import-modal').close(); h.open(202);
  h.reads[0].resolve('data:application/pdf;base64,QQ=='); await running;
  assert.equal(h.calls.length, 0);
  assert.equal(h.get('estimateImportDraft'), null);
  assert.equal(h.$('#analyze-estimate').disabled, false);
  assert.match(h.$('#estimate-import-review').innerHTML, /Project B/);
});
test('late API success cannot overwrite a reopened modal or unlock its current request', async () => {
  const h = harness(); h.open(101); h.choose('project-a.pdf'); const old = h.analyze();
  h.reads[0].resolve('old'); await flush();
  h.$('#estimate-import-modal').close(); h.open(202); h.choose('project-b.pdf'); const current = h.analyze();
  h.reads[1].resolve('new'); await flush();
  assert.equal(h.calls[0].body.projectId, 101); assert.equal(h.calls[1].body.projectId, 202);
  h.calls[0].resolve(draft(1, 101)); await old;
  assert.equal(h.get('estimateImportDraft'), null);
  assert.equal(h.$('#analyze-estimate').disabled, true);
  h.calls[1].resolve(draft(2, 202)); await current;
  assert.equal(h.get('estimateImportDraft.id'), 2);
  assert.equal(h.$('#estimate-import-project').value, '202');
});
test('reversed analysis completion keeps only the latest selected file', async () => {
  const h = harness(); h.open(101); h.choose('first.pdf'); const first = h.analyze();
  h.reads[0].resolve('first'); await flush();
  h.choose('second.pdf'); const second = h.analyze(); h.reads[1].resolve('second'); await flush();
  h.calls[1].resolve(draft(2, 101)); await second;
  const rendered = h.$('#estimate-import-review').innerHTML;
  h.calls[0].resolve(draft(1, 101)); await first;
  assert.equal(h.get('estimateImportDraft.id'), 2);
  assert.equal(h.$('#estimate-import-review').innerHTML, rendered);
  assert.equal(h.$('#analyze-estimate').disabled, false);
});
test('stale failure cannot notify or unlock a newer analysis', async () => {
  const h = harness(); h.open(101); h.choose('first.pdf'); const first = h.analyze();
  h.reads[0].resolve('first'); await flush();
  h.choose('second.pdf'); const second = h.analyze();
  h.calls[0].reject(new Error('Stale error')); await first;
  assert.deepEqual(h.notifications, []); assert.equal(h.$('#analyze-estimate').disabled, true);
  h.reads[1].resolve('second'); await flush(); h.calls[1].resolve(draft(2, 101)); await second;
});
test('current FileReader and API failures both allow retry', async () => {
  const h = harness(); h.open(101); h.choose('retry.pdf');
  let running = h.analyze(); h.reads[0].reject(new Error('Read failed')); await running;
  assert.equal(h.$('#analyze-estimate').disabled, false);
  running = h.analyze(); h.reads[1].resolve('retry'); await flush();
  h.calls[0].reject(new Error('Analysis failed')); await running;
  assert.equal(h.$('#analyze-estimate').disabled, false);
  assert.deepEqual(h.notifications, ['Read failed', 'Analysis failed']);
  running = h.analyze(); h.reads[2].resolve('retry'); await flush();
  h.calls[1].resolve(draft(3, 101)); await running;
  assert.equal(h.get('estimateImportDraft.id'), 3);
});
test('closing the modal discards an outstanding analysis response', async () => {
  const h = harness(); h.open(101); h.choose('closed.pdf'); const running = h.analyze();
  h.reads[0].resolve('closed'); await flush(); h.$('#estimate-import-modal').close();
  h.calls[0].resolve(draft(1, 101)); await running;
  assert.equal(h.get('estimateImportDraft'), null);
  assert.deepEqual(h.notifications, []);
  h.open(202); assert.equal(h.$('#analyze-estimate').disabled, false);
});
test('approval double-click sends once and late success preserves a newly opened modal', async () => {
  const h = harness(); await h.ready();
  const first = h.approve(); await h.approve(); assert.equal(h.calls.length, 2);
  h.$('#estimate-import-modal').close(); h.open(202);
  h.calls[1].resolve({ items: [{ id: 10, name: 'Approved original scope' }] }); await first;
  assert.equal(h.projects[0].estimateItems.length, 1); assert.equal(h.projects[1].estimateItems.length, 0);
  assert.equal(h.$('#estimate-import-modal').open, true);
  assert.equal(h.get('estimateImportDraft'), null); assert.deepEqual(h.notifications, []);
});
test('file change during pending approval permits approving the new draft', async () => {
  const h = harness(); await h.ready(); const firstApproval = h.approve();
  h.choose('replacement.pdf'); const analysis = h.analyze(); h.reads[1].resolve('replacement'); await flush();
  h.calls[2].resolve(draft(2, 101)); await analysis;
  assert.equal(h.$('#approve-estimate-import').disabled, false, 'New draft approval must not inherit the old request lock');
  h.calls[1].resolve({ items: [{ id: 10 }] }); await firstApproval;
  assert.equal(h.get('estimateImportDraft.id'), 2); assert.equal(h.$('#estimate-import-modal').open, true);
  const secondApproval = h.approve(); assert.equal(h.calls[3].route, '/api/estimate-imports/2/approve');
  h.calls[3].resolve({ items: [{ id: 11 }] }); await secondApproval;
  assert.equal(h.projects[0].estimateItems.length, 2);
});
test('new analysis during pending approval does not inherit the old approval lock', async () => {
  const h = harness(); await h.ready(); const approval = h.approve();
  const analysis = h.analyze(); h.reads[1].resolve('retry same file'); await flush();
  h.calls[2].resolve(draft(2, 101)); await analysis;
  assert.equal(h.$('#approve-estimate-import').disabled, false);
  h.calls[1].resolve({ items: [{ id: 10 }] }); await approval;
  assert.equal(h.get('estimateImportDraft.id'), 2); assert.equal(h.$('#estimate-import-modal').open, true);
});
test('current approval failure permits retry without duplicate local items', async () => {
  const h = harness(); await h.ready(); let running = h.approve();
  h.calls[1].reject(new Error('Approval failed')); await running;
  assert.equal(h.$('#approve-estimate-import').disabled, false); assert.equal(h.projects[0].estimateItems.length, 0);
  running = h.approve(); assert.equal(h.calls[2].route, '/api/estimate-imports/1/approve');
  h.calls[2].resolve({ items: [{ id: 10 }] }); await running;
  assert.equal(h.projects[0].estimateItems.length, 1); assert.equal(h.$('#estimate-import-modal').open, false);
});

(async () => {
  let failures = 0;
  for (const { name, run } of tests) {
    try { await run(); console.log('PASS:', name); }
    catch (error) { failures++; console.error('FAIL:', name, '\n', error); }
  }
  assert.equal(failures, 0, `${failures} estimate import UI regressions`);
  console.log(`Estimate import UI passed: ${tests.length} actual-handler VM cases; no provider calls or uploads.`);
})().catch(error => { console.error(error); process.exitCode = 1; });
