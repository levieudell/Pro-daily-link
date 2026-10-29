'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { payPeriodFor, listPayPeriods, lastEndedBefore, validateSchedule, emptySchedule } = require('./pay-schedule');
const weekly = extra => ({ ...emptySchedule(), frequency: 'weekly', period_end_weekday: 2, cards_due_offset_days: 1, payday_offset_days: 3, ...extra });

test('Tuesday-end week is due Wednesday and paid Friday', () => {
  const period = payPeriodFor(weekly(), '2026-10-27', 'America/Los_Angeles');
  assert.deepEqual(period, { start: '2026-10-21', end: '2026-10-27', cards_due: '2026-10-28', payday: '2026-10-30' });
  assert.equal(lastEndedBefore(weekly(), '2026-10-29').end, '2026-10-27');
  assert.equal(payPeriodFor(weekly(), '2026-10-21').start, '2026-10-21');
});

test('weekly periods roll forward and a DST week stays seven calendar days', () => {
  const schedule = weekly({ period_end_weekday: 0, cards_due_offset_days: null, payday_offset_days: null });
  const period = payPeriodFor(schedule, '2026-03-08', 'America/Los_Angeles');
  assert.deepEqual(period, { start: '2026-03-02', end: '2026-03-08', cards_due: null, payday: null });
  const listed = listPayPeriods(schedule, '2026-03-01', '2026-03-21');
  assert.deepEqual(listed.map(row => row.end), ['2026-03-01', '2026-03-08', '2026-03-15', '2026-03-22']);
});

test('biweekly anchors in the past and future stay on the end weekday', () => {
  const past = weekly({ frequency: 'biweekly', anchor_end_date: '2026-01-06' });
  assert.deepEqual(payPeriodFor(past, '2026-10-27'), { start: '2026-10-14', end: '2026-10-27', cards_due: '2026-10-28', payday: '2026-10-30' });
  const future = weekly({ frequency: 'biweekly', anchor_end_date: '2026-12-29', cards_due_offset_days: null, payday_offset_days: null });
  assert.equal(payPeriodFor(future, '2026-10-20').end, '2026-10-20');
  assert.equal(payPeriodFor(future, '2026-10-21').end, '2026-11-03');
});

test('semimonthly 15 and last handles February in leap and non-leap years', () => {
  const schedule = { ...emptySchedule(), frequency: 'semimonthly', semimonthly_end_days: [15, 'last'] };
  assert.deepEqual(payPeriodFor(schedule, '2026-02-15'), { start: '2026-02-01', end: '2026-02-15', cards_due: null, payday: null });
  assert.deepEqual(payPeriodFor(schedule, '2026-02-28'), { start: '2026-02-16', end: '2026-02-28', cards_due: null, payday: null });
  assert.deepEqual(payPeriodFor(schedule, '2028-02-29'), { start: '2028-02-16', end: '2028-02-29', cards_due: null, payday: null });
  assert.equal(listPayPeriods(schedule, '2026-02-01', '2026-02-28').length, 2);
});

test('monthly last and fixed days cover 31-day months', () => {
  const last = { ...emptySchedule(), frequency: 'monthly', monthly_end_day: 'last' };
  assert.deepEqual(payPeriodFor(last, '2026-01-15'), { start: '2026-01-01', end: '2026-01-31', cards_due: null, payday: null });
  assert.equal(payPeriodFor(last, '2026-03-31').end, '2026-03-31');
  const fixed = { ...emptySchedule(), frequency: 'monthly', monthly_end_day: 28 };
  assert.deepEqual(payPeriodFor(fixed, '2026-01-29'), { start: '2026-01-29', end: '2026-02-28', cards_due: null, payday: null });
  assert.equal(payPeriodFor(fixed, '2026-01-28').end, '2026-01-28');
});

test('null frequency keeps manual periods and bad schedules are rejected', () => {
  assert.equal(payPeriodFor(emptySchedule(), '2026-10-27', 'America/Los_Angeles'), null);
  assert.deepEqual(listPayPeriods({ frequency: null }, '2026-10-01', '2026-10-31'), []);
  assert.equal(lastEndedBefore(emptySchedule(), '2026-10-29'), null);
  assert.equal(validateSchedule({ frequency: null }).frequency, null);
  for (const input of [
    { frequency: 'weekly' },
    { frequency: 'biweekly', period_end_weekday: 2, anchor_end_date: '2026-10-28' },
    { frequency: 'semimonthly', semimonthly_end_days: [15, 15] },
    { frequency: 'monthly', monthly_end_day: 31 },
    { frequency: 'weekly', period_end_weekday: 2, cards_due_offset_days: 15 },
    { frequency: 'weekly', period_end_weekday: 2, payday_offset_days: 31 }
  ]) assert.throws(() => validateSchedule(input), error => error.statusCode === 400);
});
