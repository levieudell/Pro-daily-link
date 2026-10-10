# Directory and Company resource continuation

This is a source-only, inactive, synthetic continuation of the six-family Roles editor. It does not activate a production tenant, change live permissions, merge another draft, or close the full G3–G10 release. The accepted PR152, PR155 and PR164 heads remain separate. This milestone is based on the Roles continuation and main through `11195597565de3b49306ae6deee4580e53c15b9e`; later main project-task scheduling requires its own isolated integration.

## Actual supported operations

| Method and path | Current immutable baseline |
| --- | --- |
| POST /api/customers | Active signed-in company account |
| POST /api/projects | Same broad inherited creator; current customer/template/capacity; positive budget or T&M rates additionally require existing pricing access |
| POST /api/team | Same broad inherited creator; employee record only, without a login, grant or history |
| GET /api/crews | Named current crew-label reconciliation, CAS/audit when needed, scoped finite directory |
| GET /api/crews/eligible-members | Owner/Admin; current non-archived members, excluding Owner and actual Office-profile bindings |
| POST /api/crews; PATCH or DELETE /api/crews/:id | Owner/Admin; current membership, protected bindings and source blockers |
| PATCH /api/projects/:id/archive | Owner/Admin; stable ID/history, active-workday and restoration-capacity checks |
| PATCH /api/company | Owner/Admin; existing finite identity/settings/pricing fields; optional normal-form contract tracking forms one atomic compound save |
| PATCH /api/company/contract-value-tracking | Owner/Admin; existing financial tracking setting |
| POST /api/company-activities | Owner, or Admin/PM with current stored manageTime; finite initialization/append |

These operation names are not editable permission flags. No new permission family, account role, grant transfer, provider, notification, public sharing, paid call or Assistant eligibility is introduced. The editor still offers exactly six typed families and 32 restrictive controls. Owner/tenant/security/account/billing/pricing/feature/project/member/crew boundaries remain outside that policy. Office/custom profiles are restrictive within the covered families; they are not a global read-only Admin promise.

## Preview, commit and readback

Normal existing forms invoke POST `/api/resources/preview` with a finite operation, current displayed revision and bounded reason. The product shows the server preview, leaves confirmation unchecked, and then sends a closed original proof envelope to that operation's existing route. It never executes a caller-chosen generic handler.

The server executes the named existing handlers on a clone, rejects unsupported deferred effects, and validates every allowed collection/property consequence. It authenticates current session, role, subscription, object references, pricing and fixed management authority after asynchronous boundaries and at first confirmation. Preview custody binds the opening/review revisions, complete source hash, private scope consequences, original actor/session, ten-minute-or-earlier session deadline and HMAC proof. Confirmation reruns the actual candidate and commits business data, retained before-images, reason/audit and original receipt under one CAS and actual-COMMIT deadline guard. Company identity and normal-form contract tracking therefore have one outcome.

Private scope impact includes actual projected project/member/assignment/report/workday and independently scoped time-card IDs plus pricing visibility for every active account, with supported Office aliases normalized as fresh authentication does. Owner/Admin sees authorized counts and pricing consequences, rather than other accounts' private record IDs. Broad creators see only their submitted operation. Scope changes never silently transfer PM crew grants. Crew delete keeps history and removes only its exact old grant label; current/future assignment and open-workday blockers remain enforced.

Every successful response is assembled again from current authenticated readback. A purpose-bound original receipt header permits only the originating save's exact before/after authority transition. Technical outcome lookup uses a distinct current-to-same-current purpose and supplies no old private record values or grant. Crew acknowledgments identify the original operation; replay cannot conflate a later crew that reuses a numeric ID. Held responses from an earlier load are retired. The app-owned touch controller and private detail drafts are retired before fresh readback.

A PM's newly created unassigned customer can be used only in its open project-creation form, bound to current company/account/role/session/authority. It is not added to the general customer cache. The resulting unassigned project does not enter the project cache or open estimate import without current project access.

## Unknown outcomes and retention

Before the first business save the browser retains only bounded technical original identities in sessionStorage; failure to retain them stops the write. A lost response never triggers an automatic resend. Reload offers explicit POST `/api/resources/original-result` using the exact original tuple, current originating session and current fixed role authority. Only the committed technical outcome is returned; a changed session or unavailable receipt remains unknown.

Explicit local marker retirement requires current-record review and unchecked acknowledgment, the originating company/account, and a freshly captured company/account/role/session/authority/revision that is rechecked at retirement. It records `unknown`, without claiming rollback or deleting server custody. Corrupt markers require the same explicit review and retain only a digest in local history. Capacity limits fail closed without pruning. Private resource ledgers and retained before-images are excluded from public responses and credential delivery.

## Validation and remaining work

Tracked tests exercise actual HTTP handlers, canonical string-ID Owner/Office protection, derived PM/time-card/pricing consequences, altered custody, exact replay, recycled crew IDs, changed role/tenant/session, two preview contenders and lost acknowledgment. The private actual-module client regressions reject forged/missing/unsolicited receipt transitions and nine local-marker identity-switch cases. Native PostgreSQL HTTP tests cover exact one-write replay, revision contention, durable original lookup after constructing a fresh repository, and a held actual COMMIT past the originating session deadline with exact rollback of business/receipt/audit/revision. Private desktop/mobile browser tests use real login and normal customer/project/employee/crew/archive/Company forms, the PM own-customer flow, deliberate lost-response/reload and marker-storage failure; all external requests are blocked. Source hashes accompany unfrozen evidence, and final head/CI evidence remains separately required.

Thirteen G3 writers are still fenced: five manual template signatures, two catalog signatures, four subcontractor signatures and project-contract PATCH/PUT. Employee archive PR122 remains separate and unmerged. Physical Company/logo/export/deletion, attachment/sharing/provider/commercial/report variants, Assistant authorization compatibility, durable operations and restricted-principal installation/restore gates remain open. No full release or production readiness is claimed by this milestone.
