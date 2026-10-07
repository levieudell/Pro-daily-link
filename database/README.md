# Tenant database foundation

`001_tenant_foundation.sql` creates the production PostgreSQL boundary. The API must begin every authenticated transaction with `SET LOCAL app.company_id = '<membership company UUID>'`. That value comes only from the verified server session, never a request parameter or browser header.

The application database role must not own these tables and must not have `BYPASSRLS`; otherwise forced row-level security cannot provide its intended second barrier.

Guest tokens are looked up by a global hash, then the server opens a transaction using the link's stored `company_id`. Object-storage keys must use `companies/<company-id>/...` and be returned only through short-lived signed URLs after authorization.
# Supabase deployment order

1. Run `001_tenant_foundation.sql` without RLS impersonation. The migration creates and forces tenant RLS policies.
2. Run `003_private_storage.sql` to create private photo and estimate buckets.
3. Run `005_verified_backups.sql` to provision the private tenant-backup bucket. The server also creates it defensively on first use.
4. Keep the Supabase service-role credential on the application server only. Never expose it to browser code or commit it.
5. Store every object beneath a company-prefixed key, such as `<company-id>/projects/<project-id>/photos/<uuid>.jpg`.

# Transactional revision conflicts

For a fresh transactional repository, use `007_transactional_records.sql`. A stale expected revision raises `PT409`, which PostgREST returns as HTTP 409. The application recognizes the unchanged conflict message and returns `STALE_WRITE`; the caller refreshes before trying a new save. The CAS comparison and row lock still prevent overwrites.

Do not use SQLSTATE `40001` for this permanent application conflict: PostgREST's transaction runner retries serialization errors internally. Native database serialization failures keep their normal error code and retry behavior.

For an existing installation, `008_revision_conflict_http.sql` changes only the unique known exception clause and preserves the installed function body, ownership, security settings and grants. Review the installed function before applying it; this general upgrade has a clause guard, not the incident's exact fingerprint guard. Fresh installations already using PT409 need no upgrade.

The separately approved October 7 incident correction is preserved byte-for-byte in `incidents/2026-10-07_revision_conflict_http.sql`. It checks the captured definition/body hashes, postgres ownership, SECURITY DEFINER, search path and exact ACL before replacement or an already-applied no-op. Use that stricter script only for the assessed target, with deployments and other function DDL held; unexpected drift aborts. Do not restore the old 40001 conflict clause in a rollback.

These SQL files are applied explicitly. Neither the app start command nor the local Docker bootstrap automatically applies them. An application deployment alone does not run this migration. A database-function change still requires its own assessed approval.

CI runs `revision-conflict-sql.test.cjs` against a pinned PGlite 0.5.8 runtime installed in runner temp, outside application dependencies. The tests use synthetic data and verify rollback, valid-revision commits, other-tenant preservation, grants/settings, drift refusal and prepared-call invalidation. For local execution, set `PDL_SQL_TEST_RUNTIME` to an isolated directory containing `node_modules/@electric-sql/pglite`; no application environment or production connection is loaded.

