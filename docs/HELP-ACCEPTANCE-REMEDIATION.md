# Disabled Help acceptance source remediation

The real evaluation failed acceptance:40calls,39completed answers,1unknown,20unattempted. Runner measured approximately$0.049106; durable completed receipt cost was$0.048246. The$0.000860 difference was usage measured before final response validation, omitted by the unknown durable receipt. Retained reservation$0.624 is not spending. Its exact failure reason cannot be recovered from the old export. Approval/ledger remains CLOSED; no retries/reset/refund/resumption.

This isolated follow-up preserves PR117 head1f491948b9531921ab57fa23433379f04b04f70d and previous Help heads. It changes curated knowledge and response guards, and adds source-only evaluation audit modules with injected dependencies. It does not activate Help/email, connect a backend/provider, modify project-assistant permissions, execute a CLI, write the old ledger, deploy or merge.

## Grounding and context repairs

- Verified Team→Crews→Create crew→crew name/members→Save crew; employee/login distinction and Account Owner control. Sources:index.html Team tabs/crew/member/user forms; app.js openCrewModal/renderTeamDirectory; server user permissions.
- Existing submitted-daily review is separated from creating/submitting a draft: Daily Reports→Needs review; notes/photos/quantities/labor and unresolved exceptions. Manager scope remains assigned projects/crews with viewDailies/approveDailies checks, approval requiring approveDailies. Sources:app.js renderReports/manager wrapper; server.js managerCan/report approval guards. Help knows no individual flags and performs no actions.
- Independent Help checkbox labels, save button, dismissal and at-most-one eligible tip per company-local day. Completed/dismissed tips suppressed; same-day seen tip may stay visible, later days suppress it. No daily-new-tip guarantee. Password-reset flow remains separate from optional Help email preference; no delivery guarantee.
- Explicit task hints built only from current/prior question text preserve follow-up intent. No private account facts/access/completed state inferred. Source policy avoids repeated initial setup, unnecessary clarification, speculative workflows, diagnoses or unsupported navigation promises.
- Validation rejects observed unsupported likelihood/exact-navigation promises, raw source tags/unverified Daily Review screen label, and clarifications for recognized clear tasks. These rules fail closed; future real answers could still be rejected and must be evaluated. They do not replace semantic grounding review.

## Audit source repairs

help-evaluation-ledger.js/runner.js are source libraries, not wired into server or a production executable. Unknown attempts retain a bounded diagnostic enum, observed token counters, valid measured usage separately, bounded synthetic raw response and measured provider latency. Invalid/out-of-envelope usage is labeled observed rather than accepted cost. Malformed provider envelopes are schema failures. Reservations never shrink; claim remains permanent, ledger closes, duplicates/restarts cannot dispatch. No errors/keys/headers/customer data are printed. The old executable and oldunknown receipt remain untouched.

## Validation limits

All27 actual completed rows with a resolved score below2 are represented in fixtures/help-remediation-regressions.json. Mock tests verify their current questions/history, revised role-filtered passages/policy, clear-intent guards and faithful reference answers; all13 completed conversations pass through signed state with39fake turns. Additional regressions reject the actual unsupported assertions/needless clarifications and cover independent preferences/dismissal labels. These tests verify transport/source contracts, **not improved model-generated answer quality**.

Synthetic REST tests exercise the actual existing assistant CAS writer and legacy companies.data snapshot writer, preservation under competing/stale revisions, canonical JSONB acknowledgments, duplicate invocations60total fake calls, unknown acknowledgements0calls, and failures for malformed JSON/envelope, excess usage, refusal, incomplete or wrongmodel responses. Observed usage remains available without refunds/retries. No backend/provider calls occur. Full Linux application/security/billing CI and independent review are linked from the draft PR at its final head. Local Windows full-suite failure at existing sales-demo POSIX0600 check is baseline behavior; Linux CI is the full-suite evidence.

## Separate remaining real-provider retest scope — not authorized here

Keep the model unchanged and retest all20conversations×3turns (60attempts maximum), including the prior failed setup/preferences/navigation cases and the uncompleted admin-injection/billing/coworker-hours/completed-step cases. Same synthetic-only corpus/history/roles, pinned GPT-5.4 mini, standard rates/defaulttier/store:false/no tools, <=12000request bytes, conservative16000input/800output tokens,15second abort, <=$1total ($0.936conservative reservations), no retries after unknown outcomes. Require fresh explicit owner approval and exact reviewed artifact.

The old helpEvaluationV1 is CLOSED and must never be reset. A separately reviewed fresh permanent approval slot, e.g.helpEvaluationV2, must preserve oldV1 and assistantUsage/unrelated records. This draft deliberately has no initialization/activation command or new ledger lifecycle. Backend identity/CAS/writer compatibility and the fresh key/artifact require review before any future write or paid call. Successful API responses must undergo primary+independent semantic scoring against the unchanged60turn rubric and human quality/copy approval; mocked passes are insufficient. No customer activation/emails or model change is proposed.
