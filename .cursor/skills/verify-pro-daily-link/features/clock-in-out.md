# Clock in and clock out

## Sub-features

- Clock in on DEMO Cedar Grove Clinic as DEMO Jordan Reed only.
- Clock out from `#start-day-button` once it reads Clock out.
- The first painted surface after that tap is the new review (`#field-review-cards` visible).
- The legacy clock-out dialog and the notes step must not paint before that review.

## How to get to it

Sign in as the demo field user. Open the menu and choose the field day page (`data-page="fieldday"`). Tap Clock in, choose project option `3`, leave only Jordan Reed checked, and tap `#confirm-start-day`. Tap the same button again when it says Clock out.

## Driving it with puppeteer

`node .cursor/skills/verify-pro-daily-link/scripts/drive.cjs --journey 1`

The phone page is 390x844 with touch. `pageHooks` in `scripts/lib.cjs` installs a MutationObserver and a requestAnimationFrame sampler on every document. The drive arms that sampler, then taps `#start-day-button`. A hit is any of: `#end-day-modal` open, the heading "What was completed?", visible `#end-day-notes` or `#confirm-end-day` inside that dialog, or `[data-report-step="1"].active` with a visible `#field-notes` while `#field-review-cards` is not visible. The journey passes only when the report modal is open, the review cards are visible, and the sampler recorded no hit.

## Gotchas

`openReport` in `app.js` calls `showReportStep(1)` and then `showModal`. On current main that paints the notes step before `#field-review-cards`. That fails journey 1. Keep the failure. The field Clock out button does not call `showModal` on `#end-day-modal`; both screens are still old-screen hits. If the button already says Clock out, the driver clocks out without starting a second punch. A staging deploy wipes the punch.
