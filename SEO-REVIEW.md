# Public search discovery draft

Base: bdbdfe9a8b038d3dbc32327c58f5a529dbe71225. No production changes or tracking activation.

## Verified public observations (8 October 2026)
- Homepage is surfaced in search results at https://app.prodailylink.com/. This proves observed discovery, not full Google index coverage.
- Anonymous HTTPS GET of both https://prodailylink.com/ and https://www.prodailylink.com/ ends at https://app.prodailylink.com/ with a 200 HTML response. Preserve current hosting redirects; no new redirect code.
- /robots.txt and /sitemap.xml return 404 on all three hosts. Missing robots does not itself block crawling. Missing sitemap limits an explicit discovery signal.
- Homepage HTML has no canonical link. /landing.html and / are the same source document. Draft consolidates canonical to the current app-host homepage.
- Search also surfaces signup query variants and an older apex /Home listing. Search Console status, coverage and obsolete URL handling remain unknown; inspect both before requesting removals or redirects.

## Draft implementation
- Unique factual homepage and founder-page titles/descriptions; canonical homepage/about/privacy/terms URLs.
- Sitemap lists only the five public information pages. No customer records, accounts, projects, signup queries, dashboard, guest links or fabricated articles.
- robots permits public crawling, including OAI-SearchBot through its existing wildcard default, while excluding API/upload/token guest paths. No GPTBot-specific training-policy change.
- Account/workspace/guest/platform/support shells receive noindex metadata. This is indexing guidance, not access control. Existing authentication and public-file allowlist remain in force.
- txt/xml content types and allowlist entries make crawler files actually servable.
- Existing H1, founder claim, prices, entitlements, sample labels, CTA pairs and workflow copy remain intact. Useful search terminology is construction daily report software, field reporting, crew hours, production tracking and extra-work flags, supported by current public product/workflow copy.

## Release checks and decisions
- Blog articles are JavaScript-loaded query URLs. Do not canonicalize all articles to the listing. A later published-content-only rendering decision should define article metadata, stable URLs and sitemap entries; no customer data should enter that process.
- Preserve GA4 branch codex/public-ga4-consent-draft includes on landing/about/blog/signup/privacy/terms during integration. Its config stays disabled pending verified property and privacy approval. No tracking changes are in this draft.
- Search Console: owner opens https://search.google.com/search-console, selects an existing authorized property or adds Domain prodailylink.com, and completes Google's DNS TXT verification through the existing DNS provider. No access grants or credentials have been requested here. Once verified, inspect app-host homepage, submit https://app.prodailylink.com/sitemap.xml and examine canonical/coverage. A URL-prefix property https://app.prodailylink.com/ is an alternative using a supported verification method.
- Check hosting/CDN access against official OpenAI published searchbot IP ranges; a user-agent string alone cannot prove crawler access. No bot firewall/account changes are proposed.
- No ranking or ChatGPT recommendation guarantee. Search discovery permission is independent of GPTBot training policy.

## Official guidance
- https://developers.openai.com/api/docs/bots
- https://developers.google.com/search/docs/essentials/technical
- https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap
- https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls
- https://developers.google.com/search/docs/crawling-indexing/block-indexing

## Validation
Run node public-search.test.js, node --check server.js and git diff --check. Integration must rerun exact branch checks with GA4 includes and verify robots/sitemap HTTP responses in a synthetic local server before release. This draft has not been deployed.
