'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {spawn} = require('node:child_process');
let chromium;
for (const name of ['playwright','playwright-core',process.env.PDL_PLAYWRIGHT_MODULE,path.join(os.homedir(),'.cache','codex-runtimes','codex-primary-runtime','dependencies','node','node_modules','playwright')].filter(Boolean)) {
  try { chromium = require(name).chromium; break; } catch {}
}
assert(chromium,'Playwright must be installed');
const executablePath = process.env.PDL_BROWSER_PATH || ['C:/Program Files/Google/Chrome/Application/chrome.exe','/usr/bin/google-chrome','/usr/bin/chromium'].find(fs.existsSync);
(async()=>{
  let child,browser;
  try {
    child=spawn(process.execPath,['scripts/safety-demo.cjs','--port=0'],{cwd:__dirname,stdio:['ignore','pipe','pipe']});
    let log='';
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(Error('Demo startup timeout')),15000);
      child.stdout.on('data',chunk=>{log+=chunk;if(log.includes('Temporary demo password:')){clearTimeout(timer);resolve();}});
      child.stderr.on('data',()=>{});
      child.on('exit',code=>{clearTimeout(timer);reject(Error('Demo exited '+code));});
    });
    const url=log.match(/Safety demo: (http[^\s]+)/)[1],password=log.match(/Temporary demo password: ([^\s]+)/)[1];
    browser=await chromium.launch({headless:true,...(executablePath?{executablePath}:{})});
    const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.route('**/*',route=>route.request().url().startsWith(new URL(url).origin)?route.continue():route.abort());
    await page.goto(url);await page.locator('#email').fill('pm@example.invalid');await page.locator('#password').fill(password);
    await page.locator('#login button[type=submit]').click();await page.waitForURL('**/app?**');
    await page.waitForFunction(()=>window.pdlWorkspaceStateReady&&projects.length>1);
    await page.evaluate(()=>{
      projects[0].estimateItems=[{id:991,name:'Lock+Load Wall',unit:'LF',plannedQuantity:500}];
      openReport(null,{projectIndex:0,dateIso:companyTodayIso()});
      document.querySelector('#field-notes').value='Installed wall.';
      addProductionRow({estimateItemId:991,description:'Lock+Load Wall',quantity:0,unit:'LF',laborHours:0.05});
      showReportStep(2);
    });
    await page.waitForFunction(()=>reportLaborLoadedKey===reportLaborSelectionKey());
    await page.evaluate(()=>{document.querySelector('[data-labor-member]').value='0.05';document.querySelector('.production-hours').value='0.05';updateReportGaps();});
    assert.match(await page.locator('#report-gaps').innerText(),/Enter a quantity for each work line/);
    assert(!/ready to submit/.test(await page.locator('#report-gaps').innerText()));
    await page.evaluate(()=>{document.querySelector('.production-quantity').value='300';updateReportGaps();});
    assert(!/Enter a quantity/.test(await page.locator('#report-gaps').innerText()));
    fs.mkdirSync('docs/daily-review-alerts',{recursive:true});
    // Persisted legacy unmatched flags must visibly resolve into actual work rows.
    const legacy={project:0,dateIso:'2026-11-01',status:'Draft',originalNotes:'Installed 300 linear feet of wall.',notes:'Installed 300 linear feet of wall.',summary:'No production or labor recorded.',productionEntries:[],laborEntries:[],scopeFlags:[{id:'legacy-wall',kind:'extra',reason:'no_match',description:'Wall',quantity:300,unit:'LF',decision:null}]};
    for(const choice of ['estimate','extra']){
      await page.evaluate(report=>{document.querySelector('#report-modal').close();openReport(report);showReportStep(2);},{...legacy,scopeFlags:legacy.scopeFlags.map(flag=>({...flag,id:flag.id+choice}))});
      await page.locator(`[data-flag-choice="${choice}"]`).click();
      if(choice==='estimate'){
        await page.locator('[data-pick-line]').selectOption('991');
        assert.match(await page.locator('#field-choice-feedback').innerText(),/Linked to Lock.*300 LF/);
      }else assert.match(await page.locator('#field-choice-feedback').innerText(),/Marked as extra work.*300 LF/);
      assert.equal(await page.locator('.production-quantity').inputValue(),'300','decision keeps the stated quantity');
      assert.match(await page.locator('#report-summary').inputValue(),/300 linear feet/,'empty legacy summary uses source notes');
      for(const theme of ['light','dark']){
        await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
        await page.locator('#field-choice-feedback').evaluate(el=>el.scrollIntoView({block:'center'}));
        await page.screenshot({path:`docs/daily-review-alerts/choice-${choice}-${theme}-390.png`});
      }
    }
    await page.evaluate(()=>{document.querySelector('#report-summary').value='My office summary';showReportStep(2);});
    assert.equal(await page.locator('#report-summary').inputValue(),'My office summary','manual summary stays intact');
    await page.evaluate(()=>{document.querySelector('#report-modal').close();openReport(null,{projectIndex:0,dateIso:companyTodayIso()});addProductionRow({estimateItemId:991,description:'Lock+Load Wall',quantity:0,unit:'LF',laborHours:0.05});showReportStep(2);});
    // CSS fixture uses the real decision-button classes without invoking extraction.
    await page.evaluate(()=>{
      const host=document.createElement('article');host.className='field-flag';host.id='alert-brand-fixture';
      host.innerHTML='<strong>Lock + load wall</strong><button type="button" data-flag-choice="extra">Extra work</button><button type="button" data-flag-choice="estimate" class="is-selected">Part of estimate</button>';
      document.querySelector('#report-gaps').after(host);
      document.querySelector('.production-quantity').value='';updateReportGaps();showReportMessage('Enter a quantity for each work line.');
    });
    fs.mkdirSync('docs/daily-review-alerts',{recursive:true});
    for(const role of ['office','field'])for(const theme of ['light','dark'])for(const height of [500,844]){
      await page.setViewportSize({width:390,height});
      await page.evaluate(({role,theme})=>{currentRole=role;document.body.classList.toggle('field-mode',role==='field');document.documentElement.dataset.theme=theme;applyFieldReportLayout();},{role,theme});
      for(const selector of ['#report-submit-status','#report-gaps']){
        const style=await page.locator(selector).evaluate(el=>{const s=getComputedStyle(el);return [s.borderLeftColor,s.borderLeftWidth,s.color];});
        assert.deepEqual(style,['rgb(255, 46, 138)','6px',theme==='dark'?'rgb(255, 255, 255)':'rgb(0, 0, 0)']);
      }
      const colors=await page.locator('#alert-brand-fixture button').evaluateAll(els=>els.map(el=>{const s=getComputedStyle(el);return [s.color,s.backgroundColor,parseFloat(s.minHeight)];}));
      assert.deepEqual(colors.map(c=>c.slice(0,2)),[['rgb(255, 255, 255)','rgb(0, 0, 0)'],['rgb(0, 0, 0)','rgb(255, 102, 0)']]);
      assert(colors.every(c=>c[2]>=48),JSON.stringify({role,theme,height,colors}));
      await page.locator('#report-submit-status').evaluate(el=>el.scrollIntoView({block:'center'}));
      assert.equal(await page.locator('#report-submit-status').evaluate(el=>getComputedStyle(el).boxShadow),'none');
      await page.screenshot({path:`docs/daily-review-alerts/alert-${role}-${theme}-390x${height}.png`});
      assert(await page.locator('#report-modal').evaluate(el=>el.scrollWidth<=el.clientWidth+1));
    }
    assert.deepEqual(errors,[]);console.log('Daily alerts: missing quantity, brand colors, both roles/themes and phone heights passed.');
  } finally { await browser?.close();if(child?.exitCode==null)child.kill(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
