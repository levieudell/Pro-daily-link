# Project messages in the Roles successor

This source-only integration combines main `fa7c6985965e8dfe6f628414e6a535e216a1a972` (PR188) with frozen local Roles/event successor `177d7fbefaea34247fb0837ebddf33ec813db658`. Earlier event and Roles evidence remains historical evidence for its named source. This work does not change production accounts, permissions, settings, keys or data, and does not merge or deploy a release.

## Fixed current authority

Project messages remain outside all six editable role-capability families. In managed or auth-required operation, the finite `project-messages-access.js` module uses the current authenticated role, tenant, member and project/crew scope. It does not consult a typed capability mask, custom message flag or generic permission dictionary. Changing an editable family does not grant or revoke project-message access. Global session, account, tenant, deadline and current-authority protections still apply.

| Current role | Read and write boundary |
| --- | --- |
| Owner / Admin | Company project threads; broadcast to Project team or privately target a current company member. |
| Project Manager | Assigned project threads. A private recipient must belong to the PM's current assigned crew and must have the existing Field readable-project relationship to that same project. |
| Field / Foreman | Existing readable projects; Project team broadcasts and only that member's private messages/replies. Replies are attributed to the signed-in member. |
| Other roles; unauthenticated managed or auth-required request | No message authority. Platform, crew or arbitrary role-policy flags cannot broaden the fixed role set. |

The unmanaged auth-off local demo path preserves its existing Owner-shaped demo actor when no account, bearer or session cookie is supplied. Supplied credentials still require fresh authentication; invalid credentials cannot select that fallback. This legacy public demo behavior provides no authenticated privacy guarantee. Managed tenant operation requires authentication and uses the fresh current account, rather than the demo actor.

A PM broadcast intentionally reaches the **Project team**, including project participants outside the PM's private crew audience. The product therefore labels broadcasts “Project team.” The narrower private-recipient check remains mandatory for targeted PM messages; it does not redefine a project-wide broadcast as an assigned-crew broadcast.

Existing Field project visibility comes from the current tenant's assignments, workdays and report/member relationships. The existing `report.foreman === member.name` match remains part of that project visibility calculation. Historical message `senderName` supplies display attribution only. Messages introduce no new membership or cross-project access. The server returns closed `projectMessageAudiences` rows containing exactly `projectId`, `memberIds` and `allowBroadcast`. The UI uses those admitted audiences together with the fixed current role/project boundary; it cannot invent recipients from a cached roster or optional client flag.

## Finite routes, source and changes

`POST /api/projects/:id/messages` accepts only bounded message text and an optional canonical member ID. The server generates the ID, sender kind, sender name, sender/member attribution, timestamp and empty reader list. A Field/Foreman reply uses the signed-in member's own identity. Client-supplied authors, reader tags, tenant IDs or additional authority fields are rejected.

`POST /api/projects/:id/messages/read` accepts only the current project and an empty body. It appends the current reader tag only to currently visible messages from the opposite audience: office actors read Field replies; Field/Foreman actors read office broadcasts or their own private office messages. It cannot mark another member's private message as read.

The source graph has closed, bounded rows and canonical unique IDs with existing project/member references. Malformed or ambiguous rows require reconciliation. Historical sender names, nullable legacy office author IDs and reader receipts are evidence, rather than current authority. Legacy Office attribution may have a null legacy/demo author ID or a retained positive ID for a removed account. Authenticated new author attribution comes from the fresh account; the auth-off demo actor retains null attribution. Removing or renaming an office account does not erase or reinterpret its earlier authorship. Current role, crew, assignment or account changes do not rewrite message history.

Before persistence, the finite delta validator permits exactly one admitted new message or the admitted reader-tag additions. It rejects unrelated collection changes, historical message-body/author/audience changes and changes through other routes. Current authority is checked again through the shared tenant/session/revision/deadline fence. Readback projects message rows and reader tags to the current audience: private recipients and receipt tags outside a PM's current crew/project scope or another Field member's identity stay private.

These checks bind current numeric project/member references and fresh snapshot/CAS authority. They do not establish immutable lifetime identities. Hard deletion that orphans a private recipient or project reference fails closed and requires reconciliation; deletion/reuse or migration needs separate review of identity and history continuity. Employee archive [PR122](https://github.com/levieudell/Pro-daily-link/pull/122) retains member IDs in its separate proposal and is not imported here.

## Product behavior and limits

The ordinary thread, private audience selector and My Day reply path share the same server audience. A pending send/read captures its original project, recipient, body, actor/session, view and form. Current identity and scope checks guard dispatch, response application and read receipt effects. Workspace retirement clears message arrays, audiences, private views and pending form state.

Workspace startup skips optional report aggregates when the current typed report-view limit denies them. Production additionally requires the existing financial pricing ceiling; Insights uses report viewing alone. Managed state exposes only the current `pricingAllowed` result from the fixed server pricing helper, so a redacted pricing policy cannot be mistaken for permission. This read-only result is not a stored grant or an editable role flag. Unexpected authorization denials still retire private workspace state.

Messages are stored in the project thread. This integration adds no email, provider, notification or public-sharing action. It also adds no message business receipt, replay endpoint or duplicate suppression. A correlation operation header does not make a send idempotent. An unknown send result requires refreshing and reviewing current messages before another deliberate send; the UI must not automatically retry or claim recovered original delivery.

The existing fixed hard-hat Assistant eligibility and its project/crew restrictions remain unchanged. Event permissions and event row versions remain separate. No message flag is added to the role editor, and no paid dependency or provider setup belongs to this integration.

Synthetic access, normal HTTP, flag-off and actual-source UI checks must be bound to the eventual exact successor source. A moving diagnostic or earlier event pass does not certify this new head. Full workflow, independent review and current-head CI are separate gates; any later production authority or actual permission change requires its own concrete action-time approval.
