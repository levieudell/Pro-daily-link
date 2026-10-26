# Safety / PM MVP

This adds an opt-in safety workflow to the existing PDL daily report. It is an Oregon starter documentation pack, not an exhaustive safety program, legal certification, or permission to continue unsafe work. The employer and designated qualified people remain responsible for actual conditions, inspections and protective measures.

## Product workflow

1. Open **Safety today**, choose a project and work date.
2. A PM with daily-report access, admin or owner confirms the state and responsible employer, selects the project's trades, and enables the profile. Recognizable state suffixes in the address are checked against that selection. Ambiguous addresses require explicit confirmation; this is not geocoding or complete jurisdiction determination.
3. Generate the day's checks. Profile trades and recognized assignment/project-schedule tasks add starter checks. An explicit scope/conditions check is always included; unrecognized activity does not establish supported coverage.
4. Record the inspector and actual findings for every response. Excavation inspection requires a named competent person. Names alone do not verify qualification, authority or presence. Required inspection timing is shown before work and when conditions change; the software does not control physical work commencement.
5. Flag hazards with location, immediate action, responsible person, due date, work-stopped response and an optional existing project photo. The hazard appears in the PM safety view and Action Center. External SMS, email and push dispatch are not implemented and are not claimed.
6. A failed/deferred check creates a persistent hazard follow-up. A subsequent pass does not close that hazard; PM/office verification is required. Open hazards carry across days. Corrective updates remain possible when a checklist becomes stale or the profile is disabled.
7. Draft reports and clock-out remain available. An enabled project's final report creation, edit, office approval and subcontractor guest submission must pass the server-side documentation gate. Missing or stale checks block finalization even if configurable forms are disabled.
8. A documented failure/deferral can accompany a submitted report only with findings, corrective action, owner, due date and stopped-work evidence. It remains unresolved. A completed documentation gate is not a hazard-free result.

Every saved change has an actor, timestamp and before/after history. Every submitted daily captures its own check/rule/hazard snapshot, including earlier unresolved hazards; later edits do not rewrite that evidence. Changes to profile, address or schedule invalidate the old checklist until refreshed, retaining prior answers in history.

## Initial coverage

| Pack | Starter checks | Limits |
|---|---|---|
| Common | Confirm actual scope/site conditions; site walkthrough | Does not discover every hazard or determine jurisdiction from an address alone |
| Oregon roofing | Fall/edge protection, roof holes/skylights, access | Findings must establish actual conditions; no automatic choice of fall-protection method |
| Oregon excavation | Competent-person inspection, utilities, protective system and access | Not an engineered protective-system selection or qualification registry |
| Oregon framing | Leading edges and openings | Activity-specific exceptions and additional exposures need safety review |
| Oregon demolition | Survey/utilities/work sequencing | Not a complete demolition plan |
| Other states | Explicit manual-review coverage | Cannot finalize safety through an unreviewed pack |

Rule sources are displayed with each check. Catalog version: `or-starter-2026-10-26.1`.

- Oregon general construction: https://osha.oregon.gov/OSHARules/div3/div3c.pdf
- Oregon fall protection: https://osha.oregon.gov/OSHARules/div3/div3m.pdf
- Oregon excavation: https://osha.oregon.gov/OSHARules/div3/div3p.pdf
- Oregon demolition: https://osha.oregon.gov/OSHARules/div3/div3t.pdf

Safety committees/meetings, heat, respiratory protection, hazardous substances, company-level programs, state/federal jurisdiction exceptions, emergency procedures and other requirements are not comprehensively implemented. Obtain a competent safety review before real-job rollout. Washington, California, automated rule monitoring, persistent voice-segment stitching and cross-company attestations are future increments. Existing dictation and confirmed scheduling remain available.

## Prospect-driven increments

**Prepare a demo** lets a PM enter a prospect and choose a supported trade to preview the starter workflow. It performs no configuration writes and does not label an unsupported trade compliant or ready. Selecting a trade for project setup still requires explicit review and save.

For each upcoming prospect, supply: company, trade, job state, actual tasks/exposures, demo date, and what the demo must prove. Then:

1. Compare requested tasks with this coverage matrix.
2. Add a reviewed, sourced, versioned pack to `safety-engine.js`.
3. Add applicability, unsafe-state, stale-schedule, authorization and evidence regressions.
4. Demonstrate on synthetic data; label unsupported requirements clearly.
5. Publish through the normal protected release process and verify the actual deployed workflow separately.

Do not generate or publish binding safety rules from unreviewed AI output. Rule changes require reviewed sources, effective dates and new versioned tests; historical daily evidence keeps its original version.

## Local demo and verification

Use Node 22–24 and the repository's locked dependencies.

```sh
npm ci
npm run demo:safety
```

The demo binds only to `127.0.0.1:4326`, uses a new temporary synthetic workspace and prints a one-run password for `pm@example.invalid`. Open the printed login URL, then **Safety today**. Every restart creates fresh data. No production credentials or database files are needed. An alternative port can be supplied with `npm run demo:safety -- --port=4327`.

```sh
npm run check
npm run test:safety
npm run test:safety:browser
npm test
```

Browser acceptance requires an available Playwright runtime and Chromium/Edge. `PDL_PLAYWRIGHT_MODULE` and `PDL_BROWSER_PATH` can select them. It exercises the real safety API and UI component with isolated synthetic data, saves desktop/mobile screenshots to `output/`, and blocks external browser requests. It is separate from the normal CI suite because the repository does not install Playwright by default.

No schema migration is required. `safetyDays` uses the existing tenant snapshot/transactional collection persistence, is omitted from broad `/api/state` projections, and is exposed only by scoped safety endpoints or owner export. Existing backups preserve the full collection; company/project authorization and optimistic revisions apply to all safety writes.

This branch does not enable safety on existing customer projects, apply production changes, or deploy itself. Profiles are opt-in after release and safety review.

## Verification recorded for this MVP

- Base: current GitHub main `143761769cc0f49142a903365ab3ad6be534bee8`.
- Node 24.19.0: `npm run check`, safety domain/HTTP acceptance, and full `npm test` passed.
- Browser acceptance: real Edge at 1440px and 390px; complete app demo login/navigation/daily entry also passed with external requests blocked. Saved-evidence, later stopped-work updates and immutable history were checked.
- Existing full-suite browser launcher needed its supported `PDL_TEST_CHROME` setting on this Windows host; default Edge exited before the first DevTools response. The unchanged test passed with Chrome, and the full suite then passed. The normal CI browser driver was installed temporarily, without adding it to the package manifest.
- Dependency audit: two compatible existing transitive fixes (`body-parser` 2.4.0, `fast-uri` 3.1.9); npm reported zero vulnerabilities afterward.
- Repository security scan: zero critical findings. Dynamic HTML renderer findings were reviewed for escaping and covered by hostile-text browser tests.
- Production, external alert delivery, a real-job safety pilot and exhaustive legal coverage are not verified by these local tests.

[Desktop preview](safety-mvp/desktop.png) · [Mobile preview](safety-mvp/mobile.png) · [Saved daily evidence](safety-mvp/daily-evidence.png)
