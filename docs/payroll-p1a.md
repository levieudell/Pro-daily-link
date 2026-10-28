# Payroll P1a: rules and approved-hour classification

## Existing settings and approval data (Step 0)

Inspected on `main` at `20e61ac` before implementation:

| Existing field/control | Storage and save path |
| --- | --- |
| Week start | `company.weekStart`: `monday` or `sunday`; existing UI fallback is Monday. Company profile saves through `PATCH /api/company`. Payroll reuses this field; no second week-start setting. |
| Company timezone | `company.timezone`; explicit changes use `timezoneSelected` through `PATCH /api/company`. Periods snapshot it as `timeZone`. |
| Overtime warnings | `company.overtimeRule`: `weekly40`, `daily8`, `daily8_weekly40`, or `none`. This only drives existing review warnings. It is unchanged and is not a payroll calculation rule. |
| Pay periods | `db.payPeriods[]`: `id`, `label`, `from`, `to`, `timeZone`, `status`, `createdAt`, `updatedAt`; closed periods also have `closedAt`. `POST /api/pay-periods` accepts `label`, `from`, `to`; `PATCH /api/pay-periods/:id` also requires `reason` for corrections. Boundaries are inclusive; overlap is rejected; captured periods' dates are locked. |
| Pay frequency / period start | No persisted recurring frequency or anchor exists. The `pay-period-preset` control in `time-approval-controls.js` offers custom, weekly, biweekly, monthly and semimonthly. UI-only inputs `start`/`month`/`cutoff`/`half` produce explicit `from` and `to`. These presets are left intact. |
| Settings access | `company-settings-tabs.js` exposes Pay periods to the owner or an admin with `manageTime`, with the time-cards feature enabled. The new controls reuse that tab and authorization. |
| Existing handoff snapshots | `db.payPeriodExports[]` and existing `/api/pay-periods/:id/exports` routes capture immutable approved-hour snapshots, including CSV. These predate P1a and remain unchanged. No REG/OT/DT export is added here. |

Approved punches are `db.timeCards[]`, with `memberId`, `projectId`, `inAt`, `outAt`, stored `hours`, and approval metadata. Approval routes set `status: 'approved'`, `approvedBy`, `approvedAt` and an `Approved` history entry. Unapproval resets status and records `Unapproved`.

The existing status policy also accepts legacy `Status`/`state`/`approvalStatus` aliases and approval metadata. Explicit Draft/Submitted beats legacy metadata; otherwise the most recent Approved/Unapproved history entry controls legacy approval. That exact policy is now shared in `time-card-approval.js`; server behavior is unchanged. Deleted and unapproved cards never enter payroll math. Invalid approved cards fail instead of silently dropping paid hours.

`report-labor-review.js` reviews report labor and overlapping punch evidence. `schedule-approved-labor.js` sums `reports[].laborEntries` for `status: 'Approved'` reports, subtracting `laborExclusions`. Neither is the payroll source. A report's approval is not a substitute for its punches being approved.

## Added settings

Only `company.payroll.overtime` is new:

```json
{ "weeklyOver": 40, "dailyOver": null, "dailyDoubleOver": null }
```

New and existing company responses get these defaults when settings are absent. Reading defaults needs no migration or write. Saving from Pay periods sends only `{ payroll: { overtime: ... } }` to the existing `PATCH /api/company`, persists in the same company object, and leaves profile, periods, pricing, timezone, week start and warning settings intact. All thresholds must be finite positive numbers or null. Double time must exceed daily overtime if both are enabled. Invalid input returns HTTP 400 with a plain message. Owner/admin time permissions apply on the server.

## Pure calculation contract for P1b

```js
const rows = splitHours(fullWorkweekTimeCards, {
  overtime: company.payroll.overtime,
  weekStart: company.weekStart || 'monday',
  timeZone: company.timezone || 'America/Los_Angeles',
  from: '2026-10-23',
  to: '2026-10-26'
});
```

Input uses existing punch records. The caller must supply **complete workweeks touching the requested range**, including punches before and after the range; a prefiltered range cannot recover earlier weekly hours. Omitting both range boundaries returns all supplied workweeks. There is no route or data fetch in this module.

Output is an array of worker/workweek records with `memberId`, `weekStart`, `REG`, `OT`, `DT`, `total`, `jobs[]`, `days[]` and `punches[]`. Job rows use `projectId` (null means company time), day rows use `date`, and punch rows retain `punchId`, `projectId` and `date`. IDs are stable identifiers, not worker names or future processor-specific codes. All output amounts include only days inside the requested range.

The company-timezone **clock-in date** owns the whole punch, including overnight/DST shifts. Stored approved `hours` are authoritative (including deductions); timestamps determine ordering and dates. Daily OT/DT is classified first, then only daily REG counts toward weekly OT. Jobs receive the categories in punch time order. Billing/extra-work flags do not create pay categories.

Calculations keep unrounded numbers. At output, worker-week REG/OT/DT totals receive cents by largest remainder against the approved punch sum rounded to two decimals. Each category's cents are then distributed over its punches by largest remainder; ties go to the last worked row/category. Job/day/week totals aggregate those same cents, so punch rounding cannot transfer a cent between pay categories. When independently rounded categories would not sum to the rounded punch hours, largest remainder resolves that cent difference (for example, 16 REG + 4h1m OT + 1m DT becomes 16.00 / 4.01 / 0.02, totaling 20.03).

No wages, rates, currency, processor templates, worker payroll IDs, California seventh-day rule, holiday pay, export route or export screen is introduced. Existing clock, field daily, voice, approval and handoff flows are unchanged.

## Verification

- `payroll-overtime.test.js`: requested examples, approval precedence, overnight/DST, range edges, Sunday workweek, multiple workers/jobs, extra-work inclusion, fractional thresholds, category rounding regressions, 2,000 random minute-level weekly cases plus 1,000 mixed-rule cases, plain validation and no mutation.
- `payroll-settings.test.js`: real HTTP validation, authorization, tenant isolation and persistence; browser save/reload and layout at 390×844 and 1280×800 in light/dark mode.
- Both tests run in full `npm test`; new server modules are included in `npm run check`.
