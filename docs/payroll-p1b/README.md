# Payroll P1b — Murder the Guesswork export

Adds a live payroll download to the existing time approval and pay-period settings area. Existing fixed pay-period snapshots are unchanged. No field, punch, daily, voice, approval or overtime-calculation logic changes.

## Data and access

- Reuses `company.payroll.overtime`, `company.weekStart`, `company.timezone`, `timeCards`, the shared approval policy and P1a's `splitHours`. No new settings or payroll IDs.
- `GET /api/payroll/export?from=YYYY-MM-DD&to=YYYY-MM-DD&format=csv|pdf` requires the same company-wide access as fixed payroll exports: owner, or admin with `manageTime`. Field/foreman and project-scoped users cannot download company payroll.
- Full overlapping workweeks are classified and rounded first, without a requested-range filter passed to `splitHours`. Only then are requested start-days selected. This preserves each day's REG/OT/DT cents across full-week and partial-week files.
- Overnight punches belong entirely to the company-calendar day they started. Unapproved/deleted punches are excluded; incomplete approved punches block export with a plain error.
- Detail CSV rows are per worker/job/workweek. `WORKER TOTAL` rows summarize each worker across the chosen range; consumers should not sum both detail and total rows. The `worker_id` is the PDL internal ID, disclosed in the PDF footer.
- Every CSV cell uses `csv-cell.js`. The default columns and filename live in the `murder-the-guesswork` layout config, ready for future template configs.
- PDF embeds the existing licensed Anton/Inter fonts, converted losslessly from WOFF2 to TTF for reliable subsetting. Small teams use US Letter. Large teams get a taller single page, preserving readable text and every worker rather than dropping rows.
- Exports use private/no-store responses and tenant-bound authenticated requests. No server-side export records or worker payload changes.

## Verification

`payroll-export.test.js` covers range starts/ends mid-week, two workweeks, cent-for-cent full-week equivalence, chronological job allocation, overnight/company timezone, Sunday start, DST/year boundaries, unapproved exclusion, CSV formula escaping, invalid inputs, empty exports and large-team PDF pagination.

`payroll-export-e2e.test.js` creates a disposable copy of the real staging seed, logs in through the office login, and adds test-only approved and submitted punches. At 390×844 and 1280×800, in light and dark mode, it checks downloads against 45 approved hours (40 REG + 5 OT), headers, filenames, API rejection, field 403, notice/review link, AA contrast, viewport bounds, and 390px inline overtime labels.

The warm-path browser test counts trusted clicks: This pay week **2**, Last week **3**, Custom **5**. Weekly paths fail above five seconds; custom timing is reported separately. Local measurements are not a substitute for Remy's staging GO measurement.

Screenshots: `payroll-{light,dark}-{390,1280}.png`. `payroll-summary.pdf` is a synthetic seed-data example, rendered and visually checked as one page.

No P2 settings, payroll IDs, processor templates, seventh-day rules or holiday pay are included.
