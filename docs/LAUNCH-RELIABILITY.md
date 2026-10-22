# Launch reliability gates

This is the release-blocking checklist. [`SHADOW-RECONCILIATION.md`](SHADOW-RECONCILIATION.md) is the controlling live operator procedure for maintenance fencing, reconciliation, primary promotion, abort, and rollback. [`DATA-RECOVERY.md`](DATA-RECOVERY.md) controls backup and restore evidence. A shorter note or successful deploy does not override either runbook.

## Release is blocked unless

- the exact release SHA passes `npm ci`, `npm run check`, `npm test`, `npm run security:scan`, `npm audit --omit=dev`, and `npm run test:shadow-reconciliation`;
- every database migration and its privilege/integrity evidence pass in order;
- protected `main` requires the pull-request path and required passing checks, with administrator bypass disabled; the solo-founder policy requires zero additional approvers rather than blocking on a second person;
- real stale-write/concurrency acceptance passes against an approved synthetic tenant, and destructive deletion acceptance passes only on an empty disposable database with verified zero-row cleanup;
- the public read load gate passes and matching Render CPU, memory, restart, and instance metrics are retained;
- a fresh complete portable backup exists for every eligible tenant and for platform state, includes every referenced private Storage object, has an independently retained manifest SHA-256, is rehashed after transfer, and is protected from overwrite at an approved off-Render destination;
- isolated tenant and platform restore drills pass and their targets are destroyed afterward;
- production liveness and full service health are understood independently: `/api/health/live` proves only process liveness, while `/api/health` must be HTTP `200` with both repositories `primary` and all required service indicators true before writes reopen; `requirements.verifiedBackup` is backed by the exact-population tenant-plus-platform attestation in `DATA-RECOVERY.md`, never the narrower same-provider tenant receipt;
- the independent provider monitor retrieves a controlled scrubbed Sentry event from the production project, confirms a controlled Resend message is delivered, and publishes a fresh signed target-bound receipt; the named on-call alert is exercised separately;
- Stripe key, all standard/founder/setup prices, exact webhook inventory/events, both dedicated portal configurations, test checkout/webhook/replay monitoring, and Resend Reply-To pass without a live charge;
- the webhook inventory and separate standard/founder portal configurations pass [`STRIPE-BILLING-OPERATIONS.md`](STRIPE-BILLING-OPERATIONS.md), and founder 90/60/30-day reminder visibility is exercised without a live charge;
- Render externally proves exactly one steady-state production instance for reconciliation and every cutover stage;
- two consecutive, complete, instance-bound `--all` reconciliations run under the verified maintenance fence, exit `0`, and have separately retained/rehashed evidence; and
- privacy, export, deletion, retention, incident-response, and tenant/platform recovery procedures are current and owned.

## Required order

1. Merge the reviewed candidate and record its immutable SHA. Do not change repository modes.
2. Complete automated, security, migration, disposable database, concurrency, load, provider-monitoring, backup, and isolated restore gates.
3. Deploy that SHA with both repositories still `shadow`; verify liveness, logs, shadow-write health, Sentry, Resend, Stripe, backups, and external instance count.
4. Exercise one reversible tenant and one reversible platform write in approved synthetic data, read them back, reverse them, and let shadow writes settle.
5. Follow `SHADOW-RECONCILIATION.md` to establish the local plus environment write fence across Render's zero-downtime handoff.
6. On the single fenced shadow instance, run scoped diagnostics if useful, then the two consecutive full `--all` passes with new evidence paths, expected service/instance IDs, loopback liveness, and exact population checks.
7. Have the named second reviewer inspect the complete evidence packet. Primary mode requires Levi's explicit, recorded approval; no script or health check may promote it.
8. Keep maintenance enabled, change both repository modes to `primary`, and deploy the same SHA. Verify exactly one instance, logs, liveness, full readiness, and read-only tenant/platform journeys.
9. While still fenced, create fresh transactional-primary tenant and platform recovery sets, rehash them independently, and complete the required isolated restore drill.
10. With explicit approval, deploy the same SHA with both repositories still `primary` and maintenance mode off. Run one reversible synthetic tenant write and one reversible platform write and monitor them through fresh reads, revisions, Render logs, and Sentry.
11. Keep the legacy snapshots read-only through the reviewed rollback/retention window.

## Automatic stop conditions

Stop without changing modes when any test, backup, transfer hash, restore, provider delivery, alert, external instance proof, fence, identity, population, or reconciliation result is missing, failed, stale, interrupted, timed out, or ambiguous.

If primary mode is deployed but the fence proves no primary write could commit, return both modes to `shadow` under the active fence and redeploy the same SHA. If a primary write may have committed, do not switch to `shadow` or `off`; freeze mutations and follow the incident and recovery runbooks until authority and parity are independently proven.

Never treat mocked tests, static SQL inspection, a local/CI/ephemeral reconciliation, provider-only comparison, scoped diagnostic, one successful full pass, successful SDK flush without delivered alert, database-only backup, adjacent checksum without independent rehash, or cleanup-failed acceptance as launch evidence.
