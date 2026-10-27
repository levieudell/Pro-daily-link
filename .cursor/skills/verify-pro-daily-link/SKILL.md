---
name: verify-pro-daily-link
description: Drive the Pro Daily Link field clock, one-note daily, voice notes, production-versus-estimate split, extra-work picks, and office approval on the staging demo tenant at phone size. Use when verifying those journeys, the clock-out review screen, or the zero-line crew-hours send gate.
---

# Verify Pro Daily Link

Drive the real field and office UI on hosted staging. The repo's browser harness is puppeteer-core (the same driver as `field-clockout-parse-e2e.test.js`), at phone size 390x844 with touch. Playwright is not installed in this repo.

Staging: `https://pdl-staging.onrender.com`. Demo tenant `DEMO | Alder Ridge Builders`, field user and owner from `staging-seed.js`. Passwords come from `PDL_STAGING_FIELD_PASSWORD` and `PDL_STAGING_OWNER_PASSWORD`. Never write those values into this skill, a commit, or a report. The passwords local e2e tests pass to a server they spawn are not the hosted staging passwords.

## Launch

From the repo root, with both password env vars set and `PDL_TEST_CHROME` pointing at Chrome:

```bash
PDL_VERIFY_RESET_STAGING=1 .cursor/skills/verify-pro-daily-link/scripts/launch.sh
```

`PDL_VERIFY_RESET_STAGING=1` fast-forwards `origin/staging` to `origin/main` only when staging is an ancestor of main, which starts the staging auto-deploy. It does not push `main` and does not deploy production. Omit the variable to skip the push and only run doctor.

Ready means doctor exits 0: `/api/health/live` is 200, `/api/health` is 200 with `kind: operational-readiness`, and both demo logins return the Cedar Grove project. The health payload does not include a git SHA. The SHA you pushed is the commit you asked staging to serve.

Teardown does not stop the hosted service. A staging deploy reseeds the demo store. Do not run two drivers during a deploy.

## Doctor

```bash
node .cursor/skills/verify-pro-daily-link/scripts/doctor.cjs
```

Read-only. Writes `$PDL_VERIFY_ARTIFACTS/doctor.json` (default `/tmp/pdl-verify-artifacts/doctor.json`). Prints status, role, display name, and company name. It does not print passwords, cookies, or tokens.

Add `--wait` to poll until the new build shape is up (live 200 and `operational-readiness`). Login still has to succeed for exit 0. A 503 readiness body is reported and is not treated as ready.

## Drive

```bash
node .cursor/skills/verify-pro-daily-link/scripts/drive.cjs --journey 1,2
```

Journeys: `1` clock-in and clock-out, `2` one-note voice daily, `3` production versus estimate, `4` extra-work picks, `5` office approval, `6` zero-line hours send gate. Default is all six. `--check-assertions` checks the garbage-transcript guard and the largest-remainder helper without a browser.

Phone page: 390x844, `isMobile`, `hasTouch`. Selectors used:

- Clock: `#start-day-button`, `#start-day-modal`, `#start-day-project` value `3` (DEMO Cedar Grove Clinic), `#start-day-members`, `#confirm-start-day`
- Old clock-out screen, which must not paint before the review: `#end-day-modal` open, visible "What was completed?", `#end-day-notes`, `#confirm-end-day`, and `[data-report-step="1"].active` with visible `#field-notes` before `#field-review-cards` is visible
- Daily: `#report-modal`, `#field-notes`, `#voice-notes`, `#report-next-step`, `#field-review-cards`, `#field-scope-flags`, `[data-flag-choice="extra"]`, `#save-report`, `#report-sent-modal`
- Office: `[data-report]`, `[data-approve-report]`, `.extra-work-office`, `#office-decision`

Journey 1 arms a MutationObserver and a per-frame sampler, installed at document start, at the moment Clock out is tapped. Any old-screen hit before `#field-review-cards` is visible fails the journey. Do not drop that assertion to make the journey pass.

Journey 2 taps `#voice-notes`. The page hook removes `MediaRecorder` before app scripts so `startVoiceNotes` in `app.js` takes the `SpeechRecognition` branch, then delivers one final result through `recognition.onresult`. The test does not assign `#field-notes`. A note containing `Cars Our supply now Cars final` fails the journey.

Journey 3 waits two minutes on the clock so the punch has minutes to split. Curb must be 40 LF on estimate line 1 and gutter 20 LF on line 5. Line minutes must sum to the punch, and the displayed hours must be the largest-remainder hours of those minutes.

## Evidence

Artifacts go to `$PDL_VERIFY_ARTIFACTS` or `/tmp/pdl-verify-artifacts`, and drive also copies them to `/opt/cursor/artifacts/verify-pro-daily-link`. Each journey directory gets screenshots, a webm when ffmpeg can encode the screencast, and redacted API state (report, production, extra work, labor, history). No cookies or passwords.

The proof is the screen the user sees plus the report returned by `/api/state` after the tap. Do not satisfy a journey by writing the DOM value yourself.

## Cleanup

```bash
node .cursor/skills/verify-pro-daily-link/scripts/cleanup.cjs
```

Sends SIGTERM to the browser pid recorded in `run.json`, if that process is still alive. It does not delete the artifacts directory and it does not stop staging.

## Helpers

- `scripts/launch.sh` — fast-forward staging when asked, then doctor `--wait`
- `scripts/doctor.cjs` — health and both demo logins
- `scripts/drive.cjs` — phone journeys
- `scripts/cleanup.cjs` — stop only the browser this skill started
- `scripts/lib.cjs` — puppeteer launch, phone page, login, screenshots, redacted state

Invocation is `node` on the `.cjs` files and the shell script for launch. `puppeteer-core` resolves like the e2e tests: `require('puppeteer-core')`, then `PDL_PUPPETEER_MODULE`, then `/tmp/puppeteer/node_modules/puppeteer-core`.
