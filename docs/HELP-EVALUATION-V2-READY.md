# V2 standalone synthetic retest: source-only readiness

Artifact: `artifacts/pdl-help-evaluator-v2.cjs`, 48,846 bytes, SHA-256 `699db2ceca1ee6de458059cd8ad1b844cdae5c7c9634fe0503640b590a7258a7`. No runtime package installation, checkout, builder, disk or new infrastructure is required. Node 20 or newer runs this single file. `.gitattributes` prevents checkout line-ending changes to its bytes. The deterministic builder embeds exact reviewed corpus, conversation payload, unchanged cases/scoring and snapshot helpers from PR121 commit `4195e60c01359108e177fe13308764f9150947d7`, plus the V2 source libraries. The old V1 executable/libraries/closed record remain unchanged.

## Exact proposed owner approval

Approve initialization of **one fresh permanent `helpEvaluationV2` ledger** and **one synthetic-only run of 20 conversations x 3 turns, at most60 provider attempts and $1 new spend**, using this exact artifact and existing runtime access. Pinned model `gpt-5.4-mini-2026-03-17`, default service tier, low reasoning, `store:false`, no tools. At approved standard rates $0.75/M input and $4.50/M output, each attempt reserves $0.0156; maximum reservations $0.936. Payload <=12,000 UTF-8 bytes, conservative16,000 input tokens and800 output tokens including reasoning. No retries, reset, expiry, refunds, replacement run, key creation, configuration/grant changes, customer data access, emails, Help activation, deployment or merge. Check pricing/service context remains compatible; alternate/regional pricing is outside scope.

Data is the verified role-filtered public product corpus, unchanged20 synthetic conversations and prior synthetic responses from this run. All27 previously failed completed rows and previously uncompleted safety/billing/coworker/completed-step cases are included. Primary and independent semantic scoring is required after execution; mock passes do not establish model quality. Early unknown termination may leave some rows unattempted.

## Permanent storage and automatic preflight

Existing operations namespace `5a7f362f-e399-56e3-9458-e34b794a389d`, `tenant_revisions.scalar_data.helpEvaluationV2`. This is a fresh key in the existing revision, not a new database. The adapter requires V1 to exist, be closed, retain a64-hex permanent claim and have original artifact hash `442cfa4d82e5c2e2281ee9cfcd486d6806f127bbcffd3ef6706ad38b50622023`. It rejects reuse of V1's approval ID. CAS merges only V2, preserves V1/assistantUsage/all unrelated scalar fields and tenant records, and verifies namespace, next revision, canonical full scalar and content hash in the acknowledgement. There is no V1 write/reset/refund path.

`--inspect` is read-only and reports preflight booleans, not credentials/private records. Initialization and run reject a missing existing OpenAI credential before initializing/claiming. No auto-initialization. Initialization repeated under the same approval/artifact is a read-only no-op; mismatched approvals/artifacts fail. One acknowledged permanent random invocation claim admits each exact fixture/history payload via CAS before dispatch. Concurrent/repeated processes, unknown claim/admission acknowledgements or closed scopes never authorize another provider attempt. Read-only export remains available after terminal outcomes.

## Timeout and evidence

**45-second request abort;60-minute overall bound.** V1 completed maximum latency was3.421seconds (p95 2.993seconds); there is no evidence its unknown outcome was a15-second timeout.45seconds provides operational allowance for a slower valid response without changing the token/attempt/cost cap.60minutes covers60 sequential requests at45seconds (45minutes) plus bounded backend operations; admission cannot authorize dispatch after the deadline. Unknown outcomes close the scope permanently. Backend acknowledgements remain fail-closed.

Operational timeout does **not** relax the unchanged quality rubric: p95 <=10seconds and maximum <=15seconds are still required to pass acceptance. Slower valid responses can be scored as latency failures rather than being prematurely aborted at15seconds.

Unknown receipts/export retain failure category (transport/timeout/model/incomplete/refusal/usage/schema/grounding), measured latency, bounded available raw synthetic output, observed token counters, valid measured cost separately, HTTP status and bounded provider model/status/incomplete reason/refusal evidence. No headers, credentials, unrestricted error objects or stack traces are exported. Wrong-model/out-of-envelope usage remains observed; no approved-rate measured cost is asserted for it. Failed exports use measured latency or null, never a false zero sentinel. Transport/lost acknowledgements can still leave evidence unavailable; there is no recovery/retry. The old V1 failure cause remains unrecoverable.

## Operator sequence after explicit new approval only

Use the existing supported runtime environment, preserving credentials in memory. Transfer exactly this file to `/tmp/pdl-help-evaluator-v2.cjs` and verify the SHA above. Supply one unique newly approved ID; never the V1 ID. No commands below have been executed against a live backend.

```sh
sha256sum /tmp/pdl-help-evaluator-v2.cjs
node /tmp/pdl-help-evaluator-v2.cjs
node /tmp/pdl-help-evaluator-v2.cjs --inspect '<NEW_OWNER_APPROVAL_ID>'
node /tmp/pdl-help-evaluator-v2.cjs --initialize-new-approved '<NEW_OWNER_APPROVAL_ID>'
node /tmp/pdl-help-evaluator-v2.cjs --run-new-approved '<NEW_OWNER_APPROVAL_ID>'
node /tmp/pdl-help-evaluator-v2.cjs --export '<NEW_OWNER_APPROVAL_ID>'
```

Proceed to initialization only when read-only inspection confirms the expected previous closed V1, absent V2, valid existing backend and available existing provider credential. If inspection detects an existing V2, do not initialize a replacement; inspect/export its existing scope. Initialization with lost output permits inspection, not reset. A run with lost output permits export, never another paid invocation. One explicit approval covers this bounded sequence; no separate build/setup approval is needed.

## Source evidence and limits

`help-evaluation-v2.test.js` uses synthetic REST/provider functions only. It tests the actual existing assistant CAS writer and legacy snapshot writer, V1 preservation, unrelated scalar/record preservation, stale/interleaved revisions, canonical JSONB acknowledgements, exact payload/history admission, concurrent runners60total/replay0, unknown acknowledgements0calls, rejected missing/open/bad-hash/bad-claim V1 and old approval reuse, late dispatch0calls, all failure categories, timeout45seconds and bounded failure export.

The **exact standalone bundle**, rather than only source modules, is tested through inspect/init/run/export/repeated submission with60 synthetic provider responses and through a failed response/export/replay. Missing credential blocks initialization; repeated initialization does not bump revision. Embedded V2 source hashes match tracked files. Default execution prints zero-call metadata without accessing environment/backend. Source-only CI/review prove engineering contracts, not deployed backend permissions or model quality. Existing deployed backend/CAS/writer evidence from V1 remains applicable; the artifact additionally checks the live snapshot during read-only preflight before any approved write. A failed preflight stops safely without requesting changed permissions or building another runner.
