# HeyCatch website audit remediation

Source: [HeyCatch SEO audit](https://app.heycatch.ai/audit/hck_pk_Ytw7NVIoMAahVhRRPN0UCxwmyuLEo70-/seo), checked October 9, 2026; reported overall 64/100. Implementation starts from main `c504ce1afdfa36fad5179253053ebfd9d3a555de` in isolated branch `codex/heycatch-public-audit`. This is source work, not a live release or a new auditor score.

The supplied report exposes potential points and affected-page counts, but no individual score/max, passing badges or action plan. **Original score unavailable** for every finding below. Work follows the supplied lowest-dimension order: Authorship 1/5, Page clarity 9.8/18, Quotability 8.3/11, Crawlability 17.6/23. These totals are not individual finding scores.

| Code | Original score | Source outcome |
| --- | --- | --- |
| a_org_schema | Original score unavailable | Keep the existing homepage Organization and add its consistent public name, URL, logo and stable identity to the affected pages. No tenant/company records are used. |
| a_sameas | Original score unavailable | **Blocked on verified official company profile URLs.** No personal account, fabricated social URL or empty public sameAs assertion is published. Existing official URLs were requested. |
| c_title | Original score unavailable | Unique 30–60 character static titles with subject first. Published article titles retain their complete original text; out-of-range titles produce an editorial-review warning instead of truncation. |
| c_duplicate_titles | Original score unavailable | GET/HEAD `/landing.html` permanently redirect to `/`, retaining query parameters. Public navigation links use the root anchors. Browser fragment preservation is checked separately. |
| c_meta_description | Original score unavailable | The affected static pages have accurate 110–160 character descriptions. Published article excerpts remain original and are flagged when outside the editorial target. Legal body text is unchanged. |
| c_image_dimensions | Original score unavailable | Logo images on the affected landing/account pages have actual 482×496 intrinsic dimensions; existing responsive CSS controls displayed size. |
| c_social_cards | Original score unavailable | Shared 1200×630 branded image and accurate per-page Open Graph/Twitter metadata. Article cards use the actual public article text and URL. Private pages contain only generic product metadata. |
| c_title_h1_match | Original score unavailable | Homepage, About, Field Notes, signup, login and recovery titles share the central phrase of their visible heading. Authenticated app content is unchanged. |
| c_hierarchy | Original score unavailable | The sample dashboard label is a styled paragraph instead of an H3 preceding the first H2. A loaded article hides the index hero, leaving its own H1. |
| c_image_format | Original score unavailable | Lossless conversion of the existing logo to WebP, served through picture/source with the original PNG fallback. No new imagery or paid service. |
| g_definition | Original score unavailable | Natural opening definitions on home, About, Field Notes, sign-in and password recovery, describing the existing product or page purpose. |
| g_structured_data | Original score unavailable | Appropriate WebPage/AboutPage/CollectionPage plus Organization metadata. Actual published articles receive BlogPosting, their genuine author and valid stored publication/modification dates. No invented Article schema on legal/account pages. |
| g_sentence_length | Original score unavailable | Short, plain introductory sentences on Field Notes, login and recovery. Stored article bodies and legal content are not rewritten. |
| t_canonical | Original score unavailable | Absolute static canonicals; published articles have their own encoded slug URL in server-rendered and browser metadata. Unknown/draft article URLs return 404/noindex. Tokens and tenant query values are never used in canonicals. Private/account shells retain noindex/nofollow. |
| t_sitemap_fresh | Original score unavailable | Preserve the eight actual public URLs; generate lastmod from each source file's real Git modification date. No wall-clock freshness, private routes or fabricated published articles. Run `npm run sitemap:generate` after committing public-page edits; `npm run sitemap:check` checks provenance. |
| t_robots | Original score unavailable | Already satisfied on current main: read-only public HTTP returned 200 with the sitemap directive. Preserve working app/API/guest exclusions and private indexing protections. IndexNow submission/provider setup is outside this source task and was not performed. |

## Verification and boundaries

New synthetic regressions cover parsed title/description lengths, schema identity, private noindex, logo fallbacks/dimensions, heading order, actual article metadata, missing dates/authors, long-title preservation, malicious markup and literal dollar signs, published-only HTML, unknown/draft noindex, GET/HEAD redirects, working discovery files and blocked private source files. Affected existing blog, landing-pricing and browser-safety tests pass. The legal bodies, account/app behavior, prices, limits, scheduling and Roles sources remain unchanged.

The existing HeyCatch SDK integration on main is preserved. Audit tests and CI regression steps preload a test-only SDK stub to prevent fixture account/billing events from emitting real telemetry; production analytics code/configuration is unchanged. The private localhost browser fixture blocks external requests and rejects writes. No production data, account provisioning, invites, credentials, paid upgrades or provider setup is involved.

Release source review found that the existing `readPlatform()` helper may persist missing support-library records. The new article-head route uses `public-blog-source.js` instead: it reads only the stored platform file, selects an actual Published slug, and performs no writes. A byte-for-byte fixture check verifies published, missing and draft article metadata requests do not change the platform file. This reader is not publicly served.

Full exact-head Linux CI, independent final review and desktop/mobile synthetic browser results are recorded in the draft PR. Windows retains the existing POSIX file-mode assertion limitation; those tests are not weakened. Physical-device testing and a new live HeyCatch audit are not claimed. Merge/deployment remains subject to the parent's storage/recovery release gate; held PR133 and other workspaces are untouched.
