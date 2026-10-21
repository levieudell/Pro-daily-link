# Back-office launch acceptance

This is the release gate for Pro Daily Link Platform Operations. Passing a UI test alone is not enough: the command center must remain least-privilege, authoritative, recoverable, and honest about provider health.

## Required local gate

Run from the repository root on Node 22:

```powershell
npm ci
npm run check
npm test
npm run security:scan
npm audit --omit=dev --audit-level=high
```

Every command must exit successfully. The required `npm test` aggregate includes platform authorization, customer isolation, growth attribution, transactional repositories, archive/revocation, provider-readiness health, portable backup/restore, and durability regressions. A focused test must also be present in the required aggregate before a new reliability control is considered shipped.

## Database rollout gate

Apply and verify the SQL migrations in order. Never paste a provider secret into the SQL editor.

1. `008_platform_repository.sql`
2. `009_transactional_read_models.sql`
3. `010_signup_email_uniqueness.sql`
4. `011_archived_email_ownership.sql`
5. `012_operator_reviewed_tenant_deletion.sql`
6. `013_transactional_tenant_parent.sql`
7. `014_public_link_token_directory.sql`
8. `015_resumable_tenant_deletion.sql`

Migration 015 is a mandatory forward-only upgrade even when migration 012 was previously installed. The final evidence queries must show no public/browser grants, a trusted finalizer-table owner, no stale explicit or inherited effective capability access outside the exact table/function-owner allowlist, no preserved custom deletion-function grants, direct non-grantable `service_role` execution on only the three public deletion RPCs, no runtime-role access to the private transaction-bound finalizer capability table, no duplicate active login-email owners, no archived tenant that owns an active login email, the enabled parent-company guard on `tenant_revisions`, the public-link record and authoritative-revision synchronization triggers, all 45 enabled resumable-deletion lifecycle-trigger events (15 guarded tables times insert/update/delete), tenant-key immutability, and service-role-only access to the three deletion RPCs. The effective table-access audit exempts only the direct PostgreSQL predefined NOLOGIN principals `pg_read_all_data` and `pg_write_all_data`, because their built-in global privileges cannot be revoked; any login or custom role inheriting either remains independently audited and blocks readiness. Run shadow reconciliation before either repository becomes primary. A failed comparison blocks cutover.

### Real database deletion/concurrency acceptance

Static SQL inspection and mocked RPC tests are not release evidence. Exercise the deletion lock through a direct PostgreSQL migration-owner connection against a newly created disposable Supabase branch or an empty local database after migrations 001 through 015 are installed. The role must have superuser or `BYPASSRLS` visibility, private-schema access, and visibility into its own sessions in `pg_stat_activity`; a Supabase browser key is not sufficient. Never run the destructive acceptance mode against production, a production clone containing customer rows, or a shared staging database.

The runner refuses to write unless the application database starts empty: zero companies, users, identity conflicts, platform repository rows, tombstones, and pending deletion operations. It also requires an explicit disposable-database environment flag, an exact server-derived database fingerprint, a separately collected production fingerprint for every target (including loopback), TLS for remote targets, a typed confirmation phrase, and a new absolute evidence path. It verifies enabled triggers, trusted owners, explicit and inherited capability ACLs, and service-role denial on direct capability inserts; creates only random synthetic tenants; proves pre-lock inserts, updates, and deletes across every guarded table; observes deletion waiting behind an in-flight write; observes a writer waiting behind an uncommitted deletion lock and then failing without persistence; exercises all 45 guarded write events after the lock; rejects tenant-key reassignment on all 15 tables; proves populated private indexes are purged; and removes every synthetic tenant and tombstone before returning success.

```powershell
# Never type or paste a database URL into this command or shell history.
# First launch a fresh shell through the approved secret-injection workflow
# with only the PRODUCTION DATABASE_URL in its environment. --fingerprint
# connects read-only and returns a server-derived, non-secret identifier.
try {
  if (-not $env:DATABASE_URL) { throw 'Approved DATABASE_URL injection is missing.' }
  $productionFingerprint = (npm run --silent test:deletion-db -- --fingerprint | ConvertFrom-Json).fingerprint
  $productionFingerprint
} finally {
  Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue
}

# Close that shell. Launch a second fresh shell through the approved secret
# injector with only the EMPTY DISPOSABLE DATABASE_URL (including
# sslmode=require for a remote target) in its environment. The production
# fingerprint is required even when the disposable URL uses localhost through
# a tunnel/proxy; it is not a secret and may be copied below.
try {
  if (-not $env:DATABASE_URL) { throw 'Disposable DATABASE_URL injection is missing.' }
  $env:PDL_PRODUCTION_DATABASE_FINGERPRINT = '<server-derived production fingerprint>'
  $env:PDL_DELETION_ACCEPTANCE_DISPOSABLE = '1'
  npm run test:deletion-db -- --preview
  $targetFingerprint = (npm run --silent test:deletion-db -- --fingerprint | ConvertFrom-Json).fingerprint

  $evidenceDirectory = Join-Path (Resolve-Path '.').Path 'qa-tmp'
  New-Item -ItemType Directory -Force $evidenceDirectory | Out-Null
  $manifest = Join-Path $evidenceDirectory ("deletion-db-{0}.json" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
  npm run test:deletion-db -- --apply `
    --expected-fingerprint=$targetFingerprint `
    --confirm-disposable="DELETE ONLY SYNTHETIC ACCEPTANCE TENANTS" `
    --evidence=$manifest
} finally {
  Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue
  Remove-Item Env:PDL_PRODUCTION_DATABASE_FINGERPRINT -ErrorAction SilentlyContinue
  Remove-Item Env:PDL_DELETION_ACCEPTANCE_DISPOSABLE -ErrorAction SilentlyContinue
}
```

The `--evidence` file is an immutable, fsynced recovery manifest created before seeding. As soon as it is durable, the runner prints `manifestSha256`; copy that value into the independent release evidence before letting the shell close. A completed run writes `<manifest>.result.json`; retain all three pieces of evidence. Success requires a zero exit code, `passed: true`, and `cleanup.verified: true` in the result (the final console summary labels the last field `cleanupVerified`). `SIGINT` and `SIGTERM` are held as controlled failures until cleanup finishes. After an uncatchable termination, inject the same disposable URL again and run:

```powershell
try {
  $env:PDL_PRODUCTION_DATABASE_FINGERPRINT = '<server-derived production fingerprint>'
  $env:PDL_DELETION_ACCEPTANCE_DISPOSABLE = '1'
  $targetFingerprint = '<disposable server fingerprint recorded before the run>'
  $manifest = 'C:\approved-evidence\deletion-db-YYYYMMDD-HHMMSS.json'
  $manifestHash = '<manifestSha256 retained independently when the manifest was created>'
  npm run test:deletion-db -- `
    --cleanup-evidence="$manifest" `
    --manifest-sha256=$manifestHash `
    --expected-fingerprint=$targetFingerprint `
    --confirm-disposable="DELETE ONLY SYNTHETIC ACCEPTANCE TENANTS"
} finally {
  Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue
  Remove-Item Env:PDL_PRODUCTION_DATABASE_FINGERPRINT -ErrorAction SilentlyContinue
  Remove-Item Env:PDL_DELETION_ACCEPTANCE_DISPOSABLE -ErrorAction SilentlyContinue
}
```

Recovery cleanup first checks the independently retained manifest hash, then takes exclusive locks on every application and private acceptance table before it proves each listed tenant with the exact database-resident synthetic run marker (or its matching content-free terminal receipt), verifies the exact synthetic user identities for full scenarios and their absence for non-full scenarios, requires zero tenant-scoped rows for any not-yet-seeded scenario, and checks that every application row belongs to those four recorded tenants. Provenance, scope, exact-identity deletion, and zero-row verification occur in that same transaction, closing the validation-to-delete race. A shape-valid or edited JSON file alone is never deletion authority. If provenance, scope, or zero-row verification fails, destroy the disposable database; do not reuse it. Destroy the disposable branch after retaining the evidence even when the run passes. A cleanup error is failed acceptance. The normal `npm test` aggregate validates the runner's safety gates and coverage, but intentionally does not connect to a database or substitute for this acceptance run.

## Operator journeys

Verify each journey with synthetic accounts only:

1. Each platform role sees only its documented navigation and receives `403 platform_forbidden` from every unauthorized direct API request.
2. A demo request and a signup create one attributable growth record, with owner, next action, stage history, and no duplicate after retry.
3. Customer search, health, onboarding, billing context, support work, and AI usage come from authoritative tenant summaries when transactional primary mode is enabled—even if a local mirror is corrupt.
4. Temporary support access requires a reason, expires, can be revoked, exposes only the permitted summary, and leaves an audit event.
5. Archiving a synthetic tenant revokes sessions, guest links, change links, and credential links. It releases login-email ownership. Unarchiving never resurrects a bearer link and fails safely when another active tenant owns the email.
6. Customer data export contains business data but no password, setup, reset, verification, OAuth, session, guest, or customer-approval credentials.
7. Growth metrics reconcile with the underlying won opportunities and Stripe read model. A slow Stripe response must not block unrelated platform writes.
8. Content changes publish through the repository and public Help/Blog reads refresh after another instance commits.

## Recovery gate

For one explicit synthetic tenant:

1. Create a portable recovery set in the approved independent destination.
2. Verify `manifest.sha256`, the snapshot byte and canonical hashes, tenant identity, and every private object.
3. Preview an isolated restore.
4. Apply the restore only to the approved isolated target/revision, then reconcile the authoritative repository and re-download every object.
5. Confirm restored sessions and temporary credentials are revoked.
6. Retain the dated restore evidence and destroy the isolated target when the drill is complete.

A provider database backup without private Storage objects is not a portable tenant recovery set. A successful export without an exercised import is not a restore drill.

## Production provider gate

After deployment, but before inviting a customer:

1. Render liveness is green and the operational health endpoint reports the authoritative database, platform repository, tenant repository, Stripe webhook, Resend, Sentry, and fresh verified provider snapshot as ready.
2. Sentry receives one deliberate non-customer test event and the intended person receives the alert.
3. Stripe test-mode checkout, webhook, customer portal, cancellation, and retry are reconciled. A live-mode $0 charge is not used as a substitute for an approved live payment test.
4. Resend delivers a controlled message to a company-owned inbox; reply-to reaches `support@prodailylink.com`; bounce/complaint monitoring is visible.
5. Supabase backup and point-in-time settings are confirmed. Separately, the independent portable-copy monitor and isolated-restore drill are current; neither is inferred from the application health endpoint.
6. The protected `main` branch requires the quality/security workflow before merge.

Do not mark the release accepted if an endpoint returns green only because a required integration was skipped or unconfigured. Readiness is fail-closed; liveness is intentionally separate so Render does not restart a healthy process over an external business-control warning.
