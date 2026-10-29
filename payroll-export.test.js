'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { buildPayrollExport: build, payrollCsv, payrollPdf, defaultTemplate } = require('./payroll-export');
const { splitHours } = require('./payroll-overtime');
const calendar = require('./payroll-ranges');
const card = (date, hours, extra = {}) => ({ id: date, memberId: 1, projectId: 10, status: 'approved', inAt: date + 'T08:00:00Z', outAt: new Date(Date.parse(date + 'T08:00:00Z') + hours * 3600000).toISOString(), hours, ...extra });
const db = (cards, overtime = {}) => ({ company: { name: 'Payroll test', timezone: 'UTC', weekStart: 'monday', payroll: { overtime: { weeklyOver: 40, dailyOver: null, dailyDoubleOver: null, ...overtime } } }, team: [{ id: 1, name: 'Worker One' }], projects: [{ id: 10, name: 'Job One', code: 'J01' }], timeCards: cards });
const week = (from, hours = 9) => Array.from({ length: 5 }, (_, i) => card(calendar.addDays(from, i), hours, { projectId: i % 2 ? 20 : 10 }));
const total = (rows, key) => Math.round(rows.reduce((n, row) => n + row[key], 0) * 100) / 100;

test('mid-week starts, ends and two-workweek ranges match the same full-week days, including cents', () => {
  for (const hours of [9, 8.3333, 7.1234]) {
    const source = db([...week('2026-10-19', hours), ...week('2026-10-26', hours)]);
    const full = splitHours(source.timeCards, { ...source.company.payroll, timeZone: 'UTC', weekStart: 'monday' }).flatMap(w => w.punches);
    for (const [from, to] of [['2026-10-21', '2026-10-23'], ['2026-10-19', '2026-10-22'], ['2026-10-22', '2026-10-29']]) {
      const result = build(source, { from, to }), expected = full.filter(p => p.date >= from && p.date <= to);
      for (const key of ['REG', 'OT', 'DT', 'total']) assert.equal(result.totals[key], total(expected, key), `${hours} ${from} ${to} ${key}`);
      assert.equal(result.rows.filter(r => r.job_name === 'WORKER TOTAL').length, 1);
      assert.equal(total(result.rows.filter(r => r.job_name !== 'WORKER TOTAL').map(r => ({ total: Number(r.total_hours) })), 'total'), result.totals.total);
    }
  }
  assert.equal(build(db(week('2026-10-19')), { from: '2026-10-21', to: '2026-10-23' }).totals.OT, 5);
  assert.equal(build(db(week('2026-10-19')), { from: '2026-10-19', to: '2026-10-22' }).totals.OT, 0);
});
test('approved punches only, chronological jobs and extra-work hours remain in REG/OT/DT', () => {
  const source = db([card('2026-10-19', 6), card('2026-10-19', 7, { id: 'later', projectId: 20, inAt: '2026-10-19T14:00:00Z', outAt: '2026-10-19T21:00:00Z', extraWork: true }), card('2026-10-20', 8, { status: 'submitted' }), card('2026-10-21', 8, { status: 'draft' }), card('2026-10-22', 8, { deletedAt: '2026-10-23' })], { dailyOver: 8, dailyDoubleOver: 12 });
  const result = build(source, { from: '2026-10-19', to: '2026-10-25' });
  assert.deepEqual(result.totals, { REG: 8, OT: 4, DT: 1, total: 13 });
  assert.equal(result.unapprovedCount, 2); assert.equal(result.approvedCount, 2);
  assert.deepEqual(result.workers[0].weeks[0].jobs.map(j => [j.REG, j.OT, j.DT]), [[6, 0, 0], [2, 4, 1]]);
  assert.deepEqual(defaultTemplate.columns, ['worker_name','worker_id','job_name','job_number','week_start','reg_hours','ot_hours','dt_hours','total_hours']);
});
test('overnight 18:00–04:00 stays on its start day/workweek in company timezone', () => {
  const source = db([card('2026-10-25', 10, { inAt: '2026-10-26T01:00:00Z', outAt: '2026-10-26T11:00:00Z' })], { dailyOver: 8 });
  source.company.timezone = 'America/Los_Angeles';
  const result = build(source, { from: '2026-10-25', to: '2026-10-25' });
  assert.deepEqual(result.totals, { REG: 8, OT: 2, DT: 0, total: 10 });
  assert.equal(result.rows[0].week_start, '2026-10-19');
  assert.equal(build(source, { from: '2026-10-26', to: '2026-10-26' }).totals.total, 0);
  source.company.weekStart = 'sunday';
  assert.equal(build(source, { from: '2026-10-25', to: '2026-10-25' }).rows[0].week_start, '2026-10-25');
});
test('template-driven CSV quotes formulas, commas, quotes and newlines; totals do not become pay lines', () => {
  const source = db([card('2026-10-19', 8)]); source.team[0].name = '=SUM(1,2)'; source.projects[0].name = 'Job "One",\nNorth'; source.projects[0].code = '@evil';
  const report = build(source, { from: '2026-10-19', to: '2026-10-25' }), csv = payrollCsv(report);
  assert.ok(csv.startsWith(defaultTemplate.columns.map(c => `"${c}"`).join(',') + '\r\n'));
  assert.ok(csv.includes('"\'=SUM(1,2)"')); assert.ok(csv.includes('"Job ""One"",\nNorth"')); assert.ok(csv.includes('"\'@evil"'));
  assert.equal(payrollCsv(report, { columns: ['worker_id', 'reg_hours'] }), '"worker_id","reg_hours"\r\n"1","8.00"\r\n"1","8.00"\r\n');
  assert.equal(defaultTemplate.filename(report), 'pdl-payroll-2026-10-19-to-2026-10-25.csv');
});
test('validates calendar ranges and approved punches; empty export has headers and zero totals', () => {
  for (const from of ['', '2026-02-30', '2026-10-26', '2026-10-19\r\nx: bad']) assert.throws(() => build(db([]), { from, to: '2026-10-25' }), { statusCode: 400 });
  assert.throws(() => build(db([card('2026-10-19', 8, { outAt: null })]), { from: '2026-10-19', to: '2026-10-25' }), { statusCode: 400 });
  const empty = build(db([]), { from: '2026-10-19', to: '2026-10-25' }); assert.equal(empty.totals.total, 0); assert.equal(empty.rows.length, 0);
});
test('range chips use company calendar and week start across month/year/DST edges', () => {
  assert.deepEqual(calendar.range('week', '2027-01-01'), { from: '2026-12-28', to: '2027-01-03' });
  assert.deepEqual(calendar.range('last', '2026-11-03', 'sunday'), { from: '2026-10-25', to: '2026-10-31' });
  assert.deepEqual(calendar.range('wtd', '2026-11-03', 'sunday'), { from: '2026-11-01', to: '2026-11-03' });
  assert.deepEqual(calendar.range('today', '2026-11-03'), { from: '2026-11-03', to: '2026-11-03' });
  assert.equal(calendar.today('America/Los_Angeles', new Date('2026-11-02T07:00:00Z')), '2026-11-01');
});
test('PDF stays one page for empty and large teams, with all workers retained', async () => {
  for (const count of [0, 75]) {
    const source = db(Array.from({ length: count }, (_, i) => card('2026-10-19', 8, { memberId: i + 1 })));
    source.team = source.timeCards.map(c => ({ id: c.memberId, name: `Worker ${c.memberId} with a long double-barreled surname` }));
    const report = build(source, { from: '2026-10-19', to: '2026-10-25' });
    const pdf = await payrollPdf(report);
    assert.equal(report.workers.length, count); assert.equal(report.totals.total, count * 8);
    assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
    assert.equal((pdf.toString('latin1').match(/\/Type \/Page\b/g) || []).length, 1);
  }
});
