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
    assert.equal(await page.locator('[data-team-tab="accounts"]').count(),0);
    assert.equal(await page.locator('[data-team-tab="employees"]').textContent(),'Team members');
    const request=async(method,route,input)=>page.evaluate(async({method,route,input})=>{const response=await fetch(route,{method,headers:{'Content-Type':'application/json'},body:input?JSON.stringify(input):undefined});return {status:response.status,data:await response.json()};},{method,route,input});
    const created=await request('POST','/api/team-with-account',{name:'Unified Person',role:'Office administrator',crew:'Office',email:'unified@example.invalid',accountRole:'admin'});
    assert.equal(created.status,201,JSON.stringify(created.data));
    const member=created.data,user=created.data.user;
    await page.evaluate(async()=>{await loadRole('office');showPage('team');});
    assert.equal(await page.locator(`[data-team-member="member-${member.id}"]`).count(),1);
    assert.equal(await page.locator(`[data-team-member="user-${user.id}"]`).count(),0,'linked account is not a second card');
    const ownerId=await page.evaluate(()=>currentUser.id);
    const standalone=await request('POST','/api/users',{name:'Account Only',email:'account-only@example.invalid',role:'admin'});assert.equal(standalone.status,201);
    await page.evaluate(async()=>{await loadRole('office');showPage('team');});
    assert.equal(await page.locator(`[data-team-member="user-${standalone.data.id}"]`).count(),1,'account without a worker remains reachable');
    const card=page.locator(`[data-team-member="member-${member.id}"]`),dialog=page.locator('#team-details-modal');
    fs.mkdirSync(path.join(__dirname,'docs','team-members'),{recursive:true});
    for(const width of [390,1280])for(const theme of ['light','dark']){
      await page.setViewportSize({width,height:width===390?667:800});
      await page.evaluate(theme=>{document.documentElement.dataset.theme=theme;setNavigationOpen(false);document.activeElement?.blur();window.scrollTo(0,0);},theme);
      assert.equal(await card.evaluate(el=>getComputedStyle(el).borderTopColor),'rgb(110, 110, 110)');
      await page.screenshot({path:`docs/team-members/directory-${theme}-${width}.png`,animations:'disabled'});
      await card.focus();await page.keyboard.press('Enter');await dialog.waitFor();await dialog.evaluate(async el=>{await Promise.all(el.getAnimations({subtree:true}).map(animation=>animation.finished.catch(()=>{})));});
      assert.equal(await dialog.locator('[data-user-edit]').count(),1);
      assert.equal(await dialog.locator('[data-user-reset]').count(),1);
      assert.equal(await dialog.locator('[data-payroll-grant]').innerText(),'Payroll access: Off');
      const styles=await dialog.locator('[data-user-edit]').evaluate(el=>{const s=getComputedStyle(el);return {bg:s.backgroundColor,color:s.color,height:el.getBoundingClientRect().height};});
      assert.equal(styles.bg,theme==='dark'?'rgb(0, 0, 0)':'rgb(255, 255, 255)');assert.equal(styles.color,theme==='dark'?'rgb(255, 255, 255)':'rgb(0, 0, 0)');assert(styles.height>=48,JSON.stringify(styles));
      assert(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth+1),JSON.stringify(await dialog.evaluate(el=>[el,...el.querySelectorAll('*')].filter(n=>n.getBoundingClientRect().right>el.getBoundingClientRect().right).map(n=>({tag:n.tagName,cls:n.className,width:n.getBoundingClientRect().width})))));
      await page.screenshot({path:`docs/team-members/details-${theme}-${width}.png`});
      await dialog.locator('[data-team-close]').click();
      await page.evaluate(id=>openUserModal(users.find(row=>row.id===id)),user.id);
      await page.locator('#user-role').selectOption('project_manager');
      const access=page.locator('#user-modal');
      await access.evaluate(async el=>{await Promise.all(el.getAnimations({subtree:true}).map(a=>a.finished.catch(()=>{})));});
      for(const selector of ['#user-projects','#user-crews','.permission-grid']){
        const choices=await access.locator(selector+' input[type=checkbox]').evaluateAll(inputs=>inputs.map(input=>{const box=input.getBoundingClientRect(),row=input.closest('label').getBoundingClientRect();return {width:box.width,height:box.height,rowHeight:row.height,offset:box.left-row.left};}));
        assert(choices.length>0);
        for(const choice of choices){assert.equal(choice.width,20);assert.equal(choice.height,20);assert(choice.rowHeight>=48);assert(choice.offset>=0&&choice.offset<=16);}
      }
      assert(await access.evaluate(el=>el.scrollWidth<=el.clientWidth+1));
      await page.locator('#user-project-access').scrollIntoViewIfNeeded();
      await page.screenshot({path:`docs/team-members/access-${theme}-${width}.png`,animations:'disabled'});
      await access.evaluate(el=>el.close());
    }
    await card.click();await dialog.locator('[data-edit-profile]').click();await dialog.locator('[name=phone]').fill('555-0100');await dialog.locator('[type=submit]').click();
    await page.waitForFunction(id=>team.find(row=>row.id===id)?.phone==='555-0100',member.id);
    let state=(await request('GET','/api/state')).data;
    assert.equal(state.team.find(row=>row.id===member.id).phone,'555-0100');
    assert.equal((await request('PATCH',`/api/team/${member.id}/profile`,{name:'',role:'Office administrator',crew:'Office'})).status,400);
    assert.equal((await request('PATCH','/api/team/999999/profile',{name:'Missing',role:'Office administrator',crew:'Office'})).status,404);
    await dialog.locator('[data-user-edit]').click();
    await page.locator('#user-manage-time').check();await page.locator('#save-user').click();await page.locator('#user-modal').waitFor({state:'hidden'});
    state=(await request('GET','/api/state')).data;
    assert.equal(state.users.find(row=>row.id===user.id).memberId,member.id,'office access edit preserves worker link');
    assert.equal(state.users.find(row=>row.id===user.id).permissions.manageTime,true);
    await card.click();await dialog.locator('[data-user-toggle]').click();
    await page.waitForFunction(id=>users.find(row=>row.id===id)?.status==='Deactivated',user.id);
    state=(await request('GET','/api/state')).data;
    assert.equal(state.users.find(row=>row.id===user.id).permissions.manageTime,true,'status change preserves access');
    assert.equal(state.users.find(row=>row.id===user.id).memberId,member.id);
    await dialog.locator('[data-user-toggle]').click();await page.waitForFunction(id=>users.find(row=>row.id===id)?.status==='Active',user.id);
    await dialog.locator('[data-team-close]').click();
    const noLogin=await request('POST','/api/team',{name:'No Login Person',role:'Laborer',crew:'Office',email:'no-login@example.invalid'});
    await page.evaluate(async()=>{await loadRole('office');showPage('team');});
    await page.locator(`[data-team-member="member-${noLogin.data.id}"]`).click();
    assert.equal(await dialog.locator('[data-member-login]').count(),1);
    await dialog.locator('[data-member-login]').click();
    assert.equal(await page.locator('#user-field-member').inputValue(),String(noLogin.data.id));
    const teamCount=await page.evaluate(()=>team.length);
    await page.locator('#save-user').click();
    await page.waitForFunction(id=>users.some(user=>Number(user.memberId)===id),noLogin.data.id);
    state=(await request('GET','/api/state')).data;
    assert.equal(state.team.length,teamCount,'adding access does not create another worker');
    assert.equal(state.users.filter(user=>Number(user.memberId)===noLogin.data.id).length,1);
    await page.locator('#user-modal').evaluate(el=>el.close());
    await page.evaluate(()=>{currentUser={...currentUser,role:'admin'};renderTeamDirectory();});
    await card.click();assert.equal(await dialog.locator('[data-user-edit], [data-user-toggle], [data-user-reset], [data-payroll-grant]').count(),0,'non-owner cannot manage accounts');
    await dialog.locator('[data-team-close]').click();
    // Endpoint authorization is checked against a real field session, not UI state.
    const field=await request('POST','/api/team-with-account',{name:'Field Test',role:'Laborer',crew:'Office',email:'field-team@example.invalid',accountRole:'field'});
    assert.equal(field.status,201);
    const ctx=await browser.newContext();
    const login=await ctx.request.post(new URL('/api/auth/login',url).href,{data:{email:require('./staging-seed').FIELD_EMAIL,password}});
    assert.equal(login.status(),200);
    const denied=await ctx.request.patch(new URL(`/api/team/${member.id}/profile`,url).href,{data:{name:'Blocked',role:'Laborer',crew:'Office'}});assert.equal(denied.status(),403);
    const anonymous=await browser.newContext();assert.equal((await anonymous.request.patch(new URL(`/api/team/${member.id}/profile`,url).href,{data:{name:'Blocked'}})).status(),401);
    await ctx.close();await anonymous.close();assert.deepEqual(errors,[]);
    console.log('Team members: unified cards, details, profile save, linked access, status preservation, owner controls, auth and responsive themes passed.');
  } finally {await browser?.close();if(child?.exitCode==null)child.kill();}
})().catch(error=>{console.error(error);process.exitCode=1;});
