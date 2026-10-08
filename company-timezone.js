(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PDLCompanyTimezone = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';
  const choices = ['America/Los_Angeles', 'America/Denver', 'America/Chicago', 'America/New_York'];
  function valid(zone) { try { return typeof zone === 'string' && zone.length > 0 && zone.length <= 100 && Boolean(new Intl.DateTimeFormat('en', { timeZone: zone })); } catch { return false; } }
  function change(company, input) {
    // Unrelated settings saves never choose or clear a company timezone.
    if (!Object.hasOwn(input, 'timezone') || input.timezone === '' || input.timezone === company.timezone || input.timezoneSelected !== true) return { patch: {} };
    if (!choices.includes(input.timezone)) return { error: 'Choose a supported company timezone before saving it.' };
    return { patch: { timezone: input.timezone } };
  }
  function fields(stored, selected) { return !selected || selected === stored ? {} : { timezone: selected, timezoneSelected: true }; }
  function render(select, status, stored, document) {
    select.querySelector('[data-saved-timezone]')?.remove();
    const saved = valid(stored);
    if (saved && !choices.includes(stored)) {
      const option = document.createElement('option'); option.value = stored; option.textContent = stored + ' (saved timezone)'; option.setAttribute('data-saved-timezone', ''); select.append(option);
    }
    select.value = saved ? stored : '';
    status.textContent = saved ? 'Saved company timezone: ' + stored + '.' : stored ? 'The saved company timezone is invalid. Choose a timezone and save changes.' : 'No company timezone is saved. Choose one and save changes to set company dates and times.';
  }
  return { valid, change, fields, render };
});
