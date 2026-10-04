# Subcontractor directory / alert mismatch

Local branch `codex/subcontractor-alert-archive`, based on live main `7b4047c731113c84710701010cc7e29d05f71fb8`. User subsequently explicitly approved publishing this fix together with the automatic date-selection fix. No production record changes are included.

Confirmed source defect: app.js archive directory wrapper removes a card when `sub.archivedAt` or `sub.status === 'Archived'`. server.js compliance action-center wrapper iterates all stored subcontractors, without either exclusion. An archived company missing requirements remains an open alert even though it has no active directory card. The synthetic pre-fix fixture reproduces seven alerts for seven archived companies; patched fixture produces zero compliance alerts.

Minimal local fix: a server archive predicate matching the existing directory exclusion, applied to compliance alert derivation and automatic reminder iteration. Active/restored companies still generate valid alerts; archived records, compliance history and project links are preserved. Tenant routing and role scopes are unchanged. Team-only mobile CSS keeps all four destinations visible in a two-column grid and compacts the header without changing permissions.

Limits: actual production archive flags/record IDs were not inspected. Screenshots were described by the parent; previous supported Library transfer failed on Windows metadata support, so no local pixel inspection is claimed. Repeated display names do not prove duplicate alerts: generator creates `compliance-<sub.id>` once per stored row. Distinct same-name records, legacy duplicates or malformed same-ID records cannot be distinguished from screenshots. Names that look like QA labels do not authorize deletion.

Role/tenant review: readDb uses the request's database context and auth checks session company; project-manager directory returns company subcontractors while action-center results are restricted to assigned project IDs. Compliance items have no projectId and are consequently excluded for project managers, a separate preexisting behavior; this patch does not widen permissions. The observed active/archive inconsistency is directly reproducible without changing scopes.

Do not query live `/api/action-center` as a harmless read: its GET handler runs workspace preparation, automatic compliance reminders when configured, and writes changed state. No production API/provider session was used here, no messages sent, and no real customer data copied.

Validation: synthetic VM fixtures use actual server requirement/alert/reminder functions, reproduce pre-fix behavior, check timestamp/status archives, restored/active/fully compliant companies, counts, distinct-ID same-name records, immutable records and zero reminder calls for archives. Full 33-command test aggregate, syntax and diff checks passed. Actual phone rendering remains unverified.

Production source: https://github.com/levieudell/Pro-daily-link/blob/7b4047c731113c84710701010cc7e29d05f71fb8/app.js#L1030 and https://github.com/levieudell/Pro-daily-link/blob/7b4047c731113c84710701010cc7e29d05f71fb8/server.js#L311.
