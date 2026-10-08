# Forged Built assistant pilot

Project assistant access is restricted to company ID `21c12cd3-4822-4b1e-94e8-beca44efc0b7`, as specified in the owner's verified tenant instruction. Company names, request bodies, tenant headers and environment flags cannot add a company to the pilot. The shared policy fails closed for absent or nonmatching IDs.

The server authenticates the current tenant and denies every `/api/assistant` and `/api/projects/:id/assistant` route namespace outside the pilot before interpretation, legacy suggestions, context, preview, confirmation, budget reservation or provider dispatch. Both assistant handlers also enforce the policy independently. Previously issued confirmation tokens cannot grant access to another tenant. Unknown assistant subroutes are covered.

The launcher is hidden outside the pilot. The UI checks eligibility before each assistant request; a missing policy asset also hides access. Existing Forged Built owner/admin/project-manager roles, active sessions, project scopes, crew scopes and scheduling permissions still apply. Field staff gain no assistant access. Ordinary scheduling, project notes and daily reports retain their existing permissions.

This changes no company settings, timezone, subscription, model, budget, ledger, database schema or grants. No production records are needed for tests. Regression coverage uses synthetic records (including the pilot ID), mocked AI and isolated local browsers.

Release coordination: the parent owns merge/deploy and recovery. Deploy this small change separately from unrelated fixes, then verify authenticated read-only assistant context succeeds for an existing authorized pilot actor and is denied for an existing non-pilot actor. Existing pages loaded before deployment may retain the old launcher until refresh, but the deployed server denies their requests. The global AI flag alone disables only AI interpretation; it does not enforce the tenant restriction on deterministic preview/Confirm.
