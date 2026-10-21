# Platform operations repository cutover

This change gives Pro Daily Link's back office its own transactional, revisioned database boundary. It does **not** apply the migration or modify production by itself.

## What it protects

The existing `platform.json` model can lose an update when two requests read the same file and each writes a full replacement. The new repository prevents that failure in two layers:

1. `PlatformStateStore` serializes writes inside one Node process.
2. PostgreSQL locks the platform revision row and accepts a write only when its `expectedRevision` still matches. A stale process receives `PDL_PLATFORM_REVISION_CONFLICT`; it never overwrites the newer commit.

Platform operations data has a stable namespace separate from customer-company rows. Current data is split into scalar state and ordered collection records, committed in one transaction, and given a SHA-256 content hash. Each successful revision adds immutable metadata to `private.platform_revision_log`.

## Security model

- Tables live in the unexposed `private` schema.
- Forced RLS is enabled as defense in depth, with no browser policies.
- `PUBLIC`, `anon`, `authenticated`, and direct `service_role` table privileges are revoked.
- Only the two narrowly scoped public RPCs are executable by `service_role`.
- Both RPCs revoke `PUBLIC`, `anon`, and `authenticated` execution explicitly and use an empty `search_path`.
- The Supabase secret key stays in Render/server environment variables. Never place it in HTML, client JavaScript, logs, backups, or API responses.
- Prefer a current Supabase secret key (`sb_secret_...`) over the legacy JWT-shaped service-role key when rotating credentials. The repository still uses the project's existing `SUPABASE_SECRET_KEY` environment-variable name so no secret needs to move into source code.

## Files

- `database/008_platform_repository.sql` — private tables, CAS functions, grants, and revision log.
- `database/platform-repository.js` — server-only load/save/verify adapter over existing `database/supabase.js` requests.
- `database/platform-state-store.js` — immutable read cache and serialized mutation queue.
- `database/platform-portable-backup.js` — portable export and SHA-256 verification, including referenced private storage objects.
- `database/platform-recovery.js` — export, verify, preview, and guarded restore CLI.

## Safe deployment sequence

1. **Merge and deploy code without enabling the new repository.** The added modules have no production side effects.
2. **Apply `database/008_platform_repository.sql` in a non-production Supabase project first.** Do not paste secrets into the SQL editor.
3. **Verify privileges.** The migration's final query must show only `service_role` for the two RPCs. Also confirm the `private` schema is not in Data API exposed schemas.
4. **Run the focused tests** listed below.
5. **Create an independent backup of the current `platform.json`.** Keep the backup outside the Render filesystem.
6. **Initialize the repository in staging** with expected revision `0`, then read it back and compare its canonical SHA-256 with the source.
7. **Deploy with `PDL_PLATFORM_TRANSACTIONAL_DB=shadow`.** The server keeps the existing mirror as the read source and writes the same committed state to the repository. Investigate every shadow-write failure before continuing.
8. **Exercise simultaneous updates in staging** (for example, update a support ticket while assigning a demo request). One stale write must return HTTP `409`; neither edit may disappear.
9. **Reconcile shadow and mirror state** by comparing their canonical SHA-256 values and collection counts. Do not cut over if they differ.
10. **Cut over production during a short back-office maintenance window:** create and verify a fresh independent backup, set `PDL_PLATFORM_TRANSACTIONAL_DB=primary`, restart, confirm health, sign in, and perform a read-only inspection before permitting staff mutations.
11. **Confirm operational readiness:** `/api/health` must show both platform and tenant repositories in `primary` mode with every requirement `true`. `/api/health/live` is only process liveness and is not cutover evidence.

## Server integration contract

The server integration is present behind `PDL_PLATFORM_TRANSACTIONAL_DB=off|shadow|primary`. All platform mutations run through a dedicated queue; primary mode defers the HTTP success response until the compare-and-swap database commit succeeds.

`off` preserves the prior cloud snapshot behavior, `shadow` validates database writes while reads remain on the mirror, and `primary` makes the revisioned database authoritative. An invalid value falls back to `off`; primary/shadow refuse to start without a configured Supabase connection.

Important integration rules:

- Return HTTP `409` for `PDL_PLATFORM_REVISION_CONFLICT` and ask the UI to refresh. Do not silently retry a mutation against different data.
- Await `update()` before sending a success response or email whose delivery depends on the commit.
- In primary mode, keep `platform.json` only as a rollback mirror, never as an independently writable source of truth.
- Record the authenticated platform user ID in `changedBy`; do not trust a browser-provided actor identity.
- Load the repository before accepting platform traffic. If the database cannot be reached, fail closed for back-office writes.
- Do not expose repository objects or the Supabase request function to browser bundles.

## Backup and recovery

All commands are server/local operator commands. They print hashes and revision metadata, never keys.
The recovery set contains sensitive platform state, including password hashes. Write it only to an approved encrypted, access-controlled backup location; never attach it to a ticket, commit it, or place it in a public/shared folder.

```powershell
# Export the committed platform revision to an independent directory.
node database/platform-recovery.js export --output "D:\Pro Daily Link Backups\Platform"

# Verify every payload, object, and the manifest without touching Supabase.
node database/platform-recovery.js verify --backup "D:\Pro Daily Link Backups\Platform\platform-..."

# Show restore evidence and required next step; makes no changes.
node database/platform-recovery.js restore-preview --backup "D:\Pro Daily Link Backups\Platform\platform-..." --expected-manifest-sha256 <independently-recorded-sha256>

# Only after approval and after reading the current repository revision.
node database/platform-recovery.js restore --backup "D:\Pro Daily Link Backups\Platform\platform-..." --expected-manifest-sha256 <independently-recorded-sha256> --expected-revision 42 --pre-restore-output "D:\Pro Daily Link Backups\Platform\Pre-restore" --apply
```

The restore command:

1. verifies `manifest.sha256`;
2. verifies the platform snapshot byte hash and canonical hash;
3. verifies every referenced private object and inventory entry in the source recovery set;
4. compares the operator-supplied current revision;
5. exports the current revision and all available current object bytes to the independent pre-restore destination (already-missing live objects are explicitly recorded as missing evidence);
6. preflights every destination object before making any change;
7. leaves byte-identical objects untouched, creates missing objects without upsert, and overwrites a different object only when its exact prior bytes are present in the verified pre-restore set;
8. re-downloads every restored object and verifies its byte count and SHA-256;
9. commits the platform snapshot through the same CAS function only after storage is verified;
10. reads the repository result back and reconciles revision and SHA-256; and
11. writes `restore-evidence.json` beside the pre-restore manifest with revisions, manifests, per-object actions, byte counts, hashes, and the final result.

If an upload or the repository commit fails before the repository is committed, the command reverses every storage change in reverse order: newly created objects are removed and overwritten objects are restored from the verified pre-restore bytes. It then verifies the rollback. An incomplete rollback is reported as a separate recovery emergency and is never presented as success. A provider timeout after a storage upload is treated as ambiguous: the command inspects the destination and includes any landed write in the rollback journal.

If both a repository save response and all reconciliation reads are lost, commit status is unknowable. In that exceptional state the command retains the already verified target objects, records `repository-outcome-unknown`, and fails with an operator-action error; guessing and rolling storage back could break a database commit that actually succeeded. Reconcile the repository revision/content hash and the listed object hashes before resuming writes.

A pre-restore evidence set can be integrity-valid while explicitly recording that a live object was already missing. The `verify` result reports `complete: false` and a non-zero `missingObjects` count for that evidence. Such a set documents the pre-restore state but is not accepted by `restore-preview` or `restore` as a source recovery set.

`restore-preview` is intentionally local and read-only. It verifies the selected recovery set and requires the manifest SHA-256 recorded independently when the set was created; an attacker cannot make a rewritten set trustworthy by rewriting its adjacent sidecar. It does not read or write the repository and does not contact Storage. The apply command repeats the independent-hash check before live preflight. Run apply only in the documented maintenance window so no other operator is replacing the same Storage keys; Supabase Storage does not expose an object-level compare-and-swap primitive.

As a recovery safety rule, restore clears all platform sessions and temporary setup/reset hashes, and revokes every temporary customer-support grant. Password hashes remain so active staff can sign in again, but old bearer links cannot be resurrected by restoring an earlier backup.

## Focused verification

```powershell
node --check database/platform-repository.js
node --check database/platform-state-store.js
node --check database/platform-portable-backup.js
node --check database/platform-recovery.js
node platform-repository.test.js
node platform-state-store.test.js
node platform-repository-migration.test.js
node platform-portable-backup.test.js
node platform-recovery.test.js
node platform-storage-recovery.test.js
```

Production SQL advisors and a real concurrent-write test remain deployment gates because this work intentionally does not connect to or mutate the production Supabase project.
