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
    if (preset === 'last2') return { from: addDays(from, -14), to: addDays(from, -1) };
    if (preset === 'month') { const first = date.slice(0, 8) + '01', next = new Date(first + 'T00:00:00Z'); next.setUTCMonth(next.getUTCMonth() + 1); return { from: first, to: addDays(next.toISOString().slice(0, 10), -1) }; }
    if (preset === 'today') return { from: date, to: date };
    if (preset === 'wtd') return { from, to: date };
    return null;
  }
  function label(from, to, currentYear) {
    const format = value => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', ...(value.slice(0, 4) !== String(currentYear) ? { year: 'numeric' } : {}) }).format(new Date(value + 'T12:00:00Z'));
    return validDate(from) && validDate(to) ? `${format(from)} – ${format(to)}` : '';
  }
  function monthDays(month, start = 'monday') {
    const first = month.slice(0, 7) + '-01', next = new Date(first + 'T00:00:00Z'); next.setUTCMonth(next.getUTCMonth() + 1);
    const last = addDays(next.toISOString().slice(0, 10), -1), gridStart = weekStart(first, start), gridEnd = addDays(weekStart(last, start), 6);
    return Array.from({ length: (Date.parse(gridEnd) - Date.parse(gridStart)) / 86400000 + 1 }, (_, i) => addDays(gridStart, i));
  }
  function shiftMonth(date, amount) {
    const d = new Date(date + 'T12:00:00Z'), day = d.getUTCDate(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + amount);
    const end = new Date(d); end.setUTCMonth(end.getUTCMonth() + 1); end.setUTCDate(0); d.setUTCDate(Math.min(day, end.getUTCDate())); return d.toISOString().slice(0, 10);
  }
  return { validDate, addDays, weekStart, today, range, label, monthDays, shiftMonth };
});
