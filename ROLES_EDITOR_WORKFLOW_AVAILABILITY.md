# Company Roles draft: actual workflow availability

This is a local, synthetic-only compatibility draft. It is **not ready for a complete application rollout**. The six groups and 32 restrictive controls are implemented, but some existing visible workflows need compatibility admission before they can operate in this preview. Enabling a checkbox cannot open a fenced route.

The frozen `f932482f4930da8652755d6576691ec7cf3c0bc7` acceptance packet and the earlier d4975f9/990d4e1 drafts remain unchanged. This continuation completes natural-intent provider-name redaction and documents availability; it adds no route admission, new permission family or production access.

## What the 32 controls cover

| Group | Controls | Working workflow within existing role/feature/project/crew limits |
| --- | --- | --- |
| Scheduling | view, create, edit, remove, acknowledge | Manual assignment/calendar/today views, assignment writes and own acknowledgement. Repeat, attendance, mark-off and actual-time adoption use the same relevant scheduling/time review limits. |
| Time off | viewRequests, createRequest | Scoped requests and requesting one's own leave. Leave review additionally uses timeReview.reviewLeave. |
| Time review | viewCards, reviewLeave, approveCards, unapproveCards | Scoped card viewing, leave review and independent approval/unapproval. |
| Time writing/payroll | createCards, correctCards, removeCards, submitCards, clockCards, downloadCards, viewPayroll, configurePeriods, captureExports, downloadExports, viewActivities | Existing card/clock/period actions, card CSV downloads and retained payroll exports. Fixed role ceilings, time grants and feature locks still apply. |
| Dailies/workdays | viewReports, createReports, editReports, approveReports, viewWorkdays, runWorkdays | Photo-free daily creation/editing, structured safety in one compound save, independent approval, report/workday views and start/end. Report variants retain their existing fixed financial/approval authority. |
| Project notes/to-dos | view, create, edit, complete | Manual scoped notes/to-dos and team visibility. These screens work independently of the Assistant. |

Owner is protected. The matrix restricts Admin, PM, Foreman and Field actions within their original ceilings; crew membership is a scope, not a new account role. Policy management and profile assignment remain Owner-only in this phase. Absent policy, typed defaults are unchanged.

Manual Company/project/customer/directory/template/catalog/subcontractor resources admitted by the finite resource registry continue using their existing fixed authority. Manual estimate items/proposals, saved import drafts and approval remain available under original finance/project rules; no estimate or financial grant is added to the matrix. Owner Company JSON export and supported fixed report exports, plus typed card/payroll exports, are available. Exported JSON/CSV is not a complete physical attachment backup.

## Existing workflows unavailable in this preview

| Workflow | Exact boundary | User-visible consequence |
| --- | --- | --- |
| Daily photos and physical attachments | POST `/api/photos` and physical-byte APIs such as GET `/api/local-files/...` are outside the runtime's finite supported set. `/uploads/...` resolves through the protected file API rather than bypassing it. | Existing files/photos can retain metadata/references, but the named protected file APIs cannot deliver or upload their bytes here. Existing embedded images or remote URLs may render; those are outside the certified file-delivery contract. A daily with selected photos first saves a Draft; the subsequent photo call fails, so it cannot finish the requested submission. Photo-free daily workflows are supported. |
| Project plan upload/open | GET `/api/projects/:id/plans` serves scoped plan metadata. Byte creation/upload and protected file delivery are not admitted. | Plan listing and manual estimate proposal workflows can work; uploading a plan or opening retained plan bytes cannot. |
| PDF estimate analysis/import | POST `/api/estimate-imports/analyze` is not admitted. The finite manual estimate input contract excludes PDF bytes and provider/extraction side effects. | Visible PDF analysis/import controls cannot complete. Existing saved drafts can be edited/approved and manual items/proposals can be used. |
| AI Assistant | `/api/assistant/context`, `/api/assistant/interpret` and project `/assistant/context`, `/chat`, `/preview`, `/confirm` routes are not admitted by the atomic compatibility runtime. | The existing eligible-role launcher may be visible, but neither AI nor its manual Assistant action flow can complete here. Use the supported manual scheduling and notes/to-do screens. Fixed pilot Active Owner/Admin/PM eligibility remains outside the editor. |
| Company physical logo/complete attachment backup and remaining public sharing/ticket/provider paths | Physical effects and routes outside the finite resource registry remain stopped by the runtime. | They cannot be enabled through role flags. Company JSON export does not promise restoration of attachment bytes. Employee archive is excluded and unmerged. |

`compat-account-runtime.handle` rejects private `/api/` routes outside the supported set with a source-only 503 rather than falling back to a legacy writer. Some original buttons are still visible. The Roles screen now states the main unavailable workflows plainly; that notice does not implement missing routes or change authority.

## What remains unchanged outside this preview

With no installed compatibility runtime, existing server handlers continue through their original authenticated role/financial/project/crew authority. The Company Roles tab requires the runtime's `rolePolicies` capability and is unavailable in that legacy mode. The current prototype does not claim that a new policy saved here controls an unmodified legacy deployment.

This distinction matters: a workflow can be outside the 32 editable controls while still working under fixed authority, such as supported Owner report exports. Conversely, physical photo delivery and the Assistant are unavailable in this preview even though their existing legacy handlers still exist. No route fence was removed in this continuation, and no production setting was changed. The route fence is not a global browser URL firewall: existing data:image and credential-free remote image URLs are allowed by app.js but are not certified attachment delivery.

## Completed redaction and remaining release work

Natural-intent interpretation now sends only the bounded request, relevant draft fields, generic people clarification, company date/timezone and authorized project labels. It sends no generated member roster, selected-person labels or candidate IDs, including first/unknown-action turns and a scheduling-to-note transition. Scheduling person resolution still uses the current authorized server roster. Names explicitly written by the user in request/note text remain literal user content. Fresh actor/context checks, policy restrictions, budget reservation, preview/explicit confirmation and idempotency remain.

Synthetic checks cover that provider projection and actual note/to-do handler previews, explicit confirmations and replay with fake adapters and zero external calls. That closes the name-redaction prerequisite; it does **not** admit Assistant ingress or effects into this runtime.

There are two separate remaining categories:

1. **Compatibility code/admission gaps for a complete rollout:** photo/attachment byte custody and compound report-photo submission; plan/PDF physical/provider effects; Assistant ingress/confirmation/effect custody; any other legacy route required for the chosen rollout. These need bounded implementation and proof. They are not resolved by upload approval or by the 32 checkboxes. This phase makes no complete-release claim.
2. **External release gates:** approval to upload the exact new source, hosted Linux CI at that exact head, verification of the actual deployed topology/principals/schema and operational restore/rollback, and separate action-time approval for activation/deployment/live permissions. No source has been uploaded and none of those live actions is authorized by local acceptance.

Exact local test outcomes and independent review hashes are recorded in the continuation's external evidence packet. Older native/browser results remain identified by their frozen source head and module hashes; they are not presented as a new exact-head workflow run.
