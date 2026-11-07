'use strict';

const DEFAULT_MARKETING_ORIGIN = 'https://prodailylink.com';
const DEFAULT_APP_ORIGIN = 'https://app.prodailylink.com';

// One registry owns public marketing routing, canonical URLs, and sitemap entries.
const MARKETING_ROUTES = Object.freeze([
  Object.freeze({ path: '/', file: 'landing.html', aliases: ['/landing', '/landing.html'], priority: '1.0' }),
  Object.freeze({ path: '/about', file: 'about.html', aliases: ['/about.html'], priority: '0.8' }),
  Object.freeze({ path: '/blog', file: 'blog.html', aliases: ['/blog.html'], children: true, priority: '0.8' }),
  Object.freeze({ path: '/vs/raken.html', file: 'vs/raken.html', aliases: [], priority: '0.7' }),
  Object.freeze({ path: '/vs/procore.html', file: 'vs/procore.html', aliases: [], priority: '0.7' }),
  Object.freeze({ path: '/vs/paper-daily-logs.html', file: 'vs/paper-daily-logs.html', aliases: [], priority: '0.7' }),
  Object.freeze({ path: '/terms', file: 'terms.html', aliases: ['/terms.html'], priority: '0.3' }),
  Object.freeze({ path: '/privacy', file: 'privacy.html', aliases: ['/privacy.html'], priority: '0.3' })
]);

const MARKETING_ASSETS = new Set([
  '/analytics.js', '/blog.js', '/enterprise-pricing.css', '/landing-content.js',
  '/landing-demo.css', '/landing-demo.js', '/landing.css', '/legal.css',
  '/public-content.css', '/public-header.js', '/favicon.ico'
]);

function cleanOrigin(value, fallback) {
  try { return new URL(value || fallback).origin; } catch { return fallback; }
}

function config(env = process.env) {
  const marketingOrigin = cleanOrigin(env.MARKETING_ORIGIN, DEFAULT_MARKETING_ORIGIN);
  const appOrigin = cleanOrigin(env.APP_ORIGIN, DEFAULT_APP_ORIGIN);
  return {
    marketingOrigin,
    appOrigin,
    marketingHost: new URL(marketingOrigin).hostname.toLowerCase(),
    appHost: new URL(appOrigin).hostname.toLowerCase(),
    live: String(env.ROOT_DOMAIN_LIVE || '').toLowerCase() === 'true'
  };
}

function requestHost(headers = {}) {
  return String(headers.host || '').trim().toLowerCase().replace(/:\d+$/, '');
}

function marketingRoute(pathname) {
  for (const route of MARKETING_ROUTES) {
    if (pathname === route.path || route.aliases.includes(pathname)) return { ...route, canonicalPath: route.path };
    if (route.children && pathname.startsWith(`${route.path}/`) && pathname.length > route.path.length + 1) {
      return { ...route, canonicalPath: pathname };
    }
  }
  return null;
}

function marketingAsset(pathname) {
  return pathname.startsWith('/assets/') || MARKETING_ASSETS.has(pathname);
}

function samePath(origin, url) {
  return `${origin}${url.pathname}${url.search}`;
}

function hostAction({ headers = {}, method = 'GET', url, env = process.env }) {
  const settings = config(env);
  const host = requestHost(headers);
  const marketing = marketingRoute(url.pathname);
  const asset = marketingAsset(url.pathname);
  const special = url.pathname === '/robots.txt' || url.pathname === '/sitemap.xml';
  const proto = String(headers['x-forwarded-proto'] || 'https').split(',')[0].trim().toLowerCase();

  if (host === `www.${settings.marketingHost}`) {
    return { type: 'redirect', status: 301, location: samePath(settings.marketingOrigin, url) };
  }
  if (host === settings.marketingHost) {
    if (proto === 'http') return { type: 'redirect', status: 301, location: samePath(settings.marketingOrigin, url) };
    if (url.pathname === '/robots.txt') return { type: 'robots', audience: 'marketing', settings };
    if (url.pathname === '/sitemap.xml') return { type: 'sitemap', settings };
    if (marketing) return { type: 'marketing', route: marketing, settings };
    if (asset) return { type: 'asset', settings };
    const permanentMethod = method !== 'GET' && method !== 'HEAD';
    return { type: 'redirect', status: permanentMethod ? 308 : 301, location: samePath(settings.appOrigin, url) };
  }
  if (host === settings.appHost) {
    if (url.pathname === '/robots.txt') return { type: 'robots', audience: 'app', settings };
    if (settings.live && url.pathname === '/sitemap.xml') {
      return { type: 'redirect', status: 301, location: `${settings.marketingOrigin}/sitemap.xml${url.search}` };
    }
    if (settings.live && marketing && url.pathname !== '/') {
      return { type: 'redirect', status: 301, location: samePath(settings.marketingOrigin, url) };
    }
    if (settings.live && url.pathname === '/') return { type: 'app-root', settings };
  }
  return null;
}

function escapeXml(value) {
  return String(value).replace(/[<>&'\"]/g, character => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[character]));
}

function sitemapXml(marketingOrigin) {
  const urls = MARKETING_ROUTES.map(route => `  <url><loc>${escapeXml(marketingOrigin + route.path)}</loc><priority>${route.priority}</priority></url>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

function robotsText(audience, marketingOrigin) {
  if (audience === 'app') return 'User-agent: *\nDisallow: /\n';
  return `User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /guest/\n\nSitemap: ${marketingOrigin}/sitemap.xml\n`;
}

function absoluteAppLinks(html, appOrigin) {
  return html.replace(/(<a\b[^>]*\bhref=["'])(\/(?:signup(?:\.html)?|login(?:\.html)?|app)(?:[^"']*)?)(["'])/gi,
    (_match, before, href, quote) => `${before}${appOrigin}${href}${quote}`);
}

function marketingHtml(html, route, settings) {
  const canonical = `${settings.marketingOrigin}${route.canonicalPath === '/' ? '/' : route.canonicalPath}`;
  let output = html;
  output = output.replace(/<link\s+rel=["']canonical["'][^>]*>/i, `<link rel="canonical" href="${canonical}">`);
  if (!/<link\s+rel=["']canonical["']/i.test(output)) output = output.replace('</head>', `<link rel="canonical" href="${canonical}"></head>`);
  output = output.replace(/<meta\s+property=["']og:url["'][^>]*>/i, `<meta property="og:url" content="${canonical}">`);
  if (!/<meta\s+property=["']og:url["']/i.test(output)) output = output.replace('</head>', `<meta property="og:url" content="${canonical}"></head>`);
  output = output.replace(/https:\/\/app\.prodailylink\.com(?=\/assets\/(?:og-image\.png|pro-daily-link-logo\.png)|\/(?:"|\\"))/g, settings.marketingOrigin);
  output = absoluteAppLinks(output, settings.appOrigin);
  output = output.replace(/<head>/i, `<head><base href="/"><meta name="pdl-app-origin" content="${settings.appOrigin}">`);
  return output;
}

function publicMarketingApi(method, pathname) {
  if (method === 'GET' && ['/api/config', '/api/auth/me', '/api/public/stats', '/api/blog', '/api/help'].includes(pathname)) return true;
  if (method === 'GET' && /^\/api\/blog\/[^/]+$/.test(pathname)) return true;
  return method === 'POST' && pathname === '/api/demo-requests';
}

module.exports = {
  DEFAULT_MARKETING_ORIGIN, DEFAULT_APP_ORIGIN, MARKETING_ROUTES, config, requestHost,
  marketingRoute, marketingAsset, hostAction, sitemapXml, robotsText, marketingHtml, publicMarketingApi
};
