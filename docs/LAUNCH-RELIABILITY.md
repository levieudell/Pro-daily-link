# Launch reliability gates

## Release is blocked unless

- all automated tests pass;
- the transactional repository migration has a verified pre-migration backup and reconciliation report;
- concurrent stale writes are rejected rather than silently overwriting data;
- production health confirms database, email, billing-webhook, backup, and monitoring configuration without revealing secrets;
- a restore drill has passed in an isolated environment;
- dependency and secret scans have no unresolved critical or high findings;
- `main` requires pull-request review and passing checks;
- a Stripe test-mode checkout and webhook lifecycle pass;
- a Resend delivery and reply-to test pass;
- privacy, export, deletion, retention, incident, and recovery procedures are published internally.

## Transactional cutover sequence

1. Apply `007_transactional_records.sql` in Supabase.
2. Take and verify a backup for every company.
3. Dual-write snapshots to the row repository and compare hashes.
4. Run concurrent writes against synthetic tenants.
5. Enable transactional reads for an internal/demo tenant.
6. Reconcile every collection and key workflow.
7. Roll out one customer company at a time.
8. Keep the original snapshots read-only through the rollback window.

Never enable the cutover globally until the preceding gate passes.


