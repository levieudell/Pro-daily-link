(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PDLPayrollRanges = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';
  function validDate(value) {
    return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
  }
  function addDays(date, days) {
    const value = new Date(date + 'T00:00:00Z');
    value.setUTCDate(value.getUTCDate() + days);
    return value.toISOString().slice(0, 10);
  }
  function weekStart(date, start = 'monday') {
    const day = new Date(date + 'T00:00:00Z').getUTCDay();
    return addDays(date, -((day - (start === 'sunday' ? 0 : 1) + 7) % 7));
  }
  function today(timeZone, now = new Date()) {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
    return ['year', 'month', 'day'].map(type => parts.find(part => part.type === type).value).join('-');
  }
  function range(preset, date, start = 'monday') {
    if (!validDate(date) || !['monday', 'sunday'].includes(start)) return null;
    const from = weekStart(date, start);
    if (preset === 'week') return { from, to: addDays(from, 6) };
    if (preset === 'last') return { from: addDays(from, -7), to: addDays(from, -1) };
    if (preset === 'today') return { from: date, to: date };
    if (preset === 'wtd') return { from, to: date };
    return null;
  }
  return { validDate, addDays, weekStart, today, range };
});
