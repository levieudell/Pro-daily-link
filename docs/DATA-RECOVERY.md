# Production backup and recovery runbook

## Backup requirements

- Create a verified tenant backup at least daily and before risky migrations.
- Keep backups private, encrypted by the storage provider, company-prefixed, and inaccessible to browsers.
- Maintain a second backup destination or database-provider point-in-time recovery before broad launch.
- Record object key, byte count, SHA-256 hash, company ID, revision, and verification time.

## Restore drill

1. Select a backup without altering production.
2. Download it into an isolated temporary directory.
3. Verify its recorded SHA-256 hash.
4. Validate schema, company identity, reference integrity, and required collections.
5. Restore to an isolated database or test tenant.
6. Compare company, user, customer, project, report, time-card, assignment, and audit counts.
7. Exercise login, report retrieval, project totals, and CSV export.
8. Destroy the isolated copy securely and record the result.

Run the drill monthly and after any storage migration. A successful upload alone is not a recovery test.

## Production restoration

Production restoration requires Levi’s authorization and a second-person technical review. Take a current backup first, preserve the incident evidence, restore the smallest possible tenant/time range, reconcile hashes and counts, then validate the customer journey before reopening writes.


