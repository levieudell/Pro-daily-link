# Project assistant extension: multi-day scheduling and foreground voice prototype

This is a separate draft built on PR #76, commit `3c163adbf6d06f797c3905fd8882c7f2fd46e21a`. PR #76 remains independently reviewable and releasable. Its base main was `e949db64e744ebcb509623444c18a7c478e42880`; main was verified again before starting this extension. No urgent wall-tile, labor-audit, pay-period, or Needs-report fixes are included. Nothing is merged or deployed by this work.

The final preparation read found main advanced to `26d5ca10b661b4d089982c189275b9230d9d9741` with the separate PR #78 release. This draft preserves its PR #76 base and does not rewrite or absorb that release. Current-main reconciliation and combined regression remain a separate integration gate.

## Working multi-day slice

Select one authorized project, every authorized person, an inclusive ISO date range, each included weekday, the company timezone, one same-day shift, task, and daily instructions. Weekends are included only when explicitly selected. There are no implicit weekday defaults. The range is bounded to 31 calendar days, 10 people, and 100 person/date combinations; oversized or empty requests are refused rather than shortened. The same shift, task, and instructions apply to every selected date/person. Per-day variations require a different future design.

The server expands calendar date labels without local-clock arithmetic and validates every selected person/date against fresh project/crew scope, scheduling permission, active membership, existing assignments, approved full/partial leave, active workdays, company timezone, future start time, and missing/repeated DST hours. Overnight shifts are refused. Conflict messages name the selected person/date without exposing another project's name or private leave reason. A conflict anywhere blocks the whole batch.

The exact preview lists every person/date, including crew and member ID to distinguish identical names; range and selected weekdays; shift/timezone; task/instructions; daily record count and person/day count; all-or-none policy; and notifications. A batch creates one existing grouped assignment record per date containing all selected members. For example, five selected dates and two people create five daily records covering ten person/day combinations. Each selected person/date gets one existing in-app notification. No assignment email is sent.

Chat and preview perform no writes. Explicit on-screen confirmation reauthenticates the actor, validates all selected members/dates again, and checks the signed preview fingerprint. All grouped assignment records and the complete receipt are staged into one existing tenant write. No partial batch is intentionally saved. The receipt records every resulting assignment ID. Concurrent and restarted retries return that complete original result without writing or notifying again; current scope and active membership are required for every selected member even on replay. Changes in another tab, leave, crew, role, project, or relevant work state require a fresh preview. Unknown save outcomes retain the original reviewed token for an explicit safe retry.

The existing server-side Responses API may suggest fields from the typed request, selected project name, and authorized member names only. It has a strict schema, bounded response, `store:false`, no tools, and no SQL or mutation authority. People, ISO dates, hours, and named weekdays must be grounded in the request; an ambiguous member or invented date/weekend is not silently accepted. Natural weekday shorthand such as "Monday-Friday" may require explicit form selections. Without configured AI, the same editable form works. All provider tests are mocks and spend no API tokens. No credentials, contacts, reports, budgets, or other project content are sent.

The extension also omits private assistant retry receipts from owner/admin client state, matching the existing PM/field workspace policy. Normal manual scheduling and notes screens retain their existing paths.

## Actual voice prototype and limits

The prototype uses runtime-detected browser `SpeechRecognition` and speech synthesis. It starts only after an explicit button press and browser microphone permission, accepts final transcripts for at most five minutes while the page has focus and is visible, and never automatically restarts. Speech services may process audio or readback through the browser/device provider. PDL does not record audio, upload audio to its AI route, install language packs, or add a speech subscription. Unsupported, denied, or stopped recognition falls back to typing or the keyboard microphone.

Only these exact standalone commands are recognized:

- `assistant suggest fields`: request an editable proposal and read the response.
- `assistant preview changes`: validate completed fields and read the exact displayed preview.
- `assistant read preview`: read the exact displayed preview.
- `assistant cancel preview`: discard the client preview.
- `assistant stop listening`: stop capture.

Other speech is draft text. There is no voice confirm/save command. **Saving still requires the on-screen Confirm button.** A command pauses listening; the user explicitly starts it again to continue. The microphone is aborted before readback to prevent synthesized labels from becoming commands. Readback refuses an oversized preview instead of truncating it. Blur, hiding, editing, closing, scope/role changes, and stopping invalidate the voice generation, including pending proposal/preview readback after the page becomes visible again. UI request sequence and voice generation must both still match.

This is a working foreground dictation/command/readback prototype, not full hands-free operation. It provides no lock-screen, background, wake-word, realtime conversation, PSTN, or driving mode. No browser/OS support matrix is claimed from feature detection alone. Physical permission, capture, recognition, synthesis, focus, and mobile suspension still require acceptance on selected devices. Voice-only confirmation would require a separate deliberate design and review; a paid Realtime route or new credentials/subscription would require cost/access approval before implementation or testing.

The investigation used primary references: [MDN SpeechRecognition](https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition), [MDN continuous recognition](https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition/continuous), and the [Web Speech API specification](https://webaudio.github.io/web-speech-api/). Recognition has limited browser availability, some implementations send audio to a service, and the specification requires informed permission and visible capture indicators. These facts support the explicit-start foreground boundary and transparent fallback.

## Verification and integration boundary

Synthetic tests cover raw batch bounds, weekdays/weekends, month/year/leap boundaries, missing/repeated DST times, time off, adjacent/conflicting shifts, multiple people, last-member permission/status changes, stale proposals, cross-tab saves, concurrent retries, unique IDs, snapshot/transactional receipt roundtrip, and atomic staged write failure. Provider mocks test minimal context and untrusted/invented/ambiguous responses. Two-tenant HTTP tests cover no-write previews, all-member access, complete retry/restart results, private modules/receipts, and existing manual scheduling.

Voice unit/controller tests cover explicit start, final-result deduplication, strict read-only commands, denied/unsupported/throwing speech APIs, no automatic restart, five-minute stop, exact readback with capture off, and late command/readback cancellation after blur, hide/show, close, and role changes. Isolated headless Chromium full-app QA uses synthetic local tenants, mocked speech APIs, a new profile, and blocked external providers. Desktop and 390px mobile previews, every person/date, weekend edits, all-or-none conflicts, manual single-day/note/to-do flows, and field daily instructions pass without page errors or mobile horizontal overflow. Screenshots/evidence are stored outside the published source.

Local syntax and security checks passed (zero critical scanner findings); dependency audit found zero vulnerabilities. The full collected local suite passed 65 of 67 commands. Only existing Windows POSIX-mode assertions in `sales-demo-route.test.js` and `backup-verification.test.js` fail (`0666` instead of `0600`); these security checks are preserved. Exact-head Ubuntu Node 20 and Node 22 workflows remain required and are recorded on the draft PR. No paid AI test, real microphone, production record, shared browser, or deployment is used for verification.

Eligibility remains fixed to existing owner/admin/project-manager actors. No policy interface is presumed live. When separately combining the unmerged effective-role overlay, apply `roleRestrictions.effectiveUser(db.company, normalizedUser)` at shared fresh auth assembly before assigning `req.auth`; then run dedicated combined single/batch/notes/replay/role-revocation tests. This follow-up introduces no dependency on that prototype.

The bounded extension does not edit existing assignments, vary instructions by day/person, create dependency cascades, broaden project-tracking context, add subscriptions/permissions, or implement trucking/fleet features. Release requires the separate release decision, preservation of concurrent work, current-main reconciliation, production recovery checks, exact CI, and selected-device acceptance. Draft creation grants no merge/deploy authority.
