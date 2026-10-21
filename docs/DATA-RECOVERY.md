# Production backup and recovery runbook

## Backup requirements

- Create a verified tenant backup at least daily and before risky migrations.
- Keep backups private, encrypted by the storage provider, company-prefixed, and inaccessible to browsers.
- Maintain a second backup destination or database-provider point-in-time recovery before broad launch.
- Record object key, byte count, SHA-256 hash, company ID, revision, and verification time.
- Export database data and every referenced private Storage object to an independent destination with `node database/tenant-recovery.js export --company-id <uuid> --output <independent-directory>`. The command is deliberately single-tenant and refuses to run without an explicit destination.
- Treat the generated `manifest.json`, `snapshot.json`, and `objects/` directory as one recovery set. Preserve the original object bucket/key mapping in the manifest.

## Restore drill

Use the complete [tenant portable recovery runbook](TENANT-PORTABLE-RECOVERY.md). `database/tenant-recovery.js restore-preview` verifies a selected set without production reads or writes; `restore` performs a guarded transactional tenant and private-object import with an independent pre-restore set, revision compare-and-swap, rollback, reconciliation, and dated evidence. The older `database/restore-drill.js` remains only a storage-connectivity check and is not recovery proof. Public health reports backup evidence, not a restored independent recovery; see [backup evidence semantics](BACKUP-VERIFICATION-2026-10-05.md).

1. Select a backup without altering production.
2. Download it into an isolated temporary directory.
3. Verify its recorded SHA-256 hash.
4. Validate schema, company identity, reference integrity, and required collections.
5. Restore to an isolated Supabase project or approved synthetic tenant with the portable recovery command.
6. Compare company, user, customer, project, report, time-card, assignment, and audit counts.
7. Exercise login, report retrieval, project totals, and CSV export.
8. Destroy the isolated copy securely and record the result.

Run the drill monthly and after any storage migration. A successful upload alone is not a recovery test.

Supabase Pro daily database backups do not include Storage objects. A portable recovery set must therefore be copied to a provider or encrypted drive outside Supabase before the independent-backup requirement is considered satisfied.

## Deletion migration acceptance

Any change to the reviewed-deletion SQL or its guarded tenant tables requires the real database acceptance in [Back-office launch acceptance](BACK-OFFICE-LAUNCH-ACCEPTANCE.md) before production rollout. Run it only on a newly created, empty, explicitly disposable Supabase branch or local PostgreSQL database with migrations through `015_resumable_tenant_deletion.sql`. It is not a restore drill and a tenant backup is not a substitute for it.

Retain the immutable `<name>.json` recovery manifest that is fsynced before the first synthetic write, its independently recorded `manifestSha256`, and the completed `<name>.json.result.json`. Acceptance requires `passed: true`, `cleanup.verified: true`, verified zero-row cleanup, and destruction of the disposable target after the evidence is saved. A normal `SIGINT`/`SIGTERM` is deferred until cleanup finishes. After a power loss, `SIGKILL`, runner crash, or lost connection, use the documented `--cleanup-evidence=<manifest>` recovery command with the independently retained manifest hash, exact disposable server fingerprint, and confirmation phrase. It verifies the same bytes it hashes, then under writer-conflicting table locks proves each tenant from its exact database synthetic marker or matching terminal receipt, verifies exact synthetic user identities and empty not-yet-seeded scenarios, validates that no row falls outside those four IDs, performs exact-identity deletion, and verifies zero rows in the same transaction. It emits a separate dated cleanup result without overwriting the manifest. If cleanup cannot be proven, treat the database as contaminated and destroy the branch; never reuse it for staging or customer data.

## Production restoration

Production restoration requires Levi’s authorization and a second-person technical review. Pause writes for the affected tenant, take and verify a current portable backup, preserve incident evidence, require the independently recorded source manifest SHA-256 and current repository revision, then validate the customer journey before reopening writes. Follow [Tenant portable recovery](TENANT-PORTABLE-RECOVERY.md); never improvise a direct table or `storage.objects` write.

