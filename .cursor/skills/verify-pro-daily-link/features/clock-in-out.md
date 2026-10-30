# Clock in and clock out

## Sub-features

- Clock in on DEMO Cedar Grove Clinic as DEMO Jordan Reed only.
- Clock out from `#start-day-button` once it reads Clock out.
- The intended one-note flow paints the notes step, then the review.
- The legacy `#end-day-modal` must not paint from navigation start through that review.

## How to get to it

Sign in as the demo field user. Open the menu and choose the field day page (`data-page="fieldday"`). Tap Clock in, choose project option `3`, leave only Jordan Reed checked, and tap `#confirm-start-day`. Tap the same button again when it says Clock out.

## Driving it with puppeteer

`node .cursor/skills/verify-pro-daily-link/scripts/drive.cjs --journey 1`

The phone page is 390x844 with touch. `pageHooks` in `scripts/lib.cjs` installs a MutationObserver and a requestAnimationFrame sampler on every document, armed immediately. A hit is a visible open `#end-day-modal`, or any visible element whose text contains "What was completed?". The closed dialog's text is not a hit. The notes step is not a hit. A solo run then taps `#report-next-step` and keeps sampling through the review. The journey passes when the daily opened, the review became visible, and the sampler recorded no legacy hit.

`node .cursor/skills/verify-pro-daily-link/scripts/drive.cjs --stale-cache` registers `/sw.js` from the page (the app itself does that only on `https:`), seeds cache `pdl-shell-v1` with a pinned `app.js` whose `openEndDay` opens `#end-day-modal`, and reloads. That probe is expected to record a hit. If the worker does not control the page, the driver unregisters it and answers the pinned `app.js` request with the same patched script.

## Gotchas

`openReport` in `app.js` calls `showReportStep(1)` and then `showModal`. Notes, then review, is the one-note flow. The field Clock out button calls `openEndDay` and does not call `showModal` on `#end-day-modal`. A visible legacy dialog still fails the journey. If the button already says Clock out, the driver clocks out without starting a second punch. A staging deploy wipes the punch. A combined `--journey 1,2` run scores journey 1 on the notes step and does not tap Done, because journey 2 still has to speak there.
