'use strict';
// Real rendered entry points, synthetic owner/admin sessions, no report writes.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net'),{spawn}=require('node:child_process');
const chrome=process.env.PDL_TEST_CHROME||(process.platform==='win32'?'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe':'/usr/bin/google-chrome-stable');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'pdl-office-entrypoints-'));
const file=path.join(root,'db.json');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function waitForBoot(page){await page.waitForFunction(()=>typeof currentUser!=='undefined'&&currentUser?.id&&typeof projects!=='undefined'&&projects.length&&document.documentElement.classList.contains('workspace-ready')&&localStorage.getItem('pdl-role')==='office'&&document.querySelector('.page.active'));await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))}
async function navigate(page,name){
 await page.waitForFunction(()=>Date.now()>=suppressReportOpenUntil);
 if(page.viewport().width<760&&!await page.$eval('#sidebar',el=>el.classList.contains('open')))await page.click('#menu-button');
 await page.waitForFunction(name=>{const r=document.querySelector('.nav-item[data-page="'+name+'"]').getBoundingClientRect();return r.width>0&&r.left>=-1&&r.right<=innerWidth+1}, {},name);
 await page.locator(`.nav-item[data-page="${name}"]`).click();
 await page.waitForSelector(`#${name}-page.active`);
}
async function assertOfficeEntry(page,selector,label){
 if(page.viewport().width<760)await page.waitForFunction(()=>document.querySelector('#sidebar').getBoundingClientRect().right<=1);
 console.log('Checking '+label);
 // Honor the existing close/tap-through guard before a deliberate new click.
 await page.waitForFunction(()=>Date.now()>=suppressReportOpenUntil);
 await page.locator(selector).click();await page.waitForSelector('#report-modal[open]');
 const result=await page.evaluate(()=>{
  const modal=document.querySelector('#report-modal'),notes=document.querySelector('#field-notes'),voice=document.querySelector('#voice-notes'),rect=notes.getBoundingClientRect(),vr=voice.getBoundingClientRect();
  return{compact:modal.classList.contains('report-office-compact'),type:document.querySelector('#report-type').value,details:document.querySelector('#report-context-details').open,next:document.querySelector('#report-next-step').textContent,notesVisible:rect.height>0&&rect.top>=0&&rect.bottom<innerHeight-80,voiceVisible:vr.height>0&&vr.top>=0&&vr.bottom<innerHeight-80,clock:!!document.querySelector('#field-clock-out:not([hidden])')};
 });
 assert.equal(result.compact,true,label);assert.equal(result.type,'production',label);assert.equal(result.details,false,label);assert.equal(result.next,'Done',label);assert.equal(result.notesVisible,true,label+' notes visible');assert.equal(result.voiceVisible,true,label+' voice visible');assert.equal(result.clock,false,label);
 await page.click('#report-context-summary');await page.waitForSelector('#report-project',{visible:true});
 await page.select('#report-type','superintendent');
 assert.equal(await page.$eval('#report-modal',el=>el.classList.contains('report-office-compact')),false,label+' superintendent');assert.equal(await page.$eval('#report-context-details',el=>el.open),true,label+' superintendent details open');
 await page.click('#close-report');await page.waitForFunction(()=>!document.querySelector('#report-modal').open);
}
async function checkOfficeLayout(page,width,height,shot){
 await page.$eval('#report-modal',el=>Promise.all(el.getAnimations().map(animation=>animation.finished)));
 await page.setViewport({width,height,isMobile:page.viewport().isMobile,hasTouch:page.viewport().hasTouch});
 await page.evaluate(()=>{const modal=document.querySelector('#report-modal');modal.scrollTop=0;document.querySelector('#report-context-details').open=true;document.querySelector('#weather-summary').textContent='Heavy rain and gusty conditions at the north construction entrance';const crew=document.querySelector('#report-crew');crew.options[crew.selectedIndex].textContent='Concrete crew — north entrance and retaining wall';});
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 const layout=await page.evaluate(()=>{
  const modal=document.querySelector('#report-modal'),rect=el=>{const r=el.getBoundingClientRect();return{left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width}},date=document.querySelector('#report-date'),crew=document.querySelector('#report-crew'),weather=document.querySelector('.weather-row'),actions=document.querySelector('[data-report-step="1"] .modal-actions');
  return{modal:rect(modal),date:rect(date),crew:rect(crew),weather:rect(weather),buttons:[...weather.querySelectorAll('button')].map(rect),overflow:modal.scrollWidth-modal.clientWidth,position:getComputedStyle(actions).position};
 });
 assert(layout.overflow<=1,`${width}x${height} no horizontal overflow`);
 if(width<760){assert(layout.modal.left>=-1&&layout.modal.right<=width+1&&layout.modal.width>=width-1,'phone modal fills viewport '+JSON.stringify(layout.modal));assert(layout.crew.top>=layout.date.bottom,`${width} date and crew stack`);assert.equal(layout.position,'static','office actions scroll with content');}
 for(const r of [layout.date,layout.crew,...layout.buttons])assert(r.left>=layout.modal.left&&r.right<=layout.modal.right,`${width} controls stay within modal`);
 for(const selector of ['#report-date','#report-crew','#field-notes','#voice-notes','#report-photos','#report-next-step','#save-report-draft']){
  await page.$eval(selector,el=>el.scrollIntoView({block:'center'}));
  const hit=await page.$eval(selector,el=>{const r=el.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+Math.min(r.height/2,24),hit=document.elementFromPoint(x,y);return{ok:y>=0&&y<innerHeight&&(hit===el||el.contains(hit)),x,y,hit:hit?.outerHTML.slice(0,150)}});assert(hit.ok,`${width}x${height} ${selector} reachable ${JSON.stringify(hit)}`);
 }
 await page.$eval('#field-notes',el=>{el.focus();el.scrollIntoView({block:'center'})});
 if(shot){await page.$eval('#field-notes',el=>el.blur());await page.$eval('#report-modal form',el=>el.scrollTop=0);const directory=process.env.PDL_TEST_SCREENSHOTS||root;fs.mkdirSync(directory,{recursive:true});await page.screenshot({path:path.join(directory,`office-expanded-${width}-${height}.png`)});}
}
(async()=>{
 const port=await new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p))})});
 const env={...process.env,PORT:String(port),PDL_STAGING:'1',PDL_STAGING_OWNER_PASSWORD:'synthetic-owner-pass',PDL_STAGING_FIELD_PASSWORD:'synthetic-field-pass',PDL_DB_FILE:file,PDL_PLATFORM_FILE:path.join(root,'platform.json'),PDL_SUPABASE_ENABLED:'0',PDL_TRANSACTIONAL_DB:'off',PDL_EMAIL_DEV_MODE:'1',OPENAI_API_KEY:''};
 for(const key of ['STRIPE_SECRET_KEY','STRIPE_WEBHOOK_SECRET','RESEND_API_KEY','INDEXNOW_KEY','SENTRY_DSN'])delete env[key];
 const child=spawn(process.execPath,['--require',require.resolve('./scripts/test-analytics-isolation.cjs'),'server.js'],{cwd:__dirname,env,windowsHide:true,stdio:['ignore','pipe','pipe']});let log='',browser;child.stdout.on('data',c=>log+=c);child.stderr.on('data',c=>log+=c);
 try{
  for(let n=0;n<200&&!log.includes('running at');n++)await sleep(100);assert.ok(log.includes('running at'),'synthetic server started: '+log);
  const db=JSON.parse(fs.readFileSync(file));const owner=db.users.find(u=>u.role==='owner');
  // Both passwords and identities originate in this disposable seed only.
  db.users.push({...owner,id:Math.max(...db.users.map(u=>Number(u.id)))+1,role:'admin',name:'Synthetic administrator',email:'synthetic-admin@example.test'});fs.writeFileSync(file,JSON.stringify(db));
  const reportCount=db.reports.length;
  browser=await require('puppeteer-core').launch({executablePath:chrome,headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
  {
   const context=await browser.createBrowserContext(),page=await context.newPage();page.on('dialog',d=>d.accept());
   await page.setViewport({width:390,height:844,isMobile:true,hasTouch:true});await page.evaluateOnNewDocument(()=>localStorage.setItem('pdl-analytics-consent','declined'));
   await page.goto(`http://127.0.0.1:${port}/login.html`);await page.type('#email',owner.email);await page.type('#password','synthetic-owner-pass');await page.click('form#login button.primary');await waitForBoot(page);
   const commandCenter=await page.evaluate(()=>{const priority=document.querySelector('.command-priority'),setup=document.querySelector('.setup-checklist'),production=document.querySelector('.production-panel'),team=document.querySelector('.nav-item[data-page="team"]'),shell=document.querySelector('.app-shell');return{priorityDisplay:getComputedStyle(priority).display,setupDisplay:getComputedStyle(setup).display,productionDisplay:getComputedStyle(production).display,teamDisplay:getComputedStyle(team).display,overflow:document.documentElement.scrollWidth-innerWidth,activePage:document.querySelector('.page.active')?.id||'',role:typeof currentRole==='undefined'?'':currentRole,hash:location.hash,shellHidden:Boolean(shell?.hidden)}});
   assert.ok(commandCenter.priorityDisplay==='grid'||commandCenter.setupDisplay!=='none','phone Overview serves the canonical command center or its first-run setup path: '+JSON.stringify(commandCenter));assert.equal(commandCenter.productionDisplay,'none','the duplicate production chart lives in Insights, not Overview');assert.notEqual(commandCenter.teamDisplay,'none','Team remains a first-class destination');assert.ok(commandCenter.overflow<=1,'phone Overview has no horizontal overflow');
   await page.click('.top-actions [data-open-report]');await page.waitForSelector('#report-modal[open]');
   for(const width of [320,375,390,430,1280]){await checkOfficeLayout(page,width,844,true);if(width<760)await checkOfficeLayout(page,width,390,true);}
   await page.evaluate(()=>showReportStep(2));
   for(const width of [320,375,390,430,1280]){
    await page.setViewport({width,height:width<760?390:844,isMobile:true,hasTouch:true});
    for(const selector of ['#report-signature','#save-report-step2-draft','#save-report']){await page.$eval(selector,el=>{el.scrollIntoView({block:'center'});if(el.tagName==='INPUT')el.focus()});assert(await page.$eval(selector,el=>{const r=el.getBoundingClientRect(),hit=document.elementFromPoint(r.left+r.width/2,r.top+Math.min(r.height/2,24));return hit===el||el.contains(hit)}),`${width} review ${selector} reachable`)}
    assert(await page.$eval('#report-modal',el=>el.scrollWidth<=el.clientWidth+1),`${width} review no horizontal overflow`);
    if(process.env.PDL_TEST_SCREENSHOTS)await page.screenshot({path:path.join(process.env.PDL_TEST_SCREENSHOTS,`office-review-${width}.png`)});
   }
   await page.setViewport({width:390,height:844,isMobile:true,hasTouch:true});await page.$eval('#close-report',el=>el.scrollIntoView({block:'center'}));await page.click('#close-report');await page.waitForFunction(()=>Date.now()>=suppressReportOpenUntil);await page.evaluate(()=>openReport());assert.equal(await page.$eval('#report-context-details',el=>el.open),false,'reopening keeps notes-first default');
   if(process.env.PDL_TEST_SCREENSHOTS){fs.mkdirSync(process.env.PDL_TEST_SCREENSHOTS,{recursive:true});for(const name of fs.readdirSync(root).filter(name=>name.endsWith('.png')))fs.copyFileSync(path.join(root,name),path.join(process.env.PDL_TEST_SCREENSHOTS,name));}
   await context.close();
  }
  {
   const context=await browser.createBrowserContext(),page=await context.newPage();let release;page.on('pageerror',e=>console.log('Slow boot error',e.message));
   await page.setViewport({width:390,height:844,isMobile:true,hasTouch:true});await page.evaluateOnNewDocument(()=>localStorage.setItem('pdl-analytics-consent','declined'));await page.setRequestInterception(true);page.on('request',request=>{if(request.url().includes('/field-instant-daily.js'))release=()=>request.continue();else request.continue()});
   await page.goto('http://127.0.0.1:'+port+'/login.html');await page.type('#email',owner.email);await page.type('#password','synthetic-owner-pass');await page.click('form#login button.primary');
   for(let attempt=0;attempt<1500&&!release;attempt++)await sleep(20);
   assert.ok(release,'shared report controller requested within 30 seconds');
   await sleep(300);
   assert.equal(await page.evaluate(()=>document.documentElement.classList.contains('workspace-ready')),false,'slow controller cannot expose legacy New Daily');
   release();await waitForBoot(page);await assertOfficeEntry(page,'.top-actions [data-open-report]','delayed shared controller');await context.close();
  }
  for(const role of ['owner','admin'])for(const width of [390,1280]){
   const context=await browser.createBrowserContext(),page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
   await page.setViewport({width,height:844,isMobile:width===390,hasTouch:width===390});await page.evaluateOnNewDocument(()=>localStorage.setItem('pdl-analytics-consent','declined'));
   await page.goto(`http://127.0.0.1:${port}/login.html`);await page.type('#email',role==='owner'?owner.email:'synthetic-admin@example.test');await page.type('#password','synthetic-owner-pass');await page.click('form#login button.primary');await waitForBoot(page);
   assert.equal(await page.evaluate(()=>currentUser.role),role);
   for(const restored of [false,true]){
    if(restored){await page.reload({waitUntil:'domcontentloaded'});await waitForBoot(page)}
    if(await page.$eval('#report-modal',el=>el.open))await page.click('#close-report');
    await navigate(page,'dashboard');await assertOfficeEntry(page,'.top-actions [data-open-report]',`${role} ${width} restored=${restored} dashboard`);
    await navigate(page,'reports');await assertOfficeEntry(page,'#reports-page [data-open-report]',`${role} ${width} restored=${restored} reports`);
   }
   assert.deepEqual(errors,[]);await context.close();
  }
  assert.equal(JSON.parse(fs.readFileSync(file)).reports.length,reportCount,'entry-point tests never create records');
  console.log('Office actual buttons: owner/admin, mobile/desktop, fresh/restored session, dashboard/reports, notes/voice visible and superintendent escape passed. No report writes.');
 }finally{await browser?.close();child.kill();await new Promise(resolve=>child.exitCode!=null?resolve():child.once('exit',resolve));fs.rmSync(root,{recursive:true,force:true})}
})().catch(error=>{console.error(error);process.exitCode=1});
