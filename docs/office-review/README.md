# Office review fixes

- Team: an owner can explicitly link an existing login to a worker profile with the same unique email. The confirmation names both records. Ambiguous matches and existing links are rejected; role, grants, credentials and work history are preserved. A duplicate login is not created.
- Safety: follow-up shows the recorded author, timestamp and source. Recorded-in-error history remains available on the original date, with the reason and no follow-up edit controls. Saved daily evidence is unchanged.
- Daily review: a checklist and correction action appear before approval, with reported/clock evidence in Details and clock seconds formatted as hours/minutes/seconds.
- Brand: office warnings, labor-review panels and summary panels use brand surfaces, readable theme text, orange warning borders and 48px actions.
- Dates: generated action items, pay-period summaries and captured-rate/export history use MM/DD/YYYY; timestamps respect the company timezone where available. Stored dates and payloads are unchanged.
- Phone Time cards: people needing approval sort first. Pay-period management is collapsed below the people list, with a compact range/search section above it.

Validation: `office-review.test.js` covers link conflicts/authorization/access preservation, escaped review evidence, corrected hazards, dates and approval priority. `office-review.browser.test.js` checks persisted linking, anonymous/field rejection, the correction action, light/dark computed colors, and phone visibility. Screenshots cover 390x844 and 1280x800 in both themes.

Screenshots in this folder use disposable synthetic data. The local `safety-correction-live.png` is separate evidence of the owner-requested production record correction and is not included in the code commit.
