# Launch reliability gates

## Release is blocked unless

- all automated tests pass;
- the transactional repository migration has a verified pre-migration backup and reconciliation report;
- concurrent stale writes are rejected rather than silently overwriting data;
- the real deletion/concurrency acceptance passes on an empty disposable database, leaves zero synthetic rows, and its dated evidence is retained;
- production health confirms database, email, billing-webhook, backup, and monitoring configuration without revealing secrets;
- a controlled, privacy-scrubbed Sentry event reaches the production project and its alert reaches the named on-call person;
- a restore drill has passed in an isolated environment;
- dependency and secret scans have no unresolved critical or high findings;
- `main` requires pull-request review and passing checks;
- a Stripe test-mode checkout and webhook lifecycle pass;
- a Resend delivery and reply-to test pass;
- privacy, export, deletion, retention, incident, and recovery procedures are published internally.

## Transactional cutover sequence

1. Take and independently verify a portable backup for every company before migration.
2. Apply the ordered database migrations documented in `database/README.md`, including `007_transactional_records.sql` through `015_resumable_tenant_deletion.sql`; do not skip `015` when `012` was installed previously.
3. Verify every migration's final evidence query, service-role-only RPC grants, trusted SECURITY DEFINER and finalizer-table owners, normalized explicit ACLs plus inherited effective-access audits, no runtime-role access to the transaction-bound finalizer capability, all 45 enabled tenant lifecycle trigger events, immutable tenant keys, and the public-link/revision synchronization triggers. The table audit may ignore only the direct system-owned NOLOGIN principals `pg_read_all_data` and `pg_write_all_data`; a login or custom role inheriting either must still fail the gate.
4. Dual-write snapshots to the row repository and compare hashes.
5. Run stale-write concurrency checks against synthetic tenants.
6. Collect server-derived production and disposable fingerprints through read-only connections, then run `npm run test:deletion-db` in destructive acceptance mode only against a new empty disposable database. Require both advisory-lock orderings, all pre/post-lock guarded events, runtime capability denial, hold/mismatch/replay/restart/tombstone checks, exact recovery provenance, and guaranteed zero-row cleanup. Independently retain the printed manifest SHA-256 plus the immutable recovery manifest and dated result, verify populated private indexes were purged, then destroy that target. If interrupted, run the hash-, fingerprint-, and synthetic-provenance-bound cleanup mode or destroy the target; never reuse it.
7. Enable transactional reads for an internal/demo tenant.
8. Reconcile every collection and key workflow.
9. Roll out one customer company at a time.
10. Keep the original snapshots read-only through the rollback window.

Never enable the cutover globally until every preceding gate passes. Mocked tests, static SQL inspection, a skipped database run, or a cleanup-failed acceptance are not substitutes for real database evidence.


