'use strict';
// A live download, separate from the existing immutable pay-period snapshots.
(() => {
  const calendar = window.PDLPayrollRanges;
  const dialog = document.querySelector('#payroll-export-dialog');
  const find = selector => dialog.querySelector(selector);
  let identity = '', controller = null;
  const context = () => JSON.stringify([signedInCompanyId(), currentUser?.id, currentUser?.role, currentUser?.permissions, currentRole]);
  const allowed = () => currentRole === 'office' && company?.features?.timeCards === true && (currentUser?.role === 'owner' || currentUser?.role === 'admin' && currentUser?.permissions?.manageTime === true);
  const dates = () => ({ from: find('#payroll-export-from').value, to: find('#payroll-export-to').value });
  function notice(count) {
    find('#payroll-export-warning').hidden = !count;
    find('#payroll-export-count').textContent = `${count} ${count === 1 ? 'punch not approved yet. It’s left out.' : "punches not approved yet. They're left out."}`;
  }
  function refresh() {
    const { from, to } = dates(), zone = company?.timezone || 'America/Los_Angeles';
    find('#payroll-export-range').textContent = `${from} through ${to} · ${zone}`;
    notice(timeCards.filter(card => !card.deletedAt && !timeCardApproved(card) && (() => { const day = timePeriodDate(card, zone); return day && day >= from && day <= to; })()).length);
    find('#payroll-export-error').textContent = '';
  }
  function choose(preset) {
    dialog.querySelectorAll('[data-payroll-range]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.payrollRange === preset)));
    find('#payroll-export-custom').hidden = preset !== 'custom';
    if (preset !== 'custom') {
      const range = calendar.range(preset, calendar.today(company?.timezone || 'America/Los_Angeles'), company?.weekStart || 'monday');
      find('#payroll-export-from').value = range.from;
      find('#payroll-export-to').value = range.to;
    }
    refresh();
  }
  function close() { controller?.abort(); controller = null; identity = ''; if (dialog.open) dialog.close(); }
  document.addEventListener('click', event => {
    if (!event.target.closest('[data-payroll-export-open]') || !allowed()) return;
    identity = context(); choose('week'); dialog.showModal();
  });
  dialog.addEventListener('close', close);
  find('[data-payroll-close]').addEventListener('click', close);
  dialog.querySelectorAll('[data-payroll-range]').forEach(button => button.addEventListener('click', () => choose(button.dataset.payrollRange)));
  dialog.querySelectorAll('input').forEach(input => input.addEventListener('input', refresh));
  find('#payroll-export-approve').addEventListener('click', () => {
    const range = dates(); close(); showPage('timecards'); window.PDLPayPeriods.reviewRange(range.from, range.to);
  });
  dialog.querySelectorAll('[data-payroll-download]').forEach(button => button.addEventListener('click', async () => {
    if (!allowed() || identity !== context()) { close(); return; }
    const range = dates(), error = find('#payroll-export-error'); error.textContent = '';
    if (!calendar.validDate(range.from) || !calendar.validDate(range.to) || range.from > range.to) { error.textContent = 'Choose a valid start and end date.'; error.scrollIntoView({ block: 'nearest' }); return; }
    const requestContext = identity, request = new AbortController(); controller = request;
    const buttons = [...dialog.querySelectorAll('[data-payroll-download]')];
    buttons.forEach(item => item.disabled = true); dialog.setAttribute('aria-busy', 'true');
    try {
      const format = button.dataset.payrollDownload;
      const response = await fetch('/api/payroll/export?' + new URLSearchParams({ ...range, format }), { credentials: 'same-origin', headers: { 'X-PDL-Company': signedInCompanyId() }, signal: request.signal });
      if (!response.ok) throw new Error((await response.json()).error || 'Payroll download failed. Try again.');
      const blob = await response.blob();
      if (!dialog.open || identity !== requestContext || context() !== requestContext || request.signal.aborted) return;
      notice(Number(response.headers.get('X-PDL-Unapproved-Punches')) || 0);
      const url = URL.createObjectURL(blob), link = document.createElement('a');
      link.href = url; link.download = `pdl-payroll-${range.from}-to-${range.to}.${format}`;
      link.hidden = true; document.body.append(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (failure) {
      if (!request.signal.aborted && context() === requestContext && identity === requestContext) { error.textContent = failure.message; error.scrollIntoView({ block: 'nearest' }); }
    } finally {
      if (controller === request || !controller) {
        controller = null; buttons.forEach(item => item.disabled = false); dialog.removeAttribute('aria-busy');
      }
    }
  }));
  const originalRender = renderTimeCards;
  renderTimeCards = function () { if (dialog.open && (!allowed() || identity !== context())) close(); return originalRender.apply(this, arguments); };
})();
