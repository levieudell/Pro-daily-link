# Bounded leave and time-card review admission

This source-only increment is stacked on preserved draft PR101 (`519bafbe0433749f9b3da1fff5945e43aa905383`), PR100 and PR99. It is another prerequisite for the Company Roles editor, not its completion. Atomic mode remains disabled by default. There is no policy-write endpoint or settings UI, and policies are synthetic fixtures only. Main and previous draft refs are unchanged. No production data, schema, approval, grant, account, settings, credential, payment, provider, merge or deployment operation is part of this work.

## Finite admitted paths

- `POST /api/time-off-requests/:id/review-preview`, followed by the existing `POST .../approve` or `.../decline` decision path.
- `GET /api/time-cards` for existing scoped review.
- `POST /api/time-cards/review-preview`, followed by existing `POST /api/time-cards/:id/approve`, `.../:id/unapprove` or `/api/time-cards/approve` bulk approval.

Existing opt-in routes in the parent drafts remain admitted. Everything else remains503 before its handler or effects, including time-card create/correct/delete/submit/clock-out/company-clock, CSV, report-labor suggestions, pay periods/exports, company activities, financial/reporting/storage/platform/provider paths. This increment does not invent submission or approval automation.

## Immutable baseline and typed reductions

`timeReviewRolePolicy` is a separate closed version1 schema with a positive safe revision, exact admin/project_manager/foreman/field rows and exactly viewCards/reviewLeave/approveCards/unapproveCards booleans. It never grants authority absent from existing role, grant, feature and scope ceilings. Approval/unapproval depend on viewCards. reviewLeave independently depends on current private time-off view. Owner is immutable and cannot appear in policy rows; owner still obeys the time-card feature flag and record validation. Unknown/crew/platform roles cannot gain these capabilities through injected flags. Required missing or corrupt policy denies nonowner access. Marked tenants fail closed on legacy non-atomic auth so older handlers cannot bypass reductions.

| Operation | Preserved baseline |
| --- | --- |
| Private leave decision | Owner or admin/PM with manageTime===true. PM requires assigned crew; leave has no project or timeCards-feature gate. Current timeOffRolePolicy view also applies. |
| Time-card view | Company features.timeCards===true. Owner; admin manageTime; PM viewTime/manageTime with BOTH assigned project and assigned crew; field own linked member; foreman current linked member's crew. The existing field/foreman explicit other-member query still returns403. |
| Time-card approve/unapprove | Feature enabled; owner or admin/PM manageTime. PM requires BOTH current assigned project and crew. Field/foreman cannot gain office approval. |

Fresh authenticateRequestAccount assembles timeReviewAccess after existing scheduling/time-off restrictions, before req.auth is assigned. Without a policy and with atomic mode off, the original account object/defaults and legacy handlers remain unchanged. The assistant's fixed PM/admin/owner pilot eligibility stays outside all editable flags; this increment adds no assistant actions or notifications.

## Preview, confirmation and transaction

Preview performs no write. It validates the actual chosen records and returns their closed projection, exact decision/note, revision/version and a ten-minute HMAC token. Version binds the complete current selected rows, exact operation, originating actor/session/current grants/project/crew scope, policies/effective capabilities and tenant revision. Token contains hashes rather than the private raw session hash. Leave conflicts are disclosed as generic busy/date/time intervals only, never foreign project/customer names, IDs, activity, instructions or other members. Approval preserves scheduling records even when conflicts exist; existing leave semantics allow an explicit reviewed decision without deleting/splitting/reassigning work.

Confirmation accepts only token/version/confirmed===true/finite requestId. It freshly validates current session/account/capability/scope, exact route/selection, preview expiry and current revision/business version. A stale preview requires a new review. Mutation, private originating-session receipt and audit are one tenant candidate and one mandatory SQL compare-and-swap before any success response or mirror. Concurrent actor revocation, policy change or competing business action makes the losing candidate409; there is no automatic stale retry. SQL rollback/rejected commit produces no business/receipt/audit write. A lost acknowledgement requires durable replay, never an unchecked resend.

Durable replay checks current session, actor/grants/scopes/policies, exact request payload/route and current selected rows before returning current projected state. Another valid session, removed/expired origin, revoked capability, moved crew/project or later opposite decision cannot reuse the old receipt. Replays work across workers without the ephemeral preview key. A first confirmation must reach the worker that produced its preview; another worker/restart requires a fresh preview. This is a documented draft/release constraint shared with the existing assistant pattern, not a distributed key installation. No signing key is published or production key/settings change is performed.

Globally ambiguous IDs reject before decision mutation, including an allowed copy paired with a hidden copy. Legacy upsert removes every same-ID copy, so admission cannot safely approve duplicates until separate reconciliation proves their identity. Reads are side-effect-free and project known fields/history only; private receipts/session hashes and unknown nested history/metadata stay out of read, preview, confirmation, broad workspace and customer export responses.

Signed payload and signature must use canonical base64url encoding. Alternative padding-bit representations cannot acquire separate token identities; tests reject these aliases and deterministic signature tampering before any write.

## Preserved time computations and workflow

Approve only submitted, complete, non-overlapping pending cards using the existing status aliases, completeCard and whole-tenant overlap helpers. Bulk deduplicates bounded IDs and validates every selected pending card before any mutation; already-approved cards are skipped. A confirmed already-approved review records only its review receipt/audit, never another card history or computation. Unapprove requires approved, returns draft, clears submission/approval attribution, and appends the existing history shape. Approval/unapproval change no hours, breaks, report labor, workdays, schedules or frozen export snapshots. They do not apply field-edit pay-period locks: existing office review permits closed/exported-period cards. Payroll rules, period decisions/exports and correction/submit behavior are not expanded here.

## Existing finite email dispatcher

Newly approved leave conservatively fails the fixed assignment email's current-authority check when any job date overlaps the recipient's approved interval. Mixed-row jobs are indivisible: one overlapping date denies the entire job. Leave confirmation itself queues no email and changes no assignment rows. The existing dispatcher later uses its own SQL CAS to cancel queued jobs and their notification metadata; it does not rewrite schedule business data. This narrowly derived suppression applies even if the leave reviewer has no scheduling authority on the foreign project. It grants no scheduling or provider capability to that reviewer.

Dispatch claim and leave confirmation race on the same tenant revision; only one can win. A winning claim freshly rechecks approved leave before transport. An already admitted transport cannot be recalled by later leave approval. Sent/uncertain/dispatching jobs are never automatically retried because a leave decision or receipt write changed. Future explicit reconciliation remains a release gate; no provider calls are made by the synthetic tests.

## Validation

`time-review-admission.test.js` uses actual existing status/upsert/overlap/presentation helpers with synthetic memory fixtures. It covers role/grant/feature/schema/input ceilings, zero-write preview, explicit confirmation, stale versions, origin-session replay, duplicate/overlap/mixed-bulk rejection, private projection and unchanged computation/schedules.

`time-review-postgres-cases.js` runs within the mandatory guarded disposable-localhost PostgreSQL suite. Multiple real HTTP workers exercise opposite leave decisions, bulk versus single approval, scheduling versus leave approval, queued dispatch claim versus leave approval, SQL-inflight and slow-body revocation, current-session replay, feature/malicious-policy/IDOR/grant/crew/project checks, hidden duplicates, stale card changes, generic conflict projection and queued email cancellation. Foundation/own-leave/scheduling/effect tests also run. No application/cloud DATABASE_URL or credential is used; outbound HTTP is restricted to a localhost bridge and synthetic provider stub. Exact immutable source CI and independent review must pass before this becomes a verified draft milestone.

## Remaining full-role coverage

1. Time-card create/correct/delete/submit/clock-out/company-clock, report-linked labor effects, period/export source gates and read/export projections, preserving each existing field/foreman/office workflow.
2. Reports/production/insights/exceptions/safety/workdays and tenant aggregates: existing field ownership and PM project/crew scope across every path, without manufacturing future project access.
3. Customers/projects/team and crew/archive/template relationships: closed inputs, project/office/financial guards, transactional relationship/audit/default-generator effects.
4. Estimates/catalog/plans, ticket/pricing/proposal decisions and response financial ceilings.
5. Photos/plans/logos/guest/import storage effects staged before commit and cleanup after commit, never deleting a winning asset for a losing business candidate.
6. Credential/compliance finite messages, paid AI/budget/stream effects, and immutable billing/platform/bootstrap/maintenance authorities, without a generic permission/effect dictionary.
7. Owner role-policy preview/validation/explicit confirmation/revision/idempotency/audit UI after the complete underlying capability coverage, distributed preview routing/key design, and uncertain-email reconciliation.

There is no full-role activation claim. Production migration/cutover/settings/permissions/approvals require separate concrete action-time authorization; none is requested or performed by this draft.
