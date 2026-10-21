# Legacy normalized artifact quarantine

This is a one-purpose, fail-closed recovery procedure for the exact stale normalized-import artifact discovered during the transactional cutover audit. It is not a general tenant archival tool. It cannot target another company, delete data, update users, or update child rows.

## Why this exists

The exact artifact row has an empty `companies.data` value while its normalized rows duplicate an active surviving legacy snapshot. The empty object is not a valid tenant snapshot, so full-catalog reconciliation and transactional backfill correctly stop with `PROVIDER_PAYLOAD_INVALID`.

Migration `018_quarantine_legacy_normalized_artifact.sql` adds two service-role-only RPCs:

- `inspect_legacy_normalized_artifact` computes a sanitized structural safety report and cryptographic digests over the complete preserved state. It returns no names, emails, notes, object keys, or other tenant content.
- `quarantine_legacy_normalized_artifact` can change only `public.companies.data` on the single compiled-in artifact UUID, and only while that column is exactly `{}`. It changes the value to a minimal `archivedDuplicate` snapshot, making the normal catalog classifier exclude it as archived.

The mutation contains no `DELETE` and never changes `users`, `memberships`, projects, reports, assignments, customers, Storage objects, private directory rows, or transactional rows. The original company-data preimage is exactly `{}` and is recorded in immutable preview evidence. A digest over every retained row proves the preserved state does not change.

## Non-negotiable prerequisites

1. Deploy and review migration `018` through the normal migration process. Confirm browser roles cannot execute either RPC and only `service_role` can.
2. Confirm the Render process is the production web service, not a shell on a workstation or preview deployment. Record the exact Render service ID, Render instance ID, release SHA, and Supabase production project reference.
3. Verify a fresh portable recovery set for the surviving tenant independently. Keep its manifest SHA-256 outside the backup directory. The quarantine command intentionally does not read or copy tenant content.
4. Open the verified maintenance fence and wait through its quiescence window. Leave it active through preview review, apply, and the final backfill preview.
5. Use new absolute evidence paths on persistent, access-controlled storage. The command uses exclusive creation and writes a SHA-256 sidecar; it never overwrites evidence.
6. Have a second operator review the preview evidence, the independent recovery-set receipt, and all required confirmation digests before apply.

## 1. Generate the read-only preview

Run from the attached production Render instance. Replace only the angle-bracket values; the two UUID values must remain exactly as shown.

```powershell
node database/quarantine-malformed-tenant.js `
  --evidence <absolute-unused-preview-json> `
  --production-target <exact-production-supabase-project-ref> `
  --expected-service-id <exact-render-service-id> `
  --expected-instance-id <exact-render-instance-id> `
  --target-company-id 86479331-4c63-5cc3-8633-a8d7fd5751b3 `
  --surviving-company-id d3abe4a7-d659-5d07-bc8d-55625616d375 `
  --archive-at <exact-utc-iso-timestamp-with-milliseconds>
```

Preview performs two independent reads. It must report:

- `status: ready` and `writesPerformed: false`;
- `classification: malformed-empty` and `readyForQuarantine: true`;
- the expected structural counts and zero unsafe/cross-tenant/private/storage references;
- `preimage.companyDataCanonical: {}` and `capturedTwice: true`;
- four lowercase SHA-256 digests for the preimage, all preserved rows, survivor snapshot, and proposed archive data;
- a verified `.sha256` sidecar.

The evidence contains only opaque tenant references, counts, booleans, timestamps, runtime bindings, and digests. If it contains a raw company UUID or tenant content, stop.

## 2. Review and apply exactly once

Record the preview file SHA-256 independently, then supply it twice. Supply the three state digests exactly as printed in the reviewed preview. This intentional duplication prevents a copied command from silently selecting different evidence.

```powershell
node database/quarantine-malformed-tenant.js `
  --apply `
  --evidence <absolute-unused-apply-evidence-json> `
  --production-target <exact-production-supabase-project-ref> `
  --expected-service-id <exact-render-service-id> `
  --expected-instance-id <exact-render-instance-id> `
  --target-company-id 86479331-4c63-5cc3-8633-a8d7fd5751b3 `
  --surviving-company-id d3abe4a7-d659-5d07-bc8d-55625616d375 `
  --archive-at <the-exact-preview-timestamp> `
  --preview-evidence <absolute-reviewed-preview-json> `
  --preview-sha256 <reviewed-preview-sha256> `
  --confirm-preview-sha256 <same-reviewed-preview-sha256> `
  --confirm-target-company-id 86479331-4c63-5cc3-8633-a8d7fd5751b3 `
  --confirm-preimage-sha256 <preview-preimage-sha256> `
  --confirm-preserved-rows-sha256 <preview-preserved-rows-sha256> `
  --confirm-archive-data-sha256 <preview-archive-data-sha256> `
  --confirm-action "QUARANTINE EXACT LEGACY NORMALIZED ARTIFACT"
```

Apply refuses to dispatch unless the preview bytes and sidecar verify, the preview came from the same release/service/instance/Supabase target, the maintenance fence is verified and unchanged, two fresh pre-write reads equal the reviewed preview, and every explicit digest matches.

Inside PostgreSQL, an advisory lock and row lock protect the operation. The sole update is a compare-and-swap equivalent to:

```sql
UPDATE public.companies
SET data = <reviewed-archive-payload>
WHERE id = <compiled-in-artifact-id>
  AND data = '{}'::jsonb;
```

The transaction rolls back unless the preserved-row digest is unchanged and the row classifies as the exact archived quarantine snapshot. The controller then performs two more independent reads and rechecks the maintenance fence before writing success evidence.

## Ambiguous network outcome

The tool never blindly retries the mutation. If a timeout or transient provider failure occurs after dispatch, it reads twice:

- exact archived classification plus matching preserved/archive digests is recorded as a recovered verified outcome;
- anything else produces immutable `inconclusive` evidence with `writesPerformed: null`.

Keep maintenance mode active after any inconclusive result. Do not re-run apply. Review the new read-only inspection and both evidence files first.

## Cutover/backfill coordination

Before quarantine, the malformed `{}` row causes `streamLegacyCatalog`, shadow reconciliation, and transactional backfill to fail closed with `PROVIDER_PAYLOAD_INVALID`. That behavior is intentional.

After a verified quarantine, `tenantSnapshotDisposition` classifies the exact row as `archived`; it appears only in the excluded archived count and is never initialized into the transactional repository. Run a fresh full-catalog reconciliation and a fresh transactional-backfill preview. Both must prove the independent expected population without adding the artifact UUID.

Do not remove the normalized rows after cutover. Retain them through the normal data-retention window and at least one independent restore drill. Any later purge is a separate reviewed operation with its own export, retention authorization, and evidence.

## Evidence retention

Retain together, without editing:

- the preview JSON and its SHA-256 sidecar;
- the apply JSON (success or inconclusive) and its sidecar;
- the independently recorded preview digest;
- the surviving tenant recovery-set manifest digest and verification receipt;
- the migration review/approval record;
- the final full-catalog reconciliation and transactional-backfill preview evidence;
- the operator, reviewer, incident/change record, and maintenance-fence open/close evidence.

No production quarantine was executed while this workflow was built or tested.
