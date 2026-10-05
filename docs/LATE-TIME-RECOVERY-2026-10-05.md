# Field time recovery

## User workflow

Open **Time**. All of the signed-in person's cards remain available, including earlier days and weeks. Unsubmitted cards appear first. Choose **Open / edit**, enter the actual times and correction reason, save, then **Submit** for office approval. The existing job and person cannot be changed.

- Own Draft and Returned (`rejected`) cards are editable. A field account and a foreman have the same own-card mutation boundary.
- Submitted, approved, removed, explicitly locked, and closed/exported-period cards remain protected. The row explains the office correction path.
- An unfinished one-person workday can be completed using that person's explicitly entered timestamps. Its original timestamps and correction reason are retained. No report is fabricated.
- A shared active crew workday requires the existing End day workflow or an office correction. Editing one person never ends a shared clock or changes another person's card.
- Historical job assignment changes do not remove access to one's own recorded time. Historical job name/code are shown without granting additional project access.
- Times in the edit form use the device timezone, which is named on the form. Payroll dates continue to use the period's stored company timezone and inclusive clock-in-day convention. Unchanged timestamps retain their original seconds and DST offset.

## Safety and data

The new field PATCH requires the revision read from the current card. A stale correction cannot silently overwrite a newer edit. The server accepts only punch times, breaks, reason and revision; identity, job, approval and payroll fields cannot be edited. It rejects overlapping cards, invalid/future end times and invalid or overlapping breaks. Hours use the existing calculation and rounding behavior.

Only a directly linked Draft daily has its existing labor/production-hour allocation refreshed. Submitted/approved reports, their rates and fixed payroll exports are not changed. Daily-report editing remains a separate existing workflow.

There is no database migration and no production data repair. Existing office correction and versioned export flows are preserved. The additional workday history and card metadata fit the existing snapshot/transactional persistence and backups.

## Verification

- `node late-time-cards.test.js`: isolated synthetic tenant/role/state/date, ownership, revision, workday and payroll export regression scenarios.
- `node late-time-cards-ui.test.js`: UI fixture checks in Los Angeles, UTC and Kiritimati, including exact unchanged timestamp preservation, field visibility, protected states, break retention, duplicate saves, interrupted saves and changed account context.
- `npm run check` and `npm test`: aggregate release gates.

## Recovery

The release is based on remote main `3bc3d8c3ef9fe671b41251017e3dd7fe502a2a6a` and contains no unpublished billing or Issues work. Roll back the code release to that version if necessary; no schema rollback is needed. Do not restore an old database to undo code, since that would discard later legitimate time submissions. Already saved corrections retain original punch values and audit history for office review.
