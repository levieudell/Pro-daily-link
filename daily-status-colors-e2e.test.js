'use strict';
// Real daily list, disposable synthetic owner session, no report writes.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net'),{spawn}=require('node:child_process');
const chrome=process.env.PDL_TEST_CHROME||(process.platform==='win32'?'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe':'/usr/bin/google-chrome-stable');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'pdl-daily-status-'));
fs.mkdirSync(path.join(__dirname,'qa-tmp'),{recursive:true});
const file=path.join(root,'db.json');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function waitForBoot(page){await page.waitForFunction(()=>typeof currentUser!=='undefined'&&currentUser?.id&&typeof projects!=='undefined'&&projects.length&&document.documentElement.classList.contains('workspace-ready')&&localStorage.getItem('pdl-role')==='office'&&document.querySelector('.page.active'));await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))}
(async()=>{
 const port=await new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p))})});
 const env={...process.env,PORT:String(port),PDL_STAGING:'1',PDL_STAGING_OWNER_PASSWORD:'synthetic-owner-pass',PDL_STAGING_FIELD_PASSWORD:'synthetic-field-pass',PDL_DB_FILE:file,PDL_PLATFORM_FILE:path.join(root,'platform.json'),PDL_SUPABASE_ENABLED:'0',PDL_TRANSACTIONAL_DB:'off',PDL_EMAIL_DEV_MODE:'1',OPENAI_API_KEY:''};
 for(const key of ['STRIPE_SECRET_KEY','STRIPE_WEBHOOK_SECRET','RESEND_API_KEY','INDEXNOW_KEY','SENTRY_DSN'])delete env[key];
 const child=spawn(process.execPath,['--require',require.resolve('./scripts/test-analytics-isolation.cjs'),'server.js'],{cwd:__dirname,env,windowsHide:true,stdio:['ignore','pipe','pipe']});let log='',browser;child.stdout.on('data',c=>log+=c);child.stderr.on('data',c=>log+=c);
 try{
  for(let n=0;n<200&&!log.includes('running at');n++)await sleep(100);assert.ok(log.includes('running at'),'synthetic server started: '+log);
  const db=JSON.parse(fs.readFileSync(file));const owner=db.users.find(u=>u.role==='owner');
  const reportCount=db.reports.length;
  browser=await require('puppeteer-core').launch({executablePath:chrome,headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
  const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'reduce'}]);
  await page.evaluateOnNewDocument(()=>localStorage.setItem('pdl-analytics-consent','declined'));
  await page.goto(`http://127.0.0.1:${port}/login.html`);await page.type('#email',owner.email);await page.type('#password','synthetic-owner-pass');await page.click('form#login button.primary');await waitForBoot(page);
  const statuses=['Draft','Needs review','Approved','Missing data','Needs correction','Submitted'];
  const synthetic=statuses.map((status,i)=>({...db.reports[0],id:9000+i,status,project:0,foreman:'Synthetic crew',dateIso:'2026-10-18',history:[],flags:[],laborEntries:[],productionEntries:[],extraWork:[]}));
  await page.setRequestInterception(true);page.on('request',request=>{if(new URL(request.url()).pathname==='/api/reports'&&request.method()==='GET')request.respond({status:200,contentType:'application/json',body:JSON.stringify(synthetic)});else request.continue()});
  await page.evaluate(()=>showPage('reports'));
  await page.waitForSelector('#reports-page.active');
  await page.waitForNetworkIdle();
  const luminance=rgb=>{const c=rgb.match(/\d+/g).slice(0,3).map(n=>{n=+n/255;return n<=.04045?n/12.92:((n+.055)/1.055)**2.4});return .2126*c[0]+.7152*c[1]+.0722*c[2]};
  for(const width of [390,1280])for(const theme of ['light','dark']){
   await page.setViewport({width,height:844,isMobile:width===390,hasTouch:width===390});
   await waitForBoot(page);await page.evaluate(()=>showPage('reports'));await page.waitForNetworkIdle();
  await page.evaluate(statuses=>{const base=reports[0]||{project:0,foreman:'Synthetic crew',dateIso:'2026-10-18'};reports=statuses.map((status,i)=>({...base,id:9000+i,status,summary:'Synthetic status example',history:[],flags:[],laborEntries:[],productionEntries:[],extraWork:[]}));document.querySelector('#report-status-filter').value='all';renderReports(9000)},statuses);
   await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
   const badges=await page.$$eval('#report-list .status',els=>els.map(el=>({text:el.textContent,bg:getComputedStyle(el).backgroundColor,fg:getComputedStyle(el).color})));
   assert.deepEqual(badges.map(x=>x.text).sort(),statuses.slice().sort());assert.equal(new Set(badges.map(x=>x.bg)).size,statuses.length);
   for(const b of badges){const a=luminance(b.bg),c=luminance(b.fg);assert.ok((Math.max(a,c)+.05)/(Math.min(a,c)+.05)>=4.5,`${theme} ${b.text} contrast`)}
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'no horizontal overflow');
   for(const i of [1,2,3,4,5,0]){
    await page.$eval(`[data-report="${9000+i}"]`,el=>el.scrollIntoView({behavior:'instant',block:'center'}));
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    await page.click(`[data-report="${9000+i}"]`);
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    assert.equal(await page.$eval('#report-list .active .status',el=>el.textContent),statuses[i]);
    assert.equal(await page.$eval('#report-detail>.status',el=>el.textContent),statuses[i]);
   }
   for(const status of ['Draft','Needs review','Missing data','Approved','all']){await page.select('#report-status-filter',status);assert.equal(await page.$$eval('#report-list .status',els=>els.length),status==='all'?6:1)}
   await page.evaluate(()=>renderReports(9001));await page.screenshot({path:`qa-tmp/daily-status-${width}-${theme}.png`,fullPage:true});
   console.log(`${width}px ${theme}: six distinct badges, WCAG AA text contrast, all selections, no overflow`);
  }
  await page.evaluate(()=>document.querySelector('#report-list button').focus());
  await page.keyboard.press('Tab');await page.keyboard.down('Shift');await page.keyboard.press('Tab');await page.keyboard.up('Shift');
  assert.equal(await page.$eval('#report-list button',el=>getComputedStyle(el).outlineWidth),'3px','keyboard focus visible');
  await page.keyboard.press('Enter');assert.equal(await page.$eval('#report-list .active',el=>el.dataset.report),'9005','keyboard selection');
  assert.deepEqual(errors,[]);assert.equal(JSON.parse(fs.readFileSync(file)).reports.length,reportCount,'no report writes');
 }finally{await browser?.close();child.kill();await new Promise(resolve=>child.exitCode!=null?resolve():child.once('exit',resolve));fs.rmSync(root,{recursive:true,force:true})}
})().catch(error=>{console.error(error);process.exitCode=1});
