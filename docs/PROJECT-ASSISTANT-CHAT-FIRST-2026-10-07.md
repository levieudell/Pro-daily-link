# Chat-first project assistant draft

This separate draft starts from published main `59c25c335d8d6c9d5eb717cee02f2d709dbdd854` and reconciles the tested PR84 speech controller at `d5325fb14cdaf880179061eef22c91b76312fb66`. Existing draft branches and the published release are preserved. No merge or deployment is part of this work.

## Default interaction

Opening the optional assistant shows “What do you need?”, conversation history, one Message box, Send and Talk. There is one example. Project/action selectors, manual fields and optional existing AI suggestions are inside the closed Edit details disclosure. The assistant asks one next missing question, then shows a plain exact server preview and an explicit Confirm and save button. Back, cancel, corrections and reopening clear or invalidate the appropriate draft/preview. History stays in memory and is cleared on reopening.

Natural bounded requests cover scheduling and daily instructions, notes and open unassigned to-dos. An exact authorized project name or ID is required; duplicate people require an authorized ID. Scheduling dates require explicit on/across/between clauses; weekdays must each be named, and hours must include AM/PM or HH:mm. Relative dates, alternatives, exclusions, ambiguous names and unsupported weekday ranges require clarification. Entity names and literal Task/Instructions text cannot supply scheduling facts. To-do text stays literal; only a separately delimited positive “. Due today” or exact-date clause supplies an initial deadline. Otherwise the next question asks for no deadline, today or an exact date.

The default reducer is deterministic and calls no AI provider. The existing optional Suggest fields action still uses the configured server AI route and its disclosed minimum authorized context. Neither parser nor model output has mutation authority. This change adds no provider, key, permission, subscription, dependency or background job.

## Reused confirmation authority

Context and preview use existing project-scoped routes. All writes use the existing explicit confirmation route with its signed proposal, version and idempotency record. Server tenant/project/member eligibility, leave/availability, stale/conflict and role revalidation remain unchanged, as do assignment persistence, email handling and manual app screens. No client inference can bypass those checks. In-flight context is discarded on cancellation, stopping Talk, closing, hiding or losing foreground; late results cannot resurrect a discarded project. An uncertain confirmed save retains its exact receipt for safe retry.

Single-day scheduling and the existing atomic multi-person/date batch use one shift, task and instruction set. Existing bounds are 31 calendar days, 10 people and 100 person/date combinations. Notes/to-dos keep existing team visibility and notification policy. This is not a new project dependency engine.

## Talk and remaining device gate

Talk starts only after a user click and uses the same chat state with PR84's conservative lifecycle. It speaks one question with capture off, listens for one answer, and stops after exact preview readback. Bounds remain five minutes, 20 answers, 6,000 transcript characters and a 30-second answer timeout. Low reported confidence, unexpected end/error, hidden/blurred pages, role/context changes and interrupted readback cannot save. Voice never confirms; only the on-screen Confirm button can write.

Browser recognition/synthesis availability varies and browser speech may process audio remotely. Unsupported devices show a typing fallback. Use foreground voice while stationary. Real physical-device microphone/provider acceptance remains unexecuted; the disposable synthetic HTTPS, preview/cancel-only protocol in PROJECT-ASSISTANT-GUIDED-VOICE-2026-10-07.md still applies. No background/locked-phone/PSTN, realtime hands-free or driving readiness is claimed.

## Evidence

Synthetic reducer, controller, speech, API authorization, stale/replay/idempotency and integration tests use mocks and local fixtures; external providers are blocked. Isolated headless Chromium exercises actual full-app desktop/mobile defaults, natural and partial requests, duplicate-name/date clarification, edits, Back/cancel/reopen, plain zero-write preview, explicit save, Talk interruption, unsupported keyboard chat and pending-context cancellation. Before screenshots load the actual shipped main UI/CSS. Existing Needs-report navigation, pay presets, custom work scope, labor review and field instructions are checked in the same synthetic app. Exact-head Ubuntu CI and independent review are recorded in the delivery evidence, with local Windows POSIX file-mode failures reported separately.
