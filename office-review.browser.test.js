'use strict';

// Full-app Safety smoke test. The demo runner creates disposable data and
// disables every external provider.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

let chromium;
for (const dependency of [
  'playwright',
  'playwright-core',
  process.env.PDL_PLAYWRIGHT_MODULE,
  path.join(os.homedir(), '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'node', 'node_modules', 'playwright')
].filter(Boolean)) {
  try { chromium = require(dependency).chromium; break; } catch { /* Try the next installed runtime. */ }
}
if (!chromium) throw new Error('Configure PDL_PLAYWRIGHT_MODULE with an available Playwright runtime.');
const browserPath = process.env.PDL_BROWSER_PATH || [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium'
].find(file => fs.existsSync(file));
fs.mkdirSync(path.join(__dirname, 'output'), { recursive: true });

(async () => {
  let child, browser;
  try {
    child = spawn(process.execPath, ['scripts/safety-demo.cjs', '--port=0'], { cwd: __dirname, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Demo startup timed out: ' + log)), 15000);
      child.stdout.on('data', chunk => {
        log += chunk;
        if (log.includes('Temporary demo password:')) { clearTimeout(timer); resolve(); }
      });
      child.stderr.on('data', chunk => { log += chunk; });
      child.on('exit', code => reject(new Error(`Demo exited ${code}: ${log}`)));
    });
    const url = log.match(/Safety demo: (http[^\s]+)/)?.[1];
    const password = log.match(/Temporary demo password: ([^\s]+)/)?.[1];
    assert.ok(url && password, 'demo runner returns its local URL and disposable password');

    browser = await chromium.launch({ headless: true, ...(browserPath ? { executablePath: browserPath } : {}) });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => route.request().url().startsWith(new URL(url).origin) ? route.continue() : route.abort());

    await page.goto(url);
    await page.locator('#email').fill('pm@example.invalid');
    await page.locator('#password').fill(password);
    await page.locator('#login button[type=submit]').click();
    await page.waitForURL('**/app?**', { timeout: 20000 });


    await page.waitForLoadState('load');
    await page.waitForFunction(()=>typeof currentUser!=='undefined'&&currentUser?.role==='owner');
    await page.evaluate(()=>showPage('team'));
    const request=async(method,route,input)=>page.evaluate(async({method,route,input})=>{const response=await fetch(route,{method,headers:{'Content-Type':'application/json'},body:input?JSON.stringify(input):undefined});return {status:response.status,data:await response.json()};},{method,route,input});
    const created=await request('POST','/api/team',{name:'Existing Worker',role:'Operator',crew:'Main',email:'link@example.invalid'});
    assert.equal(created.status,201,JSON.stringify(created));
    const member=created.data;
    const login=await request('POST','/api/users',{name:'Existing Login',email:'link@example.invalid',role:'admin'});
    assert.equal(login.status,201,JSON.stringify(login));
    const unauth=await browser.newContext();
    const denied=await unauth.request.post(new URL(`/api/users/${login.data.id}/link-member`,url).href,{data:{memberId:member.id}});
    assert.equal(denied.status(),401);await unauth.close();
    const fieldContext=await browser.newContext();
    assert.equal((await fieldContext.request.post(new URL('/api/auth/login',url).href,{data:{email:require('./staging-seed').FIELD_EMAIL,password}})).status(),200);
    assert.equal((await fieldContext.request.post(new URL(`/api/users/${login.data.id}/link-member`,url).href,{data:{memberId:member.id}})).status(),403);
    await fieldContext.close();

    await page.evaluate(async()=>{await loadRole('office');showPage('team');});
    await page.locator(`[data-team-member="member-${member.id}"]`).click();
    const dialog=page.locator('#team-details-modal');
    assert.equal(await dialog.locator('[data-member-login]').count(),0,'existing login cannot be created twice');
    await dialog.locator('.team-link-notice summary').click();
    await dialog.locator('[data-link-member]').click();
    await page.waitForFunction(id=>users.find(u=>u.id===id)?.memberId,login.data.id);
    const accounts=(await request('GET','/api/users')).data;
    assert.equal(Object.hasOwn(accounts.find(u=>u.id===login.data.id),'passwordHash'),false);
    assert.equal(accounts.find(u=>u.id===login.data.id).memberId,member.id);
    assert.equal(accounts.find(u=>u.id===login.data.id).role,'admin');
    assert.equal(await page.locator(`[data-team-member="user-${login.data.id}"]`).count(),0);
    assert.equal((await request('GET','/api/audit-log')).data.filter(r=>r.type==='team_login_linked'&&r.userId===login.data.id).length,1);
    await dialog.locator('[data-team-close]').click();
    await page.waitForFunction(()=>!document.querySelector('#toast.visible'));
    await page.evaluate(()=>{
      if(!reports.length)reports.push({id:8000,project:0,dateIso:'2026-11-02',foreman:'Synthetic reviewer',laborEntries:[],productionEntries:[],history:[]});const report=reports[0];report.officeReview={reasons:[{message:'Compare reported hours with clock time.'}],reportedLabor:[{memberId:team[0].id,hours:35}],measuredClock:[{memberId:team[0].id,seconds:1474.711}]};
      report.status='Needs review';report.summary='Synthetic daily summary';
    });
    fs.mkdirSync(path.join(__dirname,'docs','office-review'),{recursive:true});
    for(const width of [390,1280])for(const theme of ['light','dark']){
      await page.setViewportSize({width,height:width===390?844:800});
      await page.evaluate(theme=>{document.documentElement.dataset.theme=theme;setNavigationOpen(false);showPage('reports');renderReports(reports[0].id);},theme);
      const warning=page.locator('#report-detail .office-review-warning');await warning.evaluate(el=>el.scrollIntoView({block:'start'}));
      assert.equal(await warning.locator('details').getAttribute('open'),null);
      await warning.locator('summary').click();assert.match(await warning.innerText(),/24 min 35 sec/);
      const actionStyle=await warning.locator('[data-review-daily]').evaluate(el=>{const s=getComputedStyle(el);return {color:s.color,bg:s.backgroundColor,opacity:s.opacity,text:el.textContent,font:s.fontSize,fill:s.webkitTextFillColor};});
      assert.equal(actionStyle.color,'rgb(255, 255, 255)',JSON.stringify(actionStyle));
      assert.equal(actionStyle.bg,'rgb(0, 0, 0)',JSON.stringify(actionStyle));
      assert.equal(actionStyle.fill,'rgb(255, 255, 255)',JSON.stringify(actionStyle));
      assert.equal(actionStyle.text,'Review / correct daily',JSON.stringify(actionStyle));

      for(const selector of ['.office-review-warning','.ai-banner']){
        const style=await page.locator('#report-detail '+selector).evaluate(el=>{const s=getComputedStyle(el);return {bg:s.backgroundColor,color:s.color,border:s.borderTopColor};});
        assert.equal(style.bg,theme==='dark'?'rgb(0, 0, 0)':'rgb(247, 245, 240)',JSON.stringify(style));
        assert.equal(style.color,theme==='dark'?'rgb(255, 255, 255)':'rgb(0, 0, 0)',JSON.stringify(style));
        assert.equal(style.border,'rgb(110, 110, 110)');
      }
      await page.evaluate(()=>document.fonts.ready);
      await page.screenshot({path:`docs/office-review/daily-${theme}-${width}.png`,animations:'disabled'});
      await warning.locator('[data-review-daily]').click();await page.locator('#report-modal').waitFor();await page.locator('#report-modal').evaluate(el=>el.close());
      await page.evaluate(()=>{
        showPage('timecards');
        timeCards=[{id:8001,memberId:team[0].id,projectId:projects[0].id,inAt:'2026-11-02T15:00:00Z',outAt:'2026-11-02T23:00:00Z',date:'2026-11-02',hours:8,status:'submitted'}];
        renderTimeCards();window.scrollTo(0,0);
      });
      await page.locator('.time-pay-management').waitFor();
      const inputColor=await page.locator('#time-person-search').evaluate(el=>({bg:getComputedStyle(el).backgroundColor,color:getComputedStyle(el).color,placeholder:getComputedStyle(el,'::placeholder').color}));
      assert.equal(inputColor.bg,theme==='dark'?'rgb(0, 0, 0)':'rgb(247, 245, 240)');
      assert.equal(inputColor.color,theme==='dark'?'rgb(255, 255, 255)':'rgb(0, 0, 0)');
      assert.equal(inputColor.placeholder,theme==='dark'?'rgb(255, 255, 255)':'rgb(110, 110, 110)');

      if(width===390){
        await page.locator('.time-pay-management').evaluate(el=>el.open=false);
        const first=await page.locator('[data-time-person]').first().boundingBox();assert(first&&first.y+first.height<844,JSON.stringify(first));
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
        const period=await page.locator('#pay-period-panel').boundingBox();assert(period.y>=first.y+first.height);
      }
      await page.screenshot({path:`docs/office-review/time-${theme}-${width}.png`,animations:'disabled'});
    }
    assert.deepEqual(errors,[]);
    console.log('Office review browser checks passed: explicit persisted account linking, anonymous denial, daily evidence and action, theme colors and phone approval-first layout.');
  } finally {if(browser)await browser.close();if(child)child.kill();}
})().catch(error=>{console.error(error);process.exitCode=1;});
