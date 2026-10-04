# Local security and workflow acceptance

Scope: isolated branch `codex/roadmap-launch-evidence`, initially reviewed on main `6328586` and subsequently rebased onto `6dffe9b` for the authorized draft PR. These observations do not describe deployed fixes. Existing dirty worktrees were not changed. Changes to app/server overlap files edited in the unidentified active roadmap conversation; reconcile ownership and diff before any merge.

## Production assessment using a harmless canary

At **2026-10-04 18:40:58 UTC**, a single `HEAD https://app.prodailylink.com/package.json` request returned **200**, `Content-Type: application/json; charset=utf-8` and `Cache-Control: public, max-age=3600`. No body was downloaded. The manifest is a non-sensitive public-repository canary, not a request for customer data, environment secrets or private source contents.

This proves unintended repository-manifest exposure in production. It does **not** prove that a particular private file exists there, that its contents were returned, or that any person retrieved it. No production private paths were probed. Source inspection establishes that the deployed handler allows any existing root-contained file; therefore private-file exposure is a credible risk requiring containment and operator assessment, not a claimed data breach.

Latest main is `6dffe9b7ade759c1226dfc1df38a49446326a5a0`. GitHub's Render record reports successful deployment at **18:14:13 UTC**: https://dashboard.render.com/web/srv-dal9vt5bedkc73bpru30/deploys/dep-db19elgae00c73faa5j0. Both base `6328586` and latest main have the identical vulnerable `server.js` blob `34b69db7497a8cc95d5cd98211437bbd3719832d`. Earlier affected history was not exhaustively examined.

Containment recommendation: prioritize review and explicitly approved deployment of the public-file allowlist and scoped private-asset fix. Recheck the same harmless canary for 404 and public UI assets for availability afterward. An authorized operator should assess actual deployed private-file inventory, relevant access logs and applicable caches, then decide whether incident response or credential rotation is necessary. No production mutation, cache purge, credential action or customer/private-file retrieval was performed here.

Read-only reconciliation: remote additions since this branch's base change only `landing.html`, `enterprise-pricing.css` and `scripts/service-smoke-test.js`; no remote edits overlap the current modified files. Keep PRs #27/#28 intact. The allowlist explicitly includes their new Enterprise stylesheet. The patch applies over latest main without replacing those upstream files. Existing older dirty checkout files still overlap app/server/index/package/template/UX work and require ownership reconciliation before merge; they were only inspected.

## Seven scanner findings

The scanner reports one finding per file when it sees a dynamic `innerHTML` assignment. It does not trace tainted input or prove exploitability. Findings remain visible rather than being suppressed.

| File | Inspection / disposition |
| --- | --- |
| `app.js` | Genuine unsafe customer/project/team/report/import text interpolation was found. Escape text/attribute values in the reviewed rendering paths; constrain project color/progress and photo/plan URL contexts. `browser-safety.test.js` executes production renderer functions with injected markup. This is not exhaustive certification of all 147 assignment sites or every DOM sink. |
| `blog.js` | `safeBody` escapes paragraph/header/list text; listing fields use `escapeHtml`; slug goes through `encodeURIComponent`; article metadata uses text/property assignments. The detected assignments build deliberate escaped markup. No defect established in these paths. |
| `guest.js` | `renderTickets` escapes filenames, vendor, ticket metadata, units/materials and review strings; quantities pass through `Number`; DOM indexes are numeric. The dynamic assignment is expected. No defect established in the reviewed ticket renderer. |
| `landing-content.js` | Post category/title/excerpt use the local HTML encoder and link slugs are encoded into a fixed internal URL. Expected escaped markup; no defect established. |
| `platform-demo.js` | Public demo request text passes through `demoSafe`; email is encoded into a fixed `mailto:` URL; phone is escaped in a fixed `tel:` URL; status options are fixed literals. IDs come from server-created UUIDs. Expected markup, not a demonstrated injection defect. |
| `platform.js` | `safe` protects reviewed company/help/blog/support/audit/staff text; `row` deliberately accepts already-escaped detail markup. Reviewed IDs, prices, statuses and counters have server-generated/normalized types. No defect established in these reviewed paths; future call sites must preserve that contract. |
| `test.js` | Test fixture/content strings trigger the lexical rule. This file is now denied by the public static-file policy. It is not a deployed UI sink. |

The secret scanner separately had stateful global regular expressions that could miss a matching credential in the next file. Reset the search index per file. `security-scan.test.js` proves consecutive-file detection and repeatability using synthetic values; output contains only type and filename.

## Confirmed launch-critical defects fixed locally

- Static requests previously served any existing file below the repository root, including data, configuration, source and dependency files. An explicit public-file allowlist now restricts requests to known UI assets. Directory-boundary and real-path checks prevent traversal/symlink escapes. New public assets must be added intentionally.
- Legacy local upload URLs now redirect to an authenticated API. A file must be referenced by the selected tenant and accessible to that user's project scope; anonymous, unassigned and orphan-file requests are denied. Private assets are not publicly cached. The same reference/project authorization protects cloud-file downloads before provider access.
- T&M summary reads now enforce pricing roles and manager project scope. Redacted field/restricted-manager workspaces also remove raw `contractValue`, not merely formatted budget and estimate cost.
- User text could become spreadsheet formulas in browser/server CSV even inside quotes. The shared CSV encoder protects formula/control-leading text, preserves actual numeric values, escapes embedded quotes/newlines, and preserves existing server simple-cell formatting.
- Ticket CSV used literal backslash-n separators. It now emits actual CRLF rows.
- Draft storage used only project indexes across accounts. New keys include tenant, user and stable project ID; recovery markers require matching identity. Reordering projects cannot redirect a draft. Unknown legacy unscoped drafts are left untouched, but are not automatically attributed to an account; do not silently migrate them across tenant boundaries.
- Structured drafts containing summary/labor/answers/photo names could be discarded when notes were blank. Content detection now retains these drafts. Attachment names are recovered; attachment bytes are not, and the existing reattachment notice remains.

## Local acceptance evidence and precise limits

- Financial HTTP fixture: two approved reports contribute quantity 30, labor 12, quantity/labor completion 30%, and T&M labor amount 1,200 at configured rate 100. A draft containing quantity 999/labor 99 contributes nothing. Repeated reads give identical totals. Field/foreman/restricted-manager pricing reads fail; a priced manager cannot read an unassigned project's summary.
- HTTP static/attachment fixture: anonymous data/config/source/dependency requests return 404; known public pages/scripts/logo return 200. Referenced assigned attachments remain readable, anonymous access fails, and unassigned/orphan files fail. No production data or provider was contacted.
- VM tests execute production rendering, CSV and recovery functions using controlled DOM/storage substitutes. They cover injected fields, unsafe image protocols, stable draft identity, tenant/user denial, structured-only recovery and ticket rows. They do not establish real-device interaction or offline upload/sync behavior.
- Existing integration tests cover correction/approval, financial policy and time-card CSV. The draft-tombstone assertion was updated for scoped storage rather than removed.

## Remaining product acceptance gaps

- No persisted reporting-period lock/export-record implementation was found in the reviewed application/database source. Current browser exports represent current data, not an immutable locked period. PDF/native XLSX totals and reproducibility remain unfinished roadmap acceptance; CSV fixes do not complete them.
- T&M summaries currently multiply historical approved hours by the project's current default labor rate. Immutable historical rate snapshots are not established. Resolve with the active feature owner before introducing rate migration or changing commercial semantics.
- A complete offline submission/attachment queue, background sync and representative phone/browser testing remain unverified. The local recovery fix is not an offline-delivery guarantee.
- Provider acceptance, Sentry configuration/alert recipient, all-production-tenant restore evidence and transactional rollout remain the external gates in the roadmap ledger.

## Proposed publication scope

The user authorized pushing this isolated branch and opening a draft review PR containing configuration-check correctness, static/private-file protection, pricing/project authorization and contract redaction, reviewed HTML/URL escaping, CSV correctness, scoped draft recovery, scanner repeatability, regressions and the reconciled evidence ledgers. Do not include feature expansion, provider credential changes, live billing tests or production cutover. This approval does not authorize merge or deployment. Reconcile active-work ownership before merging.

Final validation: the complete `npm test` aggregate passed after rebasing the 23-file change set onto latest main `6dffe9b`, including cloud-reference/attachment and stylesheet compatibility assertions. `npm run check`, `git diff --check`, dependency audit (zero vulnerabilities), and security scan (zero critical, seven manual-review findings) passed. Upstream pricing assets and monitoring changes were preserved. Local checks do not establish production acceptance; remote CI must verify the published commit separately.

Independent pre-merge review found and corrected a draft-key integration regression: the application's final project/report key override now retains distinct scoped namespaces, and interrupted edits restore the original report namespace. Regression tests execute that production override and check project/report separation and edit recovery. All 48 allowlisted public files and four route aliases returned 200 in an isolated local HTTP check; existing public asset references had no omitted existing files. Production provider acceptance remains open.
