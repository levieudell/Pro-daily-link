# Customer data lifecycle

## Ownership and access

Customers own their submitted project data. Pro Daily Link processes it only to provide, secure, support, back up, and improve the service. Company users receive the minimum access allowed by their role.

## Export

An account owner may request a company export. Before fulfilling it, verify the requester and company ownership. The export should include customers, projects, estimates, daily reports, photos/file references, schedules, time cards, changes, subcontractors, templates, and audit records in commonly readable formats.

## Account closure and deletion

Deletion is an operator-reviewed workflow. A customer request does **not** silently delete data or imply that billing has stopped.

1. The signed-in account owner types the exact company confirmation phrase. The request enters **Awaiting operator review**; access and billing remain unchanged and the owner may still cancel it.
2. A platform owner verifies the requester, records whether the owner downloaded or declined the final export, confirms the Stripe disposition, and leaves an operator note.
3. Starting the **Recovery hold** revokes sessions, guest links, customer decision links, reset/setup links, and interactive tenant access. It does not claim to call Stripe: the operator must first record that no subscription exists, Stripe was stopped, or a documented legal hold requires retention.
4. Recoverable company data remains in the authoritative repository for 30 days. Cancelling the hold can restore the account, but it never resurrects revoked credentials or restarts billing.
5. Permanent deletion is a separate platform-owner action after the hold. It requires the exact permanent-deletion phrase, no legal hold, primary transactional storage, and private-storage availability.
6. PostgreSQL first rechecks the request ID, repository revision, status, and hold deadline and commits a durable, non-PII finalizing lock. That lock rejects every legacy and transactional tenant write before any private object can be removed, eliminating the storage-deletion/revision-conflict race.
7. The server then removes or confirms absence of every referenced private object and local tenant mirror, and durably records that cleanup before the final database purge. Provider or filesystem failure leaves the tenant disabled, locked, and retryable. PostgreSQL accepts finalization only for the exact lock and leaves a content-free tombstone; an ambiguous network response is reconciled against that receipt. A post-commit mirror problem remains a truthful cleanup-pending response and a durable background job—never a false deletion failure or false 200 completion.
8. Backups expire through their normal retention cycle and must not be restored except for authorized disaster recovery. The platform audit keeps only the opaque tenant/request IDs, operator, result, and timestamps—not deleted customer content.

## Default retention

- Active customer records: retained while the account is active.
- Deleted tickets/receipts: recoverable for 90 days, as shown in the product. A six-hour all-tenant sweep processes inactive workspaces too. Missing provider configuration, provider errors, unsafe paths, and unconfirmed deletes preserve the storage pointer and write retry evidence.
- Closed-account operational data: 30-day recovery period unless a different written agreement applies.
- Security and billing audit records: retain only as long as needed for security, tax, dispute, and legal obligations.

These defaults must be reflected in the customer agreement and privacy policy. Legal counsel should review them before they are represented as jurisdiction-specific legal advice.


