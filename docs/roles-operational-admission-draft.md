# Roles operational continuation (source and synthetic only)

This continuation preserves PR113 at 3abb8ebd0667c6b074b1dd25fbf2aa6814a59147 and integrates inspected live main bdbdfe9a8b038d3dbc32327c58f5a529dbe71225, including merged PR106. PR114 annual billing and PR115 Help remain separate. No production account, grant, session, policy, key, setting, schema, migration, object or provider was changed. No merge or deployment is part of this work.

## Connected admitted workflows

The workspace now uses real scoped server choices and handlers for scheduling create/edit/remove/own acknowledgement; own full/partial-day leave and time review; time card create/correct/remove/submit/company clock/review/CSV; pay periods, summaries and saved payroll exports; daily create/edit/approve with per-person hours and measured/pending production; start/end workdays; and project notes/to-dos with completion and deadlines.

One-image Draft-report upload and scoped report photo viewing preserve the existing immutable storage reservation/byte hash/no-upsert/recovery contract. The report photo list resolves each exact descriptor-bound intent and rejects ambiguous identities; it never chooses a proof by photo ID alone. Owner reporting export capture/read/download and existing payroll ceilings are immutable operations, not new editable role flags. No notifications or public sharing are added.

Choices use each actual typed action gate and the original project/crew/member scope. They validate the same canonical source records as navigation and emit only finite ID/name/unit fields, never raw workspace state, financial estimates or a permissions dictionary. Existing role ceilings, grants, features, locks and owner/security/billing/pricing/tenant scope protections still apply. The fixed signed-in PM/admin/owner Assistant eligibility remains outside all editable flags; paused Assistant improvements are not imported.

All new UI actions show exact readback and require an unchecked explicit confirmation. Durable existing previews are used for time writers/review, daily/workdays, photos and owner exports. Manual schedule/notes/own-leave routes retain their existing validators. Their creates have original request-ID replay; non-idempotent edits/removals/acknowledgements require inspecting current records after an unknown result and never automatically replay.

Every read/action is fenced by the originating tenant/session/role, mount and load generation. Reads/downloads additionally bind the source tenant revision before releasing buffered data. A project change retires old note actions. Fresh revocation, same-role grant changes, slow responses and reversed project reads cannot reuse old choices or proofs. Successful saves remain successful if the following read fails. Same-page recovery retains the exact original request under the original identity; page-restart persistence remains unfinished.

## Activation boundary

The flag-off startup/auth/business path remains unchanged. Both dedicated and unbound atomic draft modes require an explicit HTTP localhost synthetic bridge. NODE_ENV=production always rejects, and omitting or changing NODE_ENV cannot admit a remote service. A dedicated mode accepts one canonical server-configured tenant UUID and rejects foreign/conflicting header/cookie/body hints before lookup or effects. API load/commit and queued-dispatch closures bind that same tenant.

The dedicated listener starts only after the actual SQL readiness protocol and canonical initialized tenant snapshot pass. The read-only SQL probe checks exact mandatory-revision and guarded-policy function bodies, PL/pgSQL/security-definer configuration, NULL-safe exact search_path, service-only execution privileges and forced RLS. Missing/changed functions, unsafe grants/configuration or snapshot corruption fail without a listener or legacy fallback. The SQL is source only and applied only to a fresh disposable database by the synthetic suite.

This prepares a reviewable process boundary; it does not authorize or implement production cutover. A single hostname or write-only fence is insufficient. Legacy hosts/scripts/service-role credentials can discover and read sessions or operate on JSON snapshots independently of atomic CAS. Selected-tenant private reads, credentials, writes and provider effects all need an enforceable reviewed drain/fence while other companies stay unchanged.

## Explicit unfinished requirements

A separate Office role profile and optional custom roles are unfinished. Stored Office values continue only as the existing Admin compatibility alias. That alias is not credited as completion. Policy management remains owner-only; Admin cannot create or change role policies.

Broader project/customer/team/subcontractor editing; company details/forms/templates/catalog; report flags/rates/deletion; estimates/changes/tickets/aggregates; broader files, guest/public links and provider workflows remain unavailable. The product states these limits. Existing normal app workflows require domain-by-domain admission before live activation.

The bounded policy/proof/photo retention limits, distributed first-confirmation coverage, authoritative tenant-and-attachment backup/isolated restore, rollback/migration packet, cross-host credential/private-read/write/provider fences and production operational acceptance remain release blockers. Those conditions cannot be satisfied by an environment variable. Actual production schema application, activation and permission changes require separately scoped action-time approval.

## Validation and review

The tracked suite uses real multiworker HTTP over fresh localhost PostgreSQL, exact guarded SQL, synthetic actors and private desktop/360px browsers. No real accounts, shared browser, production connection or paid provider calls are used. Browser fixtures block external traffic; foreign synthetic tenant snapshots and provider effects are checked unchanged. Evidence is emitted alongside the existing Roles editor browser artifacts.

The new operational regressions cover PM/field/legacy Office journeys, completion-only versus edit authority, partial-day leave, daily labor/production, original-byte photos and exact replay, owner exports, linked workdays/cards/payroll, double clicks, uncertain idempotent and non-idempotent outcomes, known-success/read-failure, revoked buffered downloads and reversed project/tenant responses. Final immutable source head, complete suite results, independent review and exact CI are recorded in the PR/checkpoint after they finish.

