# Platform-owner Stripe reporting

The report is read-only. It reuses the existing server-side Stripe configuration and changes no charge, invoice, refund, subscription, credential, tax setting, webhook, or entitlement.

## Definitions

- Payment receipts, partial-capture/payment reversals, refund debits and refund reversals use Stripe balance-transaction creation dates and settlement currency. Annual upfront payments stay at their full posted amount.
- Net movement is before fees. Fees, disputes, payouts, transfers and other adjustments are excluded. This is not a bank-deposit, profit, complete-balance or accounting-revenue report. Pending and subsequently failed refunds may debit the Stripe balance; refund reversals are shown separately.
- Estimated gross MRR is a current snapshot independent of the cash date range. It uses active/past-due fixed licensed monthly or yearly items, quantities and interval counts; yearly amounts are divided by 12. It is before discounts and excludes inclusive/unknown effective tax, unsupported currency-option pricing, trial, canceled/unpaid/paused, metered/tiered/transformed, and collection-paused items. Exclusions are counted. MRR is not collected money.
- Failed payments count historical failed Charge attempts, not customers or unpaid invoices. Later retries may succeed. Refund statuses describe refunds created within the selected period, excluding partial-capture releases.
- Currencies stay separate, with Stripe minor-unit conventions including ISK/UGX. Company and currency MRR totals round independently.

## Access and completeness

GET /api/platform/revenue requires a real active platform_owner session, including in auth-disabled demo mode, and rechecks it after provider reads. Company sessions, support/billing roles and bootstrap keys do not qualify. Owner creation also requires a real owner; bootstrap requires the existing key and uses safe byte-length comparison.

Exact stored customer/subscription IDs map companies. Names, metadata, configured plan prices and demo-name heuristics are not ownership evidence. Ambiguous activity remains visibly unmatched and included in account totals. Company-only Supabase reads keyset-paginate until empty, choose the newest persistence revision/date, and fail on tied conflicting links.

UTC date filters are inclusive, at most 366 days, and cannot include future dates. Each provider read is bounded; the overall report has 20 seconds / 80 Stripe requests, and company reads have 5-second deadlines / 40 pages. No incomplete/error/unconfigured state is presented as zero. Up to 100 activity rows are displayed while complete report totals cover all loaded rows. Minimized reports cache for at most 1 minute. Keys, raw Stripe errors, card details, customer contacts and full provider objects are not returned or logged.

## Recovery and validation

This source was reconstructed after loss of an unpublished workspace. The platform/revenue frontend was recovered byte-for-byte from the immutable synthetic preview; backend and tests were rebuilt and require fresh integration review. Previous test results do not certify this reconstruction.

Run the reporting, company-loader and HTTP access suites, then the complete project checks. They use synthetic provider adapters and local fixture servers only. Live Stripe permissions and reconciliation, authenticated production behavior and visual QA require separate verification before a release claim.

Roll back only this reporting/office change against the verified current baseline. Preserve released timed-leave semantics, project-manager approval scoping, Notes privacy, pricing DOM and verified-backup receipts. No data migration is needed for revenue reporting.
