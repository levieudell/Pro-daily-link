'use strict';
(function () {
  const controls = [
    ['scheduling', 'view', '.nav-item[data-page="schedule"],[data-office-tool="schedule"]'],
    ['scheduling', 'create', '#new-assignment,#add-assignment-day'],
    ['scheduling', 'edit', '#edit-assignment'],
    ['scheduling', 'remove', '#remove-assignment,#remove-person'],
    ['scheduling', 'acknowledge', '[data-ack-assignment]'],
    ['daily', 'viewReports', '.nav-item[data-page="reports"],[data-open-daily-report]'],
    ['daily', 'createReports', '#new-report,[data-assignment-daily]'],
    ['daily', 'editReports', '[data-edit-report]'],
    ['daily', 'approveReports', '[data-approve-report]'],
    ['daily', 'viewWorkdays', '.nav-item[data-page="fieldday"]'],
    ['daily', 'runWorkdays', '#start-day-button,[data-start-day],[data-end-day]'],
    ['timeReview', 'viewCards', '.nav-item[data-page="timecards"],[data-office-tool="timecards"]'],
    ['timeReview', 'reviewLeave', '[data-time-off-approve],[data-time-off-decline]'],
    ['timeReview', 'approveCards', '[data-timecard-approve],#timecard-bulk-approve,#timecard-toggle-selection'],
    ['timeReview', 'unapproveCards', '[data-timecard-unapprove]'],
    ['timeWrite', 'createCards', '#timecard-add'],
    ['timeWrite', 'correctCards', '[data-timecard-edit]'],
    ['timeWrite', 'removeCards', '[data-timecard-delete]'],
    ['timeWrite', 'submitCards', '[data-timecard-submit]'],
    ['timeWrite', 'clockCards', '#company-clock,[data-end-company-clock]'],
    ['timeWrite', 'downloadCards', '#timecard-export'],
    ['timeWrite', 'viewPayroll', '[data-office-tool="payreports"],[data-office-payreports]'],
    ['timeWrite', 'configurePeriods', '#pay-period-new,[data-pay-setting-edit],[data-pay-edit]'],
    ['timeWrite', 'captureExports', '[data-pay-capture]'],
    ['timeWrite', 'downloadExports', '[data-pay-download],[data-pay-history]'],
    ['timeOff', 'createRequest', '#new-time-off'],
    ['notes', 'create', '[data-notes-add]'],
    ['notes', 'edit', '[data-note-edit]'],
    ['notes', 'complete', '[data-note-complete]']
  ];
  function apply() {
    if (!window.pdlWorkspaceActions?.enabled() || typeof currentUser === 'undefined') return;
    const gates = currentUser?.effectiveCapabilities;
    for (const [family, action, selector] of controls) for (const node of document.querySelectorAll(selector)) {
      if (gates?.[family]?.[action] !== true) { node.dataset.workspaceRestricted = 'true'; node.hidden = true; if ('disabled' in node) node.disabled = true; }
      else if (node.dataset.workspaceRestricted === 'true') { delete node.dataset.workspaceRestricted; node.hidden = false; if ('disabled' in node) node.disabled = false; }
    }
  }
  const observer = new MutationObserver(apply); observer.observe(document.body, { childList: true, subtree: true }); window.addEventListener('focus', apply); apply();
})();
