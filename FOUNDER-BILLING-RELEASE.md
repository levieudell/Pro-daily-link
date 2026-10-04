# Founder billing release checklist

Status: implementation branch only. Not enabled in production. Do not merge as a declaration of payment readiness.

Later observation (2026-10-04, 18:01 UTC): main `6328586` is deployed and the canonical app's founder-offer endpoint reports enrollment enabled. The status above is historical. This does not certify live/test mode or payment readiness; the acceptance checklist below remains open until dated provider evidence is recorded in [the launch ledger](docs/ROADMAP-STATUS-2026-10-04.md).

## Offers
Standard: Starter $99/month or $990/year; Growth $199/month or $1,990/year; Pro $399/month or $3,990/year.
Founder: $79/$790, $159/$1,590, $319/$3,190 respectively, same limits.
Optional Assisted Setup: $499 once, remote 90-minute setup/training for one project and crew using supplied information, plus a 30-minute follow-up within 14 days; no travel or extensive data entry.
Regular signup retains its 14-day no-card trial. Invited founder signup creates a locked account, then pays immediately. No trial is granted.

## Founder renewal policy
Founder pricing is protected for 24 months from first successful payment. The Stripe schedule ends after the protected period rather than silently increasing to regular pricing. Pro Daily Link must contact the founder before that date, discuss continued service and obtain agreement to any renewal price. Add 90-day, 60-day and 30-day internal follow-ups before enabling live founder sales.
Confirm portal behavior for cancellations and plan changes: scheduled subscriptions must not lose price protection or bypass the schedule.

## Environment
Keep test credentials, webhook signing secret, and TEST prices together until acceptance passes.
Founder invitation is disabled unless PDL_FOUNDER_ENABLED=1.
Set PDL_FOUNDER_CODE privately in Render. Never commit it or expose it through the offer endpoint.
Required:
- STRIPE_SECRET_KEY
- STRIPE_WEBHOOK_SECRET
- PDL_PUBLIC_URL
- STRIPE_PRICE_STARTER / STRIPE_PRICE_STARTER_ANNUAL
- STRIPE_PRICE_GROWTH / STRIPE_PRICE_GROWTH_ANNUAL
- STRIPE_PRICE_PRO / STRIPE_PRICE_PRO_ANNUAL
- STRIPE_PRICE_FOUNDER_STARTER / STRIPE_PRICE_FOUNDER_STARTER_ANNUAL
- STRIPE_PRICE_FOUNDER_GROWTH / STRIPE_PRICE_FOUNDER_GROWTH_ANNUAL
- STRIPE_PRICE_FOUNDER_PRO / STRIPE_PRICE_FOUNDER_PRO_ANNUAL
- STRIPE_PRICE_ASSISTED_SETUP

## Verified live catalog IDs (NOT test IDs)
| Offer | Monthly | Annual |
| --- | --- | --- |
| Standard Starter | price_1UKgkECArcaPfC98NyWW19LO | price_1UKgkjCArcaPfC98cNJD6Zbj |
| Standard Growth | price_1UKgixCArcaPfC98k1LaJ67E | price_1UKgjICArcaPfC98m0CurlrO |
| Standard Pro | price_1UKgiACArcaPfC98xGcCE9f9 | price_1UKgiVCArcaPfC98s7X3eFEL |
| Founder Starter | price_1UKgwNCArcaPfC98eIJx5T0V | price_1UKgwgCArcaPfC98qbpLEGCp |
| Founder Growth | price_1UKgvYCArcaPfC98q7JOnUjK | price_1UKgvwCArcaPfC98wRMhDiFg |
| Founder Pro | price_1UKgukCArcaPfC986kKA0Z9Y | price_1UKgv3CArcaPfC98hyP2Wlid |

Assisted Setup: price_1UKgxhCArcaPfC98ligmrfNX (one-time).
Product: prod_VLNjAEKhqigfQh.
Render was verified to use a TEST key on 2026-09-28. Do not paste these live IDs into that active test configuration.

## Verified in isolation
JavaScript syntax for changed application files.
Synthetic, mocked Stripe policy checks: invitation validation; selected plan; optional setup; same tier limits inherited; test/live price mismatch; incorrect amount/currency/interval; existing subscription guard; 24-month calendar/leap-day arithmetic; schedule retry; unpaid invoice; wrong company.
No live Stripe calls or customer charges in those tests.

## Acceptance still required
1. Run full existing test suite and new founder-billing.test.js.
2. Test regular signup and its 14-day trial unchanged.
3. Test all six founder choices; invalid code must create no company.
4. New founder account stays locked before verified payment. Cancelled checkout stays locked and can be resumed.
5. Double-click/retry returns the same session. Existing subscriber cannot create another subscription.
6. Test subscription-only and optional $499 initial invoice. Renewals must exclude the setup fee.
7. Verify signed webhooks reach the correct synthetic tenant, persist, and retry safely.
8. Test monthly and annual subscription schedules in Stripe test mode, including cancellation at the end of 24 months and internal 90/60/30-day renewal reminders.
9. Test declined payment, cancellation, portal behavior, and founder cohort/paid setup operations queue.
10. Test mobile signup consent, checkout return, cancelled checkout and account recovery.
11. Only after passing: set matching LIVE secret, LIVE webhook secret and the live catalog IDs, then enable invitation enrollment.

Existing customer records are not migrated. No custom quote price or payment link is created.
