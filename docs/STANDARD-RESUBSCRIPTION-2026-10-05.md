# Standard subscription recovery

## Supported boundary

A company on a standard Starter, Growth or Pro subscription may begin a new Checkout only after Stripe confirms that its exact stored subscription is `canceled` or `incomplete_expired`. A local `Cancelled` label is not sufficient. The retrieved subscription must match the stored company ID, customer ID, live/test mode and a recognized standard price.

Active, trialing, past-due, unpaid, paused or incomplete subscriptions are not treated as terminal. Scheduling cancellation at period end does not make an active subscription terminal. Founder, complimentary, demo and Enterprise migrations remain separate reviewed workflows; this change cannot bypass their pricing or access safeguards.

An incomplete replacement can reopen its same saved, strictly bound open Checkout. It cannot create another subscription, change plans or reuse a different customer's session. This supports a declined-card retry without a generic existing-subscription bypass.

## Verified customer controls

Billing refresh exposes restart/resume capabilities only after a fresh successful provider check. A local `Cancelled` label or stale capability is never sufficient. Capability flags default to false, are not persisted, and resume is tied to the exact pending plan and billing cycle. The current-plan button says **Restart plan** or **Resume checkout** only when the matching verified capability is available; founder controls remain protected. A provider outage removes availability. DOM/matrix tests cover this behavior; real-browser visual verification remains a release gate.

## Persistence and replay protections

- Record the prior subscription as retired before contacting Stripe for a replacement. Preserve its identity permanently so delayed events cannot revive it or cancel a newer subscription.
- Reconcile any saved old Checkout. A completed session must belong to the same terminal subscription; an open or uncertain old session requires review.
- Save the replacement attempt and exact request parameters before provider contact. Lost-response retries reuse identical parameters and the same idempotency key.
- Do not create a different payment after an uncertain result by changing plans. An uncertain creation older than 23 hours requires payment review rather than risking expiry of Stripe's idempotency protection.
- Inspect any subscription already attached to a pending Checkout, even when its webhook has not stored the local subscription ID yet. Nonterminal state cannot be bypassed by changing plans or expiring the session. Re-read after expiration to catch a subscription appearing during that race.
- Pin new session/subscription metadata to the saved attempt, prior subscription, company and customer. Expired/replaced attempts cannot activate later through delayed webhooks.
- Grant replacement access only after matching subscription state and a paid invoice are verified. Unexpected trialing state stays locked. The success-page return never grants replacement access.
- Save confirmed entitlement and retired history through the existing tenant persistence. Internal request parameters and retirement evidence are not included in broad company-state responses or customer exports.

No provider settings, prices, legal terms, invoices, live charges or production records are changed by the implementation/tests. The existing standard Checkout payment-method configuration is preserved; enabling asynchronous methods is a separate provider acceptance change.

## Still outside this change

The observed live customer portal has subscription changes disabled. Standard plan changes require a separately approved commercial/provider configuration decision and sandbox acceptance. This code does not enable them or invent an upgrade/proration policy. Founder renewal, Enterprise migration and uncertain or mismatched billing identities require explicit review.

A connected Stripe sandbox with matched test prices and a signed destination remains necessary to certify the actual provider lifecycle. Local tests use synthetic companies, fake keys and mocked provider responses; they do not place real charges or establish browser/mobile usability.

## Verification and recovery

The pure-policy and synthetic HTTP tests cover accepted terminal states, denied nonterminal states, period-end cancellation, customer/company/price/mode mismatches, founder protections, uncertain old Checkout, provider failures, double clicks, lost responses, stable idempotency, paid-invoice activation, declined-card resume, trial denial, stale events, private internal fields and a real application-process restart.

Run the complete suite after integrating other billing work. Preserve the Enterprise quote guards and PR46 backup/awaited-queue fix. A narrow code revert is available without a schema migration; keep recorded retired IDs and replacement metadata intact so recovery does not accidentally revive old subscriptions. Production data or payment changes during recovery require separate authorization.
