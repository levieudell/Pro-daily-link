# Project manager site visits

Project manager site visits turn a stream of field observations into one grounded project update without forcing a PM to fill out a long report while walking a job.

## Intended flow

1. Open **Projects** and choose an assigned active project.
2. Use the project **Overview** for today’s crew, the next milestone, open concerns, and the latest field update.
3. Select **Open site notes**.
4. Add short typed notes, dictated notes, and photos throughout the visit. Each item is saved as separate, timestamped evidence.
5. Select **Finish site notes**. The app waits for pending offline items, freezes the evidence revision, and organizes only that visit’s evidence.
6. Review and edit work completed, safety, delays, decisions, next actions, potential changes, and possible schedule impacts. Each schedule proposal can be corrected, kept, or dismissed.
7. Select **Save project update**. The reviewed update is added to the project’s office record and appears as the latest field update on Overview. Raw visit evidence remains unchanged.

The PM can leave and resume an open visit. A second tap on Start resumes the same visit instead of making a duplicate.

## Save and offline behavior

- Typed composer text is cached on the current device until it is added or cleared.
- An unfinished correction and any review edits are also cached for the same signed-in user, visit, and evidence revision.
- Added notes use stable request IDs so replaying a queued request does not duplicate evidence.
- Supported note/photo writes may queue while offline.
- The UI distinguishes local-only data from server-saved data.
- Finish is blocked while queued evidence is still syncing, so the AI cannot silently omit an offline note or photo.
- Queued work and cached state are isolated by company and signed-in user. Logging into another account cannot see or replay them; returning as the original user safely resumes them.
- Rejected or missing offline evidence is retained as **Needs attention** and blocks Finish until the user retries or replaces it. The app never silently reports a lost photo as synced.

## Permissions and privacy

- Account owners and administrators can access site visits for their tenant’s active projects.
- Project managers can access only assigned projects.
- An open visit belongs to the PM who started it; another PM cannot guess its identifier and edit or read it.
- Completed visits remain readable to authorized office users on the project.
- Visit data is not included in the broad `/api/state` workspace payload. It is loaded only through project-scoped endpoints.
- Photos must belong to the same tenant, project, and visit.
- Raw evidence is immutable after completion.

## AI boundaries

The organizer receives only:

- the selected project’s basic identity;
- that project’s schedule task names/dates; and
- the current visit’s saved evidence IDs and literal content.

Every generated statement must cite existing evidence IDs. Statements with missing evidence are rejected. The AI is instructed not to invent people, hours, quantities, dates, hazards, decisions, delays, or schedule changes. Text that looks like an instruction inside a field note is treated as ordinary evidence, never as a system instruction.

The PM can edit or remove every suggested line before saving. Schedule proposals have an explicit keep/dismiss decision plus editable task, milestone, day shift, and reason fields. Editing the organized result never rewrites the source notes or photos.

## Schedule guardrail

A phrase such as “concrete was pushed two days” may create a **schedule impact to review**. It does not move a task, assignment, or milestone.

The current release intentionally opens the live Schedule for a human review. A future apply workflow must use a versioned preview, show downstream tasks and crew conflicts, recheck permission and current state at confirmation time, then commit the mutation and audit record atomically. Offline replay must never approve a schedule change.

## Recovery

`projectSiteVisits`, `safetyDays`, and referenced private photo objects are included in portable tenant backup validation and shadow reconciliation. Recovery verification must validate the backup manifest and storage checksums before a restore is considered usable.

## Release checks

Run:

```powershell
node --check project-site-visits.js
node --check project-site-visits-ui.js
node project-site-visits.test.js
node project-site-visits-concurrency.test.js
node project-site-visits-ui.test.js
node project-site-visits-backup.test.js
node project-site-visits-photo-api.test.js
node stored-asset-compensation.test.js
node project-notes-api.test.js
node offline-photos.test.js
node portable-backup.test.js
npm run test:site-visits:browser
```

The full mobile browser check should cover: assigned project selection, multiple text/voice/photo captures, refresh, offline replay, Finish, evidence-grounded review, accepting/editing/dismissing schedule proposals, saving the update, 390px layout, light/dark mode, and cross-project access denial.
