# Demo request durability

The public demo form acknowledges a request only after its local platform file
is saved and, when Supabase is configured, the platform snapshot save completes.
A failed save returns a retryable 503 message without clearing the form. The
local record is retained for recovery; a stable request ID lets the unchanged
form retry without creating a duplicate lead or audit event. Changed form data
uses a new request ID. Older cached clients without request IDs remain supported.

Platform cloud snapshots are sent in local-write order so a slower, older save
cannot replace a newer acknowledged lead. Other platform callers retain their
existing background-save behavior, including handled error logging. The tenant
write queue and billing routes are unchanged. The public demo handler runs before
tenant resolution, so a slow lead save cannot hold unrelated tenant or signup
requests behind its cloud response.
Platform operations that await company lookups reload their platform snapshot
before writing; failed reset-email rollback does the same and clears only its own
reset token. Concurrent accepted leads and newer account changes are preserved.

This does not schedule meetings, send email alerts, capture campaign attribution,
or reserve available slots. New requests capture the visitor's IANA time zone and
UTC instant; old zone-less requests must be confirmed explicitly. Operator status
changes await cloud persistence and surface save/load failures with refresh
recovery. Requests still appear in Platform Operations
under Onboarding → Demo requests and require a person to confirm the time.

## Checks

- `node demo-request-durability.test.js`: synthetic HTTP/cloud adapter checks for
  failure, delayed completion, retries, deduplication, payload conflicts, ordered
  older/newer snapshots, preservation of unrelated data, validation, and local-only
  compatibility. No production services or real leads are used.
- `node demo-request-ui.test.js`: VM checks for retained form values, stable retry
  IDs, edited requests, lost responses, duplicate submits, and time-zone capture.
- `node platform-demo.test.js`: synthetic queue checks for load/save errors,
  refresh recovery, escaped data, and explicit requester time-zone display.
- All are included in `npm test`; run `npm run check` and the complete suite for
  integration regressions before publication.

Ordering and deduplication are single-server-process guarantees. Multiple instances
or overlapping deployments require shared concurrency control. Real production
form delivery, provider behavior, mobile rendering, load capacity, and disaster
recovery require separate verification. This patch is not evidence
that the public campaign domain or payment checkout is launch-ready.

## Recovery

Revert this isolated commit to restore the prior behavior. Extra request ID/hash
fields are backward-compatible with the previous readers; do not remove existing
lead records. Reverting restores the old early-acknowledgment risk, so prefer a
forward correction if a regression is found.
