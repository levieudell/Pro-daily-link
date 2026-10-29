'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { splitHours, validatePayroll, companyPayroll, DEFAULT_OVERTIME } = require('./payroll-overtime');
const rules = (overtime = {}, extra = {}) => ({ overtime: { ...DEFAULT_OVERTIME, ...overtime }, timeZone: 'UTC', weekStart: 'monday', ...extra });
const card = (date, hours, extra = {}) => ({ id: date, memberId: 1, projectId: 10, status: 'approved', inAt: date + 'T08:00:00Z', outAt: new Date(Date.parse(date + 'T08:00:00Z') + hours * 3600000).toISOString(), hours, ...extra });
const pay = value => [value.REG, value.OT, value.DT];
const week = () => Array.from({ length: 5 }, (_, i) => card('2026-10-' + (19 + i), 9));
const toCents = n => Math.round(n * 100);

test('defaults, all switches off, daily-only and optional double time', () => {
  assert.deepEqual(companyPayroll({}).overtime, { weeklyOver: 40, dailyOver: null, dailyDoubleOver: null });
  assert.deepEqual(companyPayroll({ payroll: { overtime: { weeklyOver: null } } }).overtime, { weeklyOver: null, dailyOver: null, dailyDoubleOver: null });
  assert.deepEqual(pay(splitHours([card('2026-10-19', 10)], rules({ dailyOver: 8 }))[0]), [8, 2, 0]);
  assert.deepEqual(pay(splitHours([card('2026-10-19', 10)], rules({ weeklyOver: null, dailyOver: 8 }))[0]), [8, 2, 0]);
  assert.deepEqual(pay(splitHours([card('2026-10-19', 13)], rules({ dailyOver: 8, dailyDoubleOver: 12 }))[0]), [8, 4, 1]);
  assert.deepEqual(pay(splitHours([card('2026-10-19', 13)], rules({ weeklyOver: null, dailyDoubleOver: 12 }))[0]), [12, 0, 1]);
  assert.deepEqual(pay(splitHours(week(), rules({ weeklyOver: null }))[0]), [45, 0, 0]);
});
test('weekly and daily overtime never double count', () => {
  assert.deepEqual(pay(splitHours(week(), rules())[0]), [40, 5, 0]);
  assert.deepEqual(pay(splitHours(week(), rules({ dailyOver: 8 }))[0]), [40, 5, 0]);
  const sixDays = [...week(), card('2026-10-24', 13)];
  assert.deepEqual(pay(splitHours(sixDays, rules({ dailyOver: 8, dailyDoubleOver: 12 }))[0]), [40, 17, 1]);
});
test('18:00–04:00 belongs to the start day and start workweek', () => {
  const overnight = card('2026-10-25', 10, { inAt: '2026-10-26T01:00:00Z', outAt: '2026-10-26T11:00:00Z', date: 'wrong-stored-date' });
  const result = splitHours([overnight], rules({ dailyOver: 8 }, { timeZone: 'America/Los_Angeles' }))[0];
  assert.deepEqual(pay(result), [8, 2, 0]);
  assert.equal(result.weekStart, '2026-10-19');
  assert.equal(result.days[0].date, '2026-10-25');
  assert.deepEqual(splitHours([overnight], rules({ dailyOver: 8 }, { timeZone: 'America/Los_Angeles', from: '2026-10-26', to: '2026-10-26' })), []);
});
test('daily allocation uses chronological job punches, including repeated jobs and extra work', () => {
  const input = [
    card('2026-10-19', 6, { id: 'early', projectId: 10 }),
    card('2026-10-19', 5, { id: 'middle', projectId: 20, inAt: '2026-10-19T14:00:00Z', outAt: '2026-10-19T19:00:00Z', extraWork: true }),
    card('2026-10-19', 2, { id: 'late', projectId: 10, inAt: '2026-10-19T19:00:00Z', outAt: '2026-10-19T21:00:00Z' })
  ];
  const result = splitHours(input.toReversed(), rules({ dailyOver: 8, dailyDoubleOver: 12 }))[0];
  assert.deepEqual(result.punches.map(pay), [[6, 0, 0], [2, 3, 0], [0, 1, 1]]);
  assert.deepEqual(result.jobs.map(pay), [[6, 1, 1], [2, 3, 0]]);
  assert.deepEqual(pay(result), [8, 4, 1]);
  assert.equal(JSON.stringify(result).includes('extraWork'), false);
});
test('weekly threshold assigns the last hours to their jobs', () => {
  const input = [...week().slice(0, 4), card('2026-10-23', 3, { id: 'first', projectId: 20 }), card('2026-10-23', 6, { id: 'last', projectId: 30, inAt: '2026-10-23T11:00:00Z', outAt: '2026-10-23T17:00:00Z' })];
  const result = splitHours(input.toReversed(), rules())[0];
  assert.deepEqual(result.jobs.map(pay), [[36, 0, 0], [3, 0, 0], [1, 5, 0]]);
});
test('range edges retain the full-week context but output only requested start dates', () => {
  const input = [...week(), card('2026-10-26', 9)];
  let result = splitHours(input, rules({}, { from: '2026-10-23', to: '2026-10-26' }));
  assert.deepEqual(result.map(pay), [[4, 5, 0], [9, 0, 0]]);
  assert.deepEqual(result[0].days.map(row => row.date), ['2026-10-23']);
  result = splitHours(input, rules({ dailyOver: 8 }, { from: '2026-10-23', to: '2026-10-23' }));
  assert.deepEqual(pay(result[0]), [8, 1, 0]);
  assert.deepEqual(pay(splitHours(input, rules({}, { from: '2026-10-19', to: '2026-10-20' }))[0]), [18, 0, 0]);
});
test('reuse Sunday week start, keep workers separate, and ignore browser timezone/DST', () => {
  const input = [card('2026-10-24', 10), card('2026-10-25', 10), card('2026-10-25', 10, { memberId: 2 })];
  const result = splitHours(input, rules({ weeklyOver: 10 }, { weekStart: 'sunday' }));
  assert.deepEqual(result.map(row => [row.memberId, row.weekStart, ...pay(row)]), [[1, '2026-10-18', 10, 0, 0], [1, '2026-10-25', 10, 0, 0], [2, '2026-10-25', 10, 0, 0]]);
  const dst = card('2026-11-01', 9, { inAt: '2026-11-01T07:00:00Z', outAt: '2026-11-01T16:00:00Z' });
  assert.deepEqual(pay(splitHours([dst], rules({ dailyOver: 8 }, { timeZone: 'America/Los_Angeles' }))[0]), [8, 1, 0]);
});
test('approval exactly matches existing status and legacy metadata precedence', () => {
  const statuses = [
    { status: 'Approved' }, { status: undefined, Status: 'approved' }, { status: undefined, state: 'approved' },
    { status: undefined, approvalStatus: 'approved' }, { status: undefined, approvedAt: '2026-10-20' },
    { status: undefined, approvedBy: 'Office', history: [{ action: 'Unapproved' }, { action: 'Approved' }] },
    { status: 'submitted', approvedAt: 'old' }, { status: 'draft', approvedBy: 'Office' }, { status: undefined },
    { status: undefined, approvedAt: 'old', history: [{ action: 'Approved' }, { action: 'Unapproved' }] },
    { status: 'approved', deletedAt: '2026-10-20' }
  ];
  assert.equal(splitHours(statuses.map((status, i) => card('2026-10-19', 1, { id: i, ...status })), rules())[0].total, 6);
  assert.deepEqual(splitHours([card('2026-10-19', 1, { status: 'draft', inAt: null })], rules()), []);
  assert.throws(() => splitHours([card('2026-10-19', 1, { outAt: null })], rules()), /Approved punches/);
});
test('stored punch hours (after deductions) are authoritative; input is never mutated', () => {
  const input = [card('2026-10-19', 10, { hours: 9.5 })], options = rules({ dailyOver: 8 });
  const before = JSON.stringify([input, options]);
  assert.deepEqual(pay(splitHours(input, options)[0]), [8, 1.5, 0]);
  assert.equal(JSON.stringify([input, options]), before);
});
test('fractional thresholds and rounding drift conserve cents across every output level', () => {
  for (const hours of [[0.3333, 0.3333, 0.3334], [7.9999, 0.0001, 1.33333], Array(101).fill(0.006), Array(101).fill(0.004)]) {
    const input = hours.map((h, i) => card('2026-10-19', h, { id: i, projectId: i % 3, inAt: new Date(Date.parse('2026-10-19T00:00:00Z') + i * 60000).toISOString(), outAt: new Date(Date.parse('2026-10-19T01:00:00Z') + i * 60000).toISOString() }));
    const result = splitHours(input, rules({ weeklyOver: 0.25, dailyOver: 0.5, dailyDoubleOver: 0.75 }))[0];
    assert.equal(toCents(result.total), toCents(hours.reduce((a, b) => a + b, 0)));
    for (const collection of [result.jobs, result.days, result.punches]) {
      for (const category of ['REG', 'OT', 'DT', 'total']) assert.equal(collection.reduce((sum, row) => sum + toCents(row[category]), 0), toCents(result[category]));
      for (const row of collection) { assert.ok(pay(row).every(n => n >= 0)); assert.equal(pay(row).reduce((sum, n) => sum + toCents(n), 0), toCents(row.total)); }
    }
  }
});

function assertBreakdowns(result) {
  for (const collection of [result.jobs, result.days, result.punches]) {
    for (const key of ['REG', 'OT', 'DT', 'total']) {
      assert.equal(collection.reduce((sum, row) => sum + toCents(row[key]), 0), toCents(result[key]), key);
    }
    for (const row of collection) {
      assert(pay(row).every(value => value >= 0));
      assert.equal(pay(row).reduce((sum, value) => sum + toCents(value), 0), toCents(row.total));
    }
  }
  for (const punch of result.punches) {
    for (const key of ['REG', 'OT', 'DT']) assert.equal(Number(punch[key].toFixed(2)), punch[key]);
  }
}

test('round worker-week categories before allocating cents to punches and jobs', () => {
  for (const [count, hours, weeklyOver, expected] of [
    [5, 8.3333, 40, [40, 1.67, 0]],
    [6, 7.1234, 40, [40, 2.74, 0]],
    [3, 2.3333, 5, [5, 2, 0]]
  ]) {
    const input = Array.from({ length: count }, (_, i) => card(`2026-10-${19 + i}`, hours, { projectId: i % 3 }));
    const result = splitHours(input, rules({ weeklyOver }))[0];
    assert.deepEqual(pay(result), expected);
    assert.equal(toCents(result.total), toCents(count * hours));
    assertBreakdowns(result);
  }
});

// Deterministic random weeks keep failures reproducible. The independent oracle
// classifies whole minutes and never uses the production floating-hour splitter.
function randomWeeks(seed) {
  let state = seed;
  const random = max => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state % max; };
  return () => {
    const input = [], minutes = [];
    for (let day = 0, count = 1 + random(7); day < count; day++) {
      const date = `2026-10-${19 + day}`;
      let elapsed = 0;
      minutes[day] = 0;
      for (let punch = 0, count = 1 + random(3); punch < count; punch++) {
        const duration = 1 + random(300), start = Date.parse(date + 'T00:00:00Z') + elapsed * 60000;
        input.push(card(date, duration / 60, { id: input.length, projectId: random(4), inAt: new Date(start).toISOString(), outAt: new Date(start + duration * 60000).toISOString() }));
        elapsed += duration;
        minutes[day] += duration;
      }
    }
    return { input, minutes };
  };
}

test('2000 random minute-level weeks match each exact rounded category and the punch sum', () => {
  const next = randomWeeks(291);
  for (let i = 0; i < 2000; i++) {
    const { input, minutes } = next(), limit = [5, 20, 40][i % 3];
    const sum = minutes.reduce((a, b) => a + b, 0);
    const exact = [Math.min(sum, limit * 60), Math.max(0, sum - limit * 60), 0];
    const result = splitHours(input.toReversed(), rules({ weeklyOver: limit }))[0];
    assert.deepEqual(pay(result).map(toCents), exact.map(value => Math.round(value * 100 / 60)), `week ${i}`);
    assert.equal(toCents(result.total), Math.round(sum * 100 / 60), `punch sum ${i}`);
    assertBreakdowns(result);
  }
});

test('1000 mixed-rule minute-level weeks preserve largest-remainder category targets', () => {
  const next = randomWeeks(1291);
  for (let i = 0; i < 1000; i++) {
    const { input, minutes } = next();
    const daily = i % 3 ? 8 * 60 : Infinity, double = i % 2 ? 12 * 60 : Infinity, weekly = i % 5 ? 40 * 60 : Infinity;
    const exact = [0, 0, 0];
    for (const day of minutes) {
      const regular = Math.min(day, daily, double), dt = Math.max(0, day - double);
      exact[0] += regular; exact[1] += day - regular - dt; exact[2] += dt;
    }
    const excess = Math.max(0, exact[0] - weekly);
    exact[0] -= excess; exact[1] += excess;
    const expected = exact.map(value => Math.floor(value * 100 / 60));
    const total = Math.round(minutes.reduce((a, b) => a + b, 0) * 100 / 60);
    const rank = [0, 1, 2].sort((a, b) => (exact[b] * 100 % 60) - (exact[a] * 100 % 60) || b - a);
    const remainder = total - expected.reduce((a, b) => a + b, 0);
    for (let cent = 0; cent < remainder; cent++) expected[rank[cent]]++;
    const result = splitHours(input.toReversed(), rules({ weeklyOver: Number.isFinite(weekly) ? weekly / 60 : null, dailyOver: Number.isFinite(daily) ? daily / 60 : null, dailyDoubleOver: Number.isFinite(double) ? double / 60 : null }))[0];
    assert.deepEqual(pay(result).map(toCents), expected, `mixed week ${i}`);
    assert.equal(toCents(result.total), total);
    assertBreakdowns(result);
  }
});

test('category rounding ties cannot create an extra paid cent', () => {
  const result = splitHours([card('2026-10-19', 12 + 1 / 60), card('2026-10-20', 8 + 1 / 60)], rules({ dailyOver: 8, dailyDoubleOver: 12 }))[0];
  // Independent rounding would give 16 + 4.02 + .02 = 20.04, but the
  // approved sum is 20.03. Largest remainder awards the tied cent to DT.
  assert.deepEqual(pay(result), [16, 4.01, 0.02]);
  assert.equal(result.total, 20.03);
  assertBreakdowns(result);
});
test('server validation rejects malformed rules without numeric coercion', () => {
  for (const key of Object.keys(DEFAULT_OVERTIME)) for (const value of [0, -1, '8', '', true, {}, [], NaN, Infinity, undefined]) {
    const label = { weeklyOver: 'Weekly overtime', dailyOver: 'Daily overtime', dailyDoubleOver: 'Double time' }[key];
    assert.throws(() => validatePayroll({ overtime: { ...DEFAULT_OVERTIME, [key]: value } }), error => error.statusCode === 400 && error.message === `${label} must be more than 0 hours, or turn it off.`);
  }
  assert.throws(() => validatePayroll({ overtime: { weeklyOver: 40, dailyOver: 8, dailyDoubleOver: 6 } }), error => error.statusCode === 400 && error.message === 'Double time must start after daily overtime.');
  for (const input of [null, [], {}, { overtime: {} }, { overtime: { ...DEFAULT_OVERTIME, extra: 1 } }, { overtime: DEFAULT_OVERTIME, weekStart: 'mon' }, { overtime: { weeklyOver: 40, dailyOver: 8, dailyDoubleOver: 8 } }, { overtime: { weeklyOver: 40, dailyOver: 8, dailyDoubleOver: 7 } }]) {
    assert.throws(() => validatePayroll(input), error => error.statusCode === 400);
  }
  for (const extra of [{ weekStart: 'friday' }, { timeZone: 'invalid' }, { from: '2026-10-23' }, { from: '2026-10-24', to: '2026-10-23' }, { from: '2026-02-30', to: '2026-03-01' }]) assert.throws(() => splitHours([], rules({}, extra)), error => error.statusCode === 400);
});
