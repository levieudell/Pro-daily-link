# Tenant database foundation

`001_tenant_foundation.sql` creates the production PostgreSQL boundary. The API must begin every authenticated transaction with `SET LOCAL app.company_id = '<membership company UUID>'`. That value comes only from the verified server session, never a request parameter or browser header.

The application database role must not own these tables and must not have `BYPASSRLS`; otherwise forced row-level security cannot provide its intended second barrier.

Guest tokens are looked up by a global hash, then the server opens a transaction using the link's stored `company_id`. Object-storage keys must use `companies/<company-id>/...` and be returned only through short-lived signed URLs after authorization.
# Supabase deployment order

1. Run `001_tenant_foundation.sql` without RLS impersonation. The migration creates and forces tenant RLS policies.
2. Run `003_private_storage.sql` to create private photo and estimate buckets.
3. Run the repository-root `004_company_snapshot.sql` and verify `public.companies.data` exists before any transactional read-model or reviewed-deletion migration. Migrations `012` and `015` deliberately inspect that legacy snapshot column while the compatibility path remains available.
4. Run `005_verified_backups.sql` to provision the private tenant-backup bucket. The server also creates it defensively on first use.
5. Run `006_secure_exposed_core_tables.sql` and verify the reported policies and grants before continuing.
6. Run `007_transactional_records.sql` before enabling transactional tenant mode.
7. Run `008_platform_repository.sql` before enabling the back-office repository in shadow or primary mode. Follow `docs/PLATFORM-REPOSITORY-CUTOVER.md`; do not jump directly to primary mode.
8. Run `009_transactional_read_models.sql` before deploying the atomic tenant-read adapter. It replaces split revision/record reads with service-role-only RPCs and backfills an indexed, compact tenant directory for login and back-office summaries. Verify the migration's final privilege query exposes no `PUBLIC`, `anon`, or `authenticated` `EXECUTE` grants.
9. Run `010_signup_email_uniqueness.sql` before enabling public signup on more than one server instance. It atomically limits each normalized active login email to one tenant, quarantines pre-existing losing identities without blocking unrelated tenant writes, and exposes service-role-only list/resolve RPCs for an audited platform-owner decision. Conflict evidence remains an enforcement record until the affected tenant is permanently deleted.
10. Run `011_archived_email_ownership.sql` after `010`. It removes archived tenants from active login-email ownership and enforces that invariant on future writes. Restoring an archived tenant is intentionally atomic and fails if another active tenant has since claimed one of its login emails.
11. Run (or re-run) `012_operator_reviewed_tenant_deletion.sql` before enabling permanent deletion in the back office. Its first service-role-only RPC verifies the exact request ID, current repository revision, recovery-hold status, elapsed hold, and absence of a legal hold, then records a non-PII finalizing lock that blocks all legacy and transactional tenant writes. Only after that durable lock may the application purge private objects and its local mirror. A second RPC requires the same lock before replacing tenant content with a content-free tombstone; retries resolve through a content-free status receipt. The tombstone/version guard blocks both legacy company upserts and transactional revision-zero recreation, and conflict-queue rows tied to the erased tenant are purged.
12. Run `013_transactional_tenant_parent.sql` before accepting new production signups in transactional primary mode. It guarantees the `public.companies` parent is created in the same transaction before the first `tenant_revisions` child row, including when an older cached RPC body is still executing. Verify the final query reports the enabled `BEFORE` trigger for both `INSERT` and scalar-data `UPDATE`.
13. Run `014_public_link_token_directory.sql` before deploying primary-mode public guest/change-order resolution. It backfills a backend-only exact token-verifier index and keeps it atomic with transactional tenant writes. The tenant-record trigger indexes verifier changes and the tenant-revision trigger advances every verifier to the authoritative committed revision in the same transaction. Verify only `service_role` can execute the lookup RPC, no application role can read the directory table, and the final query reports three insert/update/delete record-trigger rows plus one revision-update trigger row.
14. Run `015_resumable_tenant_deletion.sql` as a forward-only upgrade after `014`, including on databases that already applied `012`. It serializes every normalized, legacy, and transactional tenant `INSERT`, `UPDATE`, and `DELETE` on the same per-company advisory transaction lock; makes tenant keys immutable so a row cannot escape a locked tenant through reassignment; authorizes finalization with a private backend-and-transaction capability that runtime roles cannot read or create; resumes an exact deletion operation by immutable company/request/revision identity; purges the email, conflict, and public-link directories; and returns an independently queryable, content-free terminal receipt. The migration removes stale explicit capability and function grants, strips any `service_role` grant option before re-granting plain `EXECUTE`, and audits inherited effective access against the table owner and exact trusted function owners. Confirm every lifecycle trigger is enabled, the finalizer table owner is trusted, no untrusted or runtime role has effective access to the capability table, and only `service_role` can execute the three deletion RPCs without grant authority.
15. Keep the Supabase secret/service-role credential on the application server only. Never expose it to browser code or commit it.
16. Store every object beneath a company-prefixed key, such as `<company-id>/projects/<project-id>/photos/<uuid>.jpg`.
17. Treat `docs/TENANT-PORTABLE-RECOVERY.md` as the production tenant restore procedure. The portable exporter must include every referenced private object and will reject legacy `/uploads/...` Render-disk references until those bytes are migrated.

## Real deletion/concurrency acceptance

`npm test` proves the adapter and sequencing logic with synthetic mocks; it deliberately never connects to a database. Before enabling deletion or either repository in production, run `npm run test:deletion-db` through a direct PostgreSQL migration-owner connection with superuser or `BYPASSRLS` visibility against a new empty Supabase branch or an empty local database that is explicitly disposable. The runner requires migrations through `015_resumable_tenant_deletion.sql`, private-schema access, visibility into its own sessions in `pg_stat_activity`, verifies all 45 guarded trigger events, seeds random synthetic rows across every guarded table, and proves:

- synthetic inserts, updates, and deletes succeed across all 15 guarded tables before the lock;
- both advisory-lock orderings are real: an in-flight write commits before deletion locks, while a writer started behind an uncommitted deletion lock waits and is then rejected without persisting data;
- every insert, update, and delete on all 15 guarded tables fails after the durable lock;
- every attempt to move a row from the locked tenant to another tenant fails on all 15 guarded tables;
- the private directory, active-email, conflict, guest-token, and change-order-token projections contain synthetic evidence before purge and are empty afterward;
- revision, request-ID, recovery-hold, and legal-hold mismatches cannot begin or finalize deletion;
- an exact begin resumes, locked status survives a new connection pool, finalization returns the exact content-free receipt, and an exact terminal replay is idempotent;
- the tombstone blocks revision-zero recreation; and
- all synthetic rows, operation locks, and tombstones are removed before success is reported.

Run `--fingerprint` first. It opens a read-only PostgreSQL connection and derives the fingerprint from the server control-system identifier plus the database OID/name; it does not trust endpoint text and never prints the credential. The migration-owner role must be permitted to read `pg_control_system()`. Run `--preview` next for a read-only schema, trigger-state, grant, and inventory check. The destructive `--apply` mode requires all of the following:

- `DATABASE_URL` in the process environment, never a command-line argument;
- an empty application database with zero companies, users, identity conflicts, platform repository rows, tombstones, and deletion operations;
- `PDL_DELETION_ACCEPTANCE_DISPOSABLE=1`;
- `PDL_PRODUCTION_DATABASE_FINGERPRINT` for every target, including loopback tunnels/proxies, which must differ from the target;
- `sslmode=require`, `verify-ca`, or `verify-full` for a remote target;
- the target's exact `--expected-fingerprint`;
- `--confirm-disposable="DELETE ONLY SYNTHETIC ACCEPTANCE TENANTS"`; and
- an absolute, unused `--evidence` JSON path whose parent already exists.

Before the first database write, the runner creates and fsyncs an immutable recovery manifest at `--evidence` and prints its SHA-256 for independent retention. A completed run writes a separate `<manifest>.result.json` so the recovery manifest is never overwritten. `SIGINT` and `SIGTERM` are converted into a controlled failure and cleanup; after an uncatchable termination (for example `SIGKILL` or power loss), rerun with `--cleanup-evidence=<manifest>`, `--manifest-sha256=<independently-retained-hash>`, and the same fingerprint/confirmation flags. Recovery refuses an edited manifest, a tenant without the exact database-resident synthetic run marker or matching terminal receipt, a non-synthetic user identity, any scoped row for a scenario that was never seeded, or any row outside the four recorded synthetic tenants. Recovery takes application/private writer locks first, then performs provenance, scope, exact-identity deletion, and zero-row verification in one transaction so concurrent writes cannot slip between proof and cleanup. Destroy the disposable database if cleanup cannot be verified.

The complete secret-safe PowerShell invocation is maintained in `docs/BACK-OFFICE-LAUNCH-ACCEPTANCE.md`. Retain the manifest and dated result, then destroy the disposable branch. A skipped, mocked, cleanup-failed, or production-targeted run is not acceptance evidence.

## Transactional read contracts

- `load_tenant_repository(uuid)` returns one tenant revision and its ordered records from one PostgreSQL statement, preventing torn reads during concurrent writes.
- `list_tenant_repository_page(uuid, integer)` is a bounded keyset-paged maintenance/recovery API for cases that truly require every full tenant snapshot.
- `list_tenant_directory_page(uuid, integer)` returns only company metadata and counts; normal back-office company lists must use this rather than full snapshots.
- `find_tenant_company_by_email(text)` uses the indexed active-user directory for login routing and duplicate-account checks.
- `find_tenant_company_by_public_token(text, text)` resolves only a SHA-256 guest/change-order verifier through the indexed private directory. Public-token requests in primary mode fail closed if this exact lookup is unavailable and never enumerate full tenant snapshots.
- `private.tenant_active_user_emails` has one global owner per normalized email after migration 010. Its stable `tenant_active_user_email_owner_unique` constraint is the final atomic signup guard; the API's preliminary lookup is advisory only.
- Pre-existing duplicate identities are denied login for every non-authorized tenant by a durable trigger-backed quarantine. Platform owners can inspect and resolve the bounded queue through the server API; direct table access remains revoked.
- Archived tenants keep their recoverable records but own no active login email after migration 011. The write trigger is defense in depth for deployments that installed the earlier transactional write function before this invariant was added.
- The parent-company trigger from migration 013 is a deployment-safe FK guard. Fresh 007/009 installs also create the parent directly inside `replace_tenant_records`; both paths are atomic and use a deterministic company UUID slug.
- All tenant read functions and `replace_tenant_records` are backend-only. They are explicitly revoked from `PUBLIC`, `anon`, and `authenticated`, and granted only to `service_role`.
- `begin_tenant_repository_purge`, `tenant_repository_deletion_status`, and `purge_tenant_repository` are also backend-only. They are deliberately unavailable until migration 012 is applied; final purge cannot run before the exact revision/request lock, and neither phase can bypass recovery-hold or legal-hold checks.
- `private.tenant_tombstones` contains no customer content. Its trigger guard makes a permanently deleted company ID terminal across legacy and transactional write paths.
- Migration 015 binds the transaction-finalizer capability plus the older tombstone/operation reads to the exact SECURITY DEFINER owners that use them. Its deployment evidence and acceptance preflight require trusted superuser/BYPASSRLS owners, exact lifecycle-state ACLs, `service_role` schema/RPC access, and zero runtime-role capability grants; the real acceptance invokes deletion RPCs under `SET LOCAL ROLE service_role`. The effective table-access audit ignores only the direct PostgreSQL predefined NOLOGIN principals `pg_read_all_data` and `pg_write_all_data`, whose built-in global privileges cannot be revoked. A login or custom role inheriting either predefined role remains a separate candidate and blocks readiness. This prevents a different migration executor from silently breaking guarded writes or PostgREST deletion.

