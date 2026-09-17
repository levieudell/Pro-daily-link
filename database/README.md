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

