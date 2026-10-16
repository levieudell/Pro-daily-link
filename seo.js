'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

// Public IndexNow key. Override with INDEXNOW_KEY. The matching file is served at /<key>.txt.
const DEFAULT_INDEXNOW_KEY = 'f4e96dc71c5a80a0538d211e687dfaaa';
const INDEXNOW_ENDPOINT = 'https://api.indexnow.org/indexnow';

const PUBLIC_PAGES = [
  { path: '/', file: 'landing.html', priority: '1.0' },
  { path: '/about.html', file: 'about.html', priority: '0.8' },
  { path: '/blog.html', file: 'blog.html', priority: '0.8' },
  { path: '/vs/raken.html', file: 'vs/raken.html', priority: '0.7' },
  { path: '/vs/procore.html', file: 'vs/procore.html', priority: '0.7' },
  { path: '/vs/paper-daily-logs.html', file: 'vs/paper-daily-logs.html', priority: '0.7' },
  { path: '/terms.html', file: 'terms.html', priority: '0.3' },
  { path: '/privacy.html', file: 'privacy.html', priority: '0.3' }
];

// Prefix rules use robots.txt matching: a path is private when it starts with the rule.
// /mcp is exact so /MCP.md stays available. /app also covers /app.js.
const ROBOTS_DISALLOWS = [
  '/app',
  '/index.html',
  '/api',
  '/mcp$',
  '/mcp/',
  '/oauth',
  '/.well-known/',
  '/guest',
  '/login.html',
  '/signup.html',
  '/forgot-password.html',
  '/reset-password.html',
  '/verify-email.html',
  '/platform',
  '/support.html',
  '/change-order.html',
  '/uploads/'
];

const PRIVATE_EXACT = new Set(['/index.html', '/mcp', '/login.html', '/signup.html', '/forgot-password.html', '/reset-password.html', '/verify-email.html', '/support.html', '/change-order.html']);
const PRIVATE_PREFIXES = ['/app', '/api', '/oauth', '/.well-known', '/guest', '/platform', '/uploads'];

let lastIndexNowSignature = null;
let indexNowJob = null;

function indexNowKey(env = process.env) {
  const value = String(env.INDEXNOW_KEY || '').trim();
  return /^[A-Za-z0-9-]{8,128}$/.test(value) ? value : DEFAULT_INDEXNOW_KEY;
}

function normalizePath(pathname) {
  let value = String(pathname || '/');
  try { value = decodeURIComponent(value); } catch { /* keep the raw path */ }
  if (!value.startsWith('/')) value = `/${value}`;
  if (value.length > 1 && value.endsWith('/')) value = value.slice(0, -1);
  return value;
}

function requestHost(req) {
  const forwarded = String(req.headers?.['x-forwarded-host'] || '').split(',')[0].trim().toLowerCase();
  const host = String(req.headers?.host || '').split(',')[0].trim().toLowerCase();
  const forwardedName = hostnameOf(forwarded);
  if (isMarketingHost(forwardedName) || forwardedName === 'app.prodailylink.com') return forwarded;
  return host;
}

function hostnameOf(host) {
  const value = String(host || '');
  if (value.startsWith('[')) return value;
  return value.replace(/:\d+$/, '');
}

function isMarketingHost(hostname) {
  return hostname === 'prodailylink.com' || hostname === 'www.prodailylink.com';
}

function originOf(req) {
  const host = requestHost(req);
  const hostname = hostnameOf(host);
  if (isMarketingHost(hostname)) return 'https://prodailylink.com';
  if (hostname === 'app.prodailylink.com') return 'https://app.prodailylink.com';
  const forwarded = String(req.headers?.['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  const proto = forwarded === 'https' || forwarded === 'http' ? forwarded : 'http';
  return `${proto}://${host || 'localhost'}`;
}

function isPublicPage(pathname) {
  const path = normalizePath(pathname);
  return path === '/landing.html' || PUBLIC_PAGES.some(page => page.path === path);
}

function shouldNoindex(pathname, env = process.env) {
  const path = normalizePath(pathname);
  if (path === '/robots.txt' || path === '/sitemap.xml' || path === '/llms.txt' || path === `/${indexNowKey(env)}.txt`) return false;
  if (isPublicPage(path)) return false;
  if (PRIVATE_EXACT.has(path)) return true;
  return PRIVATE_PREFIXES.some(prefix => path === prefix || path.startsWith(`${prefix}/`) || path.startsWith(prefix));
}

function escapeAttr(value) {
  return String(value).replace(/[&"<>]/g, char => ({ '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' }[char]));
}

function escapeXml(value) {
  return String(value).replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&apos;', '"': '&quot;' }[char]));
}

function verificationTags(env = process.env) {
  const tags = [];
  const google = String(env.GOOGLE_SITE_VERIFICATION || '').trim();
  const bing = String(env.BING_SITE_VERIFICATION || '').trim();
  if (/^[A-Za-z0-9_-]{8,128}$/.test(google)) tags.push(`<meta name="google-site-verification" content="${escapeAttr(google)}">`);
  if (/^[A-Za-z0-9]{8,128}$/.test(bing)) tags.push(`<meta name="msvalidate.01" content="${escapeAttr(bing)}">`);
  return tags.join('');
}

function canonicalUrl(req, url) {
  const pathname = normalizePath(url.pathname);
  if (!isPublicPage(pathname)) return null;
  const origin = originOf(req);
  if (pathname === '/blog.html') {
    const post = String(url.searchParams?.get('post') || '');
    if (/^[a-z0-9-]+$/.test(post)) return `${origin}/blog.html?post=${encodeURIComponent(post)}`;
  }
  const canonicalPath = pathname === '/' || pathname === '/landing.html' ? '/' : pathname;
  return `${origin}${canonicalPath}`;
}

function robotsTxt(origin) {
  const marketing = origin === 'https://prodailylink.com';
  const lines = [
    `# ${marketing ? 'prodailylink.com marketing host. Public pages are indexable.' : 'Application host. Public marketing pages stay indexable. Workspace, auth, API, OAuth, and MCP do not.'}`,
    'User-agent: *',
    'Allow: /',
    ...ROBOTS_DISALLOWS.map(rule => `Disallow: ${rule}`),
    '',
    `Sitemap: ${origin}/sitemap.xml`,
    ''
  ];
  return lines.join('\n');
}

function lastmodFor(file) {
  try {
    return fs.statSync(path.join(__dirname, file)).mtime.toISOString().slice(0, 10);
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

function readPublishedPosts(env = process.env) {
  try {
    const file = env.PDL_PLATFORM_FILE || path.join(__dirname, 'data', 'platform.json');
    const platform = JSON.parse(fs.readFileSync(file, 'utf8'));
    return (platform.blogPosts || []).filter(post => post.status === 'Published' && /^[a-z0-9-]+$/.test(String(post.slug || ''))).map(post => ({
      slug: post.slug,
      lastmod: String(post.updatedAt || post.publishedAt || '').slice(0, 10)
    }));
  } catch {
    return [];
  }
}

function sitemapEntries(posts = readPublishedPosts()) {
  const pages = PUBLIC_PAGES.map(page => ({
    path: page.path,
    lastmod: lastmodFor(page.file),
    priority: page.priority
  }));
  const notes = posts.map(post => ({
    path: `/blog.html?post=${encodeURIComponent(post.slug)}`,
    lastmod: /^\d{4}-\d{2}-\d{2}$/.test(post.lastmod) ? post.lastmod : lastmodFor('blog.html'),
    priority: '0.6'
  }));
  return [...pages, ...notes];
}

function sitemapXml(origin, posts) {
  const urls = sitemapEntries(posts).map(entry => {
    const loc = `${origin}${entry.path === '/' ? '/' : entry.path}`;
    return `  <url><loc>${escapeXml(loc)}</loc><lastmod>${entry.lastmod}</lastmod><priority>${entry.priority}</priority></url>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`;
}

function productionOrigin(env = process.env) {
  try {
    const url = new URL(String(env.PDL_PUBLIC_URL || '').trim());
    if (url.protocol === 'https:' && url.hostname && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') return url.origin;
  } catch { /* fall through to the live app origin */ }
  return 'https://app.prodailylink.com';
}

function markNoindex(res, pathname, env = process.env) {
  if (shouldNoindex(pathname, env)) res.setHeader('X-Robots-Tag', 'noindex, nofollow');
}

function dynamicBody(req, url, env = process.env) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return null;
  const pathname = normalizePath(url.pathname);
  const origin = originOf(req);
  if (pathname === '/robots.txt') {
    return { status: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=300' }, body: robotsTxt(origin) };
  }
  if (pathname === '/sitemap.xml') {
    return { status: 200, headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=300' }, body: sitemapXml(origin) };
  }
  const key = indexNowKey(env);
  if (pathname === `/${key}.txt`) {
    return { status: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=300' }, body: key };
  }
  return null;
}

function decorateHtml(html, req, url, env = process.env) {
  let next = String(html);
  const pathname = normalizePath(url.pathname);
  const tags = verificationTags(env);
  if (tags && !next.includes('google-site-verification') && !next.includes('msvalidate.01')) {
    next = next.replace(/<head\b[^>]*>/i, match => `${match}${tags}`);
  }
  if (isPublicPage(pathname)) {
    next = next.replace(/<meta\s+[^>]*name=["']robots["'][^>]*>/gi, '');
    const canonical = canonicalUrl(req, url);
    const origin = originOf(req);
    next = next.replace(/<head\b[^>]*>[\s\S]*?<\/head>/i, head => head.replaceAll('https://app.prodailylink.com', origin).replaceAll('https://prodailylink.com', origin));
    const canonicalTag = `<link rel="canonical" href="${escapeAttr(canonical)}">`;
    if (/<link\s+[^>]*rel=["']canonical["'][^>]*>/i.test(next)) next = next.replace(/<link\s+[^>]*rel=["']canonical["'][^>]*>/i, canonicalTag);
    else next = next.replace(/<head\b[^>]*>/i, match => `${match}${canonicalTag}`);
    next = next.replace(/(<meta\s+[^>]*property=["']og:url["'][^>]*content=["'])[^"']*(["'])/i, `$1${escapeAttr(canonical)}$2`);
    return next;
  }
  if (!shouldNoindex(pathname, env)) return next;
  if (/<meta\s+[^>]*name=["']robots["'][^>]*>/i.test(next)) {
    next = next.replace(/<meta\s+[^>]*name=["']robots["'][^>]*>/i, '<meta name="robots" content="noindex, nofollow">');
  } else {
    next = next.replace(/<head\b[^>]*>/i, match => `${match}<meta name="robots" content="noindex, nofollow">`);
  }
  return next;
}

function indexNowAllowed(env) {
  if (env.NODE_ENV !== 'production') return 'not-production';
  if (env.PDL_INDEXNOW === '0') return 'disabled';
  if (env.npm_lifecycle_event === 'test') return 'test';
  return null;
}

function scheduleIndexNowPing(options = {}) {
  const env = options.env || process.env;
  const skipped = indexNowAllowed(env);
  if (skipped) return { skipped };
  const origin = options.origin || productionOrigin(env);
  const posts = options.posts || readPublishedPosts(env);
  const urlList = sitemapEntries(posts).map(entry => `${origin}${entry.path === '/' ? '/' : entry.path}`);
  const key = indexNowKey(env);
  const payload = { host: new URL(origin).host, key, keyLocation: `${origin}/${key}.txt`, urlList };
  const signature = crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  const persist = options.persist !== false;
  const stamp = path.join(options.stampDir || os.tmpdir(), `pdl-indexnow-${signature}.stamp`);
  if (lastIndexNowSignature === signature || indexNowJob) return { skipped: 'already-submitted' };
  if (persist && fs.existsSync(stamp)) {
    lastIndexNowSignature = signature;
    return { skipped: 'already-submitted' };
  }
  lastIndexNowSignature = signature;
  const fetchImpl = options.fetch || global.fetch;
  const done = Promise.resolve().then(() => fetchImpl(INDEXNOW_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(payload)
  })).then(response => {
    const status = Number(response?.status || 0);
    if ((status === 200 || status === 202) && persist) {
      try { fs.writeFileSync(stamp, signature); } catch (error) { console.error('IndexNow stamp failed', error.message); }
    } else if (status !== 200 && status !== 202) console.error('IndexNow ping was not accepted', status);
    return { ok: status === 200 || status === 202, status };
  }).catch(error => {
    console.error('IndexNow ping failed', error.message);
    return { ok: false, error: error.message };
  }).finally(() => { indexNowJob = null; });
  indexNowJob = done;
  return { started: true, done };
}

function resetIndexNowForTests() {
  lastIndexNowSignature = null;
  indexNowJob = null;
}

module.exports = {
  DEFAULT_INDEXNOW_KEY,
  INDEXNOW_ENDPOINT,
  PUBLIC_PAGES,
  ROBOTS_DISALLOWS,
  indexNowKey,
  normalizePath,
  originOf,
  isPublicPage,
  shouldNoindex,
  verificationTags,
  canonicalUrl,
  robotsTxt,
  sitemapXml,
  sitemapEntries,
  readPublishedPosts,
  productionOrigin,
  markNoindex,
  dynamicBody,
  decorateHtml,
  scheduleIndexNowPing,
  resetIndexNowForTests
};
