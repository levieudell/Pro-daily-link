# Reliability evidence — 2026-10-04

This record separates completed verification from configuration that still requires an external account or production cutover.

## Passed

- Full application, tenant-isolation, billing-webhook, time-card, template, recovery, UX, security-regression, transactional-repository, and local restore tests passed.
- Production dependency audit reported zero known vulnerabilities in runtime dependencies.
- Repository secret scan reported no hard-coded production credentials.
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

## Built but not enabled in production

- Row-oriented tenant storage with atomic compare-and-swap revisions is deployed at the database layer but is not yet the application's primary storage path.
- Snapshot-to-transactional migration with pre-migration backup and hash reconciliation.
- Shadow dual-write and per-tenant primary-read modes.
- Stripe, Resend, Sentry, backup-freshness, and health verification scripts.
- GitHub quality/security workflow and Dependabot configuration.

## External gates still open

- Migrate and reconcile a synthetic tenant through the application tooling, then prove shadow mode before any customer cutover.
- Add a Sentry DSN to Render and verify a received alert and its human recipient.
- Add an independent second backup destination. Supabase Pro now provides daily database backups, but those backups do not include Storage objects and remain within the same provider. Point-in-time recovery is a separate paid add-on and was not enabled.
- Enable recurring monthly restore drills with a named owner and retained result.
- Save the prepared GitHub rule requiring the successful `Test application` status check and an up-to-date branch before merge.
- Replace the rejected Resend production key and prove delivery plus Reply-To behavior. The current production Resend API check returns HTTP 401, so email is not launch-ready.
- Add the OpenAI key through Render's secret environment settings and remove/rotate the unexpected key-shaped file only after explicit authorization. Production health currently reports AI disabled.
- Consolidate Stripe webhook delivery after confirming which endpoint is authoritative; three live endpoints are enabled. Stripe API access is healthy, but a controlled live checkout/webhook lifecycle still needs verification.

## Release rule

Do not set `PDL_TRANSACTIONAL_DB=primary` globally. Progress only through `off` → `shadow` → one internal tenant → reconciled customer cohorts, retaining the snapshot rollback path throughout the validation window.
