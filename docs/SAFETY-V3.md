# Safety v3

Safety v3 turns Pro Daily Link's Oregon starter documentation into a focused field workflow:

1. See the one safety action that matters now.
2. Record the actual condition with a deliberate response.
3. Assign and verify follow-up without losing the original evidence.
4. Find or print the project record later.

It supports a company's safety program and recordkeeping. It does **not** certify OSHA compliance, decide whether work is legally safe, qualify a competent person, determine incident recordability, or replace emergency response and employer responsibilities.

## Product promise

> Keep safety work visible and build a defensible record without making the field complete another packet of paperwork.

The UI must not promise that Pro Daily Link “handles all compliance.” Safety requirements depend on the employer, jurisdiction, trade, work, site conditions, equipment, and changes during the day.

## First-principles rules

- Delete duplicate context and navigation before adding controls.
- Ask for a fact only when the system cannot safely derive it.
- A clean check is a deliberate one-tap observation; it is never an AI conclusion.
- An exception reveals only the fields needed to control and follow up on it.
- AI may organize notes or suggest a topic. It may not complete a check, identify a competent person, attest for a worker, say work stopped, verify a correction, or declare compliance.
- Company, project, address, jurisdiction, date, authenticated recorder, and timestamp are server-owned evidence.
- Submitted safety evidence is immutable. Later corrections and review are additive.
- No worker is represented as individually acknowledging a toolbox talk unless that worker performed a dedicated acknowledgement action.

## Information architecture

The Safety workspace has three tabs:

- **Today** — current status, the next action, report hazard, toolbox talk, and assigned forms.
- **Follow-up** — open, overdue, corrected, and waiting-for-verification items.
- **Records** — checks, talks, hazards, submitted daily evidence, filters, and a printable record.

Toolbox talks and forms are actions, not permanent top-level destinations. Project/date controls remain compact. Field users start from their assigned work; managers keep their project scope.

## Daily check runner

The runner presents one check at a time with written status and large controls:

- **Looks good** — records the signed-in actor and a standard observation that no issue was observed at that time.
- **Needs action** — requires the condition, immediate protection, responsible person, due date, and explicit stopped-work response.
- **Not applicable** — requires a reason.

Checks that require a competent person still require the actual designated person's name. Entering a name does not establish qualification or presence.

## Hazards and closure

Hazards follow one lifecycle:

`Observed → Corrected → Verified`

Field users can record and correct. Verification is a distinct office/PM permission. A manager cannot jump from observed directly to verified without recorded corrective action and verification findings. Historical submitted evidence does not change when the live hazard later closes.

## Toolbox talks

A talk record stores:

- project and work date;
- topic and optional notes;
- language;
- server-owned presenter identity and time;
- a roster of valid team members the presenter reported present.

The roster is not labeled as individual acknowledgement. A future individual acknowledgement flow must store each worker's own actor ID and timestamp.

If the presenter makes a recordkeeping mistake, the original talk is retained and
an authenticated amendment or void reason is appended. Corrections never erase
the original topic, roster, presenter, or recorded time.

## Permissions

- Owner/Admin: configure and verify within the company.
- Project Manager: view only within assigned project/crew scope. `manageSafety` controls project setup; `verifySafety` controls closure verification.
- Foreman/Field: record facts for authorized project work dates; no setup or closure verification.

Owners and admins can turn project Safety off with an explicit confirmation. This
removes the daily-submission gate going forward; it does not delete prior checks,
talks, hazards, report snapshots, or their audit history.

Permission changes take effect on the next authenticated request. Direct API calls use the same rules as the UI.

## Evidence and reporting

The first non-draft daily submission captures an immutable safety snapshot containing the project/company context, jurisdiction, timezone, project setup revision, rule pack, checks, talks, hazards, authenticated actors, and capture time. Approval validates the current live safety gate but does not rewrite that original snapshot.

After capture, the daily cannot be moved to another date, returned to Draft, or
deleted. Ordinary corrections remain additive so the original safety evidence
cannot be separated from the record it supported.

The Records tab can print a scoped safety activity record. The print view is a useful project record, not a regulator-issued form or compliance certificate.

## Rule coverage

The built-in reviewed starter pack is currently limited to Oregon and the supported activities in `safety-engine.js`. Other jurisdictions remain manual-review only. Add a jurisdiction or trade only with reviewed primary sources, an effective/version date, and regression tests. Existing evidence keeps its original rule version.

Primary design references:

- [OSHA Recommended Practices for Safety and Health Programs in Construction](https://www.osha.gov/sites/default/files/publications/OSHA3886.pdf)
- [OSHA Hazard Identification and Assessment](https://www.osha.gov/safety-management/hazard-Identification/)
- [OSHA Worker Participation](https://www.osha.gov/safety-management/worker-participation)
- [Oregon OSHA: Training for safety](https://osha.oregon.gov/essentials/toolkit/pages/training-safety.aspx)
- [Oregon OSHA: The ABCs of construction site safety](https://osha.oregon.gov/oshapubs/4878.pdf)

## Release acceptance

Run:

```text
npm run check
npm run test:safety
npm run test:safety:browser
```

Acceptance includes tenant/project isolation, stale-revision conflicts, role permissions, immutable submission evidence, canonical talks, one-tap clean checks, exception follow-up, mobile 390px layout, keyboard focus, English/Spanish copy, dark mode, and printable output escaping.
