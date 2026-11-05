# Zero-line hours

## Sub-features

- A short punch whose note creates no production line.
- Send must not be blocked by `Crew hours (0.02) must equal allocated work-line hours (0)` or the same sentence with any crew-hour number and allocated hours 0.

## How to get to it

Clock in and clock out on Cedar Grove. Type "Walked the site and talked with the superintendent." Tap Done, then Send to office. That note has no quantity and no work verb the parser turns into a line.

## Driving it with puppeteer

`node .cursor/skills/verify-pro-daily-link/scripts/drive.cjs --journey 6`

The driver waits 75 seconds after clock-in so the punch is one minute, which displays as 0.02 h, then types that note, taps Done, taps `#save-report`, and reads `#report-submit-status` plus the modal text. Pass requires the hours-equality sentence to be absent and no production row to have a quantity or hours. A line with hours means this was not the zero-line case; the journey fails rather than passing on a different daily. A zero-minute punch is also a failure, because it never reaches the 0.02 h crew total in the sentence.

## Gotchas

Run this journey by itself after a staging reseed. The demo field user cannot open a second same-day punch after journeys 1–5. The client skips this equality check when `currentRole === 'field'`, and the server skips `laborAllocationMatches` for a field author. The assertion still looks for the sentence. Seeing it is a failure. Not seeing it on a true zero-line send is a pass, including when Send succeeds or shows a different office-review warning.
