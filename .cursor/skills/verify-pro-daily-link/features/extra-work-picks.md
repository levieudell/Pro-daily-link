# Extra-work picks

## Sub-features

- An unmatched note shows Needs your pick.
- Extra work does not require a quantity.
- The choice survives closing and reopening the daily.
- The equipment pad is on the Extra Work card and not on the production quantity list.

## How to get to it

The sensible note includes "Installed an equipment pad" with no quantity, which does not match Curb, Slab, Footings, Sidewalk, or Gutter. On the review, the flag says Needs your pick. Tap Extra work (`[data-flag-choice="extra"]`). Close the daily and open Edit / correct.

## Driving it with puppeteer

`node .cursor/skills/verify-pro-daily-link/scripts/drive.cjs --journey 4`

The driver taps the Extra work button inside the Needs your pick article with the touchscreen. It fails if `#report-submit-status` says "Enter a quantity for each work line." It taps `#close-report`, opens Daily reports, taps `[data-edit-report]`, and reads `/api/state`. Pass requires a saved extra decision (`scopeFlags` decision `extra` or `extraWork`) and no production entry that is not `extra_work` whose description is the equipment pad.

## Gotchas

The flag is created when Done calls extract. If the notes step never advances, this journey cannot start; record that instead of marking the flag by hand. Reopen uses the saved draft. A second save with a stale `updatedAt` returns 409 "This daily was updated, reloading". That is D7, not a reason to retry with a forced body.
