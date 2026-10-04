# Pro Daily Link incident response

## Purpose

Use this procedure for suspected data loss, cross-company exposure, login compromise, failed billing state changes, unavailable production service, or incorrect customer-facing data.

## Severity

- **SEV-1:** confirmed or suspected cross-company exposure, credential disclosure, destructive data loss, or widespread inability to use the service.
- **SEV-2:** one company cannot work, billing state is wrong, email delivery is broadly failing, or a core workflow is corrupting data.
- **SEV-3:** degraded or confusing behavior with a safe workaround and no known loss of data.

## First 15 minutes

1. Record the detection time, reporter, affected company, visible error, request ID, and last known good action.
2. Do not delete logs, redeploy blindly, reset data, or edit customer records by hand.
3. For suspected exposure, disable the affected route or account and rotate the relevant credential.
4. For suspected corruption, make a verified backup before attempting a repair.
5. Check Render service health and logs, Sentry, Supabase health, Stripe webhook delivery, and Resend delivery.
6. Name one incident lead and keep all decisions in the incident timeline.

## Containment and recovery

1. Stop the unsafe write path while preserving read access when safe.
2. Identify the smallest affected company and time window.
3. Reproduce with synthetic data; never experiment on the customer workspace.
4. Restore into an isolated location and reconcile counts and hashes before production recovery.
5. Require a second-person review before restoring or deleting production data.
6. Verify login, project, report, time, approval, export, billing, and email behavior after recovery.

## Communication

- Acknowledge a SEV-1 or SEV-2 customer report as soon as possible during business hours.
- State what is known, what is not known, the containment action, and the next update time.
- Never speculate, blame a vendor, or claim no data was exposed until verified.
- Levi owns customer and business communication. The developer owns technical containment and evidence collection.

## Closure

Close only after monitoring is normal, affected data is reconciled, the customer impact is documented, and a prevention task has an owner. Complete a short post-incident review within two business days.


