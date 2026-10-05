# All-day and appointment-sized time off

## Behavior

Field users and foremen can request **All day** (the default) or **Specific hours** in Time off. All-day requests retain inclusive first/last calendar dates. Specific hours require one day and valid minute-resolution start/end times, with the end later than the start. Overnight and different-day appointments use separate requests. Times use the company calendar/clock, matching scheduling; they are not converted to browser timezone or UTC instants. On daylight-saving transitions a repeated wall-clock time covers either occurrence; a nonexistent clock interval still has wall-clock schedule semantics. This is availability, not a payroll elapsed-hours calculation.

The office decision list, employee status list, desktop day/week/month schedules, and mobile unavailable summary show the exact time range or **All day**. Approved time off blocks only overlapping assignment hours. Endpoints are half-open: work ending at an appointment's start or starting at its end is allowed. Existing work is preserved when leave is approved and only actual overlapping work is flagged for reassignment. Pending/declined requests do not block scheduling.

Existing leave without `allDay` remains all-day. Nothing rewrites existing requests. New fields live in existing snapshot records and follow existing backups/persistence; no schema migration is needed. Request IDs make unchanged retries safe across review/restart, while changed form details receive a new request ID.

## Scope and privacy

Schedule availability retains only member ID, date range, and timed bounds when needed. Leave reasons, types, notes, decisions, and history are not included in schedule data. Field users see their own requests; authorized project managers see and decide only requests for their assigned crews. Out-of-scope decisions return a generic 404. No new permissions or production test records are introduced. Project Notes & To-dos privacy and saved records are unchanged.

## Verification

- `npm run check` and `npm test` run the complete baseline regression suite plus focused API/shared and UI coverage.
- `time-off-partial-day.test.js` covers strict dates/times, legacy persistence, half-open conflicts for create/edit/move/range/copy behavior, approval, tenant/role privacy and retries.
- `time-off-partial-day-ui.test.js` and schedule UI/date fixtures run in Los Angeles, Kiritimati and UTC, covering mode switches, exact labels, invalid ranges, duplicate/retry recovery, cancel/reopen and late account/tenant responses.
- Manual browser checks use only a synthetic local workspace or read-only production surfaces. Real employee leave is never created or changed for testing.

## Release and recovery

Layer this release on the verified Notes/privacy and mobile-availability releases. Confirm exact remote commit/tree, CI, deployment commit and live asset versions before declaring completion.

Prefer forward repair or redeploy this tested partial-day-capable release. Do not blindly revert this feature commit: that would remove the fixed project-manager decision boundary. A pre-feature fallback is permitted only after confirming no timed requests have been saved and retaining/backporting the scoped decision guard; validate its complete suite before deployment. After timed requests exist, retain partial-day-capable backend and UI behavior because pre-feature code would treat timed requests as all-day. Never revert the Notes privacy backend to pre-PR39, reset demo/customer data, discard snapshot fields, or restore an older backup over newer records. Preserve the current snapshot and audit history during incident recovery. Synthetic tests verify timed data survives reload and that old all-day records remain unchanged.
