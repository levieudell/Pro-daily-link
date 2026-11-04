# Paid signup

New accounts choose a plan, review the amount due, create their account and continue to Stripe Checkout. Workspace access stays locked until the server verifies a paid invoice for the correct subscription, customer and provider mode. Checkout retries reuse the account and pending checkout. Signing in resumes billing with the saved billing cycle.

Existing companies are not migrated. Existing trial deadlines and anchored free periods remain intact. Standard prices, founder prices, plan limits and setup offers are unchanged.

Validation: `subscription-checkout.test.js` exercises all six standard plan/cycle combinations, payment ownership, unpaid/zero-dollar invoices, webhook/confirmation replay, checkout reuse and existing trial deadlines. `paid-signup.browser.test.js` checks phone/desktop signup, charge disclosure, error/retry, and locked-workspace billing resume in both themes. Provider traffic is mocked; no live charges are created.

Screenshots: `plan-{390,1280}.png`, `payment-{390,1280}.png`, and `resume-{light,dark}-390.png`.

## Verification result

- `npm run check`: passed.
- All test groups in `npm test` passed across the initial run and resumed runs. The full command first stopped at an old public-header cache-version assertion (updated), then at the schedule drag fixture moving into an occupied day. That collision was reproduced on unchanged main; a separate test-only commit now chooses an empty day and passes. No schedule application code changed.
- The remaining application tests completed successfully. One existing daily-status browser timeout passed on retry. `test:extras` and `signup-durability.test.js` also passed.
- New billing coverage and the signup/resume browser test passed both directly and in the resumed application suite. All provider traffic was mocked.
- Not pushed or deployed. Regenerated screenshots from unrelated tests remain unstaged.
