# Tenant portable recovery

This runbook exports, verifies, or restores exactly one Pro Daily Link company. A complete set contains the tenant's transactional snapshot and every referenced private Supabase Storage object. It never contains the back-office/platform repository; use [Platform portable recovery](PLATFORM-PORTABLE-RECOVERY.md) for that state.

## Non-negotiable recovery-set contract

A complete set contains `manifest.json`, `manifest.sha256`, `snapshot.json`, and an exact `objects/` inventory. `manifest.sha256` is the sole completeness marker. The exporter withholds it until the live repository, every captured Storage object, and the exact maintenance fence have passed the final stability checks. Interruption or a failed final check therefore cannot leave an accepted-looking production set.

The manifest binds the set to:

- one canonical company UUID;
- an authoritative transactional repository revision and canonical content hash;
- every referenced bucket/object key, byte count, content type, and SHA-256 digest;
- the complete company-logo, project/report-photo, plan, ticket, estimate-import, and estimate-proposal inventory.

Verification rejects altered bytes, a changed manifest, a missing or extra object, symlinks, unsafe paths, a cross-tenant object key, local-disk references (`uploads`, local file APIs, UNC, `file://`, or drive paths), an invalid authority, or a company mismatch. Keep the printed manifest SHA-256 in a separate incident record or password manager; the checksum beside the set is not independent selection evidence.

The application may preserve an older durable Storage pointer only as its canonical authenticated route, `/api/files/<bucket>/<tenant-key>`, without separate `storageBucket` and `storageKey` fields. The bucket must be literal, the route must contain no outer whitespace, the object path must have one leading-free forward-slash form, and only object-key segments are percent-decoded, matching the live handler. The exporter converts that exact route into the same private bucket/object inventory and applies the normal bucket, tenant-prefix, traversal, download, and hash checks. Explicit bucket/key fields and every route field on the same asset must agree. It does **not** treat `/api/local-files/...`, `/uploads/...`, an absolute or opaque-scheme URL, a raw or encoded backslash, a leading/double slash, a raw or encoded `.`/`..` segment, a malformed or query-bearing route, or a cross-tenant key as portable. Dot segments are rejected because a browser may normalize them before the live handler sees the path, which could otherwise make the exporter fetch a different object. One invalid sibling pointer blocks the asset even when another field is valid. A canonical inline `data:` URL is already carried in `snapshot.json`; every other URL scheme fails closed. Blocked references remain explicit until the original bytes are located and migrated through a reviewed process; never clear the pointer or fabricate replacement bytes to make an export pass.

## Target binding

`export` and `restore --apply` require exactly one explicit target:

- `--production-target <project-ref>` is valid only on the exact production Render web instance. `SUPABASE_URL` and `PDL_PRODUCTION_SUPABASE_PROJECT_REF` must both match it; `NODE_ENV`, Render service type, service ID, and instance ID must also match. Production additionally requires `--expected-service-id` and `--expected-instance-id`.
- `--disposable-target <project-ref>` is valid only outside Render and outside production. `SUPABASE_URL` and `PDL_DISPOSABLE_SUPABASE_PROJECT_REF` must match it. A valid, different `PDL_PRODUCTION_SUPABASE_PROJECT_REF` is mandatory, so omitting the production identity cannot weaken the guard.

Both target modes require `PDL_TRANSACTIONAL_DB=primary`. `verify` and `restore-preview` remain local, target-free, no-provider-I/O operations.

Every restore, including a disposable drill, requires a verified maintenance fence. A production export also requires it. The command captures the fence digest, opening time, mode, source, and identity; it requires the exact same values before restore object work, immediately before the repository compare-and-swap, and immediately before success evidence. A missing or replaced fence stops the operation without claiming success.

## Production prerequisites

1. Obtain Levi's explicit authorization and a second-person technical review.
2. Deploy the exact reviewed release with `PDL_MAINTENANCE_MODE=1`, keep `PDL_TRANSACTIONAL_DB=primary`, prove one settled Render instance, and verify liveness.
3. From that instance's Render Shell, use [the production fence procedure](PLATFORM-PORTABLE-RECOVERY.md#create-and-verify-a-production-export). Wait for the required quiescence period and retain the `status` output.
4. Record the exact production Supabase project ref, Render service ID, Render instance ID, release SHA, fence digest, and tenant UUID outside the recovery directory.
5. Treat any Render filesystem directory as temporary staging only. Copy every completed set to the approved encrypted off-Render destination, independently recompute its manifest hash there, and run `verify` again before calling it a backup.
6. Never paste a service-role key into browser code, chat, command output, or a backup folder.

## Authoritative production export

Run on the exact fenced Render instance. Replace every placeholder from independently recorded values:

```powershell
node database/tenant-recovery.js export `
  --company-id <tenant-database-uuid> `
  --output <temporary-staging-root> `
  --production-target <production-supabase-project-ref> `
  --expected-service-id <render-service-id> `
  --expected-instance-id <render-instance-id>
```

`npm run backup:portable -- ...` is an alias for this `tenant-recovery.js export` path. The lower-level `database/portable-backup.js` command is legacy/shadow pre-cutover tooling and fails closed when `PDL_TRANSACTIONAL_DB=primary`; it cannot be used to bypass target or fence verification.

The command re-downloads every captured object, double-reads the repository, rechecks the fence, and only then writes `manifest.sha256`. It checks the same fence once more before reporting success. If any revision, content hash, object, or fence value changes, it removes the unaccepted set and fails.

The sanitized result prints the generated set name, company UUID, repository revision, content hash, manifest SHA-256, object count, and verification status. It does not print absolute paths, object keys, provider errors, or tenant data.

After transfer to the independent destination, verify without Supabase I/O:

```powershell
node database/tenant-recovery.js verify `
  --company-id <tenant-database-uuid> `
  --backup <exact-independent-set-directory>
```

Require `complete: true` and zero missing objects.

## No-write restore preview

Use the manifest digest recorded outside the selected source set:

```powershell
node database/tenant-recovery.js restore-preview `
  --company-id <tenant-database-uuid> `
  --backup <exact-independent-source-set> `
  --expected-manifest-sha256 <64-character-sha256>
```

Preview accepts only an authoritative `transactional-primary` source. It reads no live repository or Storage object and writes nothing.

## Establish the exact current target state

While the same fence remains active, create a separate authoritative export of the current target company. Retain its returned:

- `companyId`;
- `repositoryRevision`;
- `contentHash`;
- `manifestSha256`.

The restore must use that exact company UUID, revision, and content hash. The tool then creates and verifies another pre-restore set before its first restore write. This is deliberate defense in depth, not duplicate busywork.

The source set and `--pre-restore-output` must be filesystem-disjoint: they cannot be equal, and neither may contain the other. The command resolves existing path ancestors so a symlink or Windows junction cannot disguise an overlap, and it checks this before creating a directory or performing provider I/O.

## Apply a production restore

Run on the same production instance under the same verified fence:

```powershell
node database/tenant-recovery.js restore `
  --company-id <tenant-database-uuid> `
  --backup <exact-independent-source-set> `
  --expected-manifest-sha256 <source-manifest-sha256> `
  --expected-revision <current-target-revision> `
  --expected-content-hash <current-target-canonical-sha256> `
  --pre-restore-output <separate-pre-restore-root> `
  --confirm-company-id <tenant-database-uuid> `
  --production-target <production-supabase-project-ref> `
  --expected-service-id <render-service-id> `
  --expected-instance-id <render-instance-id> `
  --apply
```

The apply sequence is:

1. Validate the target project/runtime before repository or Storage I/O.
2. Verify every source byte, the independent manifest digest, exact tenant UUID, source revision/hash, authority, and complete object inventory.
3. Load a valid initialized target at the exact expected revision and content hash. It must already contain the same company UUID and at least one active break-glass `owner`.
4. Merge the live identity and company control-plane envelopes forward, then validate the complete merged snapshot, including its active-owner invariant.
5. Write and verify the separate pre-restore set; double-read the target to prove it did not change during capture.
6. Recheck the exact fence.
7. Preflight every destination object. An overwrite is allowed only when the exact current bytes exist in the pre-restore set.
8. Recheck each destination immediately before writing, upload, and verify the resulting bytes.
9. Final-read **every** destination object immediately before the repository write, including objects that required no upload.
10. Recheck the exact fence synchronously, then perform the tenant revision compare-and-swap.
11. Reload and reconcile the exact company UUID, revision, and canonical content hash.
12. Recheck the exact fence and write immutable `restore-evidence.json` in the pre-restore set.

## Disposable restore drill

Use an isolated Supabase project and isolated private Storage. Explicitly configure both project identities; they must be valid and different:

```powershell
$env:PDL_TRANSACTIONAL_DB = 'primary'
$env:PDL_SUPABASE_ENABLED = '1'
$env:SUPABASE_URL = 'https://<disposable-project-ref>.supabase.co'
$env:PDL_DISPOSABLE_SUPABASE_PROJECT_REF = '<disposable-project-ref>'
$env:PDL_PRODUCTION_SUPABASE_PROJECT_REF = '<production-project-ref>'
$env:PDL_MAINTENANCE_MODE = '1'
$env:NODE_ENV = 'test'
$env:RENDER = 'false'
```

Zero-state restore is intentionally unsupported. Before opening the fence, provision the disposable tenant through the reviewed service-role/bootstrap path with all of these exact properties:

- the `company.id` is the same canonical database UUID as the source set and `company.name` is non-empty;
- `users` contains a newly created disposable break-glass user with a unique disposable email, role `owner`, status `Active`, `mustSetPassword` not true, and non-empty current `passwordHash`/`passwordSalt` created from a fresh credential that did not come from the source backup;
- the snapshot satisfies the current tenant validator and has no inherited session, reset/setup token, guest link, Stripe identifier, trial grant, pricing grant, archive flag, or deletion/closure state;
- the transactional row has a real revision and canonical content hash in the disposable project.

Do not hand-write an empty `{}` row, copy the backed-up owner's password hash, or use a source-only owner as the seed. There is no override flag. Run an authoritative disposable `export` immediately after provisioning; only its zero exit code plus verified company UUID/revision/content hash may supply `<disposable-current-revision>` and `<disposable-current-content-hash>` below. If that export fails validation, destroy and re-provision the disposable target rather than weakening the restore checks.

Open and verify a local maintenance fence, then run:

```powershell
node database/maintenance-lock.js open --apply
node database/maintenance-lock.js status

node database/tenant-recovery.js restore `
  --company-id <tenant-database-uuid> `
  --backup <exact-independent-source-set> `
  --expected-manifest-sha256 <source-manifest-sha256> `
  --expected-revision <disposable-current-revision> `
  --expected-content-hash <disposable-current-content-hash> `
  --pre-restore-output <separate-disposable-pre-restore-root> `
  --confirm-company-id <tenant-database-uuid> `
  --disposable-target <disposable-project-ref> `
  --apply
```

Do not supply Render identity flags to a disposable drill. A Render runtime, a missing/invalid production project ref, identical production/disposable refs, or a missing/replaced fence is a hard failure before restore writes.

## Concurrency, rollback, and ambiguous outcomes

Storage rollback is conditional:

- a created object is deleted only if its current bytes still equal this restore's target bytes;
- an overwritten object is replaced with the pre-restore bytes only if its current bytes still equal this restore's target bytes;
- a concurrent value is never deleted or overwritten.
- the exact maintenance fence is revalidated immediately before **every** rollback delete or upload. If it is missing or replaced, rollback stops without another mutation, evidence is marked outcome unknown/manual reconciliation required, and no automatic retry is allowed.

If a provider response is ambiguous, the tool reads the destination. A proven target write can be conditionally rolled back before repository commit. An unreadable destination or bytes belonging to neither the pre-restore state nor this restore are `outcome unknown`: the tool retains the value, writes failure evidence when possible, and requires manual reconciliation. It never claims success.

If the repository save response is lost, the tool reads back the exact revision/hash. A newer different revision is also outcome unknown; Storage is retained for manual reconciliation instead of risking a destructive rollback.

Do not retry an outcome-unknown operation. Keep writes fenced, preserve both sets and logs, and follow [Incident response](INCIDENT-RESPONSE.md).

## Credential safety and repeatability

Recovery never rolls authentication or authorization backward. Backup creation and verification preserve bounded legacy/quarantined role and status strings as historical evidence; that structural acceptance never grants access. Current owners, admins, and office users keep their live target identity rows (including current permanent credentials, roles, and status) with transient tokens removed. Source-only identities are restored only as deactivated historical records with credential-like material removed and controlled re-enrollment required.

Field, foreman, and project-manager authorization is deliberately stricter. Team-member IDs, project IDs, crew IDs, and crew names are historical record keys, not durable identities across a restore. A reused ID or name may refer to a different person, project, or crew in the recovery source. Therefore every matching or current-only `field`, `foreman`, or `project_manager` identity is made credentialless and `Deactivated`; member/project/crew references and permission payloads are removed; and `historical-scope-reconciliation-required` is recorded. There is no raw-ID or name-based authorization carry-forward. An owner must explicitly match the person to the restored team record, assign current project/crew scope, and complete controlled re-enrollment after acceptance. Final merged-snapshot validation rejects any active scoped identity or any quarantined scoped identity that still contains authorization scope. The seeded break-glass owner remains usable throughout this process.

All sessions are cleared, and subcontractor guest links and customer change-order links are revoked using the actual restore execution time. Users sign in again; external links must be deliberately reissued.

The live company control-plane envelope also wins over the recovery point. That includes the current plan/cycle/price and founder terms; billing exemption, account type, subscription/trial/free-period state, next billing date, Stripe customer/subscription IDs, retired subscription IDs, webhook replay history and pending checkout; feature/demo/connector classification; email-verification, legal-acceptance, platform-growth-sync, and pricing-access policy; and archive, closure-hold, and deletion-request state. A backup therefore cannot reactivate a Cancelled or Past-due company, grant a second trial, revive stale Stripe IDs, replace current legal consent/growth-sync state, expose pricing, or reopen an archived/deletion-held account.

If the repository compare-and-swap has committed but the final repository read or maintenance-fence verification fails, the CLI returns `PDL_TENANT_RECOVERY_POST_COMMIT_RECONCILIATION_REQUIRED`. Treat this as an applied-or-partially-verified recovery, never as a safe retry: keep maintenance mode closed, retain `restore-evidence.json`, inspect the authoritative repository and every written object, and reconcile manually before any new recovery command.

Because those revocation timestamps use the real execution time, a later repeat is a new recovery event and can produce a different content hash. Never treat a retry as automatically idempotent. Re-run preview, capture the new current target revision/hash, obtain approval, and use a fresh pre-restore directory.

## Post-restore acceptance

1. Confirm `restore-evidence.json` says `status: verified` and matches the approved company UUID, source manifest SHA-256, target mode/project fingerprint, prior revision/hash, restored revision/hash, and fence digest.
2. Independently copy, hash, and verify the pre-restore set off Render before reopening writes.
3. Compare user, customer, project, report, time-card, assignment, subcontractor, change, Storage-object, and audit counts.
4. Open one private photo, plan, ticket, estimate import, and proposal PDF through authorized signed-URL routes.
5. Before enabling any scoped account, have the owner identity-match each field/foreman/project-manager to the restored team record, explicitly assign current projects/crews, and complete controlled credential re-enrollment. Never reuse the pre-restore numeric IDs or crew names as proof of identity.
6. Test owner login first, then one deliberately reconciled field login, report retrieval, project totals, CSV export, and one controlled write. Confirm every unreconciled scoped principal remains deactivated and credentialless.
7. Record operator, reviewer, start/end time, exact release/instance/fence, both manifest hashes, restore evidence, reconciliation approvals, and acceptance results.
8. Reopen production writes only through the controlled deployment sequence in [Shadow reconciliation and primary cutover](SHADOW-RECONCILIATION.md).

Supabase database backups and PITR do not include Storage objects. They complement this recovery set; they do not replace it.
