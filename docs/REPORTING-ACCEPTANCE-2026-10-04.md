# Reporting versions and historical rates — local acceptance

Branch `codex/reporting-rate-acceptance` is based on deployed main `7e7d9786941f86e1adba579328081ee804c7647d`. All changes described here are local, uncommitted and unpublished. Existing unrelated dirty worktrees were preserved.

## Approved policies and resulting behavior

Levi approved these three rules: exported reports stay unchanged and corrections create a new version; rates are saved at first office approval and later changes require a reason/audit; older reports without historical rates are reviewed rather than guessed.

A fixed export freezes the handoff artifact, not the source daily. Source correction, approval and reapproval remain available. After approving a correction, the owner captures the next export version; prior exports remain unchanged and readable. There is no hard source-period close or reopen policy.

## Persistent export versions

- `POST /api/reporting-exports` accepts one project and an explicit inclusive ISO date range: `{projectId, from, to}`. Status is always Approved. Unsupported filters are rejected rather than silently ignored; legacy reports without explicit ISO dates require date review before period capture.
- The first capture creates version 1 and a series ID. A subsequent capture for the same tenant/project/date range must identify the latest `supersedesId` and supply a reason of 1–1000 characters. Stale retries fail with 409. Source corrections do not overwrite or automatically recalculate an existing export.
- Records retain creator, timestamp, reason, filters, included approval IDs/history, frozen project/report data, referenced member names/classifications at capture, grouped quantities, labor totals, historical-rate financial completeness and a SHA-256 snapshot digest. Different production units are not combined. Old schema-1 exports remain readable; a replacement receives version 2 without modifying the old object.
- `GET /api/reporting-exports` lists version metadata. `GET /api/reporting-exports/:id` returns stored JSON; `GET /api/reporting-exports/:id.csv` deterministically generates CSV from that stored snapshot, with formula protection. CSV distinguishes Production rows (allocated hours) from Labor rows (person hours/amounts); these represent the same underlying work and must not be added together as independent labor totals. Missing historical rates have blank financial cells and Review required status, never guessed values.
- Export creation/list/read/download is owner-only, following the existing company export policy. Tenant identity is checked again on stored records. Normal workspace payloads exclude the full export collection. No API mutates/deletes fixed versions. Capture adds a company audit event; its detailed reason remains on the export record.
- Full company exports/portable backups include the collection. The generic transactional record repository round-trips it without a schema migration. This is application-level immutability, not protection against privileged database tampering.

The owner sees Fixed reporting exports in Production insights. Select one project, From/To, all scopes and all crews; capture a fixed version or supply a reason for the next version. Each saved version offers JSON and CSV. Repeated save clicks are guarded and account changes during capture invalidate the operation.

## First office approval and reviewed rates

- T&M/hybrid dailies capture the project's configured single default labor rate on first office approval, with actor, timestamp, source and configured markup metadata. A configured numeric zero is valid; absent, blank, boolean or invalid values are not inferred as zero.
- Existing approved reports, reports with approval history, and reports with a previous snapshot/review marker are not backfilled from today's project defaults. Reapproval retains a valid snapshot. A new approval with no configured rate remains explicitly incomplete and needs review.
- Ordinary report corrections cannot set snapshot/history fields or bypass first approval through `status: Approved`. Untrusted extraction output cannot forge those fields. Notes/hours corrections retain the captured rate; totals can change with corrected approved hours, while already fixed exports remain unchanged.
- Owners/admins may change a project's future default via `PATCH /api/projects/:id/rate-settings`, requiring a reason. Project history retains prior/new defaults, actor and time. Existing report rates remain unchanged.
- Owners/admins may review or adjust a previously approved daily via `PATCH /api/reports/:id/rate`, supplying explicit `laborRate` and reason. A missing historical rate additionally requires an evidence reference, such as a contract schedule or prior billing document reference. Existing captured rates may be adjusted with reason; previous/next snapshots, evidence, actor and time are retained in rate history and a company audit event. Legacy material/equipment markups remain unknown rather than copied from today's defaults.
- Field/foreman users and managers without pricing access never receive rate snapshots, rate history/review data or project default-rate history. A priced manager may view scoped snapshots but cannot adjust rates/defaults or export records. An unpriced manager with existing approval permission can approve without receiving financial data; the server captures the owner-configured default internally.
- Project T&M summaries use each approved daily's captured rate. If any approved daily lacks a valid snapshot, the financial total is null/Incomplete and the affected reports are identified. A separately labelled known partial amount is not presented as the total. No read silently mutates/backfills production data.

Rate controls appear on eligible daily details, including evidence/reason and history. Owners/admins see a future-rate control on T&M/hybrid project details. The summary shows Incomplete when historical rates require review. This preserves the existing single-default-rate labor model; it does not introduce classification-specific schedules, payroll, new billable/non-billable rules, invoice rounding, or material/equipment billing calculations. Those broader roadmap items remain separate.

## Local acceptance and precise limits

`report-rate-policy.test.js` exercises actual isolated HTTP handlers for first approval, unpriced manager approval without disclosure, future-default changes, correction/reapproval rate retention, audited owner/admin adjustments, evidence-required legacy review, incomplete totals, field/unpriced-manager redaction, denied manual changes, forged extraction rejection, approval bypass rejection, fixed export retention, version lineage/reasons/stale retries, CSV stability and audit records.

`reporting-exports.test.js` checks dates/filter rejection, persisted frozen capture, changed-source stability, tenant denial even with an incorrectly copied record, no mutation operation, legacy metadata compatibility and transactional round trip. `reporting-controls.test.js` executes controller code with DOM/API fixtures for escaped histories, missing-rate forms without guesses, view-only managers, reason/lineage submission, repeat-click guard, rate-review payload and role switch. The explicit public asset policy includes the new controller.

`onboarding-journey.test.js` covers cookie signup, development-token verification/reset, customer/project/scope, identical-draft deduplication, report approval/totals/export, HTTP server restart, second-tenant denial, session invalidation and logout. `photo-retry.test.js` executes production save/upload functions: a failed upload retains server report ID and current File selection, retry uses PATCH, device recovery moves safely to the saved report, success clears scoped stale drafts and preserves unattributed legacy drafts.

Real browser/mobile acceptance is still open. The computer-use skill requires `node_repl` plus `@oai/sky`; neither that runtime nor a browser/Playwright or discovery tool is callable here. No unsupported automation or interaction with the user's tabs was attempted. VM/HTTP tests do not prove visual layout, back/cancel, file-picker interaction, phone refresh behavior or production persistence. The compact isolated acceptance procedure is [MANUAL-BROWSER-QA-2026-10-04.md](MANUAL-BROWSER-QA-2026-10-04.md).

Offline uploads explicitly fail with a connection-required message. Device recovery stores photo filenames, not File bytes, and requires reattachment after refresh. No background attachment queue, service-worker upload or resumable transport was built. Branded PDF/native XLSX and broader progress-billing columns remain unfinished phase-7 scope.

## Provider production gates (unchanged)

| Gate | Next authorized operator action | Evidence required |
| --- | --- | --- |
| Email | Approve synthetic recipients; test existing verification/reset sender, links and Reply-To. Sending-only domain-query rejection is inconclusive. | Received messages and successful link journeys with tokens/addresses redacted. |
| Stripe | Confirm matching TEST credentials, standard/founder prices and TEST webhook before synthetic checkout/cancellation. No live money. | Mode/prices, event outcomes, tenant persistence, setup exclusion, 24-month cancellation, renewal agreement and follow-up operation. |
| Sentry | Authorize private DSN configuration and one controlled event; verify alert recipient/rule. | Received event and alert acknowledgment, not configuration alone. |
| Recovery | Approve tenant inventory/independent destination; export snapshots plus referenced objects; verify hashes and isolated restores. | Per-tenant manifest, storage coverage, counts and workflow reconciliation. |
| AI | Approve synthetic translation/extraction with human review and error fallback, no customer data. | Successful outputs and fallback behavior. |
| Storage rollout | After recovery proof, authorize synthetic shadow, then one internal tenant before customer cohorts. | Reconciliation and rollback evidence; no global-primary switch. |

The separate security release PR #29 deployed `7e7d978`; public assets and anonymous protections were verified at 19:00 UTC October 4. Monitoring remained false and backup verification absent. These historical live observations do not certify this local reporting branch or the provider gates above.

Validation checkpoint: the expanded full npm test aggregate passed after all rate/version/UI logic and compatibility changes. Syntax checks passed. Independent review additionally closed stale-response account/tenant context leaks and restricted project archive responses to owner/admin; regression tests cover both. The complete npm test aggregate passed after these final fixes (exit 0); npm run check and git diff --check also passed. Security scan reports zero critical findings and eight review files; the new reporting-controls.js markup was manually reviewed and tested for escaped text, numeric values and encoded fixed-route links. This does not certify exhaustive application security or real-browser QA.
