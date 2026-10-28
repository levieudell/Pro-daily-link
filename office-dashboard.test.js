'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { officePriorityItems, officeActionDestination } = require('./office-dashboard');

const items = [
  { id: 'later', severity: 'low' }, { id: 'review', severity: 'high', reportId: 17 },
  { id: 'first', severity: 'urgent', projectId: 3 }, { id: 'second', severity: 'urgent', projectId: 4 }
];
assert.deepEqual(officePriorityItems(items).map(row => row.id), ['first', 'second', 'review']);
assert.equal(items[0].id, 'later', 'the shared action queue must not be reordered');
assert.deepEqual(officePriorityItems([]), []);
assert.deepEqual(officeActionDestination(items[1]), { page: 'reports', reportId: 17 });
assert.deepEqual(officeActionDestination(items[2]), { page: 'projects', projectId: 3 });
assert.deepEqual(officeActionDestination({ subcontractorId: 8 }), { page: 'team' });
assert.deepEqual(officeActionDestination({ id: 'other' }), { page: 'actions' });
assert.equal(officeActionDestination(null), null);

function harness() {
  const nodes = new Map();
  const node = selector => {
    if (!nodes.has(selector)) nodes.set(selector, {
      value: 'Needs review', dataset: {}, open: false,
      setAttribute() {}, focus() { this.focused = true; }, scrollIntoView() { this.scrolled = true; }
    });
    return nodes.get(selector);
  };
  const context = {
    preferredLanguage: 'en', currentRole: 'office', projects: [{ id: 3 }, { id: 4, archived: true }], reports: [{ id: 17 }],
    actionCenter: { items }, $: node, $$: () => [],
    renderDashboardSummary() {}, renderActionCenter() {}, renderTable() {}, renderActivities() {},
    dashboardWatchProjects: () => [], openSetupStep: step => context.setup = step,
    renderReports: id => context.selected = id,
    openProject: id => context.project = id, openReport: (id, options) => context.newDaily = options,
    showPage: page => context.page = page, notify: message => context.notice = message,
    syncReportPhotoTagsVisibility() {},
    document: { addEventListener: (type, listener) => context.click = listener }
  };
  vm.runInNewContext(fs.readFileSync('office-dashboard.js', 'utf8'), context);
  const click = (selector, dataset) => context.click({ target: { closest: match => match === selector ? { dataset } : null } });
  return { context, node, click };
}

let h = harness();
h.click('[data-office-action]', { officeAction: 'review' });
assert.equal(h.context.page, 'reports');
assert.equal(h.context.selected, 17, 'open the specific queued report');
assert.equal(h.node('#report-status-filter').value, 'all', 'a previous filter cannot hide the requested report');
assert.equal(h.node('#report-detail').focused, true);
assert.equal(h.node('#report-detail').scrolled, true, 'phone users land on the report, below the list');
h = harness(); h.context.reports = [];
h.click('[data-office-action]', { officeAction: 'review' });
assert.equal(h.context.page, undefined, 'an unavailable report must not open a different report');
assert.ok(h.context.notice);
h = harness(); h.context.currentRole = 'field';
h.click('[data-office-action]', { officeAction: 'review' });
h.click('[data-office-project]', { officeProject: '3' });
assert.equal(h.context.page, undefined, 'office controls must not change field navigation');
for (const id of ['4', 'missing']) {
  h = harness(); h.click('[data-office-project]', { officeProject: id });
  assert.equal(h.context.page, undefined, 'archived and missing projects cannot open');
}
h = harness(); h.click('[data-office-project]', { officeProject: '3' });
assert.equal(h.context.page, 'projects');
assert.equal(h.context.project, 3);
for (const [open, projectId, role, allowed] of [[true, '3', 'office', true], [false, '3', 'office', false], [true, '4', 'office', false], [true, '3', 'field', false]]) {
  h = harness(); h.context.currentRole = role;
  Object.assign(h.node('#project-detail-modal'), { open, dataset: { projectId } });
  h.click('[data-office-new-daily]', { officeNewDaily: '3' });
  assert.equal(Boolean(h.context.newDaily), allowed, 'daily creation must match the currently open office project');
  if (allowed) assert.equal(h.context.newDaily.projectIndex, 0);
}
const { isPublicFile } = require('./public-file-policy');
for (const file of ['office-dashboard.js', 'office-dashboard.css']) assert.equal(isPublicFile(process.cwd(), process.cwd() + '/' + file), true);
assert.equal(isPublicFile(process.cwd(), process.cwd() + '/office-dashboard.test.js'), false);
console.log('Office dashboard passed: stable priorities, exact report and phone focus, filters, unavailable records, field isolation, project-scoped daily creation, and public asset boundaries.');
