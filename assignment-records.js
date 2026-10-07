'use strict';

// Shared by the manual schedule and the assistant. Notifications stay on the
// assignment so My Day and acknowledgement keep using the same source of truth.
function createAssignmentRows(db, input, dates, at = new Date().toISOString()) {
  let id = (db.assignments || []).reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1;
  return dates.map(date => ({
    id: id++, projectId: Number(input.projectId), memberIds: input.memberIds,
    crew: input.crew || null, date, start: input.start, end: input.end,
    activity: String(input.activity || 'Scheduled work').slice(0, 120),
    ...(input.instructions ? { instructions: input.instructions } : {}),
    notifications: Object.fromEntries(input.memberIds.map(memberId => [memberId, { inAppAt: at, emailStatus: 'not_available' }])),
    acknowledgements: {}
  }));
}

module.exports = { createAssignmentRows };
