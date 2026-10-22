# Production health contract

Pro Daily Link exposes two intentionally different health endpoints.

## `GET /api/health/live`

This is the Render liveness check. It proves the Node process can accept and answer HTTP requests. It does not read tenant data, contact Supabase, call Stripe or Resend, initialize Sentry, or inspect backup evidence. Render uses this endpoint so an expired backup or provider outage raises an alert without creating a restart loop.

The browser's wake-up retry uses the same endpoint. A customer can therefore reach the app and receive an honest provider-specific error even when operational readiness is degraded.

## `GET /api/health`

This is the production operational-readiness check used by monitoring. In production it returns HTTP `200` only when all of these are true:

1. Supabase is configured and reachable.
2. the tenant repository is configured in `primary` mode and its atomic loader and compact directory are reachable;
3. the platform repository is configured in `primary` mode and a live revision can be read;
4. a fresh, signed provider-readiness attestation proves a controlled Resend message reached `delivered`;
5. that same attestation proves the Stripe monitor key authenticated, all 13 standard/founder/setup prices match, exactly one official webhook has the complete required event set, no legacy PDL endpoint remains enabled, and both dedicated portal configurations are safe;
6. that same attestation proves a controlled scrubbed Sentry event was retrieved from the intended hosted project; and
7. the independent recovery-readiness attestation proves the exact live tenant population plus platform state has a fresh independently verified copy and exercised restore evidence.

A failed requirement returns HTTP `503`, `ok: false`, and a non-secret boolean in `requirements`. The response never returns credentials, provider error text, object keys, hashes, provider IDs, customer data, email addresses, or Sentry event contents. Provider evidence that is missing, malformed, unsigned, stale, signed for another target, or incompatible with the current Render product/price/portal/sender/reply-to/runtime-credential-version configuration is `unknown` or `stale`, never green. A signed provider receipt also cannot cover up a missing local `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `RESEND_API_KEY`, sender, reply-to, Sentry runtime, portal, price, or product setting: runtime configuration and independent evidence must both pass.

`/api/health` never sends email, creates a Sentry event, creates a charge, or mutates provider configuration. In production it only reads the current immutable provider attestation and pointer from the private `tenant-backups` bucket and verifies their Ed25519 signature, SHA-256, 12-hour freshness, and target binding. The complete read has a one-second default deadline (`PDL_PROVIDER_READINESS_TIMEOUT_MS`, bounded to 50–5000 ms); timeout is `unknown`, never green. Nonproduction health does not read provider evidence at all, which keeps local/test health independent of private storage. Configuration presence remains visible for diagnosis but cannot satisfy readiness.

The complete operational snapshot—including Supabase reachability, both repository probes, provider evidence, recovery evidence and authority comparison, and the tenant backup-authority read—has a five-second default deadline (`PDL_OPERATIONAL_HEALTH_TIMEOUT_MS`, bounded to 50–10000 ms). A dependency error or deadline returns a fail-closed `503`; a stalled provider cannot leave the monitoring request open indefinitely. Nonproduction health skips both recovery evidence and backup-authority reads.

Tenant writes acknowledge the authoritative database commit without waiting for the follow-up backup upload/download verification. That provider work runs outside the request and tenant queue, has a 60-second default deadline (`PDL_BACKUP_VERIFICATION_TIMEOUT_MS`, bounded to 50–120000 ms), and passes an abort signal through Supabase Storage calls. A timeout or provider error records a failed attempt without advancing the last verified timestamp; a later write retries after the normal backoff. The detached task has an explicit rejection handler, and shutdown still uses the process-wide bounded monitoring flush.

Outside production, optional service configuration is not required, but any repository explicitly set to `primary` still must be reachable.

## Alerting and release acceptance

- Point Render's service health check only at `/api/health/live`.
- Point the Pro Daily Link operational monitor at `/api/health` and alert on any non-`200` response or any requirement changing to `false`.
- Enable `.github/workflows/provider-readiness.yml` every six hours. It runs outside Render, performs the controlled provider checks, and publishes evidence only after every check is green. The private Ed25519 key belongs only in that independent runner; Render gets only `PDL_PROVIDER_ATTESTATION_PUBLIC_KEY`.
- Configure the workflow's least-privilege Stripe monitor key to read balance/account state, all prices, webhook endpoints, and billing-portal configurations. Inability to enumerate an entire webhook inventory or retrieve either portal config is `unknown`, not success.
- Configure `RESEND_MONITOR_API_KEY` to send and retrieve the controlled monitor message, and `SENTRY_MONITOR_AUTH_TOKEN` to retrieve the controlled event from only the intended project. Queued/flushed is not delivered/ingested.
- Treat a `503` as an incident to diagnose, not a reason to restart repeatedly.
- Before a release, verify both endpoints and confirm `/api/health` reports every production requirement as `true`.
- The signed Sentry receipt proves provider ingestion, not that a human received an alert. Exercise the named on-call alert route separately before launch and after alert-policy changes.
- Provider readiness does not replace payment-lifecycle acceptance or recovery evidence. Keep the Stripe test-mode lifecycle and independent portable-backup/restore gates separate.

The automated contract is covered by `operational-health.test.js`, `provider-readiness.test.js`, `service-smoke-provider.test.js`, and `service-smoke-stripe.test.js`. Repository-specific probes remain covered by `platform-repository-health.test.js` and `tenant-repository-health.test.js`.

## Independent provider verifier setup

The reviewed execution path is the scheduled or manually dispatched `.github/workflows/provider-readiness.yml` job. It is main-only, uses the protected `production-provider-readiness` GitHub environment, SHA-pins every third-party action, checks out without persisted credentials, installs dependencies with `npm ci --ignore-scripts` before any production secret exists in the step environment, and then invokes `node scripts/service-smoke-test.js --active --publish-readiness` directly. Do not run that command on Render. Require at least one human reviewer on that GitHub environment and restrict it to `main`; scheduled runs still need access to the protected environment. The verification step performs read-only Stripe retrievals, sends one controlled message to the monitor inbox and confirms its Resend delivery state, emits one scrubbed Sentry verification event and retrieves it from the intended project, and then writes only the signed readiness attestation and its pointer to private Supabase Storage. Publication is skipped unless the entire report is exactly green.

Configure these GitHub Actions secrets for the independent job:

- Supabase evidence storage: `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, and `PDL_PRODUCTION_SUPABASE_PROJECT_REF`.
- Signing: `PDL_PROVIDER_ATTESTATION_PRIVATE_KEY` (PKCS8 Ed25519 DER, base64) and its matching `PDL_PROVIDER_ATTESTATION_PUBLIC_KEY` (SPKI Ed25519 DER, base64).
- Stripe read-only verification: `STRIPE_MONITOR_KEY`, both `STRIPE_PORTAL_CONFIG_STANDARD` and `STRIPE_PORTAL_CONFIG_FOUNDER`, all six standard price IDs, all six founder price IDs, `STRIPE_PRICE_ASSISTED_SETUP`, and seven distinct intended Product IDs (one Product per standard, founder, and assisted-setup plan).
- Controlled email verification: `RESEND_MONITOR_API_KEY` and `PDL_MONITOR_EMAIL_TO`.
- Controlled Sentry verification: `SENTRY_DSN`, `SENTRY_MONITOR_AUTH_TOKEN`, `SENTRY_ORG`, and `SENTRY_PROJECT`.

Configure the four non-secret protected-environment variables `PDL_STRIPE_RUNTIME_KEY_VERSION`, `PDL_STRIPE_WEBHOOK_SECRET_VERSION`, `PDL_RESEND_RUNTIME_KEY_VERSION`, and `PDL_SENTRY_RUNTIME_DSN_VERSION` in GitHub and set the same values in Render. Use opaque operational labels such as `stripe-key-2026q4`, not hashes, prefixes, or fragments of credential values. Change the matching label every time that runtime credential rotates. Because the service only knows the labels, no key or secret value—or a guess-aiding hash of one—is included in the target digest.

Render must contain the same public target values, including the sender, reply-to, price IDs, Product IDs, portal IDs, runtime-version labels, and `PDL_PROVIDER_ATTESTATION_PUBLIC_KEY`, but **must never contain** `PDL_PROVIDER_ATTESTATION_PRIVATE_KEY`, `STRIPE_MONITOR_KEY`, `RESEND_MONITOR_API_KEY`, `PDL_MONITOR_EMAIL_TO`, or `SENTRY_MONITOR_AUTH_TOKEN`. Render cannot manufacture a green receipt: it has only the verification key. The service account can read the private pointer and content-addressed object, but changing either fails the SHA-256 and Ed25519 checks. A valid old object also expires and must match the exact production target digest.
