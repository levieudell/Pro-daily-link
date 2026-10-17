'use strict';
// Entirely local synthetic tenant: office compact review must not import raw punches.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net');
const {spawn}=require('node:child_process');
const chrome=process.env.PDL_TEST_CHROME||(process.platform==='win32'?'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe':'/usr/bin/google-chrome-stable');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'pdl-office-daily-'));
const shotRoot=process.env.PDL_TEST_SCREENSHOTS||path.join(os.tmpdir(),'pdl-office-daily-shots');
const note='Poured 40 LF of curb on north side, used 6 yards of concrete. Tomorrow form the east side.';
async function freePort(){return new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const port=s.address().port;s.close(()=>resolve(port))})})}
async function visible(page,selector){return page.$eval(selector,el=>!el.hidden&&getComputedStyle(el).display!=='none'&&el.getBoundingClientRect().height>0)}
async function set(page,selector,value,event='input'){await page.$eval(selector,(el,{value,event})=>{el.value=value;el.dispatchEvent(new Event(event,{bubbles:true}))},{value,event})}
async function run(){
 const port=await freePort(),env={...process.env,PORT:String(port),PDL_STAGING:'1',PDL_STAGING_OWNER_PASSWORD:'synthetic-owner-pass',PDL_STAGING_FIELD_PASSWORD:'synthetic-field-pass',PDL_DB_FILE:path.join(root,'db.json'),PDL_PLATFORM_FILE:path.join(root,'platform.json'),PDL_EMAIL_DEV_MODE:'1',PDL_SUPABASE_ENABLED:'0',PDL_TRANSACTIONAL_DB:'off',OPENAI_API_KEY:''};
 for(const key of ['STRIPE_SECRET_KEY','STRIPE_WEBHOOK_SECRET','RESEND_API_KEY','INDEXNOW_KEY','SENTRY_DSN'])delete env[key];
 const child=spawn(process.execPath,['--require',require.resolve('./scripts/test-analytics-isolation.cjs'),'server.js'],{cwd:__dirname,env,stdio:['ignore','pipe','pipe']});
 let log='',browser,page;child.stdout.on('data',c=>log+=c);child.stderr.on('data',c=>log+=c);
 try{
  await new Promise((resolve,reject)=>{const start=Date.now();const poll=()=>log.includes('running at')?resolve():child.exitCode!=null||Date.now()-start>20000?reject(Error(log)):setTimeout(poll,100);poll()});
  browser=await require('puppeteer-core').launch({executablePath:chrome,headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
  page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
  await page.setViewport({width:390,height:844,isMobile:true,hasTouch:true});
  await page.evaluateOnNewDocument(()=>localStorage.setItem('pdl-analytics-consent','declined'));
  await page.goto(`http://127.0.0.1:${port}/login.html`);
  await set(page,'#email','levi+owner@prodailylink.com');await set(page,'#password','synthetic-owner-pass');await page.click('form#login button.primary');
  await page.waitForFunction(()=>typeof currentRole!=='undefined'&&currentRole==='office'&&projects.length>0);
  await page.evaluate(()=>new Promise(resolve=>{const before=restoreInterruptedReport;restoreInterruptedReport=async function(){try{return await before()}finally{resolve()}};setTimeout(resolve,1500)}));
  await page.evaluate(()=>{openReport();$('#report-project').value=String(projects.findIndex(p=>/Cedar Grove/.test(p.name)));$('#report-project').dispatchEvent(new Event('change',{bubbles:true}));});
  await page.waitForFunction(()=>reportLaborLoadedKey===reportLaborSelectionKey());
  assert.equal(await page.$eval('#report-next-step',e=>e.textContent),'Done');
  for(const selector of ['#report-project-picker','#report-date-field','#report-crew-field','#report-photos','#save-report-draft'])assert.equal(await visible(page,selector),true,selector);
  assert.equal(await page.$('#field-clock-out'),null,'office has no clock action');
  // Inject raw unapproved punches in browser memory only; approved/manual inputs must win.
  await page.evaluate(()=>{const member=team[0];timeCards.push({id:999999,memberId:member.id,projectId:projects[+$('#report-project').value].id,date:$('#report-date').value,inAt:'2026-10-17T00:00:00Z',outAt:'2026-10-17T23:00:00Z',status:'draft'});populateReportLabor([{memberId:member.id,hours:2}]);});
  await set(page,'#field-notes',note);
  await page.evaluate(()=>$('#report-next-step').click());
  await page.waitForFunction(()=>$('#report-form').getAttribute('data-current-step')==='2'&&!$('#report-next-step').disabled);
  const context=await page.evaluate(()=>fieldLaborContext());assert.deepEqual(context.punches,[]);assert.equal(context.total.total,2);
  assert.equal(await page.$$eval('.production-entry',rows=>rows.some(r=>r.querySelector('.production-item')?.value)),true);
  assert.equal(await visible(page,'#field-review-cards'),true);
  assert.equal(await visible(page,'#save-report-step2-draft'),true);assert.equal(await visible(page,'.labor-fieldset'),true);assert.equal(await visible(page,'#report-more'),true);
  assert.equal(await page.$eval('#field-review-cards',e=>/Clock out|No punch/.test(e.innerText)),false);
  await page.evaluate(()=>{const row=$$('.production-entry')[0];row.querySelector('.production-quantity').value='37';row.querySelector('.production-quantity').dispatchEvent(new Event('input',{bubbles:true}));});
  await set(page,'#report-summary','Office edited summary');await set(page,'#report-signature','Synthetic signer');
  await page.evaluate(()=>$('#save-report-step2-draft').click());await page.waitForFunction(()=>!$('#report-modal').open);
  const saved=await page.evaluate(()=>reports.find(r=>r.summary==='Office edited summary'));
  assert.ok(saved?.id,'draft saved');assert.equal(saved.productionEntries[0].quantity,37);assert.equal(saved.laborEntries.reduce((s,r)=>s+r.hours,0),2);
  await page.evaluate(id=>openReport(reports.find(r=>r.id===id)),saved.id);
  await page.evaluate(()=>$('#report-next-step').click());await page.waitForFunction(()=>$('#report-form').getAttribute('data-current-step')==='2');
  assert.equal(await page.$eval('.production-quantity',e=>e.value),'37','saved edit survives reopen/Done');
  assert.equal(await page.$eval('#report-summary',e=>e.value),'Office edited summary');
  await page.evaluate(()=>{company.features.templates=true;company.requireReportSignature=true;$('#report-signature').value='';});
  await page.evaluate(()=>$('#save-report').click());await page.waitForFunction(()=>/signature/i.test($('#report-submit-status').textContent));
  assert.equal(await page.$eval('#report-modal',e=>e.open),true,'required signature blocks send');
  await set(page,'#report-signature','Synthetic signer');
  await page.evaluate(()=>{const field=document.createElement('input');field.dataset.customRequired='true';field.dataset.customType='text';field.dataset.customLabel='Synthetic required answer';$('#report-custom-fields').append(field)});
  await page.evaluate(()=>$('#save-report').click());await page.waitForFunction(()=>/Synthetic required answer/.test($('#report-submit-status').textContent));
  fs.mkdirSync(shotRoot,{recursive:true});await page.screenshot({path:path.join(shotRoot,'office-review-390.png')});
  // Changing context or leaving must ignore a late AI response.
  await page.evaluate(()=>{company.features.templates=false;$('#report-modal').close();openReport();});
  await page.waitForFunction(()=>reportLaborLoadedKey===reportLaborSelectionKey());
  await set(page,'#field-notes',note);
  await page.evaluate(()=>{window.__api=api;api=async function(url,opts){if(url==='/api/ai/extract')return new Promise(resolve=>window.__late=()=>resolve({summary:'STALE RESPONSE',scopeReview:{lines:[],flags:[]}}));return window.__api(url,opts)};$('#report-next-step').click()});
  await page.waitForFunction(()=>typeof window.__late==='function');
  await set(page,'#report-date','2026-10-01','change');await page.evaluate(()=>window.__late());
  await page.waitForFunction(()=>!$('#report-next-step').disabled);
  assert.notEqual(await page.$eval('#report-summary',e=>e.value),'STALE RESPONSE');
  assert.equal(await page.$eval('#report-form',e=>e.getAttribute('data-current-step')),'1');
  // Failed extraction still opens editable manual review.
  await page.evaluate(()=>{api=async function(url,opts){if(url==='/api/ai/extract')throw Error('Synthetic AI failure');return window.__api(url,opts)};$('#report-next-step').click()});
  await page.waitForFunction(()=>$('#report-form').getAttribute('data-current-step')==='2'&&!$('#report-next-step').disabled);
  assert.equal(await visible(page,'#report-more'),true);assert.equal(await visible(page,'.labor-fieldset'),true);
  await page.evaluate(()=>{api=window.__api;$('#report-modal').close();openReport();$('#report-type').value='superintendent';$('#report-type').dispatchEvent(new Event('change',{bubbles:true}));});
  assert.equal(await page.$eval('#report-modal',e=>e.classList.contains('report-field-compact')),false,'superintendent unchanged');
  assert.equal(await visible(page,'#superintendent-safety'),false,'superintendent safety is on second step');
  await page.evaluate(()=>$('#report-next-step').click());assert.equal(await visible(page,'#superintendent-safety'),true);
  assert.deepEqual(errors,[]);console.log('Office daily browser flow passed: compact create/review, office controls, raw punch exclusion, draft/edit/reopen, required fields, stale AI, manual fallback, superintendent.');
 }catch(error){if(page){console.error('Office failure:',error);console.error(await page.evaluate(()=>({step:$('#report-form')?.getAttribute('data-current-step'),status:$('#report-submit-status')?.textContent,toast:$('#toast')?.textContent,notes:$('#field-notes')?.value})).catch(()=>({}))); fs.mkdirSync(shotRoot,{recursive:true});await page.screenshot({path:path.join(shotRoot,'office-failure.png')}).catch(()=>{})}console.error(log.slice(-2500));throw error}
 finally{if(browser)await browser.close();child.kill();await new Promise(resolve=>child.exitCode!==null?resolve():child.once('exit',resolve));fs.rmSync(root,{recursive:true,force:true})}
}
run().catch(error=>{console.error(error);process.exitCode=1});
