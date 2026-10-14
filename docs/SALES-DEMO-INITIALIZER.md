# Dedicated synthetic sales demo

This is a one-time, data-only initializer for a new, separately registered company named exactly `DEMO | Alder Ridge Excavation & Concrete`. (The legacy name `DEMO | Alder Ridge Builders` is still accepted so previously prepared demo tenants keep their safe retry path; new demo companies should use the sitework name.) It does not create or copy an account, password, session, role or support grant. The owner establishes their login through normal signup and enters their own password.

## Supported workflow after this release is deployed

1. The owner completes the normal self-serve, no-card signup using the exact demo company name and their chosen email. They accept the linked Terms/Privacy themselves. Keep the existing owner session. Do not purchase a plan, request paid onboarding, invite employees or connect Stripe.
2. An already signed-in platform owner opens Platform Operations → Customer health → All accounts, locates this exact new company, and clicks **Prepare sales demo**. The ordinary company-owner login alone does not authorize this action.
3. Preview checks the exact tenant, age (under 24 hours), revision, one existing active owner, absence of operating records and payment links. The confirm screen explains the synthetic content. If time cards were explicitly disabled, use the existing platform feature control to enable them first.
4. Initialization verifies a pre-seed private recovery backup, then saves the fixture under the target tenant's normal write queue and snapshot/transactional controls. The response waits for all started durable writes, even when one fails. A repeat retries persistence of current demo data and never resets presenter edits.
5. The success link opens `/app?tenant=<the exact returned company ID>`. Use that company's existing owner login. It is a tenant-selection link, not an access grant.
6. Verify 3 projects, 9 employees, 30 reports, 90 time cards and the scheduled entries for the rest of the seed week. Reload and check the totals again before presenting. Real browser rendering and real-cloud persistence must be verified after deployment.

The dedicated demo is marked `demo: true`, `billingExempt: true` and `planPrice: 0`; there are no Stripe customer/subscription links. Existing customer-metric filters exclude demos; it does not create paid revenue. Normal primary-demo reset remains available only for its supported primary tenant. The dedicated demo has no destructive reset control.

## Data story

Two full weeks precede the current calendar week in America/Los_Angeles. All people, customers, projects and operating history are marked DEMO. Reserved `.example` addresses and 555 numbers are used. Six placeholder photos are local 1×1 data-URI pixels labeled DEMO — no remote imagery or outside links are seeded. Historical workdays are complete, with nonoverlapping shifts and explicit meal breaks; no indefinitely running clocks are invented.

The company is a fictional excavation, utilities and concrete contractor. DEMO Riverbend Subdivision Phase 2 (DEMO Dirt Crew) is on track: mass excavation 1,800 of 2,000 CY at 144 of 160 budget hours plus structural fill 1,200 of 1,200 CY at 96 of 96 — 240 hours at 100% efficiency. DEMO Hwy 99 Waterline Replacement (DEMO Pipe Crew) is the at-risk job: 300 of 1,500 LF of trenching and 480 of 1,400 LF of 8" DI pipe using 216 hours against 440 budget — 50% efficiency, with daily notes and Notes & To-dos pointing at a sandstone lens and the rock-trencher recovery plan. DEMO Cedar Grove Commercial Pad (DEMO Concrete Crew) is on track: footings 96 of 240 CY and slab 3,000 of 12,000 SF at 100% efficiency, plus an approved owner-added sidewalk change order.

Before review: 28 approved reports, two review reports (October 2), 84 approved cards (672 hours), five submitted cards (40 hours), and one draft card (8 hours). The closed September 21–27 weekly export contains 360 hours. The open period contains 312 approved hours and stays blocked until review is complete. Three change orders sit at three stages (Potential field flag, Submitted T&M, Approved), one scheduled day has no daily (September 17), and one daily records a deliberate 45-minute late start. Approval of the two pending reports adds 120 LF of pipe to Hwy 99 and 600 SF of slab to Cedar Grove. These are fictional figures, not evidence of production results or actual payroll payments.

## Re-running the demo seed

The seed is deterministic and re-runnable; it only ever targets a dedicated empty demo company and never touches production customer data.

- **Live platform path:** after this release is deployed, sign in to Platform Operations as a platform owner, open Customer health → All accounts, find the new empty demo company (exact name above, created within the last 24 hours) and click **Prepare sales demo**, then confirm the preview. The route verifies the tenant, takes a recovery backup first, and writes the fixture through the normal tenant write queue. Re-clicking is a safe persistence retry — it never resets presenter edits or reinstalls over existing data.
- **Offline review package:** run `node scripts/prepare-sales-demo.js --output <new-directory> --as-of YYYY-MM-DD`. The command writes only new local files (fixture, summary, manifest) and refuses an existing output directory. Its fixture ID is not proof of a live account.
- **Changing the story:** edit `sales-demo-data.js` (pure, credential-free generator) and re-run either path. `sales-demo-data.test.js` revalidates determinism, referential integrity, pay-period arithmetic and the authenticated API behavior.

## Safety and recovery

- Authentication-disabled instances, API-key-only requests, platform staff and anonymous requests cannot invoke initialization.
- Primary, old, mismatched, populated, payment-linked, already operational, or multiple-user companies are rejected.
- Users, roles and sessions are preserved exactly; the fixture contains no credentials or users.
- The verified pre-seed snapshot stays private under data storage, never the public-file allowlist. Cloud-enabled operation also requires the existing verified cloud backup flow to succeed first.
- Partial persistence failure returns an error. Refresh and retry the same target; the endpoint never restores the seed over presenter changes.
- Data reset or rollback is a separate operator-reviewed action. Do not overwrite the tenant, restore auth records blindly, or reset an unrelated demo.

## Verification

Run `npm run check` and `npm test`. Focused coverage is in `sales-demo-data.test.js`, `sales-demo-route.test.js`, `sales-demo-ui.test.js`, and `demo-polish.test.js`. The local tests cover authorization, revision guard, backup before mutation, settling failed concurrent writes, tenant isolation, unchanged credentials/sessions, private recovery files, safe retries, schema references, historical arithmetic, DST, notes/history, review/approval/fixed export, cancel, repeated clicks and stale UI navigation. Tests use only synthetic local authentication and disable email, billing, AI and live cloud services.

The source generator can also prepare an offline review package with `node scripts/prepare-sales-demo.js --output <new-directory> --as-of YYYY-MM-DD`. That command writes only new local files and refuses an existing output directory. Its fixture ID is not proof of a live account.
