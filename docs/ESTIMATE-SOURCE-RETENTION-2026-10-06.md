# Estimate source storage and retention: October 6, 2026

## Bounded change

This candidate builds on the separate guest-photo/portable-backup candidate. It repairs storage and reference retention only. It does **not** enable source-PDF reading in the application or change any authorization policy.

- New estimate-import PDFs use the existing private `estimate-documents` bucket through `saveAsset`, retaining `storageBucket`, `storageKey`, and `url` on the import. Cloud-disabled installations retain the existing local fallback.
- New field-proposal PDFs use the same private asset helper and retain its `bucket`, `objectKey`, and `url` with the source filename/content type on each proposal's `sourceFile`.
- Approval retains the proposal record with `status: Approved`, `approvedAt`, and `approvedEstimateItemId`. Its existing source reference remains intact after the final line is approved, an estimate item is edited/deleted, or the project is archived. The estimate item retains its existing `sourceProposalId`.
- Workspace projections, proposal creation/approval responses, project archive/update responses, and the review panel expose pending proposals only. An already-approved proposal returns HTTP 409 without creating another estimate item.
- The existing portable collector already reads retained proposal references and deduplicates shared objects, so no new attachment family or manifest format is introduced.

The existing active-customer retention default in `DATA-LIFECYCLE.md` applies. This patch adds no purge schedule, no deletion endpoint, and no change to account-closure policy. It performs no historical migration or provider configuration. Existing local files/records are left in place; portable backup still fails closed when their private-storage references are incomplete. Source references discarded before this repair are not reconstructed or claimed recoverable.

## Deliberately unchanged limitations

`canReadStoredAsset` still does not recognize estimate imports or proposal sources. Original PDF reads therefore remain denied, including for owners/admins, via both private-cloud and protected-local routes. Persisting a returned source URL does not make the file readable. Do not describe this patch as repairing source-PDF access.

The retention-only baseline did not consistently enforce manager project/pricing permissions beyond generic role gates. The integrated candidate now applies the separate restrictive authorization repair documented in [ESTIMATE-AUTHORIZATION.md](ESTIMATE-AUTHORIZATION.md). This does not enable source-PDF reading. A separately scoped security review must establish a source-specific reader policy before enabling access; the generic photo/plan/ticket project matcher must not be reused to expose potentially priced estimate PDFs to field users or unpriced managers.

Upload failure occurs before new records are written. A successful object upload followed by record-save failure can leave an unreferenced object, as in the existing private-asset workflows; the reader continues denying it. Cleanup is excluded. Snapshot-mode persistence acknowledgment behavior is unchanged. Local/synthetic proofs are not evidence of live-provider durability, independent production backups, scheduled retention, or a production restore.

The two new estimate-source uploads explicitly disable the adapter's missing-bucket provisioning fallback using `createBucket: false`. Other asset callers retain their existing default behavior. A missing or undersized estimate bucket fails closed without creating a bucket or persisting a new estimate record; there is no automatic local fallback when cloud storage is configured.

The shared JSON-body cap remains 16,000,000 bytes. Because PDF bytes are base64-encoded inside JSON, an actual 15,000,000-byte upload already exceeded this cap before the repair; the existing advertised 15 MB/route-limit mismatch is not changed. The preservation boundary is the actual existing HTTP behavior, including uploads greater than 6 MB but below the JSON cap.

Legacy non-UUID company IDs still use different UUID namespaces in `tenantUuid` and the portable collector. That inherited mismatch can cause portable export to reject an otherwise stored legacy-tenant object as cross-tenant. UUID-tenant synthetic recovery results must not be generalized to those legacy tenants. No historical data or provider configuration is changed here.

## Deployment gate

Before merge or deployment of this candidate, obtain read-only evidence that the **already-existing** `estimate-documents` bucket is private, permits `application/pdf`, and has an effective per-object limit compatible with 15,000,000 bytes (the normal migration specifies 15,728,640). Confirm no lower provider-wide limit overrides it. A missing or smaller bucket is a material deployment blocker for the newly cloud-backed estimate path; obtaining approval and changing provider configuration is outside this patch. Synthetic mocks cannot establish this production fact. Do not auto-create or resize the bucket to clear the gate.

Keep the existing production local-source preservation/recovery gate: deploying this code does not migrate old bytes or reconstruct previously lost references.

## Verification

The integrated candidate passed `npm run check`, all 62 commands in `npm test` (including both private-cloud and local retention modes), `npm run security:scan` (zero critical findings; 12 existing dynamic-HTML review warnings), and independent authorization/UI review on October 6, 2026. The authorization matrix covers source/destination isolation, permission revocation and concurrent duplicate approval. Twelve actual-handler UI cases cover interrupted and overlapping imports. Tests use synthetic tenants and intercepted provider transport only. No live-provider or customer data is accessed. Real-browser and live-provider acceptance remain open.

## Recovery and compatibility

Preserve the retained proposal records and object bytes. Approved proposal records are intentionally persisted although normal workspace projections omit them. Generic company exports and recovery snapshots retain them.

Do not deploy an older destructive proposal-approval handler against these retained records without a compatibility guard: the old handler can treat an archived Approved proposal as pending, and the old UI can show it again. Prefer a forward fix. If the storage write change must be disabled, keep the Approved-state guard and pending-only projections plus every retained reference. Do not delete the retained records as a rollback workaround. Reverting to local uploads also reintroduces the portability limitation.

Draft review publication does not clear the deployment gates. This candidate must remain unmerged and undeployed until the provider-compatibility and fresh source-preservation inventory gates are satisfied. It is not certified for production source-PDF access.

### Narrow emergency containment

If emergency containment is needed, prefer a reviewed forward fix that pauses only new PDF analysis and PDF proposal submission with HTTP 503 before any source storage write. Keep manual scope proposals, retained Approved records, approval-repeat guards, pending projections, authorization checks, and all existing source references. Do not delete files, revert data, create local-only replacement uploads, or restore the old destructive approval handler. Remove a temporary pause only when the underlying problem is fixed and checks pass. This is a temporary service restriction, not an alternative production storage solution. No containment switch is enabled by this candidate.
