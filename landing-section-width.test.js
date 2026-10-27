'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const root = __dirname;
const widths = [320, 390, 768, 1024, 1280, 1440, 1920, 2560, 3840];
const css = fs.readFileSync(path.join(root, 'public-content.css'), 'utf8');
assert.doesNotMatch(css, /\.landing-founder,\.landing-journal\{[^}]*max-width/);
assert.match(fs.readFileSync(path.join(root, 'landing.html'), 'utf8'), /public-content\.css\?v=20261027-public3/);

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
      if (url.pathname === '/api/blog') {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify([{ category: 'FIELD', slug: 'width', title: 'Wide enough', excerpt: 'The journal column stays readable on a wide screen.' }]));
        return;
      }
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

const measure = `(() => {
  const sections = [...document.querySelectorAll('.section')].filter(el => {
    if (el.hidden || el.closest('[hidden]')) return false;
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' && el.getClientRects().length > 0;
  }).map(el => {
    const style = getComputedStyle(el);
    const content = el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    return { cls: el.className, content };
  });
  const copy = document.querySelector('.founder-copy');
  const h2 = copy.querySelector('h2').getBoundingClientRect().width;
  const paragraphs = [...copy.querySelectorAll('p')].map(el => el.getBoundingClientRect().width);
  const founder = sections.find(section => section.cls.includes('landing-founder'));
  return {
    scroll: document.documentElement.scrollWidth,
    sections,
    h2,
    paragraphs,
    founder: founder ? founder.content : null,
    journal: sections.some(section => section.cls.includes('landing-journal'))
  };
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
    for (const width of widths) {
      await page.setViewport({ width, height: 900 });
      await page.goto(`${base}/`, { waitUntil: 'networkidle0' });
      await page.evaluate(() => document.fonts.ready);
      const result = await page.evaluate(measure);
      const minimum = Math.min(width - 48, 300);
      const textMinimum = width === 320 ? 270 : 300;
      assert.ok(result.sections.length > 0, `${width} rendered no sections`);
      assert.equal(result.journal, true, `${width} journal section was not measured`);
      for (const section of result.sections) {
        assert.ok(section.content >= minimum, `${width} ${section.cls} content ${section.content}px, need >= ${minimum}`);
      }
      assert.ok(result.h2 >= textMinimum, `${width} founder h2 ${result.h2}px, need >= ${textMinimum}`);
      if (width === 1920 || width === 2560) assert.ok(Math.abs(result.h2 - 760) <= 1, `${width} founder h2 ${result.h2}px, expected 760`);
      assert.ok(result.paragraphs.length >= 2, `${width} founder copy is missing paragraphs`);
      for (const paragraph of result.paragraphs) {
        assert.ok(paragraph >= textMinimum, `${width} founder paragraph ${paragraph}px, need >= ${textMinimum}`);
      }
      assert.equal(result.scroll, width, `${width} document scroll width ${result.scroll}`);
      console.log(`${width} founder h2 ${Math.round(result.h2)} section ${Math.round(result.founder)} scroll ${result.scroll}`);
    }
  } finally {
    await browser.close();
    server.close();
  }
  console.log('Landing section width checks passed.');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
