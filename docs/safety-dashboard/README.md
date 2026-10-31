# Company safety dashboard

Builds on the existing project Safety checks, toolbox talks, hazard follow-up, revision history and printable records. The project workspace remains under **Project checks & hazards**; field daily and clock flows are unchanged. A desktop Payroll selector was also restricted to its active page after visual QA found it appearing above Safety.

## New workflow

- **Overview:** meetings due, open corrective actions, attendance gaps and recorded meetings. Crew talks and committee meetings keep distinct records.
- **Topics:** use a published PDL topic or create a private company topic. Platform Operations → Safety library manages shared topics with draft, published and archived states and version history.
- **Assign:** choose a topic, project/company, presenter, crew/people, date and one-time/weekly/monthly schedule. Recurrence is a finite set of 1–52 meetings. Monthly dates retain their original anchor and clamp to the last day when needed.
- **Record:** presenter or office records actual discussion and attendees. Committee records include recommendations and management response. No automatic attendance or completion; an individual can separately acknowledge their own recorded attendance.
- **Follow up:** corrective actions have owners, due dates and recorded correction/verification evidence. Existing project hazards are included in the overview. Verification keeps the existing permission boundary.
- **Records:** PDF by date range and optional project includes scheduled/completed/cancelled meetings, pinned topic versions, attendance, acknowledgments, actions, amendments and existing project safety records. Earlier versions are retained when corrected.

Company records use the existing tenant repository and backup collections. Shared topics use the platform repository. No new database service or external notification provider. Repeated scheduling requests are idempotent; updates use revision checks. Company topics and records are tenant-scoped. Platform publishing uses the existing content permission.

## Oregon scope

For construction employers using safety meetings, Oregon requires meetings at least monthly and before starting each job lasting more than one week, with meeting records retained for three years. Weekly talks may be company policy. Committees have separate requirements; a scheduled meeting or completed form does not establish compliance, competent-person qualification or task-specific training.

Sources reviewed October 31, 2026:

- [OAR 437-001-0765, Safety Committees and Safety Meetings](https://osha.oregon.gov/rules/final/division-1/Pages/437-001-0760-0765.aspx)
- [Oregon OSHA safety committees and safety meetings guide](https://osha.oregon.gov/OSHAPubs/0989.pdf)

## Validation

`safety-program.test.js` covers authentication, role/tenant boundaries, recurrence, retry idempotency, repository serialization, pinned topic versions, attendance and acknowledgments, amendment history, verification permission, future-meeting denial, cancellation, PDF output and platform publishing revisions.

`safety-dashboard.browser.test.js` uses a disposable local tenant and verifies topic creation → assignment → meeting record → corrective action → PDF download. It checks 390px and 1280px in both themes, no horizontal overflow, 48px primary controls, pinned footer visibility, computed brand colors, and the publisher's version-history UI. Existing project Safety browser coverage remains in `safety-app.browser.test.js`.

Screenshots here show synthetic data only. This branch has not been deployed.
