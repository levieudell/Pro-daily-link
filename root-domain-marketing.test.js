'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-root-domain-'));
process.env.PDL_DB_FILE = path.join(temporary, 'db.json');
process.env.PDL_PLATFORM_FILE = path.join(temporary, 'platform.json');
process.env.PDL_SUPABASE_ENABLED = '0';
process.env.NODE_ENV = 'test';
process.env.MARKETING_ORIGIN = 'https://prodailylink.com';
process.env.APP_ORIGIN = 'https://app.prodailylink.com';
process.env.ROOT_DOMAIN_LIVE = 'true';
fs.copyFileSync(path.join(__dirname, 'data', 'db.json'), process.env.PDL_DB_FILE);
fs.copyFileSync(path.join(__dirname, 'data', 'platform.json'), process.env.PDL_PLATFORM_FILE);

const routes = require('./marketing-routes');
const { server } = require('./server');

function request(port, pathname, { host = 'prodailylink.com', method = 'GET', proto = 'https' } = {}) {
  return new Promise((resolve, reject) => {
    const call = http.request({ port, host: '127.0.0.1', path: pathname, method, headers: { Host: host, 'X-Forwarded-Proto': proto } }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body }));
    });
    call.on('error', reject);
    call.end();
  });
}

server.listen(0, async () => {
  const port = server.address().port;
  try {
    const httpApex = await request(port, '/?campaign=one', { proto: 'http' });
    assert.equal(httpApex.status, 301);
    assert.equal(httpApex.headers.location, 'https://prodailylink.com/?campaign=one');

    const www = await request(port, '/vs/procore.html?x=1', { host: 'www.prodailylink.com' });
    assert.equal(www.status, 301);
    assert.equal(www.headers.location, 'https://prodailylink.com/vs/procore.html?x=1');

    for (const pathname of ['/', '/about', '/terms', '/privacy', '/vs/procore.html', '/blog/sample-post']) {
      const response = await request(port, pathname);
      assert.equal(response.status, 200, `${pathname} is served on the marketing host`);
      assert.match(response.body, new RegExp(`<link rel="canonical" href="https://prodailylink\\.com${pathname === '/' ? '/' : pathname}"`));
    }

    const landing = await request(port, '/');
    assert.match(landing.body, /<meta property="og:url" content="https:\/\/prodailylink\.com\/">/);
    assert.match(landing.body, /href="https:\/\/app\.prodailylink\.com\/signup\.html/);

    const apexLogin = await request(port, '/login?next=%2Fapp');
    assert.equal(apexLogin.status, 301);
    assert.equal(apexLogin.headers.location, 'https://app.prodailylink.com/login?next=%2Fapp');
    const apiPost = await request(port, '/api/demo-requests?source=test', { method: 'POST' });
    assert.equal(apiPost.status, 308);
    assert.equal(apiPost.headers.location, 'https://app.prodailylink.com/api/demo-requests?source=test');

    const appMarketing = await request(port, '/vs/procore.html?x=1', { host: 'app.prodailylink.com' });
    assert.equal(appMarketing.status, 301);
    assert.equal(appMarketing.headers.location, 'https://prodailylink.com/vs/procore.html?x=1');
    assert.equal((await request(port, '/', { host: 'app.prodailylink.com' })).status, 200);
    assert.equal((await request(port, '/login', { host: 'app.prodailylink.com' })).status, 200);
    assert.equal((await request(port, '/signup', { host: 'app.prodailylink.com' })).status, 200);
    assert.equal((await request(port, '/api/health/live', { host: 'app.prodailylink.com' })).status, 200);

    const appRobots = await request(port, '/robots.txt', { host: 'app.prodailylink.com' });
    assert.equal(appRobots.body, 'User-agent: *\nDisallow: /\n');
    const appSitemap = await request(port, '/sitemap.xml', { host: 'app.prodailylink.com' });
    assert.equal(appSitemap.status, 301);
    assert.equal(appSitemap.headers.location, 'https://prodailylink.com/sitemap.xml');
    const robots = await request(port, '/robots.txt');
    assert.match(robots.body, /Sitemap: https:\/\/prodailylink\.com\/sitemap\.xml/);
    const sitemap = await request(port, '/sitemap.xml');
    assert.equal((sitemap.body.match(/app\.prodailylink\.com/g) || []).length, 0);
    for (const route of routes.MARKETING_ROUTES) assert.match(sitemap.body, new RegExp(`https://prodailylink\\.com${route.path === '/' ? '/' : route.path.replaceAll('/', '\\/')}`));

    process.env.ROOT_DOMAIN_LIVE = 'false';
    const flagOff = await request(port, '/vs/procore.html?x=1', { host: 'app.prodailylink.com' });
    assert.equal(flagOff.status, 200, 'the app host keeps current behavior while the flag is off');
    const unknown = await request(port, '/', { host: 'preview.onrender.com' });
    assert.equal(unknown.status, 200, 'unknown hosts keep current behavior');
    assert.equal(routes.hostAction({ headers: { host: 'localhost:3000' }, method: 'GET', url: new URL('http://localhost/about'), env: process.env }), null);

    console.log('Root-domain marketing routing, SEO, sitemap, robots, flag, and compatibility tests passed');
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    server.close();
  }
});
