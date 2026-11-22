'use strict';

const fs = require('node:fs');
const path = require('node:path');
const lib = require('./lib.cjs');

const HOURS_BUG = /Crew hours \([0-9.]+\) must equal allocated work-line hours \(0\)/;

function selectedJourneys() {
  const index = process.argv.indexOf('--journey');
  const raw = index === -1 ? '1,2,3,4,5,6' : (process.argv[index + 1] || '');
  const numbers = raw.split(',').map(value => Number(value.trim())).filter(value => value >= 1 && value <= 6);
  if (!numbers.length) throw new Error('--journey expects 1 through 6, for example 1,2');
  return numbers;
}

function checkAssertions() {
  const garbage = lib.noteVerdict(lib.GARBAGE_TRANSCRIPT, lib.SENSIBLE_TRANSCRIPT);
  const sensible = lib.noteVerdict(lib.SENSIBLE_TRANSCRIPT, 'Poured 40 LF of curb');
  const mixed = lib.noteVerdict(`${lib.SENSIBLE_TRANSCRIPT} ${lib.GARBAGE_TRANSCRIPT}`, 'Poured 40 LF of curb');
  const minutes = [1, 1];
  const hours = lib.displayHoursForMinutes(minutes);
  const ok = garbage.ok === false && garbage.reason === 'garbage-transcript'
    && sensible.ok === true
    && mixed.ok === false
    && hours.reduce((sum, value) => sum + Math.round(value * 100), 0) === Math.round(lib.hoursFromMinutes(2) * 100);
  return { ok, garbage, sensible, mixed, hours };
}

async function clockLabel(page) {
  return page.evaluate(() => document.querySelector('#start-day-button')?.textContent || '');
}

async function clockIn(page, dir) {
  await lib.openPage(page, 'fieldday');
  await lib.shot(page, dir, '01-field-day');
  let label = await clockLabel(page);
  if (/Clock out/i.test(label)) return { alreadyIn: true, label };
  if (!/Clock in/i.test(label)) throw new Error(`Clock button was "${label.trim()}"`);
  await lib.tap(page, '#start-day-button');
  await page.waitForSelector('#start-day-modal[open] #start-day-project', { timeout: 20000 });
  await page.waitForFunction(() => [...document.querySelectorAll('#start-day-project option')].some(option => option.value === '3'), { timeout: 20000 });
  await page.select('#start-day-project', '3');
  await page.waitForSelector('#start-day-members input', { timeout: 20000 });
  const boxes = await page.$$('#start-day-members input');
  for (const box of boxes) {
    const decision = await box.evaluate(element => {
      const label = element.closest('label');
      const keep = /Jordan Reed/i.test(label?.textContent || '');
      if (element.checked === keep) return null;
      (label || element).scrollIntoView({ block: 'center' });
      const rect = (label || element).getBoundingClientRect();
      return { x: rect.x + Math.min(rect.width / 2, 24), y: rect.y + rect.height / 2 };
    });
    if (decision) await page.touchscreen.tap(decision.x, decision.y);
  }
  await lib.shot(page, dir, '02-clock-in-dialog');
  await lib.tap(page, '#confirm-start-day');
  await page.waitForFunction(() => /Clock out/i.test(document.querySelector('#start-day-button')?.textContent || ''), { timeout: 30000 });
  label = await clockLabel(page);
  await lib.shot(page, dir, '03-clocked-in');
  return { alreadyIn: false, label };
}

async function readLegacy(page) {
  return page.evaluate(() => {
    function visible(el) {
      if (!el || !el.isConnected) return false;
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }
    const end = document.querySelector('#end-day-modal');
    const endOpen = end?.open === true;
    const endVisible = Boolean(end && endOpen && visible(end));
    let visibleHeading = false;
    const candidates = [];
    if (end) candidates.push(end);
    document.querySelectorAll('label, h2, p, button, legend').forEach(node => candidates.push(node));
    for (const node of candidates) {
      if (!/What was completed\?/i.test(node.textContent || '')) continue;
      if (visible(node)) { visibleHeading = true; break; }
    }
    const notes = document.querySelector('#field-notes');
    const review = document.querySelector('#field-review-cards');
    return {
      reportOpen: document.querySelector('#report-modal')?.open === true,
      endOpen,
      endVisible,
      visibleHeading,
      step1: document.querySelector('[data-report-step="1"]')?.classList.contains('active') === true,
      step2: document.querySelector('[data-report-step="2"]')?.classList.contains('active') === true,
      notesVisible: visible(notes),
      reviewVisible: Boolean(review) && !review.hidden && visible(review),
      button: document.querySelector('#start-day-button')?.textContent || ''
    };
  });
}

function legacyPainted(watch, screen) {
  return (watch?.hits?.length > 0) || screen?.endVisible === true || screen?.visibleHeading === true;
}

async function clockOut(page, dir) {
  await page.evaluate(() => {
    if (window.__pdlOldScreen) window.__pdlOldScreen.armed = true;
  });
  const video = await lib.startVideo(page, path.join(dir, 'clock-out.webm'));
  await lib.tap(page, '#start-day-button');
  await page.waitForFunction(() => document.querySelector('#report-modal')?.open || document.querySelector('#end-day-modal')?.open, { timeout: 30000 });
  await lib.sleep(700);
  const watch = await page.evaluate(() => window.__pdlOldScreen || { hits: [], reviewSeenAt: null, samples: 0, installed: false });
  const screen = await readLegacy(page);
  const screenshot = await lib.shot(page, dir, '04-after-clock-out');
  await video.stop();
  return { watch, screen, screenshot, video: video.file, videoError: video.error || '', oldPainted: legacyPainted(watch, screen) };
}

async function watchThroughReview(page, dir) {
  await page.waitForFunction(() => document.querySelector('#end-day-modal')?.open !== true, { timeout: 4000 }).catch(() => {});
  await lib.tap(page, '#report-next-step');
  await page.waitForFunction(() => {
    const step2 = document.querySelector('[data-report-step="2"]')?.classList.contains('active') === true;
    const endOpen = document.querySelector('#end-day-modal')?.open === true;
    return step2 || endOpen;
  }, { timeout: 30000 });
  await lib.sleep(800);
  const watch = await page.evaluate(() => window.__pdlOldScreen || { hits: [], reviewSeenAt: null, samples: 0, installed: false });
  const screen = await readLegacy(page);
  const screenshot = await lib.shot(page, dir, '05-through-review');
  return { watch, screen, screenshot, oldPainted: legacyPainted(watch, screen) };
}

async function speakNotes(page, dir, transcript) {
  await page.evaluate(value => { window.__PDL_SPEECH_TRANSCRIPT = value; window.__pdlSpeechEmitted = false; }, transcript);
  const video = await lib.startVideo(page, path.join(dir, 'speak.webm'));
  await lib.shot(page, dir, '01-before-speak');
  await lib.tap(page, '#voice-notes');
  let notes = '';
  try {
    await page.waitForFunction(snippet => (document.querySelector('#field-notes')?.value || '').includes(snippet), { timeout: 15000 }, transcript.slice(0, 24));
    notes = await page.$eval('#field-notes', element => element.value);
  } catch (error) {
    notes = await page.evaluate(() => document.querySelector('#field-notes')?.value || '');
    const status = await page.evaluate(() => document.querySelector('#voice-status')?.textContent || '');
    await lib.shot(page, dir, '02-speak-failed');
    await video.stop();
    return { ok: false, notes, status, error: error.message, video: video.file, videoError: video.error || '' };
  }
  const verdict = lib.noteVerdict(notes, transcript);
  await lib.shot(page, dir, '02-transcript');
  const stop = await page.evaluate(() => {
    const button = document.querySelector('#voice-notes');
    if (!button || button.getAttribute('aria-pressed') !== 'true') return null;
    button.scrollIntoView({ block: 'center' });
    const rect = button.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return { hidden: true };
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  });
  if (stop?.x) await page.touchscreen.tap(stop.x, stop.y);
  await video.stop();
  return { ok: verdict.ok, reason: verdict.reason, notes, video: video.file, videoError: video.error || '' };
}

async function typeNotes(page, transcript) {
  await lib.tap(page, '#field-notes');
  await page.type('#field-notes', transcript, { delay: 4 });
}

async function reviewSnapshot(page) {
  return page.evaluate(() => {
    const lines = [...document.querySelectorAll('.production-entry')].map(row => ({
      id: row.dataset.estimateItemId || '',
      extra: row.dataset.extraWork === 'true',
      qty: row.querySelector('.production-quantity')?.value || '',
      minutes: row.dataset.laborMinutes || '',
      hours: row.querySelector('.production-hours')?.value || '',
      name: (row.querySelector('.custom-description')?.value || row.querySelector('.production-item')?.selectedOptions?.[0]?.textContent || '').trim()
    }));
    const reviewMinutes = [...document.querySelectorAll('[data-review-labor]')].map(input => Number(input.value) || 0);
    return {
      step2: document.querySelector('[data-report-step="2"]')?.classList.contains('active') === true,
      lines,
      reviewMinutes,
      flags: document.querySelector('#field-scope-flags')?.innerText || '',
      status: document.querySelector('#report-submit-status')?.textContent || '',
      review: (document.querySelector('#field-review-cards')?.innerText || '').slice(0, 1500),
      sendDisabled: document.querySelector('#save-report')?.disabled === true
    };
  });
}

async function openReview(page, dir) {
  await lib.tap(page, '#report-next-step');
  await page.waitForFunction(() => document.querySelector('[data-report-step="2"]')?.classList.contains('active') === true, { timeout: 30000 });
  await lib.sleep(800);
  const snapshot = await reviewSnapshot(page);
  await lib.shot(page, dir, '03-review');
  return snapshot;
}

function punchMinutes(state) {
  const card = (state.timeCards || []).filter(row => row.inAt && row.outAt).sort((a, b) => String(b.outAt).localeCompare(String(a.outAt)))[0];
  if (!card) return 0;
  return lib.elapsedMinutes(card.inAt, card.outAt);
}

function latestReport(state) {
  return (state.reports || []).slice().sort((a, b) => Number(b.id) - Number(a.id))[0] || null;
}

async function journey3(page, dir, state) {
  const snapshot = await reviewSnapshot(page);
  const curb = snapshot.lines.find(line => line.id === '1' && line.qty === '40');
  const gutter = snapshot.lines.find(line => line.id === '5' && line.qty === '20');
  const total = punchMinutes(state);
  const allocated = snapshot.lines.filter(line => Number(line.minutes) > 0);
  const minutes = allocated.map(line => Number(line.minutes) || 0);
  const sum = minutes.reduce((totalMinutes, value) => totalMinutes + value, 0);
  const shownHours = allocated.map(line => Number(line.hours) || 0);
  const expectedHours = lib.displayHoursForMinutes(minutes);
  const hoursMatch = minutes.length > 0 && expectedHours.length === shownHours.length && expectedHours.every((value, index) => Math.abs(value - shownHours[index]) < 0.001);
  const ok = Boolean(curb && gutter) && total > 0 && sum === total && hoursMatch;
  const reasons = [];
  if (!curb) reasons.push('Curb 40 LF was not on estimate line 1');
  if (!gutter) reasons.push('Gutter 20 LF was not on estimate line 5');
  if (!(total > 0)) reasons.push('Punch total is 0 minutes, so the largest-remainder split is not observable');
  if (sum !== total) reasons.push(`Line minutes ${sum} do not equal punch minutes ${total}`);
  if (!hoursMatch) reasons.push('Displayed line hours are not the largest-remainder hours for those minutes');
  await lib.writeJson(path.join(dir, 'state.json'), { snapshot, total, sum, expectedHours, shownHours, report: latestReport(state) });
  return { ok, reasons, total, sum };
}

async function markExtra(page, dir) {
  const point = await page.evaluate(() => {
    const article = [...document.querySelectorAll('.field-flag')].find(element => /Needs your pick/i.test(element.innerText || ''));
    const button = article?.querySelector('[data-flag-choice="extra"]');
    if (!button) return null;
    button.scrollIntoView({ block: 'center' });
    const rect = button.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, text: article.innerText.slice(0, 240) };
  });
  if (!point) return { ok: false, reason: 'Needs your pick was not on screen' };
  await lib.shot(page, dir, '04-needs-pick');
  await page.touchscreen.tap(point.x, point.y);
  await lib.sleep(1200);
  const after = await reviewSnapshot(page);
  const quantityBlocked = /Enter a quantity for each work line/i.test(after.status);
  await lib.shot(page, dir, '05-marked-extra');
  return { ok: !quantityBlocked && /equipment pad/i.test(`${after.flags}\n${after.review}`), quantityBlocked, status: after.status, flags: after.flags };
}

async function reopen(page, dir) {
  await lib.tap(page, '#close-report');
  await page.waitForFunction(() => !document.querySelector('#report-modal')?.open, { timeout: 15000 });
  await lib.openPage(page, 'reports');
  await page.waitForSelector('[data-edit-report]', { timeout: 20000 });
  const point = await page.evaluate(() => {
    const button = document.querySelector('[data-edit-report]');
    button?.scrollIntoView({ block: 'center' });
    const rect = button?.getBoundingClientRect();
    return rect ? { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 } : null;
  });
  if (!point) return { ok: false, reason: 'Edit control was missing' };
  await page.touchscreen.tap(point.x, point.y);
  await page.waitForFunction(() => document.querySelector('#report-modal')?.open, { timeout: 20000 });
  await lib.sleep(800);
  const after = await reviewSnapshot(page);
  const state = await lib.readState(page);
  const report = latestReport(state);
  const extra = (report?.extraWork || []).some(item => /equipment pad/i.test(item.description || '') && item.extra_work === true);
  const production = (report?.productionEntries || []).filter(entry => entry?.extra_work !== true);
  const leaked = production.some(entry => /equipment pad/i.test(entry.description || ''));
  const flagHeld = (report?.scopeFlags || []).some(flag => /equipment pad/i.test(flag.description || '') && flag.decision === 'extra') || extra;
  await lib.shot(page, dir, '06-reopened');
  await lib.writeJson(path.join(dir, 'reopen-state.json'), { report, after });
  return { ok: flagHeld && !leaked, flagHeld, leaked, extra, status: after.status };
}

async function sendDaily(page, dir) {
  const point = await page.evaluate(() => {
    const button = document.querySelector('#save-report');
    button?.scrollIntoView({ block: 'center' });
    const rect = button?.getBoundingClientRect();
    return rect && rect.width ? { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, disabled: button.disabled } : null;
  });
  if (!point) return { ok: false, reason: 'Send button missing' };
  if (!point.disabled) await page.touchscreen.tap(point.x, point.y);
  await lib.sleep(1500);
  const sent = await page.evaluate(() => document.querySelector('#report-sent-modal')?.open === true);
  const status = await page.evaluate(() => document.querySelector('#report-submit-status')?.textContent || '');
  await lib.shot(page, dir, '07-send');
  return { ok: sent, status, disabled: point.disabled, hoursBug: HOURS_BUG.test(status) };
}

async function signOut(page) {
  const menuOpen = await page.evaluate(() => document.querySelector('#sidebar')?.classList.contains('open') === true);
  if (!menuOpen) await lib.tap(page, '#menu-button');
  const opened = await page.evaluate(() => {
    const blocking = [...document.querySelectorAll('dialog')].filter(dialog => dialog.open).map(dialog => dialog.id);
    try {
      document.querySelector('#profile-button')?.click();
    } catch (error) {
      return { ok: false, blocking, error: String(error && error.message || error) };
    }
    return { ok: document.querySelector('#profile-modal')?.open === true, blocking };
  });
  if (!opened.ok) {
    await page.evaluate(() => {
      document.querySelectorAll('dialog[open]').forEach(dialog => {
        if (dialog.id === 'profile-modal') return;
        try { dialog.close(); } catch { /* already closing */ }
      });
      document.querySelector('#profile-button')?.click();
    });
  }
  await page.waitForSelector('#profile-modal[open] #profile-logout-button', { timeout: 15000 });
  await page.evaluate(() => document.querySelector('#profile-logout-button')?.click());
  await page.waitForFunction(() => location.pathname.includes('login'), { timeout: 20000 });
}

async function officeReview(page, dir, reportId) {
  await lib.loginUi(page, 'owner');
  await lib.openPage(page, 'reports');
  await page.waitForSelector(`[data-report="${reportId}"]`, { timeout: 20000 });
  await lib.tap(page, `[data-report="${reportId}"]`);
  await lib.sleep(800);
  const before = await page.evaluate(() => {
    const button = document.querySelector('[data-approve-report]');
    const detail = document.querySelector('#report-detail');
    const text = detail?.innerText || '';
    const productionLines = (text.match(/PRODUCTION[\s\S]*?(?=DELAYS|NEXT STEP)/i) || [''])[0];
    return {
      disabled: button?.disabled === true,
      help: text,
      extra: document.querySelector('.extra-work-office')?.innerText || '',
      productionLines
    };
  });
  await lib.shot(page, dir, '08-office-blocked');
  const blocked = before.disabled && /Mark each extra-work item Billable or Not billable to approve/i.test(before.help);
  const onlyExtra = /equipment pad/i.test(before.extra) && !/equipment pad/i.test(before.productionLines || '');
  await page.select('#office-decision', 'non_billable');
  await page.waitForFunction(() => {
    const button = document.querySelector('[data-approve-report]');
    return button && !button.disabled;
  }, { timeout: 20000 });
  await lib.shot(page, dir, '09-office-ready');
  await lib.tap(page, '[data-approve-report]');
  await lib.sleep(1200);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#menu-button', { timeout: 30000 });
  await lib.openPage(page, 'reports');
  await lib.tap(page, '[data-report]');
  await lib.sleep(800);
  const state = await lib.readState(page);
  const report = latestReport(state);
  const persisted = (report?.extraWork || []).some(item => /equipment pad/i.test(item.description || '') && item.billable === false);
  const approved = report?.status === 'Approved';
  await lib.shot(page, dir, '10-office-persisted');
  await lib.writeJson(path.join(dir, 'office-state.json'), { before, report });
  return { ok: blocked && onlyExtra && persisted && approved, blocked, onlyExtra, persisted, approved, status: report?.status || '' };
}

async function quietHours(page, dir) {
  await clockIn(page, dir);
  await lib.sleep(75000);
  const out = await clockOut(page, dir);
  await typeNotes(page, lib.QUIET_TRANSCRIPT);
  const snapshot = await openReview(page, dir);
  const lineHours = snapshot.lines.some(line => Number(line.hours) > 0 || Number(line.qty) > 0);
  const sent = await sendDaily(page, dir);
  const text = `${snapshot.status}\n${sent.status}\n${snapshot.review}`;
  const bug = HOURS_BUG.test(text);
  const state = await lib.readState(page);
  const minutes = punchMinutes(state);
  await lib.writeJson(path.join(dir, 'state.json'), { snapshot, sent, state, minutes, out: out.screen });
  const ok = !bug && !lineHours && minutes >= 1;
  const reason = bug ? 'crew-hours-must-equal-allocated' : (lineHours ? 'a-line-had-hours' : (minutes >= 1 ? '' : 'punch-was-under-one-minute'));
  return { ok, reason, bug, lineHours, minutes, status: sent.status, oldPainted: out.oldPainted };
}

async function staleCacheJourney(page, root) {
  const dir = lib.ensureDir(path.join(root, 'journey-1-stale'));
  await lib.loginUi(page, 'field');
  const registered = await page.evaluate(async () => {
    const protocol = location.protocol;
    if (!('serviceWorker' in navigator)) return { ok: false, error: 'serviceWorker missing', protocol };
    try {
      const registration = await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;
      return { ok: true, scope: registration.scope, controller: Boolean(navigator.serviceWorker.controller), protocol };
    } catch (error) {
      return { ok: false, error: String(error && error.message || error), protocol };
    }
  });
  let mode = registered.ok ? 'service-worker' : 'request-interception';
  let patch = { ok: false };
  const patchSource = text => text.replace(
    'async function openEndDay(id){',
    'async function openEndDay(id){try{const legacy=document.querySelector("#end-day-modal");legacy?.showModal();setTimeout(()=>{try{legacy?.close()}catch(e){}},1200)}catch(e){}'
  );
  if (registered.ok) {
    await page.reload({ waitUntil: 'networkidle0', timeout: 45000 });
    await page.waitForSelector('#menu-button', { timeout: 30000 });
    const src = await page.evaluate(() => [...document.scripts].map(script => script.src).find(script => /\/app\.js\?/.test(script)) || '');
    const response = await fetch(src);
    const text = patchSource(await response.text());
    patch = await page.evaluate(async (scriptSrc, body) => {
      const cache = await caches.open('pdl-shell-v1');
      await cache.delete(scriptSrc);
      await cache.put(scriptSrc, new Response(body, { status: 200, headers: { 'Content-Type': 'application/javascript' } }));
      const saved = await cache.match(scriptSrc);
      const savedText = saved ? await saved.text() : '';
      return {
        ok: savedText.includes('legacy?.showModal'),
        src: scriptSrc,
        controlled: Boolean(navigator.serviceWorker.controller)
      };
    }, src, text);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#menu-button', { timeout: 30000 });
  }
  let executed = await page.evaluate(() => {
    try {
      return {
        patched: String(openEndDay).includes('legacy?.showModal'),
        controller: Boolean(navigator.serviceWorker && navigator.serviceWorker.controller)
      };
    } catch (error) {
      return { patched: false, controller: false, error: String(error && error.message || error) };
    }
  });
  if (!executed.patched) {
    mode = 'request-interception';
    await page.evaluate(async () => {
      const registrations = await navigator.serviceWorker?.getRegistrations?.() || [];
      await Promise.all(registrations.map(registration => registration.unregister()));
      const keys = await caches.keys();
      await Promise.all(keys.map(key => caches.delete(key)));
    });
    const src = await page.evaluate(() => [...document.scripts].map(script => script.src).find(script => /\/app\.js\?/.test(script)) || '');
    const response = await fetch(src);
    const text = patchSource(await response.text());
    if (!text.includes('legacy?.showModal')) throw new Error('openEndDay needle missing for interception');
    await page.setRequestInterception(true);
    page.on('request', request => {
      if (/\/app\.js\?/.test(request.url())) request.respond({ status: 200, contentType: 'application/javascript', body: text }).catch(() => {});
      else request.continue().catch(() => {});
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#menu-button', { timeout: 30000 });
    executed = await page.evaluate(() => {
      try {
        return { patched: String(openEndDay).includes('legacy?.showModal'), controller: Boolean(navigator.serviceWorker && navigator.serviceWorker.controller) };
      } catch (error) {
        return { patched: false, controller: false, error: String(error && error.message || error) };
      }
    });
  }
  await clockIn(page, dir);
  const out = await clockOut(page, dir);
  let through = null;
  try { through = await watchThroughReview(page, dir); }
  catch (error) { through = { error: error.message, oldPainted: false, watch: { hits: [] }, screen: {} }; }
  const legacy = out.oldPainted || Boolean(through.oldPainted);
  lib.writeJson(path.join(dir, 'watch.json'), {
    mode,
    appRegistersOnHttpsOnly: true,
    registered,
    patch,
    executed,
    atClockOut: { watch: out.watch, screen: out.screen, videoError: out.videoError },
    throughReview: through.watch ? { watch: through.watch, screen: through.screen, error: through.error || '' } : through
  });
  return {
    journey: '1-stale-cache',
    ok: executed.patched === true && legacy === true,
    reason: executed.patched ? (legacy ? 'watcher-caught-legacy-modal' : 'patched-script-ran-but-legacy-modal-did-not-paint') : 'patched-app-js-did-not-run',
    legacyPainted: legacy,
    patched: executed.patched === true,
    hits: ((through.watch || out.watch).hits || []).length,
    serviceWorker: { protocol: registered.protocol, registered: registered.ok, mode },
    evidence: dir
  };
}

async function main() {
  if (process.argv.includes('--check-assertions')) {
    const result = checkAssertions();
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exit(result.ok ? 0 : 1);
  }
  const staleCache = process.argv.includes('--stale-cache');
  const journeys = staleCache ? [] : selectedJourneys();
  const root = lib.ensureDir(lib.artifactsRoot());
  const browser = await lib.launchBrowser();
  const run = { browserPid: browser.process()?.pid || null, startedAt: new Date().toISOString(), journeys, base: lib.baseUrl() };
  lib.writeJson(path.join(root, 'run.json'), run);
  const results = [];
  const page = await lib.newPhonePage(browser);
  try {
    if (staleCache) {
      results.push(await staleCacheJourney(page, root));
    } else if (journeys.length === 1 && journeys[0] === 6) {
      await lib.loginUi(page, 'field');
      const dir = lib.ensureDir(path.join(root, 'journey-6'));
      const result = await quietHours(page, dir);
      results.push({ journey: 6, evidence: dir, ...result });
    } else {
      await lib.loginUi(page, 'field');
      const dir = lib.ensureDir(path.join(root, 'field-session'));
      await clockIn(page, dir);
      if (journeys.includes(3)) await lib.sleep(125000);
      const out = await clockOut(page, dir);
      if (journeys.includes(1)) {
        const journeyDir = lib.ensureDir(path.join(root, 'journey-1'));
        fs.copyFileSync(out.screenshot, path.join(journeyDir, '04-after-clock-out.png'));
        if (fs.existsSync(out.video)) fs.copyFileSync(out.video, path.join(journeyDir, 'clock-out.webm'));
        const solo = !journeys.some(number => number >= 2 && number <= 5);
        const through = solo ? await watchThroughReview(page, journeyDir) : null;
        const legacy = out.oldPainted || Boolean(through?.oldPainted);
        lib.writeJson(path.join(journeyDir, 'watch.json'), {
          watch: through?.watch || out.watch,
          atClockOut: { watch: out.watch, screen: out.screen },
          throughReview: through ? { watch: through.watch, screen: through.screen } : null,
          videoError: out.videoError
        });
        results.push({
          journey: 1,
          ok: out.screen.reportOpen && !legacy && (through ? through.screen.reviewVisible : true),
          reason: !out.screen.reportOpen ? 'daily-did-not-open' : (legacy ? 'legacy-end-day-modal-painted' : (through && !through.screen.reviewVisible ? 'review-not-reached' : '')),
          oldPainted: legacy,
          hits: ((through?.watch || out.watch).hits || []).length,
          reviewVisible: through ? through.screen.reviewVisible : out.screen.reviewVisible,
          endOpen: (through?.screen || out.screen).endVisible === true,
          notesFirst: out.screen.step1 && out.screen.notesVisible && !out.screen.reviewVisible,
          evidence: journeyDir
        });
      }
      const transcript = journeys.some(number => number >= 3) ? lib.SENSIBLE_TRANSCRIPT : lib.SENSIBLE_TRANSCRIPT;
      if (journeys.includes(2)) {
        const journeyDir = lib.ensureDir(path.join(root, 'journey-2'));
        const spoken = await speakNotes(page, journeyDir, transcript);
        const state = await lib.readState(page);
        lib.writeJson(path.join(journeyDir, 'state.json'), state);
        results.push({ journey: 2, ok: spoken.ok, reason: spoken.reason || '', notes: spoken.notes, evidence: journeyDir, videoError: spoken.videoError || '' });
      } else if (journeys.some(number => number >= 3 && number <= 5)) {
        await typeNotes(page, transcript);
      }
      if (journeys.some(number => number >= 3 && number <= 5)) {
        const notes = await page.$eval('#field-notes', element => element.value);
        if (!notes.includes('Poured 40 LF of curb')) throw new Error('Production notes were not in the daily, so later journeys were not driven.');
        await openReview(page, dir);
      }
      if (journeys.includes(3)) {
        const state = await lib.readState(page);
        const result = await journey3(page, dir, state);
        results.push({ journey: 3, ...result, evidence: dir });
      }
      if (journeys.includes(4)) {
        const marked = await markExtra(page, dir);
        const opened = marked.ok ? await reopen(page, dir) : { ok: false, reason: 'extra work was not marked' };
        results.push({ journey: 4, ok: marked.ok && opened.ok, marked, opened, evidence: dir });
      }
      if (journeys.includes(5)) {
        if (!journeys.includes(4)) await markExtra(page, dir);
        const onReview = await page.evaluate(() => document.querySelector('#report-modal')?.open === true && document.querySelector('[data-report-step="2"]')?.classList.contains('active') === true);
        if (!onReview) await openReview(page, dir);
        const sent = await sendDaily(page, dir);
        if (sent.ok) {
          await page.waitForSelector('#report-sent-modal[open] button.primary', { timeout: 8000 });
          await page.click('#report-sent-modal button.primary');
          await page.waitForFunction(() => document.querySelector('#report-sent-modal')?.open !== true, { timeout: 8000 });
        }
        const sentState = await lib.readState(page);
        const reportId = latestReport(sentState)?.id;
        if (!sent.ok || !reportId) results.push({ journey: 5, ok: false, reason: sent.reason || sent.status || 'send-failed', sent, evidence: dir });
        else {
          await signOut(page);
          const office = await officeReview(page, dir, reportId);
          results.push({ journey: 5, ...office, sent, evidence: dir });
        }
      }
      if (journeys.includes(6)) {
        results.push({ journey: 6, ok: false, reason: 'A field punch is already open or closed today. Journey 6 needs a reseeded staging day of its own. Run --journey 6 by itself.', evidence: dir });
      }
    }
  } catch (error) {
    const failDir = lib.ensureDir(path.join(root, 'drive-error'));
    try { await lib.shot(page, failDir, 'error'); } catch { /* page may already be closed */ }
    results.push({ journey: 0, ok: false, error: error.message, evidence: failDir });
  } finally {
    await browser.close();
    run.browserPid = null;
    run.finishedAt = new Date().toISOString();
    run.results = results.map(result => ({
      journey: result.journey,
      ok: result.ok,
      reason: result.reason || (result.reasons || []).join('; '),
      evidence: result.evidence || '',
      legacyPainted: result.legacyPainted,
      oldPainted: result.oldPainted,
      hits: result.hits,
      patched: result.patched,
      reviewVisible: result.reviewVisible,
      notesFirst: result.notesFirst,
      bug: result.bug,
      lineHours: result.lineHours,
      status: result.status,
      serviceWorker: result.serviceWorker
    }));
    lib.writeJson(path.join(root, 'run.json'), run);
    lib.writeJson(path.join(root, 'results.json'), results);
  }
  const mirror = '/opt/cursor/artifacts/verify-pro-daily-link';
  fs.cpSync(root, mirror, { recursive: true });
  process.stdout.write(`${JSON.stringify({ artifacts: root, mirror, results: run.results }, null, 2)}\n`);
  process.exit(results.every(result => result.ok) ? 0 : 1);
}

main().catch(error => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
