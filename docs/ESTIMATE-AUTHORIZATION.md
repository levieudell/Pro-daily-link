# Estimate authorization and import provenance

Financial estimate actions (PDF analysis/approval, proposal approval, direct
estimate creation, and catalog application) require company pricing access.
Owners and administrators retain access regardless of the company’s manager
pricing selection. Project managers must have current assignment to the target
project and current pricing permission. Existing estimate-item editing and
deletion remain restricted to owners and administrators. This release adds no
manager UI controls.

Quantity-only proposal submission is separate: assigned field/foreman users
and assigned project managers can submit manual or PDF-extracted scope for
review. This does not authorize them to approve scope into an estimate or read
price-bearing source documents.

## Import provenance

- Analysis records the authenticated creator; client-supplied creator fields
  cannot override this identity.
- Analysis launched from a project binds the draft to that authorized project.
  The review picker remains fixed for a bound draft. File reads and analysis responses retain their originating project and are ignored after closing/reopening or starting a newer import; a completed approval cannot close a newer import dialog. Global import drafts may
  remain unbound until their first approval.
- A manager can approve a draft bound to a currently assigned project, or their
  own unbound draft into a currently assigned project. Both cases require
  current pricing permission.
- Legacy unbound drafts without a trusted creator are available for approval
  only to owners/administrators. They are not automatically attributed to the
  next caller.
- A bound draft cannot be silently moved to another project, even by an owner.
  Analyze a new draft for the intended project instead.
- Already-approved imports return HTTP 409 without adding duplicate items.
- Scope/pricing are checked again on approval, so permission changes after
  analysis take effect immediately.

Access checks run before PDF parsing, OCR, upload storage, and estimate changes.
Inaccessible project/source imports return 404; missing financial permission
returns 403. Stored-source read authorization is unchanged by this patch. The
separate estimate source retention work remains responsible for durable storage,
backup references, and the existing restrictive document read policy.

## Verification

`node estimate-authorization.test.js` uses isolated synthetic tenants and
intercepts all outbound provider requests. It checks roles, manager assignment,
pricing selection and revocation, creator/source/destination isolation, legacy
unbound recovery, bound-draft retarget rejection, duplicate approval rejection,
field manual/PDF proposals, and preservation of owner/admin-only editing.
Denied requests must leave the database snapshot, upload directory, and provider
call count unchanged.

Before hardening, `--reproduce` confirmed six unauthorized successful requests:
unpriced manager analysis, manager cross-project import approval, cross-project
proposal creation/approval, field cross-project direct estimate creation, and
manager cross-project catalog application. This diagnostic mode is intended for
the vulnerable baseline and should fail against a hardened build.

`node estimate-import-ui.test.js` exercises the actual UI handlers with deferred file/API responses, including close/reopen, overlapping completion, retry, and approval interruption.

Run the full suite plus both estimate source retention modes before release.
The tests do not contact production, OCR, payment, email, or storage providers.

## Release and recovery gates

Draft source review does not authorize or establish production readiness. Before
merge/deployment, obtain fresh read-only confirmation that the existing private
`estimate-documents` bucket accepts PDFs at the required effective object limit,
and preserve the current live local-source inventory before any redeployment.
No bucket creation, permission change, credential change, migration, deletion,
or production restore is included. See the retention document for forward-safe
containment; retain the authorization checks, approved-state guards, pending-only
projections, and original object/reference data during recovery.
