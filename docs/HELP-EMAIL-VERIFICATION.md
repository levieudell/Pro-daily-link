# Disabled email integration verification

This follow-up preserves PR116 head e24aeaf575215b8cbc0a220b3224cdfd705698c7. It does not connect a sender, scheduler, or production database. The integration accepts only an explicitly fake provider and synthetic example.invalid recipients; delivery is disabled by default.

A unique draft reservation alone does not prevent two workers from dispatching it. The integration now persists an exclusive `sending` claim with a unique attempt ID through the existing tenant revision compare-and-swap before calling the fake provider. Conflicts stop dispatch. A crash or unknown outcome leaves a durable blocking record with no automatic retry or lease takeover.

Fresh eligibility checks cover membership, role, verified address, opt-in, completed setup steps, tenant-local day, and receipt ownership. Unsubscribe before dispatch cancels the claim. Unsubscribe during an already accepted attempt preserves the withdrawn preference and blocks future deliveries; it cannot recall an accepted delivery.

Local fake-provider tests exercise contention, restart, crash, lost response, and unsubscribe races. The dedicated CI workflow checks out the exact PR head and starts a disposable password-free PostgreSQL service. Independent Node processes exercise both the existing transactional repository and the actual `replace_tenant_records` RPC. The script refuses other database names, remote hosts, or password-bearing URLs. CI evidence is linked in the PR; a local missing-database skip is explicitly not a pass.

This evidence covers the transactional persistence paths. JSON-file storage has no proven cross-worker atomic claim and must not enable delivery. Real provider behavior, deployment configuration, deliverability, customer copy approval, and live activation remain separate gates.

The acceptance rubric and scorer prepare the proposed 60-attempt, $1 maximum synthetic model evaluation. They make no provider calls and do not grant permission. Paid evaluation remains paused until explicit owner approval is relayed.
