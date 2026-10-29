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
  await page.evaluate(()=>{showPage('dashboard');window.scrollTo(0,0)});
  await page.evaluate(async()=>{await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));await Promise.all(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})))});
  const root=page.locator('#payroll-landing'); await root.locator('[data-payroll-download="csv"]').waitFor({state:'visible'});
  assert(await page.locator('#dashboard-page').evaluate(el=>el.classList.contains('active')),'start on the actual office landing');
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
  assert.equal(await scrollOffset(page), 0, 'page is already at the top');
  await tap(page, locator);
  assert.equal(await scrollOffset(page), 0, 'tap did not scroll');
}
async function assertScheduleClear(page) {
  assert.equal(await scrollOffset(page), 0, 'schedule fits without scrolling');
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
    const root=page.locator('#payroll-landing');await page.evaluate(()=>showPage('dashboard'));
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
    await page.evaluate(()=>showPage('dashboard'));
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
      await page.evaluate(() => { showPage('dashboard'); window.scrollTo(0, 0); });
      await page.locator('#payroll-landing [data-payroll-download="csv"]').waitFor({state:'visible'});
      await assertCustomUnapprovedNotice(page, page.locator('#payroll-landing'));
      await page.evaluate(() => showPage('timecards'));
      await page.locator('#pay-period-panel [data-payroll-export-open]').click();
      await assertCustomUnapprovedNotice(page, page.locator('#payroll-dialog-content'));
      await page.locator('[data-payroll-close]').click();
    }
    for (const viewport of [{width:390,height:500},{width:390,height:844},{width:1280,height:800}]) {
      await page.setViewportSize(viewport);
      await page.evaluate(() => { document.documentElement.dataset.theme='light'; showPage('dashboard'); window.scrollTo(0,0); });
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
    const scheduleCounts=[];
    for (const height of [844, 667]) for (const theme of ['light', 'dark']) {
      await page.setViewportSize({width:390,height});
      await settle(page);
      await page.evaluate(async theme=>{
        document.documentElement.dataset.theme=theme;
        company=await api('/api/company',{method:'PATCH',body:JSON.stringify({payroll:{pay_schedule:{frequency:null}}})});
        window.PDLCompanySettings.openPayPeriods();
      },theme);
      await page.locator('#pay-schedule-form').waitFor();
      await page.waitForFunction(()=>{const save=document.querySelector('[data-pay-schedule-save]');return !!save&&save.hidden&&!document.querySelector('[data-end-weekday]')});
      await settle(page);
      await page.evaluate(()=>{window.scrollTo(0,0);document.querySelector('main')?.scrollTo(0,0);window.payrollTapCount=0});
      const periodTab=await page.locator('#settings-tab-periods').evaluate(el=>({bg:getComputedStyle(el).backgroundColor,color:getComputedStyle(el).color}));
      assert.deepEqual(periodTab,theme==='dark'?{bg:'rgb(255, 255, 255)',color:'rgb(0, 0, 0)'}:{bg:'rgb(0, 0, 0)',color:'rgb(255, 255, 255)'});
      assert.equal(await page.locator('[data-pay-schedule-save]').isHidden(),true);
      const scheduleStarted=performance.now();
      await tapInPlace(page,page.locator('[data-pay-frequency="weekly"]'));
      await tapInPlace(page,page.locator('[data-end-weekday="2"]'));
      await tapInPlace(page,page.locator('[data-due-weekday="3"]'));
      await tapInPlace(page,page.locator('[data-pay-weekday="5"]'));
      await assertScheduleClear(page);
      const bar=await page.locator('[data-pay-schedule-save]').evaluate(el=>({position:getComputedStyle(el).position,bottom:getComputedStyle(el).bottom,h:el.getBoundingClientRect().height}));
      assert.deepEqual(bar,{position:'sticky',bottom:'0px',h:48});
      await tapInPlace(page,page.locator('[data-pay-schedule-save]'));
      await page.locator('[data-pay-schedule-status]').filter({hasText:'saved'}).waitFor();
      assert.equal(await page.locator('[data-pay-schedule-status]').evaluate(el=>getComputedStyle(el).borderLeftWidth),'0px');
      await page.locator('[data-pay-schedule-save]').waitFor({state:'hidden'});
      const scheduleTaps=await page.evaluate(()=>window.payrollTapCount),scheduleElapsed=performance.now()-scheduleStarted;
      assert(scheduleTaps<=6,`weekly setup at 390x${height} ${theme} took ${scheduleTaps} taps`);
      assert(scheduleElapsed<10000,`${height} ${theme}: ${scheduleElapsed}ms`);
      console.log(`Weekly Tue-end 390x${height} ${theme}: ${scheduleTaps} taps, ${Math.round(scheduleElapsed)}ms`);
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
      window.PDLCompanySettings.openPayPeriods();
    });
    await page.locator('#pay-schedule-form').waitFor();
    await page.waitForFunction(()=>{const save=document.querySelector('[data-pay-schedule-save]');return !!save&&save.hidden&&!document.querySelector('[data-end-weekday]')});
    await settle(page);
    await page.evaluate(()=>{window.scrollTo(0,0);document.querySelector('main')?.scrollTo(0,0);window.payrollTapCount=0});
    assert.equal(await page.locator('#settings-tab-company').evaluate(el=>getComputedStyle(el).borderTopColor),'rgb(110, 110, 110)');
    await tapInPlace(page,page.locator('[data-pay-frequency="weekly"]'));
    await tapInPlace(page,page.locator('[data-end-weekday="2"]'));
    await tapInPlace(page,page.locator('[data-due-weekday="3"]'));
    await tapInPlace(page,page.locator('[data-pay-weekday="5"]'));
    await assertScheduleClear(page);
    const desktopSave=await page.locator('[data-pay-schedule-save]').evaluate(el=>({position:getComputedStyle(el).position,h:el.getBoundingClientRect().height}));
    assert.deepEqual(desktopSave,{position:'static',h:48});
    const kept=async()=>{
      assert.equal(await page.locator('[data-due-weekday="3"]').getAttribute('aria-pressed'),'true');
      assert.equal(await page.locator('[data-pay-weekday="5"]').getAttribute('aria-pressed'),'true');
    };
    await kept();
    await tapInPlace(page,page.locator('[data-pay-schedule-save]'));
    await page.locator('[data-pay-schedule-status]').filter({hasText:'saved'}).waitFor();
    await tapInPlace(page,page.locator('[data-pay-frequency="biweekly"]'));
    await kept();
    await tapInPlace(page,page.locator('[data-pay-frequency="weekly"]'));
    await kept();
    console.log('Desktop 1280x800 weekly flow on screen, due and payday kept across Weekly > Every 2 weeks > Weekly');
    await page.setViewportSize({width:390,height:667});
    await settle(page);
    await page.evaluate(()=>{document.documentElement.dataset.theme='dark';window.scrollTo(0,0);document.querySelector('main')?.scrollTo(0,0)});
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
    assert.equal(await page.locator('[data-offset="cards_due_offset_days"]').inputValue(),'1');
    assert.equal(await page.locator('[data-offset="payday_offset_days"]').inputValue(),'3');
    console.log('Twice a month at 390x667 dark clears the Save bar');
    assert.equal((await context.request.patch(base+'/api/company',{data:{payroll:{pay_schedule:{frequency:'weekly'}}},headers:{'X-PDL-Company':seed.COMPANY_ID}})).status(),400);
    const scheduleToday=calendar.today('America/Los_Angeles');
    const expectedPeriod=paySchedule.lastEndedBefore({...paySchedule.emptySchedule(),frequency:'weekly',period_end_weekday:2,cards_due_offset_days:1,payday_offset_days:3},scheduleToday);
    await page.evaluate(()=>showPage('dashboard'));
    await page.locator('#payroll-landing [data-payroll-range="period"]').click();
    assert.equal(await page.locator('#payroll-landing [data-payroll-range-label]').innerText(),calendar.label(expectedPeriod.start,expectedPeriod.end,scheduleToday.slice(0,4)));
    const field=await browser.newContext(),fieldPage=await field.newPage();await login(fieldPage,seed.FIELD_EMAIL);await fieldPage.waitForFunction(()=>!document.querySelector('#payroll-landing')&&!document.querySelector('#payroll-export-dialog'));assert.equal((await field.request.get(base+route)).status(),403);assert.equal((await field.request.patch(base+'/api/company',{data:{payroll:{pay_schedule:{frequency:'weekly',period_end_weekday:2}}},headers:{'X-PDL-Company':seed.COMPANY_ID}})).status(),403);assert.equal(await fieldPage.locator('#payroll-landing').count(),0,'field users have no payroll card in the DOM');assert.equal(await fieldPage.locator('#payroll-export-dialog').count(),0,'field users have no export dialog in the DOM');assert.equal(await fieldPage.locator('[data-payroll-export-open]:visible').count(),0);
    assert.deepEqual(errors,[]);console.log('Landing payroll speed, real inline calendar, CSV sums, empty states, shared dialog, filtered review, keyboard, brand and access checks passed.');
  }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));fs.rmSync(root,{recursive:true,force:true})}
}
main().catch(error=>{console.error(error);process.exitCode=1});
