# Pro Daily Link launch connections

Run `npm run launch:check` after adding the values below. This command checks configuration presence and database reachability; it never prints secrets. Exit 0 means configuration is complete; it does not certify payment processing, delivery, alerts, or recovery. All missing advertised service configuration returns exit 1. Both historical checker entry points use the same policy. Complete the [launch acceptance ledger](docs/ROADMAP-STATUS-2026-10-04.md) separately.

## Already connected

- Supabase: `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, and `PDL_SUPABASE_ENABLED=1`
- Public app: `PDL_PUBLIC_URL=https://pro-daily-link-demo.onrender.com`
- Authentication: `PDL_REQUIRE_AUTH=1`

## Connect when the accounts are ready

### Stripe

Add these Render environment variables:

- `STRIPE_SECRET_KEY`
- `STRIPE_PRICE_STARTER`
- `STRIPE_PRICE_STARTER_ANNUAL`
- `STRIPE_PRICE_GROWTH`
- `STRIPE_PRICE_GROWTH_ANNUAL`
- `STRIPE_PRICE_PRO`
- `STRIPE_PRICE_PRO_ANNUAL`
- `STRIPE_WEBHOOK_SECRET`

Create recurring Stripe prices for each billing interval:

- Starter: $99 monthly and $990 annually
- Growth: $199 monthly and $1,990 annually
- Pro: $399 monthly and $3,990 annually

After this change is merged and deployed, create a **test-mode** snapshot event destination at:

`https://pro-daily-link-demo.onrender.com/api/billing/webhook`

Confirm this is the intended Render service before registering the destination. Subscribe to:

- `checkout.session.completed`
- `checkout.session.async_payment_succeeded`
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `invoice.paid`
- `invoice.payment_failed`

Save that destination's signing secret as `STRIPE_WEBHOOK_SECRET` in the same Render service and redeploy. Use a test secret API key and test prices for acceptance testing. Never paste Stripe keys into GitHub or chat. Existing live destinations for earlier versions of the app should not be changed as part of this test setup.

Verify a real test-mode checkout from a disposable Pro Daily Link company, then test a plan change, failed payment, cancellation, and replay of a delivery. Confirm 2xx responses in Stripe Event deliveries and the matching company's billing status in the app. Unrelated Stripe fixtures without subscription `company_id` metadata are acknowledged but ignored; they do not prove billing synchronization. No live charges are required.

The handler verifies raw request bytes with the official Stripe SDK before selecting a company. It retrieves current subscription state to handle delayed events, serializes updates, and acknowledges only after persistence completes. Failed Stripe or storage calls return 5xx for retries. Duplicate event IDs are retained for the most recent 200 deliveries; older replays still apply current subscription state. This uses the app's existing single-process tenant queues; multiple server instances require a shared transactional event store before scaling.

Local verification: `npm run check` and `npm test`. The webhook tests use a fake signing secret, temporary company files, and mocked Stripe GET requests; they never charge a card.

### Password-reset email

Verify `prodailylink.com` with Resend, then add:

- `RESEND_API_KEY`
- `RESEND_FROM=Pro Daily Link <support@prodailylink.com>`

### AI features

Add `OPENAI_API_KEY` for Spanish translation and scanned-estimate extraction. The app keeps its safe fallback behavior when this is missing.

### Error monitoring

Create a Sentry Node project and add `SENTRY_DSN`. The server integration is already installed and sends request IDs, request methods, and route names without customer field notes, photos, passwords, query strings, or personal data. Optional: set `SENTRY_TRACES_SAMPLE_RATE` (the default is `0.05`).

### Backup restoration

The existing `npm run backup:restore-drill` checks a local snapshot copy and, when explicitly run with Supabase configured, creates/downloads a private snapshot and verifies its bytes. It does not restore a new tenant, attachments or application workflows. Obtain approval for the production tenant scope and an isolated destination before a real restore, then follow [DATA-RECOVERY.md](docs/DATA-RECOVERY.md). The public health receipt records only completed single-tenant snapshot verification; see [the evidence contract and remaining gates](docs/BACKUP-VERIFICATION-2026-10-05.md).

## Final launch checks

1. Run `npm test`.
2. Run `npm run launch:check` in the production environment.
3. Complete a Stripe test checkout, plan change, failed-payment test, cancellation, and customer-portal return.
4. Request and use a password-reset email.
5. Run `npm run backup:restore-drill` and retain the successful output with the launch checklist.
6. Run the two-company tenant-denial suite.
7. Confirm legal terms, privacy policy, support contact, and data-retention policy.
