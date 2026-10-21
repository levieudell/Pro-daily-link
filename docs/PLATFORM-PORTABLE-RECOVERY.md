# Platform portable recovery

This runbook covers Pro Daily Link's own back-office state: platform users, support grants, growth records, content, sales activity, and operational settings. It is separate from customer-company recovery. A tenant backup cannot restore the back office, and a platform backup cannot restore a customer workspace.

## What a valid recovery set contains

Each export creates a new, randomly suffixed directory. It never overwrites an existing set or any other file in the destination. The format identifier is `pdl-platform-portable-backup-v1`.

```text
platform-<UTC timestamp>-r<revision>-<random>/
├── platform.json
├── manifest.json
├── manifest.sha256
└── objects/
    └── 00001-<sha256 prefix>.bin
```

- `platform.json` is the exact committed platform snapshot.
- `objects/` contains every private Storage object referenced by that snapshot. An export fails if a reference is incomplete, crosses the platform namespace, uses an unsafe key, still points at local `/uploads/` storage, cannot be downloaded, or returns invalid bytes.
- `manifest.json` records the repository revision, platform byte count and SHA-256, canonical snapshot SHA-256, and the bucket, key, byte count, content type, and SHA-256 of every object. Property paths are represented only by opaque source digests so user-defined keys are not repeated in command output or manifest metadata.
- `manifest.sha256` is written last. Its exact lowercase SHA-256 covers the exact bytes of `manifest.json`; its presence is the recovery-set completeness marker.

The verifier rejects a changed manifest, changed or missing snapshot, changed or missing object, unexpected object payload, duplicate entry, cross-namespace reference, symlinked payload, invalid timestamp, wrong namespace, wrong byte count, or wrong canonical hash. A set that explicitly records a missing object is integrity-valid evidence of a damaged source, but it is incomplete and cannot be used as a restore source.

The set contains highly sensitive back-office data, including password hashes and historical bearer-session material. Store it only in the approved encrypted, access-controlled Pro Daily Link backup location. Do not commit it, attach it to a ticket, paste its contents into chat, or place it in a public/shared folder.

## Create and verify a production export

Run a production export **only inside the active Render web-service instance**. A laptop or generic server with production Supabase credentials is not an approved production recovery runtime. Configure `PDL_PRODUCTION_SUPABASE_PROJECT_REF` in Render to the exact 20-character production project reference. The command independently requires the same reference with `--production-target` and binds the operation to the exact Render service and instance. It rejects a local process, pull-request instance, mismatched Supabase URL, or mismatched identity before repository or Storage I/O. Never put the Supabase URL, secret key, or any other secret in a command argument, shell history, output path, or evidence file.

When the repository is still in shadow mode, do not call a transactional platform export authoritative until the platform result has reconciled with the runtime-local and legacy copies under the verified maintenance fence. Exporting a valid transactional copy before parity is proven could create an integrity-valid backup of the wrong state. For cutover, create/refresh the platform set after the two qualifying full reconciliation passes and before primary promotion; create it again after the fenced primary deploy so the recovery packet records the primary revision.

Before the export, deploy `PDL_MAINTENANCE_MODE=1`, prove exactly one settled Render instance, then use that instance's Render Shell. If `status` already reports the same verified instance-local fence, reuse it; do not try to replace it. Otherwise, only when there is no partial/corrupt artifact, open it once. Wait at least 35 seconds after `openedAt`; the export also enforces this production quiescence period. A production export rechecks the exact fence after capturing the repository and every referenced object, re-downloads every captured object, and double-reads the repository. It withholds `manifest.sha256`, the sole completeness marker, until those checks pass. A changed fence, revision, content hash, or object removes the unaccepted set and fails the export without claiming success.

```bash
# Run in the exact active Render web-service instance; these values come from its environment.
node database/maintenance-lock.js status \
  --expected-service-id "$RENDER_SERVICE_ID" \
  --expected-instance-id "$RENDER_INSTANCE_ID"

# Run only when status proves there is no existing or corrupt local artifact.
node database/maintenance-lock.js open --apply \
  --expected-service-id "$RENDER_SERVICE_ID" \
  --expected-instance-id "$RENDER_INSTANCE_ID"

sleep 35

node database/maintenance-lock.js status \
  --expected-service-id "$RENDER_SERVICE_ID" \
  --expected-instance-id "$RENDER_INSTANCE_ID"

destination=/tmp/pdl-platform-export
node database/platform-recovery.js export \
  --output "$destination" \
  --production-target "$PDL_PRODUCTION_SUPABASE_PROJECT_REF" \
  --expected-service-id "$RENDER_SERVICE_ID" \
  --expected-instance-id "$RENDER_INSTANCE_ID"
```

The final status must report `environmentEnabled: true`, `verified: true`, the expected service/instance/release identity, and a non-null digest. Keep the fence open until the controlling cutover/incident procedure explicitly reopens writes. Securely transfer the complete generated set from the server-only destination to the approved encrypted off-Render backup location, then delete the temporary server copy only after the independent copy is rehashed and verified.

Success is a zero exit code and JSON with all of the following:

- `ok: true`
- `mode: "export"`
- `verified: true`
- `targetMode: "production"`
- the same non-null `maintenanceFenceDigest` recorded by the final fence status
- the source repository revision
- the canonical content hash
- the full manifest SHA-256
- a generated `backupSet` directory name
- the number of private objects included

The command deliberately prints no platform snapshot, account name, email, password hash, session, object key, provider response, secret, or absolute filesystem path. Record the returned manifest SHA-256 in the access-controlled change/incident record outside the recovery set.

Verify again from the independent destination:

```powershell
node database/platform-recovery.js verify --backup (Join-Path $destination '<backupSet>')
```

Success requires `ok: true`, `complete: true`, `missingObjects: 0`, and the expected revision/content hash. A zero exit code is mandatory. Merely seeing files in OneDrive is not verification.

Transfer the complete generated directory—not selected files—to the approved encrypted off-Render destination. Recompute the SHA-256 of `manifest.json` on that destination and compare it with both `manifest.sha256` and the value recorded outside the set. Use the `Confirm-PdlManifestHash` command in `DATA-RECOVERY.md`, then run `verify` against the transferred copy. Protect the copy from overwrite/deletion with provider version history or object lock and record its retention/version identifier. The source-side verification or adjacent sidecar alone is not independent evidence.

## Preview and drill a restore

`restore-preview` is local and read-only. It verifies the selected set and requires the manifest hash retained separately when the set was created.

```powershell
$sourceManifestSha256 = 'replace-with-the-independently-recorded-64-character-sha256'

node database/platform-recovery.js restore-preview `
  --backup (Join-Path $destination '<backupSet>') `
  --expected-manifest-sha256 $sourceManifestSha256
```

Before any production restore—and before cutover writes reopen—restore the set into an isolated, disposable Supabase project and isolated private Storage target. Verify platform login, customer list/counts, content, support workflow, growth pipeline, billing read model, audit history, and every referenced asset. Retain source/destination fingerprints, source and pre-restore hashes, revision/hash reconciliation, journey results, operators, timestamps, and target destruction. A successful export, copy, checksum, or preview is not a restore drill.

Zero-state restore is intentionally unsupported. First initialize the disposable platform namespace through the reviewed platform bootstrap path. Its snapshot must pass the current platform validator and contain at least one newly created disposable break-glass user with a unique disposable email, role `platform_owner`, status `Active`, `mustSetPassword` not true, and non-empty current `passwordHash`/`passwordSalt` created from a fresh credential that did not come from the source set. It must contain no inherited session, reset/setup token, or support grant. Do not hand-write `{}`, copy a backed-up credential, or weaken the validator. Run the disposable `export` shown below and use only its verified revision and content hash; if export fails, destroy and re-provision the disposable target.

The drill target needs an explicit two-sided acknowledgment: set `PDL_DISPOSABLE_SUPABASE_PROJECT_REF` to the exact disposable Supabase project reference and pass the same value with `--disposable-target`. It also requires `PDL_PRODUCTION_SUPABASE_PROJECT_REF` to hold the valid, exact production reference so the safety check can prove they differ; never put the disposable reference in that production variable. The tool rejects disposable mode in `NODE_ENV=production`, on Render, when either required guard is absent/invalid, when the URL/ref differs, or when the target equals production. Restore still requires a verified local maintenance fence:

```powershell
$env:PDL_MAINTENANCE_MODE = '1'
$env:PDL_DISPOSABLE_SUPABASE_PROJECT_REF = '<exact-disposable-project-ref>'
$env:PDL_PRODUCTION_SUPABASE_PROJECT_REF = '<exact-production-project-ref>'
$disposableCurrentOutput = Join-Path $destination 'Disposable-current-state'

# Read the disposable target's exact current revision through a verified export.
# Stop if the command exits nonzero; never guess this compare-and-swap value.
$currentTarget = node database/platform-recovery.js export `
  --output $disposableCurrentOutput `
  --disposable-target $env:PDL_DISPOSABLE_SUPABASE_PROJECT_REF | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or $null -eq $currentTarget.revision -or $currentTarget.contentHash -notmatch '^[a-f0-9]{64}$') {
  throw 'Could not establish the disposable target revision and content hash.'
}
$currentTargetRevision = [int]$currentTarget.revision
$currentTargetContentHash = [string]$currentTarget.contentHash

node database/maintenance-lock.js status
# Run open only when status proves no existing or corrupt artifact.
node database/maintenance-lock.js open --apply
node database/maintenance-lock.js status

node database/platform-recovery.js restore `
  --backup (Join-Path $destination '<backupSet>') `
  --expected-manifest-sha256 $sourceManifestSha256 `
  --expected-revision $currentTargetRevision `
  --expected-current-content-hash $currentTargetContentHash `
  --pre-restore-output (Join-Path $destination 'Disposable-pre-restore') `
  --disposable-target $env:PDL_DISPOSABLE_SUPABASE_PROJECT_REF `
  --apply
```

Production apply is an incident action, not a routine command. It requires Levi's explicit authorization, a second-person technical review, paused back-office writes, the current target revision and content hash from the same verified current-state export, a fresh independently verified pre-restore destination, and the independently retained source manifest hash. Securely transfer the approved recovery set onto the already-fenced Render instance without changing its bytes. Then use Render Shell (bash) on that exact instance:

```bash
set -euo pipefail

# Run status again in the exact instance immediately before restore.
node database/maintenance-lock.js status \
  --expected-service-id "$RENDER_SERVICE_ID" \
  --expected-instance-id "$RENDER_INSTANCE_ID"

# Replace these values only from the approved incident/change evidence.
backup=/tmp/pdl-approved-platform-set
pre_restore_output=/tmp/pdl-platform-pre-restore
current_target_capture=/tmp/pdl-platform-current-target
source_manifest_sha256=replace-with-the-independently-recorded-64-character-sha256

# Capture the current target under the same fence and take the exact live
# revision and content hash from the command's validated JSON. Never guess
# either restore precondition.
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
current_target_content_hash="$(printf '%s' "$current_target_json" | node -e '
  const fs = require("node:fs");
  const value = JSON.parse(fs.readFileSync(0, "utf8"));
  if (!value.ok || !/^[a-f0-9]{64}$/.test(String(value.contentHash || ""))) process.exit(2);
  process.stdout.write(value.contentHash);
')"

node database/platform-recovery.js restore \
  --backup "$backup" \
  --expected-manifest-sha256 "$source_manifest_sha256" \
  --expected-revision "$current_target_revision" \
  --expected-current-content-hash "$current_target_content_hash" \
  --pre-restore-output "$pre_restore_output" \
  --production-target "$PDL_PRODUCTION_SUPABASE_PROJECT_REF" \
  --expected-service-id "$RENDER_SERVICE_ID" \
  --expected-instance-id "$RENDER_INSTANCE_ID" \
  --apply
```

Run that production command only after completing the same verified open/status/35-second quiescence sequence shown for production export. The backup and pre-restore output must be separate, non-overlapping directories; the CLI rejects equal, parent, or child paths before any repository, Storage, fence, or filesystem write. After loading and validating the initialized target, apply recomputes its canonical content hash and requires an exact match to both the repository hash and `--expected-current-content-hash` before creating rollback evidence or touching Storage. Revision and hash must come from the same verified current-state export. The apply path then verifies every source byte, requires the active break-glass `platform_owner`, merges the live identity envelope forward, validates the final merged snapshot, and only then creates a portable pre-restore set. It preflights all destination objects, restores private objects, and then re-downloads **every** expected object—including objects that were initially unchanged—immediately before the repository compare-and-swap. It rechecks the exact fence immediately before that commit and again before success evidence. Rollback removes or replaces an object only while its current bytes still equal this restore's target bytes **and** the identical maintenance fence is still valid immediately before that individual mutation. A newer value is preserved; a missing/replaced fence stops the rollback without touching later objects. Either condition produces outcome-unknown evidence and requires manual reconciliation. Backup creation and verification preserve bounded legacy/quarantined role and status strings as historical evidence, but this never grants access. Matching users keep their entire live target identity rows; source-only users are inactive with credential material scrubbed and require controlled re-enrollment. Final restore validation rejects every active identity without a currently supported platform role/status while permitting inactive legacy rows to remain for audit. All platform sessions and setup/reset credentials are cleared, temporary support grants are revoked, and the seeded current-only break-glass owner remains.

If the repository compare-and-swap has committed but the final repository read or maintenance-fence verification fails, the CLI returns `PDL_PLATFORM_RECOVERY_POST_COMMIT_RECONCILIATION_REQUIRED`. Treat this as an applied-or-partially-verified recovery, never as a safe retry: keep maintenance mode closed, retain `restore-evidence.json`, inspect the authoritative platform repository and every written object, and reconcile manually before any new recovery command.

If the provider loses both the repository write response and all reconciliation reads, the command fails closed and preserves verified target objects for manual reconciliation. Do not retry blindly or change repository mode. Follow the incident runbook and reconcile repository revision/content hash plus every listed object hash first.

## Operating cadence

- Export after every material platform-schema or back-office release and at least daily once the back office contains operational sales/support data.
- Retain the manifest hash separately from the set and restrict it to recovery operators.
- Rehash and fully verify every copied set after transfer; protect the copy from overwrite/deletion and record the provider version/retention identifier.
- Run an isolated restore drill monthly and after repository or Storage changes.
- Keep Supabase point-in-time recovery enabled as a separate layer. Database PITR does not include Storage objects and does not replace this portable set.
- Alert on a failed export, incomplete set, checksum mismatch, stale last verified set, or failed restore drill. Never report success when filesystem, repository, credential, or Storage access is unavailable.

## Focused verification for code changes

```powershell
node --check database/platform-portable-backup.js
node --check database/platform-recovery.js
node platform-portable-backup.test.js
node platform-recovery.test.js
node platform-storage-recovery.test.js
```

The repository's required full launch gate still applies. These focused tests do not replace `npm run check`, `npm test`, security scanning, dependency audit, live reconciliation, or an isolated restore drill.
