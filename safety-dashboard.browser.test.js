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


    await page.evaluate(()=>showPage('safety'));
    await page.locator('#safety-dashboard [data-program-action="assign"]').waitFor();
    const request=async(method,path,input)=>page.evaluate(async({method,path,input})=>{const response=await fetch('/api/safety/'+path,{method,headers:{'Content-Type':'application/json'},body:input?JSON.stringify(input):undefined});return {status:response.status,data:await response.json()};},{method,path,input});
    const overview=(await request('GET','overview')).data;
    assert.ok(overview.people.length&&overview.presenters.length);
    await page.locator('[data-program-tab="topics"]').click();
    await page.locator('#safety-dashboard [data-program-action="topic"]').click();
    const dialog=page.locator('#safety-program-dialog');
    await dialog.locator('[name=title]').fill('Site access walk-through');
    await dialog.locator('[name=content]').fill('Discuss the access route, moving equipment and the protected pedestrian path.');
    await dialog.locator('[name=status]').selectOption('Published');
    await dialog.locator('[type=submit]').click();await dialog.waitFor({state:'hidden'});
    await page.locator('[data-program-tab="overview"]').click();
    await page.locator('#safety-dashboard [data-program-action="assign"]').click();
    await dialog.locator('[name=topicId]').selectOption({label:'Site access walk-through'});
    await dialog.locator('[name=presenterId]').selectOption(String(overview.presenters[0].id));
    await dialog.locator('[name=projectId]').selectOption(String(overview.projects[0].id));
    await dialog.locator('[name=invited]').first().check();
    await dialog.locator('[name=invited]').nth(1).check();
    await dialog.locator('[type=submit]').click();await dialog.waitFor({state:'hidden'});
    const assigned=(await request('GET','overview')).data.meetings.find(row=>row.topic.title==='Site access walk-through');
    assert.equal(assigned.status,'scheduled');assert.equal(assigned.attendees.length,0);
    await page.locator(`[data-program-action="meeting"][data-id="${assigned.id}"]`).click();
    await dialog.locator('[name=discussion]').fill('Reviewed the pedestrian path. Replace the missing barrier before deliveries.');
    assert.equal(await dialog.locator('[name=attendee]:checked').count(),0);
    await dialog.locator('[name=attendee]').first().check();
    await dialog.locator('summary').filter({hasText:'Add a corrective action'}).click();
    await dialog.locator('[name=observation]').fill('Replace missing barrier');
    await dialog.locator('[name=ownerId]').selectOption(String(overview.people[0].id));
    await dialog.locator('[name=dueDate]').fill(overview.today);
    await dialog.locator('[type=submit]').click();await dialog.waitFor({state:'hidden'});
    const saved=(await request('GET','overview')).data.meetings.find(row=>row.id===assigned.id);
    assert.equal(saved.status,'completed');assert.equal(saved.attendees.length,1);assert.equal(saved.actions.length,1);
    const planned=await request('POST','meetings',{kind:'committee',projectId:null,presenterId:overview.presenters[0].id,invitedIds:overview.people.slice(0,2).map(row=>row.id),date:overview.today,frequency:'monthly',count:3});assert.equal(planned.status,201);
    await page.locator('#safety-dashboard [data-program-action="refresh"]').click();
    await page.locator('#safety-dashboard h3').filter({hasText:'Safety committee meeting'}).first().waitFor();
    fs.mkdirSync(path.join(__dirname,'docs','safety-dashboard'),{recursive:true});
    for(const width of [390,1280])for(const theme of ['light','dark']){
      await page.setViewportSize({width,height:width===390?667:800});
      await page.evaluate(theme=>{document.documentElement.dataset.theme=theme;},theme);
      await page.locator('[data-program-tab="overview"]').click();
      await page.evaluate(()=>window.scrollTo(0,0));
      assert.equal(await page.locator('#payroll-page').isVisible(),false,'inactive Payroll cannot appear above Safety');
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'no horizontal overflow');
      const styles=await page.locator('#safety-dashboard [data-program-action="assign"]').evaluate(node=>{const s=getComputedStyle(node);return {height:node.getBoundingClientRect().height,bg:s.backgroundColor,color:s.color};});
      assert.ok(styles.height>=48);
      const offPalette=await page.locator('#safety-dashboard').evaluate(root=>[...root.querySelectorAll('*')].filter(node=>node.checkVisibility()).flatMap(node=>{const s=getComputedStyle(node),allowed=['rgb(0, 0, 0)','rgb(255, 255, 255)','rgb(247, 245, 240)','rgb(255, 102, 0)','rgb(110, 110, 110)','rgba(0, 0, 0, 0)'];return ['color','backgroundColor'].filter(key=>!allowed.includes(s[key])).map(key=>node.tagName+' '+key+': '+s[key]);}));assert.deepEqual(offPalette,[],theme+' dashboard uses brand colors');assert.equal(styles.bg,'rgb(255, 102, 0)');assert.equal(styles.color,'rgb(0, 0, 0)');
      await page.screenshot({path:path.join(__dirname,'docs','safety-dashboard',`overview-${theme}-${width}.png`),fullPage:true,animations:'disabled'});
      await page.locator('#safety-dashboard [data-program-action="assign"]').click();
      if(theme==='dark')assert.equal(await dialog.locator('select').first().evaluate(node=>getComputedStyle(node).backgroundColor),'rgb(0, 0, 0)');
      const bounds=await dialog.locator('footer [type=submit]').boundingBox();assert.ok(bounds.y>=0&&bounds.y+bounds.height<=(width===390?667:800),'pinned submit stays inside viewport');
      await page.screenshot({path:path.join(__dirname,'docs','safety-dashboard',`assign-${theme}-${width}.png`)});
      await dialog.locator('[data-close]').click();
    }
    await page.locator('#safety-dashboard [data-program-action="export"]').click();
    const downloadPromise=page.waitForEvent('download');
    await dialog.locator('[type=submit]').click();const download=await downloadPromise;
    assert.match(download.suggestedFilename(),/^pdl-safety-.*\.pdf$/);assert.equal(await download.failure(),null);

    const publisher=await browser.newPage({viewport:{width:1280,height:800}});
    await publisher.setContent('<section id="safety-view" class="active"><div id="platform-safety-library" class="safety-program"></div></section>');
    await publisher.addStyleTag({path:path.join(__dirname,'safety-dashboard-ui.css')});
    await publisher.addScriptTag({content:`const PLATFORM_CAP={HELP_CONTENT_WRITE:'write'};const can=()=>true;let savedTopics=[];async function api(path,options){if(!options)return savedTopics;const input=JSON.parse(options.body);const old=savedTopics.find(row=>path.endsWith('/'+row.id));const next={...input,id:old?.id||'new-topic',revision:(old?.revision||0)+1,history:old?[{...old,by:'Editor'}]:[]};savedTopics=[next];return next;}`});
    await publisher.addScriptTag({path:path.join(__dirname,'platform-safety-ui.js')});
    await publisher.locator('[data-safety-topic=""]').click();
    await publisher.locator('[name=title]').fill('Reviewed equipment talk');await publisher.locator('[name=content]').fill('Discuss equipment separation and spotters.');await publisher.locator('[name=status]').selectOption('Published');await publisher.locator('[type=submit]').click();
    await publisher.locator('[data-safety-topic="new-topic"]').click();assert.equal(await publisher.locator('[name=title]').inputValue(),'Reviewed equipment talk');await publisher.locator('[name=content]').fill('Updated spotter guidance.');await publisher.locator('[type=submit]').click();
    await publisher.locator('[data-safety-topic="new-topic"]').click();await publisher.locator('summary').click();assert.ok((await publisher.locator('details').textContent()).includes('Discuss equipment separation and spotters.'));await publisher.close();
    assert.deepEqual(errors,[]);
    console.log('Safety dashboard: topic creation, assignment, actual attendance, corrective actions, branded mobile/desktop and PDF passed.');
  } finally {await browser?.close();if(child?.exitCode==null)child.kill();}
})().catch(error=>{console.error(error);process.exitCode=1;});
