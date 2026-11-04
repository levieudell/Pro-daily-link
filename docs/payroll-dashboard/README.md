# Payroll dashboard

The Payroll page puts date selection, approval readiness, approved REG/OT/DT totals and downloads together. Worker rows expand into the job breakdown. Pay schedule editing stays in a collapsed section.

The shared calendar shows one month with keyboard navigation and 48px days. It closes after the second selection; closing an unfinished selection restores the prior range. Less-used presets live under More.

`GET /api/payroll/summary` uses the existing export builder and the same authenticated payroll permission checks. Overtime math, approval handling, CSV/PDF formats, clock-in/out and field workflows are unchanged.

Screenshots use disposable staging-seed data on a local server, not live customer records. Phone previews cover 390x667 and 390x844; desktop previews cover 1280x800, in both themes.

Browser checks cover matching dashboard/export totals, expandable jobs, calendar completion/cancellation, download tap counts, no-scroll phone exports, both themes, the existing schedule editor, anonymous/field/no-grant access, and fresh/reload routing.
