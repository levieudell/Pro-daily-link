'use strict';
const availability = require('./schedule-availability');
const MAX_DAYS = 31, MAX_MEMBERS = 10, MAX_PERSON_DAYS = 100;
const FIELDS = ['action', 'memberIds', 'startDate', 'endDate', 'weekdays', 'start', 'end', 'activity', 'instructions', 'timezone'];
// Calendar arithmetic is UTC only for ISO date labels; shift hours stay company-local.
function expandBatch(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !FIELDS.includes(key)) || input.action !== 'schedule_batch') return { error: 'Review only the supported batch scheduling fields.' };
  if (!Array.isArray(input.memberIds) || !input.memberIds.length || input.memberIds.length > MAX_MEMBERS || input.memberIds.some(id => !Number.isSafeInteger(id) || id <= 0) || new Set(input.memberIds).size !== input.memberIds.length) return { error: 'Choose 1–10 distinct authorized people explicitly.' };
  if (!availability.validDate(input.startDate) || !availability.validDate(input.endDate) || input.endDate < input.startDate) return { error: 'Choose an exact inclusive start/end date range.' };
  const start = Date.parse(input.startDate + 'T12:00:00Z'), end = Date.parse(input.endDate + 'T12:00:00Z');
  if ((end - start) / 86400000 + 1 > MAX_DAYS) return { error: 'Use a range of 31 calendar days or fewer.' };
  if (!Array.isArray(input.weekdays) || !input.weekdays.length || input.weekdays.length > 7 || input.weekdays.some(day => !Number.isInteger(day) || day < 0 || day > 6) || new Set(input.weekdays).size !== input.weekdays.length) return { error: 'Choose the weekdays explicitly, including weekends only when intended.' };
  const dates = [];
  for (let timestamp = start; timestamp <= end; timestamp += 86400000) if (input.weekdays.includes(new Date(timestamp).getUTCDay())) dates.push(new Date(timestamp).toISOString().slice(0, 10));
  if (!dates.length) return { error: 'No dates match these selected weekdays. Review the range and weekdays.' };
  if (dates.length * input.memberIds.length > MAX_PERSON_DAYS) return { error: 'Use 100 person/day combinations or fewer in one batch.' };
  return { input: { ...input, memberIds: [...input.memberIds].sort((a,b) => a-b), weekdays: [...input.weekdays].sort((a,b) => a-b) }, dates, personDays: dates.length * input.memberIds.length };
}
module.exports = { expandBatch, MAX_DAYS, MAX_MEMBERS, MAX_PERSON_DAYS };
