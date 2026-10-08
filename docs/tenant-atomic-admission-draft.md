# Tenant transaction foundation — isolated source candidate

The next separately bounded leave/time-card decision increment is documented in [time-review-admission-draft.md](time-review-admission-draft.md). Statements below describe this earlier milestone; the new increment still excludes payroll and the full Roles editor, and all modes remain disabled by default.

The transaction foundation is based on main `e8c34db3805c1f5544d4fd37fd81c3410c21445b`. The separately stacked [scheduling admission increment](scheduling-admission-draft.md) preserves PR99; the next [private leave read/own-request increment](time-off-admission-draft.md) preserves PR100. Each adds only the bounded coverage described below. This candidate advances prerequisites for the requested full Company Roles editor. It does **not** implement or enable the full editor, apply role policies, or deploy the separate notes restrictions slice. PRs 74, 77, 82 and 98 remain separate and untouched.

No production tenant has been selected or inspected. No production schema, backfill, cutover, grants, credentials, billing, settings, permissions, accounts or customer records were changed. All database/schema exercises use disposable synthetic localhost PostgreSQL or the isolated CI service.

## Implemented milestones

1. **Coherent reads:** explicit ordered REST pagination, bounded retries, revision/scalar/hash checks before and after all pages, per-collection contiguous positions, complete reconstructed hash and company identity checks. Empty arrays live in scalar data; missing properties and null remain distinct. Corrupt, truncated, duplicate or foreign data fails closed. The direct PostgreSQL repository loads under repeatable read with hash validation. Existing flag-off REST loading remains in place until a separately reviewed cutover.
2. **Authoritative CAS first:** one staged candidate per request, one mandatory expected revision and database CAS, then an optional disposable mirror, then deferred JSON/body/cookies. Multiple stage calls replace the candidate rather than committing intermediate snapshots. Rejected handlers discard their candidates. Conflict/SQL rejection produces no mirror, receipt publication, effect or success response. SQL008 is source only and rejects null/unsafe expected revisions before materializing or locking revision zero. Both JS writers also require an explicit safe integer revision.
3. **Shared admission boundary, bounded coverage:** `PDL_TENANT_ATOMIC=1` enters the explicit route admission boundary before all legacy bypass dispatch. It requires strict auth and initialized transactional primary storage. Supported requests fully receive their input before a verified tenant load and current session/user assembly. Every unsupported API route is rejected before handler execution or side effects. This is a prerequisite candidate, not completed integration of every app writer.

With the new flag absent, ordinary routes retain existing role decisions, sessions, legacy dispatch, provider/billing/storage behavior and feature defaults. Malformed/missing expected revision calls are intentionally rejected. No generic editable permission dictionary is introduced. The stacked scheduling and private leave-read/request increments have closed, restrictive policies used only by synthetic fixtures, with no policy-write endpoint or settings UI.

## Audited coverage

| Writer or reader | Atomic draft behavior |
| --- | --- |
| Auth login, logout, GET me session renewal | Staged under tenant CAS; cookies/body after acknowledgement. Current tenant/user checked; failed-login limits preserved. |
| Existing GET users, owner PATCH users/:id | Current strict owner gate and existing owner protections; one candidate includes existing access audit events. This edits existing user assignments/grants, not role policy. |
| Project notes/to-dos GET, POST, PATCH | Existing project/team authorization and input validation. Candidate contains content, revision, history and create idempotency key. |
| Manual assistant selected-project context, preview, confirmation | Fixed pilot and signed-in owner/admin/PM gate. Schedule additionally requires current scheduleCrews/project/crew scope. Resource and confirmation receipt commit together. Scheduling retains existing in-app assignment notifications in that candidate; project notes/to-dos send none. No provider, email or public sharing. |
| Signup; platform tenant feature/owner/demo/reset/subscription changes; sales demo; webhook; company lookup | Rejected at the outer boundary before disk/cloud/account effects. |
| Manual scheduling GET/POST/PATCH/DELETE and own acknowledgement | Closed scheduling action/scope checks; one candidate contains assignment, audit, exact create receipt and fixed manual-recipient email jobs. See the scheduling increment for current dispatch/revocation limitations. |
| Private leave GET/own field-foreman POST; redacted schedule-availability GET | Fixed role/grant/own-member/crew scope; closed private read/create reductions; one request/receipt/audit candidate, no effects. Approve/decline/review-preview remain unsupported. |
| Other app mutations: reports/approvals, time cards/payroll, financial/pricing, company, estimates, templates, guest reports | Rejected at the boundary pending individual admission/effect review. Existing application works in flag-off mode. |
| Hidden GET effects: workspace repair, ticket purge, automatic compliance reminders; streamed/export/file routes | Rejected. Atomic context also skips legacy readDb repairs and disk feature overrides. |
| Upload/delete/bucket/backup/legacy snapshot adapters and platform persistence | Defense-in-depth rejection before I/O in atomic mode. No automatic backup is launched by admitted writes. |
| set-commercial-account, set-temp-password, migrate-json apply, migrate-transactional apply | Explicit atomic-mode rejection before the write/apply path. Preview is still read-only. |
| Startup legacy cloud loads | Skipped in atomic mode; no mirror is an authorization or read fallback. |
| Private assistant budget ledger | Its existing private operations CAS stays separate; it cannot grant tenant permissions or pilot eligibility. Provider routes are outside this admission draft. |
| Synthetic generators/portable backup/restore drills | Create isolated artifacts only; no production tenant writer is introduced. |

Route support is a fixed implementation allowlist in `database/tenant-atomic-routes.js`, not an administrator-controlled authorization flag. Existing permissions and bounded scheduling/private leave restrictions are freshly assembled at `authenticateRequestAccount(req, db)` before `req.auth` is assigned. Full-role effective restrictions remain future work.

## Failure and concurrency contract

- CAS conflict returns 409 `STALE_WRITE`; the losing candidate was not committed or mirrored. It is not automatically retried with a new revision.
- A lost/invalid acknowledgement returns 503 `COMMIT_OUTCOME_UNKNOWN`, not a claim that nothing saved. Verify authoritative state or replay the exact idempotent notes create/assistant confirmation/manual scheduling create. Non-idempotent changes must be reviewed before a new retry; this candidate provides no generic retry UI.
- Mirror failure **after** acknowledged CAS retains the original successful result and reports `X-PDL-Mirror-Status: degraded`. Mirrors may lag or reorder across workers; they are disposable and never read for authorization or fallback.
- Read-only replies and previews linearize at the verified snapshot/current actor check. A later revocation makes any write based on that older revision fail CAS, and every new request resolves a fresh actor. Already admitted read data cannot be withdrawn from a response.
- Preview signing keys retain existing per-process behavior: a first confirmation on another worker/restarted process needs a fresh preview. An already committed durable receipt can be replayed on another worker/restart with current access revalidation.

## Evidence and remaining gates

`tenant-admission.test.js` exercises torn/truncated/paginated reads, missing/null/empty distinctions, unsafe revisions, competing candidates, failed/unknown commits, mirror failure and legacy/effect rejection before fetch. It is part of `npm test`.

`tenant-atomic-postgres.test.js` requires an explicit fresh localhost `pdl_atomic_synthetic*` database and `PDL_ATOMIC_TEST_ALLOW_SCHEMA=1`; it refuses existing schemas and ignores DATABASE_URL. Real PostgreSQL and two real app workers cover first-materialization and initialized races, rollback after DELETE, anonymous RPC denial, deferred responses, IDOR/self escalation/owner preservation, slow-body and inflight revocation, assistant eligibility/scopes/preview/replay, actual mirror failure, corrupt authority, credential lockout, and lost commit acknowledgement. The dedicated CI workflow uses its own disposable PostgreSQL16 service and no production secrets.

The full editor remains blocked on integration of **every** remaining writer/read projection and external effect before enabling this backend, followed by remaining typed capability enforcement and a preview/confirm/revision/audit product workflow. Scheduling enforcement is one implemented increment, not full coverage. Current PM flags exist (`scheduleCrews`, `viewDailies`, `approveDailies`, `viewTime`, `manageTime`), but role checks and scope checks across all routes are not interchangeable with an editable policy. This candidate exposes none of those controls as new role-policy settings.

Future capability work must preserve tenant/project/crew boundaries, owner and security/account control, credentials/sessions, platform roles, billing/subscriptions, payroll/time approvals, financial pricing visibility, estimate/storage/signature/time-total/timezone behavior, and the immutable assistant pilot/role gate. An owner must not lock out owners or grant tenant/platform administration through a role policy; admin management cannot escalate itself. Notes restrictions in PR98 are a separate typed compatibility slice, not evidence of full coverage.

Before any future production step, return a concrete review packet for one owner-selected tenant: exact SQL/cutover change, current writer inventory, tenant revision and collection counts (including empty collections), canonical hash reconciliation, pending writer/drain evidence, rollback/backup plan and access risks. That evidence is unavailable here because production reads/writes are outside this task. Source SQL008, synthetic test results and a draft PR do not authorize applying it or enabling PDL_TENANT_ATOMIC.
