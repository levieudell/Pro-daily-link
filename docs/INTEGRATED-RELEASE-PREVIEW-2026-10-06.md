# Held integration preview

This is an isolated preview branch, not an approved production release. Do not merge or deploy while storage/recovery and coordinated browser/device QA gates remain unresolved.

Verified main: `976af1a5b68e447b8eda05ef23b6d0007789baa9`.

| Included PR | Exact source head | Purpose |
| --- | --- | --- |
| 55 | adaf88b1c58a174b6205225de832628d4bb7893e | Daily draft/photo recovery, safe clock-out retry |
| 56 | 0c958f176ba8b9116090eb16761f91d3383fa4b7 | Dialog-safe mobile pull refresh |
| 57 | eff7cba204de0fbc073370d2d350f127b6bd3ad7 | Exact project daily navigation |
| 58 | 216ee1708e918ad587baafd7049e6243886b7aad | Employee detail and guarded account access |
| 59 | 73cfa5e6641095fba59a4138a10611218d57f0a2 | Synthetic crew onboarding acceptance; platform-aware test assertions |

Only package.json conflicted in merges for PR56, PR57, and PR58. Preserve the unique union of all check/test commands and PR55's fake-indexeddb dependency; no suite was dropped. Final scripts contain 67 test commands (66 from source PRs/main plus an integration regression) and 29 syntax-check commands. Original source branches and main were not modified.

## Independently reviewed integration corrections

A separate reviewer reproduced two blocking daily-save gaps: the photo wrapper referenced undeclared scope/generation after successful save, skipping staged-photo cleanup; and photo/time-card preparation waits could enter a save after user/tenant/form replacement. Capture scope/generation and revalidate before delegating writes in the photo wrapper, original core save, and late labor wrapper. Regressions exercise actual functions: successful save cleanup, new-draft identity migration, unconfirmed upload retention, and user/tenant/form changes during asynchronous preparation. Independent probes and focused daily-flow/storage/employee/navigation/pull-refresh/onboarding tests passed, with no remaining concrete finding in the reviewed changes.

The reviewer then reproduced a related recovery-deletion gap: closing the dialog during pending time-card lookup correctly aborted the core with zero writes, but a later wrapper deleted unsaved note bytes and the active marker based only on dialog closure. Remove that redundant closed-dialog cleanup; successful core persistence already performs explicit recovery cleanup. Actual core/wrapper/storage-helper regression now verifies aborted close preserves exact notes and marker, and the wrapper preserves confirmed core completion. Update the older source-contract assertion to check confirmed core cleanup rather than require the unsafe wrapper cleanup.

## Dependencies and minimal release order

No module/symbol or hard runtime dependency on PR52, PR53, or PR54 was found for this preview. They are deliberately excluded.

- PR52 (`64108920235ee2926715b968dc96c5dbd6dca220`) fixes guest-photo storage and fail-closed portable backup completeness. PR53 (`411d1124bd248604a3319a15a19d7b76d25d347f`) is explicitly stacked on PR52 and fixes estimate retention/authorization. If included in the eventual release, integrate 52 before 53 and rerun the larger combined candidate. Their live upload preservation, private-bucket compatibility, backup/restore, and independent-copy evidence remain separate release gates; compiling this preview does not satisfy them.
- PR54 (`1e889edde9a614d50936b95d10b45009d6dd3218`) independently fixes project/date scheduled labor defaults. This preview still uses the pre-54 whole-crew defaults and must not be represented as including that fix. Include 54 before claiming scheduled-labor behavior, then rerun combined tests and browser QA.
- For just the requested 55–59 feature set, the minimal code release unit is this tested integration bundle including the save corrections. Do not release the original PR55 without these corrections. After the separate storage/recovery gate clears, run coordinated browser/device acceptance on the exact final candidate, then obtain/use the existing release authorization. This document provides no merge/deployment authorization.

Synthetic employee account tests do not create real employee access or invitations. Temporary credentials are synthetic; no production database/provider/billing writes, new real credentials, paid upgrades, browser actions, main merges, or deployment occurred. Windows-compatible tests do not certify Windows ACL privacy, cold onboarding restart, physical phones, or live provider restoration.
