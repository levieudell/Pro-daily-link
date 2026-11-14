'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net');
const {spawn}=require('node:child_process');
let chromium;
for(const dependency of ['playwright','playwright-core',process.env.PDL_PLAYWRIGHT_MODULE,path.join(os.homedir(),'.cache','codex-runtimes','codex-primary-runtime','dependencies','node','node_modules','playwright')].filter(Boolean)){try{chromium=require(dependency).chromium;break}catch{}}
if(!chromium)throw new Error('Configure PDL_PLAYWRIGHT_MODULE with an available Playwright runtime.');
const browserPath=process.env.PDL_BROWSER_PATH||['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','/usr/bin/google-chrome-stable','/usr/bin/chromium'].find(file=>fs.existsSync(file));
const fieldEmail='levi+field@prodailylink.com',fieldPassword='staging-field-pass';
const freePort=()=>new Promise((resolve,reject)=>{const probe=net.createServer();probe.listen(0,'127.0.0.1',()=>{const port=probe.address().port;probe.close(error=>error?reject(error):resolve(port))})});

(async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'pdl-day-flags-browser-')),port=await freePort(),env={...process.env,PORT:String(port),PDL_STAGING:'1',PDL_STAGING_FIELD_PASSWORD:fieldPassword,PDL_STAGING_OWNER_PASSWORD:'staging-owner-pass',PDL_DB_FILE:path.join(root,'db.json'),PDL_PLATFORM_FILE:path.join(root,'platform.json'),PDL_REQUIRE_AUTH:'1',PDL_EMAIL_DEV_MODE:'1',PDL_SUPABASE_ENABLED:'0',PDL_TRANSACTIONAL_DB:'off',OPENAI_API_KEY:''};
 for(const key of ['STRIPE_SECRET_KEY','STRIPE_WEBHOOK_SECRET','RESEND_API_KEY','INDEXNOW_KEY','SENTRY_DSN'])delete env[key];
 const child=spawn(process.execPath,['server.js'],{cwd:__dirname,env,stdio:['ignore','pipe','pipe']});let log='',browser;
 child.stdout.on('data',chunk=>{log+=chunk});child.stderr.on('data',chunk=>{log+=chunk});
 try{
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Server startup timed out: '+log)),20000),poll=()=>{if(log.includes('running at')){clearTimeout(timer);resolve()}else if(child.exitCode!=null){clearTimeout(timer);reject(new Error('Server exited: '+log))}else setTimeout(poll,100)};poll()});
  browser=await chromium.launch({headless:true,...(browserPath?{executablePath:browserPath}:{})});
  const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>localStorage.setItem('pdl-analytics-consent','declined'));
  await page.goto(`http://127.0.0.1:${port}/login.html`);
  await page.locator('#email').fill(fieldEmail);await page.locator('#password').fill(fieldPassword);await page.locator('#login button[type=submit]').click();
  await page.waitForURL('**/app?**',{timeout:20000});await page.waitForFunction(()=>typeof currentRole!=='undefined'&&currentRole==='field'&&projects.length>0);

  async function open(date){await page.evaluate(date=>{openReport(null,{projectIndex:0,dateIso:date});$('#field-notes').value='No field activity was recorded for this daily.';$('#field-notes').dispatchEvent(new Event('input',{bubbles:true}))},date);await page.locator('#report-modal[open] #field-notes').waitFor()}
  async function submit(){if(await page.locator('#report-form').getAttribute('data-current-step')!=='2'){await page.locator('#report-next-step').click();await page.waitForFunction(()=>document.querySelector('#report-form')?.getAttribute('data-current-step')==='2')}await page.locator('#report-signature').evaluate(input=>{input.value='Synthetic field user';input.dispatchEvent(new Event('input',{bubbles:true}))});await page.locator('#save-report').click();await page.locator('#report-sent-modal[open]').waitFor({timeout:20000});await page.locator('#report-sent-modal button.primary').click();await page.waitForFunction(()=>!document.querySelector('#report-modal')?.open)}

  await open('2026-11-13');
  const weatherTarget=await page.locator('#report-weather-day').evaluate(input=>({text:input.closest('label').textContent.trim(),height:input.closest('label').getBoundingClientRect().height}));assert.equal(weatherTarget.text,'Weather day');assert.ok(weatherTarget.height>=44,JSON.stringify(weatherTarget));
  await page.locator('#report-weather-day').click();await page.locator('#report-next-step').click();await page.waitForFunction(()=>document.querySelector('#report-form')?.getAttribute('data-current-step')==='2');
  const delayTarget=await page.locator('#report-delay-day').evaluate(input=>({text:input.closest('label').textContent.trim(),height:input.closest('label').getBoundingClientRect().height}));assert.equal(delayTarget.text,'Delay day');assert.ok(delayTarget.height>=44,JSON.stringify(delayTarget));await page.locator('#report-delay-day').click();
  const fit=await page.locator('#report-form').evaluate(el=>({scroll:el.scrollWidth,width:el.clientWidth}));assert.ok(fit.scroll<=fit.width+1,JSON.stringify(fit));
  await submit();
  const flagged=await page.evaluate(()=>reports.find(report=>report.dateIso==='2026-11-13'));assert.equal(flagged.weatherDay,true);assert.equal(flagged.delayDay,true);
  await page.evaluate(id=>openReport(reports.find(report=>Number(report.id)===Number(id))),flagged.id);assert.equal(await page.locator('#report-weather-day').isChecked(),true);assert.equal(await page.locator('#report-delay-day').isChecked(),true);await page.evaluate(()=>document.querySelector('#report-modal')?.close());
  await page.evaluate(id=>openDailyReportDetails(id),flagged.id);await page.locator('#daily-details-modal[open]').waitFor();assert.match(await page.locator('#daily-details-modal').innerText(),/Weather day/);assert.match(await page.locator('#daily-details-modal').innerText(),/Delay day/);await page.locator('#close-daily-details').click();

  await open('2026-11-14');assert.equal(await page.locator('#report-weather-day').isChecked(),false);assert.equal(await page.locator('#report-delay-day').isChecked(),false);await submit();
  const unflagged=await page.evaluate(()=>reports.find(report=>report.dateIso==='2026-11-14'));assert.equal(unflagged.weatherDay,false);assert.equal(unflagged.delayDay,false);
  assert.deepEqual(errors,[]);console.log('Daily weather/delay flag browser passed at 390px: field taps, submit, reopen, read-only tags, off-state submit, and no horizontal overflow.');
 }finally{await browser?.close();child.kill();const resolved=path.resolve(root);if(resolved.startsWith(path.resolve(os.tmpdir())+path.sep))fs.rmSync(resolved,{recursive:true,force:true})}
})().catch(error=>{console.error(error);process.exitCode=1});
