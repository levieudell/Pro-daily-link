# Full release candidate and rollback boundaries

This is an isolated draft integration for a separate final release decision. It does not merge main, deploy, apply SQL, create credentials, change provider settings, migrate old uploads, or modify production data. Earlier component documents record historical validation and holds; this manifest describes the combined scope and current evidence limits.

## Pinned inputs

| Input | Exact commit | Included behavior |
| --- | --- | --- |
| Main, including merged PR65 | `ed8e5516d56ea3751cc043ee6a0fa79c5da724b3` | Mobile dialog refresh protection and exact project daily navigation |
| PR64 | `ffc9f53019cbed025241302dc94dba318fc9efc1` | Daily flow/device recovery, employee access, restricted crew, estimate review/import, null labor budgets and duplicate approval guard; includes its PR62/63 ancestry |
| PR52 | `64108920235ee2926715b968dc96c5dbd6dca220` | Private guest photo persistence and fail-closed incomplete portable backups |
| PR53, stacked on PR52 | `411d1124bd248604a3319a15a19d7b76d25d347f` | Private estimate PDF persistence, retained approved sources, pending projections and scoped authorization |
| PR54 | `1e889edde9a614d50936b95d10b45009d6dd3218` | Report defaults use selected project/date schedule; preserve actual, explicit and historical labor |
| PR66, source only | `110499987fa9a731cbbe204fabd7a1ed0a457a9e` | Fresh/guarded SQL source and isolated SQL CI preserve PT409 conflict behavior |

All source branches remain independent. The integration uses merge ancestry, with no force push or changes to original PR refs. Its branch is `codex/full-release-integration-2026-10-07`, based on main above. Recheck main and the source heads before the final release decision; any later base change requires candidate reconciliation and affected checks again.

## Integration decisions

- Retain every distinct component test/check command: 81 application regression commands and 34 syntax checks. The PR66 SQL job remains byte-identical, installs pinned PGlite 0.5.8 outside application dependencies and uses no production connection.
- Retain PR64's strict all-line validation, inclusion controls, missing amount/unit handling, nullable labor budgets and duplicate import approval code. Combine PR53's creator/project provenance, current pricing/project authorization, private source storage and stale import dialog sequences.
- Restricted crew uses the dedicated route allowlist, minimal workspace and assignment-based asset checks before ordinary field routes. Pending-only estimate projections do not replace that restricted workspace.
- Guest photos use private `project-photos`; estimate imports/proposals use existing private `estimate-documents` with `createBucket:false`. Configured-cloud upload failure does not silently switch to local storage. Cloud-disabled installations retain the documented local fallback.
- Approved proposal records and original source references persist. Source PDF reads remain denied, including owner/admin reads. This candidate does not add a document-reader policy.
- Independent review reproduced two device photo-loss races: closing during daily labor preparation or an unconfirmed progress upload could clear recovery bytes without a save. Core handlers now return an explicit saved result; cleanup requires it. Progress preparation and encoding capture session, recovery key/generation and project ID, so stale forms cannot upload into a replacement form. New actual-handler tests preserve exact retry bytes/notes and check confirmed cleanup.
- Integration fixtures also exposed a parser rule that discarded every description starting with “Synthetic”, including legitimate synthetic turf scope. Only the exact fixture header `SYNTHETIC DOCUMENT ONLY` is now skipped; a priced turf regression verifies the distinction.

No application dependency version changes accompany the storage/SQL integration. PR64 adds the `fake-indexeddb` development dependency already present in its lockfile. No automated migration/deletion/purge is introduced. The existing JSON cap is 16,000,000 bytes: base64 JSON means the advertised 15 MB PDF limit cannot be reached over the existing route. Tests exercise 8 MB PDFs and the existing HTTP cap; this candidate does not claim a new 15 MB upload guarantee.

## Verification and its limits

The draft PR and task evidence record the final exact-head local aggregate, syntax/security/audit, Linux application/billing/SQL CI and independent review results. These are required to certify the published candidate; earlier component CI and intermediate heads do not substitute for them.

Coverage includes actual authenticated synthetic server requests; tenant/role/project/pricing denial without side effects; restricted clocks/photos/revocation; daily saved drafts, stale saves and photo retries; scheduled labor historical/zero/actual rows; null/zero save/reload/production comparisons; private/local PDF retention; immutable byte hashes and deduplicated portable object sets; and local SQL fresh-install, stale-write rollback, grants/settings, drift refusal, idempotence and prepared-call adoption. Standalone headless Chromium uses disposable fixtures and loopback-only requests, with desktop/mobile emulation. It does not attach to the shared browser.

The retained full parser/API regressions include the already bundled public Smartsheet sample as an unsupported-layout oracle. All newly constructed inputs and review/rollback fixtures are synthetic; no customer export or paid provider call is used. No real OCR/model accuracy, native QuickBooks acceptance, physical iPhone acceptance, live-provider restoration, independent Drive restoration or all-tenant disaster recovery is certified.

## Demonstrated rollback incompatibilities

Independent actual-server probes load the same candidate-shaped synthetic snapshot against current main and this candidate. On main, a restricted crew user receives a daily report, an unknown `budgetHours:null` is presented as zero, and a retained Approved proposal is approved again with another item and its source record removed. The candidate denies the daily, preserves unknown metrics and returns 409 for replay while retaining the source. Thus **a full code revert to current main is not a safe rollback after these formats/access modes are used**.

Any rollback or forward containment must preserve:

1. Restricted crew `fieldAccessMode`, exact method/path guards, own time/schedule projections, assignment-only photo access, stale authorization checks and separate crew routes. Do not downgrade these users to ordinary field operations.
2. Null versus explicit zero budget/amount semantics in API writes, reload and production/insight presentation. Keep existing numeric records intact.
3. Retained Approved proposal/source/import records, immutable original bytes, approval-repeat guards, pending-only projections and scoped pricing/project authorization. Do not restore destructive approval or local-only source writes.
4. Saved report/workday identities, idempotent end/retry behavior, template versions/custom fields, approval/audit data and device recovery keys/bytes. Code rollback does not undo saved operational work.
5. The already approved live PT409 function behavior and matching source. App rollback must not run old SQL or restore the 40001 clause. PR66 source inclusion executes no SQL.

The tested candidate can read these synthetic persisted formats. A prebuilt alternate production rollback commit or automatic containment flag is **not** supplied or tested. Prefer a reviewed forward correction. If PDF intake needs emergency containment, pause only new PDF analysis/proposal submissions with 503 before writes while preserving manual scope, existing references, authorization and approved-state guards; implement and test that concrete containment separately before using it. No broad database restore belongs in ordinary code rollback, because it would discard subsequent business work and would not restore stored file bytes.

## Remaining release and recovery checks

- Obtain fresh read-only confirmation that the existing `estimate-documents` bucket is private, permits PDFs and has a compatible effective object limit (including the project-wide cap). October 6 evidence is historical. Do not create/resize a bucket to clear this check without separate authorization.
- Immediately before any authorized restart, reconcile all current live local-source references/bytes and authoritative cloud snapshots; preserve any unique local bytes. This candidate performs no historical migration or reconstruction. The October 7 parent-reported inventory found no current unique local upload bytes, but it is time-bound evidence, not a standing guarantee.
- Verify the approved exact release head, successful cloud-load/startup and tenant state reconciliation, then canary the affected private photo/PDF and restricted crew flows with appropriately authorized acceptance. Local mocks establish code behavior, not effective live storage policy or provider durability.
- Choose and review the actual rollback/containment commit preserving the five boundaries above before publication. Run its permission/null/source/reference checks against a synthetic post-release snapshot. The proven unsafe old-main rollback is not a substitute for testing that future commit.
- The screenshot-verified Supabase physical database restore point is **2026-10-07 09:50:49 UTC**, supplied by the parent incident task; it excludes Storage file bytes. Independent encrypted Drive file recovery remains incomplete. Finish the independently authorized byte/reference/hash copy and isolated restore/reconciliation before claiming independent recovery. Do not claim current object readability or portable synthetic tests prove this recovery.

The Drive gap is a real disaster-recovery limitation. A completed archive alone would not protect PDFs uploaded later; the private storage/retention fixes address that route directly. Connect remaining acceptance checks to these actual mechanisms rather than imposing a speculative blanket requirement for every cosmetic change. Production publication requires a separate final decision and does not follow from publishing this draft.
