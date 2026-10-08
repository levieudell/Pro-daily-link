# Scheduling enforcement and finite assignment email admission

The next separately bounded leave/time-card decision increment is documented in [time-review-admission-draft.md](time-review-admission-draft.md). Statements below describe this earlier milestone; the new increment still excludes payroll and the full Roles editor, and all modes remain disabled by default.

This source-only increment is stacked on preserved draft PR99 (`4741c805f6561adfc40445a27e19e75b59f07777`). It advances the requested Company Roles editor prerequisites. It does not expose a policy settings UI or enable a tenant policy. No production settings, grants, accounts, schema, keys, deployment or provider messages were changed. Earlier role/editor and notes drafts remain separate.

The original application behavior remains in flag-off mode when no policy exists. The new atomic runtime remains disabled by default, requires strict authentication and initialized transactional primary storage, and rejects every API outside its fixed implementation allowlist. This mode is incomplete and must not be deployed as a full application or Roles editor. Policy records here are installed only by synthetic test fixtures; there is no policy-write HTTP endpoint.

## Current framework and immutable boundaries

Existing authorization combines signed-in roles with tenant session identity, per-PM project/crew assignments and five stored PM flags: `scheduleCrews`, `viewDailies`, `approveDailies`, `viewTime`, `manageTime`. Approval implies its existing corresponding read permission in the relevant legacy PM helper. Non-PM results from `managerCan` are not an eligibility gate and must always be paired with an explicit allowed role. Legacy `office` normalizes to `admin`; `foreman` remains a distinct server role although the existing auth response presents the field UI with `accessRole: foreman`.

| Role | Scheduling ceiling in this increment | Immutable scope |
| --- | --- | --- |
| Owner | View/create/edit/remove; own linked-member acknowledgement | Current tenant; owner authority cannot be restricted or granted by this policy |
| Admin | View/create/edit/remove; own linked-member acknowledgement | Current tenant; no role-policy or account-owner management grant |
| Project manager | View; create/edit/remove additionally require existing `scheduleCrews === true`; own linked-member acknowledgement | Assigned projects; **all source and destination members** must be in assigned crews for a write |
| Foreman/field | View own assignments; acknowledge only their own linked member | Current tenant and actual signed-in member identity |
| Crew/unknown/platform roles | No scheduling admission | No injected flag changes eligibility |

PM reads intersect the selected assignment with their current crew members. Field and foreman reads/acknowledgement replies contain their own member IDs, acknowledgements and notification statuses. Server-generated/private metadata and other crew notification records are not projected. IDs and supported input fields are typed; clients cannot override a generated ID, permissions, effect payload or notification recipient.

The synthetic scheduling schema is closed: `company.schedulingRolePolicy` has version 1, a positive safe revision and exactly admin/project_manager/foreman/field rows, each with exactly boolean `view/create/edit/remove/acknowledge` fields. It can only reduce each immutable ceiling. An action requires view. Owner, billing, payroll, pricing, tenant administration, security, platform and AI fields are rejected. `schedulingPolicyRequired` makes missing/corrupt policy deny non-owner scheduling; a non-atomic runtime refuses non-owner authentication for a tenant marked as requiring this policy. There is no fallback to an earlier policy or generic permission dictionary.

Fresh `authenticateRequestAccount(req, db)` assembles `req.auth.user.schedulingAccess` before general manual handlers and private assistant/notes handlers. Scheduling routes also resolve current access from the request's verified snapshot. Policies never broaden the hard-hat assistant's fixed pilot and signed-in PM/admin/owner eligibility. Assistant scheduling requires typed create plus the existing PM grant/project/crew scope; preview fingerprints and confirmation/replay checks invalidate revoked access. Notes/to-dos retain their separate existing project/team checks.

Tenant identity, owner preservation, role assignment management, passwords/sessions, platform administration, financial pricing visibility, billing/subscriptions and payroll/time approvals remain outside editable scheduling controls. Admins have no policy-write endpoint and cannot escalate themselves. The owner-only existing user management endpoints keep their current protections.

## Admitted scheduling paths

- `GET /api/assignments` returns the explicit scoped projection and current finite scheduling capabilities.
- `POST /api/assignments` requires a bounded request ID. Assignment rows, private receipt, audit event and any allowed recipient email jobs are one SQL revision candidate. Exact replay under the same current session/scope returns the saved result without a new job. Changed input, edited/deleted assignments or revoked access reject replay.
- `PATCH /api/assignments/:id` checks every member on the source before edit/move and every destination member/project. It retains availability and conflict checks.
- `DELETE /api/assignments/:id` checks the source and validates an optional scheduled member query. DELETE input is fully received before fresh actor resolution.
- `POST /api/assignments/:id/acknowledge` checks the actual signed-in linked member and returns only that person's scoped assignment projection.

Rejected requests do not persist their audit candidate. Every losing SQL CAS discards the whole assignment/receipt/job/audit candidate; no provider attempt occurs. Role, grant, scope, policy or session changes incrementing tenant revision invalidate any inflight older write. An already admitted read cannot be withdrawn from its recipient.

## Finite email effect contract

Only ordinary manual assignment creation can enqueue `assignment_email_v1`. Jobs are private records containing the originating actor/session hash, policy revision, business/recipient hashes, typed identities and a fixed structured assignment email payload. Recipients must be current active same-tenant field/foreman accounts linked to the assignment **and currently allowed to view every included assignment**. No job accepts a URL, headers, arbitrary email override or bearer-link credential. No assistant action or project note/to-do creates an email job or public share.

`PDL_ASSIGNMENT_OUTBOX_DISPATCH` is also disabled by default. When explicitly enabled in the isolated synthetic runtime, a successful acknowledged admitted commit schedules a bounded background drain. Any admitted commit can kick separately authorized queued manual jobs, including auth/session or assistant commits; assistant-created assignments themselves never enqueue email.

Before transport, dispatch rechecks current tenant/account access, active actor and recipient, the originating unexpired session, exact role/PM scope/grant/policy revision, recipient email/member identity and view permission, active project/member, and unchanged assignment business records. Unknown/malformed/stale jobs cancel without transport. Queue age is limited to 23 hours. A SQL CAS reserves a unique dispatch lease **before** the fixed provider adapter. A second fresh load checks the reserved job and authorization before the adapter call. Concurrent claim losers never send.

The claim CAS is the dispatch admission point. A later permission revocation cannot retract a transport operation already admitted there; the fresh check narrows that interval. Transport has a ten-second timeout and stable `Idempotency-Key: pdl-assignment/<job UUID>`. [Resend documents a 24-hour deduplication window and the header contract](https://resend.com/docs/dashboard/emails/idempotency-keys), and [its send API returns an email ID](https://resend.com/docs/api-reference/emails/send-email). This implementation attempts each application job once and does not promise unlimited or exactly-once external delivery.

Known 4xx provider rejection becomes failed. Lost/invalid provider acknowledgement, 5xx or transport uncertainty becomes uncertain; a known accepted ID becomes sent only after receipt persistence. Receipt finalization may reload/retry the metadata CAS at most three times, preserving concurrent unrelated changes and rechecking the same dispatch lease. It never retries transport. Unknown claim acknowledgement, worker death or unavailable finalization can strand dispatching jobs. They require future explicit reviewed reconciliation; there is no retry/recovery UI or automatic resend, including after the provider deduplication window. Those operational gaps must be closed before enabling delivery for a real tenant.

Public workspace/export paths strip the outbox and scheduling receipts. Assignment read/acknowledgement projections expose no session hash, actor hash, private payload or provider receipt. Internal backups retain durable private records under their existing private access; they are not public customer exports.

## Evidence

`scheduling-access.test.js` runs in npm test and the dedicated PostgreSQL workflow. It covers immutable ceilings, closed/malicious policy input, required-policy failures, current project/crew scope, finite fields and dispatcher ordering. Existing assistant auth-contract tests exercise the actual current server assembly with synthetic restrictions.

`tenant-atomic-postgres.test.js` now invokes `scheduling-postgres-cases.js` within its mandatory fresh localhost synthetic schema. Tests use actual PostgreSQL transactions and multiple actual server workers. They cover competing manual saves and dispatch leases, no effect/job for a losing business CAS, replay/hash changes, whole source/destination scope, own acknowledgement privacy, slow DELETE and inflight revocation, assistant preview/confirm/replay reduction, immutable owner and malicious policy cases, discriminating same-revision recipient view checks, current session/actor/recipient/company identities, changed/deleted assignments, malformed jobs, lost claim/provider/finalization acknowledgement, receipt conflicts, and the actual server adapter's stable key with localhost-only transport. No real external provider connection is permitted by the child-process fetch shim.

## Remaining full-editor engineering

The settings preview/confirm/revision/audit UI remains gated on all relevant paths enforcing typed capabilities. No owner input is needed to continue that source work. The current audited route allowlist deliberately keeps these paths unavailable in the opt-in draft:

| Remaining area | Concrete gap before admission and policy UI |
| --- | --- |
| Reports, production/insights/exceptions, safety and workday creation | Foreman/field ownership gaps, PM project/crew checks and whole-tenant read aggregates; prevent a forged report from manufacturing later project access |
| Customers/projects/team and estimates/catalog/plans | Generic object spreads allow client IDs; missing office eligibility, project scope and financial/pricing guards; project financial fields need a separate fixed ceiling |
| Tickets/proposals | Existing PM pricing restrictions are not consistently applied to mutation or responses; approve must remain a distinct typed operation |
| Time cards, time-off decisions, payroll and approval/export paths | Private leave reads/own requests are a separate bounded increment described in [time-off admission](time-off-admission-draft.md). Every remaining decision needs current feature/role/PM/own-member scope; scheduling versus leave approval races need shared CAS admission |
| Crews, project archive and templates | Relationship updates and default project generation need scoped candidates/audit; retain owner/security boundaries |
| Uploads, plans, photos, logos, guest/import storage and deletion | Stage assets before admission and use post-commit cleanup/tombstones; no storage deletion before a losing business CAS |
| Authentication and compliance emails | Reset/verification bearer credentials cannot use this assignment outbox; finite contracts and lifecycle handling remain separate |
| Paid AI, streaming, billing and platform/bootstrap/maintenance writers | Provider budget/authorization admission, buffered response ordering, independent financial/platform authority and explicit maintenance operations; no generic tenant-policy bypass |

Once those paths and their read projections are admitted and independently tested, the full policy can get a closed capability schema and an owner preview showing exact before/after effects, expected revision, validation, explicit confirmation, idempotent save, and immutable audit history. Earlier prototype/notes slices cannot establish this coverage.
