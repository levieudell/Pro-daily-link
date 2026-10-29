'use strict';
// Styling regression with disposable data and Chrome's synthetic microphone.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net'),{spawn}=require('node:child_process');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const root=fs.mkdtempSync(path.join(os.tmpdir(),'pdl-field-brand-'));
const shots=process.env.PDL_TEST_SCREENSHOTS||root;
async function settle(page){await page.evaluate(async()=>{await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));await Promise.all(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})))})}
async function shot(page,name){fs.mkdirSync(shots,{recursive:true});await page.screenshot({path:path.join(shots,`field-brand-${name}.png`)})}
async function contrast(page,selectors){
 const result=await page.evaluate(selectors=>{
  const ctx=document.createElement('canvas').getContext('2d',{willReadFrequently:true});
  const rgba=color=>{ctx.clearRect(0,0,1,1);ctx.fillStyle=color;ctx.fillRect(0,0,1,1);return [...ctx.getImageData(0,0,1,1).data]};
  const lum=rgb=>rgb.slice(0,3).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4}).reduce((s,v,i)=>s+v*[.2126,.7152,.0722][i],0);
  return selectors.flatMap(selector=>[...document.querySelectorAll(selector)].filter(el=>el.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})).map(el=>{
   let node=el,bg=[255,255,255,255];while(node){const color=rgba(getComputedStyle(node).backgroundColor);if(color[3]===255){bg=color;break}node=node.parentElement}
   const style=getComputedStyle(el),a=lum(rgba(style.color)),b=lum(bg);return{selector,text:el.textContent.trim().slice(0,60),color:style.color,bg,ancestor:node?.outerHTML.slice(0,240),ratio:(Math.max(a,b)+.05)/(Math.min(a,b)+.05)};
  }));
 },selectors);
 for(const item of result)assert(item.ratio>=4.5,'AA text '+JSON.stringify(item));
}
async function dailyBounds(page,label){
 await settle(page);
 const boxes=await page.evaluate(()=>{
  const modal=document.querySelector('#report-modal'),step=modal.querySelector('.report-step.active'),body=step.querySelector('.report-step-scroll'),footer=step.querySelector('.modal-actions'),m=modal.getBoundingClientRect();
  return{overflow:modal.scrollWidth-modal.clientWidth,bodyBottom:body.getBoundingClientRect().bottom,footerTop:footer.getBoundingClientRect().top,controls:[...footer.querySelectorAll('button')].filter(el=>el.checkVisibility()).map(el=>{const r=el.getBoundingClientRect(),hit=document.elementFromPoint(r.left+r.width/2,r.bottom-2);return{id:el.id,left:r.left,right:r.right,top:r.top,bottom:r.bottom,height:r.height,inside:r.left>=Math.max(0,m.left)&&r.right<=Math.min(innerWidth,m.right)&&r.bottom<=Math.min(innerHeight,m.bottom),hit:hit===el||el.contains(hit)}})};
 });
 assert(boxes.overflow<=1&&boxes.bodyBottom<=boxes.footerTop+.1,label+' body is separate from footer '+JSON.stringify(boxes));
 for(const c of boxes.controls)assert(c.inside&&c.hit&&c.height>=48,label+' complete action '+JSON.stringify(c));
 const legacy=await page.$$eval('#report-modal *',els=>els.filter(el=>el.checkVisibility?.()).flatMap(el=>['color','backgroundColor','borderColor','outlineColor'].filter(key=>['rgb(255, 107, 26)','rgb(23, 105, 224)','rgb(25, 115, 76)'].includes(getComputedStyle(el)[key])).map(key=>({id:el.id||el.className,key,value:getComputedStyle(el)[key]}))));assert.deepEqual(legacy,[],label+' has no old field colors');
}
(async()=>{
 const port=await new Promise(resolve=>{const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolve(port))})});
 const env={...process.env,PORT:String(port),PDL_STAGING:'1',PDL_STAGING_OWNER_PASSWORD:'brand-owner-pass',PDL_STAGING_FIELD_PASSWORD:'brand-field-pass',PDL_DB_FILE:path.join(root,'db.json'),PDL_PLATFORM_FILE:path.join(root,'platform.json'),PDL_SUPABASE_ENABLED:'0',PDL_TRANSACTIONAL_DB:'off',PDL_EMAIL_DEV_MODE:'1',OPENAI_API_KEY:''};
 for(const key of ['STRIPE_SECRET_KEY','STRIPE_WEBHOOK_SECRET','RESEND_API_KEY','INDEXNOW_KEY','SENTRY_DSN'])delete env[key];
 const server=spawn(process.execPath,['--require',require.resolve('./scripts/test-analytics-isolation.cjs'),'server.js'],{cwd:__dirname,env,windowsHide:true,stdio:['ignore','pipe','pipe']});let log='',browser;server.stdout.on('data',c=>log+=c);server.stderr.on('data',c=>log+=c);
 try{
  for(let i=0;i<200&&!log.includes('running at');i++)await sleep(100);assert(log.includes('running at'),'local server started');
  browser=await require('puppeteer-core').launch({executablePath:process.env.PDL_TEST_CHROME||(process.platform==='win32'?'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe':'/usr/bin/google-chrome-stable'),headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream']});
  const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.dismiss());
  await page.setViewport({width:390,height:844,isMobile:true,hasTouch:true});
  await page.evaluateOnNewDocument(()=>{
   localStorage.setItem('pdl-analytics-consent','declined');
   window.__officePaints=[];const sample=()=>{const el=document.querySelector('#dashboard-page');if(el?.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})){const r=el.getBoundingClientRect(),hit=document.elementFromPoint(Math.min(innerWidth-2,r.left+30),Math.min(innerHeight-2,r.top+30));if(hit&&(hit===el||el.contains(hit)))window.__officePaints.push(location.pathname)}requestAnimationFrame(sample)};requestAnimationFrame(sample);
  });
  await page.setRequestInterception(true);page.on('request',async request=>{
   if(request.url().includes('/api/ai/transcribe'))return request.respond({status:200,contentType:'application/json',body:JSON.stringify({text:'Formed east footing.'})});
   if(request.url().includes('/field-instant-daily.js'))await sleep(350);
   await request.continue();
  });
  await page.goto(`http://127.0.0.1:${port}/login.html`);await page.type('#email','levi+field@prodailylink.com');await page.type('#password','brand-field-pass');await page.click('form#login button.primary');
  await page.waitForSelector('#myday-page.active [data-start-day]');await page.waitForFunction(()=>document.documentElement.classList.contains('workspace-ready'));
  assert.deepEqual(await page.evaluate(()=>window.__officePaints),[],'field login never paints Overview, including delayed controller load');
  for(const theme of ['light','dark'])for(const height of [844,500]){
   await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);await page.setViewport({width:390,height,isMobile:true,hasTouch:true});await settle(page);
   const header=await page.$eval('.topbar',el=>{const s=getComputedStyle(el);return{height:el.getBoundingClientRect().height,bg:s.backgroundColor,border:s.borderBottomColor,overflow:document.documentElement.scrollWidth-innerWidth,mark:getComputedStyle(document.querySelector('#header-company-mark'),'::before').backgroundImage,icons:['#menu-button','#help-button'].map(sel=>document.querySelector(sel).getBoundingClientRect().toJSON())}});
   assert.equal(header.height,56);assert.equal(header.bg,'rgb(0, 0, 0)');assert.equal(header.border,'rgb(255, 102, 0)');assert(header.mark.includes('assets/pdl-monogram.svg'));assert(header.overflow<=1);for(const icon of header.icons){assert.equal(icon.width,44);assert.equal(icon.height,44)}
   await contrast(page,['#myday-page h1','#myday-page small','#myday-page span','#myday-page p','#myday-page button','#myday-page .field-assignment-map']);await shot(page,`myday-${theme}-390-${height}`);
  }
  await page.setViewport({width:1280,height:800});await page.waitForSelector('#myday-page.active [data-start-day]');await page.waitForFunction(()=>document.documentElement.classList.contains('workspace-ready'));await settle(page);
  const desktopMark=await page.$eval('#header-company-mark',el=>({visible:el.checkVisibility(),width:el.getBoundingClientRect().width,overflow:document.documentElement.scrollWidth-innerWidth}));assert(desktopMark.visible&&desktopMark.width>=140&&desktopMark.overflow<=1,'field desktop keeps the full lockup');await shot(page,'myday-desktop-1280-800');
  await page.setViewport({width:390,height:844,isMobile:true,hasTouch:true});
  await page.waitForSelector('#myday-page.active [data-start-day]');await page.waitForFunction(()=>document.documentElement.classList.contains('workspace-ready'));
  await page.click('[data-start-day]');await page.waitForSelector('#start-day-modal[open]');
  for(const box of await page.$$('#start-day-members input')){const keep=await box.evaluate(el=>/Jordan Reed/.test(el.closest('label').textContent));if(await box.evaluate(el=>el.checked)!==keep)await box.click()}
  await page.click('#confirm-start-day');await page.waitForFunction(()=>/Clock out/i.test(document.querySelector('#start-day-button').textContent));
  await page.waitForSelector('#myday-page.active [data-assignment-daily]');
  await page.waitForFunction(()=>!document.querySelector('#toast')?.classList.contains('visible'));
  await settle(page);
  await page.locator('#myday-page.active [data-assignment-daily]').click();
  await page.waitForSelector('#report-modal[open]');
  for(const theme of ['light','dark'])for(const height of [844,500]){
   await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);await page.setViewport({width:390,height,isMobile:true,hasTouch:true});await page.$eval('#field-notes',el=>el.focus());await dailyBounds(page,`${theme} ${height} notes focused`);
   const notes=await page.$eval('#field-notes',el=>({font:getComputedStyle(el).fontSize,ring:getComputedStyle(el).boxShadow}));assert.equal(notes.font,'16px');assert(notes.ring.includes('255, 102, 0'));
   await contrast(page,['#report-modal-title','#report-modal .report-job-heading h3','#report-modal dt','#report-modal dd','#voice-notes','#flag-extra-work','.daily-photos-label','#report-modal .input-help','#field-ai-disclosure','#report-next-step']);
   await page.$eval('.report-step.active .report-step-scroll',el=>el.scrollTop=0);await shot(page,`notes-${theme}-390-${height}`);
  }
  await page.locator('#voice-notes').click();await page.waitForFunction(()=>voiceNotesRecorder?.state==='recording');
  await dailyBounds(page,'listening at 390x500');await shot(page,'listening-390-500');await page.locator('#voice-capture-stop').click();await page.waitForFunction(()=>document.querySelector('#field-notes').value.includes('Formed east footing'));
  assert.equal(await page.$eval('#voice-notes',el=>el.getAttribute('aria-pressed')),'false');
  await page.locator('#report-next-step').click();await page.waitForFunction(()=>document.querySelector('#report-form').dataset.currentStep==='2');await page.waitForSelector('[data-pick-line]');
  for(const theme of ['light','dark'])for(const height of [844,500]){
   await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);await page.setViewport({width:390,height,isMobile:true,hasTouch:true});await dailyBounds(page,`${theme} ${height} review`);
   await contrast(page,['#report-modal .field-review-card small','#report-modal .field-review-card strong','#report-modal .field-review-card em','#report-modal .field-hours-card small','#report-modal .field-hours-card p','#report-modal .field-flag small','#report-modal .field-flag button','#report-back','#save-report']);
   await page.$eval('.report-step.active .report-step-scroll',el=>el.scrollTop=0);await shot(page,`review-${theme}-390-${height}`);
   await page.$eval('.field-flag',el=>el.scrollIntoView({block:'start'}));await dailyBounds(page,`${theme} ${height} pick/extra`);await shot(page,`pick-${theme}-390-${height}`);
  }
  await page.locator('#report-back').click();await page.waitForFunction(()=>document.querySelector('#report-form').dataset.currentStep==='1');
  await page.reload();await page.waitForFunction(()=>document.documentElement.classList.contains('workspace-ready'));assert.deepEqual(await page.evaluate(()=>window.__officePaints),[],'field restored session never paints Overview');
  assert.deepEqual(errors,[]);
  console.log('Field branding passed: both themes at 390x844 and focused 390x500, pinned actions, contrast, one-tap clock-in, actual synthetic microphone capture with mocked transcription, review/back, and no office flash on fresh/restored load.');
 }finally{await browser?.close();server.kill();await new Promise(resolve=>server.exitCode!=null?resolve():server.once('exit',resolve));if(root.startsWith(path.join(os.tmpdir(),'pdl-field-brand-')))fs.rmSync(root,{recursive:true,force:true})}
})().catch(error=>{console.error(error);process.exitCode=1});
