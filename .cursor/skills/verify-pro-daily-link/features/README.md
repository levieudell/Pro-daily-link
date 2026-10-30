# Features

Each file is one staging journey. Run them with `node .cursor/skills/verify-pro-daily-link/scripts/drive.cjs --journey <n>`. A failure is a finding. Do not relax the assertion, skip the old-screen watch, or type over the voice path to force a pass.

| Journey | File | End state |
| --- | --- | --- |
| 1 | clock-in-out.md | Notes, then review, with no paint of `#end-day-modal` |
| 2 | one-note-daily.md | Spoken transcript is in the note, and the known garbage transcript is rejected |
| 3 | production-vs-estimate.md | Curb and gutter quantities match, and labor minutes sum to the punch |
| 4 | extra-work-picks.md | Extra work needs no quantity, survives reopen, and stays off the production list |
| 5 | office-review.md | Approve stays blocked until the office decides, then the decision sticks |
| 6 | zero-line-hours.md | Send is not blocked by the zero allocated-hours message |

Staging reseeds on deploy and the demo field user has one punch path per day. Run journey 6 on its own after a reseed. Do not drive two browsers against staging at once.
