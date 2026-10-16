'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const seo = require('./seo');

const productionEnv = { NODE_ENV: 'production', PDL_PUBLIC_URL: 'https://app.prodailylink.com' };

function request(host, pathname, headers = {}) {
  const url = new URL(pathname, 'http://localhost');
  return [{ headers: { host, ...headers } }, url];
}

(async () => {
  seo.resetIndexNowForTests();
  assert.equal(seo.indexNowKey({}), seo.DEFAULT_INDEXNOW_KEY);
  assert.equal(seo.indexNowKey({ INDEXNOW_KEY: 'short' }), seo.DEFAULT_INDEXNOW_KEY);
  assert.equal(seo.indexNowKey({ INDEXNOW_KEY: 'custom-key-1234' }), 'custom-key-1234');
  assert.equal(seo.verificationTags({}), '');
  assert.equal(seo.verificationTags({ GOOGLE_SITE_VERIFICATION: '<script>alert(1)</script>', BING_SITE_VERIFICATION: 'bad token' }), '');
  assert.match(seo.verificationTags({ GOOGLE_SITE_VERIFICATION: 'googleToken_12345678' }), /name="google-site-verification" content="googleToken_12345678"/);
  assert.match(seo.verificationTags({ BING_SITE_VERIFICATION: '0123456789ABCDEF' }), /name="msvalidate\.01" content="0123456789ABCDEF"/);
  assert.doesNotMatch(seo.verificationTags({ GOOGLE_SITE_VERIFICATION: 'googleToken_12345678' }), /msvalidate/);

  const [appReq, appHome] = request('app.prodailylink.com', '/');
  const [wwwReq, wwwHome] = request('www.prodailylink.com', '/', { 'x-forwarded-host': 'www.prodailylink.com', 'x-forwarded-proto': 'https' });
  const [apexReq, apexAbout] = request('prodailylink.com', '/about.html', { 'x-forwarded-host': 'prodailylink.com' });
  assert.equal(seo.originOf(appReq), 'https://app.prodailylink.com');
  assert.equal(seo.originOf(wwwReq), 'https://prodailylink.com');
  assert.equal(seo.canonicalUrl(apexReq, apexAbout), 'https://prodailylink.com/about.html');
  assert.equal(seo.canonicalUrl(appReq, new URL('/landing.html', 'http://localhost')), 'https://app.prodailylink.com/');
  assert.equal(seo.canonicalUrl(appReq, new URL('/blog.html?post=daily-notes', 'http://localhost')), 'https://app.prodailylink.com/blog.html?post=daily-notes');
  assert.equal(seo.canonicalUrl(appReq, new URL('/blog.html?post=../secret', 'http://localhost')), 'https://app.prodailylink.com/blog.html');
  assert.equal(seo.canonicalUrl(appReq, new URL('/login.html', 'http://localhost')), null);

  for (const pathname of ['/app', '/app.js', '/index.html', '/api/health', '/mcp', '/oauth/authorize', '/.well-known/oauth-authorization-server', '/guest.html', '/guest/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '/login.html', '/signup.html', '/forgot-password.html', '/reset-password.html', '/verify-email.html', '/platform.html', '/platform-login.html', '/support.html', '/change-order.html', '/uploads/logo.png']) {
    assert.equal(seo.shouldNoindex(pathname), true, pathname);
  }
  for (const pathname of ['/', '/landing.html', '/about.html', '/blog.html', '/vs/raken.html', '/vs/procore.html', '/vs/paper-daily-logs.html', '/terms.html', '/privacy.html', '/robots.txt', '/sitemap.xml', '/llms.txt', '/MCP.md', `/${seo.DEFAULT_INDEXNOW_KEY}.txt`]) {
    assert.equal(seo.shouldNoindex(pathname), false, pathname);
  }

  const appRobots = seo.robotsTxt('https://app.prodailylink.com');
  const marketingRobots = seo.robotsTxt('https://prodailylink.com');
  assert.equal(appRobots, fs.readFileSync(path.join(__dirname, 'robots.txt'), 'utf8'));
  assert.match(appRobots, /Allow: \/\n/);
  assert.match(appRobots, /Sitemap: https:\/\/app\.prodailylink\.com\/sitemap\.xml/);
  assert.match(marketingRobots, /Sitemap: https:\/\/prodailylink\.com\/sitemap\.xml/);
  assert.match(marketingRobots, /marketing host/);
  assert.doesNotMatch(appRobots, /^Disallow: \/$/m);
  for (const rule of ['/app', '/api', '/mcp$', '/oauth', '/guest', '/login.html', '/signup.html', '/platform', '/uploads/']) {
    assert.match(appRobots, new RegExp(`Disallow: ${rule.replace('$', '\\$')}`));
    assert.match(marketingRobots, new RegExp(`Disallow: ${rule.replace('$', '\\$')}`));
  }

  const sitemap = seo.sitemapXml('https://app.prodailylink.com', []);
  assert.match(sitemap, /<loc>https:\/\/app\.prodailylink\.com\/<\/loc><lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/);
  assert.match(sitemap, /<loc>https:\/\/app\.prodailylink\.com\/about\.html<\/loc>/);
  assert.match(sitemap, /<loc>https:\/\/app\.prodailylink\.com\/vs\/paper-daily-logs\.html<\/loc>/);
  assert.doesNotMatch(sitemap, /\/app</);
  assert.doesNotMatch(sitemap, /login\.html/);
  const noteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-seo-notes-'));
  const noteFile = path.join(noteDir, 'platform.json');
  fs.writeFileSync(noteFile, JSON.stringify({ blogPosts: [{ status: 'Published', slug: 'daily-notes', updatedAt: '2026-10-02T00:00:00.000Z' }, { status: 'Draft', slug: 'hidden-note', updatedAt: '2026-10-03T00:00:00.000Z' }] }));
  assert.deepEqual(seo.readPublishedPosts({ PDL_PLATFORM_FILE: noteFile }), [{ slug: 'daily-notes', lastmod: '2026-10-02' }]);
  assert.match(seo.sitemapXml('https://prodailylink.com', seo.readPublishedPosts({ PDL_PLATFORM_FILE: noteFile })), /<loc>https:\/\/prodailylink\.com\/blog\.html\?post=daily-notes<\/loc><lastmod>2026-10-02<\/lastmod>/);
  assert.doesNotMatch(seo.sitemapXml('https://prodailylink.com', seo.readPublishedPosts({ PDL_PLATFORM_FILE: noteFile })), /hidden-note/);

  const decorated = seo.decorateHtml('<html><head><title>About</title></head><body></body></html>', apexReq, apexAbout, { GOOGLE_SITE_VERIFICATION: 'googleToken_12345678', BING_SITE_VERIFICATION: '0123456789ABCDEF' });
  assert.match(decorated, /rel="canonical" href="https:\/\/prodailylink\.com\/about\.html"/);
  assert.match(decorated, /google-site-verification/);
  assert.match(decorated, /msvalidate\.01/);
  assert.doesNotMatch(decorated, /noindex/);
  const privateHtml = seo.decorateHtml('<html><head><title>Sign in</title></head></html>', appReq, new URL('/login.html', 'http://localhost'), {});
  assert.match(privateHtml, /name="robots" content="noindex, nofollow"/);
  assert.doesNotMatch(privateHtml, /google-site-verification/);
  const stripped = seo.decorateHtml('<html><head><meta name="robots" content="noindex, nofollow"><title>Home</title></head></html>', appReq, appHome, {});
  assert.doesNotMatch(stripped, /noindex/);

  const skipped = seo.scheduleIndexNowPing({ env: { NODE_ENV: 'test' }, persist: false, fetch: async () => { throw new Error('IndexNow ran in test'); } });
  assert.equal(skipped.skipped, 'not-production');
  const lifecycle = process.env.npm_lifecycle_event;
  const nodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  process.env.npm_lifecycle_event = 'test';
  const duringTest = seo.scheduleIndexNowPing({ persist: false, fetch: async () => { throw new Error('IndexNow ran under npm test'); } });
  assert.equal(duringTest.skipped, 'test');
  if (lifecycle === undefined) delete process.env.npm_lifecycle_event; else process.env.npm_lifecycle_event = lifecycle;
  if (nodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = nodeEnv;

  const stampDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-indexnow-'));
  let calls = [];
  let release;
  const pending = seo.scheduleIndexNowPing({
    env: productionEnv,
    persist: true,
    stampDir,
    fetch: (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return new Promise(resolve => { release = () => resolve({ ok: true, status: 202 }); });
    }
  });
  assert.equal(pending.started, true);
  assert.equal(calls.length, 0, 'IndexNow must not block startup');
  const duplicate = seo.scheduleIndexNowPing({ env: productionEnv, persist: true, stampDir, fetch: async () => { throw new Error('second ping'); } });
  assert.equal(duplicate.skipped, 'already-submitted');
  await Promise.resolve();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, seo.INDEXNOW_ENDPOINT);
  assert.equal(calls[0].body.host, 'app.prodailylink.com');
  assert.equal(calls[0].body.key, seo.DEFAULT_INDEXNOW_KEY);
  assert.equal(calls[0].body.keyLocation, `https://app.prodailylink.com/${seo.DEFAULT_INDEXNOW_KEY}.txt`);
  assert.ok(calls[0].body.urlList.includes('https://app.prodailylink.com/'));
  assert.ok(calls[0].body.urlList.includes('https://app.prodailylink.com/about.html'));
  assert.ok(!calls[0].body.urlList.some(url => url.includes('/login') || url.endsWith('/app')));
  release();
  assert.deepEqual(await pending.done, { ok: true, status: 202 });
  seo.resetIndexNowForTests();
  const stamped = seo.scheduleIndexNowPing({ env: productionEnv, persist: true, stampDir, fetch: async () => { throw new Error('stamp ignored'); } });
  assert.equal(stamped.skipped, 'already-submitted');

  seo.resetIndexNowForTests();
  const failDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-indexnow-fail-'));
  const failed = await seo.scheduleIndexNowPing({
    env: productionEnv,
    persist: true,
    stampDir: failDir,
    fetch: async () => { throw new Error('down'); }
  }).done;
  assert.equal(failed.ok, false);
  assert.equal(fs.readdirSync(failDir).length, 0);
  const serverSource = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  const bootAt = serverSource.indexOf('if(require.main===module)');
  assert.ok(bootAt > 0);
  assert.match(serverSource.slice(bootAt), /seo\.scheduleIndexNowPing\(\)/);
  assert.doesNotMatch(serverSource.slice(0, bootAt), /scheduleIndexNowPing\(\)/);

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-seo-http-'));
  process.env.PDL_DB_FILE = path.join(temp, 'db.json');
  process.env.PDL_PLATFORM_FILE = path.join(temp, 'platform.json');
  process.env.PDL_SUPABASE_ENABLED = '0';
  process.env.PDL_REQUIRE_AUTH = '1';
  process.env.PDL_EMAIL_DEV_MODE = '1';
  process.env.NODE_ENV = 'test';
  process.env.GOOGLE_SITE_VERIFICATION = 'googleToken_12345678';
  process.env.BING_SITE_VERIFICATION = '0123456789ABCDEF';
  delete process.env.INDEXNOW_KEY;
  fs.copyFileSync(path.join(__dirname, 'data', 'db.json'), process.env.PDL_DB_FILE);
  fs.copyFileSync(path.join(__dirname, 'data', 'platform.json'), process.env.PDL_PLATFORM_FILE);
  const { server } = require('./server');
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function get(pathname, host) {
    const response = await fetch(base + pathname, { headers: { 'x-forwarded-host': host, 'x-forwarded-proto': 'https' } });
    return { response, text: await response.text() };
  }
  const titles = new Map();
  const descriptions = new Map();
  for (const pathname of ['/', '/about.html', '/blog.html', '/vs/raken.html', '/vs/procore.html', '/vs/paper-daily-logs.html', '/terms.html', '/privacy.html']) {
    const { response, text } = await get(pathname, 'app.prodailylink.com');
    assert.equal(response.status, 200, pathname);
    assert.equal(response.headers.get('x-robots-tag'), null, pathname);
    const title = text.match(/<title>([^<]+)<\/title>/)[1];
    const description = text.match(/<meta name="description" content="([^"]+)"/)[1];
    titles.set(pathname, title);
    descriptions.set(pathname, description);
    assert.ok(title.length > 10, pathname);
    assert.ok(description.length > 20, pathname);
    const canonicalPath = pathname === '/' ? '/' : pathname;
    assert.match(text, new RegExp(`rel="canonical" href="https://app\\.prodailylink\\.com${canonicalPath.replace(/[.]/g, '\\.')}"`));
    assert.match(text, /google-site-verification" content="googleToken_12345678"/);
    assert.match(text, /msvalidate\.01" content="0123456789ABCDEF"/);
  }
  assert.equal(new Set(titles.values()).size, titles.size);
  assert.equal(new Set(descriptions.values()).size, descriptions.size);

  const marketingHome = await get('/', 'www.prodailylink.com');
  assert.match(marketingHome.text, /rel="canonical" href="https:\/\/prodailylink\.com\/"/);
  assert.equal(marketingHome.response.headers.get('x-robots-tag'), null);
  const marketingRobotsHttp = await get('/robots.txt', 'prodailylink.com');
  assert.equal(marketingRobotsHttp.text, seo.robotsTxt('https://prodailylink.com'));
  assert.match(marketingRobotsHttp.text, /Sitemap: https:\/\/prodailylink\.com\/sitemap\.xml/);
  const appRobotsHttp = await get('/robots.txt', 'app.prodailylink.com');
  assert.equal(appRobotsHttp.text, seo.robotsTxt('https://app.prodailylink.com'));
  const appSitemap = await get('/sitemap.xml', 'app.prodailylink.com');
  assert.match(appSitemap.text, /<loc>https:\/\/app\.prodailylink\.com\/<\/loc><lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/);
  assert.doesNotMatch(appSitemap.text, /login\.html/);
  const key = await get(`/${seo.DEFAULT_INDEXNOW_KEY}.txt`, 'app.prodailylink.com');
  assert.equal(key.response.status, 200);
  assert.equal(key.text, seo.DEFAULT_INDEXNOW_KEY);
  assert.equal(key.response.headers.get('content-type'), 'text/plain; charset=utf-8');

  for (const pathname of ['/app', '/login.html', '/signup.html', '/forgot-password.html', '/reset-password.html', '/verify-email.html', '/platform.html', '/guest.html', '/support.html', '/change-order.html', '/index.html']) {
    const { response, text } = await get(pathname, 'app.prodailylink.com');
    assert.equal(response.status, 200, pathname);
    assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow', pathname);
    assert.match(text, /noindex, nofollow/, pathname);
  }
  const guest = await get('/guest/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'app.prodailylink.com');
  assert.equal(guest.response.headers.get('x-robots-tag'), 'noindex, nofollow');
  const stats = await get('/api/public/stats', 'app.prodailylink.com');
  assert.equal(stats.response.headers.get('x-robots-tag'), 'noindex, nofollow');
  const mcp = await get('/mcp', 'app.prodailylink.com');
  assert.equal(mcp.response.headers.get('x-robots-tag'), 'noindex, nofollow');
  const oauth = await get('/oauth/authorize', 'app.prodailylink.com');
  assert.equal(oauth.response.headers.get('x-robots-tag'), 'noindex, nofollow');
  const metadata = await get('/.well-known/oauth-authorization-server', 'app.prodailylink.com');
  assert.equal(metadata.response.headers.get('x-robots-tag'), 'noindex, nofollow');

  console.log('SEO indexing tests passed');
  server.close();
  process.exit(0);
})().catch(error => {
  console.error(error);
  process.exit(1);
});
