# Production lines versus estimate

## Sub-features

- Notes match Cedar Grove estimate lines: Curb 40 LF (id 1) and Gutter 20 LF (id 5).
- "Used 6 yards of concrete" stays a material, not a third production line.
- Labor minutes on the lines sum to the closed punch, and the hours shown are the largest-remainder display of those minutes.

## How to get to it

Use the one-note daily. Tap `#report-next-step` (Done on the phone layout). The review cards and `.production-entry` rows are the check.

## Driving it with puppeteer

`node .cursor/skills/verify-pro-daily-link/scripts/drive.cjs --journey 3`

The driver waits 125 seconds after clock-in so `elapsedMinutes` is at least two, then clocks out, enters the sensible note (by voice when journey 2 is in the same run, otherwise by typing into `#field-notes`), and taps Done. It reads `[data-review-labor]` and `.production-hours`, reads the closed time card from `/api/state`, and compares the minute sum with the punch. Displayed hours must equal `displayHoursForMinutes` in `scripts/lib.cjs`, the same largest-remainder rule as `splitLargestRemainder` in `field-daily-scope.js`.

## Gotchas

A punch under one minute floors to 0. The journey then fails because there is nothing to split. Do not treat 0 = 0 as a pass. Parsing still runs through `POST /api/ai/extract` when Done is tapped; without an API key the server falls back to the local parser. Run this journey in the same session as clock-out, before a second punch.
