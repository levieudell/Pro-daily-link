'use strict';
// Linked project-task scheduling engine: business-day arithmetic, dependency
// chains, cycle rejection, and cascade change detection.
const assert = require('node:assert/strict');
const engine = require('./project-schedule');

// Business-day arithmetic
assert.equal(engine.isBusinessDay(engine.toDate('2026-10-05')), true, 'Monday is a business day');
assert.equal(engine.isBusinessDay(engine.toDate('2026-10-10')), false, 'Saturday is not');
assert.equal(engine.isBusinessDay(engine.toDate('2026-10-11')), false, 'Sunday is not');
assert.equal(engine.nextBusinessDay('2026-10-09'), '2026-10-12', 'Friday rolls to Monday');
assert.equal(engine.addBusinessDays('2026-10-09', 1), '2026-10-09', 'a one-day task ends the day it starts');
assert.equal(engine.addBusinessDays('2026-10-05', 5), '2026-10-09', 'five working days from Monday lands Friday');
assert.equal(engine.addBusinessDays('2026-10-08', 3), '2026-10-12', 'Thu + 3 working days crosses the weekend');
assert.equal(engine.businessDaysBetween('2026-10-09', '2026-10-12'), 2, 'Fri and Mon both count; the weekend does not');

// Validation
{
  const bad = engine.validate({ name: '  ', durationDays: 2 });
  assert.equal(bad.error, 'A task name is required');
  const badDuration = engine.validate({ name: 'Dig', durationDays: 0 });
  assert.equal(badDuration.error, 'Duration must be 1–365 working days');
  const badMember = engine.validate({ name: 'Dig', durationDays: 2, memberIds: [99] }, null, new Set([1, 2]));
  assert.equal(badMember.error, 'Choose people from this company’s team');
  const ok = engine.validate({ name: ' Dig ', durationDays: '3', predecessorIds: [1, 1, 2] }, null, new Set([1, 2]));
  assert.equal(ok.error, undefined);
  assert.deepEqual(ok.value.predecessorIds, [1, 2], 'duplicate predecessors collapse');
  assert.equal(ok.value.status, 'not-started');
}

// Scheduling
{
  const single = engine.scheduleTasks([{ id: 1, name: 'Mobilize', durationDays: 2, predecessorIds: [] }], '2026-10-05');
  assert.equal(single.error, undefined);
  assert.equal(single.tasks[0].startDate, '2026-10-05');
  assert.equal(single.tasks[0].endDate, '2026-10-06');
}
{
  // Chain: B starts the next business day after A ends; duration cascades.
  const tasks = [
    { id: 1, name: 'Excavate', durationDays: 3, predecessorIds: [] },
    { id: 2, name: 'Footings', durationDays: 2, predecessorIds: [1] },
    { id: 3, name: 'Walls', durationDays: 1, predecessorIds: [2] }
  ];
  const result = engine.scheduleTasks(tasks, '2026-10-05');
  assert.equal(result.error, undefined);
  const byId = new Map(result.tasks.map(t => [t.id, t]));
  assert.equal(byId.get(1).endDate, '2026-10-07');
  assert.equal(byId.get(2).startDate, '2026-10-08');
  assert.equal(byId.get(2).endDate, '2026-10-09');
  assert.equal(byId.get(3).startDate, '2026-10-12', 'Friday finish rolls the successor to Monday');
  // Growing task 1 by a day moves 2 and 3.
  const grown = engine.scheduleTasks(tasks.map(t => t.id === 1 ? { ...t, durationDays: 4 } : t), '2026-10-05');
  const grownById = new Map(grown.tasks.map(t => [t.id, t]));
  assert.equal(grownById.get(1).endDate, '2026-10-08');
  assert.equal(grownById.get(2).startDate, '2026-10-09');
  assert.equal(grownById.get(3).startDate, '2026-10-13');
  const changed = engine.changedDateIds(result.tasks, grown.tasks);
  assert.deepEqual(changed.sort((a, b) => a - b), [1, 2, 3], 'every downstream task reports a date change');
}
{
  // Merge: a task waiting on two predecessors starts after the LATER one.
  const tasks = [
    { id: 1, name: 'A', durationDays: 5, predecessorIds: [] },
    { id: 2, name: 'B', durationDays: 1, predecessorIds: [] },
    { id: 3, name: 'C', durationDays: 2, predecessorIds: [1, 2] }
  ];
  const result = engine.scheduleTasks(tasks, '2026-10-05');
  const byId = new Map(result.tasks.map(t => [t.id, t]));
  assert.equal(byId.get(1).endDate, '2026-10-09');
  assert.equal(byId.get(2).endDate, '2026-10-05');
  assert.equal(byId.get(3).startDate, '2026-10-12', 'starts after A (Friday) not B');
}
{
  // Cycles are rejected, not infinite-looped.
  const loop = engine.scheduleTasks([
    { id: 1, name: 'A', durationDays: 1, predecessorIds: [2] },
    { id: 2, name: 'B', durationDays: 1, predecessorIds: [1] }
  ], '2026-10-05');
  assert.match(loop.error, /link back on themselves/);
  assert.ok(Array.isArray(loop.cycle) && loop.cycle.length === 2);
}
{
  // Unknown predecessor ids are ignored rather than crashing the chain.
  const result = engine.scheduleTasks([{ id: 1, name: 'A', durationDays: 1, predecessorIds: [42] }], '2026-10-05');
  assert.equal(result.tasks[0].startDate, '2026-10-05');
}
{
  // Missing anchor falls back to a valid date.
  const result = engine.scheduleTasks([{ id: 1, name: 'A', durationDays: 1, predecessorIds: [] }], null);
  assert.match(result.tasks[0].startDate, /^\d{4}-\d{2}-\d{2}$/);
}

console.log('project-schedule engine: ok');
