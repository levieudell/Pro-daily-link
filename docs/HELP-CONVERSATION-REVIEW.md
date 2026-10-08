# Conversational Help follow-up — disabled draft

Preserves reviewed PR115 head `1d20a12ee267ea025a725431d1b3b67e373dc398`. Its exact-head Linux Quality/security and Founder billing workflows both passed, including full npm test. The local Windows 0600 mode assertion is platform-specific. Project assistant code and configuration remain untouched.

## Engineering completed for review

`POST /api/help/conversation` authenticates an active account, uses server-resolved role, and accepts only text, encrypted state, UUID turn ID and explicit data consent. It supplies role-filtered verified product help, never account records or action tools. Follow-ups carry bounded encrypted history tied to tenant/user/effective role and expire after 30 minutes; a restart clears state. Raw transcripts are not persisted server-side. Browser history is in memory and clears on account/role changes or New conversation.

OpenAI adapter validates completion/refusal, strict JSON response, allowed citations and usage receipts. Unknowns and ambiguity have explicit clarification/escalation fields. UI renders plain text, has labelled questions, consent, status and accessible conversation log. This does not establish semantic model faithfulness: real-provider evaluation and human review remain required.

Before each provider call, the existing tenant queue durably stores a bounded cost reservation and fingerprint. Concurrent/replayed turn IDs do not repeat provider calls. Completed results replay from a short-lived cache; after restart or cache loss the persisted receipt rejects retries rather than double-charge. Timeout, invalid answer, unknown outcome or missing usage consumes the full reservation. Active identity/access is rechecked before returning an answer. No automatic provider retries.

Default route returns disabled; approved evaluation also requires PDL_HELP_DRAFT, an explicit evaluation-scope marker and one exact configured synthetic tenant. No settings, API keys or production permissions were changed. All QA injects a mocked adapter with provider keys absent.

Email engineering now includes durable draft reservation under the existing tenant queue, unique tenant/user/tip identity, one/day and three-lifetime limits, owner/admin consent and verified-address checks, fresh membership/address/completion recheck, cancelled/unknown outcome suppression, signed tenant/recipient unsubscribe, safe GET confirmation, anonymous one-click POST and List-Unsubscribe headers. The authenticated draft-reservation endpoint has no send adapter. Unsubscribe cancels pending reservations immediately. GET never changes preferences. Signed-token tenant selection ignores caller cookies. No provider delivery, scheduler or campaign is installed. Cross-process durability uses existing transactional snapshot revision checks; rollout must use that supported persistence mode and delivery cannot proceed on a failed reservation. A future sender must recheck eligibility immediately before its external call and honor unknown outcomes; this draft never sends.

## One proposed approval scope

Provider: OpenAI Responses API at api.openai.com. Pinned model: **gpt-5.4-mini-2026-03-17**, reasoning low, store:false, strict structured output, no tools, one call per turn, 15-second timeout, 800 maximum output tokens including reasoning. Model choice is a candidate to evaluate, not a claim that its quality is already sufficient. [Official model/pricing](https://developers.openai.com/api/docs/models/gpt-5.4-mini) and [structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs) verified October 8, 2026.

Approve **synthetic evaluation only**, not customer activation: 20 prepared conversations × 3 turns = at most 60 attempts in one synthetic workspace, total ceiling **$1.00**. Failed attempts count; no unapproved retries or model substitution. Use synthetic actor IDs to keep each actor below the daily cap. Record exact commit/model/config, prompts, raw outputs, actual usage, latency and human judgments. No customer email or data may enter this evaluation. `fixtures/help-evaluation.json` contains the exact 20 conversations and expected behavior. `node scripts/help-evaluation-plan.js` validates preparation and prints the scope; it cannot call a provider.

Transmitted fields: broad effective-role enum; verified role-filtered product passages with public topic/source IDs; current synthetic question; up to six recent synthetic user/assistant turns; fixed Help policy and response schema. No database-derived company/user IDs, names, email, projects/teams, reports/files, billing, credentials, signed conversation tokens or receipt identifiers. The API receives raw user-entered text, so a later customer rollout needs separate approved data treatment; rejecting obvious email/key strings is not comprehensive PII redaction. store:false does not itself establish zero provider retention; provider data-handling approval remains part of the scope.

| Bound | Maximum reserved cost |
|---|---:|
| One call: ≤12,000 serialized UTF-8 bytes, conservative 16,000 input-token reserve + 800 output tokens | $0.0156 |
| One user, UTC day: 20 calls | $0.312 |
| One tenant, UTC day: 60 calls | $0.936 |
| Entire approved synthetic evaluation: 60 attempts | $0.936 estimated, $1.00 ceiling |

Rates verified from official docs: $0.75 input / $4.50 output per million tokens. No cached-input discounts assumed. No web/search/tools or regional endpoint uplift. Reverify rates before execution; stop and seek updated approval if model/pricing/scope differs. Actual API access/quota is not verified in this draft.

Acceptance: zero unauthorized data/actions, invented capabilities, unsupported discounts or false completion claims; citations must faithfully support the answer; clarify all ambiguous asks; useful escalation for unknowns; at least 90% human-rated useful and navigation-correct across first answers and follow-ups. Include role-spoofing and adversarial follow-ups. Schema tests and mocked screenshots are not this acceptance gate.

## Short copy/cadence for owner review

Welcome: “Welcome to Pro Daily Link. Need a hand getting started? Ask a product question or choose a help topic.”

1. Earliest day 1 — **Start with one project:** “Add a customer, then create the job your crew will work on.”
2. Earliest day 2 — **Give your crew a clear starting point:** “Add employees and organize crews in Team. The Account Owner can set up login access.”
3. Earliest day 3 — **Try your first daily:** “Check the job, date, work and labor. Save a draft or submit it to the office for review.”

Skip completed/dismissed/previously shown in-app steps. Owner is the primary optional email audience; admins make their own opt-in choice, default off. Field/foreman/manager get practical permitted-work in-app help, no email campaign. Proposed email: maximum one/day, three setup tips total, no discounts or marketing follow-up. Preferences and one-click unsubscribe control optional setup tips; security/account mail remains separate.

## Finite next gates

1. Owner reviews copy/cadence and approves or revises this exact synthetic provider/data/$1 scope.
2. Run the prepared real-provider evaluation within that approved cap; record measured usage and human quality scores. Fix failures and obtain additional approval if another paid run is needed.
3. Review email sender integration against the completed draft ledger/unsubscribe contract, without delivery; validate deployment persistence and cross-worker behavior before any campaign.
4. Make a separate production data/role rollout and activation decision. No merge/deploy or live email authorization is implied.
