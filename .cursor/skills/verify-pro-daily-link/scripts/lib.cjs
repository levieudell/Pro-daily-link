'use strict';

const fs = require('node:fs');
const path = require('node:path');

const GARBAGE_TRANSCRIPT = 'Cars Our supply now Cars final';
const SENSIBLE_TRANSCRIPT = 'Poured 40 LF of curb and 20 LF of gutter. Used 6 yards of concrete. Installed an equipment pad. Tomorrow we need the pump.';
const QUIET_TRANSCRIPT = 'Walked the site and talked with the superintendent.';
const FIELD_EMAIL = process.env.PDL_STAGING_FIELD_EMAIL || 'levi+field@prodailylink.com';
const OWNER_EMAIL = process.env.PDL_STAGING_OWNER_EMAIL || 'levi+owner@prodailylink.com';
const COMPANY_NAME = 'DEMO | Alder Ridge Builders';

function baseUrl() {
  return String(process.env.PDL_VERIFY_BASE || 'https://pdl-staging.onrender.com').replace(/\/$/, '');
}

function artifactsRoot() {
  return process.env.PDL_VERIFY_ARTIFACTS || '/tmp/pdl-verify-artifacts';
}

function requirePassword(name) {
  const value = process.env[name] || '';
  if (value.length < 10) {
    const error = new Error(`${name} is unset or shorter than 10 characters. Set it in the environment. Do not write it into the skill or the command line.`);
    error.code = 'MISSING_PASSWORD';
    throw error;
  }
  return value;
}

function puppeteer() {
  const candidates = ['puppeteer-core', process.env.PDL_PUPPETEER_MODULE, '/tmp/puppeteer/node_modules/puppeteer-core'].filter(Boolean);
  const errors = [];
  for (const name of candidates) {
    try { return require(name); }
    catch (error) { errors.push(`${name}: ${error.message}`); }
  }
  throw new Error('puppeteer-core is required, same as the field e2e tests. ' + errors.join(' | '));
}

function chromePath() {
  const candidates = [
    process.env.PDL_TEST_CHROME,
    '/usr/bin/google-chrome-stable',
    '/usr/local/bin/google-chrome',
    '/usr/bin/google-chrome'
  ].filter(Boolean);
  return candidates.find(candidate => fs.existsSync(candidate)) || '';
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeJson(file, value) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function noteVerdict(text, expected) {
  const value = String(text || '');
  if (value.includes(GARBAGE_TRANSCRIPT)) return { ok: false, reason: 'garbage-transcript' };
  if (expected && !value.includes(expected)) return { ok: false, reason: 'transcript-missing' };
  return { ok: true, reason: 'transcript-landed' };
}

function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function hoursFromMinutes(minutes) {
  return round2(Math.max(0, Number(minutes) || 0) / 60);
}

function splitLargestRemainder(total, weights) {
  const count = weights.length;
  if (!count) return [];
  const target = Math.max(0, Math.round(Number(total) || 0));
  if (!target) return weights.map(() => 0);
  const sum = weights.reduce((totalWeight, weight) => totalWeight + (Number(weight) || 0), 0);
  const raw = weights.map(weight => (sum > 0 ? target * (Number(weight) || 0) / sum : target / count));
  const floors = raw.map(value => Math.floor(value + 1e-9));
  let left = target - floors.reduce((totalUnits, value) => totalUnits + value, 0);
  const order = raw.map((value, index) => ({ index, fraction: value - floors[index], weight: Number(weights[index]) || 0 }))
    .sort((a, b) => b.fraction - a.fraction || b.weight - a.weight || a.index - b.index);
  let cursor = 0;
  while (left > 0 && order.length) {
    floors[order[cursor % order.length].index] += 1;
    left -= 1;
    cursor += 1;
  }
  return floors;
}

function displayHoursForMinutes(minuteList) {
  const minutes = (Array.isArray(minuteList) ? minuteList : []).map(value => Math.max(0, Math.round(Number(value) || 0)));
  const hundredths = Math.round(hoursFromMinutes(minutes.reduce((sum, value) => sum + value, 0)) * 100);
  return splitLargestRemainder(hundredths, minutes).map(part => part / 100);
}

function elapsedMinutes(start, end) {
  const ms = new Date(end) - new Date(start);
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.floor(ms / 60000);
}

function redactState(data) {
  const reports = (data?.reports || []).map(report => ({
    id: report.id,
    status: report.status,
    dateIso: report.dateIso,
    project: report.project,
    projectId: report.projectId,
    notes: report.notes,
    originalNotes: report.originalNotes,
    next: report.next,
    productionEntries: report.productionEntries,
    extraWork: report.extraWork,
    laborEntries: report.laborEntries,
    scopeFlags: report.scopeFlags,
    history: (report.history || []).map(row => ({ action: row.action, at: row.at })),
    updatedAfterSend: report.updatedAfterSend ? { at: report.updatedAfterSend.at, summary: report.updatedAfterSend.summary } : null
  }));
  const workdays = (data?.workdays || []).map(day => ({
    id: day.id, status: day.status, projectId: day.projectId, reportId: day.reportId, startedAt: day.startedAt, endedAt: day.endedAt
  }));
  const timeCards = (data?.timeCards || []).map(card => ({
    id: card.id, memberId: card.memberId, projectId: card.projectId, reportId: card.reportId, date: card.date, inAt: card.inAt, outAt: card.outAt, status: card.status
  }));
  const projects = (data?.projects || []).map(project => ({ id: project.id, name: project.name }));
  return {
    companyName: data?.company?.name || '',
    projects,
    reports,
    workdays,
    timeCards
  };
}

function storeCookies(jar, response) {
  const lines = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
  for (const line of lines) {
    const pair = String(line).split(';', 1)[0];
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1));
  }
}

function cookieHeader(jar) {
  return [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
}

async function apiRequest(jar, method, pathname, body) {
  const headers = { accept: 'application/json' };
  const cookie = cookieHeader(jar);
  if (cookie) headers.cookie = cookie;
  const company = jar.get('pdl_company');
  if (company) headers['x-pdl-company'] = company;
  let payload;
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const response = await fetch(baseUrl() + pathname, { method, headers, body: payload });
  storeCookies(jar, response);
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; }
  catch { data = { unparsed: true }; }
  return { status: response.status, data };
}

async function loginAccount(role) {
  const email = role === 'owner' ? OWNER_EMAIL : FIELD_EMAIL;
  const password = requirePassword(role === 'owner' ? 'PDL_STAGING_OWNER_PASSWORD' : 'PDL_STAGING_FIELD_PASSWORD');
  const jar = new Map();
  const company = await apiRequest(jar, 'POST', '/api/auth/company', { email });
  if (!company.data?.companyId) {
    return { ok: false, role, status: company.status, error: company.data?.error || 'company lookup failed' };
  }
  jar.set('pdl_company', company.data.companyId);
  const logged = await apiRequest(jar, 'POST', '/api/auth/login', { email, password });
  if (logged.status !== 200) {
    return { ok: false, role, status: logged.status, error: logged.data?.error || 'login failed' };
  }
  const me = await apiRequest(jar, 'GET', '/api/auth/me');
  const state = await apiRequest(jar, 'GET', '/api/state');
  const safe = redactState(state.data);
  return {
    ok: me.status === 200 && safe.companyName === COMPANY_NAME,
    role,
    loginStatus: logged.status,
    meStatus: me.status,
    stateStatus: state.status,
    accountRole: me.data?.role || '',
    name: me.data?.name || '',
    companyName: safe.companyName,
    cedarGrove: safe.projects.some(project => /Cedar Grove/i.test(project.name || '')),
    jar
  };
}

async function launchBrowser() {
  const executablePath = chromePath();
  if (!executablePath) throw new Error('Set PDL_TEST_CHROME to a Chrome or Chromium binary.');
  const browser = await puppeteer().launch({
    executablePath,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream']
  });
  return browser;
}

function pageHooks() {
  localStorage.setItem('pdl-analytics-consent', 'declined');
  localStorage.setItem('pdl-field-tip', 'dismissed');
  window.__PDL_SPEECH_TRANSCRIPT = window.__PDL_SPEECH_TRANSCRIPT || '';
  window.__pdlSpeechEmitted = false;
  class FakeSpeechRecognition {
    start() {
      if (window.__pdlSpeechEmitted) return;
      const transcript = String(window.__PDL_SPEECH_TRANSCRIPT || '');
      if (!transcript) return;
      window.__pdlSpeechEmitted = true;
      setTimeout(() => {
        if (typeof this.onresult !== 'function') return;
        this.onresult({
          resultIndex: 0,
          results: [{ 0: { transcript }, isFinal: true, length: 1 }]
        });
      }, 40);
    }
    stop() { if (typeof this.onend === 'function') this.onend(); }
    abort() { this.stop(); }
  }
  window.SpeechRecognition = FakeSpeechRecognition;
  window.webkitSpeechRecognition = FakeSpeechRecognition;
  try { delete window.MediaRecorder; } catch { /* non-configurable in this browser */ }
  window.MediaRecorder = undefined;
  if (!window.__pdlOldScreen) {
    const state = { armed: false, hits: [], reviewSeenAt: null, samples: 0 };
    window.__pdlOldScreen = state;
    function visible(el) {
      if (!el) return false;
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }
    function sample(reason) {
      state.samples += 1;
      const review = document.querySelector('#field-review-cards');
      const reviewVisible = visible(review) && !review.hidden;
      if (reviewVisible && state.reviewSeenAt == null) state.reviewSeenAt = performance.now();
      if (!state.armed || state.reviewSeenAt != null || state.hits.length >= 12) return;
      const end = document.querySelector('#end-day-modal');
      const notesStep = document.querySelector('[data-report-step="1"]');
      const notes = document.querySelector('#field-notes');
      const oldEnd = Boolean(end && end.open && visible(end));
      const oldHeading = Boolean(oldEnd && /What was completed\?/i.test(end.innerText || ''));
      const oldNotes = Boolean(oldEnd && visible(document.querySelector('#end-day-notes')));
      const oldConfirm = Boolean(oldEnd && visible(document.querySelector('#confirm-end-day')));
      const notesFirst = Boolean(visible(notesStep) && notesStep.classList.contains('active') && visible(notes) && !reviewVisible);
      if (oldEnd || oldHeading || oldNotes || oldConfirm || notesFirst) {
        state.hits.push({
          reason,
          at: Math.round(performance.now()),
          oldEnd,
          oldHeading,
          oldNotes,
          oldConfirm,
          notesFirst,
          stepActive: notesStep?.classList.contains('active') === true
        });
      }
    }
    const observer = new MutationObserver(() => sample('mutation'));
    observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'open', 'hidden', 'style'] });
    (function frame() {
      sample('frame');
      requestAnimationFrame(frame);
    })();
  }
}

async function newPhonePage(browser) {
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  page.on('dialog', dialog => dialog.accept());
  await page.evaluateOnNewDocument(pageHooks);
  return page;
}

async function tap(page, selector) {
  await page.waitForSelector(selector, { timeout: 20000, visible: true });
  await page.$eval(selector, element => element.scrollIntoView({ block: 'center', inline: 'center' }));
  const handle = await page.$(selector);
  await handle.tap();
}

async function shot(page, dir, name) {
  ensureDir(dir);
  const file = path.join(dir, name.endsWith('.png') ? name : `${name}.png`);
  await page.screenshot({ path: file, captureBeyondViewport: false });
  return file;
}

async function startVideo(page, file) {
  ensureDir(path.dirname(file));
  try {
    const recorder = await page.screencast({ path: file });
    return { file, stop: async () => { await recorder.stop(); } };
  } catch (error) {
    return { file, error: error.message, stop: async () => {} };
  }
}

async function loginUi(page, role) {
  const email = role === 'owner' ? OWNER_EMAIL : FIELD_EMAIL;
  const password = requirePassword(role === 'owner' ? 'PDL_STAGING_OWNER_PASSWORD' : 'PDL_STAGING_FIELD_PASSWORD');
  await page.goto(`${baseUrl()}/login.html`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('#email', { timeout: 30000 });
  await tap(page, '#email');
  await page.click('#email', { clickCount: 3 });
  await page.type('#email', email, { delay: 8 });
  await tap(page, '#password');
  await page.type('#password', password, { delay: 8 });
  await tap(page, 'form#login button.primary');
  await page.waitForFunction(() => location.pathname.includes('/app'), { timeout: 45000 });
  await page.waitForSelector('#menu-button', { timeout: 30000 });
}

async function openPage(page, name) {
  const active = await page.evaluate(target => document.getElementById(`${target}-page`)?.classList.contains('active') === true, name);
  if (active) return;
  const menuOpen = await page.evaluate(() => document.querySelector('#sidebar')?.classList.contains('open') === true);
  if (!menuOpen) await tap(page, '#menu-button');
  await tap(page, `.nav-item[data-page="${name}"]`);
  await page.waitForFunction(target => document.getElementById(`${target}-page`)?.classList.contains('active') === true, { timeout: 15000 }, name);
}

async function readState(page) {
  return page.evaluate(async () => {
    const response = await fetch('/api/state', { credentials: 'include', cache: 'no-store' });
    const data = await response.json();
    const pickReport = report => ({
      id: report.id,
      status: report.status,
      dateIso: report.dateIso,
      project: report.project,
      projectId: report.projectId,
      notes: report.notes,
      originalNotes: report.originalNotes,
      next: report.next,
      productionEntries: report.productionEntries,
      extraWork: report.extraWork,
      laborEntries: report.laborEntries,
      scopeFlags: report.scopeFlags,
      history: (report.history || []).map(row => ({ action: row.action, at: row.at })),
      updatedAfterSend: report.updatedAfterSend ? { at: report.updatedAfterSend.at, summary: report.updatedAfterSend.summary } : null
    });
    return {
      status: response.status,
      companyName: data?.company?.name || '',
      projects: (data.projects || []).map(project => ({ id: project.id, name: project.name })),
      reports: (data.reports || []).map(pickReport),
      workdays: (data.workdays || []).map(day => ({ id: day.id, status: day.status, projectId: day.projectId, reportId: day.reportId, startedAt: day.startedAt, endedAt: day.endedAt })),
      timeCards: (data.timeCards || []).map(card => ({ id: card.id, memberId: card.memberId, projectId: card.projectId, reportId: card.reportId, date: card.date, inAt: card.inAt, outAt: card.outAt, status: card.status }))
    };
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = {
  GARBAGE_TRANSCRIPT,
  SENSIBLE_TRANSCRIPT,
  QUIET_TRANSCRIPT,
  FIELD_EMAIL,
  OWNER_EMAIL,
  COMPANY_NAME,
  baseUrl,
  artifactsRoot,
  requirePassword,
  chromePath,
  ensureDir,
  writeJson,
  noteVerdict,
  hoursFromMinutes,
  splitLargestRemainder,
  displayHoursForMinutes,
  elapsedMinutes,
  redactState,
  loginAccount,
  launchBrowser,
  newPhonePage,
  tap,
  shot,
  startVideo,
  loginUi,
  openPage,
  readState,
  sleep
};
