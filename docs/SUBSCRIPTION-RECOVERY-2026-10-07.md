# Standard subscription trial and recovery

Choosing a standard monthly or annual plan during the free trial now sends the original trial end to Stripe Checkout. It does not restart the trial, change the stored deadline, or activate access merely because Checkout opens. Standard prices and plan entitlements are unchanged.

Checkout requires its trial end to be at least 48 hours ahead and its session to last at least 30 minutes. Sessions expire before that boundary, with a one-minute margin. When too little trial remains, the API returns409 with a preserved-trial message: return when the trial ends to choose a paid plan. There is no early-charge fallback or trial extension. A deferred payment-method collection flow for that window is outside this repair.

A canceled standard subscription can start a replacement only after fresh Stripe reads verify ownership, mode, terminal status (`canceled` or `incomplete_expired`), previous completed Checkout and customer subscription history. Any nonterminal subscription, incomplete history, provider error or ownership mismatch fails closed. Customer identity remains; retired subscription IDs prevent late webhook deliveries or old confirmation links from overwriting the replacement. A returning subscription receives no new trial. Founder recovery requires support review and preserves existing setup/protection terms; exempt/legacy policy is unchanged.

Each tenant's existing request queue serializes create/restore/checkout writes. Failed or concurrent Checkout requests recover the saved attempt, exact parameters and provider idempotency key. A plan change cannot bypass an unresolved creation. Ambiguous legacy creation attempts, expired retry windows or changed price configurations require support review rather than risk a second session. Active project creation and archived-to-active restoration share the same cap; idempotent restoration of an already-active project succeeds. Existing records above the cap are retained, with no retroactive archive or deletion.

## Validation

`node subscription-checkout.test.js` exercises local HTTP signup/checkout/confirmation/webhook/project routes with synthetic tenants and intercepted Stripe traffic. Coverage includes all six standard prices, original/near-end/expired trials, terminal recovery, provider failures and ownership/mode history checks, concurrent retries, late events and confirmation links, active subscription protection, founder support review, and restore/create capacity races. All existing test and syntax commands remain in the package scripts, including assistant/import release checks.

Isolated desktop/mobile Chromium tests verify the trial date/message, selectable canceled plan, retained invoices action, clear near-end refusal, project restore cap error and mocked replacement navigation. No actual provider acceptance is implied by those tests.

## Deployment and recovery

This is an additive tenant JSON change, with no SQL migration, credential/config changes or mass customer updates. New fields are `stripeTrialUsed`, `retiredStripeSubscriptionIds` and durable `pendingCheckout.params/createdAt`. Earlier paid subscriptions remain protected by fresh provider checks even if the new fields are absent. Pre-repair open Checkouts lacking the preserved trial parameters are expired before replacement; ambiguous pre-repair creation attempts require support.

For containment, set `PDL_CHECKOUT_DISABLED=1`: new Checkout POSTs return503 without provider calls, while existing subscriptions, webhooks, invoices and workspace access continue. No such setting is changed by this draft. Preserve repaired webhook/confirmation guards and the added fields when reverting unrelated UI. A blanket rollback to pre-repair billing code is unsafe: it ignores retired IDs and can resume early-charge behavior. Back up tenant state before rollout; do not delete retired IDs, reset trial dates or cancel provider subscriptions as a rollback step.

Before release, recheck main and review the exact combined head. Keep the current single-process tenant serialization model; this patch does not add distributed locking for horizontally scaled snapshot writers. Actual Stripe sandbox acceptance of absolute trial deadlines/session expiry and canceled replacement remains to be exercised separately. Prior successful paid sandbox activation remains valid; this draft is not merged or deployed by its author.
