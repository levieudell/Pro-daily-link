# Tenant portable recovery

This runbook restores exactly one Pro Daily Link company from a verified portable recovery set. It restores the tenant's transactional database snapshot and every referenced private Supabase Storage object. It does not restore the back-office/platform database.

## Recovery-set contract

A complete set contains `manifest.json`, `manifest.sha256`, `snapshot.json`, and `objects/`. The manifest records the exact company UUID, transactional repository revision and canonical content hash, plus the bucket, object key, byte count, content type, and SHA-256 digest of every referenced private object.

The exporter covers company logos, project/report photos, plans, delivery or pick tickets, office estimate imports, and field estimate proposal PDFs. Export fails when it finds an old `/uploads/...` Render-disk reference. That is intentional: migrate the bytes to private Supabase Storage before calling the set recoverable. Missing Storage objects also fail normal exports.

Keep the printed manifest SHA-256 in an independent incident record or password-manager note. The restore command requires that independently recorded value; the adjacent checksum file alone is not treated as proof that an operator selected the intended set.

## Preconditions

- Use Node.js 22 or newer.
- Run from a trusted operator workstation with server-only Supabase credentials. Never put the service-role key in browser code, a shell transcript, or the backup folder.
- Set `PDL_TRANSACTIONAL_DB=primary` and use the same production project configuration as the application.
- Obtain Levi's explicit authorization and a second-person review for a production restore.
- Pause writes for the affected company before the current-revision export and keep them paused through reconciliation.
- Use the exact canonical company UUID. Aliases and company names are rejected.
- Put both the source set and the pre-restore set on an independent encrypted destination, not Render's ephemeral filesystem.

## Export and verify

```powershell
node database/tenant-recovery.js export `
  --company-id 11111111-1111-4111-8111-111111111111 `
  --output D:\PDL-Recovery\exports
```

Record the returned `directory`, `manifestSha256`, and `authority.repositoryRevision`. Verify the set without writing to Supabase:

```powershell
node database/tenant-recovery.js verify `
  --company-id 11111111-1111-4111-8111-111111111111 `
  --backup D:\PDL-Recovery\exports\11111111-...-set
```

`verify` rejects a mismatched company, altered manifest, altered snapshot, altered object, unsafe path, cross-tenant object key, duplicate object, missing payload, invalid authority, or an inventory that does not exactly match the snapshot.

## No-write restore preview

Use the SHA-256 stored outside the recovery set:

```powershell
node database/tenant-recovery.js restore-preview `
  --company-id 11111111-1111-4111-8111-111111111111 `
  --backup D:\PDL-Recovery\exports\11111111-...-set `
  --expected-manifest-sha256 <64-character-sha256>
```

Preview accepts only an authoritative `transactional-primary` export and reads no production database or Storage objects. It writes nothing.

## Apply a restore

Immediately before restore, export the current target company to establish the current transactional revision. Use that revision for `--expected-revision`. Any concurrent tenant write makes the compare-and-swap fail instead of overwriting newer data.

```powershell
node database/tenant-recovery.js restore `
  --company-id 11111111-1111-4111-8111-111111111111 `
  --backup D:\PDL-Recovery\exports\11111111-...-set `
  --expected-manifest-sha256 <64-character-sha256> `
  --expected-revision 42 `
  --pre-restore-output D:\PDL-Recovery\pre-restore `
  --confirm-company-id 11111111-1111-4111-8111-111111111111 `
  --apply
```

The command performs these steps in order:

1. Re-verifies every source byte, manifest digest, company identity, authority, and object inventory.
2. Loads the target at the exact expected repository revision.
3. Writes and verifies a separate pre-restore recovery set of the current tenant and its referenced Storage bytes.
4. Preflights every destination object. An existing object can be overwritten only when its exact current bytes are preserved in the verified pre-restore set.
5. Uploads private objects, re-checking for changes immediately before each write and verifying each uploaded digest.
6. Replaces the tenant records through the transactional repository's revision compare-and-swap.
7. Reloads the committed tenant and reconciles its revision and canonical content hash.
8. Writes immutable `restore-evidence.json` inside the pre-restore set.

If the database compare-and-swap fails, new objects are removed and overwritten objects are restored to their preserved bytes. If a provider response is ambiguous, the command fails closed, records the uncertainty, and does not claim success. Never delete either recovery set until the incident review is complete.

## Credential safety and repeatability

Recovery preserves user password hashes, but clears all active sessions and temporary password-reset, account-setup, and email-verification tokens. It revokes subcontractor guest links and customer change-order links. Users sign in again; external links must be deliberately reissued.

Re-running the same verified restore after a confirmed success is idempotent: identical Storage objects are left unchanged and an identical tenant snapshot does not receive another repository revision. A monthly drill should still target an isolated Supabase project or approved synthetic tenant.

## Post-restore acceptance

1. Confirm `restore-evidence.json` says `status: verified` and its company ID and source manifest SHA-256 match the approved incident record.
2. Compare user, customer, project, report, time-card, assignment, subcontractor, change, and audit counts.
3. Open one private photo, plan, ticket, estimate import, and proposal PDF through the application's authorized signed-URL routes.
4. Test owner login, a field login, report retrieval, project totals, CSV export, and a new write.
5. Reopen tenant writes only after those checks pass.
6. Record operator, reviewer, start/end time, source and pre-restore manifest hashes, restored revision, evidence path, and acceptance results.

Do not use Supabase database backups alone as tenant recovery evidence: database backups do not include Storage objects.
