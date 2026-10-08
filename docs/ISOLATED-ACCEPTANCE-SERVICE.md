# Isolated acceptance service

This is a temporary, synthetic signup/billing acceptance harness for paid-launch candidate `c187882db188e67382c551a9d4b064df32a6c1b9`. The application and billing code are unchanged. It is not a production deployment configuration or a completed paid-launch certification.

## Approval and deployment gate

This revision is **local review preparation only**. It does not authorize publication, deployment, creation of a remote owner, credential access, expanded Stripe key permissions, provider configuration, or enabling Enterprise on the existing service. The actual acceptance service must remain unchanged until the owner has given the required action-time approval. Then publish/deploy only the independently reviewed artifact, with the exact product candidate and the existing production/demo service left untouched.

The intended test service is `srv-db1noks9v7es738ebdd0`, at `https://pdl-paid-acceptance-20261005.onrender.com`. This is the only hosted identity allowed for the optional Enterprise fixture. No additional service, paid plan, persistent disk, or new provider should be created as part of this preparation.

## Render Free startup

Use the already isolated Node web service, with no production environment group, secret files, disk, databases, or credentials cloned. Use the reviewed acceptance artifact derived from the exact candidate above.

- Plan: Free. No paid upgrades or persistent disk.
- Build command: `npm ci`
- Start command: `npm run start:acceptance` (equivalently `node scripts/start-acceptance.js`)
- Health check: `/api/health`
- Runtime: Node 20 or newer on Linux.
- Use the actual `RENDER_EXTERNAL_URL` that Render supplies to the new service. Do not invent a service URL or copy the production return URL.
- Initially leave `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` absent. The service can boot safely; checkout remains unavailable.
- Do **not** apply the repository's original `render.yaml`: it describes the separate production/demo service and integrations, not this harness.
- Do **not** use plain `npm start`, which bypasses this wrapper.

The wrapper forces authentication on and disables Supabase, transactional mode, founder checkout, and the development email-token bypass. Enterprise checkout is also disabled by default; only the separately approved paired opt-ins below can enable it. AI, email and monitoring credentials/configuration are forbidden. It rejects root `.env` and `.env.local` files (including symlinks), inherited backend credentials, alternate database paths, conflicting feature switches, unknown PDL/Stripe settings, production hosts, and untrusted return origins. It does not print credentials or inherited values. Do not set Node preloads or runtime env-file flags outside the documented start command.

The public origin is derived only from `RENDER_EXTERNAL_URL`. It must be an HTTPS `*.onrender.com` origin without credentials, a custom port, path, query, or fragment. `pro-daily-link-demo.onrender.com` and `prodailylink.com` hosts are rejected. A supplied `PDL_PUBLIC_URL` must exactly match the derived origin; omitting it is simplest. Incoming Host/forwarded headers do not choose Stripe return URLs.

The health response retains the unchanged application's JSON and adds two non-secret headers:

- `X-PDL-Acceptance: isolated-synthetic`
- `X-PDL-Candidate: c187882db188e67382c551a9d4b064df32a6c1b9`

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

The unchanged Checkout code retrieves the selected pinned price from Stripe and verifies its identifier, active state, test/live mode, USD amount, recurrence, and interval count before creating Checkout. A test key from a different account should fail that lookup. The key must have the permissions the unchanged application actually needs. The default wrapper creates no credential or access grant. The optional owner fixture below creates only a local hashed password row after explicit opt-in and private owner entry. Actual authenticated test Checkout, webhook delivery/replay, customer-portal changes, and resubscription must be checked separately after secure setup; local tests do not certify those flows.

A missing key, missing signing secret, or wrong-account price lookup must not be treated as a successful paid checkout. Existing synthetic state is kept across startup rather than automatically wiped.

## Storage and scope

On default first boot the wrapper creates a private, owned `/tmp/pdl-acceptance-*` directory, a service/candidate marker, a root tenant with **no users or customer records**, and an empty platform state. It never reads the repository's `data/db.json` or `data/platform.json`. The fixed synthetic root is locked and has no login credentials. Testers create fake tenants through normal signup using synthetic details such as `example.invalid` email addresses. Do not enter real customer, employee, payment, or health data.

The default storage name is stable for the same checkout path and public origin. Root/platform files are initialized only if absent. Signup tenants, sessions, and other synthetic state are not reset on ordinary process restart while that same filesystem exists. A custom `PDL_ACCEPTANCE_DATA_DIR` is optional and must be a direct `/tmp/pdl-acceptance-*` child, private, owned by the process, and either empty or already marked for this service/candidate. Existing unmarked data, corrupt state, changed markers, symlinks, hard links, foreign ownership, or group/world-accessible storage are rejected rather than adopted or erased. Files are created with a private umask.

**Render Free storage is ephemeral.** Redeploys, service restarts/replacement, suspension, or platform events may discard local files. An ordinary same-filesystem process-restart test is not a Render durability guarantee. No database, backup, restore, recovery, or customer-data durability certification is provided. There is no automatic export or production restore.

The candidate hardcodes attachment storage under checkout `uploads/`. This first harness is for signup/billing only: it requires that ordinary directory to contain nothing except an empty or newline-only `.gitkeep`. It neither relocates attachments nor weakens the application's realpath/access checks. If an attachment is uploaded while the service runs, a subsequent startup will refuse the nonempty directory instead of silently reusing or deleting it. Attachment workflows and recovery acceptance remain open. Do not use this service for attachment testing without a separately reviewed plan.

Real email delivery remains **unverified and disabled**. Verification resend/password reset report unavailable and never reveal a development preview token. By default the platform is empty and has no staff account or master key. Founder checkout stays disabled in all acceptance modes. Enterprise remains disabled unless both exact opt-ins below are supplied. `PDL_PLATFORM_KEY` stays forbidden, including in the optional fixture mode.

## Optional Enterprise owner fixture (default off)

After the owner approves the specific remote setup, the owner privately enters the following in **this service only**:

- `PDL_ACCEPTANCE_ENTERPRISE=test-only`
- `PDL_ACCEPTANCE_PLATFORM_OWNER=synthetic-test-owner`
- `PDL_ACCEPTANCE_PLATFORM_PASSWORD`: a unique, private password of at least 12 characters chosen and entered by the owner. No example, public, shared, reused, or default password is supplied by this harness.

Provider-key/signing-secret-looking passwords or passwords equal to a configured Stripe secret are refused with a fixed message, protecting against an accidental credential paste.

Both flags must have these exact values. To leave the feature off, omit both flags and the password entirely. One flag, empty flags, alternate values, a stray password, or an explicit conflicting application feature switch fails startup. Do not set `PDL_ENTERPRISE_CHECKOUT_ENABLED=1` directly. Do not pass the password in a shell command, commit it, send it in chat, screenshot it, or have an assistant retrieve it.

The wrapper requires `RENDER=true`, `RENDER_SERVICE_ID=srv-db1noks9v7es738ebdd0`, and `RENDER_EXTERNAL_URL=https://pdl-paid-acceptance-20261005.onrender.com`. If Render supplies its hostname or service type, they must agree. These variable names are documented in [Render default environment variables](https://render.com/docs/environment-variables). They bind configuration to the reviewed service; they are not cryptographic proof of deployment identity, and locally fabricated values are used only in network-blocked tests. There is no Enterprise loopback opt-in or new HTTP setup endpoint.

The only fixture identity is:

- Email: `enterprise-test-owner@example.invalid`
- Name: `PDL Enterprise Acceptance Owner`
- Role/status: `platform_owner` / `Active`

The owner then signs in normally at `https://pdl-paid-acceptance-20261005.onrender.com/platform-login.html`. The existing application's password login creates the session. Startup creates no cookie, token, session, master key, login bypass, or public credential. Owner-only quote checks are unchanged. The normal Platform Owner role has the application's existing broad powers inside this isolated synthetic service; it is not a narrowed quote-only role. Do not use real customer information or production identities.

### Password and state handling

First setup requires a private acceptance platform whose users and sessions are empty. It preserves unrelated platform notes/help/other data, seeds exactly one explicitly marked owner, and leaves the synthetic root without users or sessions. Password hashing exactly matches the unchanged server: a random 16-byte hexadecimal salt and `crypto.scryptSync(password, salt, 64).toString('hex')`. The password is not trimmed. It is deleted from the Node process environment before the application server is imported and is absent from returned configuration, logs, health, and startup errors.

The password hash and salt live only in private platform state. A separate private `.pdl-acceptance-owner.json` records a digest binding those credentials to this fixture/service/candidate. It is never served or included in public health or configuration. Missing, corrupt, or changed identity evidence is refused. This file is corruption/conflict detection, not protection against someone who already controls and can edit the entire private filesystem.

Repeated startup accepts only the exact existing marked identity, role, Active status, credential evidence, and its own normally created sessions. It preserves matching state byte-for-byte. A supplied password must match the existing hash without trimming. Changed passwords/hash/salt, inactive or edited identity, additional users, foreign or malformed sessions, setup/reset credential state, or conflicting markers fail closed. It never adopts, overwrites, re-enables, rotates, or deletes a conflicting user. An interrupted initial write may leave incomplete private identity evidence; startup then refuses pending explicit review instead of reseeding. Creating additional staff or initiating password-reset state through normal UI can intentionally make a later fixture startup refuse; this is a one-owner acceptance fixture, not a multi-user platform setup.

A password may be omitted **only when the same filesystem still contains the complete matching fixture and private credential evidence**. A fresh or reset filesystem without the password refuses startup and never invents credentials. Removing the opt-in flags while privileged state or identity evidence remains also refuses; it does not silently keep the account available or erase user data.

Deleting the variable from the Node process does **not** delete the saved secret in Render. Provider-secret cleanup is an explicit owner step after the acceptance run. Changing/removing an environment variable in Render may trigger a redeploy and erase this Free service's local state. Therefore removing the saved password is not guaranteed to permit a later startup: if state was lost, both active opt-ins with no password will refuse. Any desired reset or re-entry requires an explicit reviewed owner step; the harness does not automatically wipe or recover data. Disabling/decommissioning the remote service and any data deletion also remain separate authorized cleanup actions.

### Readiness and provider gates

Enabling the fixture does not certify Stripe, paid launch, email, persistence, recovery, or key ownership. The expected Stripe account `acct_1SqHF1FsPiiIUxge` is metadata, not proof that a test-prefix key belongs to that account. Existing pinned standard prices remain unchanged. Enterprise Checkout remains unavailable without the test-mode key and endpoint signing secret, and normal quote approval/terms acceptance still apply.

Before an approved external acceptance run, independently verify this candidate, normal owner login, test-key account and price context, trusted return origin, complete webhook delivery/replay coverage, and the minimum required key permissions. Prefer a service-specific restricted test key, consistent with [Stripe restricted-key guidance](https://docs.stripe.com/keys/restricted-api-keys). The frozen refund-recovery runtime reads PaymentIntents, Charges, and Disputes. If these reads are missing, expanding them needs its own required approval. **Do not grant Refunds write permission**; this harness does not issue refunds.

The webhook must subscribe to all 15 events required by the unchanged standard and Enterprise handlers:

1. `checkout.session.completed`
2. `checkout.session.async_payment_succeeded`
3. `checkout.session.async_payment_failed`
4. `checkout.session.expired`
5. `customer.subscription.created`
6. `customer.subscription.updated`
7. `customer.subscription.deleted`
8. `invoice.paid`
9. `invoice.payment_failed`
10. `charge.refunded`
11. `charge.dispute.created`
12. `charge.dispute.updated`
13. `charge.dispute.closed`
14. `refund.updated`
15. `refund.failed`

Signature verification and delivery/replay acceptance remain mandatory, following [Stripe webhook guidance](https://docs.stripe.com/webhooks). This local preparation configures no webhook, provider, key, or secret. The planned external synthetic Enterprise amount is USD 10, with no more than six test payments under the separately authorized test plan; this is a test fixture constraint, not a commercial price or real customer contract. No real Parker terms or new business policy are introduced. Local fake-client tests do not make payments and do not certify hosted checkout or webhook processing.

## Local verification only

Run from the isolated acceptance copy, never the production checkout:

```sh
npm run check:acceptance
npm run test:acceptance
npm run check
```

Run the original `npm test` suite in a separate disposable candidate checkout or CI job. Its tests create synthetic files under checkout `uploads/`, which intentionally make this payment-only wrapper refuse a later startup until those generated fixtures are removed; do not run the original suite against a deployed acceptance service.

The tests use fresh private temporary directories and synthetic, generated test passwords only. The original 17 guard tests still run. New tests add exact opt-ins and service binding, password omission rules, no-session seed, untrimmed server-compatible hashing, independent private credential evidence, conflict refusal, unchanged-state preservation, and credential-free errors. A test-only child simulates Render metadata, forces a fresh loopback listener, supplies a fake Stripe client, and blocks outbound fetch, HTTP(S), socket and TLS connections. It verifies wrong-password/anonymous denial, normal owner login, owner-only USD 10 quote creation/issue and fake Checkout, authenticated support denial through normal account setup/login, private-file denial, environment password removal before server import, and session preservation across a same-filesystem restart. It performs no browser action and no real provider/API call.

For an explicit loopback-only manual run, start with a clean environment and a chosen free port:

```sh
env -i PATH="$PATH" \
  PDL_ACCEPTANCE_ALLOW_LOOPBACK=1 \
  PDL_ACCEPTANCE_PUBLIC_URL=http://127.0.0.1:4173 \
  PORT=4173 \
  node scripts/start-acceptance.js
```

Only explicit `127.0.0.1` or `::1` HTTP origins are accepted locally; wildcard/private-network hosts and `localhost` aliases are rejected. The origin port must match the listen port. Loopback mode cannot be combined with Render context. The loopback command keeps Enterprise and the owner fixture disabled; it does not change any public service.

For local dependency reuse, a read-only-use symlink to an existing `node_modules` may be used. Do not publish that symlink or any dependencies, state, `.env` files, credentials, or generated uploads. Render should install its dependencies through `npm ci`.
