# Project assistant current-main release candidate

This separate candidate combines the implemented assistant drafts PR #76 (`3c163adbf6d06f797c3905fd8882c7f2fd46e21a`) and PR #79 (`0086b68ec589d5818dc89647cbe2a15ecdf70e70`) with freshly fetched main `26d5ca10b661b4d089982c189275b9230d9d9741`. The original draft branches and identities remain intact. This candidate targets main and has no merge/deploy authority.

## Reconciliation performed

The assistant branch was merged locally into an isolated worktree created from exact current main. The only textual conflict was in package scripts; every current-main check and test is retained in its original order, and assistant tests are appended. Dependencies and lockfile are unchanged. No role-overlay module is imported or installed.

All PR #78 extraction/custom-scope, pay-period, labor/date-warning, and exact Needs-report navigation behavior is retained. Preservation checks confirm the corresponding source/tests/styles are identical to main. `app.js` differs only by a single assignment data attribute used for escaped daily instructions. Existing report date handlers, scope decisions, labor evidence, preset forms, dashboard targeting, and Back behavior remain intact. The original upload/PDF assets and other workers' branches are untouched.

The resulting assistant supports typed chat and guided form input, single-person/day and atomic multi-person/date-range/selected-weekday scheduling, daily instructions, project notes, and open unassigned to-dos. Multi-day limits are 31 calendar days, 10 people, and 100 person/date pairs. The exact preview includes every selected person/date, crew/ID, shift/company timezone, task/instructions, notification policy, and conflicts. The same shift/task/instructions applies to the entire batch. Confirmation revalidates fresh actor/scope/member/availability/DST and stale proposal state, then stores all grouped daily records and their complete durable receipt in one tenant write. Conflicts save none; concurrent/restarted retries do not duplicate records or notifications. In-app notifications only; no assignment emails.

Voice is a **foreground, explicitly started prototype** for supported browsers: final dictation, exact suggest/preview/read/cancel/stop commands, bounded listening, and complete spoken preview with microphone off. **Saving requires the on-screen Confirm button.** No hands-free release, locked-screen/background/wake-word/realtime/PSTN/driving capability is claimed. Unsupported or denied recognition offers typing/keyboard microphone; the complete typed multi-day flow works without speech support. No physical microphone grant, provider spend, new subscription/key/service, or production changes are part of verification.

## Effective-permissions contract and separate overlay

The current candidate preserves existing main RBAC. Fresh authenticated user/session/tenant state replaces any inherited request actor; scheduling uses the existing PM scheduling grant, project IDs, and assigned crews. Fixed owner/admin/PM eligibility remains. Existing owner/admin scheduling authority and PM project-note authority are preserved. No assistant-specific role-policy toggles are live.

The new integration test executes the actual shared server auth assembly and then supplies a **test-only** returned restriction callback to the assistant handler. It proves that returned effective actor restrictions override stored grants for single/batch preview, confirmation, and durable replay; project/role changes deny access; notes/to-dos retain current authority without scheduling grants; and any changed effective permission snapshot invalidates a pending proposal. This is a consumption/assembly contract test, not proof of a fully installed runtime role overlay. Independent review also exercised 432 permission-parity cases against current main's actual PM `managerCan` and `managerAssignmentAllowed` functions.

Before separately integrating that overlay, address all existing stored-user seams, not just assistant auth:

- Shared `authenticateRequestAccount` must normalize the account and resolve effective permissions before assigning `req.auth`.
- `/api/auth/me` currently reads and presents the stored user directly.
- `/api/state` currently reselects the stored PM for its manager workspace, and reselects the stored owner/admin for office state.
- Client state/auth presentation and manual-route authority must agree on the fresh effective actor; account/project/crew changes must invalidate pending assistant UI and server preview authority.
- Fixed assistant role eligibility and automatic owner/admin scheduling authority are separate current rules. Any future assistant-specific capability switch needs explicit UI/server/action/fingerprint policy changes, including notes/to-dos and receipt replay, with its own complete runtime tests.

Resolve those seams deliberately in the overlay's integration candidate. Do not claim this assistant draft has already enabled custom role-policy toggles. Keeping the overlay separate does not prevent release consideration of the existing typed assistant contract.

## Combined verification

All 73 combined repository test commands ran locally: 71 pass; only the unchanged Windows POSIX `0600` assertions in sales-demo-route and backup-verification report `0666`. The security assertions are preserved. Syntax checks pass, dependency audit finds zero vulnerabilities, and the security scanner finds zero critical issues. Exact-head Ubuntu Node 20/22 full suites and independent final review are required and recorded on the candidate PR.

Synthetic API checks exercise two tenants, manual scheduling during mocked AI latency, read-only context/chat/preview, fresh permissions, all-member/date conflicts, stale/cross-tab proposals, atomic writes, unique IDs, and full durable replay after restart. Existing current-main API/UI/unit suites cover custom scope across trades, ambiguous repair coverage, labor allocations, date changes, pay presets, and exact daily navigation.

Actual full-app desktop and 390px mobile QA runs every script in current index order in a new headless browser profile, with local synthetic data, blocked external providers, and mocked speech. It verifies the original assistant scheduling/note/to-do flows; all-person/date previews and exact readback; explicit weekends/conflict refusal; current-main Needs report opening an assistant-created assignment's exact project/company date without saving; current pay-period leap-month preset preview; generalized wall-tile/drywall/plumbing custom work; duplicate-labor advisory retaining the allocation and clearing when the date changes; current/upcoming instruction text appearing once and remaining literal; field Create daily preserving the assignment date; and typed multi-day preview/confirmation in a separate profile with speech recognition unavailable. No page errors or horizontal mobile overflow were found. Screenshots, test results, preservation checks, review and CI evidence are packaged separately from public source.

## Minimal owner acceptance before a separate release decision

1. On a chosen phone/browser, open the assistant and review one typed multi-day preview. Verify project, people, dates/weekdays, hours/timezone, task/instructions and all-or-none/no-email policy; cancel the preview. Confirm normal manual scheduling and daily report navigation remain familiar.
2. If speech is supported, explicitly start it, grant the browser microphone permission, dictate a harmless draft, request/read a preview, and stop. Switch away and back to confirm it stays stopped. Verify the displayed preview, then cancel. Do not rely on background or locked-phone speech; typing remains available when speech is unsupported or denied.
3. Give the separate release decision after these checks. No additional role-overlay integration or full hands-free voice is required to assess the current typed/multi-day candidate; those remain independently scoped work.

Acceptance should use harmless drafts/cancel or an authorized disposable test project. This task does not create production assignments or grant physical microphone access. Merge/deploy, production recovery checks, and a final fresh-main comparison remain separately authorized release actions.
