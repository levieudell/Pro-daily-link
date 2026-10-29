'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { chromium } = require('playwright-core');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function settlePaint(page) {
  await page.evaluate(async () => {
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await document.fonts.ready;
    await Promise.all(document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity)
      .map(animation => animation.finished.catch(() => {})));
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
}

async function round4Shot(page, shots, scene, theme, height) {
  if (!shots) return;
  fs.mkdirSync(shots, { recursive: true });
  await settlePaint(page);
  await page.screenshot({ path: path.join(shots, `round4-${scene}-${theme}-390-${height}.png`) });
}

async function assertMyDayStart(page, theme, height, shots) {
  await page.setViewportSize({ width: 390, height });
  await page.evaluate(() => window.scrollTo(0, 0));
  await settlePaint(page);
  const start = await page.locator('#field-start-card [data-start-day]').evaluate(el => {
    const r = el.getBoundingClientRect(), header = document.querySelector('.topbar').getBoundingClientRect();
    const hit = [r.top + 2, r.top + r.height / 2, r.bottom - 2].every(y => {
      const target = document.elementFromPoint(r.left + r.width / 2, y);
      return target === el || el.contains(target);
    });
    return { top: r.top, bottom: r.bottom, height: r.height, header: header.bottom, viewport: innerHeight, hit,
      scroll: scrollY, overflow: document.documentElement.scrollWidth - innerWidth };
  });
  assert(start.top >= start.header && start.bottom <= height && start.height >= 44 && start.hit && start.scroll === 0 && start.overflow <= 1,
    `${theme} ${height} Clock in is fully visible without scrolling ` + JSON.stringify(start));
  await assertPalette(page, '#myday-page');
  await assertPalette(page, '.topbar');
  await assertContrast(page, '#myday-page', `${theme} ${height} My Day`);
  const chips = await page.locator('#myday-page .field-assignment .status.warning').evaluateAll(els => els.filter(el => el.checkVisibility()).map(el => {
    const s = getComputedStyle(el);
    return { text: el.textContent, background: s.backgroundColor, color: s.color, border: s.borderTopColor, width: parseFloat(s.borderTopWidth), style: s.borderTopStyle };
  }));
  assert(chips.length && chips.some(chip => chip.text === 'New assignment'), 'My Day fixture includes the New assignment chip');
  for (const chip of chips) {
    assert.equal(chip.background, 'rgba(0, 0, 0, 0)');
    assert.equal(chip.border, 'rgb(255, 102, 0)');
    assert.equal(chip.color, theme === 'dark' ? 'rgb(255, 255, 255)' : 'rgb(0, 0, 0)');
    assert(chip.width >= 1 && chip.width <= 2 && chip.style === 'solid');
  }
  if (theme === 'dark') await assertWhiteSecondary(page, '#myday-page');
  await round4Shot(page, shots, 'myday', theme, height);
  // At 500px the above-fold Clock in and the lower assignment card need
  // separate screenshots; do not change the layout to fit both into one shot.
  if (shots) {
    await page.locator('#myday-page .field-assignment-card').first().evaluate(el => {
      el.closest('.panel').scrollIntoView({ block: 'start' });
      window.scrollBy(0, -document.querySelector('.topbar').getBoundingClientRect().bottom - 12);
    });
    await settlePaint(page);
    await page.screenshot({ path: path.join(shots, `myday-assignment-${theme}-390x${height}.png`) });
  }
}

async function assertFocusedNotes(page, theme, height, shots) {
  await page.setViewportSize({ width: 390, height });
  const notes = page.locator('#field-notes');
  await notes.fill('Set forms along the east footing.\nChecked elevations with the crew.\nPlaced concrete at the south wall.\nStripped forms from yesterday.\nCleaned the work area.\nReady for the next pour.');
  await notes.evaluate(el => { el.setSelectionRange(el.value.length, el.value.length); el.blur(); });
  await page.locator('.report-step.active .report-step-scroll').evaluate(el => el.scrollTop = el.scrollHeight);
  await notes.focus(); // Native focus from the bottom; no test-side scrollIntoView.
  await settlePaint(page);
  await assertPalette(page, '#report-modal');
  if (theme === 'dark') await assertWhiteSecondary(page, '#report-modal');
  const rect = await notes.evaluate(el => {
    const r = el.getBoundingClientRect(), header = document.querySelector('#report-modal .modal-header').getBoundingClientRect();
    const body = el.closest('.report-step-scroll').getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + 3);
    const footer = el.closest('.report-step').querySelector('.modal-actions').getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, header: header.bottom, bodyBottom: body.bottom, footer: footer.top,
      hit: hit === el || el.contains(hit), active: document.activeElement === el, cursorAtEnd: el.selectionStart === el.value.length && el.selectionEnd === el.value.length };
  });
  if (shots && height === 500) await page.screenshot({ path: path.join(shots, `notes-focus-${theme}-390x500.png`) });
  assert(rect.active && rect.cursorAtEnd && rect.top >= rect.header + 8 && rect.bottom <= Math.min(rect.bodyBottom, rect.footer - 8) && rect.hit,
    `${theme} ${height} focused notes clear the header and footer ` + JSON.stringify(rect));
  if (height === 500) {
    // Keep focus and the end caret while the keyboard-sized viewport changes.
    // There is deliberately no second focus call to trigger the focus handler.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('.report-step.active .report-step-scroll').evaluate(el => el.scrollTop = el.scrollHeight);
    await page.setViewportSize({ width: 390, height: 500 });
    // Model the final caret-driven scroll in the keyboard resize sequence,
    // then deliver its viewport event without blurring or refocusing the field.
    await page.locator('.report-step.active .report-step-scroll').evaluate(el => el.scrollTop = el.scrollHeight);
    await page.evaluate(() => window.visualViewport.dispatchEvent(new Event('resize')));
    await page.waitForFunction(() => {
      const el = document.querySelector('#field-notes'), r = el.getBoundingClientRect();
      const header = document.querySelector('#report-modal .modal-header').getBoundingClientRect();
      const footer = el.closest('.report-step').querySelector('.modal-actions').getBoundingClientRect();
      return document.activeElement === el && el.selectionStart === el.value.length && el.selectionEnd === el.value.length &&
        r.top >= header.bottom + 8 && r.bottom <= footer.top - 8;
    }, null, { timeout: 3000 });
    await settlePaint(page);
    if (shots) await page.screenshot({ path: path.join(shots, `notes-focus-${theme}-390x500.png`) });
  }
  await round4Shot(page, shots, 'focused-notes', theme, height);
}

async function assertBlockedSend(page, theme, height, shots) {
  await page.setViewportSize({ width: 390, height });
  await page.locator('#save-report').click();
  await page.waitForFunction(() => /Enter a quantity for each work line\./.test(document.querySelector('#report-submit-status')?.textContent || ''));
  assert.equal(await page.locator('#report-sent-modal[open]').count(), 0, 'quantity gate still blocks send');
  const empty = await page.locator('.report-step.active .report-step-scroll').evaluate(root => [...root.querySelectorAll('div,p,section')].filter(el => {
    const s = getComputedStyle(el), r = el.getBoundingClientRect();
    return el.checkVisibility() && r.width > 0 && r.height > 0 && !el.textContent.trim() &&
      !el.querySelector('input,textarea,select,button,img,svg') && parseFloat(s.borderTopWidth) > 0;
  }).map(el => ({ id: el.id, className: el.className })));
  assert.deepEqual(empty, [], `${theme} ${height} blocked send has no empty bordered containers`);
  await page.locator('#report-submit-status').evaluate(el => el.scrollIntoView({ block: 'end' }));
  await round4Shot(page, shots, 'blocked-send', theme, height);
  await page.locator('#field-edit-hours').evaluate(el => el.scrollIntoView({ block: 'center' }));
  const row = await page.locator('#field-edit-hours,#field-add-line').evaluateAll(buttons => buttons.map(el => {
    const s = getComputedStyle(el), r = el.getBoundingClientRect(), hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { font: s.fontSize, family: s.fontFamily, weight: s.fontWeight, height: r.height,
      borders: ['Top','Right','Bottom','Left'].map(edge => [s['border' + edge + 'Width'], s['border' + edge + 'Style'], s['border' + edge + 'Color']]),
      outline: s.outlineStyle, shadow: s.boxShadow, hit: hit === el || el.contains(hit) };
  }));
  assert.equal(row.length, 2);
  assert.deepEqual(row[0], row[1], 'Edit reported hours matches Add line');
  assert(row[0].font === '16px' && row[0].family.includes('Inter') && row[0].weight === '700' && row[0].height === 48 && row[0].hit, JSON.stringify(row));
  assert.deepEqual(row[0].borders, Array(4).fill(['2px', 'solid', 'rgb(110, 110, 110)']));
  assert.equal(row[0].outline, 'none');
  assert.equal(row[0].shadow, 'none');
  await round4Shot(page, shots, 'hours-actions', theme, height);
  // Tab into each control without activating its editing behavior.
  await page.locator('#field-edit-hours').evaluate(el => el.focus());
  await page.keyboard.press('Tab');
  for (const id of ['field-add-line', 'field-edit-hours']) {
    if (id === 'field-edit-hours') await page.keyboard.press('Shift+Tab');
    const focus = await page.locator('#' + id).evaluate(el => {
      const s = getComputedStyle(el);
      return { active: document.activeElement === el, visible: el.matches(':focus-visible'), width: s.outlineWidth, style: s.outlineStyle, color: s.outlineColor };
    });
    assert.deepEqual(focus, { active: true, visible: true, width: '2px', style: 'solid', color: 'rgb(255, 102, 0)' });
  }
  await page.locator('#field-edit-hours').evaluate(el => el.blur());
}

// Inspect text nodes, not a hand-picked list of labels. Include rendered content
// below the scroll fold, plus native input values, selected options and placeholders.
async function assertContrast(page, selector, label) {
  await settlePaint(page);
  const samples = await page.locator(selector).evaluate(root => {
    const context = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
    const rgba = color => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
      const value = [...context.getImageData(0, 0, 1, 1).data];
      value[3] /= 255;
      return value;
    };
    const over = (front, back) => [...front.slice(0, 3).map((v, i) => v * front[3] + back[i] * (1 - front[3])), 1];
    const luminance = color => color.slice(0, 3).map(v => {
      v /= 255;
      return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4;
    }).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
    const visible = el => el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) && el.getClientRects().length;
    const result = [];
    function sample(el, text, pseudo) {
      if (!text.trim() || !visible(el)) return;
      const style = getComputedStyle(el, pseudo);
      const chain = [];
      for (let node = el; node; node = node.parentElement) chain.unshift(node);
      let background = [255, 255, 255, 1];
      let opacity = Number(pseudo ? style.opacity : 1);
      const gradients = [];
      for (const node of chain) {
        const s = getComputedStyle(node);
        background = over(rgba(s.backgroundColor), background);
        opacity *= Number(s.opacity);
        if (s.backgroundImage.includes('gradient(')) gradients.push(node.id || node.className);
      }
      const color = rgba(style.color);
      color[3] *= opacity;
      const foreground = over(color, background);
      const a = luminance(foreground), b = luminance(background);
      const size = parseFloat(style.fontSize), weight = parseInt(style.fontWeight, 10);
      result.push({ element: el.id || el.className || el.tagName, text: text.trim().slice(0, 70),
        kind: pseudo || 'text', color: foreground, background, gradients,
        ratio: (Math.max(a, b) + .05) / (Math.min(a, b) + .05),
        minimum: size >= 24 || (size >= 18.6667 && weight >= 700) ? 3 : 4.5 });
    }
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (!node.textContent.trim() || !visible(node.parentElement)) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      if ([...range.getClientRects()].some(r => r.width > 0 && r.height > 0)) sample(node.parentElement, node.textContent);
    }
    for (const el of root.querySelectorAll('input,textarea,select')) {
      if (['hidden', 'file', 'checkbox', 'radio'].includes(el.type) || !visible(el)) continue;
      sample(el, el.tagName === 'SELECT' ? el.selectedOptions[0]?.textContent || '' : el.value);
      if (!el.value && el.placeholder) sample(el, el.placeholder, '::placeholder');
    }
    return result;
  });
  assert(samples.length > 0, label + ' inspected text');
  const failures = samples.filter(s => s.gradients.length || s.ratio < s.minimum);
  assert.deepEqual(failures, [], label + ' WCAG AA text contrast');
  return samples;
}

async function assertLayout(page, label) {
  const result = await page.locator('#report-modal').evaluate(modal => {
    const step = modal.querySelector('.report-step.active');
    const body = step.querySelector('.report-step-scroll');
    const footer = step.querySelector('.modal-actions');
    return { overflow: Math.max(document.documentElement.scrollWidth - innerWidth, modal.scrollWidth - modal.clientWidth),
      separate: body.getBoundingClientRect().bottom <= footer.getBoundingClientRect().top + 1,
      buttons: [...footer.querySelectorAll('button')].filter(el => el.checkVisibility()).map(el => {
        const r = el.getBoundingClientRect(), hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return { id: el.id, width: r.width, height: r.height,
          inside: r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight,
          tappable: hit === el || el.contains(hit) };
      }) };
  });
  assert(result.overflow <= 1 && result.separate, label + JSON.stringify(result));
  for (const button of result.buttons) assert(button.inside && button.tappable && button.height >= 48, label + JSON.stringify(button));
  assert.equal(result.buttons.find(b => b.id === 'report-back').width, result.buttons.find(b => b.id === 'save-report').width, 'Back matches Send width');
}

async function assertReviewHitTargets(page, theme, shots) {
  const scroll = page.locator('.report-step.active .report-step-scroll');
  const settleScroll = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const hit = locator => locator.evaluate(el => {
    const rect = el.getBoundingClientRect();
    const body = el.closest('.report-step-scroll').getBoundingClientRect();
    const header = document.querySelector('#report-modal .modal-header').getBoundingClientRect();
    const target = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    const uncovered = [rect.top + 3, rect.top + rect.height / 2, rect.bottom - 3].every(y => {
      const found = document.elementFromPoint(rect.left + rect.width / 2, y);
      return found === el || el.contains(found);
    });
    return { element: el.id || el.className, top: rect.top, bottom: rect.bottom,
      target: target?.id || target?.className || target?.tagName,
      direct: target === el || el.contains(target), uncovered,
      clear: rect.top >= Math.max(body.top, header.bottom + 8) && rect.bottom <= body.bottom && rect.left >= 0 && rect.right <= innerWidth };
  });
  await scroll.evaluate(el => el.scrollTop = el.scrollHeight);
  await settleScroll();
  const next = page.locator('#report-next');
  const bottom = await hit(next);
  assert(bottom.direct, theme + ' Next step center at scroll bottom ' + JSON.stringify(bottom));
  if (shots) await page.screenshot({ path: path.join(shots, `field-review-bottom-${theme}-390-500.png`) });

  const selectors = page.locator('.production-item');
  assert(await selectors.count() > 0, 'Work-line selectors are present');
  // Start from the bottom for every field. Native focus must reveal it without
  // Playwright's click auto-scrolling or a manual scrollIntoView hiding an overlap.
  for (const field of [next, ...await selectors.all()]) {
    await field.evaluate(el => el.blur());
    await scroll.evaluate(el => el.scrollTop = el.scrollHeight);
    await field.focus();
    await settleScroll();
    const result = await hit(field);
    assert(result.direct && result.uncovered && result.clear, theme + ' focused field is clear of header/strip/footer ' + JSON.stringify(result));
  }
  if (shots) await page.screenshot({ path: path.join(shots, `field-review-select-${theme}-390-500.png`) });
}

async function assertPalette(page, selector) {
  const colors = await page.locator(selector).evaluate(root => {
    const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
    const rgba = value => { ctx.clearRect(0,0,1,1); ctx.fillStyle = value; ctx.fillRect(0,0,1,1); return [...ctx.getImageData(0,0,1,1).data]; };
    return [root, ...root.querySelectorAll('*')].filter(el => el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })).flatMap(el => {
      const pseudos = [null, '::before', '::after', ...(el.matches('input[placeholder],textarea[placeholder]') ? ['::placeholder'] : [])];
      return pseudos.flatMap(pseudo => {
        const style = getComputedStyle(el, pseudo);
        if (pseudo && pseudo !== '::placeholder' && ['none','normal'].includes(style.content)) return [];
        return ['color','backgroundColor','borderTopColor','borderRightColor','borderBottomColor','borderLeftColor','outlineColor'].map(property =>
          ({ element: el.id || el.className || el.tagName, pseudo, property, value: style[property], rgba: rgba(style[property]) }));
      });
    });
  });
  // Normalize color-mix()/color(srgb) too: string-only RGB checks miss these tints.
  const forbidden = new Set(['219,219,219','61,61,61','255,234,219','36,14,0']);
  assert.deepEqual(colors.filter(c => c.rgba[3] && forbidden.has(c.rgba.slice(0,3).join(','))), [], selector + ' has no DBDBDB/3D3D3D/FFEADB/240E00');
  const palette = new Set(['0,0,0','255,255,255','247,245,240','110,110,110','255,102,0','255,46,138','0,102,255']);
  assert.deepEqual(colors.filter(c => c.rgba[3] && (c.rgba[3] !== 255 || !palette.has(c.rgba.slice(0,3).join(',')))), [], selector + ' only uses brand colors, without tints');
}

async function assertWhiteSecondary(page, selector) {
  const samples = await page.locator(selector).locator('small,dt,.input-help,.page-heading p,.field-assignment-date,.field-ai-disclosure,.field-clamp-note,.field-review-card em,.field-flag p,.field-hours-card p,.status').evaluateAll(els =>
    els.filter(el => el.checkVisibility() && el.textContent.trim()).map(el => ({ element: el.id || el.className || el.tagName, text: el.textContent.trim().slice(0,60), color: getComputedStyle(el).color })));
  assert(samples.length > 0, selector + ' has secondary text to inspect');
  assert.deepEqual(samples.filter(sample => sample.color !== 'rgb(255, 255, 255)'), [], selector + ' dark secondary text is white');
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-review-contrast-'));
  const shots = process.env.PDL_TEST_SCREENSHOTS;
  const port = await new Promise(resolve => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
  });
  const env = { ...process.env, PORT: String(port), PDL_STAGING: '1', PDL_STAGING_OWNER_PASSWORD: 'contrast-owner-pass',
    PDL_STAGING_FIELD_PASSWORD: 'contrast-field-pass', PDL_DB_FILE: path.join(root, 'db.json'), PDL_PLATFORM_FILE: path.join(root, 'platform.json'),
    PDL_SUPABASE_ENABLED: '0', PDL_TRANSACTIONAL_DB: 'off', PDL_EMAIL_DEV_MODE: '1', OPENAI_API_KEY: '' };
  for (const key of ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'RESEND_API_KEY', 'INDEXNOW_KEY', 'SENTRY_DSN']) delete env[key];
  const server = spawn(process.execPath, ['--require', require.resolve('./scripts/test-analytics-isolation.cjs'), 'server.js'],
    { cwd: __dirname, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '', browser;
  server.stdout.on('data', data => log += data);
  server.stderr.on('data', data => log += data);
  try {
    for (let i = 0; i < 200 && !log.includes('running at'); i++) await sleep(100);
    assert(log.includes('running at'), 'Disposable staging server started');
    browser = await chromium.launch({ executablePath: process.env.PDL_TEST_CHROME || process.env.CHROME_PATH ||
      (process.platform === 'win32' ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : '/usr/bin/google-chrome-stable'),
      headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme: 'dark' });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error' && /Content Security Policy/.test(message.text())) errors.push(message.text()); });
    await context.addInitScript(() => localStorage.setItem('pdl-analytics-consent', 'declined'));
    await page.goto(`http://127.0.0.1:${port}/login.html`);
    await page.locator('#email').fill('levi+field@prodailylink.com');
    await page.locator('#password').fill('contrast-field-pass');
    await page.locator('form#login button.primary').click();
    await page.waitForSelector('#myday-page.active [data-start-day]');
    await page.waitForFunction(() => document.documentElement.classList.contains('workspace-ready'));

    // Hold app initialization while taking a real first-paint sample. A MutationObserver
    // also records the theme at the instant the first stylesheet is parsed.
    await page.addInitScript(() => {
      window.__themeAtFirstStylesheet = null;
      const observer = new MutationObserver(() => {
        if (document.querySelector('link[rel="stylesheet"]')) {
          window.__themeAtFirstStylesheet = document.documentElement.dataset.theme;
          observer.disconnect();
        }
      });
      observer.observe(document, { subtree: true, childList: true });
    });
    for (const theme of ['dark', 'light', 'system']) {
      await page.evaluate(theme => localStorage.setItem('pdl-theme', theme), theme);
      let release;
      const gate = new Promise(resolve => release = resolve);
      const hold = async route => { await gate; await route.continue(); };
      await page.route('**/api/config', hold);
      await page.reload({ waitUntil: 'domcontentloaded' });
      try {
        await page.locator('.workspace-loader').waitFor({ state: 'visible' });
        const expected = theme === 'light' ? 'light' : 'dark';
        const paint = await page.evaluate(() => ({ theme: document.documentElement.dataset.theme,
          early: window.__themeAtFirstStylesheet, meta: document.querySelector('meta[name="theme-color"]').content,
          background: getComputedStyle(document.querySelector('.workspace-loader')).backgroundColor,
          officeVisible: document.querySelector('#dashboard-page').checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) }));
        assert.equal(paint.theme, expected, JSON.stringify({ paint, errors, url: page.url() })); assert.equal(paint.early, expected);
        assert.equal(paint.meta, expected === 'dark' ? '#000000' : '#F7F5F0');
        assert.equal(paint.background, expected === 'dark' ? 'rgb(0, 0, 0)' : 'rgb(247, 245, 240)');
        assert.equal(paint.officeVisible, false);
        await assertContrast(page, '.workspace-loader', theme + ' loader');
      } finally { release(); }
      await page.waitForFunction(() => document.documentElement.classList.contains('workspace-ready'));
      await page.unroute('**/api/config', hold);
    }
    for (const theme of ['dark', 'light']) {
      await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
      await settlePaint(page);
      const borders = await page.locator('.topbar :is(.topbar-control,[data-open-report])').evaluateAll(els =>
        els.filter(el => el.checkVisibility()).map(el => ({ id: el.id, color: getComputedStyle(el).borderTopColor })));
      assert(borders.length > 0 && borders.every(button => button.color === 'rgb(110, 110, 110)'), theme + ' Heather Gray header borders ' + JSON.stringify(borders));
      assert.equal(await page.locator('#field-first-tip').count(), 0, 'obsolete tip is removed');
      for (const height of [844, 500]) await assertMyDayStart(page, theme, height, shots);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('[data-start-day]').first().click();
    await page.locator('#start-day-modal[open]').waitFor();
    for (const theme of ['dark', 'light']) {
      await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
      assert.equal(await page.locator('#start-day-modal .modal-header').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(0, 0, 0)');
      assert.equal(await page.locator('#start-day-modal .modal-header').evaluate(el => getComputedStyle(el).borderBottomColor), 'rgb(255, 102, 0)');
      await assertContrast(page, '#start-day-modal', theme + ' clock-in');
      await assertPalette(page, '#start-day-modal');
      if (theme === 'dark') await assertWhiteSecondary(page, '#start-day-modal');
      if (theme === 'dark') assert.equal(await page.locator('#start-day-modal .timestamp-preview').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(0, 0, 0)');
      if (shots) {
        fs.mkdirSync(shots, { recursive: true });
        await page.screenshot({ path: path.join(shots, `field-clock-in-${theme}-390.png`) });
      }
    }
    await page.locator('#confirm-start-day').click();
    await page.waitForFunction(() => /Clock out/i.test(document.querySelector('#start-day-button').textContent));
    await page.locator('[data-assignment-daily]').first().click();
    for (const theme of ['dark', 'light']) {
      await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
      for (const height of [844, 500]) await assertFocusedNotes(page, theme, height, shots);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#field-notes').fill('Formed east footing.');
    await page.locator('#report-next-step').click();
    await page.waitForFunction(() => document.querySelector('#report-form').dataset.currentStep === '2');
    for (const pick of await page.locator('[data-pick-line]').all()) {
      const footing = await pick.evaluate(el => [...el.options].find(option => /Footings/i.test(option.textContent))?.value);
      assert(footing, 'the note can be assigned to the fixture Footings estimate line');
      await pick.selectOption(footing);
    }
    await page.locator('#field-edit-hours').click();
    await settlePaint(page);
    // Edit hours exposes More; exercise its toggle before auditing the expanded content.
    await page.locator('#report-more > summary').click();
    await page.locator('#report-more > summary').click();
    assert.equal(await page.locator('#report-more').evaluate(el => el.open), true);
    await page.locator('#field-add-line').click();
    const editor = page.locator('.production-entry.is-editing');
    await editor.locator('.production-scope-toggle').waitFor();
    assert.equal(await editor.locator('.production-scope-toggle').innerText(), 'Use custom work');
    const item = await editor.locator('.production-item').evaluate(el => [...el.options].find(option => /Curb/i.test(option.textContent))?.value);
    assert(item, 'an estimate item is available for the quantity gate');
    await editor.locator('.production-item').selectOption(item);
    await editor.locator('.production-quantity').fill('0');
    for (const theme of ['dark', 'light']) {
      await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
      await page.locator('#field-edit-hours').click();
      await settlePaint(page);
      const samples = await assertContrast(page, '#report-modal', theme + ' expanded review');
      assert.equal(await page.locator('#report-review-summary').evaluate(el => getComputedStyle(el).backgroundColor),
        theme === 'dark' ? 'rgb(0, 0, 0)' : 'rgb(247, 245, 240)', theme + ' solid totals background');
      for (const name of ['Materials used', 'Equipment used', 'Safety observations', 'Office summary', 'Next step', 'Your name (optional)', 'Use custom work']) {
        assert(samples.some(sample => sample.text === name), name + ' was actually inspected');
      }
      for (const text of ['Hours', 'Cause and duration']) assert(samples.some(sample => sample.kind === '::placeholder' && sample.text === text), text + ' placeholder was inspected');
      await assertPalette(page, '#report-modal');
      if (theme === 'dark') await assertWhiteSecondary(page, '#report-modal');
      const button = await page.locator('#field-edit-hours').evaluate(el => {
        const style = getComputedStyle(el);
        return { background: style.backgroundColor, color: style.color, border: style.borderTopColor, height: el.getBoundingClientRect().height };
      });
      assert.deepEqual(button, { background: 'rgb(0, 0, 0)', color: 'rgb(255, 255, 255)', border: 'rgb(110, 110, 110)', height: 48 });
      if (theme === 'dark') assert.equal(await page.locator('#report-back').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(0, 0, 0)');
      const placeholder = await page.locator('#report-delays').evaluate(el => ({ typed: getComputedStyle(el).color, placeholder: getComputedStyle(el, '::placeholder').color }));
      if (theme === 'dark') assert.equal(placeholder.placeholder, 'rgb(255, 255, 255)', 'dark placeholders keep AA using white, distinguished by regular weight');
      else assert.notEqual(placeholder.placeholder, placeholder.typed, theme + ' placeholders differ from typed values');
      const weights = await page.locator('#report-modal :is(input,textarea)[placeholder]').evaluateAll(els =>
        els.filter(el => el.checkVisibility()).map(el => getComputedStyle(el, '::placeholder').fontWeight));
      assert(weights.length > 0 && weights.every(weight => weight === '400'), theme + ' regular-weight placeholders');
      if (shots) {
        fs.mkdirSync(shots, { recursive: true });
        await page.locator('#report-more').evaluate(el => {
          const scroll = el.closest('.report-step-scroll');
          scroll.scrollTop += el.getBoundingClientRect().top - scroll.getBoundingClientRect().top - 16;
        });
        await page.screenshot({ path: path.join(shots, `field-review-more-${theme}-390.png`) });
        await editor.evaluate(el => el.scrollIntoView({ block: 'start' }));
        await page.screenshot({ path: path.join(shots, `field-review-editor-${theme}-390.png`) });
      }
      for (const height of [844, 500]) {
        await page.setViewportSize({ width: 390, height });
        await page.locator('#field-edit-hours').click();
        // Edit hours reveals/focuses its input across two frames. Let that finish
        // before deliberately focusing or scrolling elsewhere for hit testing.
        await settlePaint(page);
        await page.locator('#report-delays').focus();
        await assertLayout(page, `${theme} 390x${height}`);
        if (height === 500) await assertReviewHitTargets(page, theme, shots);
        await assertBlockedSend(page, theme, height, shots);
      }
      await page.setViewportSize({ width: 390, height: 844 });
    }
    await editor.locator('.production-scope-toggle').click();
    await page.locator('.production-entry .custom-description').last().fill('Formed east footing');
    await page.evaluate(() => document.documentElement.dataset.theme = 'dark');
    await assertContrast(page, '#report-modal', 'dark custom-work editor');
    await assertPalette(page, '#report-modal');
    assert.deepEqual(errors, []);
    console.log('Playwright field review passed: normalized palette with no tints, transparent assignment chip, white dark secondary text, solid matching hours borders and keyboard-only focus rings; AA text, More/custom work, first paint, pinned actions, native focus/header clearance, no empty blocked-send boxes and tip-free Clock in above the fold at 390x844 and 390x500 in both themes. Short-screen Next step and every work-line selector pass center and edge hit tests.');
  } finally {
    await browser?.close();
    server.kill();
    await new Promise(resolve => server.exitCode !== null ? resolve() : server.once('exit', resolve));
    if (root.startsWith(path.join(os.tmpdir(), 'pdl-review-contrast-'))) fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
