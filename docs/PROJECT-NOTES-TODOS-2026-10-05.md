# Project Notes & To-dos

Verified integration base: published main `02afb298f7459120b4bcdb5afd3d7b3a9a8a43d0` (approved-leave PR #38), tree `a090a10345c82fad499406f349a77625048068cb`, byte-identical to the tested leave candidate. The privacy foundation is merged as `7e2f4c6c31ba4d861873d688b657b3a84b38dfb4` (PR #39), with tested recovery tree unchanged; the client is based on that merge with tested application code unchanged. The separate landing-pricing repair is not part of this feature.

## Behavior

A project detail tab holds plain-text notes, open to-dos, and an expandable completed list. A compact editor supports add/edit, keyboard save, explicit Cancel, and reopening completed work. Saved items display authors and timestamps. History keeps every before/after text and completion change; users cannot supply or rewrite audit metadata. No due date, assignee, financial value, or automatic follow-up is invented.

Notes require an active tenant session, even in an auth-disabled demo. Owner/admin scope covers their company projects; project managers and field/foreman accounts use existing project assignment/work history access. Guest links and unknown roles cannot read or change notes. The collection is excluded from broad workspace responses and unauthenticated exports. Authenticated owner exports retain only the owner's tenant rows.

Create request IDs are persisted for safe retries. Edits require the latest integer revision. A conflict keeps the user's draft and requires reviewing the latest saved version before rebasing. An unconfirmed creation preserves its original payload; a changed draft can explicitly resolve the earlier save, then review and edit the same record rather than create a duplicate.

UI requests are invalidated and aborted on project, tenant, account, role, page/history navigation, dialog dismissal, or logout changes. Existing project-render layers carry a view guard so late data cannot append to a newer project. Notes errors do not redirect an unsigned demo away from existing project browsing. Existing API redirect behavior is unchanged by default.

## Persistence and recovery

`projectNotesTodos` is an additive tenant snapshot collection. Existing JSON, cloud snapshot, generic transactional records, and portable backup mechanisms preserve it. No SQL/schema migration, provider configuration, payment/authentication settings change, or production seed is required. Tests use disposable synthetic tenants and do not modify live operational records.

Recovery must preserve the server privacy protections once any notes have been saved. Prefer rolling back the UI assets/index to the prior version while retaining the scoped notes endpoint, `/api/state` exclusion, and authenticated tenant-filtered owner export. A raw rollback of the whole server to the base commit would spread this previously unknown collection into broad workspace/export responses, so it is not a safe recovery path. If server rollback is necessary, first apply the same collection exclusion and export protection to that server version. Retain the normal company backups and do not delete saved notes to roll back UI code.

## Staged release and tested UI rollback

The published privacy-first/recovery commit is `7e2f4c6c31ba4d861873d688b657b3a84b38dfb4` (PR #39), tree `01081ab66715b20fcc6d50b6fd2d863d41213f4f`. It retains the approved-leave `app.js` and `index.html`, includes the private endpoint and state/export protections, and does not load the Notes & To-dos client assets. The following client commit wires the Notes tab. Keep these two changes separately recoverable when publishing.

1. Publish/deploy the privacy-first version. Verify that the running server has the scoped API and collection exclusions before exposing the Notes tab or writing operational records. Wait until no older application instance can serve requests.
2. Publish/deploy the client-wiring version only after that verification and required CI passes. Verify the deployed server and client version together before adding real notes.
3. To withdraw the feature UI, revert only the client-wiring change on top of the current server, or deploy the tested privacy-first tree if no later work would be lost. Preserve later unrelated changes. Never revert the privacy-first server protection while this collection exists.
4. Run the API/privacy/restore acceptance test and applicable full checks on the exact recovery revision before deploying it. After deployment, check the UI is withdrawn while scoped access, generic-state exclusion, and tenant-filtered owner export remain enforced. Retain all note records and backups.

The recovery tree is verified in an independent checkout: approved-leave client files are byte-identical to published main `02afb298`, the server files match the feature server, and its 38-command aggregate suite includes portable backup restore and role/tenant privacy assertions. Record and verify the actual deployed commit before using it for recovery; preserve later unrelated changes.

## Verification

- `project-notes-api.test.js`: live local HTTP server with synthetic tenant fixtures; create/edit/complete/reopen, author/history integrity, validation, safe projections, role and project access, same-ID cross-tenant isolation, guest/anonymous denial, concurrent requests, revision conflicts, retry idempotency, static-file privacy, owner export privacy, and full process restart.
- `project-notes-ui.test.js`: real client module and extracted existing wrappers in a synthetic DOM/VM; text/history escaping, keyboard controls, load/empty/error states, interrupted/repeated flows, draft recovery, explicit conflict review, stale response rejection, and API error/redirect behavior.
- Aggregate gates: `npm run check`, `npm test`, `npm run security:scan`, `npm audit --omit=dev --audit-level=high`, and `git diff --check`.

Browser/device layout and touch interaction have not been visually verified. The CSS has narrow-screen single-column cards, wrapping text, 44px controls, and a 16px mobile text-field minimum, but synthetic assertions are not a real iPhone/Safari acceptance test. The pre-publication browser route was unavailable; no workaround bypass was used.

Post-deployment acceptance should confirm the delivered version's tab on an authorized project, complete/reopen/edit behavior using an authorized record, mobile keyboard/focus and narrow-screen layout, and persistence after reload. Confirm the remote commit and required CI before release.

Final local result (2026-10-05, Node 24.19.0): feature syntax checks and all 39 aggregate commands passed, including 198 UI fixtures. The independent recovery checkout passed syntax checks and all 38 aggregate commands. Independent review found no remaining feature/privacy/recovery blocker. Dependency audit reported zero vulnerabilities. The security scan reported zero critical findings and 11 review flags: the baseline 9 plus the new dynamic HTML renderer and its synthetic DOM test fixture. Variable renderer text is escaped and covered by injection tests.

Integration conflict review: server state retains both `scheduleAvailability` projection and the notes-collection exclusion. Public asset lists retain both helpers. The schedule helper loads before `app.js`, and Notes loads last. The leave stylesheet cache version and all leave fixture setup/assertions remain; only the combined app cache is advanced. All 39 feature and 38 recovery test commands are unique and include both feature suites. Recovery retains the approved-leave fix instead of returning to the older pre-leave UI.
