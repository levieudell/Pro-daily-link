(function(root){
  'use strict';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function date(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
    return match ? `${match[2]}/${match[3]}/${match[1]}` : String(value || '');
  }
  function duration(seconds) {
    if (seconds == null || !Number.isFinite(Number(seconds)) || Number(seconds) < 0) return 'Not available';
    const total = Math.round(Number(seconds)), hours = Math.floor(total / 3600), minutes = Math.floor(total % 3600 / 60), remainder = total % 60;
    return [hours ? `${hours} h` : '', minutes ? `${minutes} min` : '', remainder || !total ? `${remainder} sec` : ''].filter(Boolean).join(' ');
  }
  function warning(report, members) {
    const review = report.officeReview;
    if (!review?.reasons?.length) return '';
    const name = id => members.find(row => Number(row.id) === Number(id))?.name || `Team member ${id}`;
    const reasons = [...new Set(review.reasons.map(row => row.message).filter(Boolean))];
    return `<section class="office-review-warning" aria-label="Daily needs review"><h3>Check before approval</h3><ul>${reasons.map(message => `<li>${esc(message)}</li>`).join('')}</ul><button type="button" class="secondary" data-review-daily="${esc(report.id)}">Review / correct daily</button><details><summary>Details: reported and clock hours</summary><p>Reported hours and clock time are separate evidence. Correct the daily before approval; clock punches stay unchanged.</p><dl>${(review.reportedLabor || []).map(row => `<div><dt>${esc(name(row.memberId))} · reported</dt><dd>${row.hours == null ? 'Not entered' : esc(row.hours) + ' h'}</dd></div>`).join('')}${(review.measuredClock || []).map(row => `<div><dt>${esc(name(row.memberId))} · clock</dt><dd>${esc(duration(row.seconds))}</dd></div>`).join('')}</dl>${!(review.measuredClock || []).length ? '<p>No measured clock time available.</p>' : ''}</details></section>`;
  }
  const api = {date, duration, warning};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PDLOfficeReview = api;
})(typeof window !== 'undefined' ? window : globalThis);
