'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright-core');
const seed = require('./staging-seed');
const calendar = require('./payroll-ranges');
const paySchedule = require('./pay-schedule');
const { buildPayrollExport, defaultTemplate } = require('./payroll-export');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-payroll-export-'));
const dbFile = path.join(root, 'db.json');
const password = 'local-payroll-test-only';
seed.ensureStagingDatabase(dbFile, { PDL_STAGING_OWNER_PASSWORD: password, PDL_STAGING_FIELD_PASSWORD: password });
seed.ensureStagingOfficeUser(dbFile, { PDL_STAGING: '1', PDL_STAGING_OFFICE_PASSWORD: password });
const db = JSON.parse(fs.readFileSync(dbFile));
const foremanEmail = 'payroll-test-foreman@example.test';
db.users.push({...db.users.find(user=>user.email===seed.FIELD_EMAIL),id:Math.max(...db.users.map(user=>user.id))+1,email:foremanEmail,role:'foreman'});
const week = calendar.range('week', calendar.today(db.company.timezone), db.company.weekStart);
// Disposable staging seed with approved/unapproved punches; never modifies the live demo.
db.timeCards = [];
for (const start of [week.from, calendar.addDays(week.from, -7), calendar.addDays(week.from, -14)]) for (let day = 0; day < 5; day++) {
  const date = calendar.addDays(start, day), inAt = date + 'T16:00:00Z';
  db.timeCards.push({ id: start + '-' + day, memberId: 1, projectId: day % 2 ? 2 : 1, date, status: 'approved', inAt, outAt: new Date(Date.parse(inAt) + 9 * 3600000).toISOString(), hours: 9 });
}
db.timeCards.push({ id: 'unapproved', memberId: 2, projectId: 1, status: 'submitted', inAt: week.from + 'T16:00:00Z', outAt: week.from + 'T20:00:00Z', hours: 4 });
db.timeCards.push({id:'draft-payroll',memberId:3,projectId:1,status:'draft',inAt:week.from+'T16:00:00Z',outAt:week.from+'T19:00:00Z',hours:3});
const lastWeekDay = calendar.addDays(week.from, -7);
db.timeCards.push({ id: 'unapproved-last', memberId: 2, projectId: 1, status: 'draft', inAt: lastWeekDay + 'T16:00:00Z', outAt: lastWeekDay + 'T20:00:00Z', hours: 4 });
db.timeCards.push({ id: 'unapproved-oct21', memberId: 4, projectId: 1, status: 'draft', inAt: '2026-10-21T15:00:00Z', outAt: '2026-10-21T22:45:00Z', hours: 7.75 });
db.payPeriods=[{id:'previous-payroll',label:'Previous saved period',from:calendar.addDays(week.from,-14),to:calendar.addDays(week.from,-1),timeZone:db.company.timezone,status:'open'}];
fs.writeFileSync(dbFile, JSON.stringify(db));
fs.writeFileSync(path.join(root, 'platform.json'), JSON.stringify({ users: [], sessions: [] }));
Object.assign(process.env, { PDL_DB_FILE: dbFile, PDL_PLATFORM_FILE: path.join(root, 'platform.json'), PDL_REQUIRE_AUTH: '1', PDL_SUPABASE_ENABLED: '0', PDL_TRANSACTIONAL_DB: 'off', PDL_PLATFORM_TRANSACTIONAL_DB: 'off', PDL_EMAIL_DEV_MODE: '1', PDL_STAGING: '0', NODE_ENV: 'test' });
for (const key of ['SENTRY_DSN','RESEND_API_KEY','OPENAI_API_KEY','STRIPE_SECRET_KEY','STRIPE_WEBHOOK_SECRET','DATABASE_URL','INDEXNOW_KEY']) delete process.env[key];
require('./database/supabase').loadLocalEnv = () => {};
const { server } = require('./server');
let browser, base;
const shots = process.env.PDL_PAYROLL_SCREENSHOTS;
async function login(page, email) {
  await page.goto(base + '/login.html'); await page.locator('#email').fill(email); await page.locator('#password').fill(password);
  await page.locator('form#login button.primary').click();
  await page.waitForFunction(() => typeof currentUser !== 'undefined' && currentUser && typeof showPage === 'function');
}
async function assertPayrollEntry(page, allowed, home = 'dashboard') {
  await page.addInitScript(() => {
    window.payrollEntryFrames = [];
    const inspect = () => {
      const shell = document.querySelector('.app-shell');
      const loader = document.querySelector('.workspace-loader');
      if (shell?.checkVisibility({visibilityProperty:true}) && !loader?.checkVisibility({visibilityProperty:true})) {
        window.payrollEntryFrames.push(document.querySelector('.page.active')?.id);
      }
      requestAnimationFrame(inspect);
    };
    requestAnimationFrame(inspect);
  });
  // Make the startup access race repeatable, including a reload with saved role.
  await page.route('**/api/state*', async route => {
    await new Promise(resolve => setTimeout(resolve, 180));
    await route.continue().catch(error => { if (!/already handled|Target.*closed/.test(error.message)) throw error; });
  });
  for (const mode of ['fresh','home-reload','payroll-reload']) {
    if (mode === 'fresh') { await page.goto('about:blank'); await page.goto(base + '/app#payroll'); }
    else { if(mode==='payroll-reload')await page.evaluate(()=>history.replaceState(null,'','#payroll')); await page.reload(); }
    const expected = (allowed ? 'payroll' : home) + '-page';
    await page.waitForFunction(expected => window.pdlWorkspaceStateReady && document.documentElement.classList.contains('workspace-ready') && document.querySelector('.page.active')?.id === expected, expected).catch(async error => {
      console.error('Payroll entry state', await page.evaluate(() => ({hash:location.hash,role:currentRole,ready:window.pdlWorkspaceStateReady,classes:document.documentElement.className,active:document.querySelector('.page.active')?.id})));
      throw error;
    });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const frames = await page.evaluate(() => window.payrollEntryFrames);
    assert(frames.length > 0, 'sampled visible startup frames');
    assert(frames.every(id => id === expected), `${mode}: no previous screen flash: ${JSON.stringify(frames)}`);
    assert.equal(new URL(page.url()).hash, allowed ? '#payroll' : '#'+home);
    if (allowed) await page.waitForFunction(() => !document.querySelector('#payroll-landing [data-payroll-download="csv"]')?.disabled);
  }
  await page.unrouteAll({behavior:'wait'});
  console.log(`Payroll fresh/reload ${allowed?'allowed':'denied'}: correct page without a visible old screen`);
}
function parseCsv(text) {
  const rows = []; let row = [], value = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') { if (quoted && text[i + 1] === '"') { value += '"'; i++; } else quoted = !quoted; }
    else if (c === ',' && !quoted) { row.push(value); value = ''; }
    else if (c === '\n' && !quoted) { row.push(value.replace(/\r$/, '')); rows.push(row); row = []; value = ''; }
    else value += c;
  }
  return rows;
}

async function tap(page, locator) {
  const box = await locator.boundingBox(), viewport = page.viewportSize();
  assert(box && box.x >= 0 && box.x + box.width <= viewport.width + .5 && box.y >= 56 && box.y + box.height <= viewport.height + .5, 'target fully on screen without an uncounted scroll: ' + JSON.stringify(box));
  const hit=await locator.evaluate(el => { const r=el.getBoundingClientRect(), hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2); return {ok:hit===el||el.contains(hit),hit:hit?.outerHTML.slice(0,300),target:el.outerHTML,box:{x:r.x,y:r.y,width:r.width,height:r.height}}; });
  if(!hit.ok&&shots){fs.mkdirSync(shots,{recursive:true});await page.screenshot({path:path.join(shots,'failure.png')})}
  assert(hit.ok, 'target receives the tap: '+JSON.stringify(hit));
  await locator.click();
}
function verifyCsv(text, range) {
  const rows=parseCsv(text), headers=rows.shift(); assert.deepEqual(headers,defaultTemplate.columns);
  assert(headers.includes('from_date')&&headers.includes('to_date')); assert(!headers.includes('week_start'));
  const records=rows.map(row=>Object.fromEntries(headers.map((key,i)=>[key,row[i]])));
  assert(records.every(row=>row.job_name!=='WORKER TOTAL'));
  assert.equal(new Set(records.map(row=>row.worker_id+'|'+row.job_name)).size,records.length,'one worker/job row for the whole range');
  const expected=buildPayrollExport(db,range);
  for(const [column,key] of [['reg_hours','REG'],['ot_hours','OT'],['dt_hours','DT'],['total_hours','total']])assert.equal(Math.round(records.reduce((sum,row)=>sum+Number(row[column]),0)*100),Math.round(expected.totals[key]*100));
  for(const row of records){assert.equal(row.from_date,range.from);assert.equal(row.to_date,range.to)}
  return expected;
}
async function checkComponent(page, root) {
  await page.evaluate(async()=>{await Promise.all(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})))});
  const styles=await root.evaluate(el=>{
    const rgb=s=>s.match(/[\d.]+/g).map(Number), lum=s=>rgb(s).slice(0,3).map(v=>(v/=255)<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((n,v,i)=>n+v*[.2126,.7152,.0722][i],0);
    return { overflow:Math.max(el.scrollWidth-el.clientWidth,document.documentElement.scrollWidth-innerWidth), colors:[...el.querySelectorAll('button,p,h2,th,strong')].filter(e=>e.checkVisibility()).map(e=>{const s=getComputedStyle(e);let p=e;while(p&&rgb(getComputedStyle(p).backgroundColor)[3]===0)p=p.parentElement;const a=lum(s.color),b=lum(getComputedStyle(p).backgroundColor);return{text:e.textContent,ratio:(Math.max(a,b)+.05)/(Math.min(a,b)+.05),height:e.tagName==='BUTTON'?e.getBoundingClientRect().height:48,forbidden:['rgb(219, 219, 219)','rgb(61, 61, 61)','rgb(20, 20, 20)'].some(c=>[s.color,s.backgroundColor,s.borderTopColor].includes(c))}})};
  });
  assert(styles.overflow<=1,JSON.stringify(styles));
  for(const item of styles.colors){assert(item.ratio>=4.5,JSON.stringify(item));assert(item.height>=48,JSON.stringify(item));assert(!item.forbidden,JSON.stringify(item))}
}
async function landingDownload(page, preset) {
  await page.evaluate(()=>{showPage('payroll');window.scrollTo(0,0)});
  await page.evaluate(async()=>{await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));await Promise.all(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})))});
  const root=page.locator('#payroll-landing'); await root.locator('[data-payroll-download="csv"]').waitFor({state:'visible'});
  assert(await page.locator('#payroll-page').evaluate(el=>el.classList.contains('active')),'payroll opens on its own page');
  assert.equal(await root.locator('[data-payroll-range="week"]').getAttribute('aria-pressed'),'true');
  await page.evaluate(()=>{window.payrollTapCount=0}); const started=performance.now();
  let range=calendar.range(preset==='custom'?'week':preset,calendar.today(db.company.timezone),db.company.weekStart);
  if(preset!=='week')await tap(page,root.locator(`[data-payroll-range="${preset}"]`));
  if(preset==='custom'){
    range={from:calendar.addDays(week.from,2),to:calendar.addDays(week.from,4)};
    assert.equal(await root.locator('input[type="date"]').count(),0,'no native date controls');
    for(const date of [range.from,range.to])await tap(page,root.locator(`[data-payroll-day="${date}"]`));
    assert.equal(await root.locator('[data-payroll-day].in-range').count(),3,'selected range highlighted');
  }
  const [download]=await Promise.all([page.waitForEvent('download'),tap(page,root.locator('[data-payroll-download="csv"]'))]);
  assert.equal(download.suggestedFilename(),defaultTemplate.filename(range));
  const expected=verifyCsv(fs.readFileSync(await download.path(),'utf8'),range);
  assert.equal(expected.totals.total,preset==='custom'?27:45);
  const elapsed=performance.now()-started,taps=await page.evaluate(()=>window.payrollTapCount),limit=preset==='week'?2:preset==='last'?2:4,ms=preset==='week'?3000:preset==='last'?4000:8000;
  assert.equal(taps,preset==='week'?1:preset==='last'?2:4);assert(taps<=limit);assert(elapsed<=ms,`${preset}: ${elapsed}ms > ${ms}`);
  console.log(`Landing ${page.viewportSize().width}px ${preset}: ${taps} real taps, ${Math.round(elapsed)}ms, ${expected.totals.total} approved hours`);
  await checkComponent(page,root);
}
async function settle(page) {
  await page.evaluate(async () => { await Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))); });
}
async function scrollOffset(page) {
  return page.evaluate(() => {
    const nodes = [document.scrollingElement, document.querySelector('main'), document.querySelector('#settings-page'), document.querySelector('#company-pay-periods'), document.querySelector('.pay-schedule')];
    return Math.max(window.scrollY, document.documentElement.scrollTop, document.body.scrollTop, ...nodes.filter(Boolean).map(el => el.scrollTop || 0));
  });
}
async function tapInPlace(page, locator) {
  const before = await scrollOffset(page);
  const savesSchedule = await locator.getAttribute('data-pay-schedule-save') !== null;
  await tap(page, locator);
  // A successful save removes the button and can clamp the shorter page's scroll offset.
  if (savesSchedule) {
    await page.locator('[data-pay-schedule-status]').filter({hasText:'saved'}).waitFor();
    await locator.waitFor({state:'hidden'});
    return;
  }
  const maxScroll = await page.evaluate(() => {
    const nodes = [document.scrollingElement, document.querySelector('main'), document.querySelector('#settings-page'), document.querySelector('#company-pay-periods'), document.querySelector('.pay-schedule')];
    return Math.max(0, ...nodes.filter(Boolean).map(el => el.scrollHeight - el.clientHeight));
  });
  assert.equal(await scrollOffset(page), Math.min(before, maxScroll), 'tap did not scroll beyond natural page-height clamping');
}
async function showSchedule(page) {
  await page.evaluate(() => { showPage('payroll'); window.scrollTo(0, 0); });
  await page.locator('#pay-schedule-form').waitFor();
  const size = page.viewportSize();
  const box = await page.locator('#pay-schedule-form').boundingBox();
  if (size.width <= 420 || !box || box.y < 56 || box.y + box.height > size.height) {
    await page.locator('#pay-schedule-form').evaluate(el => {
      el.scrollIntoView({block:'start', inline:'nearest'});
      const scroller = document.scrollingElement || document.documentElement;
      const top = el.getBoundingClientRect().top;
      if (top < 56) scroller.scrollTop -= 56 - top;
    });
  }
  await settle(page);
}
async function typeKept(page, selector, text) {
  const locator = page.locator(selector);
  await locator.click();
  await locator.evaluate(el => { el.focus(); el.select(); });
  await page.keyboard.type(text, { delay: 20 });
  const state = await page.evaluate(sel => { const el = document.querySelector(sel); return { value: el ? el.value : '', focused: document.activeElement === el }; }, selector);
  assert.equal(state.value, text, selector);
  assert.equal(state.focused, true, selector + ' keeps focus');
}
async function assertScheduleClear(page) {
  // Readable labels make the schedule taller than the export card. Inspect it
  // after bringing the schedule into view; the export speed path never scrolls.
  if (page.viewportSize().width <= 420) await page.locator('#pay-schedule-form').evaluate(el => {
    el.scrollIntoView({block:'start'});
    const scroller=document.scrollingElement||document.documentElement;
    const top=el.getBoundingClientRect().top;
    if(top<56)scroller.scrollTop-=56-top;
  });
  const rows = await page.evaluate(() => {
    const save = document.querySelector('[data-pay-schedule-save]');
    const shown = save && !save.hidden && getComputedStyle(save).display !== 'none';
    const saveRect = shown ? save.getBoundingClientRect() : null;
    return [...document.querySelectorAll('#pay-schedule-form button, #pay-schedule-form p, #pay-schedule-form label, #pay-schedule-form input')].filter(el => !el.hidden && getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden').map(el => {
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      const overlaps = !!saveRect && el !== save && r.bottom > saveRect.top + 0.5 && r.top < saveRect.bottom - 0.5 && r.right > saveRect.left + 0.5 && r.left < saveRect.right - 0.5;
      return { text: el.textContent.trim().slice(0, 90), tag: el.tagName, top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height), width: Math.round(r.width), inView: r.top >= 56 && r.bottom <= innerHeight + 0.5 && r.left >= -0.5 && r.right <= innerWidth + 0.5, hit: hit === el || !!el.contains(hit), overlaps, save: el.hasAttribute('data-pay-schedule-save'), hitText: hit ? hit.outerHTML.slice(0, 160) : null };
    });
  });
  assert(rows.length > 0, 'schedule controls are on screen');
  for (const row of rows) {
    assert(row.inView && row.hit && !row.overlaps, JSON.stringify(row));
    if (row.tag === 'BUTTON') assert(row.height >= 48 && row.width >= 48, JSON.stringify(row));
  }
}
async function assertChipsHit(page, root) {
  await settle(page);
  const chips = root.locator('[data-payroll-range]');
  assert.equal(await chips.count(), 6);
  for (let i = 0; i < 6; i++) {
    const info = await chips.nth(i).evaluate(el => {
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return { text: el.textContent.trim(), top: r.top, bottom: r.bottom, height: r.height, innerHeight, hit: hit === el || !!el.contains(hit), hitText: hit ? hit.outerHTML.slice(0, 140) : null };
    });
    assert(info.height >= 48, JSON.stringify(info));
    assert(info.top >= -0.5 && info.bottom <= info.innerHeight + 0.5 && info.hit, JSON.stringify(info));
  }
}
async function assertStickyFooter(page, root) {
  await settle(page);
  const line = root.locator('[data-payroll-bar-review]');
  const csv = root.locator('[data-payroll-download="csv"]');
  for (const locator of [line, csv]) {
    const info = await locator.evaluate(el => {
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height, innerHeight, innerWidth, hit: hit === el || !!el.contains(hit), hitText: hit ? hit.outerHTML.slice(0, 160) : null };
    });
    assert(info.top >= -0.5 && info.bottom <= info.innerHeight + 0.5 && info.left >= -0.5 && info.right <= info.innerWidth + 0.5, 'fully inside the viewport: ' + JSON.stringify(info));
    assert(info.hit, 'elementFromPoint hits the control: ' + JSON.stringify(info));
    assert(info.height >= 48, JSON.stringify(info));
  }
  const text = (await root.innerText()).replace(/\s+/g, ' ');
  assert.equal((text.match(/not approved/g) || []).length, 1, text);
  assert.match(text, /\d+ punch(?:es)? not approved · Review/);
  assert.equal(await root.locator('[data-payroll-warning]').count(), 0);
}
async function showMonth(root, ym) {
  for (let i = 0; i < 36; i++) {
    const current = await root.locator('[data-payroll-day]:not(.adjacent-month)').first().getAttribute('data-payroll-day');
    if (current.slice(0, 7) === ym) return;
    await root.locator(`[data-month="${current.slice(0, 7) > ym ? '-1' : '1'}"]`).click();
  }
  throw new Error('could not open ' + ym);
}
async function assertCustomUnapprovedNotice(page, root) {
  const first = calendar.addDays(week.from, 1), second = week.from;
  await settle(page);
  await tap(page, root.locator('[data-payroll-range="custom"]'));
  assert.equal(await root.locator('.payroll-calendar').isVisible(), true, 'custom calendar is open');
  await tap(page, root.locator(`[data-payroll-day="${first}"]`));
  assert.equal(await root.locator('[data-payroll-bar-review]').isVisible(), false, 'review line waits until the range is complete');
  await tap(page, root.locator(`[data-payroll-day="${second}"]`));
  const bar = root.locator('[data-payroll-bar-review]');
  assert.match((await bar.innerText()).replace(/\s+/g, ' '), /^2 punches not approved · Review$/);
  assert.equal(await root.locator('[data-payroll-warning]').count(), 0);
  await assertStickyFooter(page, root);
  await checkComponent(page, root);
}
async function main() {
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base='http://127.0.0.1:'+server.address().port;
  try{
    browser=await chromium.launch({executablePath:process.env.PDL_TEST_CHROME||(process.platform==='win32'?'C:/Program Files/Google/Chrome/Application/chrome.exe':'/usr/bin/google-chrome-stable'),headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
    const context=await browser.newContext({acceptDownloads:true}),page=await context.newPage();
    await page.addInitScript(()=>{localStorage.setItem('pdl-analytics-consent','declined');document.addEventListener('click',e=>{if(e.isTrusted)window.payrollTapCount=(window.payrollTapCount||0)+1},true)});
    const errors=[];page.on('pageerror',e=>errors.push(e.message));await login(page,seed.OFFICE_EMAIL);
    await page.waitForFunction(()=>!document.querySelector('#payroll-landing [data-payroll-download="csv"]')?.disabled);
    assert(await page.locator('#dashboard-page').evaluate(el=>el.classList.contains('active')),'sign-in lands on dashboard');
    assert.equal(await page.locator('#dashboard-page .payroll-component, #dashboard-page #payroll-landing, #dashboard-page .pay-schedule').count(),0,'overview has no payroll markup');
    await page.setViewportSize({width:390,height:844});
    await page.reload();
    await page.waitForFunction(()=>typeof showPage==='function'&&document.querySelector('#dashboard-page')?.classList.contains('active')&&document.querySelector('#payroll-phone-bar:not([hidden]) button'));
    await page.waitForFunction(()=>!document.querySelector('#toast')?.classList.contains('visible'));
    const payrollSpeed=[];
    for (const height of [844,667]) for (const theme of ['light','dark']) {
      await page.setViewportSize({width:390,height});
      await settle(page);
      await page.evaluate(theme=>{document.documentElement.dataset.theme=theme;showPage('dashboard');window.scrollTo(0,0);window.payrollTapCount=0},theme);
      await page.waitForFunction(()=>!document.querySelector('#payroll-phone-bar')?.hidden&&!document.querySelector('#toast')?.classList.contains('visible'));
      await settle(page);
      const barStyle=await page.locator('#payroll-phone-bar button').evaluate(el=>{const s=getComputedStyle(el),r=el.getBoundingClientRect();return{bg:s.backgroundColor,color:s.color,h:r.height}});
      assert.deepEqual(barStyle,{bg:'rgb(255, 102, 0)',color:'rgb(0, 0, 0)',h:48});
      await page.evaluate(() => {
        window.payrollFrames = []; window.trackPayrollFrames = true;
        document.querySelector('#payroll-phone-bar button').addEventListener('click', () => {
          const sample = () => {
            window.payrollFrames.push([...document.querySelectorAll('.page.active')].map(el => el.id));
            if (window.trackPayrollFrames) requestAnimationFrame(sample);
          };
          requestAnimationFrame(sample);
        }, { once: true });
      });
      const started=performance.now();
      await tapInPlace(page,page.locator('#payroll-phone-bar button'));
      await page.locator('#payroll-page.active').waitFor();
      assert(await page.locator('#payroll-page .page-heading h1').isVisible(), 'Payroll heading stays visible');
      for (const label of ['Period ends', 'Time cards due', 'Payday']) assert(await page.locator('.pay-schedule-legend').filter({hasText:new RegExp(`^${label}$`)}).isVisible(), `${label} stays visible`);
      assert(await page.locator('.pay-schedule-preview-title').isVisible());
      const previewType = await page.locator('.pay-schedule-preview p, .pay-schedule-preview span').evaluateAll(els => els.map(el => { const s=getComputedStyle(el); return {size:parseFloat(s.fontSize),line:parseFloat(s.lineHeight)}; }));
      assert(previewType.length && previewType.every(s=>s.size>=12&&s.line>=s.size*1.2-.01), JSON.stringify(previewType));
      await page.evaluate(()=>window.scrollTo(0,0));
      await tapInPlace(page,page.locator('#payroll-landing [data-payroll-range="last"]'));
      const [speedDownload]=await Promise.all([page.waitForEvent('download'),tapInPlace(page,page.locator('#payroll-landing [data-payroll-download="csv"]'))]);
      assert.equal(speedDownload.suggestedFilename().endsWith('.csv'),true);
      const speedTaps=await page.evaluate(()=>window.payrollTapCount),speedElapsed=performance.now()-started;
      assert(speedTaps<=3,`payroll ${height} ${theme} took ${speedTaps} taps`);
      assert(speedElapsed<4000,`${speedElapsed}ms`);
      const frames = await page.evaluate(() => { window.trackPayrollFrames = false; return window.payrollFrames; });
      assert(frames.length > 0 && frames.every(ids => ids.length === 1 && ids[0] === 'payroll-page'), `no old page flashes: ${JSON.stringify(frames)}`);
      assert.equal(await scrollOffset(page),0);
      payrollSpeed.push({height,theme,taps:speedTaps,ms:Math.round(speedElapsed)});
      console.log(`Payroll page 390x${height} ${theme}: ${speedTaps} taps, ${Math.round(speedElapsed)}ms`);
    }
    console.log('Payroll phone taps '+JSON.stringify(payrollSpeed));
    const route='/api/payroll/export?'+new URLSearchParams({...week,format:'csv'});
    const response=await context.request.get(base+route);assert.equal(response.status(),200);assert.equal(response.headers()['cache-control'],'private, no-store');verifyCsv(await response.text(),week);
    assert.equal((await fetch(base+route)).status,401,'anonymous gets 401');
    for(const query of ['from=bad&to=2026-10-25&format=csv',`from=${week.from}&to=${week.to}&format=x`])assert.equal((await context.request.get(base+'/api/payroll/export?'+query)).status(),400);
    assert.equal((await context.request.post(base+'/api/payroll/export')).status(),405);
    for (const size of [{width:390,height:500},{width:390,height:844},{width:768,height:844},{width:1280,height:800}]) for (const theme of ['light','dark']) {
      await page.setViewportSize(size);await page.evaluate(theme=>{document.documentElement.dataset.theme=theme},theme);await page.evaluate(()=>document.fonts.ready);
      for (const preset of ['week','last','custom']) {
        await landingDownload(page,preset);
        if(shots){fs.mkdirSync(shots,{recursive:true});await page.screenshot({path:path.join(shots,`landing-${preset}-${theme}-${size.width}x${size.height}.png`)})}
      }
    }
    const root=page.locator('#payroll-landing');await page.evaluate(()=>showPage('payroll'));
    for(const [preset,range] of [['last2',calendar.range('last2',calendar.today(db.company.timezone))],['period',db.payPeriods[0]],['month',calendar.range('month',calendar.today(db.company.timezone))]]){
      await root.locator(`[data-payroll-range="${preset}"]`).click();const [file]=await Promise.all([page.waitForEvent('download'),root.locator('[data-payroll-download="csv"]').click()]);verifyCsv(fs.readFileSync(await file.path(),'utf8'),{from:range.from,to:range.to});
    }
    await root.locator('[data-payroll-range="custom"]').click();
    const focused=root.locator('[data-payroll-day][tabindex="0"]');const original=await focused.getAttribute('data-payroll-day');await focused.focus();await focused.press('ArrowRight');
    assert.equal(await page.evaluate(()=>document.activeElement.dataset.payrollDay),calendar.addDays(original,1));
    await page.keyboard.press('Enter');await page.keyboard.press('ArrowRight');await page.keyboard.press('Space');
    assert.equal(await root.locator('[data-payroll-day].in-range').count(),2,'keyboard selects range');
    await root.locator('[data-month="1"]').click();const monthLabel=await root.locator('[data-month-label]').textContent();assert(monthLabel);
    const emptyDays=await root.locator('[data-payroll-day]').evaluateAll(els=>els.filter(el=>!el.classList.contains('adjacent-month')).slice(10,12).map(el=>el.dataset.payrollDay));
    for(const day of emptyDays)await root.locator(`[data-payroll-day="${day}"]`).click();
    assert(await root.locator('[data-payroll-empty]').isVisible());assert(await root.locator('[data-payroll-download="csv"]').isDisabled());
    await page.evaluate(()=>showPage('payroll'));
    assert.match((await root.locator('[data-payroll-bar-review]').innerText()).replace(/\s+/g,' '),/^2 punches not approved · Review$/);
    await assertStickyFooter(page, root);
    await root.locator('[data-payroll-bar-review]').click();assert.equal(await page.locator('#timecard-status').inputValue(),'unapproved');
    const unapproved=await page.evaluate(()=>filteredTimeCards().map(c=>c.status).sort());assert.deepEqual(unapproved,['draft','submitted']);
    await page.locator('#pay-period-panel [data-payroll-export-open]').click();
    const modal=page.locator('#payroll-dialog-content');assert.equal(await modal.locator('[data-payroll-range]').count(),6);
    await checkComponent(page,modal);
    assert.equal(await page.locator('#payroll-export-dialog').evaluate(el=>getComputedStyle(el).borderTopColor),'rgb(110, 110, 110)');
    const [pdf]=await Promise.all([page.waitForEvent('download'),modal.locator('[data-payroll-download="pdf"]').click()]);const bytes=fs.readFileSync(await pdf.path());assert.equal(bytes.subarray(0,5).toString(),'%PDF-');assert.equal((bytes.toString('latin1').match(/\/Type \/Page\b/g)||[]).length,1);
    if(shots)fs.copyFileSync(await pdf.path(),path.join(shots,'payroll-summary.pdf'));
    await modal.locator('[data-payroll-range="custom"]').click();for(let i=0;i<2;i++)await modal.locator('[data-month="1"]').click();const days=await modal.locator('[data-payroll-day]').evaluateAll(els=>els.slice(10,12).map(el=>el.dataset.payrollDay));for(const day of days)await modal.locator(`[data-payroll-day="${day}"]`).click();assert(await modal.locator('[data-payroll-empty]').isVisible());assert(await modal.locator('[data-payroll-download="csv"]').isDisabled());
    await page.locator('[data-payroll-close]').click();
    for (const width of [390, 1280]) for (const theme of ['light', 'dark']) {
      await page.setViewportSize({width, height: width === 1280 ? 800 : 844});
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
      await page.evaluate(() => { showPage('payroll'); window.scrollTo(0, 0); });
      await page.locator('#payroll-landing [data-payroll-download="csv"]').waitFor({state:'visible'});
      await assertCustomUnapprovedNotice(page, page.locator('#payroll-landing'));
      await page.evaluate(() => showPage('timecards'));
      await page.locator('#pay-period-panel [data-payroll-export-open]').click();
      await assertCustomUnapprovedNotice(page, page.locator('#payroll-dialog-content'));
      await page.locator('[data-payroll-close]').click();
    }
    for (const viewport of [{width:390,height:500},{width:390,height:844},{width:1280,height:800}]) {
      await page.setViewportSize(viewport);
      await page.evaluate(() => { document.documentElement.dataset.theme='light'; showPage('payroll'); window.scrollTo(0,0); });
      const landing = page.locator('#payroll-landing');
      await assertChipsHit(page, landing);
      await landing.locator('[data-payroll-range="last"]').click();
      if (viewport.height > 560) await page.evaluate(() => window.scrollTo(0,0));
      await assertChipsHit(page, landing);
      await assertStickyFooter(page, landing);
      await landing.locator('[data-payroll-range="custom"]').click();
      await showMonth(landing, '2026-10');
      await landing.locator('[data-payroll-day="2026-10-21"]').click();
      await landing.locator('[data-payroll-day="2026-10-23"]').click();
      await page.evaluate(() => window.scrollTo(0,0));
      await assertStickyFooter(page, landing);
      assert.equal(await landing.locator('.payroll-calendar').isVisible(), true);
      if (viewport.height === 500 && viewport.width === 390) {
        await landing.locator('[data-payroll-bar-review]').click();
        assert.equal(await page.locator('#timecard-status').inputValue(), 'unapproved');
        assert.equal(await page.locator('#timecard-from').inputValue(), '2026-10-21');
        assert.equal(await page.locator('#timecard-to').inputValue(), '2026-10-23');
      } else await page.evaluate(() => showPage('timecards'));
      await page.locator('#pay-period-panel [data-payroll-export-open]').click();
      const dialog = page.locator('#payroll-dialog-content');
      await assertChipsHit(page, dialog);
      await dialog.locator('[data-payroll-range="last"]').click();
      await assertChipsHit(page, dialog);
      await assertStickyFooter(page, dialog);
      await dialog.locator('[data-payroll-range="custom"]').click();
      await showMonth(dialog, '2026-10');
      await dialog.locator('[data-payroll-day="2026-10-21"]').click();
      await dialog.locator('[data-payroll-day="2026-10-23"]').click();
      await assertStickyFooter(page, dialog);
      assert.equal(await dialog.locator('.payroll-calendar').isVisible(), true);
      await page.locator('[data-payroll-close]').click();
    }
    await page.setViewportSize({width:390,height:844});await page.evaluate(()=>window.PDLCompanySettings.openPayPeriods());await page.locator('#payroll-overtime-form').waitFor({state:'visible'});
    const spacing=await page.locator('#company-pay-periods').evaluate(el=>{const a=el.querySelector('[data-payroll-export-open]').getBoundingClientRect(),b=el.querySelector('[data-pay-new]').getBoundingClientRect();return{gap:b.y>=a.bottom?b.y-a.bottom:b.x-a.right,height:a.height,newHeight:b.height}});assert(spacing.gap>=8&&spacing.height>=48&&spacing.newHeight>=48,JSON.stringify(spacing));
    for(const theme of ['light','dark']){await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);const inline=await page.locator('.payroll-rule-hours').evaluateAll(labels=>labels.map(label=>{const parts=[...label.children].map(el=>el.getBoundingClientRect()),input=label.querySelector('input').getBoundingClientRect();return{top:Math.max(...parts.map(r=>r.top)),bottom:Math.min(...parts.map(r=>r.bottom)),right:Math.max(...parts.map(r=>r.right)),boxRight:label.getBoundingClientRect().right,width:input.width,height:input.height,gap:parseFloat(getComputedStyle(label.parentElement).columnGap)}}));for(const line of inline){assert(line.top<line.bottom&&line.right<=line.boxRight+.5,JSON.stringify(line));assert.equal(line.width,48);assert.equal(line.height,48);assert(line.gap>=4)}}
    assert.doesNotMatch(await page.locator('#company-pay-periods').textContent(), /when the schedule is off/);
    await require('./pay-schedule-ui-regression.test')(page, showSchedule);
    const scheduleCounts=[];
    for (const height of [844, 667]) for (const theme of ['light', 'dark']) {
      await page.setViewportSize({width:390,height});
      await settle(page);
      await page.evaluate(async theme=>{
        document.documentElement.dataset.theme=theme;
        company=await api('/api/company',{method:'PATCH',body:JSON.stringify({payroll:{pay_schedule:{frequency:null}}})});
        window.PDLCompanySettings.openPayPeriods();
      },theme);
      const periodTab=await page.locator('#settings-tab-periods').evaluate(el=>({bg:getComputedStyle(el).backgroundColor,color:getComputedStyle(el).color}));
      assert.deepEqual(periodTab,theme==='dark'?{bg:'rgb(255, 255, 255)',color:'rgb(0, 0, 0)'}:{bg:'rgb(0, 0, 0)',color:'rgb(255, 255, 255)'});
      await showSchedule(page);
      const defaultEnd='0', defaultDue='1';
      await page.waitForFunction(()=>document.querySelector('[data-pay-frequency="weekly"]')?.getAttribute('aria-pressed')==='true'&&document.querySelector('[data-pay-schedule-save]')&&!document.querySelector('[data-pay-schedule-save]').hidden);
      assert.equal(await page.locator(`[data-end-weekday="${defaultEnd}"]`).getAttribute('aria-pressed'),'true');
      assert.equal(await page.locator(`[data-due-weekday="${defaultDue}"]`).getAttribute('aria-pressed'),'true');
      assert.equal(await page.locator('[data-pay-weekday="5"]').getAttribute('aria-pressed'),'true');
      assert.match(await page.locator('.pay-schedule-preview-title').evaluate(el=>el.textContent),/Next pay periods/);
      await page.evaluate(()=>{window.payrollTapCount=0});
      await assertScheduleClear(page);
      const scheduleStarted=performance.now();
      const bar=await page.locator('[data-pay-schedule-save]').evaluate(el=>({position:getComputedStyle(el).position,bottom:getComputedStyle(el).bottom,h:el.getBoundingClientRect().height}));
      assert.deepEqual(bar,{position:'sticky',bottom:'0px',h:48});
      await tapInPlace(page,page.locator('[data-pay-schedule-save]'));
      await page.locator('[data-pay-schedule-status]').filter({hasText:'saved'}).waitFor();
      assert.equal(await page.locator('[data-pay-schedule-status]').evaluate(el=>getComputedStyle(el).borderLeftWidth),'0px');
      await page.locator('[data-pay-schedule-save]').waitFor({state:'hidden'});
      const scheduleTaps=await page.evaluate(()=>window.payrollTapCount),scheduleElapsed=performance.now()-scheduleStarted;
      assert(scheduleTaps<=3,`weekly setup at 390x${height} ${theme} took ${scheduleTaps} taps`);
      assert(scheduleElapsed<5000,`${height} ${theme}: ${scheduleElapsed}ms`);
      console.log(`Weekly default 390x${height} ${theme}: ${scheduleTaps} taps, ${Math.round(scheduleElapsed)}ms`);
      await page.evaluate(()=>{window.payrollTapCount=0});
      await tapInPlace(page,page.locator('[data-pay-frequency="biweekly"]'));
      await tapInPlace(page,page.locator('[data-anchor]').first());
      assert.equal(await page.evaluate(()=>window.payrollTapCount),2);
      await assertScheduleClear(page);
      console.log(`Every 2 weeks plus anchor 390x${height} ${theme}: 2 taps`);
      scheduleCounts.push({height,theme,weekly:scheduleTaps,biweekly:2,ms:Math.round(scheduleElapsed)});
    }
    console.log('Pay schedule phone taps '+JSON.stringify(scheduleCounts));
    await page.setViewportSize({width:1280,height:800});
    await settle(page);
    await page.evaluate(async()=>{
      document.documentElement.dataset.theme='light';
      company=await api('/api/company',{method:'PATCH',body:JSON.stringify({payroll:{pay_schedule:{frequency:null}}})});
    });
    await showSchedule(page);
    const desktopEnd='0', desktopDue='1';
    await page.waitForFunction(()=>document.querySelector('[data-pay-frequency="weekly"]')?.getAttribute('aria-pressed')==='true'&&!document.querySelector('[data-pay-schedule-save]')?.hidden);
    await page.evaluate(()=>{window.payrollTapCount=0});
    assert.equal(await page.locator('#settings-tab-company').evaluate(el=>getComputedStyle(el).borderTopColor),'rgb(110, 110, 110)');
    assert.equal(await page.locator(`[data-end-weekday="${desktopEnd}"]`).getAttribute('aria-pressed'),'true');
    assert.equal(await page.locator(`[data-due-weekday="${desktopDue}"]`).getAttribute('aria-pressed'),'true');
    assert.equal(await page.locator('[data-pay-weekday="5"]').getAttribute('aria-pressed'),'true');
    assert.match(await page.locator('.pay-schedule-preview-title').evaluate(el=>el.textContent),/Next pay periods/);
    await assertScheduleClear(page);
    const desktopSave=await page.locator('[data-pay-schedule-save]').evaluate(el=>({position:getComputedStyle(el).position,h:el.getBoundingClientRect().height}));
    assert.deepEqual(desktopSave,{position:'static',h:48});
    await tapInPlace(page,page.locator('[data-pay-schedule-save]'));
    await page.locator('[data-pay-schedule-status]').filter({hasText:'saved'}).waitFor();
    assert(await page.evaluate(()=>window.payrollTapCount)<=3,'desktop default setup stays within 3 taps');
    const kept=async()=>{
      assert.equal(await page.locator(`[data-end-weekday="${desktopEnd}"]`).getAttribute('aria-pressed'),'true');
      assert.equal(await page.locator(`[data-due-weekday="${desktopDue}"]`).getAttribute('aria-pressed'),'true');
      assert.equal(await page.locator('[data-pay-weekday="5"]').getAttribute('aria-pressed'),'true');
    };
    await tapInPlace(page,page.locator('[data-pay-frequency="biweekly"]'));
    await kept();
    assert.equal(await page.getByRole('group', {name:'Your last payroll end date'}).count(),1);
    await tapInPlace(page,page.locator('[data-pay-frequency="weekly"]'));
    await kept();
    console.log('Desktop 1280x800 weekly default stays within 3 taps and keeps due and payday across Weekly > Every 2 weeks > Weekly');
    await tapInPlace(page,page.locator('[data-end-weekday="4"]'));
    assert.equal(await page.locator(`[data-due-weekday="${desktopDue}"]`).getAttribute('aria-pressed'),'true','end Thursday keeps the due weekday');
    assert.equal(await page.locator('[data-pay-weekday="5"]').getAttribute('aria-pressed'),'true','end Thursday keeps paid Friday');
    await tapInPlace(page,page.locator(`[data-due-weekday="${desktopDue}"]`));
    assert.equal(await page.locator(`[data-due-weekday="${desktopDue}"]`).getAttribute('aria-pressed'),'false');
    const clearedPreview=await page.locator('.pay-schedule-preview').innerText();
    assert.doesNotMatch(clearedPreview,/cards due/);
    assert.match(clearedPreview,/paid/);
    console.log('End Thursday keeps the due weekday and paid Friday; tapping due again clears it');
    await tapInPlace(page,page.locator(`[data-due-weekday="${desktopDue}"]`));
    await page.evaluate(()=>window.scrollTo(0,0));
    await tapInPlace(page,page.locator('[data-pay-frequency="biweekly"]'));
    await tapInPlace(page,page.locator('[data-anchor]').first());
    assert.equal(await scrollOffset(page),0,'biweekly anchor stays at the top of the payroll page');
    const desktopFit=await page.evaluate(()=>{
      const save=document.querySelector('[data-pay-schedule-save]').getBoundingClientRect();
      const lines=[...document.querySelectorAll('.pay-schedule-preview-range, .pay-schedule-preview-pay')].map(el=>{const r=el.getBoundingClientRect();return{text:el.textContent.trim(),top:r.top,bottom:r.bottom,overflow:el.scrollWidth-el.clientWidth}});
      const orange=[...document.querySelectorAll('button')].filter(el=>!el.hasAttribute('data-pay-schedule-save')&&!el.hidden&&getComputedStyle(el).display!=='none'&&getComputedStyle(el).backgroundColor==='rgb(255, 102, 0)');
      let gap=null;
      for (const el of orange) {
        const r=el.getBoundingClientRect();
        const vertical=r.bottom<=save.top?save.top-r.bottom:r.top>=save.bottom?r.top-save.bottom:0;
        const horizontal=r.right<=save.left?save.left-r.right:r.left>=save.right?r.left-save.right:0;
        const distance=vertical&&horizontal?Math.hypot(vertical,horizontal):vertical||horizontal;
        if (gap==null||distance<gap) gap=distance;
      }
      return {saveTop:save.top,saveBottom:save.bottom,saveHeight:save.height,lines,gap};
    });
    assert.equal(desktopFit.lines.length,6,'each of the next 3 periods has a range line and a cards/paid line');
    assert(desktopFit.saveTop>=56&&desktopFit.saveBottom<=800&&desktopFit.saveHeight>=48,JSON.stringify(desktopFit));
    for (const line of desktopFit.lines) assert(line.bottom<=800&&line.top>=56,JSON.stringify(desktopFit));
    assert(desktopFit.gap>=16,`orange controls need 16px, gap was ${desktopFit.gap}`);
    console.log(`Desktop biweekly anchor fits: save y=${Math.round(desktopFit.saveTop)}-${Math.round(desktopFit.saveBottom)}, nearest orange gap ${Math.round(desktopFit.gap)}px`);
    await page.setViewportSize({width:390,height:667});
    await settle(page);
    await page.evaluate(()=>{document.documentElement.dataset.theme='dark'});
    await showSchedule(page);
    await tapInPlace(page,page.locator('[data-pay-frequency="semimonthly"]'));
    await assertScheduleClear(page);
    const darkColors=await page.evaluate(()=>{
      const style=sel=>{const el=document.querySelector(sel);const s=getComputedStyle(el);return{color:s.color,bg:s.backgroundColor,border:s.borderTopColor}};
      return{label:style('#pay-schedule-form > p'),preview:style('.pay-schedule-preview p'),input:style('.pay-schedule input[type="number"]'),tab:getComputedStyle(document.querySelector('#settings-tab-company')).borderTopColor};
    });
    assert.equal(darkColors.label.color,'rgb(255, 255, 255)');
    assert.equal(darkColors.preview.color,'rgb(255, 255, 255)');
    assert.deepEqual(darkColors.input,{color:'rgb(255, 255, 255)',bg:'rgb(0, 0, 0)',border:'rgb(110, 110, 110)'});
    assert.equal(darkColors.tab,'rgb(110, 110, 110)');
    assert.equal(await page.locator('[data-offset="cards_due_offset_days"]').inputValue(),'');
    assert.equal(await page.locator('[data-offset="payday_offset_days"]').inputValue(),'');
    const offsetCopy=await page.locator('.pay-schedule-offsets').innerText();
    assert.match(offsetCopy,/Time cards due:[\s\S]*days after the period ends/);
    assert.match(offsetCopy,/Payday:[\s\S]*days after the period ends/);
    await typeKept(page,'[data-end-index="0"]','15');
    await typeKept(page,'[data-offset="cards_due_offset_days"]','12');
    await typeKept(page,'[data-offset="payday_offset_days"]','10');
    const secondDay=page.locator('[data-end-index="1"]');
    assert.equal(await secondDay.getAttribute('aria-disabled'),'true');
    assert.equal(await secondDay.inputValue(),'');
    assert.equal(await secondDay.evaluate(el=>getComputedStyle(el).borderTopColor),'rgb(110, 110, 110)');
    const narrowPreview=await page.locator('.pay-schedule-preview-period').evaluateAll(els=>els.map(el=>{const range=el.querySelector('.pay-schedule-preview-range'),pay=el.querySelector('.pay-schedule-preview-pay');return{range:range.textContent,pay:pay?.textContent||'',rangeTop:range.getBoundingClientRect().top,payTop:pay?pay.getBoundingClientRect().top:0,rangeOverflow:range.scrollWidth-range.clientWidth,payOverflow:pay?pay.scrollWidth-pay.clientWidth:0}}));
    assert.equal(narrowPreview.length,3);
    for (const line of narrowPreview) { assert(line.payTop>line.rangeTop,JSON.stringify(line)); assert(line.rangeOverflow<=1&&line.payOverflow<=1,JSON.stringify(line)); assert.match(line.range,/–/); assert.match(line.pay,/cards due .+/); assert.match(line.pay,/paid .+/); }
    await tapInPlace(page,page.locator('[data-end-last="0"]'));
    const firstDay=page.locator('[data-end-index="0"]');
    assert.equal(await firstDay.getAttribute('aria-disabled'),'true');
    assert.equal(await firstDay.inputValue(),'');
    assert.equal(await firstDay.evaluate(el=>getComputedStyle(el).borderTopColor),'rgb(110, 110, 110)');
    await page.locator('[data-pay-frequency="monthly"]').click();
    await typeKept(page,'[data-offset="cards_due_offset_days"]','11');
    await typeKept(page,'[data-offset="payday_offset_days"]','16');
    const monthEnd=page.locator('[data-month-end]');
    if (await monthEnd.getAttribute('aria-disabled') !== 'true') await typeKept(page,'[data-month-end]','21');
    console.log('Twice a month and Monthly keep each typed number and its focus at 390x667');
    assert.equal((await context.request.patch(base+'/api/company',{data:{payroll:{pay_schedule:{frequency:'weekly'}}},headers:{'X-PDL-Company':seed.COMPANY_ID}})).status(),400);
    assert.equal((await context.request.patch(base+'/api/company',{data:{payroll:{pay_schedule:{frequency:'weekly',period_end_weekday:2,cards_due_offset_days:1}}},headers:{'X-PDL-Company':seed.COMPANY_ID}})).status(),400);
    assert.equal((await context.request.patch(base+'/api/company',{data:{payroll:{pay_schedule:{frequency:'monthly',monthly_end_day:'last',payday_weekday:5}}},headers:{'X-PDL-Company':seed.COMPANY_ID}})).status(),400);
    const scheduleToday=calendar.today('America/Los_Angeles');
    const expectedPeriod=paySchedule.lastEndedBefore(paySchedule.suggestedWeekly(db.company.weekStart),scheduleToday);
    await page.evaluate(()=>showPage('payroll'));
    await page.locator('#payroll-landing [data-payroll-range="period"]').click();
    assert.equal(await page.locator('#payroll-landing [data-payroll-range-label]').innerText(),calendar.label(expectedPeriod.start,expectedPeriod.end,scheduleToday.slice(0,4)));
    const noaccessId=db.users.find(user=>user.email===seed.OFFICE_NOACCESS_EMAIL).id;
    const denied=await browser.newContext(),deniedPage=await denied.newPage();await login(deniedPage,seed.OFFICE_NOACCESS_EMAIL);await deniedPage.waitForFunction(()=>document.querySelector('#dashboard-page')?.classList.contains('active'));
    assert.equal(await deniedPage.locator('#payroll-nav').isHidden(),true,'office without payroll has no nav item');
    assert.equal(await deniedPage.locator('#payroll-phone-bar').isHidden(),true);
    await deniedPage.evaluate(()=>showPage('payroll'));
    assert.equal(await deniedPage.locator('#dashboard-page').evaluate(el=>el.classList.contains('active')),true,'#payroll without access returns to the overview');
    assert.equal(await deniedPage.locator('#payroll-landing').count(),0);
    assert.equal((await denied.request.get(base+route)).status(),403);
    assert.equal((await denied.request.patch(base+'/api/company',{data:{payroll:{pay_schedule:{frequency:null}}},headers:{'X-PDL-Company':seed.COMPANY_ID}})).status(),403);
    assert.equal((await denied.request.patch(base+'/api/users/'+noaccessId+'/payroll-access',{data:{payroll:true},headers:{'X-PDL-Company':seed.COMPANY_ID}})).status(),403);
    await deniedPage.evaluate(()=>{showPage('team');teamTab='accounts';renderTeamDirectory();});
    assert.equal(await deniedPage.locator('[data-payroll-grant]').count(),0,'admin has no payroll grant toggles');
    await assertPayrollEntry(deniedPage,false);
    const ownerCtx=await browser.newContext(),ownerPage=await ownerCtx.newPage();await login(ownerPage,seed.OWNER_EMAIL);await ownerPage.waitForFunction(()=>document.querySelector('#payroll-nav')&&!document.querySelector('#payroll-nav').hidden);
    await assertPayrollEntry(ownerPage,true);
    assert.equal((await ownerCtx.request.get(base+route)).status(),200);
    await ownerPage.evaluate(()=>showPage('team'));
    await ownerPage.locator('[data-team-tab="accounts"]').click();
    await ownerPage.locator('.payroll-access-always').waitFor();
    assert.match(await ownerPage.locator('.payroll-access-always').innerText(),/Always on/);
    await ownerPage.setViewportSize({width:390,height:667});
    for (const theme of ['light','dark']) {
      await ownerPage.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
      const row=await ownerPage.locator('.payroll-access-always').evaluate(el=>{const r=el.getBoundingClientRect(),parent=el.parentElement,style=getComputedStyle(parent),label=parent.querySelector('.payroll-account-owner');return{width:r.width,available:parent.clientWidth-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight),overflow:el.scrollWidth-el.clientWidth,color:getComputedStyle(label).color};});
      assert(row.width>=row.available-1&&row.overflow<=1,JSON.stringify(row));
      assert.equal(row.color,theme==='dark'?'rgb(255, 255, 255)':'rgb(0, 0, 0)');
      const grantStyles=await ownerPage.locator('#account-list .payroll-grant').evaluateAll(elements=>elements.map(el=>{const s=getComputedStyle(el);return{border:s.borderTopColor,bg:s.backgroundColor,color:s.color};}));
      assert(grantStyles.length>0);
      const palette=['rgb(0, 0, 0)','rgb(255, 255, 255)','rgb(247, 245, 240)','rgb(255, 102, 0)','rgb(110, 110, 110)'];
      for(const styles of grantStyles){assert.equal(styles.border,'rgb(110, 110, 110)');assert(Object.values(styles).every(color=>palette.includes(color)),JSON.stringify(styles));}
      if(theme==='dark')for(const color of await ownerPage.locator('#account-list .account-row small').evaluateAll(elements=>elements.map(el=>getComputedStyle(el).color)))assert.equal(color,'rgb(255, 255, 255)');
    }
    const grant=ownerPage.locator(`[data-payroll-grant="${noaccessId}"]`);
    await grant.click();
    await ownerPage.waitForFunction(id=>document.querySelector(`[data-payroll-grant="${id}"]`)?.getAttribute('aria-pressed')==='true',noaccessId);
    assert.equal((await denied.request.get(base+route)).status(),200,'grant takes effect');
    await deniedPage.evaluate(async()=>{await api('/api/state');showPage('payroll');});
    await deniedPage.locator('#payroll-page.active').waitFor();
    await assertPayrollEntry(deniedPage,true);
    assert.equal(await deniedPage.evaluate(()=>currentUser.permissions.manageTime),false,'payroll grant does not grant time management');
    assert.equal((await denied.request.get(base+'/api/time-cards')).status(),403,'Time cards access stays restricted');
    const payrollPunches=await denied.request.get(base+'/api/payroll/punches');
    assert.equal(payrollPunches.status(),200);
    assert.equal((await payrollPunches.json()).length,db.timeCards.length,'payroll availability includes company-wide punches');
    await deniedPage.locator('#payroll-landing [data-payroll-range="last"]').click();
    await deniedPage.waitForFunction(()=>!document.querySelector('#payroll-landing [data-payroll-download="csv"]')?.disabled);
    assert.equal(await deniedPage.locator('[data-payroll-empty]').first().isHidden(),true);
    const [grantedDownload]=await Promise.all([deniedPage.waitForEvent('download'),deniedPage.locator('#payroll-landing [data-payroll-download="csv"]').click()]);
    const grantedCsv=fs.readFileSync(await grantedDownload.path(),'utf8');
    const lastRange=calendar.range('last',calendar.today(db.company.timezone),db.company.weekStart);
    verifyCsv(grantedCsv,lastRange);
    const lastRoute=base+'/api/payroll/export?'+new URLSearchParams({...lastRange,format:'csv'});
    assert.equal(grantedCsv,await (await ownerCtx.request.get(lastRoute)).text(),'granted admin and owner export the same company hours');
    assert.equal(grantedCsv,await (await context.request.get(lastRoute)).text(),'granted admin and office demo export the same company hours');
    await grant.click();
    await ownerPage.waitForFunction(id=>document.querySelector(`[data-payroll-grant="${id}"]`)?.getAttribute('aria-pressed')==='false',noaccessId);
    assert.equal((await denied.request.get(base+route)).status(),403,'removing payroll revokes export');
    await deniedPage.evaluate(()=>api('/api/state'));
    assert.equal(await deniedPage.locator('#payroll-page.active, #payroll-nav:visible, #payroll-phone-bar:visible').count(),0,'next state refresh removes revoked access without reload');
    // Use the time-enabled office session for the rejected-download path.
    const officeId=db.users.find(user=>user.email===seed.OFFICE_EMAIL).id;
    await page.evaluate(()=>showPage('payroll'));
    await page.waitForFunction(()=>!document.querySelector('#payroll-landing [data-payroll-download="csv"]')?.disabled);
    await ownerPage.locator(`[data-payroll-grant="${officeId}"]`).click();
    await ownerPage.waitForFunction(id=>document.querySelector(`[data-payroll-grant="${id}"]`)?.getAttribute('aria-pressed')==='false',officeId);
    await page.locator('#payroll-landing [data-payroll-download="csv"]').click();
    await page.waitForFunction(()=>!document.querySelector('#payroll-page.active')&&document.querySelector('#payroll-nav').hidden);
    assert.equal(await page.locator('#payroll-landing, #payroll-export-dialog').count(),0,'export 403 removes both components immediately');
    for (const authFlag of [undefined,'0','1']) {
      if(authFlag===undefined)delete process.env.PDL_REQUIRE_AUTH;else process.env.PDL_REQUIRE_AUTH=authFlag;
      assert.equal((await fetch(base+route)).status,401,`${authFlag}: anonymous export`);
      assert.equal((await denied.request.get(base+route)).status(),403,`${authFlag}: ungranted export`);
      assert.equal((await ownerCtx.request.get(base+route)).status(),200,`${authFlag}: owner export`);
      assert.equal((await fetch(base+'/api/payroll/punches')).status,401,`${authFlag}: anonymous payroll availability`);
      assert.equal((await denied.request.get(base+'/api/payroll/punches')).status(),403,`${authFlag}: ungranted payroll availability`);
      const grantRoute=base+'/api/users/'+noaccessId+'/payroll-access';
      assert.equal((await fetch(grantRoute,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({payroll:true})})).status,401,`${authFlag}: anonymous grant`);
      assert.equal((await denied.request.patch(grantRoute,{data:{payroll:true}})).status(),403,`${authFlag}: admin grant`);
      assert.equal((await denied.request.patch(base+'/api/company',{data:{payroll:{pay_schedule:{frequency:null}}}})).status(),403,`${authFlag}: ungranted schedule`);
    }
    assert.equal((await ownerCtx.request.patch(base+'/api/users/'+db.users.find(user=>user.role==='owner').id+'/payroll-access',{data:{payroll:false},headers:{'X-PDL-Company':seed.COMPANY_ID}})).status(),409);
    const field=await browser.newContext(),fieldPage=await field.newPage();await login(fieldPage,seed.FIELD_EMAIL);await fieldPage.waitForFunction(()=>!document.querySelector('#payroll-landing')&&!document.querySelector('#payroll-export-dialog'));assert.equal((await field.request.get(base+route)).status(),403);assert.equal((await field.request.patch(base+'/api/company',{data:{payroll:{pay_schedule:{frequency:'weekly',period_end_weekday:2}}},headers:{'X-PDL-Company':seed.COMPANY_ID}})).status(),403);assert.equal(await fieldPage.locator('#payroll-landing').count(),0,'field users have no payroll card in the DOM');assert.equal(await fieldPage.locator('#payroll-export-dialog').count(),0,'field users have no export dialog in the DOM');assert.equal(await fieldPage.locator('[data-payroll-export-open]:visible').count(),0);
    assert.equal(await fieldPage.locator('#payroll-nav:visible, #payroll-phone-bar:visible').count(),0,'field users never see Payroll navigation');
    await assertPayrollEntry(fieldPage,false,'myday');
    const foreman=await browser.newContext(),foremanPage=await foreman.newPage();
    await login(foremanPage,foremanEmail);
    assert.equal((await foreman.request.get(base+'/api/auth/me').then(response=>response.json())).accessRole,'foreman');
    await assertPayrollEntry(foremanPage,false,'myday');
    assert.equal((await foreman.request.get(base+route)).status(),403);
    assert.equal(await foremanPage.locator('#payroll-nav:visible, #payroll-phone-bar:visible, #dashboard-page:visible').count(),0);
    assert.equal((await field.request.get(base+'/api/payroll/punches')).status(),403);
    await fieldPage.evaluate(()=>showPage('payroll'));
    assert.equal(await fieldPage.locator('#payroll-page.active').count(),0,'field users cannot open the Payroll page');
    assert.deepEqual(errors,[]);console.log('Landing payroll speed, real inline calendar, CSV sums, empty states, shared dialog, filtered review, keyboard, brand and access checks passed.');
  }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));fs.rmSync(root,{recursive:true,force:true})}
}
main().catch(error=>{console.error(error);process.exitCode=1});
