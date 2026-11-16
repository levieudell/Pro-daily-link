'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { computeJobDebrief } = require('./job-debrief');

function fixture() {
  return {
    projects: [{ id: 10, name: 'Wall', lifecycleStatus: 'Completed', startDate: '2026-11-01', endDate: '2026-11-05', estimateItems: [
      { id: 1, name: 'Excavate', unit: 'CY', plannedQuantity: 100, budgetHours: 20 },
      { id: 2, name: 'Wall', unit: 'LF', plannedQuantity: 50, budgetHours: 10 }
    ] }],
    reports: [], team: [{ id: 1, role: 'Operator' }], changes: []
  };
}

test('debrief handles a project with no reports', () => {
  const db = fixture(), result = computeJobDebrief(db, 10);
  assert.deepEqual(result.dates, { plannedStart: '2026-11-01', plannedEnd: '2026-11-05', actualStart: null, actualEnd: null, daysOverUnderPlan: null });
  assert.equal(result.weatherDays, 0);
  assert.equal(result.delayDays, 0);
  assert.equal(result.completed, true);
  assert.equal(result.production.totals.hours.actual, 0);
  assert.deepEqual(result.debrief, { wentWell: '', wentWrong: '', doDifferently: '', rating: null, updatedAt: null, updatedBy: null });
});

test('debrief uses approved flags and estimate actuals without guessing from text', () => {
  const db = fixture();
  db.reports.push(
    { id: 1, project: 0, status: 'Approved', dateIso: '2026-11-02', weatherDay: true, delayDay: false, delays: 'Utility conflict', materials: 'Pipe', laborEntries: [{ memberId: 1, hours: 12 }], productionEntries: [{ estimateItemId: 1, quantity: 125, laborHours: 24 }] },
    { id: 2, project: 0, status: 'Approved', dateIso: '2026-11-04', notes: 'Rain delay in the narrative only', laborEntries: [{ memberId: 1, hours: 4 }], productionEntries: [{ estimateItemId: 2, quantity: 40, laborHours: 8 }] },
    { id: 3, project: 0, status: 'Approved', dateIso: '2026-11-07', delayDay: true, issue: 'Access blocked', safetyItems: [{ observation: 'Open trench edge' }], laborEntries: [], productionEntries: [] },
    { id: 4, project: 0, status: 'Draft', dateIso: '2026-11-08', weatherDay: true, delayDay: true, laborEntries: [], productionEntries: [] }
  );
  const result = computeJobDebrief(db, 10);
  assert.equal(result.weatherDays, 1, 'old reports and narrative text do not create flags');
  assert.equal(result.delayDays, 1);
  assert.equal(result.dates.actualStart, '2026-11-02');
  assert.equal(result.dates.actualEnd, '2026-11-07');
  assert.equal(result.dates.daysOverUnderPlan, 2);
  assert.deepEqual(result.production.items[0].quantity, { estimated: 100, actual: 125, variance: 25, percent: 125 });
  assert.deepEqual(result.production.items[1].quantity, { estimated: 50, actual: 40, variance: -10, percent: 80 });
  assert.equal(result.issues.some(row => row.type === 'delay' && row.reportId === 1), true);
  assert.equal(result.issues.some(row => row.type === 'issue' && row.reportId === 3), true);
  assert.equal(result.issues.some(row => row.type === 'safety_item' && row.text === 'Open trench edge'), true);
  assert.deepEqual(result.materials, [{ reportId: 1, dateIso: '2026-11-02', text: 'Pipe' }]);
});

test('debrief labor cost is null when any approved report lacks a captured rate', () => {
  const db = fixture();
  db.reports.push({ id: 1, project: 0, status: 'Approved', dateIso: '2026-11-02', laborEntries: [{ memberId: 1, hours: 8 }], productionEntries: [] });
  const result = computeJobDebrief(db, 10, { includePricing: true });
  assert.equal(result.laborCost, null);
  assert.equal(result.laborCostComplete, false);
  const redacted = computeJobDebrief(db, 10, { includePricing: false });
  assert.equal(Object.hasOwn(redacted, 'laborCost'), false);
  assert.equal(Object.hasOwn(redacted, 'laborRates'), false);
});

test('debrief uses captured daily rates for labor cost', () => {
  const db = fixture();
  db.reports.push({ id: 1, project: 0, status: 'Approved', dateIso: '2026-11-02', laborEntries: [{ memberId: 1, hours: 8 }], productionEntries: [], rateSnapshot: { schemaVersion: 1, laborRate: 75, capturedAt: '2026-11-02T20:00:00.000Z', capturedBy: { id: 1, name: 'Owner' } } });
  const result = computeJobDebrief(db, 10, { includePricing: true });
  assert.equal(result.laborCost, 600);
  assert.equal(result.laborCostComplete, true);
});
