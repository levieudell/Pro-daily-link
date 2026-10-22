# Stripe billing operations

This runbook is the source of truth for Pro Daily Link billing configuration. Repository tests prove policy and request construction; they do **not** prove live provider delivery. Never paste Stripe keys, webhook signing secrets, customer data, or full webhook payloads into logs or evidence.

## Required webhook inventory

Production must have exactly one enabled Pro Daily Link endpoint at:

`https://app.prodailylink.com/api/billing/webhook`

It must subscribe to all of these events:

- `checkout.session.completed`
- `checkout.session.async_payment_succeeded`
- `checkout.session.async_payment_failed`
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `invoice.paid`
- `invoice.payment_failed`

The legacy Supabase and Base44 endpoints must be disabled, not immediately deleted, so rollback evidence remains available. `node scripts/service-smoke-test.js` fails closed when the official event set is incomplete, an identifiable legacy/duplicate PDL endpoint is enabled, pagination is incomplete, or the restricted key cannot enumerate endpoints. An explicit `unknown` is never launch-green. The active independent run verifies all six standard prices, all six founder prices, and the one-time Assisted Setup price against their intended active Product IDs. Every recurring price must be live, active, USD, fixed `per_unit`, `licensed`, non-tiered, non-metered, without quantity transformation or aggregate usage, and have its exact amount/interval/count. Assisted Setup must be a live active fixed one-time price with no recurring object. Checkout repeats the same semantic validation immediately before creating a Session.

Webhook processing verifies the raw-body signature and provider mode, retrieves the current Subscription from Stripe, checks tenant/customer/subscription ownership, ignores retired subscriptions, and records bounded event IDs for retry idempotency. Both delayed-payment success and failure reconcile from the current Subscription rather than trusting an event snapshot. Handled failures send only a scrubbed exception and static route to Sentry; payloads, signatures, object IDs, and customer data are never attached.

## Checkout and payment methods

Checkout does not send `payment_method_types`. Stripe therefore presents only payment methods enabled and eligible in the account configuration. Do not enable a delayed method unless both async Checkout events above are subscribed and the production monitor is green.

The server validates every configured price for active status, live/test mode, currency, amount, billing interval, and interval count. Checkout creation uses a durable tenant attempt plus a provider idempotency key. A stale, ambiguous, or ownership-mismatched attempt fails closed instead of risking a second subscription or free trial.

## Portal configurations and plan changes

Use two dedicated Customer Portal configurations; do not depend on the account-wide default:

1. `STRIPE_PORTAL_CONFIG_STANDARD` must enable subscription price updates and contain **exactly** the six current standard monthly/annual price IDs. It must not contain founder or legacy prices.
2. `STRIPE_PORTAL_CONFIG_FOUNDER` must keep subscription updates disabled. It may allow payment-method updates, invoices, and the approved cancellation policy.

The server retrieves and validates the selected configuration before creating a portal session. Missing any one of the six standard price environment values is itself unsafe; a five-price environment can never validate a five-price portal. Missing, wrong-mode, inactive, incomplete, permission-unknown, or unsafe configurations fail closed. Standard subscribers change plans in their dedicated portal. Founder subscribers see only their protected plan and are directed to support for a reviewed change; a global portal toggle cannot expose founder prices.

## Active provider evidence

The six-hour independent workflow runs `npm run services:verify-active`. It makes no charge and changes no Stripe object. It uses a least-privilege live restricted key to read provider state, sends one controlled message to the approved monitor inbox and confirms Resend reports `delivered`, sends one scrubbed Sentry verification event and retrieves it from the intended project, and then publishes a signed immutable readiness attestation to private Supabase Storage. It publishes nothing when a provider is unavailable, access is insufficient, inventory pagination is incomplete, either portal is unsafe, delivery is not observed, or any check is unknown.

Render has only the Ed25519 public key. The private key stays in the independent workflow secret store. `/api/health` reads and verifies the evidence; it never calls Stripe, sends an email, emits a Sentry test, or creates a charge. The attestation expires after 12 hours and is bound to the exact production URL, Supabase project, portal IDs, all price and Product IDs, sender, reply-to, and four operator-managed runtime-credential version labels. Runtime Stripe, webhook, Resend, and Sentry configuration must also be present locally. Never derive a version label from credential bytes; use an opaque rotation label and change it in both GitHub and Render whenever the corresponding runtime credential rotates. A revoked monitor credential prevents the next receipt; a rotated runtime credential invalidates the old target immediately.

## Founder renewal operation

The first confirmed founder payment creates the existing 24-month Stripe Subscription Schedule with `end_behavior=cancel`; there is no silent jump to standard pricing. The app records the protected-through date and runs internal 90-, 60-, and 30-day review reminders. Reminders:

- are sent only to active platform owners through the existing founder-alert channel;
- are stored per tenant, retry no more than daily after a delivery/configuration failure, and never send a stack of missed milestones at once;
- remain visible in customer health until a renewal decision is operationally resolved; and
- are audited as sent, suppressed, skipped, or failed without storing email credentials.

Before accepting a founder payment, exercise the complete schedule, webhook, retry, cancellation, and reminder path in an isolated Stripe sandbox. Mocked tests are not provider evidence.

## Enterprise agreements and invoices

Enterprise remains a quoted, written agreement. Prefer a Stripe Customer plus Stripe Invoice or Subscription so payment status, retries, cancellation, and reconciliation stay in the same provider lifecycle as the app.

A Mercury invoice by itself must **never** grant, extend, or reactivate application access. If a customer must pay through Mercury:

1. execute the written order form and identify the exact tenant, plan limits, term, price, start/end dates, cancellation terms, and support owner;
2. wait for cleared payment evidence—an invoice being sent is not payment;
3. have an authorized platform owner record the external invoice/payment reference and approved entitlement in the back office without copying bank credentials or sensitive payment data;
4. record an audit event linking the commercial decision to the tenant;
5. independently reconcile the entitlement, cleared payment, renewal date, and Stripe status at least monthly; and
6. revoke or change access only through the documented account lifecycle, never by editing tenant files or Stripe metadata by hand.

Do not use old active `Enterprise Custom`, `Solo Contractor`, `Team Pro`, additional-user, IronGrade, or additional-project prices until each object is mapped and explicitly approved. Archive obsolete catalog objects only after confirming no customer, subscription, schedule, invoice, portal configuration, or payment link references them.

## Safe live rollout

Provider changes require explicit approval. Make them in this order:

1. deploy code that handles both async Checkout outcomes and validates both portal configurations;
2. add both async events to the official webhook;
3. create the separate standard/founder portal configurations and set their IDs in Render;
4. disable the old Supabase and Base44 webhooks;
5. configure the independent provider workflow secrets, run `npm run services:verify-active`, and require a fresh signed receipt plus `/api/health` HTTP `200`;
6. run an isolated test-mode Checkout, delayed-success/failure webhook replay, subscription update, portal return, cancellation, and founder schedule test; and
7. retain scrubbed evidence plus the exact release SHA.

The independent verifier runs only from `main` in the protected `production-provider-readiness` GitHub environment. Configure that environment with no required reviewers or wait timer, administrator bypass disabled, and deployment branches set to **Protected branches only** while `main` remains protected. The workflow's ref guard rejects non-`main` runs. The six-hour schedule and a manual verification dispatch must never wait for per-run human approval; explicit approval is still required before changing provider objects, credentials, or runtime configuration. Third-party actions are SHA-pinned. Dependency installation uses `npm ci --ignore-scripts` with no production provider secret in scope; secrets are injected only into the direct verifier step. The four rotation labels are GitHub environment **variables**, not secrets. Keep every actual key, token, ID, signing key, recipient, and private-storage credential in environment secrets.

Do not rotate the API key or webhook secret during this rollout unless compromise is suspected. A signing-secret rotation is a separate coordinated deploy/rollback procedure; the existing multiple-signature parser test is not rotation evidence.
