# Schedule date picker and mobile refinement

Local branch `codex/schedule-date-picker`, based on released main commit `07734e5e5961daa4fc68eb1008881cc829becb1e`. User subsequently explicitly authorized pushing and deploying this schedule-only update. Annual enterprise quote and pay-period changes are excluded.

Click or keyboard-activate the central schedule date/range to open a labeled dialog and native date picker. If automatic native opening is unavailable or throws, the visible native date field remains usable. Select a date and press Go to date; cancellation, Escape and backdrop dismissal leave the schedule unchanged. Focus returns to the triggering date button. Day/Week/Month mode stays selected. Dates are parsed as local noon and validated without UTC conversion; arrows and Today retain their existing behavior.

Schedule-only CSS reduces header/control spacing, keeps 44px touch controls, aligns the office checkbox and label, uses three compact summary columns on mobile, and groups agenda days with consistent type and spacing. Orange/blue brand variables and role/data behavior are preserved. Very narrow screens stack filters. Updated asset versions prevent stale app/styles caches.

Validation: complete 32-command test aggregate passed, including existing role, tenant, onboarding, export and backup fixtures. New date regression runs in America/Los_Angeles, Pacific/Kiritimati and UTC; covers mode preservation, local dates, daylight-saving boundaries, leap day, invalid dates, cancellation, native fallback and arrow/year boundaries. Syntax and diff checks passed.

Limits: reference-image transfers were attempted through the current Library materialization helper. All failed on Windows because Python lacks `os.setxattr`; no final images were installed or pixel-inspected. The implementation uses the parent's image observations and the unambiguous requested date behavior. No supported browser runtime is available; no rendered desktop/iOS QA is claimed.

Before publishing, inspect at 391px, 320px and desktop widths; light/dark themes; all modes; native picker open/Cancel/Go to date; Escape and focus restoration; previous/next and Today; office checkbox/select; assignment view/add/edit for permitted roles; long project/person names and Spanish text. User accepted the outstanding iPhone visual QA limitation when authorizing publication.
