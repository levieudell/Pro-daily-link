# Reporting browser acceptance checklist

Prepared for the local reporting branch; not a record of completed browser testing.
Use an isolated synthetic tenant/database with all provider keys absent, email development preview enabled and transactional/Supabase storage off. Do not use production accounts, payments or customer data. Run at phone width 360 x 800 and desktop 1365 x 900 when the supported browser runtime is available.

1. Sign up, confirm the synthetic email through the development preview, create a project and report, approve it, reset the password and sign in again. Check navigation, back/cancel, form validation and readable controls.
2. Attach a photo, interrupt its upload, and retry. Confirm one report ID and one successful attachment. Refresh after failure: notes recover, the saved report remains selected, and photos honestly require reattachment. Restore connectivity before uploading.
3. Approve a T&M report at rate 100; change the future default to 200 with a reason. Correct and reapprove the old report: its rate stays 100. Approve a new report: its rate is 200. Field/unpriced manager views show no financial fields.
4. Review a legacy report with no historical rate: leave its amount incomplete until an owner/admin supplies a rate, reason and evidence reference. Verify the prior/new rate and actor history after a subsequent correction.
5. Capture a fixed export for one project/date range. Double-click capture and confirm one version. Correct source data/rates, then download the old JSON/CSV: its contents stay unchanged. Capture the replacement with a reason and verify version lineage.
6. Delay a rate/default/export response, then switch accounts/tenants with matching numeric IDs or navigate to another project. Confirm stale responses neither update the new workspace nor download the previous account's export; previous export links clear immediately.

Capture viewport screenshots, report/export IDs, expected/actual outcomes and redacted evidence. Automated VM/HTTP tests already cover these data paths; this checklist closes real layout, file-picker and navigation acceptance only. No browser runtime was installed and no user tabs were touched.
