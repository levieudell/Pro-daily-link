# Original manual-code and report-intake recovery

This source increment preserves the original operation ID for two existing
managed manual credential actions (platform staff create and company owner reset)
and compound daily-report create/edit intake. The platform bootstrap key workflow
has no session-based browser recovery adapter here. Existing Roles/profile save
recovery remains unchanged.

`original-operation-recovery.js` stores one closed record per operation in
`localStorage`, with a limit of 32 records and 32 KiB. Records contain version,
opaque operation UUID, finite purpose/route/target IDs, SHA256 identity and input
digests, and creation time. They contain no credential, email, report text, image,
filename, form contents, session token, server proof, policy, or grant. Identity
includes company, account, role and the existing hashed session binding; the
manual client also hashes the current owner's email into that binding without
storing the email. This metadata is untrusted and only selects an original GET.
The server still checks the original session, current identity, generation,
expiry, capabilities and source scope.

Each entry has a separate storage key. Appending in another tab cannot overwrite
an original entry. A live journal also pins observed opaque handles in memory:
erasing storage during that page's lifetime preserves original GET recovery and
blocks replacement POSTs. Changed persisted metadata fails closed, and missing
metadata is never automatically written back. Before sending, the clients require exact persistence/readback
and recheck the current identity, entry and caller's acceptance callback. A
different pending request or identity blocks a replacement. Storage failure,
malformed or unknown-version entries, expiry, key drift, lookup 404 and uncertain
acknowledgement never prune or repair entries. External deletion of browser
storage cannot be recovered by a browser-only journal; the durable server records
and their authorization remain authoritative.

The manual callable API exposes `originalOperations()`,
`recoverOriginal(id, {accept})` and
`reviewOriginal(id, {confirmed: true, accept})`. The report helper exposes
`createIntakeClient({call, identity, journal, retire})` with the same methods plus
`submit(route, {body, target, accept, headers})`. Its target is exactly
`{companyId, projectId, resourceId}`; resourceId is null for create and the report
ID for edit. The input is the existing finite compound
`{report, files, caption, tags}` body. Recovery requires no old form or files.

Both clients retain a handle after a known response. Explicit review makes a
fresh original GET and current-identity check before removing that one exact
entry. Known-success consumers may do this after applying an acknowledged result
under their current form fence. Cleanup failure remains a known result with
`originalHandleRetained: true`; it does not become an unknown save. All report
POST/PATCH consumers must block while an unresolved intake exists, including
later forms with no images or safety fields. Page wiring must provide current
view acceptance and retire private UI on a failed current check.

Pending, unknown or changed report status is read-only and remains blocking. The
client never uploads again, recreates the report, renews a code, changes an
identity binding or infers no effect from a 404. An operation without a conclusive
authorized original result needs further explicit server-side reconciliation;
this increment does not invent such a result or silently erase the handle.

The tests use memory storage/transport and actual exported client factories,
plus existing platform/app VM callers. They cover reload, known and lost
acknowledgements, exact operation recovery, identity changes, buffered denial,
malformed storage, quota/readback/cleanup failures, expiry, target binding and
partial intake. They do not establish native multiworker, provider, browser or
production activation readiness.
