# Automatic schedule date selection — local follow-up

Branch `codex/schedule-auto-date`, based on live `7b4047c731113c84710701010cc7e29d05f71fb8`. User subsequently explicitly approved publishing this fix together with the subcontractor alert and mobile Team fixes.

Remove the extra Go to date button. A valid date field `change` commits the chosen local date, rerenders the schedule and closes the dialog. Day/Week/Month mode is retained. Intermediate `input` events are not used. Reopening permits another selection; duplicate/late events after dismissal are ignored. Enter remains a keyboard fallback. Native showPicker/visible field fallback, invalid-date validation, focus restoration, arrows and Today remain intact.

Cancel/close/backdrop pointerdown prevents a subsequent blur/change from committing while dismissing. Dismissal before a committed change leaves the schedule unchanged. The browser owns native picker commit semantics; do not claim actual iOS wheel behavior has been observed.

Event reference: https://developer.mozilla.org/en-US/docs/Web/API/HTMLElement/change_event describes selecting a date as a committed change, unlike each intermediate input alteration.

Validation: extended VM regression runs in Los Angeles, Kiritimati and UTC for local dates/DST/leap day, mode preservation, repeated selection/late changes, Cancel before blur, invalid inputs, Enter, native fallback, Today and arrows. Full final 32-command npm test, syntax and diff checks passed. No real browser/device runtime was available.

Device acceptance: on iPhone choose a date and confirm the schedule updates without a PDL confirmation button; wheel movement should not close the picker prematurely; native cancel and app Cancel/backdrop should retain the old date before commit. Check repeated picks, keyboard fallback, all modes, arrows and Today. Platform-native Done controls, if provided, remain platform controlled.
