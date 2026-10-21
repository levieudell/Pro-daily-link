# Platform operations repository cutover

This change gives Pro Daily Link's back office its own transactional, revisioned database boundary. It does **not** apply the migration or modify production by itself.

The controlling production evidence and rollback procedure is [`SHADOW-RECONCILIATION.md`](SHADOW-RECONCILIATION.md). Its combined tenant-and-platform gate takes precedence over any shorter reconciliation description in this document.

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

This section qualifies the platform repository implementation. It does not replace the combined live cutover in `SHADOW-RECONCILIATION.md`.

1. **Merge and deploy code without enabling the repository.** Record the exact release SHA. The added modules have no production effect while the mode is `off`.
2. **Apply `database/008_platform_repository.sql` outside production first, then production under the migration procedure.** Never paste secrets into the SQL editor or evidence.
3. **Verify privileges.** The migration's final query must show only `service_role` for the two RPCs. Confirm the `private` schema is not a Data API exposed schema and retain the final privilege query result.
4. **Run every focused test below plus the required aggregate suite.** A focused pass that is absent from `npm test` is not shipped protection.
5. **Create and independently verify a full platform portable set.** It must contain the committed snapshot plus every referenced private Storage object, be copied off Render, be rehashed after transfer, and be protected from overwrite. A raw `platform.json` copy is not a recovery set.
6. **Initialize and exercise the repository in staging.** Start at expected revision `0`, read the committed state back, compare its canonical SHA-256, and exercise simultaneous updates. Exactly one stale writer must receive HTTP `409`; no edit may disappear.
7. **Deploy production with `PDL_PLATFORM_TRANSACTIONAL_DB=shadow`.** Reads remain on the legacy mirror and acknowledged mutations dual-write. Investigate every shadow-write, revision, or integrity failure before continuing.
8. **Run a reversible synthetic back-office mutation in production shadow mode.** Read it back, reverse it through the normal application path, and confirm both copies settle without Render or Sentry errors.
9. **Use the combined fenced gate.** The live cutover requires both tenant and platform modes in `shadow`, externally proven single-instance Render state, the environment and verified local maintenance fences, and two consecutive complete `--all` passes from the ordinary SSH session on that exact instance. A platform-only diagnostic cannot authorize primary mode.
10. **Promote only by separate recorded human decision.** Keep maintenance enabled, change both tenant and platform modes to `primary` together, deploy the exact reconciled SHA, and complete all pre-write health, backup, restore, and read-only acceptance in the controlling runbook.
11. **Reopen writes in a separate deployment.** Keep both modes `primary`, disable maintenance, prove one instance again, and verify one controlled platform CAS mutation plus one tenant mutation before ending the window.

`/api/health/live` proves only that the process can answer. Before writes reopen, `/api/health` must return HTTP `200`, show both repositories in `primary`, and report every required dependency true.

If a primary write might have committed, do not blindly return to `shadow` or `off`: freeze mutations and follow the decision table in `SHADOW-RECONCILIATION.md`. A mirror can be older even when a mode change appears to recover service.

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

[`PLATFORM-PORTABLE-RECOVERY.md`](PLATFORM-PORTABLE-RECOVERY.md) is the controlling platform backup/restore procedure. The commands below are a compact reference only. They print hashes and revision metadata, never keys.

The recovery set contains sensitive platform state, including password hashes. Write it only to an approved encrypted, access-controlled backup location; never attach it to a ticket, commit it, paste it into chat, or place it in a public/shared folder. Preserve the CLI-reported manifest SHA-256 outside the set, transfer the complete set off Render, independently recompute `manifest.json` SHA-256 at the destination, and compare all three values. A mutable copy or an adjacent sidecar alone is not independent evidence.

Production export and restore run only from Render Shell (bash) on the exact active web-service instance. Configure `PDL_PRODUCTION_SUPABASE_PROJECT_REF` in that service to the exact production project reference. First deploy `PDL_MAINTENANCE_MODE=1`, externally prove one settled instance, and open or reuse the verified instance-local fence. Do not replace an existing fence; if `status` reports a partial or corrupt artifact, stop for incident review.

```bash
set -euo pipefail

node database/maintenance-lock.js status \
  --expected-service-id "$RENDER_SERVICE_ID" \
  --expected-instance-id "$RENDER_INSTANCE_ID"

# Run open only when status proves there is no existing or corrupt artifact.
node database/maintenance-lock.js open --apply \
  --expected-service-id "$RENDER_SERVICE_ID" \
  --expected-instance-id "$RENDER_INSTANCE_ID"

sleep 35

node database/maintenance-lock.js status \
  --expected-service-id "$RENDER_SERVICE_ID" \
  --expected-instance-id "$RENDER_INSTANCE_ID"

node database/platform-recovery.js export \
  --output /tmp/pdl-platform-export \
  --production-target "$PDL_PRODUCTION_SUPABASE_PROJECT_REF" \
  --expected-service-id "$RENDER_SERVICE_ID" \
  --expected-instance-id "$RENDER_INSTANCE_ID"
```

The final status and export must report the exact service/instance identity, `environmentEnabled: true`, `verified: true`, and the same non-null fence digest. The exporter withholds `manifest.sha256`, the sole completeness marker, until object re-download, repository double-read, and exact-fence recheck pass; a failed final check removes the unaccepted set. Keep the fence open. Transfer the complete generated set to the approved encrypted off-Render destination, rehash it there, and record the returned manifest SHA-256 outside the set.

Verification and preview are local, read-only operations and require no production credentials:

```powershell
$destination = 'C:\Users\levif\OneDrive - forgedbuilt.com\Pro Daily Link Backups\Platform'
$sourceManifestSha256 = 'replace-with-the-independently-recorded-64-character-sha256'
$backup = Join-Path $destination '<exact-generated-platform-set>'

node database/platform-recovery.js verify --backup $backup
node database/platform-recovery.js restore-preview `
  --backup $backup `
  --expected-manifest-sha256 $sourceManifestSha256
```

After the required isolated disposable-target drill and explicit production approval, securely transfer the approved set onto the same already-quiescent Render instance. Re-run the exact identity-bound `status`, read the current live platform revision, and use that exact compare-and-swap value:

```bash
set -euo pipefail

node database/maintenance-lock.js status \
  --expected-service-id "$RENDER_SERVICE_ID" \
  --expected-instance-id "$RENDER_INSTANCE_ID"

backup=/tmp/pdl-approved-platform-set
pre_restore_output=/tmp/pdl-platform-pre-restore
current_target_capture=/tmp/pdl-platform-current-target
source_manifest_sha256=replace-with-the-independently-recorded-64-character-sha256

current_target_json="$(node database/platform-recovery.js export \
  --output "$current_target_capture" \
  --production-target "$PDL_PRODUCTION_SUPABASE_PROJECT_REF" \
  --expected-service-id "$RENDER_SERVICE_ID" \
  --expected-instance-id "$RENDER_INSTANCE_ID")"
current_target_revision="$(printf '%s' "$current_target_json" | node -e '
  const fs = require("node:fs");
  const value = JSON.parse(fs.readFileSync(0, "utf8"));
  if (!value.ok || !Number.isSafeInteger(value.revision) || value.revision < 0) process.exit(2);
  process.stdout.write(String(value.revision));
')"

node database/platform-recovery.js restore \
  --backup "$backup" \
  --expected-manifest-sha256 "$source_manifest_sha256" \
  --expected-revision "$current_target_revision" \
  --pre-restore-output "$pre_restore_output" \
  --production-target "$PDL_PRODUCTION_SUPABASE_PROJECT_REF" \
  --expected-service-id "$RENDER_SERVICE_ID" \
  --expected-instance-id "$RENDER_INSTANCE_ID" \
  --apply
```

The source and pre-restore output must be separate, non-overlapping directories. Production target, Supabase URL, Render service/instance identity, and the verified fence must all agree before repository or Storage I/O. The same fence is rechecked immediately before the repository commit and before success evidence.

Do not run production `restore` from this summary alone. `PLATFORM-PORTABLE-RECOVERY.md` defines source completeness, independent-hash verification, pre-restore capture, Storage preflight and rollback, CAS commit/reconciliation, session and temporary-token revocation, ambiguous provider outcomes, acceptance, and required human authorization. If its verifier reports `complete: false`, or a repository/storage outcome is ambiguous, freeze writes and enter incident response; never retry blindly.

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
