# Pro Daily Link Product Roadmap

## Product boundary

Pro Daily Link is the operational record between the field and office. The initial commercial product captures work, verifies production, compares estimates with actuals, and exports billing-ready reports. It does not create or send invoices in the first release.

## Current foundation

- Branded responsive office interface
- Customer and project hierarchy
- Estimated, scheduled, and actual production foundations
- Crew and individual scheduling
- Start/end workday with calculated labor time
- Opening and closing field photos
- AI-assisted daily report with human verification
- Custom/unplanned production items and office flags
- Office and restricted field experiences
- Local persistence and API test coverage

## Phase 1 — Production-grade data model

Goal: replace prototype storage with a reliable multi-company foundation.

### Build

- PostgreSQL database and migrations
- Companies, users, memberships, roles, customers, projects, job sites, crews, workers, assignments, workdays, reports, photos, estimate items, production entries, exceptions, changes, and exports
- Immutable audit events for submissions, corrections, approvals, mappings, and exports
- Tenant isolation on every database query
- Object storage for original and compressed photos
- Time zones stored per company and project; timestamps stored in UTC
- Soft deletion and recovery for business records
- Automated backups and restore procedure

### Done when

- Two companies can use the system without accessing each other's records
- Restarting or deploying the service never loses data
- Every approval and correction identifies who changed what and when
- Restore from backup is tested

## Phase 2 — Authentication and roles

Goal: enforce office and field access rather than only changing the interface.

### Roles

- Owner/admin: company configuration, billing, all financial and operating data
- Office manager: customers, projects, estimates, reports, exports, and approvals
- Project manager: assigned projects, reports, production, and changes
- Superintendent/foreman: assigned crews and projects, workdays, reports, and corrections
- Field worker: personal schedule, start/end day, photos, and assigned reports

### Build

- Secure sign-in, invitation, password reset, and session management
- Server-side authorization for every endpoint
- Project-level access assignments
- Financial-field restrictions for field roles
- Account removal and company offboarding

### Done when

- Field users cannot retrieve contract values or costs through the API
- Users see only assigned projects and work
- Permission tests cover every protected endpoint

## Phase 3 — Field-first daily workflow

Goal: make a correct daily possible in roughly two minutes.

### Build

- "My Day" dashboard with today, upcoming work, personal dailies, and a large Start button
- Start day: assigned project, present workers, timestamp, location, weather, and opening photos
- During day: add/remove workers, record breaks, switch projects, and capture photos or notes
- End day: closing photos, voice/text summary, automatic end time, and calculated hours
- AI extraction of production, labor allocation, materials, equipment, delays, safety, and next steps
- Large touch controls, autosave, offline queue, sync indicator, and recovery
- Foreman verification and signature
- Reopen/correct workflow with audit history

### Done when

- A workday can be completed offline and sync safely later
- Accidental glove input is editable before and after submission
- No AI-generated number is accepted without visible verification
- Split shifts and workers leaving early calculate correctly

## Phase 4 — Estimate versus actual production

Goal: provide the daily answer to "are we winning or losing?"

### Build

- Multiple production items per daily
- Labor-hour allocation by production item
- Approved reports roll into actuals; drafts never do
- Planned quantity, actual quantity, remaining quantity, budget hours, actual hours, and earned production
- Production rates such as SF per labor hour and labor hours per unit
- Forecast labor at completion and variance alerts
- Date and crew filters
- Exception queue for missing quantities, mismatched units, unusual production, and unplanned work

### Done when

- Every production dashboard number can be traced to approved daily entries
- Corrections recalculate totals without double-counting
- Unit mismatches cannot silently aggregate

## Phase 5 — T&M, hybrid projects, and field tickets

Goal: support work that has no production estimate.

### Project types

- Estimated
- Time and material
- Hybrid

### Build

- Labor classifications and billable rates
- Material, equipment, subcontractor, and markup entries
- T&M ticket number and customer representative signature
- Receipt and supporting-photo attachments
- Hybrid separation between base contract, T&M, and changes
- Office verification of billable versus non-billable time
- Rate snapshots so later rate changes do not rewrite history

### Done when

- A T&M project can operate without estimate line items
- A verified ticket contains enough backup to enter into external billing software
- Field users cannot view rates, markups, costs, or billing totals

## Phase 6 — Unplanned work and change management

Goal: ensure work outside the estimate never disappears.

### Workflow

Field custom item → office exception → mapped to existing scope, acknowledged as non-billable, converted to T&M, or opened as a potential change → submitted → approved/rejected → approved change line

### Build

- Unplanned-work office inbox
- Reason, photos, notes, labor, material, and equipment evidence
- Potential change records with sequential numbers
- Pending, submitted, approved, rejected, and void statuses
- Approved changes added to revised contract and production tracking
- Full change history and supporting exports

### Done when

- Every custom field item reaches an explicit office disposition
- Unapproved changes never alter the original contract or progress totals
- Approved changes retain their original field evidence

## Phase 7 — Reporting and billing handoff

Goal: produce trusted reports for any existing contractor billing process.

### Reports

- One-page project production summary
- Reporting-period summary
- Progress-billing backup
- T&M ticket summary and detailed backup
- Labor by person, classification, project, and scope
- Change and unplanned-work log
- Daily report package with selected photos

### Progress report columns

- Description
- Original estimate or contract quantity
- Approved changes
- Revised total
- Previously reported
- Current period
- Completed to date
- Remaining
- Percent complete

### Formats

- Branded PDF for reading and submission
- XLSX/CSV for entry into accounting and billing systems
- Filters for period, project, status, line item, and change
- Export record containing filters, included approvals, creator, and timestamp

### Done when

- PDF totals match the underlying approved records
- Re-running the same locked reporting period produces the same totals
- Detailed spreadsheet values reconcile to the one-page summary

## Phase 8 — Mobile applications and deployment

Goal: deliver a dependable product through the Apple App Store, Google Play, and web.

### Build

- Capacitor-based iOS and Android shells
- Camera, location, notification, and offline storage integration
- Photo compression and background upload
- Push reminders for assignments, missing start/end events, and pending dailies
- Hosted API, database, storage, CDN, monitoring, alerts, and deployment pipeline
- Privacy policy, terms, account deletion, permission explanations, icons, screenshots, and store listings

### Done when

- Field workflows pass tests on representative iPhone and Android devices
- Poor connectivity cannot lose a completed daily
- Store privacy disclosures match actual data collection

## Phase 9 — Historical production intelligence

Goal: turn completed work into a contractor's private estimating advantage.

### Preserve now

- Normalized work category and unit
- Actual quantity and labor hours
- Crew size and classifications
- Working days and elapsed duration
- Project type, conditions, access, height, complexity, weather, equipment, and photos
- Original estimate, final actual, and approved changes

### Build later

- Completed-work benchmark library
- Comparable-project search
- Average, median, range, and outlier production rates
- Filters by crew, work type, conditions, region, and project type
- Estimate assistant that proposes labor from verified company history
- Source links from every recommendation to comparable completed work

### Done when

- Suggested production rates are based only on the contractor's approved history
- Users can inspect the projects behind every recommendation
- Low-confidence recommendations are labeled and never silently inserted

## Recommended delivery order

1. Database, storage, authentication, authorization, and audit foundation
2. Complete field workday and offline daily workflow
3. Estimate-to-actual calculations and exception review
4. T&M and hybrid project support
5. Unplanned-work and change workflow
6. PDF/XLSX reporting and billing handoff
7. Mobile store packaging and production launch
8. Historical benchmarking and estimate assistance

## Initial commercial release boundary

The first sellable release includes phases 1–7 at a focused level: secure companies and roles, field workdays, verified dailies, estimated/T&M/hybrid projects, change tracking, production dashboards, and billing-ready exports. Full invoicing, payments, payroll, accounting ledgers, and customer portals remain outside the initial product.

## Product success measures

- Median time to submit a field daily
- Percentage of scheduled days with completed reports
- Percentage of AI suggestions corrected by users
- Time from field submission to office approval
- Unplanned work identified before billing cutoff
- Difference between reported and final production totals
- Weekly active field and office users
- Report exports per active project
