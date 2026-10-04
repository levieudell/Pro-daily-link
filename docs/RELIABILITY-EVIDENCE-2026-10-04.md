# Reliability evidence — 2026-10-04

This record separates completed verification from configuration that still requires an external account or production cutover.

## Later observation: 18:01 UTC

The entries below retain earlier historical observations. The [reconciled roadmap ledger](ROADMAP-STATUS-2026-10-04.md) supersedes their current-state merge, deployment, AI and Resend-outage conclusions: PRs #23/#25 are merged, main `6328586` deployed successfully, AI/email/billing are configured, and Sentry remains unconfigured. A sending-only Resend key's domain-query rejection does not establish failed delivery. Production health's backup timestamp is not proof of independently verified backups for every tenant. Provider delivery, billing lifecycle, alerts, recovery and staged cutover remain acceptance gates.

## Passed

- Full application, tenant-isolation, billing-webhook, time-card, template, recovery, UX, security-regression, transactional-repository, and local restore tests passed.
- Production dependency audit reported zero known vulnerabilities in runtime dependencies.
- Repository secret scan reported no hard-coded production credentials.
- The post-backup-tooling dependency audit again reported 0 vulnerabilities across 36 production dependencies. The repository scanner reported 0 critical findings and retained 7 dynamic-rendering files for manual review rather than silently suppressing them.
- Public production load test completed 90 requests at concurrency 10 with zero failures: p50 77 ms, p95 237 ms, p99 335 ms.
- Every active production tenant snapshot (12 of 12) was backed up, downloaded, parsed, and compared byte-equivalently at the JSON data level.
- Production Northstar restore artifact was independently downloaded and verified at 8,860 bytes with SHA-256 `b4ffecb2b7f536de083b3422f07119b6f05696a602da9fc19e65abf221853956`.
- Data export, reversible account-closure request, 30-day hold, cancellation, and audit coverage are implemented and tested.
- Security headers and safe rendering of support/audit data have regression tests.
- GitHub protects `main`: changes require a pull request, conversations must be resolved, force pushes and deletion are blocked, and administrators cannot bypass the rule.
- The reliability branch passed a local 200-request test at concurrency 20 with zero failures (p50 21 ms, p95 39 ms, p99 41 ms).
- Supabase Pro is active. Eight consecutive daily physical database restore points were visible, including the 2026-10-04 backup.
- The additive transactional schema migration is applied in production. A synthetic QA tenant advanced atomically to revision 1, and a stale revision-0 write was rejected with `PDL_REVISION_CONFLICT expected=0 actual=1`; no customer tenant was used.
- The reliability pull request's `Test application` and `test` checks both passed on GitHub.
- Portable single-tenant recovery sets now include the JSON snapshot plus every referenced private logo, photo, plan, and ticket object, with per-file SHA-256 hashes and original bucket/key mappings. Cross-tenant object references and unscoped exports are rejected; the full test suite passes.
- GitHub `main` protection is saved: pull requests and the `Test application` check are required, branches must be current, conversations must be resolved, administrators cannot bypass, and force pushes/deletion are blocked.
- A fresh production load run completed 200 requests at concurrency 20 with zero failures: 95.1 requests/second, p50 72 ms, p95 444 ms, p99 456 ms.
- A fresh synthetic-tenant transactional concurrency run passed; competing writers did not silently overwrite one another.
- The first independent portable backup was written to the approved OneDrive destination for synthetic tenant `4b272b77-d674-442c-ae3a-c4186e6d234f` at revision 74. The downloaded snapshot was parsed, its tenant identity matched the manifest, and SHA-256 `581c730323e39af6d95fce3fa0d37e9d85a95f1d777991fd5ee5cd9beee337e3` matched exactly. No customer tenant was used.
- A monthly restore-drill automation is active. It uses the documented isolated procedure, retains dated evidence, stays quiet on clean runs, and alerts only for failure, stale backups, checksum/tenant mismatch, missing access, or another actionable regression.
- A daily independent-backup automation is active for the approved OneDrive destination. It requires explicit tenant scope, includes referenced private objects, verifies the manifest after writing, never mutates production, and alerts instead of claiming success when access or verification fails.
- A daily production-health monitor is active and stays quiet while healthy. It checks public reachability and, after the reliability health format ships, requires database, billing webhook, email, monitoring, and verified-backup signals without charging, messaging customers, mutating customer data, or exposing secrets.
- Daily-report notes-only edits now preserve existing labor when an empty editor list is produced. Subcontractor archiving is recoverable, requires a reason, revokes active guest links, preserves history, blocks active duplicates, validates contact information, and records link creation/revocation. The complete automated suite passed after these changes.

## Built but not enabled in production

- Row-oriented tenant storage with atomic compare-and-swap revisions is deployed at the database layer but is not yet the application's primary storage path.
- Snapshot-to-transactional migration with pre-migration backup and hash reconciliation.
- Shadow dual-write and per-tenant primary-read modes.
- Stripe, Resend, Sentry, backup-freshness, and health verification scripts.
- GitHub quality/security workflow and Dependabot configuration.

## External gates still open

- Migrate and reconcile a synthetic tenant through the application tooling, then prove shadow mode before any customer cutover.
- Add a Sentry DSN to Render and verify a received alert and its human recipient.
- Run a portable backup and isolated restore drill for each production tenant after the release branch is merged; the independent destination and synthetic proof are complete.
- Replace the rejected Resend production key and prove delivery plus Reply-To behavior. The current production Resend API check returns HTTP 401, so email is not launch-ready.
- Add the OpenAI key through Render's secret environment settings and remove/rotate the unexpected key-shaped file only after explicit authorization. Production health currently reports AI disabled.
- Consolidate Stripe webhook delivery after confirming which endpoint is authoritative; three live endpoints are enabled. Stripe API access is healthy, but a controlled live checkout/webhook lifecycle still needs verification.
- Push and merge the local reliability commits. This computer currently lacks a usable GitHub credential, so commit `135a5ac` and the preceding reliability commits are not yet on the protected remote branch.
- Render inspection on 2026-10-04 confirmed production was still running commit `884fc79`, `SENTRY_DSN` was absent, and OpenAI existed as a secret file rather than the `OPENAI_API_KEY` environment variable read by the application. Stripe, Supabase, and Resend variable names were present; values were not exposed. The live legacy health response returned HTTP 200 with Supabase reachable and AI disabled, but cannot prove email, webhook, Sentry, or backup freshness until the reliability release is deployed.

## Release rule

Do not set `PDL_TRANSACTIONAL_DB=primary` globally. Progress only through `off` → `shadow` → one internal tenant → reconciled customer cohorts, retaining the snapshot rollback path throughout the validation window.
