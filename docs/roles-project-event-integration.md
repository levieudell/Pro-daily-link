# Project events in the Roles successor

This source-only successor combines main `7c87dee6b2ebaa2ef4fdb424a582532f45a8fedc` (PR187) with frozen local Roles successor `798c8cbd78093b2e0c2cc283a4a287074ca8213a`. Published draft PR186 remains frozen at `b6ff24c70eca0b97e3f1102e6c3cb7c51e717b63`. No production settings, grants, accounts, data, credentials, merge or deployment belong to this work.

The main event routes checked only the office role. A closed synthetic run on unchanged main reproduced assigned PM creation/deletion on another project and writes by a PM with `scheduleCrews: false`. Field mutations were already denied and readable-project state scope was already present.

## Finite authority

| Existing route or projection | Existing typed control | Fixed boundary |
| --- | --- | --- |
| `POST /api/projects/:id/events` | Scheduling Create | Current Owner/Admin/PM; PM `scheduleCrews` and assigned project |
| `DELETE /api/project-events/:id` | Scheduling Remove | Same current office ceiling, original event's PM project, and selected event version |
| `GET /api/state` event collection | Scheduling View | Current readable project scope |

These are project/day records, with no assignment crew target. No fake member IDs, new editable event flag, event-derived privileges, or Assistant eligibility are introduced. `createdBy` is a display name only. Field and Foreman receive read-only project events within existing assignment/workday/report project visibility. My Day additionally selects today's events for today's assigned projects, matching PR187.

The normal adapter admits and validates events before its no-policy early return. Baseline manual routes enforce the same current PM permission/project floors. The event collection has bounded closed records, canonical numeric IDs, valid calendar dates, five existing types, and bounded title/notes. A create changes exactly one matching event; a delete removes exactly its admitted original event. Unrelated collection changes and event changes through other routes fail closed. Existing snapshot revision, session/role/scope authority, deadline and CAS fences still apply before persistence and response delivery.

Existing no-policy role defaults remain unchanged. The correction closes the newly introduced event route's omitted existing PM boundaries. Malformed inputs that formerly coerced or silently truncated now receive validation errors.

## Product and limits

The ordinary event form, desktop schedule and mobile agenda use the server's existing per-action Scheduling DTO plus the fixed office/PM scope. Readable events remain viewable without Remove authority. Private event state and dialogs retire with workspace authority, and a delayed response cannot update a newer identity or form. Permission policy edits still use their existing server preview, revision, audit and explicit confirmation.

Event state and creation responses include a content version calculated from the current finite source row. Deletion requires that version in `X-PDL-Event-Version`; missing or changed versions receive a conflict before persistence. This prevents a changed event with a reused numeric ID from silently replacing the displayed deletion target. The version is read-only DTO metadata and is never persisted as a grant or event field. It compares current contents, without claiming an immutable lifecycle identity for legacy rows.

The event route does not provide a business receipt, replay endpoint or duplicate suppression. An `X-PDL-Operation` value does not make its POST idempotent. Unknown event results must be reviewed against refreshed current events before another deliberate submission; the UI never automatically retries or claims an original-operation recovery guarantee for events.

The unchanged fixed Assistant eligibility remains signed-in Owner/Admin/PM only, with the existing scheduling/project-note checks. Employee archive remains fixed Owner/Admin and outside editable flags. PR24 dependency changes remain separate.

Synthetic and source review results must name their exact successor head. Earlier `798` and published `b6` results are historical evidence, not automatic validation of this integration. Hosted CI and any later production gate require separate current-head evidence; production action approval is still required at action time.
