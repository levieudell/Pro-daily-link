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

    await page.waitForFunction(()=>window.pdlWorkspaceStateReady&&projects.length>1);
    await page.evaluate(()=>{showPage('messages');projectMessages=[{id:901,projectId:projects[0].id,sender:'field',senderName:'Crew',text:'First job message',createdAt:new Date().toISOString(),readBy:[]},{id:902,projectId:projects[1].id,sender:'office',senderName:'Office',text:'Second job message',createdAt:new Date().toISOString(),readBy:[]}];renderMessages();});
    fs.mkdirSync('docs/messages-inbox',{recursive:true});
    for(const width of [390,1280])for(const theme of ['light','dark']){
      await page.setViewportSize({width,height:width===390?667:800});
      await page.evaluate(theme=>{document.documentElement.dataset.theme=theme;setNavigationOpen(false);document.querySelector('#messages-page').classList.remove('thread-open');},theme);
      assert(!await page.locator('.msg-new-panel').isVisible());
      assert.equal(await page.locator('[data-msg-project]:visible').count(),2);
      const search=page.getByRole('searchbox',{name:'Search conversations'});await search.fill('Second job');assert.equal(await page.locator('[data-msg-project]:visible').count(),1);await search.fill('');
      await page.screenshot({path:`docs/messages-inbox/inbox-${theme}-${width}.png`});
      await page.locator('[data-msg-project]').first().click();await page.locator('#msg-reply-row').waitFor({state:'visible'});
      assert(await page.locator('#messages-page').evaluate(el=>el.scrollWidth<=el.clientWidth+1));
      await page.screenshot({path:`docs/messages-inbox/thread-${theme}-${width}.png`});
      await page.getByRole('button',{name:'New message',exact:true}).click();assert(await page.locator('#msg-project').isVisible());await page.locator('.msg-new-panel').getByRole('button',{name:'Cancel',exact:true}).click();
    }
    await page.evaluate(()=>{currentRole='field';currentUser={...currentUser,memberId:team[0].id};showPage('myday');renderMyDay();});
    const ids=await page.locator('[data-field-thread]').evaluateAll(els=>els.map(el=>el.dataset.fieldThread));assert.equal(ids.length,2);
    let payload;
    await page.route('**/api/projects/*/messages',async route=>{payload={url:route.request().url(),...route.request().postDataJSON()};await route.fulfill({json:{id:903,projectId:Number(ids[1]),sender:'field',senderName:'Crew',text:payload.text,createdAt:new Date().toISOString()}});});
    await page.locator(`[data-field-thread="${ids[1]}"]`).click();await page.locator('.field-inbox textarea').fill('Reply to selected job');await page.locator('.field-inbox button[type=submit]').click();await page.waitForFunction(()=>projectMessages.some(m=>m.id===903));
    assert(payload.url.includes(`/projects/${ids[1]}/messages`));assert.equal(payload.text,'Reply to selected job');assert.deepEqual(errors,[]);
    console.log('Messages inbox passed: responsive themes, search, compose, conversation view, and selected-job field reply.');
  }finally{await browser?.close();if(child?.exitCode==null)child.kill();}
})().catch(error=>{console.error(error);process.exitCode=1;});
