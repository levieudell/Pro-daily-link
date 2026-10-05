# Backup verification evidence and remaining recovery gates

## Narrow correctness change

Previously, `writeDb` advanced `company.persistence.lastBackupAt` before attempting a backup, including when no cloud storage was configured or an upload/hash check failed. Public health then called that value `lastVerifiedAt`. This timestamp did not prove verification.

The new `database/backup-verification.js` helper records a successful receipt only after the existing Supabase adapter uploads a tenant snapshot, downloads it again, and compares SHA-256. The helper also checks that the result matches the captured snapshot's hash, byte count and tenant-prefixed object key. It does not change the snapshot or its revision, and it does not make a second customer-snapshot write.

The legacy `lastBackupAt` value is retained as historical data but is never used as verification evidence or to suppress a new verification attempt. Local saves, a successful upload alone, attempted copies, invalid receipts and future timestamps do not establish verification.

## Health contract

`/api/health` retains `services.backup.lastVerifiedAt` and `services.backup.fresh`. Their source is now a validated server-side verification receipt. Additional fields clarify their meaning:

- `scope: "single-tenant-snapshot"`: the snapshot for the selected workspace, normally the default workspace on an anonymous health check. This is not an inventory of every tenant.
- `lastAttemptAt` and `lastAttemptStatus`: the most recent attempted check, separately from a completed verification.
- `independentCopy: "not-checked"`: the same-provider snapshot check does not prove an independent recovery copy or complete private attachments.
- `restore: "not-checked"`: neither a hash check nor a local byte-copy test establishes restored application workflows.

Public health never includes the tenant ID/name, object key, snapshot hash, notes or other customer contents. A fresh status means a successful snapshot verification within 36 hours; HTTP 200 still primarily establishes the existing database-reachability check, not completion of every launch gate.

## Storage, cadence and failure handling

Receipts live in the private `.backup-verification` directory beside server data, with a hashed tenant filename and mode `0600`. They are not in the public-file allowlist, tenant snapshots, company-edit payloads or customer exports. Client-provided company persistence fields cannot establish a receipt. Missing, malformed, mismatched-tenant or invalid receipts are treated as unknown.

The existing write-triggered backup cadence remains one day after the last verified completion. Failed or interrupted checks become eligible on a later tenant write after a one-minute retry backoff. A failed upload, download or hash comparison preserves any prior successful evidence but never advances its timestamp. The helper coalesces in-flight attempts per tenant across requests, including when an application-save failure releases its queue early. Late completion cannot replace newer recorded evidence. This remains a single-server-process design; a shared transactional coordinator is required before multi-instance scaling. No background timer or new provider service is installed.

Receipts survive a process restart on the same filesystem. On an ephemeral fresh deployment they may disappear; health then conservatively reports unknown/not fresh until a later write completes a new verification. This does not mean the previously stored cloud backup was deleted. The receipt is operational evidence, not the recovery archive itself.

## Verification and recovery

The HTTP request handler also now awaits its tenant-queue promise inside the existing error handler. A cloud-save rejection is caught instead of becoming an unhandled rejection that can terminate Node. Error response contents are unchanged. Snapshot-mode HTTP acknowledgment timing is also unchanged; this patch does not certify that every application response waits for durable cloud persistence.

The added synthetic test exercises the actual Supabase adapter through mocked network calls: pending upload/download boundaries, successful hash verification, upload/download failures, corrupt downloads, retry eligibility, legacy/local false positives, tenant separation, private-route denial, client metadata forgery, process restart, ephemeral reset, late-failure/out-of-order races, and a rejected application save with pending backup I/O. All provider addresses and account fixtures are synthetic. The full application suite must pass on the final integrated candidate, including Notes privacy and project-manager denial checks.

Recovery for this code change is a narrow revert of its helper, tests, imports, `writeDb` backup scheduling and health-source changes. Customer snapshots, Notes, billing configuration and database mode are not migrated or altered by the change. Reverting restores the previous misleading health semantics, so retaining the corrected health-source behavior is preferable if rollback can be narrower.

## Production acceptance still required

This patch does not claim production recovery, successful alert delivery, a completed payment lifecycle or physical-phone acceptance.

1. **Production backup inventory:** use an authorized executor with existing Supabase read access to run the read-only backup audit. Inventory each approved tenant and independently verify actual objects/manifests. Do not print credentials or private tenant contents.
2. **Independent recovery sets:** confirm the tenant scope and approved private destination, then export snapshots plus all referenced private objects and verify manifests there. A connector or executor must have access to that destination; setting up credentials or broader persistent access requires approval.
3. **Isolated restore:** approve the isolated destination and exact tenant/fixture scope before creating restored records or objects. Verify hashes, relationships, login, report retrieval, totals and export. Never switch global production storage mode or restore over a live tenant as part of this patch.
4. **Monitoring:** configure an approved Sentry project/secret privately if needed, then authorize and verify a controlled event, alert rule and actual human recipient. SDK flush or an empty error-log query alone is insufficient. No new monitor or paid service is created here.
5. **Payments:** the connected Stripe account was live-only in this audit. Before provider acceptance, supply an isolated approved sandbox with matching test prices and a signed webhook destination; configure credentials through the supported secure flow. Run authorized synthetic checkout/decline/retry/cancellation/portal cases there, without live charges or customer mutations.
6. **Browser/phone:** finish the pending authorized synthetic browser handoff and a representative physical-device employee journey. API/VM fixtures do not certify either.

Read-only production evidence at 06:04 UTC on October 5, 2026: main `5f78520` was live, Supabase was reachable, monitoring was unconfigured, transactional mode was off, and the old health response reported no backup timestamp. These observations are time-bounded and must be rechecked after any release.
