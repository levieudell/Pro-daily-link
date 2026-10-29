(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PDLPaySchedule = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const FREQUENCIES = ['weekly', 'biweekly', 'semimonthly', 'monthly'];
  const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  function fail(message) { throw Object.assign(new Error(message), { statusCode: 400 }); }
  function validDate(value) {
    return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value + 'T00:00:00Z')) && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
  }
  function addDays(date, days) {
    const value = new Date(date + 'T00:00:00Z');
    value.setUTCDate(value.getUTCDate() + days);
    return value.toISOString().slice(0, 10);
  }
  function weekday(date) { return new Date(date + 'T12:00:00Z').getUTCDay(); }
  function daysBetween(from, to) { return Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86400000); }
  function lastDate(year, month) { return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10); }
  function shiftMonth(year, month, amount) {
    const value = new Date(Date.UTC(year, month - 1 + amount, 1));
    return [value.getUTCFullYear(), value.getUTCMonth() + 1];
  }
  function emptySchedule() {
    return { frequency: null, period_end_weekday: null, anchor_end_date: null, semimonthly_end_days: null, monthly_end_day: null, cards_due_offset_days: null, payday_offset_days: null };
  }
  function offset(value, max, label) {
    if (value == null) return null;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > max) fail(`${label} must be a whole number from 0 to ${max}, or left off.`);
    return value;
  }
  function endSpec(value, label) {
    if (value === 'last') return 'last';
    if (typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 28) return value;
    fail(`${label} must be a day from 1 to 28, or the last day of the month.`);
  }
  function validateSchedule(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Save a pay schedule, or turn it off.');
    const allowed = new Set(Object.keys(emptySchedule()));
    if (Object.keys(input).some(key => !allowed.has(key))) fail('Save a pay schedule, or turn it off.');
    const schedule = emptySchedule();
    if (input.frequency == null) return schedule;
    if (!FREQUENCIES.includes(input.frequency)) fail('Choose weekly, every 2 weeks, twice a month, or monthly.');
    schedule.frequency = input.frequency;
    schedule.cards_due_offset_days = offset(input.cards_due_offset_days, 14, 'Time cards due');
    schedule.payday_offset_days = offset(input.payday_offset_days, 30, 'Payday');
    if (input.frequency === 'weekly' || input.frequency === 'biweekly') {
      const day = input.period_end_weekday;
      if (typeof day !== 'number' || !Number.isInteger(day) || day < 0 || day > 6) fail('Choose the weekday the pay period ends.');
      schedule.period_end_weekday = day;
    }
    if (input.frequency === 'biweekly') {
      if (!validDate(input.anchor_end_date) || weekday(input.anchor_end_date) !== schedule.period_end_weekday) fail('Choose a real period end date that falls on the end weekday.');
      schedule.anchor_end_date = input.anchor_end_date;
    }
    if (input.frequency === 'semimonthly') {
      const days = input.semimonthly_end_days;
      if (!Array.isArray(days) || days.length !== 2) fail('Choose the two days each month when a pay period ends.');
      schedule.semimonthly_end_days = [endSpec(days[0], 'First end day'), endSpec(days[1], 'Second end day')];
      if (String(schedule.semimonthly_end_days[0]) === String(schedule.semimonthly_end_days[1])) fail('The two end days have to be different.');
    }
    if (input.frequency === 'monthly') schedule.monthly_end_day = endSpec(input.monthly_end_day, 'End day');
    return schedule;
  }
  function resolveEnd(year, month, spec) {
    const last = lastDate(year, month);
    if (spec === 'last') return last;
    return `${year}-${String(month).padStart(2, '0')}-${String(Math.min(spec, Number(last.slice(8)))).padStart(2, '0')}`;
  }
  function endsFor(schedule, year, month) {
    if (schedule.frequency === 'semimonthly') return schedule.semimonthly_end_days.map(spec => resolveEnd(year, month, spec)).sort();
    return [resolveEnd(year, month, schedule.monthly_end_day)];
  }
  function finish(schedule, end) {
    const length = schedule.frequency === 'weekly' ? 6 : schedule.frequency === 'biweekly' ? 13 : null;
    let start;
    if (length != null) start = addDays(end, -length);
    else {
      const [year, month] = [Number(end.slice(0, 4)), Number(end.slice(5, 7))];
      const [py, pm] = shiftMonth(year, month, -1);
      const previous = endsFor(schedule, py, pm).filter((value, index, all) => all.indexOf(value) === index).at(-1);
      const earlier = endsFor(schedule, year, month).filter(value => value < end).at(-1);
      start = addDays(earlier || previous, 1);
    }
    return {
      start, end,
      cards_due: schedule.cards_due_offset_days == null ? null : addDays(end, schedule.cards_due_offset_days),
      payday: schedule.payday_offset_days == null ? null : addDays(end, schedule.payday_offset_days)
    };
  }
  function payPeriodFor(schedule, date) {
    if (!schedule || schedule.frequency == null || !validDate(date)) return null;
    if (schedule.frequency === 'weekly' || schedule.frequency === 'biweekly') {
      let end;
      if (schedule.frequency === 'weekly') end = addDays(date, (schedule.period_end_weekday - weekday(date) + 7) % 7);
      else {
        const steps = Math.ceil(daysBetween(schedule.anchor_end_date, date) / 14);
        end = addDays(schedule.anchor_end_date, steps * 14);
      }
      return finish(schedule, end);
    }
    let [year, month] = [Number(date.slice(0, 4)), Number(date.slice(5, 7))];
    for (let i = 0; i < 4; i++) {
      const end = endsFor(schedule, year, month).find(value => value >= date);
      if (end) return finish(schedule, end);
      [year, month] = shiftMonth(year, month, 1);
    }
    return null;
  }
  function listPayPeriods(schedule, from, to) {
    if (!schedule || schedule.frequency == null || !validDate(from) || !validDate(to) || from > to) return [];
    const periods = [];
    let cursor = from;
    for (let guard = 0; guard < 400; guard++) {
      const period = payPeriodFor(schedule, cursor);
      if (!period || period.start > to) break;
      if (period.end >= from && !periods.some(row => row.start === period.start)) periods.push(period);
      cursor = addDays(period.end, 1);
      if (cursor > to && period.start > to) break;
    }
    return periods;
  }
  function lastEndedBefore(schedule, today) {
    const current = payPeriodFor(schedule, today);
    if (!current) return null;
    if (current.end < today) return current;
    return payPeriodFor(schedule, addDays(current.start, -1));
  }
  function preview(period) {
    if (!period) return '';
    const format = value => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(value + 'T12:00:00Z'));
    return `${format(period.start)} – ${format(period.end)}${period.cards_due ? ` · cards due ${format(period.cards_due)}` : ''}${period.payday ? ` · paid ${format(period.payday)}` : ''}`;
  }
  return { FREQUENCIES, WEEKDAYS, emptySchedule, validateSchedule, payPeriodFor, listPayPeriods, lastEndedBefore, preview, weekday, addDays };
});
