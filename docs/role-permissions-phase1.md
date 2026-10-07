# Role permissions: phase 1 draft

Base inspected: `e949db64e744ebcb509623444c18a7c478e42880` (main, October 7, 2026).

The requested product is an editor for what **each role** can do. This draft is deliberately narrower: restrictions on five existing Project Manager grants. It is not the full role editor. Publication and expansion need review with the owner. No production settings, user accounts, grants, records, credentials or provider calls were changed during this work.

## Existing capability matrix

| Account role | Current server boundaries | Configurable in this draft |
| --- | --- | --- |
| Owner | Company-wide office access; user creation and role assignment are owner-only. Owner access is protected by role checks. | Sets PM restriction caps; own capabilities stay fixed. |
| Admin (`office` legacy alias) | Company-wide office tools and settings; time management requires its existing individual `manageTime` grant; cannot manage user accounts. | Read-only review of caps, affected PMs and history. |
| Project Manager | Office role limited in workspace, scheduling, time and report mutations to assigned projects/crews. Individual `scheduleCrews`, `viewDailies`, `approveDailies`, `viewTime`, `manageTime` flags. Approval implies daily viewing; time management implies time viewing. | Five company-wide caps: follow existing user grants or block. Caps do not grant anything, override an individual denial, assign scope, or modify the stored user permissions. |
| Foreman | Linked team member; field workspace and own assigned work; time view can cover its crew; approval remains office-only. Auth UI maps this to field while retaining `accessRole`. | Fixed. |
| Field / crew | Linked team member; own assignment/work/report-derived project scope; own time records. Crew is a team grouping, not a separate login permission role. | Fixed. |
| Guest / subcontractor | Expiring project-specific guest token and limited workflow. | Fixed. |
| Platform roles | Separate platform sessions, financial reporting and operational administration. | Fixed; outside tenant policy. |

Pricing remains separate: owners/admins can see pricing; PMs use `company.pricingAccess` (`enabled`, office mode, selected user IDs). Field/foreman data strips contract values, estimated costs and report rates. Time-card features are separately enabled for the company. Payroll calculation is not implemented. Billing/Stripe/platform grants, ownership, user administration, authentication, tenant selection and office-assistant eligibility cannot be added as policy keys. The assistant work is in another draft; these caps neither grant nor configure assistant access.

## Supported routes and enforcement

The dedicated `company-role-policy.js` schema accepts exactly five boolean caps for PMs. Missing policy returns the original user object unchanged. Invalid stored policy blocks supported PM capabilities while preserving owner access to inspect the problem. Unknown roles/capabilities, malformed booleans, invalid revisions and contradictory view/management combinations are rejected.

The server projects the caps into the existing PM permission fields for `/api/auth/me`, `/api/state`, scheduling guards, report guards and office time-card guards. Existing scope checks continue to apply. A daily viewing restriction also denies report creation and report-derived aggregate routes (`insights`, `exceptions`, `production`, `catalog`, T&M summary and reporting exports). With a saved policy, workdays require both effective daily and time viewing because their notes and timestamps contain both kinds of data. Office workday helpers cannot bypass a time-management restriction. Asset/project-plan access remains controlled by its existing project scope, separately from report visibility.

| PM control | Existing enforcement reused / additional restriction guard |
| --- | --- |
| Schedule create/edit | `POST/PATCH/DELETE /api/assignments`, manager assignment scope validation. |
| View dailies | Scoped workspace/report filtering and `PATCH/DELETE /api/reports/:id` guards; additional denial of report creation and report-derived aggregate routes when the cap blocks viewing. |
| Approve dailies | `PATCH /api/reports/:id/approve`, existing view/crew/project checks and labor allocation validation. A general report edit cannot introduce Approved status. |
| View time | Scoped time-card lists, CSV, labor suggestions, time-off and pay-period review; existing time management implies viewing. |
| Manage time | Create/correct/delete/submit/approve/unapprove time records, bulk approval and time-off decisions, using existing office time guards; workday helpers additionally blocked when the cap disables management. |

`GET /api/company/role-restrictions` requires an active tenant owner/admin session even when general authentication is disabled for a demo. Preview and save require an active owner with a permanent password. A company header mismatch is rejected. Preview is read-only and shows effective before/after changes for active PMs. Confirmation requires the exact signed, five-minute preview, same owner session, policy revision and unchanged user roles/grants/scopes. Save stores a new revision and an audit event with actor, reason, before/after caps and affected users. Saving unchanged caps is rejected. Restarting the process invalidates outstanding previews.

Governed request bodies finish uploading **before** admission to the existing per-tenant queue. The queue then reloads the freshest local snapshot and checks current permissions. A revoked/demoted session or a restriction saved while an upload is incomplete cannot authorize the queued mutation. An operation that has already committed is not rolled back. This is single-process serialization, not distributed cancellation; snapshot/transactional multi-instance admission and response-time revocation need separate architecture work.

The UI labels the feature “Role restrictions · phase 1”, shows fixed versus configurable roles, requires a reason, previews affected users and requires a confirmation checkbox. Identity/company changes clear pending results. Admins cannot edit. A returning PM tab refreshes its scoped workspace; stale buttons remain subject to server checks. No simulated checkbox claims unsupported enforcement.

## Route audit required for the full requested editor

The authorization system is a monolithic server with several independent route checks, not a complete central capability framework. Broader grants would need an explicit operation/resource registry and default-equivalence evidence for every route. In particular, inspect and repair:

- Aggregate endpoints: current `production`, `insights`, `exceptions` and catalog history operate on company-wide reports in some existing PM paths. The new view restriction denies them when blocked; it does not certify or rewrite their existing scopes when allowed.
- Field/foreman differences: several legacy workday, report, photo and generic resource create handlers check `role === 'field'` instead of all field roles, or do not apply PM scope at all. Verify every read/write by linked member, project and crew before making them configurable.
- Report correction/approval: preserve approved-work rate snapshots and allocation invariants; scope every report reference, linked file and custom-form mutation.
- Time and financial workflows: document exactly which roles may view, create, edit, submit, approve, export and configure periods. Keep time data, pricing, billing and platform financial boundaries explicit.
- Generic resource creation, estimate imports, templates, plan uploads, subcontractor links and assignment acknowledgement need their own capability contracts rather than relying on UI visibility or generic dictionaries.
- Multiple replicas/cloud snapshots: current per-tenant queues are process-local. Exact distributed revocation requires authoritative storage admission/CAS and response checks, not a token-cached capability flag. The preview HMAC is process-local; a different instance rejects the preview and asks for a new one.
- Client refresh: current clients can retain already-delivered data. Reloads and fresh requests enforce caps; live revocation cannot erase data already delivered. Design a scoped identity revision and cancellation mechanism before claiming instant removal throughout all open tabs.

These are pre-existing audit gaps and expansion blockers. Default access is intentionally unchanged when no policy is saved. This draft must not be described as a completed full role editor or deployed as a substitute without discussing the narrower scope.

## Validation

`company-role-policy.test.js` uses isolated synthetic tenants with provider keys removed. It covers unchanged defaults, nonconfigurable roles, corrupt/malicious policies, implication rules, owner/admin scope, cross-tenant headers/tokens, signed preview tampering, stale/replayed previews, session expiry/role changes, owner email verification, saved grants remaining intact, same-session cap updates, scoped writes, aggregate denials, completed-workday notes/timestamps and mutation bypass denial, audit retention, transactional round-trip and restriction during an incomplete HTTP upload.

`company-role-restrictions-ui.test.js` covers preview/confirmation, escaping, pending-result invalidation after edits, company/role changes, admin read-only behavior, refreshing PM grants and accessible tab/panel linkage, including the app's iterable NodeList query helper. Isolated full-app Chrome QA exercises owner preview, explicit confirmation and a real local HTTP save, admin review-only controls and 390-pixel viewport layout, with external requests blocked. This does not certify a physical mobile device. Full repository checks, exact-commit Linux CI and independent review results are recorded in the draft PR. No merge/deploy is part of this task.
