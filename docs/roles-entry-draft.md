# Permanent-password entry prerequisite

Isolated continuation based on the unchanged reviewed PR119 head `e2f02a199c0dbc84bae4e84a8eeb5e7179605794`. No production credential, grant, account, setting, schema, migration, cutover, merge or deployment is authorized. Production startup remains rejected.

This implements the permanent-password sign-in/resume/sign-out prerequisite within **G1**, and the `/app` entry/destination prerequisite within **G2**. **Neither entire numbered gate is closed: all 10 technical release gates and separate production action-time approval remain open.** G1 still includes setup/reset/verification/preferences and invitation effects; G2 still includes required normal dashboard/aggregate projections and navigation acceptance. Unsupported workflows in the finite release assessment remain unavailable.

## Server entry contract

`POST /api/auth/company` is an unauthenticated selected-host entry contract, outside editable flags. Only a server-bound canonical tenant can use it. Every bounded email, known or unknown, gets exactly that tenant ID. No tenant snapshot, local tenant directory, remote email/account index, session renewal, SQL write or provider lookup occurs. Unbound synthetic API mode cannot perform discovery. Foreign/conflicting header/cookie/body hints and unknown credential fields reject before any authoritative lookup.

Normal permanent-password login uses the explicit matching custom company header obtained from discovery; a cookie-free simple cross-site request without that hint remains denied before lookup. Its bounded email/password payload cannot supply roles, grants or session targets. Existing credential verification and transactional session creation remain in the actual server handler; current actor projections consume typed six-family/profile restrictions. A concurrent password/account/role/policy change makes SQL CAS fail and no success cookie is delivered. No default access is granted.

Current-session logout retains guarded SQL session removal. A revoked/expired/missing session can repeat logout to clear its browser cookies without changing tenant data, renewing a session or acting on another account. Tenant binding and closed logout input still apply. Malformed/ambiguous authority remains denied.

## Actual browser entry

The login page settles its initial mode/session probe before credential submission. The probe renews an HttpOnly cookie, so merely ignoring late JavaScript data would not prevent an old cookie from overwriting a new login. Submit intent suppresses the old resume redirect; double clicks cannot start competing credential requests.

`/app` still has exactly one initial config/auth gate and does not bootstrap raw state before a scoped redirect. Scoped mode validates the explicit URL tenant through fresh auth and preserves supported destinations/legacy aliases. Its workspace gives the explicit URL tenant precedence over a cookie; a conflict denies access rather than silently substituting a company. Legacy mode retains its normal raw bootstrap/navigation.

The scoped workspace adds explicit sign-out, clears cached private labels/configuration/activity before dispatch, and invalidates pending responses. Locked and unsupported accounts have finite truthful recovery states and usable sign-out without redirect loops. Password setup/reset/new-account links are unavailable in scoped mode; legacy mode keeps its existing forms. Existing role-editor recovery IDs stay isolated to their original tenant/account/session; signing out does not turn unresolved records into authority.

## Verification contract

Native tests use a fresh disposable localhost PostgreSQL database and real HTTP workers. Browser tests start cookie-free and use actual credential/session cookies, including a held old-session response before new login, real sign-out/reload/revocation, locked/unsupported/setup-required states, tenant mismatch and flag-off ordinary navigation. External providers are blocked; existing UTF-8/native/multiworker and 54 prior browser journeys remain unfiltered. The three inherited cookie-switch journeys also change the selected URL before reopening; their delayed-response, private-data and original-request assertions remain intact.

Exact immutable source, independent review, complete local evidence and all three CI results will be recorded in the draft PR/checkpoint. Incomplete predecessor runs receive no complete-run credit.
