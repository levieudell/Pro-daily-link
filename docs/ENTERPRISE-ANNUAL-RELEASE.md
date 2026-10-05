# Enterprise annual quotes: implementation and release gates

## Commercial boundaries

No customer offer, price, currency, user/project limit, scope, cancellation policy, or refund policy is preselected. Platform Owners enter these in a private draft. A separate review/approval makes that exact version visible to that company's account owner. Drafts never grant access or contact Stripe. Editing an issued quote requires cancellation and a replacement.

This workflow implements one annual term paid upfront, beginning when successful payment is verified by the server. The annual end uses calendar-year arithmetic, including leap-day clamping. Every renewal requires manual review and a new quote; there is no recurring subscription or automatic renewal. A renewal draft can be prepared ahead of time, but it cannot be issued/paid until the previous term ends and outstanding payment reviews are resolved. Seamless advance-paid renewals and migrations from existing founder, subscription, complimentary, or demo accounts are intentionally not automatic.

The annual total is an explicit two-decimal-currency amount, including any applicable tax. The creator must select either tax included or tax not applicable. The integration does not enable automatic tax or infer registrations. Features (time cards and templates) and limits (including explicit unlimited values) are included in the approved quote.

## Application workflow

- Platform console → Manage Enterprise annual quotes (`/enterprise.html?platform=1`). Requires an active signed-in Platform Owner. A bootstrap/platform API key and support/billing staff cannot read or change quotes.
- Select a company, create/edit a private draft, review its exact contents, and issue it. No email or automatic message is sent.
- Company Account Owner → Manage plan → Review Enterprise annual quotes (`/enterprise.html`). Other company roles cannot read or pay quotes. Drafts are excluded from company state and exports.
- The Account Owner reviews the exact quote and accepts its version before continuing to hosted Stripe Checkout. This creates a one-time payment Checkout Session, not a subscription or invoice.
- Only a verified webhook can activate Enterprise access. A success URL/session ID cannot activate or change the plan.
- Cancellation expires an unpaid Checkout Session first. Complete/processing payments require billing review; the application does not refund money.
- Expired or failed Checkout Sessions require a replacement quote. Refunds and unresolved disputes suspend the affected term pending review. Fully refunded payments remain locked. Won/closed-warning disputes can recover only when Stripe's current payment/charge state verifies.

## Security and reliability

Quotes are stored in the existing company snapshot/transactional persistence. No schema migration is needed. All commercial mutations use the tenant queue and durable persistence. Cross-company platform routes acquire only the target tenant queue to avoid lock-order cycles.

The immutable Checkout parameters and idempotency key are durably saved before Stripe is contacted. Repeated clicks and uncertain network responses reuse the exact request. A creation whose result remains unknown after 23 hours is blocked for manual Stripe review, so expiration of Stripe's idempotency retention cannot create a second payment. Cancellation of an uncertain creation first resolves the same idempotency key within that window.

Webhook entry uses the existing raw-body signature/mode validation. Enterprise fulfillment retrieves the saved Checkout Session and its PaymentIntent/current charge from Stripe. It validates the stored session ID, exact tenant, quote ID, terms digest, amount, currency, mode, customer, successful payment/charge state, refunds, and disputes. Event metadata only selects the lookup; it cannot grant access. Duplicate events re-persist after cloud failures. Out-of-order events use current Stripe state, and historical quotes cannot replace a newer nonoverlapping term.

Company owner acceptance and Platform Owner issue/cancel actions are recorded with actor IDs and timestamps in the tenant's quote audit trail. Founder/standard subscription behavior is retained, and old subscription events cannot overwrite verified Enterprise access. Generic feature toggles cannot contradict a paid Enterprise quote.

## Default-off and live activation gates

`PDL_ENTERPRISE_CHECKOUT_ENABLED=0` by default. Auth must also be enabled, with existing Stripe key, webhook signing secret and secure public URL. Do not enable checkout until all gates below pass. The code/feature flag alone is not proof of operational readiness.

1. Review the specific customer's annual total, currency, limits, scope, tax treatment, cancellation/refund policies and manual-renewal terms before issuing a real quote. This release creates no real quote or charge.
2. Obtain any required approval for Stripe credentials, persistent permissions or webhook security/configuration changes. Use a separate Stripe sandbox for integration proof; no live payment writes are part of the synthetic tests.
3. Verify the authenticated webhook endpoint subscribes to `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`, `charge.refunded`, `charge.dispute.created`, `charge.dispute.updated`, `charge.dispute.closed`, and `refund.updated`. Preserve the standard subscription/invoice event types.
4. Verify API permissions for creating/retrieving/expiring Checkout Sessions, reading PaymentIntents and charges, and listing disputes. No new credential is created by this code.
5. In the sandbox prove a paid checkout activates exactly its company, delayed success grants nothing early, failure/expiry grants nothing, duplicate delivery is safe, refund/dispute suspends appropriately, and no automatic charge exists at annual expiry.
6. Run the complete suite, independent security review, exact-commit CI, and authenticated browser QA at desktop/mobile widths. Synthetic UI fixtures do not substitute for visual/accessibility QA.
7. Confirm persistence/backup health and the recoverable deployment commit. Enable the flag only under the owner's authorized release process.

## Checks

`node enterprise-billing.test.js` covers commercial validation, inert drafts, immutable/idempotent requests, default-off behavior, founder/standard preservation, mapping/mode/amount/currency/customer forgery, paid/delayed/failed payment states, annual dates, cancellation, refunds/disputes, current-state replay and cloud-save retry.

`node enterprise-api.test.js` exercises the actual HTTP server with synthetic sessions and a fake Stripe client: strict roles, private drafts, authenticated tenant selection, unsigned-webhook rejection, company-bound activation, persisted contract features/limits, locked billing recovery and private source denial. It makes no external Stripe requests.

`node enterprise-ui.test.js` checks escaped commercial text, explicit review actions, exact decimal amounts and source-level interruption/double-click guards. Browser QA remains a separate gate.

## Recovery

Disable `PDL_ENTERPRISE_CHECKOUT_ENABLED` to stop new Checkout Sessions. Keep verified webhook processing running for sessions already created; disabling checkout must not abandon payments in flight. Cancel/expire a known unpaid session through the reviewed quote action. For an uncertain result older than 23 hours, locate the quote/session in the Stripe Dashboard and reconcile the existing payment before creating any replacement. Never delete quote/payment history to bypass a review.

A code rollback is straightforward before any Enterprise quote is paid. After a paid Enterprise term exists, keep the Enterprise access reader/webhook handler or deploy a forward fix: rolling back to pre-Enterprise code could misclassify the plan or ignore a refund. Preserve tenant snapshots and quote history. This is a material release consideration, not a reason to improvise customer terms or issue a refund.
