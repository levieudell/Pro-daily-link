'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const root = __dirname;
const V = '20261027-public3';
const pages = [
  'landing.html',
  'about.html',
  'blog.html',
  'login.html',
  'signup.html',
  'vs/raken.html',
  'vs/procore.html',
  'vs/paper-daily-logs.html'
];
const headerPages = pages.filter(file => !['login.html', 'signup.html'].includes(file));

for (const file of pages) {
  const html = fs.readFileSync(path.join(root, file), 'utf8');
  const tags = html.match(/<(?:link|script)\b[^>]*>/g) || [];
  for (const tag of tags) {
    const sheet = /rel="stylesheet"/.test(tag);
    const script = /^<script\b/.test(tag) && /\bsrc=/.test(tag);
    if (!sheet && !script) continue;
    assert.match(tag, new RegExp(`\\?v=${V}["']`), `${file} pins ${tag}`);
  }
  if (headerPages.includes(file)) {
    assert.match(html, new RegExp(`href="(?:\\.\\./)?landing\\.css\\?v=${V}"`), `${file} pins the header stylesheet`);
    assert.match(html, new RegExp(`src="/public-header\\.js\\?v=${V}" defer`), `${file} loads the header fitter from head`);
  }
}
assert.match(fs.readFileSync(path.join(root, 'landing.html'), 'utf8'), new RegExp(`href="landing-demo\\.css\\?v=${V}"`));

const landing = fs.readFileSync(path.join(root, 'landing.html'), 'utf8');
assert.ok(landing.indexOf('landing-demo.js') < landing.indexOf('public-header.js'), 'demo button is inserted before the header is measured');
assert.match(landing, /<section class="section landing-founder" style="display:block;width:100%;min-width:0">/);
assert.match(landing, /<div class="founder-copy" style="display:block;width:100%;min-width:0;max-width:760px;grid-column:1\/-1">/);
const css = fs.readFileSync(path.join(root, 'public-content.css'), 'utf8');
assert.match(css, /\.landing-founder\{display:block;width:100%;min-width:0\}/);
assert.match(css, /\.landing-founder \.founder-copy\{display:block;width:100%;min-width:0;max-width:760px;grid-column:1\/-1/);
assert.match(fs.readFileSync(path.join(root, 'landing.css'), 'utf8'), /\.site-header \.header-actions \.button\{white-space:nowrap/);
assert.equal(require('./public-file-policy').isPublicFile(root, path.join(root, 'public-header.js')), true);

function chromePath() {
  const candidates = [
    process.env.PDL_TEST_CHROME,
    '/usr/bin/google-chrome-stable',
    '/usr/local/bin/google-chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium'
  ].filter(Boolean);
  return candidates.find(file => fs.existsSync(file));
}

function startServer() {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      let file = decodeURIComponent(url.pathname);
      if (file === '/') file = '/landing.html';
      const full = path.join(root, file);
      if (!full.startsWith(root) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
        res.writeHead(404); res.end('missing'); return;
      }
      const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
      res.writeHead(200, { 'content-type': types[path.extname(full)] || 'application/octet-stream', 'cache-control': 'no-store' });
      fs.createReadStream(full).pipe(res);
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

const inspect = `(() => {
  const header = document.querySelector('.site-header');
  const lines = el => {
    const tops = new Set();
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (!node.textContent.trim()) continue;
      let parent = node.parentElement;
      let hidden = false;
      while (parent) {
        if (getComputedStyle(parent).display === 'none') { hidden = true; break; }
        if (parent === el) break;
        parent = parent.parentElement;
      }
      if (hidden) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const rect of range.getClientRects()) if (rect.width > 0.5 && rect.height > 0.5) tops.add(Math.round(rect.top));
    }
    return tops.size;
  };
  const view = document.documentElement.clientWidth;
  const items = header ? [...header.querySelectorAll('a,button')].filter(el => getComputedStyle(el).display !== 'none' && el.getClientRects().length).map(el => {
    const rect = el.getBoundingClientRect();
    return { text: el.textContent.trim().replace(/\\s+/g, ' ').slice(0, 40), lines: lines(el), left: Math.round(rect.left), right: Math.round(rect.right), top: Math.round(rect.top), bottom: Math.round(rect.bottom) };
  }) : [];
  const section = document.querySelector('.landing-founder');
  const copy = document.querySelector('.founder-copy');
  let founder = null;
  if (section && copy) {
    const style = getComputedStyle(section);
    const inner = section.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    const h2 = copy.querySelector('h2');
    const paragraph = copy.querySelector('p');
    founder = {
      copy: Math.round(copy.getBoundingClientRect().width),
      inner: Math.round(inner),
      cap: Math.round(Math.min(inner, 760)),
      h2: lines(h2),
      words: paragraph.textContent.trim().split(/\\s+/).length,
      p: lines(paragraph)
    };
  }
  return { items, founder, collapsed: header?.classList.contains('nav-collapsed') || false, scroll: header ? header.scrollWidth - header.clientWidth : 0, view };
})()`;

(async () => {
  const executablePath = chromePath();
  assert.ok(executablePath, 'Chrome is required');
  const puppeteer = require('puppeteer-core');
  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await puppeteer.launch({ executablePath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
  try {
    const page = await browser.newPage();
    const widths = [390, 768, 1024, 1100, 1280, 1440];
    for (const file of headerPages) {
      for (const width of widths) {
        await page.setViewport({ width, height: 900 });
        await page.goto(`${base}/${file}`, { waitUntil: 'networkidle0' });
        await page.evaluate(() => document.fonts.ready);
        await page.evaluate(() => window.fitSiteHeader && window.fitSiteHeader());
        const result = await page.evaluate(inspect);
        for (const item of result.items) {
          assert.ok(item.lines <= 1, `${file} @ ${width} "${item.text}" wraps (${item.lines} lines)`);
          assert.ok(item.left >= -1 && item.right <= result.view + 1, `${file} @ ${width} "${item.text}" escapes the viewport`);
        }
        for (let i = 0; i < result.items.length; i++) {
          for (let j = i + 1; j < result.items.length; j++) {
            const a = result.items[i], b = result.items[j];
            const hit = a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
            assert.equal(hit, false, `${file} @ ${width} "${a.text}" overlaps "${b.text}"`);
          }
        }
        assert.ok(result.scroll <= 1, `${file} @ ${width} header overflows by ${result.scroll}px`);
        if (file === 'landing.html') {
          assert.ok(result.founder, 'founder block is on the landing page');
          assert.ok(Math.abs(result.founder.copy - result.founder.cap) <= 1, `${width} founder-copy ${result.founder.copy}px, expected ${result.founder.cap}`);
          assert.ok(result.founder.copy <= 760, `${width} founder-copy exceeds 760`);
          assert.ok(result.founder.p < result.founder.words / 3, `${width} founder copy collapsed (${result.founder.p} lines / ${result.founder.words} words)`);
        }
      }
    }
    await page.setViewport({ width: 1280, height: 900 });
    await page.goto(`${base}/landing.html`, { waitUntil: 'networkidle0' });
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(() => {
      const style = document.createElement('style');
      style.textContent = '.landing-founder{display:grid;grid-template-columns:1fr 1fr;gap:60px;align-items:center;width:min-content}.landing-founder .founder-copy{width:min-content;max-width:none}';
      document.body.appendChild(style);
    });
    const inlineBeats = await page.evaluate(inspect);
    assert.ok(Math.abs(inlineBeats.founder.copy - inlineBeats.founder.cap) <= 1, `inline width lost to a stale min-content rule (${inlineBeats.founder.copy}px, expected ${inlineBeats.founder.cap})`);
    await page.goto(`${base}/landing.html`, { waitUntil: 'networkidle0' });
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(() => {
      document.querySelector('.landing-founder').removeAttribute('style');
      document.querySelector('.founder-copy').removeAttribute('style');
      const style = document.createElement('style');
      style.textContent = '.landing-founder{display:grid;grid-template-columns:1fr 1fr;gap:60px;align-items:center}';
      document.body.appendChild(style);
    });
    const stale = await page.evaluate(inspect);
    assert.ok(Math.abs(stale.founder.copy - stale.founder.cap) <= 1, `stale 1fr 1fr grid collapsed the copy to ${stale.founder.copy}px, expected ${stale.founder.cap}`);
    assert.ok(stale.founder.h2 <= 2, `stale grid wrapped the heading onto ${stale.founder.h2} lines`);
  } finally {
    await browser.close();
    server.close();
  }
  console.log('Landing header and founder measure checks passed.');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
