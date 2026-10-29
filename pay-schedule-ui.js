'use strict';
// Company Settings pay schedule. Computed periods stay on company.payroll.pay_schedule.
(() => {
  const scheduleApi = window.PDLPaySchedule;
  const host = document.querySelector('#pay-schedule-settings');
  if (!scheduleApi || !host || !window.PDLPayPeriods) return;
  const names = scheduleApi.WEEKDAYS;
  const labels = [['weekly', 'Weekly'], ['biweekly', 'Every 2 weeks'], ['semimonthly', 'Twice a month'], ['monthly', 'Monthly']];
  let draft = scheduleApi.emptySchedule();
  const allowed = () => currentRole === 'office' && company?.features?.timeCards === true && (currentUser?.role === 'owner' || (currentUser?.role === 'admin' && currentUser?.permissions?.manageTime === true));
  const today = () => window.PDLPayrollRanges.today(company?.timezone || 'America/Los_Angeles');
  function savedSchedule() {
    const raw = company?.payroll?.pay_schedule || {};
    try { return scheduleApi.validateSchedule({ ...scheduleApi.emptySchedule(), ...raw, frequency: raw.frequency ?? null }); }
    catch (error) { return scheduleApi.emptySchedule(); }
  }
  function dirty() {
    try { return JSON.stringify(scheduleApi.validateSchedule(draft)) !== JSON.stringify(savedSchedule()); }
    catch (error) { return true; }
  }
  function shortDate(date) {
    return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' }).format(new Date(date + 'T12:00:00Z'));
  }
  const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  function load() { draft = scheduleApi.validateSchedule({ ...scheduleApi.emptySchedule(), ...(company?.payroll?.pay_schedule || {}), frequency: company?.payroll?.pay_schedule?.frequency ?? null }); }
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
  function weekdayChoices(kind, selected) {
    const end = draft.period_end_weekday;
    return `<div class="pay-schedule-weekdays" role="group" aria-label="${kind === 'due' ? 'Time cards due' : 'Payday'}">${names.map((name, index) => {
      const offset = end == null ? null : (index - end + 7) % 7;
      const pressed = offset != null && draft[kind === 'due' ? 'cards_due_offset_days' : 'payday_offset_days'] === offset;
      return `<button type="button" data-${kind}-weekday="${index}" aria-pressed="${pressed}">${name}</button>`;
    }).join('')}</div>`;
  }
  function render() {
    if (!allowed()) { host.hidden = true; host.innerHTML = ''; return; }
    host.hidden = false;
    const frequency = draft.frequency;
    const endDays = draft.semimonthly_end_days || [15, 'last'];
    const preview = (() => {
      try {
        const normalized = scheduleApi.validateSchedule(draft);
        if (!normalized.frequency) return '<p>Periods stay manual until you save a schedule.</p>';
        let cursor = today();
        return `<div class="pay-schedule-preview">${[0, 1, 2].map(() => { const period = scheduleApi.payPeriodFor(normalized, cursor); cursor = scheduleApi.addDays(period.end, 1); return `<p>${escapeHtml(scheduleApi.preview(period))}</p>`; }).join('')}</div>`;
      } catch (error) { return `<div class="pay-schedule-preview"><p>${escapeHtml(error.message)}</p></div>`; }
    })();
    host.innerHTML = `<form id="pay-schedule-form"><div class="pay-schedule-choices" role="group" aria-label="How often">${chips(labels.map(([key, label]) => [key, label, frequency === key, 'data-pay-frequency']))}</div>${frequency === 'weekly' || frequency === 'biweekly' ? `<p>Period ends</p><div class="pay-schedule-weekdays" role="group" aria-label="Period end weekday">${chips(names.map((name, index) => [index, name, draft.period_end_weekday === index, 'data-end-weekday']))}</div>` : ''}${frequency === 'biweekly' && draft.period_end_weekday != null ? `<p>A recent end date</p><div class="pay-schedule-days">${recentEnds(draft.period_end_weekday).map(date => `<button type="button" data-anchor="${date}" aria-pressed="${draft.anchor_end_date === date}">${escapeHtml(shortDate(date))}</button>`).join('')}</div>` : ''}${frequency === 'semimonthly' ? `<p>First end day</p><div class="pay-schedule-day-row"><label>Day <input data-end-index="0" type="number" min="1" max="28" value="${endDays[0] === 'last' ? '' : endDays[0]}"></label><button type="button" data-end-last="0" aria-pressed="${endDays[0] === 'last'}">Last day</button></div><p>Second end day</p><div class="pay-schedule-day-row"><label>Day <input data-end-index="1" type="number" min="1" max="28" value="${endDays[1] === 'last' ? '' : endDays[1]}"></label><button type="button" data-end-last="1" aria-pressed="${endDays[1] === 'last'}">Last day</button></div>` : ''}${frequency === 'monthly' ? `<p>Period ends</p><div class="pay-schedule-day-row"><label>Day <input data-month-end type="number" min="1" max="28" value="${draft.monthly_end_day === 'last' ? '' : (draft.monthly_end_day || '')}"></label><button type="button" data-month-last aria-pressed="${draft.monthly_end_day === 'last'}">Last day</button></div>` : ''}${frequency === 'weekly' || frequency === 'biweekly' ? `<p>Time cards due</p>${weekdayChoices('due')}<p>Payday</p>${weekdayChoices('pay')}` : ''}${frequency === 'semimonthly' || frequency === 'monthly' ? `<div class="pay-schedule-offsets"><label>Time cards due <input data-offset="cards_due_offset_days" type="number" min="0" max="14" value="${draft.cards_due_offset_days ?? ''}"></label><label>Payday <input data-offset="payday_offset_days" type="number" min="0" max="30" value="${draft.payday_offset_days ?? ''}"></label></div>` : ''}${preview}<p data-pay-schedule-status role="status"></p><p data-pay-schedule-error role="alert"></p><button type="button" data-pay-schedule-save${dirty() ? '' : ' hidden'}>Save</button></form>`;
  }
  host.addEventListener('click', event => {
    const frequency = event.target.closest('[data-pay-frequency]');
    const end = event.target.closest('[data-end-weekday]');
    const due = event.target.closest('[data-due-weekday]');
    const pay = event.target.closest('[data-pay-weekday]');
    const anchor = event.target.closest('[data-anchor]');
    const last = event.target.closest('[data-end-last]');
    if (frequency) draft = { ...scheduleApi.emptySchedule(), frequency: frequency.dataset.payFrequency, period_end_weekday: draft.period_end_weekday, cards_due_offset_days: draft.cards_due_offset_days, payday_offset_days: draft.payday_offset_days, semimonthly_end_days: frequency.dataset.payFrequency === 'semimonthly' ? (draft.semimonthly_end_days || [15, 'last']) : null, monthly_end_day: frequency.dataset.payFrequency === 'monthly' ? (draft.monthly_end_day || 'last') : null };
    else if (end) draft.period_end_weekday = Number(end.dataset.endWeekday);
    else if (due || pay) {
      const button = due || pay;
      const index = Number((due || pay).dataset[due ? 'dueWeekday' : 'payWeekday']);
      draft[due ? 'cards_due_offset_days' : 'payday_offset_days'] = (index - draft.period_end_weekday + 7) % 7;
    } else if (anchor) draft.anchor_end_date = anchor.dataset.anchor;
    else if (last) { draft.semimonthly_end_days ||= [15, 'last']; draft.semimonthly_end_days[Number(last.dataset.endLast)] = 'last'; }
    else if (event.target.closest('[data-month-last]')) draft.monthly_end_day = 'last';
    else if (event.target.closest('[data-pay-schedule-save]')) { void save(); return; }
    else return;
    render();
  });
  host.addEventListener('input', event => {
    const field = event.target;
    if (field.matches('[data-end-index]')) { draft.semimonthly_end_days ||= [15, 'last']; draft.semimonthly_end_days[Number(field.dataset.endIndex)] = Number(field.value); }
    else if (field.matches('[data-month-end]')) draft.monthly_end_day = Number(field.value);
    else if (field.matches('[data-offset]')) draft[field.dataset.offset] = field.value === '' ? null : Number(field.value);
    else return;
    render();
  });
  async function save() {
    const message = host.querySelector('[data-pay-schedule-error]');
    try {
      const pay_schedule = scheduleApi.validateSchedule(draft);
      const saved = await api('/api/company', { method: 'PATCH', body: JSON.stringify({ payroll: { pay_schedule } }) });
      company = saved; draft = scheduleApi.validateSchedule(saved.payroll.pay_schedule); render();
      host.querySelector('[data-pay-schedule-status]').textContent = 'Pay schedule saved.';
    } catch (error) { if (message) message.textContent = error.message || 'Pay schedule could not be saved.'; }
  }
  const previous = window.PDLPayPeriods.refresh;
  window.PDLPayPeriods.refresh = async function () { const result = await previous.apply(this, arguments); load(); render(); return result; };
  load(); render();
})();
