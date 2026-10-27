# Office review

## Sub-features

- Approve stays disabled while an extra-work item has no billable decision.
- Choosing Not billable enables Approve.
- After Approve, a reload still shows the decision and status Approved.

## How to get to it

The field user sends the daily (`#save-report`). Sign out from the profile button (`#profile-button`, then `#profile-logout-button`). Sign in as the demo owner. Open Daily reports, open that report, use `#office-decision`, then Approve report.

## Driving it with puppeteer

`node .cursor/skills/verify-pro-daily-link/scripts/drive.cjs --journey 5`

Edit reopens the daily on the notes step, so the driver taps Done again and then `#save-report`. It signs out through the profile dialog and signs in as the owner. It taps `[data-report="<id>"]` for the report just sent. Pass requires `[data-approve-report]` disabled with "Mark each extra-work item Billable or Not billable to approve", the equipment pad inside `.extra-work-office` and absent from the PRODUCTION line list. The AI summary may still quote the original note. Then `#office-decision` is set to `non_billable`, Approve enables, and after reload `extraWork[].billable === false` with status Approved.

## Gotchas

Approve also checks safety evidence when `safetyProfile.enabled` is set. The demo Cedar Grove project does not enable that profile. If safety blocks Approve, record the response; do not turn the profile off in the database to get a pass. The owner and field user share one browser cookie jar, so the field user must sign out first.
