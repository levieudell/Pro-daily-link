# Dedicated synthetic sales demo

This is a one-time, data-only initializer for a new, separately registered company named exactly `DEMO | Alder Ridge Builders`. It does not create or copy an account, password, session, role or support grant. The owner establishes their login through normal signup and enters their own password.

## Supported workflow after this release is deployed

1. The owner completes the normal self-serve, no-card signup using the exact demo company name and their chosen email. They accept the linked Terms/Privacy themselves. Keep the existing owner session. Do not purchase a plan, request paid onboarding, invite employees or connect Stripe.
2. An already signed-in platform owner opens Platform Operations → Customer health → All accounts, locates this exact new company, and clicks **Prepare sales demo**. The ordinary company-owner login alone does not authorize this action.
3. Preview checks the exact tenant, age (under 24 hours), revision, one existing active owner, absence of operating records and payment links. The confirm screen explains the synthetic content. If time cards were explicitly disabled, use the existing platform feature control to enable them first.
4. Initialization verifies a pre-seed private recovery backup, then saves the fixture under the target tenant's normal write queue and snapshot/transactional controls. The response waits for all started durable writes, even when one fails. A repeat retries persistence of current demo data and never resets presenter edits.
5. The success link opens `/app?tenant=<the exact returned company ID>`. Use that company's existing owner login. It is a tenant-selection link, not an access grant.
6. Verify 3 projects, 8 employees, 60 reports, 160 time cards and 75 schedule entries. Reload and check the totals again before presenting. Real browser rendering and real-cloud persistence must be verified after deployment.

The dedicated demo is marked `demo: true`, `billingExempt: true` and `planPrice: 0`; there are no Stripe customer/subscription links. Existing customer-metric filters exclude demos; it does not create paid revenue. Normal primary-demo reset remains available only for its supported primary tenant. The dedicated demo has no destructive reset control.

## Data story

Four full weeks precede the current calendar week in America/Los_Angeles. All people, customers, projects and operating history are marked DEMO. Reserved `.example` addresses and 555 numbers are used. No photos or outside links are seeded. Historical workdays are complete, with nonoverlapping shifts and explicit meal breaks; no indefinitely running clocks are invented.

Before review: 58 approved reports, two review reports, 155 approved cards (1,240 hours), four submitted cards (32 hours), and one draft card (8 hours). Three closed weekly exports each contain 320 hours. The last period contains 280 approved hours and stays blocked until review is complete. Production and fixed exports use the application's own modules.

Cedar Grove: 13,200 SF / 480 hours / 110% efficiency. Juniper: 11,340 SF / 456 hours / 89.53%; header staging is its recovery to-do. Harbor: 8,025 SF / 304 hours / 105.59%. Approval of the two remaining reports yields Juniper 12,000 SF / 480 hours / 90% and Harbor 8,500 SF / 320 hours / 106.25%. These are fictional figures, not evidence of production results or actual payroll payments.

## Safety and recovery

- Authentication-disabled instances, API-key-only requests, platform staff and anonymous requests cannot invoke initialization.
- Primary, old, mismatched, populated, payment-linked, already operational, or multiple-user companies are rejected.
- Users, roles and sessions are preserved exactly; the fixture contains no credentials or users.
- The verified pre-seed snapshot stays private under data storage, never the public-file allowlist. Cloud-enabled operation also requires the existing verified cloud backup flow to succeed first.
- Partial persistence failure returns an error. Refresh and retry the same target; the endpoint never restores the seed over presenter changes.
- Data reset or rollback is a separate operator-reviewed action. Do not overwrite the tenant, restore auth records blindly, or reset an unrelated demo.

## Verification

Run `npm run check` and `npm test`. Focused coverage is in `sales-demo-data.test.js`, `sales-demo-route.test.js`, and `sales-demo-ui.test.js`. The local tests cover authorization, revision guard, backup before mutation, settling failed concurrent writes, tenant isolation, unchanged credentials/sessions, private recovery files, safe retries, schema references, historical arithmetic, DST, notes/history, review/approval/fixed export, cancel, repeated clicks and stale UI navigation. Tests use only synthetic local authentication and disable email, billing, AI and live cloud services.

The source generator can also prepare an offline review package with `node scripts/prepare-sales-demo.js --output <new-directory> --as-of YYYY-MM-DD`. That command writes only new local files and refuses an existing output directory. Its fixture ID is not proof of a live account.
