# Private time-off reads and own requests: bounded source increment

This increment is stacked on preserved draft PR100 at `2336f9691d399b765dabef86d63ea51f7646d0e4`. It advances Company Roles prerequisites with scoped private leave reads, own field/foreman request creation and redacted scheduling availability. It does not implement leave approval, payroll or the full Roles settings editor. Main and every earlier draft remain separate and unchanged.

The atomic runtime remains disabled by default. With the flag absent and no policy, existing handlers, grants, feature decisions, dispatch and provider behavior remain unchanged. Policies here are synthetic fixtures only; no policy-write endpoint or Roles UI exists. No production migration, account/grant/role/settings change, customer read/write, provider message, merge or deployment is performed.

## Exact eligibility and scope

| Role | Private request view | Request submission |
| --- | --- | --- |
| Owner | Current tenant's valid member records; immutable | Unavailable, matching the existing field-only submission gate |
| Admin | Existing `manageTime === true`; current tenant | Unavailable |
| Project manager | Existing `viewTime === true` or `manageTime === true`; assigned crew members | Unavailable |
| Foreman/field | Own actual linked member | Own actual linked member only, when that member exists in the current tenant |
| Crew/unknown/platform | Unavailable | Unavailable, regardless of injected flags |

Leave is projectless. Existing PM private-request scope is crew scope and does not require a project grant. Existing leave routes have no timeCards feature gate; this increment preserves that fact instead of inventing one. Foreman leave remains own-only even though other time-card operations have different crew semantics.

`company.timeOffRolePolicy` is a closed version-1 schema with a positive safe revision, exactly admin/project_manager/foreman/field rows, and exactly boolean `viewRequests`/`createRequest` fields. Creation requires view. Policies can only restrict each fixed role ceiling and existing office grant. Owner, approval, payroll, billing, security, platform and assistant fields are rejected. Owner authority stays immutable. The durable `timeOffPolicyRequired` marker makes missing/corrupt policy deny non-owner private request access; non-atomic mode refuses a non-owner authentication for a marked tenant to prevent bypass. Fresh `authenticateRequestAccount` resolves `timeOffAccess` after `schedulingAccess` before assigning `req.auth`.

`GET /api/schedule-availability` is a separate scheduling read capability. It requires the fixed scheduling view eligibility: owner/admin get the tenant's member intervals, PM gets assigned crews, field/foreman get their own member, and unknown roles are denied. It projects only approved member/date/time intervals, with no leave type, private note, history, reviewer, request ID or receipt. Denying private `viewRequests` does not revoke this distinct redacted scheduling read; scheduling view restrictions do. No project names or private leave details are used to answer availability.

## Admitted requests and concurrency contract

- `GET /api/time-off-requests` checks current private view permission and returns an explicit scoped projection. Unknown stored metadata and receipt/session information are excluded; permitted private leave notes and review history remain visible only within the existing own/office/crew scope.
- `POST /api/time-off-requests` requires an actual signed-in linked field/foreman account, exact supported fields, typed dates/time/all-day choice/type/note and a bounded save request ID. Clients cannot provide an ID, member, approval, reviewer, role, grant or effect payload. The new request is pending.
- One tenant CAS candidate contains the request, its private originating actor/session receipt, and a `time_off_requested` audit event. No email, notification, schedule reassignment, storage or provider job is created by this action. Losing/rejected CAS candidates persist none of those records.
- Replay requires the current originating session, actor eligibility, member link, policy and unchanged request details. It projects the current row so a subsequently reviewed status/history can be returned without replaying a decision. Changed details/input/member/session or revoked access reject replay. A legacy member/request ID without a verified private originating receipt returns 409; it cannot create a duplicate or invent an origin session. Already admitted private data cannot be withdrawn from an earlier response.
- Full input is received before the authoritative tenant/session/actor load. A role, policy, grant, session or link change invalidates a first inflight save through the tenant revision CAS; the next request resolves current authority. No automatic retry adopts a new revision or recipient.

Private `timeOffActionReceipts` are excluded from broad workspace and customer exports. Internal durable backups retain private records under their existing private access.

## Explicitly unsupported paths

Approve, decline and review-preview routes remain rejected at the outer boundary with `ATOMIC_ROUTE_UNSUPPORTED` before handlers or side effects. Time-card/payroll, company activities and every previously unsupported API also remain blocked. No approval flag is accepted in this policy. Existing flag-off approval handlers are unchanged.

Before a later approval increment, a zero-write preview must bind the exact row, decision/review note, originating session/actor, current role/grant/crew/policy and tenant revision. All affected assignments need a fresh conflict assessment, with foreign-project details redacted for PMs. Confirmation/replay must be explicit and idempotent. A concurrent leave decision versus scheduling save must have one SQL winner and require a refreshed conflict preview or return the newly approved-leave schedule conflict on retry. Never silently remove, split or reassign existing work. Pending manual assignment email handling during later approval must be chosen and documented: PR100 currently permits a queued email while its assignment remains current; already-dispatching/admitted transport cannot be retracted. This increment admits no decision that could introduce that race.

The full Roles editor still requires typed coverage for report/approval/field ownership and aggregates; time/time-off decisions and payroll; customer/project/team IDs and office gates; pricing/tickets/estimates/proposals; crews/archive/templates; staged assets and tombstone cleanup; bearer credential/compliance email effects; paid AI/streamed responses; and separate billing/platform/maintenance authorities. Owner policy preview/validation/confirmation/revision/idempotent audit UI comes after that coverage. Stranded/uncertain assignment-email reconciliation remains a separate release gate. No owner input is needed to continue source engineering, and no draft or test authorizes production activation.

## Verification

`time-off-admission.test.js` runs in npm test and the dedicated PostgreSQL workflow. It exercises immutable role/grant ceilings, strict malicious policy/request keys, missing-policy failures, own/crew scope, idempotent replay, private projections and separate redacted availability permission. Existing actual-auth integration tests exercise the fresh shared assembly with both typed domain resolvers.

`time-off-postgres-cases.js` runs inside the guarded mandatory `tenant-atomic-postgres.test.js` suite. Every run requires a fresh explicitly selected disposable localhost `pdl_atomic_synthetic*` schema and refuses existing schemas or application DATABASE_URL. Real PostgreSQL and multiple actual HTTP workers exercise own-create races, exactly one audit/receipt winner and byte-identical assignments, no extra provider effects, stale/slow-body/inflight revocation, valid-new versus originating/removed/expired sessions, strict role/grant/crew/member boundaries including policy-true with absent office grants, private/null-history projections, legacy-key collision and current-state replay, IDOR/malicious policy and pre-effect rejection of all decision paths. Existing scheduling and foundation regressions run in the same suite. Child transport is restricted to a localhost bridge; no real provider call is permitted.
