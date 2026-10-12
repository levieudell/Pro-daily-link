'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { parse } = require('./resource-estimates');
const app = fs.readFileSync(require.resolve('./app.js'), 'utf8');
const collect = app.split('\n').find(line => line.startsWith('function collectEstimateImportLines()'));
assert.ok(collect, 'actual saved-import form collector required');
const sourceLine = { description: 'Existing extracted line', quantity: 5, unit: 'LF', amount: 400,
  budgetHours: null, budgetHoursUserEdited: true, unitPrice: 80, internalCost: 250,
  confidence: 'high', catalogSuggestions: [{ id: 3, name: 'Scoped catalog', targetHoursPerUnit: 2 }],
  targetHoursPerUnit: 2, privateProviderContext: 'must never be submitted' };
const controls = { description: 'Reviewed line', quantity: '0', unit: '', amount: '', hours: '', catalog: '', include: true };
function actualCollector(atomic) {
  const context = { estimateImportDraft: { lines: [structuredClone(sourceLine)] },
    window: { pdlWorkspaceActions: { enabled: () => atomic } },
    $: selector => {
      const field = selector.match(/^\[data-import-([a-z]+)="0"\]$/)?.[1];
      assert.ok(Object.hasOwn(controls, field), 'actual collector used an unexpected input');
      return { value: String(controls[field]), checked: controls[field] === true };
    } };
  vm.runInNewContext(collect + '\nresult=collectEstimateImportLines();', context);
  assert.deepEqual(context.estimateImportDraft.lines[0], sourceLine, 'collecting must preserve rendered source metadata');
  return JSON.parse(JSON.stringify(context.result));
}
const lines = actualCollector(true);
const parsed = parse({ kind: 'estimateImportDraft', method: 'PATCH', path: '/api/estimate-imports/7/draft', details: { projectId: 101, lines } });
assert.equal(parsed.details.lines[0].quantity, 0);
assert.equal(parsed.details.lines[0].amount, null);
assert.equal(parsed.details.lines[0].budgetHours, null);
assert.equal(parsed.details.lines[0].budgetHoursUserEdited, true);
assert.equal(parsed.details.lines[0].unitPrice, 80);
assert.equal(parsed.details.lines[0].internalCost, 250);
for (const field of ['confidence', 'catalogSuggestions', 'targetHoursPerUnit', 'privateProviderContext']) assert.equal(Object.hasOwn(lines[0], field), false);
assert.equal(actualCollector(false)[0].confidence, 'high', 'legacy form payload remains compatible');
assert.throws(() => parse({ kind: 'estimateImportDraft', method: 'PATCH', path: '/api/estimate-imports/7/draft', details: { projectId: 101, lines: [{ ...lines[0], privateProviderContext: 'injected' }] } }), error => error.statusCode === 400);
console.log('actual saved-import form payload accepted by finite server contract; unknown/null/zero budgets, source display metadata and legacy form behavior preserved');
