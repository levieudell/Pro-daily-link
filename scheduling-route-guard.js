'use strict';
const schedule = require('./scheduling-access');
const availability = require('./schedule-availability');
const bad = error => ({ status: 400, error });
const denied = () => ({ status: 403, error: 'Your scheduling permission or project/crew access does not allow this action.' });
const members = value => Array.isArray(value) && value.length > 0 && value.length <= 100 && value.every(id => Number.isSafeInteger(id) && id > 0) && new Set(value).size === value.length;
function guard(db, user, method, url, input) {
  if (method === 'GET') return schedule.access(db, user).view ? null : denied();
  if (!input || typeof input !== 'object' || Array.isArray(input)) return bad('Enter a typed scheduling request.');
  const match = url.pathname.match(/^\/api\/assignments\/(\d+)(?:\/(acknowledge))?$/);
  const existing = match && (db.assignments || []).find(row => row.id === Number(match[1]));
  if (match && !existing) return { status: 404, error: 'Assignment not found' };
  const action = match?.[2] ? 'acknowledge' : method === 'POST' ? 'create' : method === 'PATCH' ? 'edit' : 'remove';
  if (!schedule.access(db, user)[action] || existing && !schedule.inScope(db, user, existing, action)) return denied();
  if (action === 'acknowledge') return Object.keys(input).some(key => key !== 'memberId') || Object.hasOwn(input, 'memberId') && input.memberId !== user.memberId ? bad('Only acknowledge your linked member assignment.') : null;
  if (action === 'remove') {
    if (Object.keys(input).length || [...url.searchParams.keys()].some(key => key !== 'memberId')) return bad('Only remove the assignment or an explicitly scheduled person.');
    const raw = url.searchParams.get('memberId');
    return raw !== null && (!/^[1-9][0-9]*$/.test(raw) || !existing.memberIds.includes(Number(raw))) ? bad('Choose a person on this assignment.') : null;
  }
  const keys = action === 'create' ? ['projectId', 'memberIds', 'crew', 'date', 'endDate', 'includeWeekends', 'start', 'end', 'activity', 'requestId'] : input.edit === true ? ['edit', 'projectId', 'memberIds', 'crew', 'date', 'start', 'end', 'activity'] : ['edit', 'memberId', 'targetMemberId', 'date'];
  if (Object.keys(input).some(key => !keys.includes(key))) return bad('Only supported scheduling fields can be changed.');
  if (action === 'create' && (typeof input.requestId !== 'string' || !/^[a-zA-Z0-9_-]{8,128}$/.test(input.requestId))) return bad('An explicit scheduling request ID is required.');
  if (Object.hasOwn(input, 'includeWeekends') && typeof input.includeWeekends !== 'boolean' || Object.hasOwn(input, 'edit') && typeof input.edit !== 'boolean') return bad('Use explicit scheduling choices.');
  if (typeof input.date !== 'string' || !availability.validDate(input.date) || Object.hasOwn(input, 'crew') && input.crew !== null && (typeof input.crew !== 'string' || input.crew.length > 80) || Object.hasOwn(input, 'activity') && (typeof input.activity !== 'string' || input.activity.length > 120)) return bad('Enter a valid date and supported scheduling text.');
  if (input.edit === true || action === 'create') {
    if (typeof input.start !== 'string' || typeof input.end !== 'string' || !availability.validTime(input.start) || !availability.validTime(input.end) || input.start >= input.end || Object.hasOwn(input, 'endDate') && input.endDate !== '' && (typeof input.endDate !== 'string' || !availability.validDate(input.endDate))) return bad('Enter valid dates and a shift ending after it starts.');
  } else if (!Number.isSafeInteger(input.memberId) || !existing.memberIds.includes(input.memberId)) return bad('Choose a person on this assignment.');
  const target = input.edit === true || action === 'create' ? { projectId: input.projectId, memberIds: input.memberIds } : { projectId: existing.projectId, memberIds: [input.targetMemberId] };
  if (!Number.isSafeInteger(target.projectId) || !members(target.memberIds)) return bad('Choose a valid project and distinct people.');
  return schedule.inScope(db, user, target, action) ? null : denied();
}
module.exports = { guard };
