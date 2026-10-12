# Fixed field flagged-work read

`GET /api/changes/mine` is the existing My Day flagged-work endpoint, not an
obsolete browser-test URL. The quarantined compatibility adapter now admits
this exact read instead of falling back to an unreviewed private handler.
Other methods, extra path components and unknown private routes stay fenced.

The current Active Field or Foreman account must match its current stored
account/member tuple. The read uses current tenant, project and linked-report
scope, including the existing typed Daily restrictions through the same
`changeVisible` function as the normal adapter. It accepts no query overrides,
role flags, member IDs or caller-supplied audience. Owner, Admin and PM cannot
use this own-field endpoint.

Only id, number, title, status, flagDate and createdAt leave the source. Amounts,
details, history, author metadata, customer tokens and provider fields do not.
Canonical resource identities and bounded scalar summaries are required;
malformed/foreign/ambiguous source fails closed. Existing current-read and
final-return revision, account, session, subscription and deadline fences remain
in force. The read performs no company write or provider call.

The existing field writer stores a display-name author. A unique current account
name retains that legacy behavior inside current project/report scope; this is
not immutable historical author custody. Any same-name stored account, including
an inactive one, makes matched history ambiguous and returns409. An optional
createdById can only further restrict a match; it never proves custody or removes
the name ambiguity requirement. No numeric migration, flag writer, new editable
capability or alternate identity dictionary is introduced here.

The HTTP regression uses genuine compatibility requests, positive own summaries,
both Field/Foreman roles, scope and private-field exclusions, malformed source,
query/method/tenant denials, Daily-linked restrictions and ten revocation cases
between opening, current-read and final private return. Browser coverage retains
the original no500+ assertion and every previously skipped program.
