# Roadmap reconciliation and launch acceptance

Initially reviewed against main `632858683d5e7e1ebff475e39118335ecdc07177`; the isolated fixes were subsequently rebased onto `6dffe9b7ade759c1226dfc1df38a49446326a5a0` for the authorized draft review PR. This ledger covers every roadmap phase without equating existing code or configuration with acceptance. The separate active roadmap conversation has not been identified; ownership must be reconciled before overlapping feature work or merge.

## Release evidence observed today

- Reliability PR #23 merged 17:32:51 UTC; Resend probe PR #25 merged 17:43:13 UTC.
- Main quality/security CI passed: https://github.com/levieudell/Pro-daily-link/actions/runs/37221584167.
- Render's GitHub deployment record for main reported success at 17:50:19 UTC: https://dashboard.render.com/web/srv-dal9vt5bedkc73bpru30/deploys/dep-db193fm0tbcc73a41lb0.
- Canonical app https://app.prodailylink.com/api/health at 18:01 UTC returned reachable/configured Supabase, AI/email/billing configuration true, monitoring false, transactional mode off, backup timestamp null and freshness false.
- Signup/login/legal/support pages returned 200; anonymous company/project APIs returned 401. These checks do not establish browser onboarding or cross-tenant authorization correctness.
- Founder offer endpoint was enabled, with optional setup enabled and 24-month protection advertised. This does not establish live versus test Stripe mode or an accepted founder payment.

Health's service booleans measure environment-variable presence. Its backup field reads the default tenant persistence timestamp; it is not an independently verified manifest or an all-tenant inventory. HTTP 200 establishes database reachability, not completion of the other release gates.

## Phase-by-phase reconciliation

| Roadmap scope | Existing implementation/evidence | Acceptance remaining |
| --- | --- | --- |
| 1. Data model, tenancy, audit, storage, recovery | Snapshot persistence and scoped storage; transactional repository/migration; tenant, migration, concurrency and portable-backup tests | Synthetic application migration and hash reconciliation; shadow then internal primary reads; portable recovery sets and isolated restores for every approved production tenant. Full row-oriented query coverage is not certified. |
| 2. Authentication and roles | Signup, verification/reset, sessions, server authorization; API and tenant tests | Browser signup/invite/reset/logout journeys; full role/project financial-data denial matrix in representative deployment. |
| 3. Field workflow | Workdays, labor, reports, human verification, local draft/recovery code and tests | Representative phone/glove and poor-connectivity journey. Device draft recovery is not proof of a complete offline submission queue or guaranteed attachment recovery; photos may require reattachment. |
| 4. Estimate versus actual | Production dashboards, insights, approval/calculation flows in app/server tests | Trace dashboard/export totals to approved entries; corrected-report double-count prevention and unit mismatch matrix across customer workflows. Forecast/variance acceptance not fully established. |
| 5. T&M and hybrid | Ticket, rates, hybrid summary and permission paths in application tests | Signed ticket with attachments, historical rate stability and financial-field denial on representative workflows. |
| 6. Unplanned work and changes | Custom production, exception and change/history paths | End-to-end field exception through mapping/T&M/change approval with totals and audit reconciliation. |
| 7. Reporting and billing handoff | CSV/report/export paths | Locked-period reproducibility, branded PDF and native XLSX availability/accuracy must be verified; CSV alone does not complete every format requirement. |
| 8. Mobile and production | Responsive web, web manifest, hosted app and CI | Device/browser acceptance, monitoring/recovery/provider gates below. Capacitor shells, App Store/Play releases, push and background upload are separate unfinished deliverables; web availability does not complete them. |
| 9. Historical intelligence | Insights/history foundation | Private comparable-work benchmark/search, confidence-labelled estimate recommendations and source links remain later product scope; not certified complete. |
| Product success measures | Measures defined in roadmap | Define collection and baseline for daily completion time, corrections, approval lag, unplanned work, production variance, weekly activity and exports; no measured baseline established here. |

The original initial sellable boundary is focused phases 1–7. Mobile store releases and advanced historical intelligence remain explicit roadmap work; they are not silently removed by a web launch. Full invoicing/payroll/accounting remain outside the stated product boundary. PDL subscription billing is a separate launch requirement.

## Required launch acceptance evidence

All rows are open unless a dated record identifies commit, environment, synthetic tenant, actual outcome and safe evidence location. Do not paste credentials, reset tokens or customer data into this ledger.

| Gate | Required proof / next action | Current limit |
| --- | --- | --- |
| Customer journey | Mobile regular 14-day signup, verification, login, first project/report, approval/export, restart persistence and password recovery | Pages and local API tests do not prove delivered links or browser usability. |
| Email | Sender-domain verification, received reset/verification mail, usable links and Reply-To | Sending-only domain-query 401/403 cannot establish outage. Sending requires separate authorization; no key replacement is justified solely by that response. |
| Standard billing | Matching TEST key/prices/webhook, real synthetic test-mode checkout, plan change, decline, replay, retry, cancellation, portal return and tenant persistence | Configured flags and mocked webhooks do not prove provider lifecycle. Do not charge live money. |
| Founder billing | All six choices; unpaid/cancelled lock; retry/idempotency; optional one-time setup excluded from renewals; monthly/annual schedule cancellation at 24 months; portal protection; 90/60/30-day follow-ups and recorded agreement before renewal | Code and mock policy tests implement 24 months, `end_behavior: cancel`, and review flag. Existing enrollment is enabled; actual mode, schedule and follow-up operation remain unverified. |
| Sentry | Configure secret privately, receive a controlled event, verify alert rule and named recipient | Monitoring was false at 18:01 UTC. SDK flush alone does not prove alert delivery. Credential/production configuration needs approval. |
| Recovery | Approved tenant inventory, fresh portable snapshots plus referenced private objects in independent destination; verify manifest hashes; isolated restore and workflow/count reconciliation | Dated historical document describes synthetic success. Production all-tenant recovery is not established by default health timestamp or provider DB backups alone. |
| Storage rollout | Backup/reconcile synthetic tenant, shadow comparison, internal tenant, then reconciled customer cohorts with rollback | Transactional mode off. Do not switch global primary storage. Production mutation needs approval. |
| AI | Correctly configured secret plus Spanish translation and extraction with visible human review and fallback/error handling | AI configured true now; successful provider outputs not verified. |
| Legal/operations | Verify published disclosures against actual collection, export/deletion/retention operation, support ownership and incident runbook | Public pages load; operational acceptance remains open. |

## Local work completed in this isolated change set

- Removed false public/pilot readiness certification from both checker entry points.
- Validate all six standard price variables and, when enrollment is enabled, founder invitation and all six founder price variables.
- Reject blank values, malformed public URLs and URLs embedding credentials; redact connectivity failures.
- Missing service configuration now fails the configuration check. Optional setup remains optional and is reported as unavailable when absent.
- Add mocked regression tests covering false readiness, annual/founder omissions, monitoring, database failures and output secret redaction. Include founder policy tests in the normal test command.

## Validation and ownership

See [local security and workflow acceptance](SECURITY-ACCEPTANCE-2026-10-04.md) for the seven scanner dispositions, newly reproduced defects, precise financial/export/offline limits, and proposed PR scope. These additional fixes are local and have not been deployed. They include static/private-file access, contract-value/T&M authorization, reviewed rendering, CSV protection, scoped draft recovery and scanner repeatability.

This change set lives in a new isolated checkout on `codex/roadmap-launch-evidence`; existing dirty checkouts were preserved. No production modifications, provider credentials, payments, external messages, merge or deployment were performed. The user subsequently authorized pushing this isolated branch and opening a draft review PR. No relevant local AGENTS.md or .agents/skills/SKILL.md existed in the clean repository.

Validation executed locally on October 4:

- `npm test` passed with the new configuration regression and founder policy tests included, plus all existing API, tenancy, webhook, hours, time-card, template, blog, identity, recovery, UX, security, lifecycle, transactional, migration, portable-backup and isolated local restore checks.
- The expanded full suite also passed with secret-scanner, CSV, production-renderer/draft-isolation and financial/static-file HTTP regressions. Updated template/time-card assertions exercise scoped draft storage; UI loading checks require the CSV encoder before the cache-versioned application script.
- The complete aggregate passed again after rebasing onto latest main `6dffe9b`, including attachment/cloud-reference and upstream stylesheet compatibility changes. Remote CI must verify the published commit separately.
- `npm run check` and explicit syntax checks for both checker entry points and the new test passed.
- `npm audit --omit=dev --audit-level=high` reported zero vulnerabilities.
- `npm run security:scan` reported zero critical findings and seven existing dynamic-rendering files requiring manual review; this is not a claim that all manual security review is complete.
- `git diff --check` passed.

The restore test reconstructed the fixture locally; it does not certify restoration of production tenants, storage objects or browser login against a restored deployment. Complete the external gates with the authorized provider owners before declaring launch completion.

Review before publication: the static handler previously allowed repository-root files to be served. The local allowlist fix is launch-critical and is not deployed. Assess the production exposure and any credential/data response with the authorized operator; no production private files were fetched in this investigation. Other release gates remain open. Reconcile the app/server/security diff with the unidentified active roadmap owner before merging.

Later production assessment: the single harmless manifest HEAD canary returned 200 at 18:40:58 UTC, proving repository-manifest exposure without downloading content. Latest main `6dffe9b` deployed successfully at 18:14:13 UTC and retains the identical vulnerable server blob. Private-file availability/retrieval is not proven. See the security ledger for exact evidence and containment. Remote changes are limited to Enterprise pricing assets and the service-monitor script; these are preserved, with the new stylesheet included in the allowlist.
