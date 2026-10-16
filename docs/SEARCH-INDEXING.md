# Search indexing

Pro Daily Link serves public marketing pages and the signed-in product from this app. `robots.txt` and `sitemap.xml` are generated per request host.

## Hosts

- `prodailylink.com` and `www.prodailylink.com` are the marketing host. Canonical URLs use `https://prodailylink.com`. Public pages are indexable. Workspace, auth, API, OAuth, and MCP routes are disallowed and send `X-Robots-Tag: noindex, nofollow`.
- `app.prodailylink.com` is the application host. The same private routes are noindex. The public marketing pages stay indexable, with canonical URLs on `https://app.prodailylink.com`, until the marketing domain serves those pages itself.

The homepage, about, Field Notes, comparison pages, terms, and privacy policy are the public URLs in the sitemap. Each has its own title, description, and canonical. Published Field Notes are added as `/blog.html?post=<slug>`.

## IndexNow

On production startup the server submits the sitemap URLs to `https://api.indexnow.org/indexnow`. The submission is not awaited, runs once per process for a given URL list, and does not run when `NODE_ENV` is not `production`, when `npm test` is the current lifecycle, or when `PDL_INDEXNOW=0`.

The key file is `https://<public-host>/<INDEXNOW_KEY>.txt`. If `INDEXNOW_KEY` is unset or invalid, the server uses the documented default:

```text
f4e96dc71c5a80a0538d211e687dfaaa
```

Set `INDEXNOW_KEY` in Render to replace that default. Use 8–128 characters from `a-z`, `A-Z`, `0-9`, and `-`. `PDL_PUBLIC_URL` must stay `https://app.prodailylink.com` so the ping host matches the key file this service serves.

## Search Console and Bing

The one-step ownership check is a DNS TXT record for a **Domain** property in Google Search Console. That covers the apex, `www`, and `app` hostnames. After Google verifies the domain, import the property into Bing Webmaster Tools from Google Search Console. Bing does not need a second tag when it imports from Google.

`GOOGLE_SITE_VERIFICATION` and `BING_SITE_VERIFICATION` are optional HTML-tag alternatives. Each meta tag is rendered only when the variable is set to a plain token:

- Google: `<meta name="google-site-verification" content="...">`
- Bing: `<meta name="msvalidate.01" content="...">`

Leave both unset when using the DNS TXT method.
