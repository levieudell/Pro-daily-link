# Company Roles release-integration draft

Unpublished source only. No production accounts, grants, credentials, settings,
data, schemas or deployments changed. Frozen `4aea7aa` and every other task remain
intact. This candidate integrates main `66f4583f37657c910c1134f0e7062d814f00633c`
(PRs 181–185), independently rechecked 2026-10-12. Deployed source is uninspected.

## Supported controls and fixed authority

Owner alone previews, audits and explicitly confirms role-policy/profile changes.
The six typed families cover scheduling, time off, time review, time writing/
payroll, dailies/workdays and project notes/to-dos. Profiles restrict an existing
base role. Effective permissions intersect existing ceilings, stored grants,
features, project and entire-crew scope. No policy creates account grants or
changes stored defaults. Crew names are assignment scope, not permission roles.
Owner/account/security/billing/tenant/financial management remain fixed. Archive
for projects/subcontractors retains Owner/Admin and managed snapshot CAS.
Employee archive is a separate unmerged draft; its Owner/Admin/expectedVersion
interface must be preserved if it is later integrated. Assistant eligibility remains the
Forged signed-in Owner/Admin/PM pilot; scheduling also needs its existing grant
and project/crew scope. Roles does not enroll a company in the Assistant.

Managed fixed baseline checks close inherited daily and project/plan/catalog/
estimate IDOR/consequence gaps; normal HTTP positives and denials document those
behavior changes. Broader project/customer/settings/attachment flags are absent.
Inherited estimate-import/proposal source-PDF readback through the legacy asset
fallback is outside this phase. Source rows without a trusted numeric author ID
cannot establish Field authorship; names are not authorization evidence.

## Shared authority and current workflows

009 supplies opted-in tenant snapshot CAS, legacy-writer/deletion fences and
deferred SQL deadlines. 010 separately fences the existing platform envelope with
platform_managed/platform_revision. That UUID must keep roles_managed=false so
the Assistant's separate budget-ledger namespace remains independent.
Managed platform startup/requests check shared snapshots and installed trigger/
function metadata before delivery. Local mirrors cannot replace authority.
Named deferred founder/demo/trial/digest work, provider admission, system commands
and support delivery share revision/current-authority fences. Platform authority
service validates private ledger MACs; SQL/repository validate envelopes/CAS and
installed metadata. Metadata checks do not attest function-body fingerprints.
No initializer runs at startup. Missing managed configuration fails closed.
Managed platform discovery requires PDL_REQUIRE_AUTH=1 even without a Roles
company allowlist; missing/off authentication rejects startup and HTTP delivery.
Cached authority also checks this immutable configuration before every return.

Main's token decisions, pricing-authorized change sharing, scoped dashboard
summaries, stored crew preselection and concurrent end-day photo/AI behavior
remain integrated. Tokens bind exact company/change/project/photo purposes;
rotations and scope changes withhold stale bytes. Images have bounded type/path/
reference validation. Photo intake signs one original create/edit operation,
uploads/checkpoints and current template/approval/crew dependencies. Accepted
partial Drafts remain reviewable; original GET recovery never repeats uploads
or creation. Safety-only forms use one final CAS. Client checks current identity
and form before applying results; in-memory form custody does not survive reload.

Unknown credential email delivery remains unknown. Current Owner can preview a
reason and explicitly confirm invalidation of that exact original reset/email
verification generation. A separate signed receipt is auditable; no resend or
delivery claim is manufactured. Later requests need new generations/admission.
Descriptor-less history requires independent evidence and a reviewed action.
Tenant and platform provider ledgers use closed schemas. Post-dispatch outcomes
can update only an unchanged original admission descriptor. A changed descriptor
or uncertain outcome commit returns a finite technical error with the original
operation ID; no business rebase, private response or automatic resend occurs.
Concurrent access changes may record the original known outcome while withholding
the stale private response. Roles confirmation freezes its original preview,
identity and checkbox proof, then rechecks immediately before actual dispatch.

Exactly three manual-code workflows have encrypted original custody: platform
bootstrap, staff creation and managed company-owner reset. Mandatory original
X-PDL-Operation, separate derived AES-GCM/MAC purposes and current setup scrypt
evidence bind company/request/generation to the original Owner/session or existing
bootstrap authorization. Natural expiry and fresh generation are checked before
buffered delivery. GET recovery/original replay issue no new code/grant/provider
call. Private projections hide custody. Capacity is 1000 receipts / 2 MiB with no
auto-pruning/key fallback. The platform client preserves uncertain operation
handles only in its current tab's memory; operators must retain the UUID for
direct recovery after reload. No reload-proof UI claim is made.

## Remaining external release gates

1. Freeze combined commit/tree and independently review that exact source. Run
   complete manifest, normal HTTP/VM/browser and generated native SQL suites.
   Mutable diagnostics are not exact-head acceptance. Windows cannot establish
   the two existing POSIX 0600 assertions.
2. Obtain approval to publish THIS NEW exact head and run both Linux workflows
   there. Earlier approval/CI does not transfer. Publication, CI, merge and deploy
   remain separate actions; none is authorized by this draft.
3. Before production installation, review exact 009/010 SQL/function bodies/ACLs/
   owners/triggers, approved recoverable backups, every running writer/job, named
   companies/platform flags, stable key custody/version/retention and rollback.
   No live key creation, schema application or cutover is authorized.
4. For a real uncertain credential, independently identify the original attempt/
   company/account/generation. The later action requiring approval is current
   Owner preview + explicit confirmation of THAT generation's link invalidation.
   Descriptor-less attempts need separate generation evidence and a separately
   reviewed recovery action. No automatic rotation or lease-based resend.
5. Actual role changes remain current Owner in-product preview, audit reason,
   revision validation and explicit confirmation after approved activation.

All local proofs use generated accounts, closed memory transports and owned
loopback PostgreSQL/browser fixtures with real providers blocked. Source CI
creates distinct fresh generated databases, but has not been uploaded/run.
Workflow existence is not successful GitHub CI evidence.
