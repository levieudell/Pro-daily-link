# Pro Daily Link back-office command center

The back office is an internal operating system for customer health, growth, onboarding, support, billing, content, AI usage, and audited customer access. It is deliberately separate from every contractor workspace.

## Roles and least privilege

| Role | Primary access |
|---|---|
| Platform owner | Every back-office capability, staff administration, destructive account operations |
| Customer success | Customer health, onboarding, support, own audited support sessions, read-only pipeline |
| Onboarding | Customer health and onboarding work orders |
| Support | Customer health, tickets/follow-ups, own audited support sessions |
| Billing | Customer/subscription context, revenue, audit trail |
| Engineering | Customer/support context, AI usage, audit trail, own audited support sessions |
| Sales | Customer context and full growth pipeline |
| Content | Help Center and Field Notes publishing |

The browser receives an allowlisted user DTO and server-issued capabilities. Navigation visibility is convenience only: every API route repeats authorization, unknown platform routes fail closed, tenant cookies never authorize platform APIs, and the legacy global platform key is refused in production.

Staff cannot change their own role or deactivate themselves. The final active platform owner cannot be demoted or deactivated. Deactivation revokes that person's active sessions immediately.

Account closure is platform-owner-only. Customer health shows requests that await review, active recovery holds, legal holds, retry-required attempts, and the hold end date. Starting, cancelling, and completing a closure each require a typed company-specific phrase. The back office never presents a customer request as already scheduled for automatic deletion and never claims that Stripe was stopped unless an operator records the verified billing disposition.

## Growth cockpit

Growth is outcome-focused rather than a vanity leaderboard. It provides:

- attributable leads from demo requests and account signups;
- funnel stages from New lead through Won or Lost;
- an owner, next action, due date, expected plan, and expected monthly revenue;
- searchable/filterable pipeline and overdue follow-up visibility;
- stage conversion, won monthly recurring revenue, first-response time, and follow-up reliability by owner;
- duplicate detection, idempotent creation, optimistic versions, and immutable history.

New demo requests create or link a growth opportunity only after their normalized attribution is captured. New workspaces link to their open opportunity and create the appropriate onboarding request in the same serialized platform operation.

## Customer support access

Support access is temporary (15–120 minutes), reason-required, and written to the audit trail. The server derives the actor from the signed-in platform session; it never trusts a browser-supplied actor. Non-owners can list and revoke only their own grants. Owners can administer all grants. Revoked and expired links cannot be reused.

## Data integrity and recovery

Back-office writes are serialized independently of tenant traffic. The optional PostgreSQL repository stores one revision atomically and uses compare-and-swap so a stale process receives `409 STALE_WRITE` instead of overwriting another staff member's work.

Enable it only through the staged `off` → `shadow` → `primary` procedure in `PLATFORM-REPOSITORY-CUTOVER.md`. Portable exports include referenced private storage objects and a SHA-256 manifest. Recovery requires manifest verification, an explicit expected revision, and a verified pre-restore export. It restores and re-download-verifies referenced private objects before committing the database, rolls storage back on a pre-commit failure, writes a dated evidence record, and clears sessions, reset/setup hashes, and temporary customer-access grants.

Customer/subscription mapping for the revenue console follows the same authority boundary. In tenant `primary` mode it reads only the compact transactional tenant directory; it never merges a stale Render file or legacy snapshot. Stripe's bounded network reads run outside the global platform mutation queue, and the operator's session and revenue permission are checked again before any totals are returned.

Production availability has separate liveness and operational-readiness contracts. Render uses `/api/health/live`; monitoring uses `/api/health`, which fails closed if either primary repository, Supabase, billing webhook, email, Sentry, or same-provider verified-snapshot freshness is unhealthy. Independent portable-copy and isolated-restore evidence stays on its dedicated monitor because the application must not pretend a provider round trip is disaster recovery. See `OPERATIONAL-HEALTH.md`.

## Operator acceptance checklist

1. Sign in separately as each staff role and confirm only its documented sections appear.
2. Attempt direct API access outside each role and confirm `403 platform_forbidden` without data.
3. Create, edit, advance, and close a synthetic growth opportunity; verify history and metrics after refresh.
4. Create and revoke a temporary support session; verify both actions in the audit trail and verify the revoked URL is dead.
5. Deactivate a synthetic staff member and confirm their existing session is rejected.
6. Run the focused back-office, security, repository, backup, and recovery suites before release.
7. In staging, run concurrent writes and reconcile the shadow repository before primary cutover.
8. Confirm `/api/health/live` returns `200` and `/api/health` reports every production requirement as `true`.
8. Create a synthetic account-closure request, start and cancel its hold, and confirm revoked sessions and links do not return. On an isolated disposable tenant only, advance the hold clock and verify private objects are removed before the repository tombstone is committed.

No test should send production email, create a Stripe charge, or modify a real customer tenant.
