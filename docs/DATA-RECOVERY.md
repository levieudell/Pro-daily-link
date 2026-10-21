# Production backup and recovery runbook

## Backup requirements

- Create a verified tenant backup at least daily and before risky migrations.
- Create a separate verified platform backup at least daily and before a repository cutover or material back-office release.
- Keep backups private, encrypted by the storage provider, company-prefixed, and inaccessible to browsers.
- Maintain a second off-Render destination with version history or object lock, plus database-provider point-in-time recovery before broad launch.
- Record object key, byte count, SHA-256 hash, company ID, revision, and verification time.
- Export database data and every referenced private Storage object with the target-bound command in [Tenant portable recovery](TENANT-PORTABLE-RECOVERY.md). The command is deliberately single-tenant; production requires the exact Supabase project, Render service/instance, and verified maintenance fence.
- Treat the generated `manifest.json`, `snapshot.json`, and `objects/` directory as one recovery set. Preserve the original object bucket/key mapping in the manifest.
- Never call a backup independent or immutable merely because it has a sidecar. Transfer the complete set off Render, recompute the manifest hash at the destination, compare it with both the sidecar and the value recorded outside the set, run the complete set verifier at the destination, then prevent overwrite/deletion under the provider's access and retention controls.

## Cutover backup packet

Repository cutover needs two generations of evidence:

1. **Pre-cutover rollback capture while reads are still legacy-authoritative.** Export one complete `pdl-portable-backup-v1` set per eligible tenant with `database/portable-backup.js` (or `npm run backup:portable:legacy -- ...`), plus the platform set. These sets preserve the authority in use before primary mode. The legacy command refuses transactional-primary exports before provider or destination I/O; once primary is authoritative, use only the target-bound, fenced `database/tenant-recovery.js export` flow. The default `npm run backup:portable -- ...` script now routes to that hardened primary export command.
2. **Primary-authority recovery capture before writes reopen.** After the primary deployment is healthy but while `PDL_MAINTENANCE_MODE=1` still blocks writes, export every tenant with `database/tenant-recovery.js` and export platform state with `database/platform-recovery.js`. These sets must record transactional revisions and must pass isolated restore drills before maintenance is removed.

The intervening legacy-to-transactional backfill is an initialization gate, not restoration or repair. `database/migrate-transactional.js` may create only a missing transactional tenant at revision `0` from an unchanged eligible legacy snapshot while the exact production target and maintenance fence remain bound. It skips an exact existing tenant, refuses divergent or unexpected population, and never writes the legacy snapshot. Preserve the pre-cutover portable sets before running it. If apply evidence reports an unknown write outcome, changed fence, timeout, interruption, or drift, keep production fenced and prove repository authority before any retry; do not overwrite the transactional side to force parity.

Example tenant commands use an explicit UUID and approved destination:

```powershell
# Shadow/pre-cutover authority capture.
node database/portable-backup.js `
  --company-id <tenant-database-uuid> `
  --output 'C:\Users\levif\OneDrive - forgedbuilt.com\Pro Daily Link Backups\Tenants\Pre-cutover'

# Primary-authority capture; run only after primary deploy while writes remain fenced.
node database/tenant-recovery.js export `
  --company-id <tenant-database-uuid> `
  --output <temporary-render-staging-root> `
  --production-target <production-supabase-project-ref> `
  --expected-service-id <render-service-id> `
  --expected-instance-id <render-instance-id>

node database/tenant-recovery.js verify `
  --company-id <tenant-database-uuid> `
  --backup '<exact-generated-tenant-set-path>'
```

The pre-cutover export self-verifies before reporting success. After transfer, verify that legacy-authority set again without changing repository mode:

```powershell
node -e "const p=require('./database/portable-backup');const r=p.verifyPortableBackup(process.argv[1],{expectedCompanyId:process.argv[2]});if(!r.ok||r.missingObjects)process.exit(1);console.log(JSON.stringify({ok:r.ok,complete:r.missingObjects===0,authority:r.authority.mode,manifestSha256:r.manifestSha256,objects:r.objects}))" '<exact-generated-tenant-set-path>' '<tenant-database-uuid>'
```

Use `PLATFORM-PORTABLE-RECOVERY.md` for the platform export and verification. A tenant set never substitutes for platform state, and a platform set never substitutes for a tenant.

Independently rehash each copied set on the destination workstation:

```powershell
function Confirm-PdlManifestHash([string]$SetPath, [string]$RecordedSha256) {
  $manifest = Join-Path $SetPath 'manifest.json'
  $sidecar = Join-Path $SetPath 'manifest.sha256'
  $actual = (Get-FileHash -LiteralPath $manifest -Algorithm SHA256).Hash.ToLowerInvariant()
  $adjacent = ((Get-Content -LiteralPath $sidecar -Raw).Trim() -split '\s+')[0].ToLowerInvariant()
  if ($actual -ne $adjacent -or $actual -ne $RecordedSha256.ToLowerInvariant()) {
    throw 'Manifest SHA-256 does not match the sidecar and independently recorded value.'
  }
  [pscustomobject]@{ Verified = $true; ManifestSha256 = $actual }
}

Confirm-PdlManifestHash '<exact-generated-set-path>' '<independently-recorded-64-character-sha256>'
```

Record the verifier output, destination, transfer time, operator, and the provider retention/version identifier. Do not record snapshot contents, Storage object keys, credentials, or customer PII in the evidence log. A missing object or `complete: false` blocks cutover.

## Restore drill

Use the complete [tenant portable recovery runbook](TENANT-PORTABLE-RECOVERY.md). `database/tenant-recovery.js restore-preview` verifies a selected set without production reads or writes; `restore` performs a guarded transactional tenant and private-object import with an independent pre-restore set, revision compare-and-swap, rollback, reconciliation, and dated evidence. The older `database/restore-drill.js` remains only a storage-connectivity check and is not recovery proof. Public health reports backup evidence, not a restored independent recovery; see [backup evidence semantics](BACKUP-VERIFICATION-2026-10-05.md).

## Production readiness attestation

`/api/health` deliberately does **not** treat the application's same-provider, single-tenant backup receipt as launch-ready recovery. In production, `requirements.verifiedBackup` is true only when `services.recovery.ready` proves all of the following against the current transactional authorities:

- the exact Supabase project reference in `SUPABASE_URL` matches the independently configured `PDL_PRODUCTION_SUPABASE_PROJECT_REF`;
- both tenant and platform repositories are in `primary` mode;
- every currently eligible tenant, and no omitted or extra tenant, has a fresh complete portable recovery set at its exact live revision and canonical content hash;
- platform state has a fresh complete portable recovery set at its exact live revision and canonical content hash;
- every set has a fresh off-provider copy whose independently recomputed manifest hash matches the portable set; and
- every tenant plus platform state has a successful restore drill no more than 35 days old and evidence that the isolated target was destroyed.

The independent backup job must publish one sanitized attestation to the private `tenant-backups` bucket under the immutable, content-addressed key `recovery-readiness/attestations/<attestation-sha256>.json` with overwrite disabled. Only after downloading and rehashing that exact object may it replace `recovery-readiness/current.json` with this strict pointer:

```json
{
  "schema": "pdl-recovery-readiness-pointer/v1",
  "attestationObjectKey": "recovery-readiness/attestations/<attestation-sha256>.json",
  "attestationSha256": "<attestation-sha256>",
  "attestationSignature": "<base64 Ed25519 signature over the exact attestation bytes>",
  "updatedAt": "<ISO time>"
}
```

Generate a dedicated Ed25519 signing key on the independent backup runner. Keep the private key off Render and out of Supabase; configure only its DER/SPKI public key, base64 encoded, as `PDL_RECOVERY_ATTESTATION_PUBLIC_KEY` in Render. Sign the exact attestation bytes before upload. The well-known pointer survives Render restart/redeploy; no ephemeral-disk or manual file injection is part of readiness. Health validates its path, full digest, Ed25519 signature, timestamp, and immutable object bytes after exact production-target binding, then compares that evidence with live tenant and platform authority. A missing, stale, unsigned, corrupt, target-mismatched, population-mismatched, or authority-mismatched attestation makes readiness HTTP `503`. Never overwrite a content-addressed attestation. Retain old immutable attestations through the reviewed evidence-retention period; the current pointer may move only after the new object has been verified.

### Independent publisher workflow

`database/recovery-readiness-publisher.js` is the only reviewed publisher. Run it from the independent backup runner, never Render. The runner needs read/write access to the private `tenant-backups` bucket, read access to current tenant/platform authorities, `PDL_PRODUCTION_SUPABASE_PROJECT_REF`, the matching public verification key, and the private PKCS8 Ed25519 key in `PDL_RECOVERY_ATTESTATION_PRIVATE_KEY`. The private key must come from that runner's secret store and must never be placed in Render, Supabase, a JSON source file, a shell-history argument, CI output, or retained command evidence.

The publisher source is a strict, local `pdl-recovery-readiness-source/v1` JSON document. It contains only `schema`, canonical `attestedAt`, `tenants`, and `platform`. Each tenant entry contains `databaseCompanyId`, `revision`, `contentHash`, `portable`, `independentCopy`, and `restoreDrill`; the platform entry contains the same fields except `databaseCompanyId`. Build it directly from the completed portable-set verifier, independent-copy rehash result, and isolated restore/drill evidence. Do not add company names, emails, paths, object keys, destinations, provider messages, or arbitrary notes. The publisher converts raw database IDs to opaque tenant refs and rejects every unknown field before provider I/O.

First validate without writes. Use absolute paths and the exact project ref; retain the returned attestation SHA-256 with the backup evidence packet:

```text
npm run backup:publish-readiness -- validate --source /approved-independent-evidence/recovery-source.json --production-target "$PDL_PRODUCTION_SUPABASE_PROJECT_REF"
```

Validation binds `SUPABASE_URL` to the independently configured project ref, requires both repositories to be `primary`, validates every freshness/checksum/completeness field, and compares the exact sorted eligible tenant population plus platform revision/content hash with live authority. It returns only a count, timestamp, and attestation digest; it performs no writes.

After an operator and reviewer compare that digest with the retained source, publish the exact same source using the digest printed by validation:

```text
npm run backup:publish-readiness -- publish --source /approved-independent-evidence/recovery-source.json --production-target "$PDL_PRODUCTION_SUPABASE_PROJECT_REF" --expected-attestation-sha256 "$ATTESTATION_SHA256" --confirm-action "PUBLISH VERIFIED RECOVERY READINESS" --apply
```

Publish refuses Render, derives and signs the sanitized attestation in memory, requires the private key to match Render's configured public key, and repeats the exact authority comparison before its first write. It uploads the attestation with overwrite disabled, downloads and compares the exact bytes, updates the pointer only after that succeeds, downloads and verifies the pointer/signature/schema chain, then repeats live authority comparison. A target, key, checksum, signature, population, provider-outcome, or final-authority mismatch returns an inconclusive sanitized result; health remains fail-closed. Re-running the same digest is idempotent only when the existing immutable object bytes are exact.

The JSON schema is intentionally strict; unknown fields are rejected so customer names, emails, object keys, destinations, and other PII cannot accidentally enter public-health evidence:

```json
{
  "schema": "pdl-recovery-readiness/v1",
  "attestedAt": "2026-10-20T19:00:00.000Z",
  "productionTargetSha256": "<sha256 of the domain-separated production project ref>",
  "populationSha256": "<sha256 of the sorted opaque tenant-ref population>",
  "tenants": [
    {
      "tenantRef": "<24-character opaque ref>",
      "revision": 42,
      "contentHash": "<canonical tenant sha256>",
      "portable": { "manifestSha256": "<sha256>", "verifiedAt": "<ISO time>", "complete": true, "missingObjects": 0 },
      "independentCopy": { "manifestSha256": "<same sha256>", "verifiedAt": "<ISO time>", "destinationEvidenceSha256": "<sanitized transfer evidence sha256>" },
      "restoreDrill": { "verifiedAt": "<ISO time>", "evidenceSha256": "<sanitized drill evidence sha256>", "targetDestroyedAt": "<ISO time>" }
    }
  ],
  "platform": {
    "revision": 17,
    "contentHash": "<canonical platform sha256>",
    "portable": { "manifestSha256": "<sha256>", "verifiedAt": "<ISO time>", "complete": true, "missingObjects": 0 },
    "independentCopy": { "manifestSha256": "<same sha256>", "verifiedAt": "<ISO time>", "destinationEvidenceSha256": "<sanitized transfer evidence sha256>" },
    "restoreDrill": { "verifiedAt": "<ISO time>", "evidenceSha256": "<sanitized drill evidence sha256>", "targetDestroyedAt": "<ISO time>" }
  }
}
```

Use `productionTargetSha256`, `populationSha256`, and `opaqueTenantRef` exported by the reviewed database modules when the independent automation builds this document; do not hand-type or invent digests. Tenant rows must be sorted by `tenantRef`, must contain no duplicates, and must reflect only the eligible transactional population. Keep the richer source evidence at the approved off-provider destination; only the sanitized attestation and pointer belong in Supabase. The public response exposes only readiness, counts, timestamps, and fixed reason codes—never target refs, tenant refs, content hashes, manifest hashes, paths, or provider errors.

Back-office/platform state has its own [platform portable recovery runbook](PLATFORM-PORTABLE-RECOVERY.md). It must be exported and drilled separately; tenant sets do not contain platform operations data, and the platform set does not contain customer workspaces.

1. Select the exact tenant and platform sets without altering production.
2. Copy them into an isolated temporary directory and independently rehash each manifest.
3. Run each repository's complete verifier; require `complete: true`, zero missing objects, exact identity, and the expected authority/revision.
4. Restore to an isolated disposable Supabase project plus isolated private Storage using the portable recovery commands. Never point a drill at production.
5. For a tenant, compare company, user, customer, project, report, time-card, assignment, subcontractor, change, Storage-object, and audit counts; exercise owner/field login, private asset retrieval, report retrieval, project totals, CSV export, and one write.
6. For platform state, compare account, support, growth, content, sales, billing-read-model, audit, and Storage-object counts; exercise platform login, customer list, support workflow, growth pipeline, and referenced assets.
7. Retain the source/destination fingerprints, source and pre-restore manifest hashes, restore evidence, revision/hash reconciliation, operator, reviewer, timestamps, and journey results.
8. Destroy the isolated database and Storage target securely and record destruction.

Run both drills monthly, after any repository or Storage change, and during primary cutover after the primary deployment but before writes reopen, using the new primary-authority sets while production remains fenced. A successful export, checksum, preview, or upload alone is not a recovery test.

Supabase Pro daily database backups and PITR do not include Storage objects. A portable recovery set must therefore be copied to an approved encrypted destination outside both Render and Supabase before the independent-backup requirement is satisfied.

## Deletion migration acceptance

Any change to the reviewed-deletion SQL or its guarded tenant tables requires the real database acceptance in [Back-office launch acceptance](BACK-OFFICE-LAUNCH-ACCEPTANCE.md) before production rollout. Run it only on a newly created, empty, explicitly disposable Supabase branch or local PostgreSQL database with migrations through `015_resumable_tenant_deletion.sql`. It is not a restore drill and a tenant backup is not a substitute for it.

Retain the immutable `<name>.json` recovery manifest that is fsynced before the first synthetic write, its independently recorded `manifestSha256`, and the completed `<name>.json.result.json`. Acceptance requires `passed: true`, `cleanup.verified: true`, verified zero-row cleanup, and destruction of the disposable target after the evidence is saved. A normal `SIGINT`/`SIGTERM` is deferred until cleanup finishes. After a power loss, `SIGKILL`, runner crash, or lost connection, use the documented `--cleanup-evidence=<manifest>` recovery command with the independently retained manifest hash, exact disposable server fingerprint, and confirmation phrase. It verifies the same bytes it hashes, then under writer-conflicting table locks proves each tenant from its exact database synthetic marker or matching terminal receipt, verifies exact synthetic user identities and empty not-yet-seeded scenarios, validates that no row falls outside those four IDs, performs exact-identity deletion, and verifies zero rows in the same transaction. It emits a separate dated cleanup result without overwriting the manifest. If cleanup cannot be proven, treat the database as contaminated and destroy the branch; never reuse it for staging or customer data.

## Production restoration

Production restoration requires Levi's explicit authorization and a second-person technical review. Keep writes fenced with the exact same verified maintenance artifact, take and independently verify the current portable target capture, preserve incident evidence, and require the separately recorded source manifest SHA-256 plus exact target company UUID, repository revision, and canonical content hash. Source and pre-restore directories must be filesystem-disjoint. Validate the customer or back-office journey before reopening writes. Follow [Tenant portable recovery](TENANT-PORTABLE-RECOVERY.md) for a company and [Platform portable recovery](PLATFORM-PORTABLE-RECOVERY.md) for back-office state; never improvise a direct table or `storage.objects` write.

If a provider response is ambiguous or a primary write may have committed, do not retry, change repository mode, or restore from a mirror merely because it looks newer. Freeze mutations, retain logs/request IDs/revisions/hashes, and follow `INCIDENT-RESPONSE.md` until authority is proven.

