# Public Analytics owner and release handoff

## Verified configuration and approval

Main base bdbdfe9a. PR #120 implements public/signup opt-in GA4 without private workspace or form data. Owner approved public/signup optional consent, Enhanced Measurement OFF, ads personalization OFF, two-month retention and preserving the existing Ads link at 23:03 UTC October 8, 2026.

Read-only signed-in inspection verified levi@prodailylink.com, Analytics account 381224348 (Google Ads Account), property 520632381 (prodailylink.com), stream 13331422396, public measurement ID G-BDXQC0Z07E. Google reported no data received. No new property or grant is needed.

Approved changes saved and read back before billing browser handoff:
- Enhanced Measurement OFF on stream 13331422396.
- Ads personalization allowed in 0 of 307 regions on property 520632381.

After the parent returned the browser slot, user retention was saved at the approved 2 months; Google's success notification confirmed the save. Event retention remains 2 months. Reset on new activity remains ON, unchanged. Enhanced Measurement OFF, ads personalization 0/307 regions allowed and the existing Ads link with personalization disabled were read back. Reset ON means the user-data retention window restarts on new activity; turning it OFF would be a separate setting change. Google's retention controls do not cap aggregate standard reports.

Google Signals is not enabled; user-provided collection is not activated. Granular location/device collection remains at its existing ON setting (no separate approval to change it). Account Google products/services, modeling/business insights, technical support and business recommendations sharing boxes were all OFF. One existing Ads link has personalized advertising disabled; preserve it. Non-personalized measurement/conversion use can remain available in Ads. No Search Console link exists; that separate task must coordinate through the parent.

## Source and privacy boundaries

The verified measurement ID is configured, but enabled remains FALSE pending release-owner coordination and vendor network QA. Copy is integrated in privacy.html, including Google Analytics provider disclosure, device vs approximate analytics location, choice/withdrawal, Google processing link, no advertising personalization and retained non-personalized Ads link behavior. This is proposed release copy in the isolated draft; production has not been restarted or changed.

Only Home, About, Field Notes index/reviewed articles, Signup, Privacy and Terms are eligible. Authentication, guest links, support, password flows, private workspace and platform pages contain no tracker. Company cookies suppress public tracking. There are no user IDs, form values, account conversion events, project/customer/person data or dynamic page titles in emitted payloads.

Basic consent loads no Google script/ping before Allow. Decline sends no Google request. Withdrawal disables collection, clears GA cookies and reloads to unload the tag; other tabs reload on changed preferences. GPC and DNT suppress collection. The existing draft caps analytics cookies at 30 days without renewal; this minimizes the browser identifier lifetime independently of the approved two-month server retention. It has not been activated in production.

Manual pageviews use fixed titles, sanitized URLs and referrer origins. Duplicate installation/identical consecutive views are prevented. Private/unknown navigation disables collection. Sensitive tokens, private/unknown query keys, ad click IDs, unknown article slugs and unknown fragments suppress the visit. Unreviewed standard UTM values are dropped so consenting public visits can count under their canonical page without sending or copying those values. Campaign and public article slug allowlists remain empty until exact non-personal labels are reviewed: campaign attribution is therefore unavailable, even when canonical public page counts are eligible. Actual signup hrefs preserve only approved UTMs after consent for normal, keyboard, middle/context-menu navigation; unrelated values are not copied. Real vendor automatic-event/network behavior remains unverified, and activation stays disabled.

## Legal boundary

No explicit agreement was accepted. Existing account UI says Data Processing Terms have not been accepted; this is not a universal technical activation block or an optional sharing feature. Current Analytics terms incorporate processor terms to the extent use is within scope. Owner reviews applicability and any separate acceptance; do not check the agreement box automatically.

Verified agreement: https://business.safety.google/adsprocessorterms/ (account link https://privacy.google.com/businesses/processorterms/ redirects here).
Acceptance guidance: https://support.google.com/analytics/answer/3379636
Analytics terms, section 7: https://marketingplatform.google.com/about/analytics/terms/us/

## Release and QA still required

Coordinate combined SEO/archive release with parent/release owner. Do not restart production independently. Before enabling, inspect real collection payloads with consent Allow/Decline/withdrawal, GPC/DNT, anonymous/public navigation, signup form typing, private/company/guest/password navigation, approved UTMs and harmless production redirects. Check one pageview per navigation and no sensitive URL/referrer/title/form payloads. Check vendor first_visit/session_start/engagement behavior, including automatic tag-detected events; client unit mocks cannot prove vendor behavior. Keep internal QA out of production collection with a separate test stream or opt-out. Inspect apex/www/app redirects using harmless approved labels only. Application maps / to landing.html without redirecting; external domain redirects are outside this repository.

Owner reports: https://analytics.google.com/analytics/web/?authuser=2#/a381224348p520632381/reports/intelligenthome . Traffic acquisition shows referral/source/medium/campaign; Pages and screens shows measured pages; demographic details shows approximate location subject to availability. Viewer access for another exact Google email is optional and requires approval. No retrospective traffic is created, and browser/device user counts do not prove unique humans.

## Validation and official references

Config/copy exact head 68c8c4c passed Linux Test application and founder-billing checks, including full npm test, audit and security scan. Independent review passed. Local analytics/privacy, browser safety, landing-pricing DOM, onboarding journey and blog checks passed. Windows full suite hits an unchanged POSIX permissions assertion; exact-head Linux CI passed it. Re-run exact-head CI after this documentation status update before release.

- https://developers.google.com/tag-platform/security/concepts/consent-mode
- https://developers.google.com/analytics/devguides/collection/ga4/views
- https://developers.google.com/analytics/devguides/collection/ga4/reference/config
- https://support.google.com/analytics/answer/6004245
- https://support.google.com/analytics/answer/9379420
- https://support.google.com/analytics/answer/9626162
- https://support.google.com/analytics/answer/9305587
