# Isolated acceptance service

This is a temporary, synthetic signup/billing acceptance harness for paid-launch candidate `dc15e21d0fe3ce7def793296de9df43bdd0a0031`. The application and billing code are unchanged. It is not a production deployment configuration or a completed paid-launch certification.

## Render Free startup

Create a **new** Node web service, with no production environment group, secret files, disk, databases, or credentials cloned. Use the reviewed acceptance branch derived from that exact candidate.

- Plan: Free. No paid upgrades or persistent disk.
- Build command: `npm ci`
- Start command: `npm run start:acceptance` (equivalently `node scripts/start-acceptance.js`)
- Health check: `/api/health`
- Runtime: Node 20 or newer on Linux.
- Use the actual `RENDER_EXTERNAL_URL` that Render supplies to the new service. Do not invent a service URL or copy the production return URL.
- Initially leave `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` absent. The service can boot safely; checkout remains unavailable.
- Do **not** apply the repository's original `render.yaml`: it describes the separate production/demo service and integrations, not this harness.
- Do **not** use plain `npm start`, which bypasses this wrapper.

The wrapper forces authentication on and disables Supabase, transactional mode, founder checkout, Enterprise checkout, and the development email-token bypass. AI, email and monitoring credentials/configuration are forbidden. It rejects root `.env` and `.env.local` files (including symlinks), inherited backend credentials, alternate database paths, conflicting feature switches, unknown PDL/Stripe settings, production hosts, and untrusted return origins. It does not print credentials or inherited values. Do not set Node preloads or runtime env-file flags outside the documented start command.

The public origin is derived only from `RENDER_EXTERNAL_URL`. It must be an HTTPS `*.onrender.com` origin without credentials, a custom port, path, query, or fragment. `pro-daily-link-demo.onrender.com` and `prodailylink.com` hosts are rejected. A supplied `PDL_PUBLIC_URL` must exactly match the derived origin; omitting it is simplest. Incoming Host/forwarded headers do not choose Stripe return URLs.

The health response retains the unchanged application's JSON and adds two non-secret headers:

- `X-PDL-Acceptance: isolated-synthetic`
- `X-PDL-Candidate: dc15e21d0fe3ce7def793296de9df43bdd0a0031`

Healthy startup means that the isolated app is running, not that external billing, account ownership, email, persistence, or recovery have passed.

## Owner-entered sandbox setup

After the service exists, the owner may securely enter its Stripe sandbox key and the signing secret for a webhook on this **new acceptance endpoint**, according to the separately approved setup process. Do not put secrets in this repository, this document, chat, test fixtures, screenshots, or command history. Never clone a production key or signing secret. This wrapper permits nonempty `rk_test_` and `sk_test_` key formats only and rejects live/unknown keys without printing them. A signing secret must have `whsec_` format; a prefix alone does not establish its endpoint or account, so that association still requires verification during setup.

Expected sandbox account metadata is pinned to `acct_1SqHF1FsPiiIUxge`. This metadata and a test-key prefix do **not** prove which account a key belongs to. The six catalog IDs below were separately created and read back in that sandbox on 2026-10-05 with `livemode=false`, currency USD, `interval_count=1`, and the stated monthly/yearly intervals. The harness defaults to them and rejects a supplied price ID that differs.

| Environment key | Verified sandbox price | Amount / interval |
| --- | --- | --- |
| STRIPE_PRICE_STARTER | price_1UN8pAFsPiiIUxgeaaE3jemv | USD 99 / month |
| STRIPE_PRICE_STARTER_ANNUAL | price_1UN8pvFsPiiIUxgeB3LdijQb | USD 990 / year |
| STRIPE_PRICE_GROWTH | price_1UN8ppFsPiiIUxgeRqkQLSVk | USD 199 / month |
| STRIPE_PRICE_GROWTH_ANNUAL | price_1UN8pyFsPiiIUxge7oz1Pu39 | USD 1990 / year |
| STRIPE_PRICE_PRO | price_1UN8psFsPiiIUxgembTKfPnj | USD 399 / month |
| STRIPE_PRICE_PRO_ANNUAL | price_1UN8q2FsPiiIUxgewG7iFaL2 | USD 3990 / year |

The unchanged Checkout code retrieves the selected pinned price from Stripe and verifies its identifier, active state, test/live mode, USD amount, recurrence, and interval count before creating Checkout. A test key from a different account should fail that lookup. The key must have the permissions the unchanged application actually needs. No new credential or access grant is created by this wrapper. Actual authenticated test Checkout, webhook delivery/replay, customer-portal changes, and resubscription must be checked separately after secure setup; local tests do not certify those flows.

A missing key, missing signing secret, or wrong-account price lookup must not be treated as a successful paid checkout. Existing synthetic state is kept across startup rather than automatically wiped.

## Storage and scope

On first boot the wrapper creates a private, owned `/tmp/pdl-acceptance-*` directory, a service/candidate marker, a root tenant with **no users or customer records**, and an empty platform state. It never reads the repository's `data/db.json` or `data/platform.json`. The fixed synthetic root is locked and has no login credentials. Testers create fake tenants through normal signup using synthetic details such as `example.invalid` email addresses. Do not enter real customer, employee, payment, or health data.

The default storage name is stable for the same checkout path and public origin. Root/platform files are initialized only if absent. Signup tenants, sessions, and other synthetic state are not reset on ordinary process restart while that same filesystem exists. A custom `PDL_ACCEPTANCE_DATA_DIR` is optional and must be a direct `/tmp/pdl-acceptance-*` child, private, owned by the process, and either empty or already marked for this service/candidate. Existing unmarked data, corrupt state, changed markers, symlinks, hard links, foreign ownership, or group/world-accessible storage are rejected rather than adopted or erased. Files are created with a private umask.

**Render Free storage is ephemeral.** Redeploys, service restarts/replacement, suspension, or platform events may discard local files. An ordinary same-filesystem process-restart test is not a Render durability guarantee. No database, backup, restore, recovery, or customer-data durability certification is provided. There is no automatic export or production restore.

The candidate hardcodes attachment storage under checkout `uploads/`. This first harness is for signup/billing only: it requires that ordinary directory to contain nothing except an empty or newline-only `.gitkeep`. It neither relocates attachments nor weakens the application's realpath/access checks. If an attachment is uploaded while the service runs, a subsequent startup will refuse the nonempty directory instead of silently reusing or deleting it. Attachment workflows and recovery acceptance remain open. Do not use this service for attachment testing without a separately reviewed plan.

Real email delivery remains **unverified and disabled**. Verification resend/password reset report unavailable and never reveal a development preview token. The platform is empty and has no preloaded staff account or master key. Founder and Enterprise checkout remain off regardless of acceptance environment defaults.

## Local verification only

Run from the isolated acceptance copy, never the production checkout:

```sh
npm run check:acceptance
npm run test:acceptance
npm run check
```

Run the original `npm test` suite in a separate disposable candidate checkout or CI job. Its tests create synthetic files under checkout `uploads/`, which intentionally make this payment-only wrapper refuse a later startup until those generated fixtures are removed; do not run the original suite against a deployed acceptance service.

The new tests use fresh private temporary directories, synthetic placeholder strings, no external credentials, and an outbound-fetch rejection hook inside integration-test child processes. They verify guard refusal, isolated seeds, auth/health, missing-key/missing-webhook unavailable behavior, no email-token bypass, private-file denial, fake signup/session preservation across same-filesystem process restart, and non-secret logs. They do not perform a browser action or make an external API call.

For an explicit loopback-only manual run, start with a clean environment and a chosen free port:

```sh
env -i PATH="$PATH" \
  PDL_ACCEPTANCE_ALLOW_LOOPBACK=1 \
  PDL_ACCEPTANCE_PUBLIC_URL=http://127.0.0.1:4173 \
  PORT=4173 \
  node scripts/start-acceptance.js
```

Only explicit `127.0.0.1` or `::1` HTTP origins are accepted locally; wildcard/private-network hosts and `localhost` aliases are rejected. The origin port must match the listen port. Loopback mode cannot be combined with Render context. No actual public acceptance URL is assigned by this documentation.

For local dependency reuse, a read-only-use symlink to an existing `node_modules` may be used. Do not publish that symlink or any dependencies, state, `.env` files, credentials, or generated uploads. Render should install its dependencies through `npm ci`.
