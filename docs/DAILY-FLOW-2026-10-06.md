# Daily workflow changes — not deployed

Base: verified public main `976af1a5b68e447b8eda05ef23b6d0007789baa9`.
Worktree: `daily-flow-implementation`; branch `feat/daily-flow-recovery-20261006`.

- End Day retains typed/dictated notes on reopen and after refresh.
- IndexedDB retains selected report/end-day/progress photo bytes per company/user/form. Additional selections accumulate; individual staged photos can be removed. Storage errors are explicit. Browser eviction, private browsing and device loss cannot be guaranteed against; device recovery is not a cloud backup.
- Clock-out is persisted before analysis or photo upload. Retrying a completed workday returns its original linked report/time without creating another record. Completed workdays without a linked daily retain the existing 404 behavior and require office review.
- Automatic analysis opens editable review. Explicit source safety facts survive local fallback and AI omission. It creates no compliance conclusion. Separately entered next steps take precedence.
- Reports with new photos remain Draft until uploads succeed; final submission then uses PATCH on the same report. Photo upload IDs plus content digests make lost-response retries safe. Invalid/oversized batches fail explicitly.
- Previous submitted daily next steps appear as dated references alongside today's assignment activity. Drafts/future reports/other projects are excluded. Empty latest next steps suppress older instructions. PM scheduling control hides the reference per assignment and resets acknowledgement when changed.

Validation: syntax check and 58 of 60 repository checks passed, including all four new regressions, photo retry, report recovery, hours safety and all 28 late-time-card scenarios. Two failures reproduce on unchanged main: `sales-demo-route.test.js:40` and `backup-verification.test.js:86` expect Unix mode 0600; Windows returns 0666.

Remaining release gates: real-browser/phone QA (supported browser tools disappeared during implementation), Linux/CI verification, fresh production storage inventory/recovery proof under the parent task, and deployment authorization. No production data was written and no release was deployed.

Compatibility: PR52's guest-photo route is unchanged. PR53's estimate-import logic and PR54's scheduled-labor functions are unchanged. Shared `package.json` test/check commands will require combining during integration. Merge compatibility should be checked again at release.

Smaller release option: the recovery/clock-out/photo/analysis changes can ship independently of dated instruction carryforward; carryforward is confined to its policy function, GET route, assignment flag/checkbox, and the last instruction-rendering section of `daily-flow-ui.js`.
