'use strict';

const { completeCard, dateAt, validDate } = require('./pay-periods');
const { isApproved } = require('./time-card-approval');
const DEFAULT_OVERTIME = Object.freeze({ weeklyOver: 40, dailyOver: null, dailyDoubleOver: null });
const CATEGORIES = ['REG', 'OT', 'DT'];
const empty = () => ({ REG: 0, OT: 0, DT: 0 });
function fail(message) { throw Object.assign(new Error(message), { statusCode: 400 }); }

function companyPayroll(company = {}) {
  return { ...company.payroll, overtime: { ...DEFAULT_OVERTIME, ...company.payroll?.overtime } };
}
function validatePayroll(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => key !== 'overtime')) {
    fail('Send payroll overtime rules. Week start uses the existing company setting.');
  }
  const overtime = input.overtime;
  if (!overtime || typeof overtime !== 'object' || Array.isArray(overtime) || Object.keys(overtime).length !== 3) {
    fail('Set all three overtime thresholds to a positive number or null.');
  }
  for (const key of Object.keys(DEFAULT_OVERTIME)) {
    const value = overtime[key];
    if (value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)) {
      fail(`${key} must be a positive number or null.`);
    }
  }
  if (overtime.dailyOver !== null && overtime.dailyDoubleOver !== null && overtime.dailyDoubleOver <= overtime.dailyOver) {
    fail('Double time must start after daily overtime.');
  }
  return { overtime: { ...overtime } };
}
function weekDate(date, weekStart) {
  const day = new Date(date + 'T00:00:00Z');
  const start = weekStart === 'sunday' ? 0 : 1;
  day.setUTCDate(day.getUTCDate() - (day.getUTCDay() - start + 7) % 7);
  return day.toISOString().slice(0, 10);
}
const cents = hours => Math.round((hours + Number.EPSILON) * 100);

// Round once, after classification and range filtering. Reconcile the last
// worked pay category; if tiny rows cannot absorb negative drift, work backwards.
// All parent totals are sums of these integer cents, never independently rounded.
function roundRows(rows) {
  const rounded = rows.map(row => ({ ...row, ...Object.fromEntries(CATEGORIES.map(key => [key, cents(row[key])])) }));
  const target = cents(rows.reduce((sum, row) => sum + row.REG + row.OT + row.DT, 0));
  let drift = target - rounded.reduce((sum, row) => sum + row.REG + row.OT + row.DT, 0);
  for (let i = rounded.length - 1; i >= 0 && drift; i--) {
    for (const key of [...CATEGORIES].reverse()) {
      if (!rows[i][key] || !drift) continue;
      const adjustment = drift > 0 ? drift : Math.max(drift, -rounded[i][key]);
      rounded[i][key] += adjustment;
      drift -= adjustment;
    }
  }
  return rounded;
}
function totals(rows) {
  const sums = rows.reduce((sum, row) => {
    for (const key of CATEGORIES) sum[key] += row[key];
    return sum;
  }, empty());
  return { ...Object.fromEntries(CATEGORIES.map(key => [key, sums[key] / 100])), total: (sums.REG + sums.OT + sums.DT) / 100 };
}
function breakdown(rows, key) {
  const groups = new Map();
  for (const row of rows) {
    const id = String(row[key]);
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(row);
  }
  return [...groups.values()].map(group => ({ [key]: group[0][key], ...totals(group) }));
}

/**
 * Pure payroll calculation over existing timeCards (one punch per job).
 * Supply ALL punches in the full workweeks touching [from, to], not just the
 * requested days. No I/O or mutation. Stored approved hours include any break
 * deductions and are authoritative; elapsed timestamps establish order/date only.
 *
 * rules: { overtime, weekStart: company.weekStart, timeZone: company.timezone,
 *          from?: 'YYYY-MM-DD', to?: 'YYYY-MM-DD' } (inclusive range).
 * Returns one row per member/workweek, with REG/OT/DT/total, jobs, days and punches.
 * When a range is supplied, every returned amount includes only in-range days.
 * Extra-work/billing flags deliberately have no effect on pay categories.
 */
function splitHours(workerDays, rules = {}) {
  if (!Array.isArray(workerDays)) fail('Provide time cards for the full workweeks.');
  const overtime = validatePayroll({ overtime: { ...DEFAULT_OVERTIME, ...rules.overtime } }).overtime;
  const weekStart = rules.weekStart ?? 'monday';
  if (!['monday', 'sunday'].includes(weekStart)) fail('Use the company Monday or Sunday week start.');
  const timeZone = rules.timeZone || 'America/Los_Angeles';
  try { new Intl.DateTimeFormat('en-US', { timeZone }).format(0); } catch { fail('Configure a valid company timezone.'); }
  const { from, to } = rules;
  if ((from !== undefined || to !== undefined) && (!validDate(from) || !validDate(to) || from > to)) {
    fail('Choose a valid inclusive start and end date.');
  }
  const firstWeek = from && weekDate(from, weekStart), lastWeek = to && weekDate(to, weekStart);
  const cards = workerDays.filter(card => card && !card.deletedAt && isApproved(card)).map(card => {
    if (!completeCard(card) || card.memberId == null) fail('Approved punches need a worker, valid start/end times and nonnegative hours.');
    const date = dateAt(card.inAt, timeZone);
    return { card, date, weekStart: weekDate(date, weekStart) };
  }).filter(row => !from || row.weekStart >= firstWeek && row.weekStart <= lastWeek)
    .sort((a, b) => a.date.localeCompare(b.date) || Date.parse(a.card.inAt) - Date.parse(b.card.inAt) || String(a.card.id).localeCompare(String(b.card.id)));
  const weeks = new Map();
  for (const { card, date, weekStart: start } of cards) {
    const key = JSON.stringify([String(card.memberId), start]);
    if (!weeks.has(key)) weeks.set(key, { memberId: card.memberId, weekStart: start, regular: 0, days: new Map(), rows: [] });
    const week = weeks.get(key), before = week.days.get(date) || 0, hours = Number(card.hours), after = before + hours;
    const doubleLine = overtime.dailyDoubleOver ?? Infinity;
    const regularLine = Math.min(overtime.dailyOver ?? Infinity, doubleLine);
    let REG = Math.max(0, Math.min(after, regularLine) - Math.min(before, regularLine));
    const DT = Math.max(0, after - Math.max(before, doubleLine));
    let OT = hours - REG - DT;
    const weeklyOT = Math.max(0, REG - Math.max(0, (overtime.weeklyOver ?? Infinity) - week.regular));
    week.regular += REG;
    REG -= weeklyOT;
    OT += weeklyOT;
    week.days.set(date, after);
    if (!from || date >= from && date <= to) {
      week.rows.push({ punchId: card.id ?? null, projectId: card.projectId ?? null, date, REG, OT: Math.max(0, OT), DT });
    }
  }
  return [...weeks.values()].filter(week => week.rows.length).map(week => {
    const rows = roundRows(week.rows);
    return {
      memberId: week.memberId, weekStart: week.weekStart, ...totals(rows),
      jobs: breakdown(rows, 'projectId'), days: breakdown(rows, 'date'),
      punches: rows.map(row => ({ punchId: row.punchId, projectId: row.projectId, date: row.date, ...totals([row]) }))
    };
  });
}

module.exports = { DEFAULT_OVERTIME, companyPayroll, validatePayroll, splitHours };
