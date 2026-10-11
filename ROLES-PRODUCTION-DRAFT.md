# Company Roles production-adapter source draft

This is an isolated, unpublished source draft. It has not changed production
permissions, accounts, sessions, credentials, schemas or services. **It is not
ready to activate.** The earlier compatibility prototype remains frozen.

This candidate integrates repository main through
`d6c316d7d2b3dd1e2a8e1e05f8bb6d2bfda2bb3c` (change-card details and
field flag/status updates). Repository main is not evidence of the deployed
commit. No existing PR contains this unpublished production-adapter candidate.

The existing framework uses Owner, Admin (including legacy Office), Project
Manager, Foreman and Field account roles. Crew names are assignment scopes.
Owner authority, account management, billing, pricing, feature switches,
tenant boundaries, project/crew scope and Assistant eligibility remain fixed.
The editor configures only the six existing typed controller families:
scheduling, time off, time review, time writing/payroll, daily/workdays and
project notes/to-dos. Every proposed true value remains below its existing
role ceiling, stored grants, feature gates and current scope. Owner alone
manages policies and profiles. Admin cannot change its own ceiling or policy.

The normal server and normal page now have a production adapter using the
existing Supabase service. Migration 009 supplies an opt-in snapshot CAS over
`companies.data`, a revision, legacy-writer/deletion fences and a deferred
commit deadline. No schema initializer runs at server startup. Activation
requires both explicitly named `PDL_ROLES_COMPANIES` and the separately
approved database `roles_managed` flag, authentication enabled, transactional
mode off and a durable policy signing key. No policy means unchanged stored
permission defaults; controllers never write new account grants.

Policies use server previews, reasons, finite impact reports, signed original
bindings, explicit confirmation, revision validation, audit entries and
idempotent original-result lookup. The normal manual routes and Assistant
read a freshly assembled effective actor. Fixed Assistant eligibility remains
signed-in Owner/Admin/Project Manager. Scheduling also requires its existing
grant and project/crew scope. Employee archive/restore remains an immutable
Owner/Admin route with its own expected version.

Managed requests stage business changes, buffer protected bytes, validate
typed consequences and scopes, and commit only against the opening revision
and original authorization deadline. Provider admission is persisted before
dispatch; uncertain attempts are not silently retried. An Owner can inspect
finite attempt references at `/api/company/provider-operations`. Client reads
bind company, actor, session, generation, revision and authority, and retire
private views after revocation. A failed oversized/partial stream returns
finite 503 JSON rather than partial successful bytes.

Change-card line items retain nonfinancial detail and hide material costs and
amount-bearing history when existing pricing access denies them. Linked daily
and photo sources remain within current scope. Managed status emails are
awaited and journaled; uncertain delivery returns the original operation
reference. These are fixed projections and source checks, not editable changes
or pricing grants.

Read-time broad draft cleanup, duplicate-card collapse and Owner-member
relinking are suppressed in the managed adapter; they need a separately
reviewed maintenance action. Managed sessions renew when fewer than 24 hours
remain so repeated `/auth/me` reads do not mutate revisions during one page
load. Unmanaged flag-off behavior remains the existing implementation.
The passive cloud fence deliberately fails closed if the managed flag remains
set but a worker loses its source configuration; cloud availability is thus
required to prove an unmanaged UUID before legacy fallback can proceed.

## Remaining activation blockers

1. The global platform store still has local-before-cloud full-snapshot writes
   and only process-local serialization. A shared revision/authority fence must
   cover platform accounts/sessions, named founder-alert and onboarding effects,
   audit/outcome receipts and every overlapping legacy writer. A tenant CAS or
   a standalone append helper cannot prevent another worker restoring revoked
   platform authority or erasing receipts. Managed platform system/support
   commands and founder recipient checks need that shared evidence too.
   Until then, the managed platform adapters in this draft are review subjects,
   not authority-safe activation paths.
2. Unknown credential delivery is safely blocked, but the Owner needs a finite
   explicit reconciliation contract tied to the original outcome/generation
   before it can be resolved or deliberately rotated. The current read-only
   operations list is not a recovery command. Do not add a lease-based resend.
3. Finish the complete production route/writer/side-effect inventory, finite
   response/default-workflow matrix and concurrent failure proofs at the frozen
   head. Whole workday and linked-card checks have positive and denial evidence,
   but the focused normal-HTTP fixture is not proof for every legacy workflow.
4. Run Linux CI at the exact published head after publishing is authorized.
   Local Windows POSIX file-mode assertions do not establish Linux results.

These are source work, not a request for live migrations or credentials.

## Finite later owner steps

After those source blockers and exact-head review/CI close, separately authorize
publication and then review the exact release commit, migration, durable-key
custody and named-company cutover. Verify an approved backup, current account
and scope evidence, writer fences and the flag-off/default workflow matrix.
Apply approved schema and configuration only at that action-time boundary.
Actual permission changes remain a separate in-product preview and explicit
confirmation by the current Owner. No deploy, merge, migration, key creation,
company activation or permission change is authorized by this draft handoff.

Synthetic fixtures use generated data, memory Supabase transport and an owned
loopback PostgreSQL instance. The normal-page browser blocks external requests.
Test receipts distinguish mutable work-in-progress checks from frozen-head
checks. Deployed production commit is not inferred from repository main.
The source-only `roles-production-synthetic.yml` checks the exact PR head with
an ephemeral PostgreSQL service and isolated browser dependency. It has not
been published or run; source workflow existence is not a successful CI result.
