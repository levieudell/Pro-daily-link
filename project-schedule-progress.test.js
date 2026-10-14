'use strict';
// Planned-vs-done rollup for estimate-linked schedule tasks (synthetic VM):
// planned quantity comes from the estimate line; done comes only from
// approved, non-deleted daily reports for the same project.
const assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const source = fs.readFileSync('project-schedule-ui.js', 'utf8');
const project = { id: 7, name: 'QA Schedule Test', estimateItems: [{ id: 11, name: 'Footings', plannedQuantity: 2000, unit: 'SF' }, { id: 12, name: 'No quantity line', unit: 'EA' }] };
const approvedA = { id: 1, project: 0, status: 'Approved', productionEntries: [{ estimateItemId: 11, quantity: 500 }] };
const approvedB = { id: 2, project: 0, status: 'Approved', productionEntries: [{ estimateItemId: 11, quantity: 250 }, { estimateItemId: 99, quantity: 40 }] };
const draft = { id: 3, project: 0, status: 'Draft', productionEntries: [{ estimateItemId: 11, quantity: 999 }] };
const needsReview = { id: 4, project: 0, status: 'Needs review', productionEntries: [{ estimateItemId: 11, quantity: 888 }] };
const deleted = { id: 5, project: 0, status: 'Approved', deletedAt: '2026-10-01T00:00:00Z', productionEntries: [{ estimateItemId: 11, quantity: 777 }] };
const otherProject = { id: 6, project: 1, status: 'Approved', productionEntries: [{ estimateItemId: 11, quantity: 666 }] };
function load(reports, currentRole){
  const sandbox = {
    window: {},
    projects: [{ id: 7 }, { id: 8 }],
    reports,
    currentRole,
    team: [],
    escapeHtml: value => String(value),
    formatDate: value => String(value),
    api: async () => { throw new Error('no network in this harness'); },
    notify: () => {},
    setTimeout,
    console
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return sandbox.PDLProjectScheduleUI.estimateProgress;
}
{
  const progress = load([approvedA, approvedB, draft, needsReview, deleted, otherProject], 'office')(project, 11);
  assert.equal(progress.done, 750, 'only approved live entries for this project count');
  assert.equal(progress.planned, 2000);
  assert.equal(progress.unit, 'SF');
  assert.equal(progress.pct, 38);
}
{
  const progress = load([approvedA, approvedB], 'office')(project, 12);
  assert.equal(progress, null, 'an estimate line without a planned quantity shows no progress');
}
{
  const progress = load([approvedA], 'field')(project, 11);
  assert.equal(progress, null, 'the field workspace skips progress (its report subset has no production entries)');
}
{
  const progress = load([], 'office')(project, 11);
  assert.equal(progress.done, 0, 'no approved reports yet reads a clean zero');
  assert.equal(progress.pct, 0);
}
console.log('estimate progress rollup: ok');
