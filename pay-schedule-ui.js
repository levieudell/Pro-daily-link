'use strict';
// Company Settings pay schedule. Computed periods stay on company.payroll.pay_schedule.
(() => {
  const scheduleApi = window.PDLPaySchedule;
  const host = document.querySelector('#pay-schedule-settings');
  if (!scheduleApi || !host || !window.PDLPayPeriods) return;
  const names = scheduleApi.WEEKDAYS;
  const labels = [['weekly', 'Weekly'], ['biweekly', 'Every 2 weeks'], ['semimonthly', 'Twice a month'], ['monthly', 'Monthly']];
  let draft = scheduleApi.emptySchedule();
  const allowed = () => window.PDLPermissions.payrollPageAllowed();
  const today = () => window.PDLPayrollRanges.today(company?.timezone || 'America/Los_Angeles');
  function storedDraft(raw) {
    const input = { ...scheduleApi.emptySchedule(), ...(raw || {}), frequency: raw?.frequency ?? null };
    const weekdayFamily = input.frequency === 'weekly' || input.frequency === 'biweekly';
    if (weekdayFamily && typeof input.period_end_weekday === 'number') {
      if (input.cards_due_weekday == null && input.cards_due_offset_days != null) input.cards_due_weekday = (input.period_end_weekday + input.cards_due_offset_days) % 7;
      if (input.payday_weekday == null && input.payday_offset_days != null) input.payday_weekday = (input.period_end_weekday + input.payday_offset_days) % 7;
    }
    if (weekdayFamily) { input.cards_due_offset_days = null; input.payday_offset_days = null; }
    else { input.cards_due_weekday = null; input.payday_weekday = null; }
    return scheduleApi.validateSchedule(input);
  }
  function savedSchedule() {
    try { return storedDraft(company?.payroll?.pay_schedule); }
    catch (error) { return scheduleApi.emptySchedule(); }
  }
  function dirty() {
    try { return JSON.stringify(scheduleApi.validateSchedule(draft)) !== JSON.stringify(savedSchedule()); }
    catch (error) { return true; }
  }
  function endDayInput(attr, value) {
    const last = value === 'last';
    return `<input ${attr} type="number" min="1" max="28" value="${last ? '' : escapeHtml(value ?? '')}" ${last ? 'disabled aria-disabled="true"' : 'aria-disabled="false"'}>`;
  }
  function shortDate(date) {
    return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' }).format(new Date(date + 'T12:00:00Z'));
  }
  const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  function load() {
    try {
      const stored = storedDraft(company?.payroll?.pay_schedule);
      draft = stored.frequency ? stored : scheduleApi.suggestedWeekly(company?.weekStart);
    } catch (error) { draft = scheduleApi.suggestedWeekly(company?.weekStart); }
  }
  function recentEnds(day) {
    const dates = [];
    let cursor = today();
    for (let i = 0; i < 80 && dates.length < 4; i++) {
      if (scheduleApi.weekday(cursor) === day) dates.push(cursor);
      cursor = scheduleApi.addDays(cursor, -1);
    }
    return dates;
  }
  function chips(items) { return items.map(([key, label, pressed, attr]) => `<button type="button" ${attr}="${escapeHtml(key)}" aria-pressed="${pressed}">${escapeHtml(label)}</button>`).join(''); }
  function weekdayChoices(kind) {
    const key = kind === 'due' ? 'cards_due_weekday' : 'payday_weekday';
    return `<div class="pay-schedule-weekdays" role="group" aria-label="${kind === 'due' ? 'Time cards due' : 'Payday'}">${names.map((name, index) => `<button type="button" data-${kind}-weekday="${index}" aria-pressed="${draft[key] === index}">${name}</button>`).join('')}</div>`;
  }
  function previewState() {
    try {
      const normalized = scheduleApi.validateSchedule(draft);
      if (!normalized.frequency) return { html: '<div class="pay-schedule-preview"><p>Periods stay manual until you save a schedule.</p></div>', error: '' };
      let cursor = today();
      const periods = [0, 1, 2].map(() => {
        const period = scheduleApi.payPeriodFor(normalized, cursor);
        cursor = scheduleApi.addDays(period.end, 1);
        const parts = scheduleApi.previewParts(period);
        return `<p class="pay-schedule-preview-period"><span class="pay-schedule-preview-range">${escapeHtml(parts.range)}</span>${parts.detail ? `<span class="pay-schedule-preview-pay">${escapeHtml(parts.detail)}</span>` : ''}</p>`;
      }).join('');
      return { html: `<div class="pay-schedule-preview"><p class="pay-schedule-preview-title">Next pay periods</p>${periods}</div>`, error: '' };
    } catch (error) { return { html: '<div class="pay-schedule-preview"></div>', error: error.message }; }
  }
  function showError(text) {
    const message = host.querySelector('[data-pay-schedule-error]');
    if (!message) return;
    host.querySelectorAll('[aria-invalid]').forEach(el => { el.removeAttribute('aria-invalid'); el.removeAttribute('aria-describedby'); });
    message.id = 'pay-schedule-error';
    message.textContent = text;
    if (!text) return;
    const selector = /Time cards due/.test(text) ? '[data-offset="cards_due_offset_days"], [data-due-weekday]'
      : /Payday/.test(text) ? '[data-offset="payday_offset_days"], [data-pay-weekday]'
      : /real period end date/.test(text) ? '[data-anchor]'
      : /weekday the pay period ends/.test(text) ? '[data-end-weekday]'
      : /First end day/.test(text) ? '[data-end-index="0"]'
      : /Second end day|two end days/.test(text) ? '[data-end-index="1"]'
      : /End day/.test(text) ? '[data-month-end]' : '[data-pay-frequency]';
    const field = host.querySelector(selector);
    if (field) {
      field.setAttribute('aria-invalid', 'true');
      field.setAttribute('aria-describedby', message.id);
      const row = field.closest('.pay-schedule-weekdays, .pay-schedule-days, .pay-schedule-day-row, label, .pay-schedule-choices');
      (row || field).after(message);
    }
  }
  function refreshInputs() {
    const live = previewState();
    const preview = host.querySelector('.pay-schedule-preview');
    if (preview) preview.outerHTML = live.html;
    showError(live.error);
    const save = host.querySelector('[data-pay-schedule-save]');
    if (save) save.hidden = !dirty();
  }
  function render() {
    const scroller = document.scrollingElement || document.documentElement;
    const scrollY = window.scrollY, scrollTop = scroller.scrollTop;
    if (!allowed()) { host.hidden = true; host.innerHTML = ''; return; }
    host.hidden = false;
    const frequency = draft.frequency;
    const endDays = draft.semimonthly_end_days || [15, 'last'];
    const preview = previewState().html;
    host.innerHTML = `<form id="pay-schedule-form"><div class="pay-schedule-choices" role="group" aria-label="How often">${chips(labels.map(([key, label]) => [key, label, frequency === key, 'data-pay-frequency']))}</div>${frequency === 'weekly' || frequency === 'biweekly' ? `<p class="pay-schedule-legend">Period ends</p><div class="pay-schedule-weekdays" role="group" aria-label="Period end weekday">${chips(names.map((name, index) => [index, name, draft.period_end_weekday === index, 'data-end-weekday']))}</div>` : ''}${frequency === 'biweekly' && draft.period_end_weekday != null ? `<p id="pay-schedule-anchor-label">Your last payroll end date</p><div class="pay-schedule-days" role="group" aria-labelledby="pay-schedule-anchor-label">${recentEnds(draft.period_end_weekday).map(date => `<button type="button" data-anchor="${date}" aria-pressed="${draft.anchor_end_date === date}">${escapeHtml(shortDate(date))}</button>`).join('')}</div>` : ''}${frequency === 'semimonthly' ? `<p>First end day</p><div class="pay-schedule-day-row"><label>Day ${endDayInput('data-end-index="0"', endDays[0])}</label><button type="button" data-end-last="0" aria-pressed="${endDays[0] === 'last'}">Last day</button></div><p>Second end day</p><div class="pay-schedule-day-row"><label>Day ${endDayInput('data-end-index="1"', endDays[1])}</label><button type="button" data-end-last="1" aria-pressed="${endDays[1] === 'last'}">Last day</button></div>` : ''}${frequency === 'monthly' ? `<p>Period ends</p><div class="pay-schedule-day-row"><label>Day ${endDayInput('data-month-end', draft.monthly_end_day)}</label><button type="button" data-month-last aria-pressed="${draft.monthly_end_day === 'last'}">Last day</button></div>` : ''}${frequency === 'weekly' || frequency === 'biweekly' ? `<p class="pay-schedule-legend">Time cards due</p>${weekdayChoices('due')}<p class="pay-schedule-legend">Payday</p>${weekdayChoices('pay')}` : ''}${frequency === 'semimonthly' || frequency === 'monthly' ? `<div class="pay-schedule-offsets"><label>Time cards due: <input data-offset="cards_due_offset_days" type="number" min="0" max="14" value="${draft.cards_due_offset_days ?? ''}"> days after the period ends</label><label>Payday: <input data-offset="payday_offset_days" type="number" min="0" max="30" value="${draft.payday_offset_days ?? ''}"> days after the period ends</label></div>` : ''}${preview}<p data-pay-schedule-status role="status"></p><p data-pay-schedule-error role="alert"></p><button type="button" data-pay-schedule-save${dirty() ? '' : ' hidden'}>Save</button></form>`;
    showError(previewState().error);
    if (window.scrollY !== scrollY) window.scrollTo(0, scrollY);
    if (scroller.scrollTop !== scrollTop) scroller.scrollTop = scrollTop;
  }
  host.addEventListener('click', event => {
    const frequency = event.target.closest('[data-pay-frequency]');
    const end = event.target.closest('[data-end-weekday]');
    const due = event.target.closest('[data-due-weekday]');
    const pay = event.target.closest('[data-pay-weekday]');
    const anchor = event.target.closest('[data-anchor]');
    const last = event.target.closest('[data-end-last]');
    if (frequency) {
      const next = frequency.dataset.payFrequency;
      const fromWeekday = draft.frequency === 'weekly' || draft.frequency === 'biweekly';
      const toWeekday = next === 'weekly' || next === 'biweekly';
      const sameFamily = draft.frequency != null && fromWeekday === toWeekday;
      draft = { ...scheduleApi.emptySchedule(), frequency: next, period_end_weekday: toWeekday && (sameFamily || draft.period_end_weekday != null) ? draft.period_end_weekday : null, anchor_end_date: next === 'biweekly' && fromWeekday ? draft.anchor_end_date : null, semimonthly_end_days: next === 'semimonthly' ? (draft.semimonthly_end_days || [15, 'last']) : null, monthly_end_day: next === 'monthly' ? (draft.monthly_end_day ?? 'last') : null, cards_due_weekday: toWeekday && sameFamily ? draft.cards_due_weekday : null, payday_weekday: toWeekday && sameFamily ? draft.payday_weekday : null, cards_due_offset_days: !toWeekday && sameFamily ? draft.cards_due_offset_days : null, payday_offset_days: !toWeekday && sameFamily ? draft.payday_offset_days : null };
    }
    else if (end) draft.period_end_weekday = Number(end.dataset.endWeekday);
    else if (due || pay) {
      const key = due ? 'cards_due_weekday' : 'payday_weekday';
      const index = Number((due || pay).dataset[due ? 'dueWeekday' : 'payWeekday']);
      draft[key] = draft[key] === index ? null : index;
    } else if (anchor) draft.anchor_end_date = anchor.dataset.anchor;
    else if (last) { draft.semimonthly_end_days ||= [15, 'last']; draft.semimonthly_end_days[Number(last.dataset.endLast)] = 'last'; }
    else if (event.target.closest('[data-month-last]')) draft.monthly_end_day = 'last';
    else if (event.target.closest('[data-pay-schedule-save]')) { void save(); return; }
    else return;
    render();
  });
  host.addEventListener('input', event => {
    const field = event.target;
    if (field.matches('[data-end-index]')) {
      draft.semimonthly_end_days ||= [15, 'last']; draft.semimonthly_end_days[Number(field.dataset.endIndex)] = Number(field.value);
      host.querySelector(`[data-end-last="${field.dataset.endIndex}"]`).setAttribute('aria-pressed', 'false');
    }
    else if (field.matches('[data-month-end]')) {
      draft.monthly_end_day = Number(field.value);
      host.querySelector('[data-month-last]').setAttribute('aria-pressed', 'false');
    }
    else if (field.matches('[data-offset]')) draft[field.dataset.offset] = field.value === '' ? null : Number(field.value);
    else return;
    refreshInputs();
  });
  function revealFocusedInput() {
    requestAnimationFrame(() => {
      const field = document.activeElement;
      if (host.contains(field) && field.matches('input')) field.scrollIntoView({ block: 'center', inline: 'nearest' });
    });
  }
  host.addEventListener('focusin', revealFocusedInput);
  let keyboardResize;
  window.visualViewport?.addEventListener('resize', () => {
    clearTimeout(keyboardResize);
    keyboardResize = setTimeout(revealFocusedInput, 100);
  });
  async function save() {
    try {
      const pay_schedule = scheduleApi.validateSchedule(draft);
      const saved = await api('/api/company', { method: 'PATCH', body: JSON.stringify({ payroll: { pay_schedule } }) });
      company = saved; draft = storedDraft(saved.payroll.pay_schedule); render();
      host.querySelector('[data-pay-schedule-status]').textContent = 'Pay schedule saved.';
    } catch (error) { showError(error.message || 'Pay schedule could not be saved.'); }
  }
  const previous = window.PDLPayPeriods.refresh;
  window.PDLPayPeriods.refresh = async function () { const result = await previous.apply(this, arguments); load(); render(); return result; };
  const previousPage = showPage;
  showPage = function (page) { const result = previousPage.apply(this, arguments); if (page === 'payroll' || !allowed()) { load(); render(); } return result; };
  load(); render();
})();
