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
4. Resend has both its API key and sender configured;
5. Stripe has both its server key and webhook-signing secret configured;
6. the hosted Sentry client initialized successfully; and
7. the current primary tenant has a fresh same-provider snapshot upload-download SHA-256 verification receipt.

A failed requirement returns HTTP `503`, `ok: false`, and a non-secret boolean in `requirements`. The response never returns credentials, provider error text, object keys, hashes, customer data, or Sentry event contents.

Outside production, optional service configuration is not required, but any repository explicitly set to `primary` still must be reachable.

## Alerting and release acceptance

- Point Render's service health check only at `/api/health/live`.
- Point the Pro Daily Link operational monitor at `/api/health` and alert on any non-`200` response or any requirement changing to `false`.
- Treat a `503` as an incident to diagnose, not a reason to restart repeatedly.
- Before a release, verify both endpoints and confirm `/api/health` reports every production requirement as `true`.
- A Sentry `true` value proves SDK initialization only. Run the documented controlled Sentry verification and confirm the alert reaches the on-call person.
- The snapshot receipt is not independent-copy or restore-drill evidence. The independent portable-backup and monthly isolated-restore automations remain separate release gates and must alert on stale evidence.

The automated contract is covered by `operational-health.test.js`. Repository-specific probes remain covered by `platform-repository-health.test.js` and `tenant-repository-health.test.js`.
