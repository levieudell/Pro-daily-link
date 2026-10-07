# Pay-period date presets

Base verified: `e949db64e744ebcb509623444c18a7c478e42880` on `main`.

Company settings → Pay periods → **New pay period** offers these date helpers:

| Choice | Explicit input | Inclusive range |
| --- | --- | --- |
| Weekly | Start date | Start through start + 6 calendar days |
| Every 2 weeks (14 days) | Start date | Start through start + 13 calendar days |
| Twice monthly | Calendar month, cutoff day 1–27, First half or Second half | First: day 1 through cutoff. Second: cutoff + 1 through month end |
| Monthly | Calendar month | Day 1 through month end |
| Custom | Start and end dates | Entered dates |

Custom remains the default, and start/month inputs open empty. The twice-monthly
cutoff visibly starts at 15, with First half selected; these are form defaults,
not an inferred company schedule. For other cutoffs/ranges, use Custom.
Twice monthly follows calendar boundaries and is distinct from 14-day periods.

The preview shows the exact ISO start/end dates, inclusive day count, and timezone.
Weekly/14-day start edits move the anchor and refill the end. Editing their end,
or either date of a calendar-month preset, switches to Custom while preserving
the edited range. Selecting Custom directly also preserves the dates. Cancel,
Escape, reopening, and switching account context clear unsaved preset state.
Existing periods open as Custom with their saved dates and timezone.

Save creates one period through the existing explicit-date POST/PATCH payload.
No preset metadata or recurrence is stored. The server continues to enforce
company timezone snapshots, inclusive nonoverlap, required correction reasons,
fixed-export date locks, time-card feature access, and owner/admin permissions.
Server policy, time cards, rates, payroll math, and export formats are unchanged.

## Validation

- `pay-period-presets.test.js`: DST spring/fall, UTC-offset independence across
  five host zones, leap/nonleap February, 30/31-day months, year rollover,
  invalid input, semimonthly versus 14 days, inclusive adjacent/overlapping
  boundaries, saved timezone snapshots, and fixed-export locks.
- `time-approval-controls.test.js`: all preset choices, explicit anchors/months,
  custom edits, preview, Cancel/reopen, invalid and overlap-rejected saves,
  unchanged POST/PATCH payload, correction reason, existing timezone on edit,
  export-lock UI, permission/context reset, plus existing approval/export cases.
- Existing pay-period HTTP integration passed: tenant/role gates, local-date
  boundaries, overlap rejection, immutable CSV, export correction, restart
  persistence, and audit behavior.
- Independent review found no actionable issues and passed 16,872 calendar cases
  across 2020–2035.
- Isolated headless Chromium exercised the actual form, stylesheet, and controls
  with synthetic API responses at 1280×900, 390×844, and 320×700. All choices,
  native validation, keyboard Tab/focus, Escape/Cancel/reopen, error recovery,
  single explicit save, no horizontal overflow, and mobile 16px fonts/44px tap
  targets passed. This is synthetic browser QA; physical iOS zoom/keyboard
  behavior is not verified.
- Syntax check, repository security scan, and dependency audit were run locally.
  All 62 application test commands were exercised. After refreshing CSS asset
  assertions, 60 pass on Windows; `sales-demo-route.test.js` and
  `backup-verification.test.js` fail only their Unix `0600` mode assertions
  (`0666` on Windows). Both failures reproduce on the unchanged base commit.
  Linux PR CI remains the full-suite publication check.

Release scope: isolated draft PR only; no merge, deployment, recurring period
creation, or production writes.
