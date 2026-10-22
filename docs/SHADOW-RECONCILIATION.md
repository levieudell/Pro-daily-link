# Shadow repository reconciliation and primary cutover

This is the controlling production runbook for moving both Pro Daily Link repositories from `shadow` to `primary`. It proves parity between the runtime-local mirror, the legacy Supabase snapshot, and the transactional repository, then keeps writes fenced through Render's zero-downtime deployments. The reconciler is read-only: it never copies, repairs, restores, deletes, or changes a repository mode.

`LAUNCH-RELIABILITY.md` is the release checklist. `DATA-RECOVERY.md` governs backup and restore evidence. This file controls the live cutover, abort, and rollback sequence. If another document is shorter or ambiguous, this file wins.

## Safety invariants

- Primary is never automatic. A timer, deploy hook, health check, successful test, successful reconciliation, or automation must not change either repository mode.
- A production full run is valid only from an ordinary SSH session attached to the single live production Render web-service instance. Never use `render ssh --ephemeral`, CI, a preview service, a local checkout, or a one-off container.
- Full cutover evidence requires `PDL_TRANSACTIONAL_DB=shadow`, `PDL_PLATFORM_TRANSACTIONAL_DB=shadow`, `PDL_MAINTENANCE_MODE=1`, and a verified instance-local maintenance fence.
- Every production reconciliation, including a scoped diagnostic, requires `PDL_PRODUCTION_SUPABASE_PROJECT_REF` to be the exact 20-character project reference in `SUPABASE_URL`. A missing, custom, or mismatched target is rejected before any provider read; evidence contains only an opaque target digest.
- The maintenance fence must cover HTTP mutations and the tenant/platform persistence boundaries. A UI banner or request-routing convention is not a fence.
- Render must have exactly one steady-state production instance for the evidence window. Prove this from Render's control plane, not from inside the container. A process cannot prove that no sibling instance exists.
- Evidence is bound to an exact release SHA, Render service ID, Render instance ID, and Supabase target fingerprint. Reconcile one release and deploy that same release.
- A full production `--all` run must write a new absolute evidence path. Scoped diagnostics may omit `--evidence`, but they never authorize cutover.
- Keep credentials in protected Render environment variables. Never print the environment, paste a key into a command, or copy secrets into evidence.
- Any mismatch, provider ambiguity, timeout, interrupted run, unexpected instance, stale backup, missing object, failed drill, or unreviewed high/critical security finding blocks cutover.

## Required evidence packet

Before opening the maintenance window, create a dated change record. It is not complete and cannot authorize primary until it contains:

- exact release SHA and pull request;
- Render workspace, service ID, current deploy ID, current instance count, current instance ID, and current repository/env values;
- the named operator, reviewer/approver, rollback owner, on-call recipient, start/end window, and incident channel;
- test-suite, dependency/secret/security scan, migration/privilege, disposable deletion acceptance, concurrency, and load-test results;
- fresh pre-cutover tenant and platform backup set names, independently recorded manifest SHA-256 values, off-host copy location, and verification result;
- isolated tenant and platform restore-drill evidence;
- Sentry verification event ID and delivered-alert evidence;
- Resend delivered-message ID and Stripe test event/webhook delivery IDs; and
- both full reconciliation evidence files and their independently recomputed SHA-256 values.

Do not store secrets, private data, raw snapshots, Storage object keys, or customer content in this record.

## Gate 1: qualify the exact release before production

Run from a clean checkout of the exact candidate SHA:

```powershell
npm ci
npm run check
npm test
npm run security:scan
npm audit --omit=dev
npm run test:shadow-reconciliation
```

Acceptance requires every command to exit `0`; no unresolved high/critical dependency, secret, or security finding; and protected `main` requiring the pull-request path plus passing checks. The solo-founder branch policy does not require another person's approval, but it does not permit direct pushes, failed checks, or administrator bypass.

Run the real database and recovery acceptance outside production:

1. Apply every migration through the current final migration to a newly created, empty, explicitly disposable Supabase branch/project.
2. Run `npm run test:deletion-db` in its documented destructive acceptance mode and retain its manifest/result evidence. Require cleanup verification and zero synthetic rows before destroying the target.
3. Restore one current tenant set and one current platform set into an isolated Supabase project plus isolated private Storage, exercise the journeys listed in `DATA-RECOVERY.md`, retain dated evidence, then destroy the isolated target.
4. Run the stale-write test against an approved synthetic tenant only:

```text
node database/concurrency-test.js --supabase-company=<synthetic-tenant-database-uuid>
```

Exactly one concurrent writer must commit, the stale writer must be rejected, the original synthetic state must be restored, and the command must exit `0`.

5. Run the public read load gate from an operator workstation:

```powershell
$env:PDL_LOAD_TARGET = 'https://app.prodailylink.com'
$env:PDL_LOAD_REQUESTS = '200'
$env:PDL_LOAD_CONCURRENCY = '20'
npm run test:load
Remove-Item Env:PDL_LOAD_TARGET,Env:PDL_LOAD_REQUESTS,Env:PDL_LOAD_CONCURRENCY
```

Require 200 completed requests, zero failures for the cutover gate, no unexpected Render restart or memory/CPU saturation, and the script's latency threshold to pass. Retain output and the matching Render metrics window. A local mocked test is not concurrency, load, or restore evidence.

## Gate 2: qualify production services

While both repositories remain `shadow`, deploy the exact candidate SHA without changing modes. Wait for Render to report the deploy live, then confirm recent logs contain no startup, shadow-write, database, or Storage failures.

The Render CLI examples below are non-secret. First confirm the signed-in identity and selected workspace, then substitute the recorded service ID and 40-character candidate SHA:

```text
render whoami --output json
render workspace current --output json
render deploys create <render-service-id> --commit <candidate-release-sha> --wait --confirm -o json
render deploys list <render-service-id> -o json --confirm
render logs -r <render-service-id> -o json
render ssh <render-service-id>
```

Use ordinary `render ssh`. Never add `--ephemeral`: an ephemeral shell is isolated from the live process and cannot prove its runtime-local state. If the installed CLI command surface differs, inspect `render help <command>` and record the actual supported command; do not guess or silently fall back to a detached environment.

From an ordinary SSH session on the live service, run:

```text
curl --fail --silent --show-error https://app.prodailylink.com/api/health/live
npm run services:verify
npm run monitor:verify
```

Acceptance:

- liveness returns HTTP `200` with `ok: true` and `kind: "liveness"`;
- the service verification finds the live Stripe prices and enabled production webhook endpoint, and can reach Resend without exposing credentials;
- the controlled Sentry event is visible in the production Sentry project with `monitoring_verification=true`; and
- the configured Sentry alert actually reaches the named on-call person. A successful SDK flush without a received alert is insufficient.

Record the owner's approval of the permanent monitor recipient and recurring controlled test message, set `PDL_MONITOR_EMAIL_TO` only in the protected `production-provider-readiness` GitHub environment, and manually dispatch `.github/workflows/provider-readiness.yml` from `main` for the initial acceptance run. The environment must have no required reviewers or wait timer, administrator bypass disabled, and deployment branches set to **Protected branches only** while `main` remains protected. The initial run and every six-hour scheduled run must start without per-run manual approval. Never place `PDL_MONITOR_EMAIL_TO`, `RESEND_MONITOR_API_KEY`, `STRIPE_MONITOR_KEY`, `SENTRY_MONITOR_AUTH_TOKEN`, or the provider attestation private key in Render, and never run the active readiness publisher from Render.

Require the workflow to finish green and publish a fresh signed provider-readiness attestation. Verify the message is `Delivered` in Resend and in the recipient inbox, Reply-To is `support@prodailylink.com`, and the resulting `/api/health` provider checks match the exact Render public target configuration. Keep the permanent monitor recipient only in the protected GitHub environment.

In Stripe test mode, complete the documented synthetic checkout/webhook lifecycle. Require the expected test event, a `2xx` delivery to `/api/billing/webhook`, correct local subscription state, safe replay/idempotency, and no production charge. In live mode, only inspect the enabled endpoint, recent legitimate deliveries, and failure alert routing; do not create a live charge for this gate.

Finally, verify `/api/health` reports database, email, billing webhook, monitoring, and verified-backup indicators configured. It may remain non-ready while repository modes are `shadow`; `/api/health/live` is the deploy liveness check until primary mode.

## Gate 3: create independent backups

Follow `DATA-RECOVERY.md` exactly. Before the maintenance fence:

1. export and verify one complete legacy-authority portable set for every eligible tenant, including every referenced private Storage object;
2. run a platform-only diagnostic; if it reconciles, create a provisional platform portable set, then refresh it under the fence after both full passes;
3. transfer each complete set to the approved encrypted off-Render destination;
4. independently recompute `manifest.json` SHA-256 after transfer and compare it with both the sidecar and the separately recorded value; and
5. protect the copied bytes from overwrite/deletion with provider version history or object lock and restrict access to the recovery operators.

A Render-local file, a database-only provider backup, an adjacent checksum by itself, or a mutable copy that was not rehashed after transfer does not satisfy this gate. Supabase PITR is an additional layer; it does not include Storage objects.

## Gate 4: prove one active Render instance

Immediately before fencing writes, use Render's Dashboard, API, or connected Render metrics—not the app container—to capture:

- manual instance count configured as `1`;
- active instance count exactly `1` for the settled deploy;
- the production service ID and live deploy SHA; and
- no deploy, autoscaling operation, restart, or preview instance in progress.

Save a timestamped screenshot or structured control-plane response in the evidence packet. Wait until a zero-downtime deploy has fully retired the old instance before capturing the proof. Repeat this check after the maintenance-shadow deploy, after the primary deploy, and after writes are reopened. If the count is missing, greater than one, or changing, stop.

## Gate 5: exercise shadow writes before the fence

While both modes are still `shadow` and before maintenance begins:

1. make one small reversible mutation in an approved synthetic tenant through the deployed application;
2. make one small reversible back-office/platform mutation;
3. read both back through a fresh request;
4. confirm no shadow-write error in Render logs or Sentry; and
5. reverse the business values through normal application actions and wait for all acknowledged writes to settle.

Do not run a write canary between the two final reconciliation passes. Both final passes run under the verified fence.

## Gate 6: establish a continuous write fence

The sequence uses a transition-opened instance-local artifact for the currently serving instance and `PDL_MAINTENANCE_MODE=1` for every new instance. The transition artifact must block writes immediately even though the outgoing process started with maintenance mode off. This closes the zero-downtime handoff gap.

1. On the single current live instance, open and verify the local fence:

```text
node database/maintenance-lock.js open --apply --transition --expected-service-id "$RENDER_SERVICE_ID" --expected-instance-id "$RENDER_INSTANCE_ID" --expected-release-sha "$RENDER_GIT_COMMIT"
node database/maintenance-lock.js status --expected-service-id "$RENDER_SERVICE_ID" --expected-instance-id "$RENDER_INSTANCE_ID"
```

Require the open result and status to report the exact service, instance, and release identity, `verified: true`, and `enforced: true`; record the returned digest. Confirm a harmless authenticated mutation returns HTTP `503` with `code: "MAINTENANCE_READ_ONLY"`; confirm GET/HEAD and `/api/health/live` still work. Do not change Render configuration or start the deploy unless this proof passes. Do not use customer data for the probe.

2. In Render, set `PDL_MAINTENANCE_MODE=1` while leaving both repository modes `shadow`, and deploy the exact same candidate SHA. During the overlap, the old instance is protected by its local artifact and the new instance by the environment fence. Do not close or delete the outgoing artifact during this deployment.
3. Wait for the deploy to be live and the old instance to retire. Repeat the external exactly-one-instance proof, liveness check, release-SHA check, and log review.
4. In a new ordinary SSH session on the new live instance, use the non-transition open command below, then verify status. The fence identity must match this new `RENDER_INSTANCE_ID`, and both commands must report `verified: true` and `enforced: true`:

```text
node database/maintenance-lock.js open --apply --expected-service-id "$RENDER_SERVICE_ID" --expected-instance-id "$RENDER_INSTANCE_ID"
node database/maintenance-lock.js status --expected-service-id "$RENDER_SERVICE_ID" --expected-instance-id "$RENDER_INSTANCE_ID"
```

`PDL_MAINTENANCE_MODE=1` plus a verified local fence are both required for the full reconciler. A corrupt, missing, wrong-instance, or wrong-release fence fails closed.

If maintenance must be cancelled **before** the environment fence is deployed, do not close or delete the outgoing transition artifact. Production intentionally rejects closing an instance-local artifact while `PDL_MAINTENANCE_MODE` is off, because doing so would reopen a write gap. Leave both repositories in `shadow`, leave the Render maintenance variable off, and redeploy the exact same reviewed SHA. The outgoing instance stays fenced until Render replaces and retires it; the fresh instance starts without the ephemeral artifact and resumes writes. Prove the fresh instance identity, exact SHA, liveness, one settled active instance, normal synthetic mutation behavior, and absence of persistence errors before declaring the abort complete.

If maintenance is cancelled **after** `PDL_MAINTENANCE_MODE=1` is live but before primary mode, leave both repositories `shadow`, set maintenance mode back to `off`, and deploy the same reviewed SHA. The old instance remains fenced until the new shadow instance takes traffic. Verify liveness, one active instance, and normal synthetic mutation behavior before declaring the abort complete.

## Gate 7: run scoped diagnostics

Scoped diagnostics are optional troubleshooting tools. They are read-only and may omit evidence and the maintenance fence, but must still run on the actual production instance in the applicable `shadow` mode:

```text
node database/reconcile-shadow.js --company-id <tenant-database-uuid> --expected-service-id "$RENDER_SERVICE_ID" --expected-instance-id "$RENDER_INSTANCE_ID" --max-samples 8 --stable-samples 3 --interval-ms 1000 --request-timeout-ms 10000 --capture-timeout-ms 120000

node database/reconcile-shadow.js --platform-only --expected-service-id "$RENDER_SERVICE_ID" --expected-instance-id "$RENDER_INSTANCE_ID" --max-samples 8 --stable-samples 3 --interval-ms 1000 --request-timeout-ms 10000 --capture-timeout-ms 120000
```

Any drift, missing source, integrity failure, timeout, or inconclusive result stops the cutover. Preserve the sanitized output and investigate under the incident/recovery runbooks. Never copy data merely to make hashes agree.

## Gate 8: bind the expected tenant population

The three compared stores cannot prove that all three forgot the same tenant. Build the expected-population manifest from the independently retained, verified backup/tenant inventory—not from runtime files, the legacy `companies` table, or the transactional repository being compared.

Prepare a protected JSON input containing only the exact eligible database tenant UUIDs, for example `['uuid-1','uuid-2']`. Exclude the platform namespace, connector-only records, archived duplicates, and completed deletion tombstones under the same reviewed eligibility policy used by the backup register. Have a second person compare the UUID count to the backup inventory before hashing it.

On the fenced production instance, generate the opaque manifest without printing the source UUIDs:

```text
node -e 'const fs=require("fs"),{opaqueTenantRef}=require("./database/shadow-reconciliation");const src=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;if(!Array.isArray(src)||src.length<1||src.length>10000||src.some(v=>!uuid.test(String(v)))||new Set(src.map(v=>String(v).toLowerCase())).size!==src.length)throw Error("invalid independent tenant inventory");const tenantRefs=src.map(v=>opaqueTenantRef(String(v).toLowerCase())).sort();const out={schema:"pdl-shadow-expected-population/v1",tenantCount:tenantRefs.length,tenantRefs};fs.writeFileSync(process.argv[2],JSON.stringify(out,null,2)+"\n",{flag:"wx",mode:0o600});' /secure/independent-tenant-uuids.json /tmp/pdl-expected-population.json

sha256sum /tmp/pdl-expected-population.json
```

Record the 64-character lowercase SHA-256 outside Render and have the reviewer compare the manifest count with the independent inventory. The manifest must be a regular, non-symlink file no larger than 2 MiB with exactly:

- `schema: "pdl-shadow-expected-population/v1"`;
- `tenantCount` from 1 through 10,000; and
- the same number of unique, strictly sorted, lowercase 24-hex opaque `tenantRefs`.

Pass both the absolute manifest path and the independently recorded digest to every full run. A missing, changed, malformed, empty, duplicate, unsorted, or mismatched population file blocks cutover.

Set a shell variable from the independently retained record; do not derive it from the adjacent file at run time:

```text
export EXPECTED_POPULATION_SHA256='replace-with-the-recorded-64-character-lowercase-sha256'
```

## Gate 9: initialize only missing transactional tenants

Migration `017_transactional_legacy_backfill.sql` and this gate exist only to populate transactional rows that are absent. They are not a repair tool. Preview is read-only. Both repositories must remain in `shadow`; apply additionally requires the exact production Supabase project ref, current Render service and instance, exact release SHA, the verified maintenance fence from Gate 6, and the independently retained population manifest and digest from Gate 8. It rechecks the fence before and after every dispatched mutation.

Run preview first with a new evidence path whose real parent directory already exists and is writable. The command rejects a symlinked evidence directory, preflights durable file creation before provider reads or mutations, and never overwrites an evidence file or checksum:

```text
npm run migrate:transactional:preview -- --evidence /tmp/pdl-transactional-backfill-preview.json --production-target "$PDL_PRODUCTION_SUPABASE_PROJECT_REF" --expected-service-id "$RENDER_SERVICE_ID" --expected-instance-id "$RENDER_INSTANCE_ID" --expected-population-manifest /tmp/pdl-expected-population.json --expected-population-sha256 "$EXPECTED_POPULATION_SHA256" --request-timeout-ms 10000 --capture-timeout-ms 120000
```

Preview qualifies only when it exits `0`, reports schema `pdl-transactional-backfill/v1`, status `ready`, `writesPerformed: false`, no malformed, missing, unexpected, or divergent population, and `initializeTenants + exactTenants` equals the independent manifest count. Connector-only, archived, deleted, tombstoned, platform, or malformed rows are never eligible. Have the operator and reviewer compare the sanitized plan and evidence checksum before apply.

If—and only if—the preview is exact, run apply with a second unused evidence path and the literal confirmation phrase:

```text
npm run migrate:transactional:apply -- --evidence /tmp/pdl-transactional-backfill-apply.json --production-target "$PDL_PRODUCTION_SUPABASE_PROJECT_REF" --expected-service-id "$RENDER_SERVICE_ID" --expected-instance-id "$RENDER_INSTANCE_ID" --expected-population-manifest /tmp/pdl-expected-population.json --expected-population-sha256 "$EXPECTED_POPULATION_SHA256" --confirm-population-sha256 "$EXPECTED_POPULATION_SHA256" --confirm-action "INITIALIZE ONLY MISSING TRANSACTIONAL TENANTS" --request-timeout-ms 10000 --capture-timeout-ms 120000
```

Apply qualifies only when it exits `0`, reports status `verified`, records each newly initialized tenant at revision `0`, reports every pre-existing exact tenant as untouched, and finishes with two stable full catalogs plus two exact reads of every initialized tenant. The initializer locks and rechecks the legacy source in the same database transaction as the insert. It never writes `companies.data`, and it refuses any existing transactional drift instead of overwriting it.

Run preview again with a third unused evidence path. It must report `initializeTenants: 0`, `exactTenants` equal to the manifest count, and no drift. Copy every JSON evidence file and `.sha256` sidecar off Render, independently rehash it, and retain it with the cutover packet. A timeout, interrupt, changed fence, malformed provider payload, or ambiguous dispatch produces non-qualifying or outcome-unknown evidence. Keep writes fenced; do not blindly retry. Reconcile the tenant and evidence under the incident and recovery runbooks first.

## Gate 10: run two consecutive full reconciliations

Choose two new absolute paths on the attached instance. The command verifies loopback `http://127.0.0.1:$PORT/api/health/live`, exact Render service/instance identity, both shadow modes, the environment fence, and the local fence before scanning.

```text
npm run reconcile:shadow -- --all --evidence /tmp/pdl-shadow-pass-1.json --expected-service-id "$RENDER_SERVICE_ID" --expected-instance-id "$RENDER_INSTANCE_ID" --expected-population-manifest /tmp/pdl-expected-population.json --expected-population-sha256 "$EXPECTED_POPULATION_SHA256" --max-samples 8 --stable-samples 3 --interval-ms 1000 --request-timeout-ms 10000 --capture-timeout-ms 120000

npm run reconcile:shadow -- --all --evidence /tmp/pdl-shadow-pass-2.json --expected-service-id "$RENDER_SERVICE_ID" --expected-instance-id "$RENDER_INSTANCE_ID" --expected-population-manifest /tmp/pdl-expected-population.json --expected-population-sha256 "$EXPECTED_POPULATION_SHA256" --max-samples 8 --stable-samples 3 --interval-ms 1000 --request-timeout-ms 10000 --capture-timeout-ms 120000
```

Each path and its `.sha256` sidecar must not exist before the run. The two passes must be consecutive; any scoped, failed, interrupted, partial, or inconclusive run between them resets the pair.

Each pass qualifies only when:

- exit code is `0`;
- schema is `pdl-shadow-reconciliation/v1` and `writesPerformed` is `false`;
- release SHA, service ID, instance ID, Supabase target fingerprint, loopback liveness, and maintenance-fence identity match the approved evidence packet;
- expected-population schema, digest, count, and opaque tenant membership match the independently retained manifest;
- overall status and every tenant/platform result are stable and reconciled;
- legacy-cloud and transactional hashes and exact counts agree, and every present runtime-local snapshot agrees with both;
- the eligible population and membership scan are complete with no orphan, missing required remote source, corruption, timeout, skip, or inconclusive result; and
- the evidence and sidecar were written exclusively and verified.

The stability/evidence record must include the active population and excluded legacy/transactional counts (archived, connector, deleted, and legacy platform rows) without exposing tenant UUIDs. `EXPECTED_POPULATION_REQUIRED`, `EXPECTED_POPULATION_INVALID`, or `EXPECTED_POPULATION_SHA_MISMATCH` means the independent population gate failed. `LOCAL_SOURCE_INVALID`, `LOCAL_SOURCE_ID_MISMATCH`, `PROVIDER_PAYLOAD_INVALID`, `PROVIDER_TIMEOUT`, `CAPTURE_TIMEOUT`, or `MAINTENANCE_FENCE_CHANGED` means the run is inconclusive and cannot produce qualifying evidence. Missing/unexpected members may appear only as opaque tenant references.

Copy both files and sidecars out of Render immediately. Independently rehash each JSON file at the destination, compare with its sidecar and CLI-reported hash, then protect it from overwrite. Do not edit or reformat evidence after hashing.

While the fence remains active, export and verify a fresh platform portable set from the just-reconciled transactional revision, copy/re-hash it at the independent destination, and replace the provisional set in the cutover evidence packet. Do not promote until this qualifying platform set is complete.

Exit meanings:

| Exit | Meaning | Action |
| --- | --- | --- |
| `0` | Requested scope is complete, stable, integrity-valid, and reconciled. | Retain evidence; continue only if every other gate passes. |
| `1` | Stable drift, missing source, count/hash mismatch, orphan, or integrity failure. | Block cutover and enter investigation/recovery. |
| `2` | Invalid/incomplete evidence: configuration, identity, fence, provider, timeout, malformed data, population scan, or stabilization failure. | Block cutover; fix the condition and restart the two-pass gate. |
| `130` | Interrupted. | Treat as no evidence; restart the two-pass gate. |

Any other non-zero exit blocks cutover. The mere presence of a JSON file is not success.

`--request-timeout-ms` bounds each provider request through response-body parsing. `--capture-timeout-ms` bounds one complete concurrent local/legacy/transactional/platform capture. `SIGINT`/`SIGTERM`, a capture timeout, or a failed sibling scan cancels outstanding work, writes no qualifying evidence, and resets the two-pass gate.

Immediately before writing each evidence file, the command re-verifies the local maintenance fence. Its digest, open time, identity, mode, and source must exactly match the values captured at the start; otherwise no evidence qualifies.

## Gate 11: human approval and primary deploy

The named operator and second reviewer inspect the complete evidence packet. Levi gives explicit approval only after every gate is green. Record that decision. Nothing in the application or reconciler may substitute for it.

Keep `PDL_MAINTENANCE_MODE=1`. In one reviewed Render configuration change, set:

```text
PDL_TRANSACTIONAL_DB=primary
PDL_PLATFORM_TRANSACTIONAL_DB=primary
PDL_MAINTENANCE_MODE=1
```

Deploy the exact reconciled SHA and wait for Render to report it live. During the handoff, the outgoing shadow instance is protected by environment plus local fences and the incoming primary instance by the environment fence.

Before any write is permitted:

1. externally prove exactly one active instance and the exact release SHA;
2. inspect Render logs for startup, repository-load, revision, database, and Storage errors;
3. require `GET /api/health/live` to return HTTP `200` liveness;
4. require `GET /api/health` to return HTTP `200`, both repositories `primary`, and database, email, billing webhook, monitoring, and verified backup indicators true;
5. perform read-only owner, field, back-office, tenant, and platform inspections; and
6. export new transactional-primary portable tenant sets plus a new platform set, transfer/re-hash them independently, and complete the required isolated restore drill while writes remain fenced.

Because no primary mutation can commit while the fence is active, failure in this section permits the pre-write abort below.

## Gate 12: reopen writes and run one canary

After explicit approval to reopen, keep both repositories `primary`, set `PDL_MAINTENANCE_MODE=off`, and deploy the same SHA. The outgoing primary instance remains fenced until the new instance takes traffic.

Then:

1. externally prove exactly one active instance and exact release SHA;
2. verify both health endpoints and logs;
3. make one controlled reversible mutation in an approved synthetic tenant, read it back, and verify its transactional revision advanced once;
4. make one controlled reversible platform mutation, read it back, and verify its platform revision advanced once;
5. confirm no Sentry event or Render error for either write; and
6. end the maintenance window only after normal traffic and monitoring remain healthy.

Treat the first attempted primary mutation as the point of no blind rollback.

## Abort and rollback decision table

| Condition | Required response |
| --- | --- |
| Any prerequisite, backup, restore, concurrency, load, monitoring, security, instance-count, fence, or reconciliation gate fails | Do not change modes. Keep writes fenced while preserving evidence and investigating. If resuming shadow service is safe, use the documented maintenance-off shadow deploy. |
| Primary deploy fails **and it is proven no primary write could commit** | Keep maintenance active, restore both reviewed modes to `shadow`, deploy the same SHA, verify liveness/readiness as appropriate, then reopen writes only after review. A future attempt starts the two-pass reconciliation gate again. |
| A primary write may have committed, its response is ambiguous, or the fence status is uncertain | Freeze mutations. Do **not** switch to `shadow` or `off`. Preserve logs, request IDs, timestamps, repository revisions/hashes, and provider evidence. Follow `INCIDENT-RESPONSE.md`, `DATA-RECOVERY.md`, and the repository-specific recovery runbook. Resume or roll back only after authority is proven and parity is independently reviewed. |
| Reconciler copies differ | Do not pick the newest timestamp, largest count, or visually plausible copy. Hashes prove difference, not correctness. Determine authority from committed revisions, acknowledged requests, immutable backups, and CAS recovery evidence. |
| Render has more than one active instance or cannot prove the count | Keep writes fenced and stop. Do not waive the local-snapshot or instance-bound evidence requirement. |
| Sentry/Resend/Stripe verification or alert routing fails | Keep writes fenced; fix and repeat the service gate. Provider configuration without observed delivery is not evidence. |

Keep the legacy snapshots read-only through the approved rollback/retention window. Retire them only under a separate reviewed retention plan after multiple successful backups and restore drills.
