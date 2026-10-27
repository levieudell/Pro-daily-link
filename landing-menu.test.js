'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const root = __dirname;
execFileSync(process.execPath, ['--check', path.join(root, 'public-header.js')], { stdio: 'inherit' });

const landingNav = ['How it works', 'Features', 'About', 'Field Notes', 'Pricing', 'Compare', 'FAQ'];
const pages = ['landing.html', 'about.html', 'blog.html', 'vs/raken.html'];
const overflowWidths = [360, 390, 768, 1024, 1280, 1440, 1920];

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

function visibleNav(page) {
  return page.evaluate(() => {
    const header = document.querySelector('.site-header');
    const button = header.querySelector('.header-menu');
    const nav = header.querySelector(':scope > nav');
    const shown = el => {
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 1 && rect.height > 1;
    };
    return {
      open: header.classList.contains('menu-open'),
      expanded: button.getAttribute('aria-expanded'),
      controls: button.getAttribute('aria-controls'),
      navId: nav.id,
      button: button.getBoundingClientRect().width,
      buttonHeight: button.getBoundingClientRect().height,
      buttonDisplay: getComputedStyle(button).display,
      labels: [...nav.querySelectorAll('a')].filter(shown).map(el => el.textContent.trim()),
      demoInNav: Boolean(nav.querySelector('.header-demo')),
      demoInBar: Boolean(header.querySelector('.header-actions .header-demo')),
      navPosition: getComputedStyle(nav).position,
      scroll: document.documentElement.scrollWidth,
      client: document.documentElement.clientWidth
    };
  });
}

(async () => {
  const executablePath = chromePath();
  assert.ok(executablePath, 'Chrome is required');
  const puppeteer = require('puppeteer-core');
  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await puppeteer.launch({ executablePath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
  const measurements = [];
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    await page.goto(`${base}/login.html`, { waitUntil: 'networkidle0' });
    assert.equal(await page.$('.site-header'), null, 'login does not share the public header');
    await page.goto(`${base}/signup.html`, { waitUntil: 'networkidle0' });
    assert.equal(await page.$('.site-header'), null, 'signup does not share the public header');

    for (const file of pages) {
      await page.setViewport({ width: 390, height: 900 });
      await page.goto(`${base}/${file}`, { waitUntil: 'networkidle0' });
      await page.evaluate(() => document.fonts.ready);
      const before = await visibleNav(page);
      assert.equal(before.open, false, `${file} menu starts closed`);
      assert.equal(before.expanded, 'false', `${file} menu button is collapsed`);
      assert.equal(before.controls, before.navId, `${file} menu controls the page nav`);
      assert.ok(before.button >= 44 && before.buttonHeight >= 44, `${file} menu tap target is ${before.button}x${before.buttonHeight}`);
      assert.equal(before.labels.length, 0, `${file} nav links are hidden until the menu opens`);
      await page.click('.header-menu');
      const opened = await visibleNav(page);
      assert.equal(opened.open, true, `${file} menu opens`);
      assert.equal(opened.expanded, 'true');
      assert.equal(opened.navPosition, 'absolute', `${file} menu drops under the header`);
      const expected = file === 'landing.html' ? landingNav : await page.evaluate(() => [...document.querySelectorAll('.site-header > nav > a:not(.header-demo)')].map(el => el.textContent.trim()));
      for (const label of expected) assert.ok(opened.labels.includes(label), `${file} menu is missing ${label}`);
      if (file === 'landing.html') {
        assert.deepEqual(opened.labels.filter(label => label !== 'Request a demo'), landingNav);
        assert.equal(opened.demoInNav, true, 'Request a demo moves into the menu at 390');
        assert.equal(opened.demoInBar, false);
        assert.ok(opened.labels.includes('Request a demo'));
      }
      assert.equal(opened.scroll, opened.client, `${file} open menu scroll ${opened.scroll} vs ${opened.client}`);
      await page.keyboard.press('Escape');
      const escaped = await visibleNav(page);
      assert.equal(escaped.open, false, `${file} Escape closes the menu`);
      assert.equal(escaped.expanded, 'false');
      await page.click('.header-menu');
      await page.evaluate(() => {
        document.querySelector('main').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      });
      const outside = await visibleNav(page);
      assert.equal(outside.open, false, `${file} an outside tap closes the menu`);
      await page.click('.header-menu');
      await page.evaluate(() => {
        const link = document.querySelector('.site-header nav a');
        link.addEventListener('click', event => event.preventDefault(), { capture: true });
        link.click();
      });
      const linked = await visibleNav(page);
      assert.equal(linked.open, false, `${file} a nav link closes the menu`);
    }

    await page.setViewport({ width: 1440, height: 900 });
    await page.goto(`${base}/landing.html`, { waitUntil: 'networkidle0' });
    await page.evaluate(() => document.fonts.ready);
    const desktop = await visibleNav(page);
    assert.equal(desktop.buttonDisplay, 'none', 'the menu button stays hidden when the nav fits');
    assert.ok(desktop.labels.includes('How it works') && desktop.labels.includes('FAQ'), 'desktop nav stays in the header');
    assert.notEqual(desktop.navPosition, 'absolute');
    await page.evaluate(() => document.querySelector('.site-header').classList.add('menu-open'));
    const forced = await page.$eval('.site-header > nav', el => getComputedStyle(el).position);
    assert.notEqual(forced, 'absolute', 'opening the menu does not restyle the desktop nav');

    for (const file of ['landing.html', 'about.html', 'blog.html', 'vs/raken.html', 'vs/procore.html', 'vs/paper-daily-logs.html']) {
      await page.goto(`${base}/${file}`, { waitUntil: 'networkidle0' });
      await page.evaluate(() => document.fonts.ready);
      for (const width of overflowWidths) {
        await page.setViewport({ width, height: 900 });
        await page.evaluate(() => window.fitSiteHeader());
        const box = await page.evaluate(() => {
          const header = document.querySelector('.site-header');
          const button = header.querySelector('.header-menu');
          const shown = el => getComputedStyle(el).display !== 'none' && el.getClientRects().length;
          const links = [...header.querySelectorAll(':scope > nav > a')].filter(el => !el.classList.contains('header-demo'));
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
          const bar = [...header.querySelectorAll('.header-actions a, .header-actions button, .logo')].filter(shown).map(el => ({
            text: (el.textContent.trim().replace(/\s+/g, ' ') || el.getAttribute('aria-label') || '').slice(0, 40),
            lines: lines(el)
          }));
          return {
            scroll: document.documentElement.scrollWidth,
            client: document.documentElement.clientWidth,
            buttonDisplay: getComputedStyle(button).display,
            visibleLinks: links.filter(shown).length,
            linkCount: links.length,
            bar
          };
        });
        measurements.push({ file, width, scroll: box.scroll, client: box.client, button: box.buttonDisplay, links: `${box.visibleLinks}/${box.linkCount}` });
        assert.equal(box.scroll, box.client, `${file} @ ${width} scrollWidth ${box.scroll} vs ${box.client}`);
        if (width < 1280) assert.notEqual(box.buttonDisplay, 'none', `${file} @ ${width} menu button is hidden`);
        else {
          assert.equal(box.buttonDisplay, 'none', `${file} @ ${width} menu button covers the inline nav`);
          assert.equal(box.visibleLinks, box.linkCount, `${file} @ ${width} hides nav links`);
        }
        for (const item of box.bar) assert.ok(item.lines <= 1, `${file} @ ${width} "${item.text}" wraps (${item.lines} lines)`);
      }
    }

    await page.goto(`${base}/landing.html`, { waitUntil: 'networkidle0' });
    await page.evaluate(() => document.fonts.ready);
    for (let width = 320; width <= 1600; width += 10) {
      await page.setViewport({ width, height: 900 });
      await page.evaluate(() => window.fitSiteHeader());
      const box = await page.evaluate(() => {
        const shot = document.querySelector('.product-shot');
        const rect = shot.getBoundingClientRect();
        return {
          scroll: document.documentElement.scrollWidth,
          client: document.documentElement.clientWidth,
          shotRight: Math.round(rect.right),
          shotWidth: Math.round(rect.width),
          transform: getComputedStyle(shot).transform
        };
      });
      assert.equal(box.scroll, box.client, `landing @ ${width} scrollWidth ${box.scroll} vs ${box.client}`);
      assert.ok(box.shotWidth > 120, `landing @ ${width} product shot collapsed to ${box.shotWidth}`);
    }
    await page.setViewport({ width: 1024, height: 900 });
    await page.evaluate(() => window.fitSiteHeader());
    const hero = await page.evaluate(() => {
      const shot = document.querySelector('.product-shot');
      const rect = shot.getBoundingClientRect();
      return {
        scroll: document.documentElement.scrollWidth,
        client: document.documentElement.clientWidth,
        shotRight: Math.round(rect.right),
        shotWidth: Math.round(rect.width),
        transform: getComputedStyle(shot).transform
      };
    });
    assert.equal(hero.scroll, hero.client, `1024 scrollWidth ${hero.scroll}`);
    assert.ok(hero.transform !== 'none', 'the product shot keeps its tilt at 1024');
    assert.ok(hero.shotWidth > 400, `product shot is ${hero.shotWidth}px at 1024`);
    console.log(JSON.stringify({ widths: measurements, hero }, null, 2));
  } finally {
    await browser.close();
    server.close();
  }
  console.log('Landing menu and overflow checks passed.');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
