# Pro Daily Link launch connections

Run `npm run launch:check` after adding the values below. The command reports only whether each value works; it never prints secrets.

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

Use recurring monthly Stripe prices for $79, $179, and $349. The webhook destination will be the production Pro Daily Link webhook endpoint after its final verified-handler cutover. Never paste Stripe keys into GitHub or chat.

### Password-reset email

Verify `prodailylink.com` with Resend, then add:

- `RESEND_API_KEY`
- `RESEND_FROM=Pro Daily Link <support@prodailylink.com>`

### AI features

Add `OPENAI_API_KEY` for Spanish translation and scanned-estimate extraction. The app keeps its safe fallback behavior when this is missing.

### Error monitoring

Create a Sentry Node project and add `SENTRY_DSN`. Do not include customer field notes or photos in error payloads.

## Final launch checks

1. Run `npm test`.
2. Run `npm run launch:check` in the production environment.
3. Complete a Stripe test checkout, plan change, failed-payment test, cancellation, and customer-portal return.
4. Request and use a password-reset email.
5. Restore a verified Supabase backup into an isolated test tenant and compare record totals.
6. Run the two-company tenant-denial suite.
7. Confirm legal terms, privacy policy, support contact, and data-retention policy.
