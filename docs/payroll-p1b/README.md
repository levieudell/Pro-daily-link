# Payroll P1b — Murder the Guesswork export

The office landing screen has a compact Payroll card with the same range/calendar/download component used by the Time cards dialog. No field, punch, daily, voice, approval policy or overtime-calculation changes.

## Data and access

- Reuses company overtime rules, week start, timezone, approved time cards and P1a's splitHours. Full overlapping weeks are classified first, then the requested start-days are selected. Overnight and range-edge classification are unchanged.
- Existing pay schedules store explicit period dates, not recurring frequency/anchor settings. As confirmed for this PR, Last pay period selects the most recent saved period ending before today. No parallel schedule was added.
- CSV rows are one worker/job across the entire requested range, with from_date and to_date instead of week_start. There are no worker-total rows to double-count. Every cell uses csv-cell.js; columns and filename remain template-driven.
- Worker totals remain in the one-page PDF. Its black header uses the supplied PDL monogram paths; its footer explains that worker IDs are Pro Daily Link IDs until payroll IDs are added.
- Existing access checks are unchanged: company-wide payroll access is required, field users receive 403 and anonymous users receive 401.
- Review unapproved opens the selected date range with draft and submitted cards included. Empty ranges show a message and disable downloads.

## Verification

The browser test signs in using a disposable copy of staging seed data and starts each timed path on the warm office landing screen. At 390×844, 768×844 and 1280×800, in both themes, it counts trusted clicks and verifies each target is visible and unobstructed without automatic scrolling:

| Path | Actual taps | Limit | Local elapsed range |
| --- | ---: | ---: | ---: |
| This week | 1 | 2 / 3 seconds | 86–162 ms |
| Last week | 2 | 2 / 4 seconds | 103–127 ms |
| Custom | 4 | 4 / 8 seconds | 160–251 ms |

Custom uses actual inline calendar day buttons: Custom, first day, last day, Download. No native picker adapter or new dependency. Arrow keys, Home/End, Page Up/Down, Enter and Space are covered. Month/year boundaries, leap years and six-row months have unit coverage. Remy's staging device measurement remains the GO check; local timings are not a claim about device/network performance.

CSV tests assert category and total sums, unique worker/job rows, date columns, formula escaping and unchanged full-week/partial-week equivalence. Browser checks cover all presets, empty states in both entry points, filtered approval review, 48px targets, contrast, dark dialog border, settings spacing and inline overtime labels. PDF tests cover one-page output with empty and large teams.

Screenshots: payroll-{light,dark}-{390,768,1280}.png and calendar-{light,dark}-{390,768,1280}.png. payroll-summary.pdf contains synthetic seed data and was rendered and visually checked.

No P2 settings, payroll IDs, processor templates, seventh-day rules or holiday pay are included.
