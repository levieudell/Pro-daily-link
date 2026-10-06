# Recovery asset coverage: October 6, 2026

## Verified defect and narrow change

On main `976af1a5b68e447b8eda05ef23b6d0007789baa9`, an isolated synthetic guest-report request with cloud storage enabled returned HTTP 201 and saved one photo record, but the photo bytes existed only under the server's local uploads directory. The portable backup succeeded with zero objects. A deployment or disk loss could therefore leave a recoverable report with an unrecoverable image.

New guest-report photos now use the same `saveAsset` private `project-photos` storage path as ordinary report photos and retain the original tenant-scoped bucket/key metadata. Existing file-read authorization is unchanged. Failed private upload returns an error before saving the report/photo records. Cloud-disabled local behavior remains available.

Portable backups now reject unresolved attachment references before creating any destination, snapshot or manifest. This covers logos, photos, plans, tickets, estimate imports and estimate-proposal source files, including partially missing storage metadata. An explicit error identifies the record requiring recovery. Existing files and records are not deleted or migrated. Old backup manifests must not be treated as newly certified complete by this change.

## Verification

- `npm run check` and the complete `npm test` passed on the integrated candidate.
- New guest-photo tests use the real application and Supabase adapter against intercepted synthetic requests. They cover private backup bytes, failed-upload retry without persisted report/photo duplication, owner reads, anonymous/unassigned-field denial, local fallback, and refusal to certify local-only attachments.
- Portable tests cover all six unresolved attachment families, incomplete metadata, no output/download on refusal, and preservation of the original source.
- Independent review additionally covered first- and second-upload failures, wrong-project manager denial, guest-token denial and local fallback.
- A separate isolated recovery proof discarded the synthetic source store before restoring its portable manifest. It verified 3 projects, 60 reports, 58 approved reports, 2 photos, 5 private assets, 3 fixed reporting exports and 3 pay-period exports. Normal password login, report/photo relationships, production quantities/hours, export hashes and CSV bytes, and redacted company-export counts passed. The restored PNG decoded and the restored PDF's text was readable.

This is local synthetic evidence with mocked provider transport. It does not establish production provider access, independent-destination durability, retention, every production tenant's inventory, a live provider restore, scheduled execution or physical-device acceptance. Snapshot-mode HTTP acknowledgment behavior is unchanged.

## Remaining estimate-source lifecycle issue

The current estimate-import analysis route and PDF estimate-proposal route still write source PDFs to local `uploads/estimates` files. The protected file reader does not recognize those reference families, and approving a proposal removes its source-file reference when converting it into an estimate item. The new portable guard catches references that remain present, but cannot recover a reference that was already removed.

A separate reviewed change must define source-file retention through approval and explicit authorized read scope before converting these uploads to private cloud storage. It should test new imports/proposals, approval, original PDF readability, company/project isolation, pricing visibility, upload/save failures, backup inclusion and legacy handling. Do not silently widen field or project-manager access, migrate historical data, or delete files as part of this patch.

## Remaining production recovery gate

1. Inventory the approved tenants' actual backup snapshots and all attachment reference families through existing authorized provider access. Flag local-only assets and old manifests without completeness proof. Do not print credentials or customer contents.
2. Preserve any local-only source bytes before redeployment or storage cleanup. Migration and repair need separately scoped authorization; this change performs neither.
3. Confirm an approved independent destination and exact isolated synthetic restore target. Creating restored provider records/objects requires that scope. New credentials, expanded persistent access or provider changes require their corresponding approval.
4. Run the same count/hash/relationship/login/report/export checks against that isolated provider restore, retain dated evidence and verify the independent copy after reading it back. Never overwrite a live tenant or change global database mode.

Partial multi-file upload failures can leave unreferenced private objects, matching existing ordinary-upload behavior. They are not served by the app's file routes. Cleanup is deliberately excluded.

## Recovery

This patch changes application code and tests only. No schema, production data, storage permissions, billing or provider configuration is changed. Revert only this patch if necessary, preserving other work. Reverting the guest-photo change reintroduces local-only uploads; reverting the guard reintroduces misleading successful incomplete backups, so prefer a narrower rollback if possible.
