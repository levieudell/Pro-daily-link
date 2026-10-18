'use strict';
// Real rendered entry points, synthetic owner/admin sessions, no report writes.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net'),{spawn}=require('node:child_process');
const chrome=process.env.PDL_TEST_CHROME||(process.platform==='win32'?'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe':'/usr/bin/google-chrome-stable');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'pdl-office-entrypoints-'));
const file=path.join(root,'db.json');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function waitForBoot(page){await page.waitForFunction(()=>typeof currentUser!=='undefined'&&currentUser?.id&&typeof projects!=='undefined'&&projects.length&&document.documentElement.classList.contains('workspace-ready'));await page.waitForNetworkIdle({idleTime:300,timeout:20000})}
async function navigate(page,name){
 if(page.viewport().width<760&&!await page.$eval('#sidebar',el=>el.classList.contains('open')))await page.click('#menu-button');
 await page.waitForFunction(name=>{const r=document.querySelector('.nav-item[data-page="'+name+'"]').getBoundingClientRect();return r.width>0&&r.left>=0&&r.right<=innerWidth}, {},name);
 await page.click(`.nav-item[data-page="${name}"]`);
 await page.waitForSelector(`#${name}-page.active`);
}
async function assertOfficeEntry(page,selector,label){
 console.log('Checking '+label);
 // Honor the existing close/tap-through guard before a deliberate new click.
 await page.waitForFunction(()=>Date.now()>=suppressReportOpenUntil);
 await page.click(selector);await page.waitForSelector('#report-modal[open]');
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
