'use strict';
// Real rendered entry points, synthetic owner/admin sessions, no report writes.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net'),{spawn}=require('node:child_process');
const {navigateOffice:navigate,assertNoGlobalOfficeDaily,openOfficeProjectDaily}=require('./scripts/test-office-project-navigation.cjs');
const chrome=process.env.PDL_TEST_CHROME||(process.platform==='win32'?'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe':'/usr/bin/google-chrome-stable');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'pdl-office-entrypoints-'));
const file=path.join(root,'db.json');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function waitForBoot(page){await page.waitForFunction(()=>typeof currentUser!=='undefined'&&currentUser?.id&&typeof projects!=='undefined'&&projects.length&&document.documentElement.classList.contains('workspace-ready')&&localStorage.getItem('pdl-role')==='office'&&document.querySelector('.page.active'));await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))}
async function assertDailyActionsVisible(page,label){
 assert.equal(await page.$eval('#report-modal',el=>el.open),true,label+' dialog stays open');
 await page.$eval('#report-modal',el=>Promise.all(el.getAnimations().map(animation=>animation.finished)));
 const layout=await page.evaluate(()=>{
  const actions=document.querySelector('#report-modal .report-step.active .modal-actions'),modal=document.querySelector('#report-modal').getBoundingClientRect();
  return [actions,...actions.querySelectorAll('button')].filter(el=>el.checkVisibility()).map(el=>{
   const r=el.getBoundingClientRect(),hit=document.elementFromPoint(r.left+r.width/2,r.bottom-2);
   return{name:el.id||'action bar',left:r.left,right:r.right,top:r.top,bottom:r.bottom,inside:r.left>=Math.max(0,modal.left)&&r.right<=Math.min(innerWidth,modal.right)&&r.top>=Math.max(0,modal.top)&&r.bottom<=Math.min(innerHeight,modal.bottom),reachable:hit===el||el.contains(hit)};
  });
 });
 assert(layout.length>=3,label+' action bar and both buttons are rendered');
 for(const control of layout)assert(control.inside&&control.reachable,label+' '+JSON.stringify(control));
 const oldBlue=await page.$$eval('#report-modal *',elements=>elements.filter(el=>el.checkVisibility?.()).filter(el=>['color','backgroundColor','borderColor','outlineColor'].some(key=>getComputedStyle(el)[key]==='rgb(23, 105, 224)')).map(el=>el.id||el.className));
 assert.deepEqual(oldBlue,[],label+' has no outdated blue');
}
async function assertProductionContrast(page){
 for(const theme of ['dark','light']){
  await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
  await page.$eval('.production-details-link',el=>Promise.all(el.getAnimations().map(animation=>animation.finished)));
  const contrast=await page.$eval('.production-details-link',el=>{
   // Resolve CSS color-mix values to sRGB before measuring rendered contrast.
   const ctx=document.createElement('canvas').getContext('2d',{willReadFrequently:true});
   const luminance=color=>{ctx.clearRect(0,0,1,1);ctx.fillStyle=color;ctx.fillRect(0,0,1,1);const rgb=[...ctx.getImageData(0,0,1,1).data].slice(0,3).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4});return rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722};
   const style=getComputedStyle(el),text=luminance(style.color),background=luminance(style.backgroundColor);
   return{color:style.color,background:style.backgroundColor,ratio:(Math.max(text,background)+.05)/(Math.min(text,background)+.05)};
  });
  assert(contrast.ratio>=4.5,theme+' production details readable '+JSON.stringify(contrast));
 }
}
async function assertBrandContrast(page,selectors){
 const colors=await page.evaluate(selectors=>{
  const ctx=document.createElement('canvas').getContext('2d',{willReadFrequently:true});
  const rgb=color=>{ctx.clearRect(0,0,1,1);ctx.fillStyle=color;ctx.fillRect(0,0,1,1);return [...ctx.getImageData(0,0,1,1).data]};
  const luminance=values=>values.slice(0,3).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4}).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);
  return selectors.flatMap(selector=>[...document.querySelectorAll(selector)].filter(el=>el.checkVisibility()).map(el=>{
   const style=getComputedStyle(el);let node=el,background;
   while(node){background=rgb(getComputedStyle(node).backgroundColor);if(background[3]===255)break;node=node.parentElement}
   const fg=luminance(rgb(style.color)),bg=luminance(background),ratio=(Math.max(fg,bg)+.05)/(Math.min(fg,bg)+.05);
   return{selector,color:style.color,background,ratio};
  }));
 },selectors);
 for(const color of colors)assert(color.ratio>=4.5,'brand text contrast '+JSON.stringify(color));
}
async function checkOfficeBrandMatrix(page){
 const sizes=[[1280,800],[1440,900],[390,844],[390,500]];
 for(const theme of ['light','dark']){
  await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
  await navigate(page,'dashboard');
  for(const [width,height] of sizes){
   await page.setViewport({width,height,isMobile:true,hasTouch:true});
   await page.$eval('#sidebar',el=>Promise.all(el.getAnimations().map(animation=>animation.finished)));
   const header=await page.$eval('.topbar',el=>{const s=getComputedStyle(el),r=el.getBoundingClientRect();return{height:r.height,background:s.backgroundColor,border:s.borderBottomColor,borderWidth:s.borderBottomWidth,shadow:s.boxShadow,overflow:document.documentElement.scrollWidth-innerWidth,help:document.querySelector('#help-button').getBoundingClientRect().toJSON(),menu:document.querySelector('#menu-button').getBoundingClientRect().toJSON(),brand:getComputedStyle(document.querySelector('#header-company-mark'),'::before').backgroundImage}});
   assert.equal(header.height,56);assert.equal(header.background,'rgb(0, 0, 0)');assert.equal(header.border,'rgb(255, 102, 0)');assert.equal(header.borderWidth,'3px');assert.equal(header.shadow,'none');assert(header.overflow<=1);
   assert.equal(header.help.width,44);assert.equal(header.help.height,44);
   if(width===390){assert.equal(header.menu.width,44);assert.equal(header.menu.height,44);assert(header.brand.includes('assets/pdl-monogram.svg'))}
   await assertBrandContrast(page,['.office-topbar-label small','#office-page-name','#help-button','#menu-button']);
   if(process.env.PDL_TEST_SCREENSHOTS)await page.screenshot({path:path.join(process.env.PDL_TEST_SCREENSHOTS,`office-header-${theme}-${width}-${height}.png`)});
  }
  await openOfficeProjectDaily(page);
  assert.equal(await page.$eval('#office-page-name',el=>el.textContent),'Projects','header follows existing navigation');
  assert.equal(await page.$eval('#report-modal-title',el=>el.textContent),'New daily');
  for(const [width,height] of sizes){
   await page.setViewport({width,height,isMobile:true,hasTouch:true});
   await page.$eval('#sidebar',el=>Promise.all(el.getAnimations().map(animation=>animation.finished)));
   await page.$eval('#report-context-details',el=>el.open=false);
   await page.$eval('#report-modal .report-step.active .report-step-scroll',el=>el.scrollTop=0);
   await assertDailyActionsVisible(page,`${theme} ${width}x${height} initial footer`);
   const layout=await page.evaluate(()=>{
    const modal=document.querySelector('#report-modal'),body=modal.querySelector('.report-step.active .report-step-scroll'),actions=modal.querySelector('.report-step.active .modal-actions'),r=modal.getBoundingClientRect();
    return{top:r.top,bottom:r.bottom,bodyBottom:body.getBoundingClientRect().bottom,actionsTop:actions.getBoundingClientRect().top,formOverflow:getComputedStyle(document.querySelector('#report-form')).overflow,bodyOverflow:getComputedStyle(body).overflowY,overflow:modal.scrollWidth-modal.clientWidth,buttons:['#voice-notes','#report-next-step','#save-report-draft'].map(selector=>({selector,height:document.querySelector(selector).getBoundingClientRect().height}))};
   });
   assert(layout.top>=0&&layout.bottom<=height);assert(layout.overflow<=1);assert(layout.bodyBottom<=layout.actionsTop+.1);assert.equal(layout.formOverflow,'hidden',JSON.stringify({theme,width,height,layout}));assert.equal(layout.bodyOverflow,'auto');
   for(const button of layout.buttons)assert.equal(button.height,48,JSON.stringify(button));
   await assertBrandContrast(page,['#report-modal-title','#report-context-job','#report-context-selection','#report-context-summary>span','#report-open-safety','#voice-notes','.office-photo-label','#report-next-step','#save-report-draft','#report-modal .input-help','#report-modal .autosave-status','#field-ai-disclosure']);
   if(process.env.PDL_TEST_SCREENSHOTS)await page.screenshot({path:path.join(process.env.PDL_TEST_SCREENSHOTS,`office-daily-${theme}-${width}-${height}.png`)});
   await checkOfficeLayout(page,width,height,false);
   await assertDailyActionsVisible(page,`${theme} ${width}x${height} after scrolling`);
   await page.evaluate(()=>showReportStep(2));
   await assertDailyActionsVisible(page,`${theme} ${width}x${height} review footer`);
   await page.locator('#report-back').click();
  }
  // The styled picker still opens the same native input; only its presentation changes.
  const photo=path.join(root,'office-brand-photo.png');fs.writeFileSync(photo,Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jV9sAAAAASUVORK5CYII=','base64'));
  const [chooser]=await Promise.all([page.waitForFileChooser(),page.locator('#report-modal .daily-photos-hit').click()]);await chooser.accept([photo]);
  assert.equal(await page.$eval('#office-photo-count',el=>el.textContent),'1 photo selected');
  assert.equal(await page.$eval('#report-photos',el=>el.files.length),1);
  await page.click('#close-report');await page.waitForFunction(()=>Date.now()>=suppressReportOpenUntil);
  await page.locator('[data-office-new-daily]').click();await page.waitForSelector('#report-modal[open]');
  assert.equal(await page.$eval('#office-photo-count',el=>el.hidden),true,'a fresh daily clears the photo count');
  await page.click('#close-report');
  console.log(`Office brand ${theme}: 1280x800, 1440x900, 390x844 and 390x500; bounded initial/expanded/review footers, 48px actions, AA text, header and same photo input passed.`);
 }
 await page.evaluate(()=>document.documentElement.dataset.theme='light');
 await page.setViewport({width:390,height:844,isMobile:true,hasTouch:true});
}
async function assertOfficeEntry(page,label){
 if(page.viewport().width<760)await page.waitForFunction(()=>document.querySelector('#sidebar').getBoundingClientRect().right<=1);
 console.log('Checking '+label);
 // Honor the existing close/tap-through guard before a deliberate new click.
 await page.waitForFunction(()=>Date.now()>=suppressReportOpenUntil);
 const projectId=await openOfficeProjectDaily(page);
 const result=await page.evaluate(()=>{
  const modal=document.querySelector('#report-modal'),notes=document.querySelector('#field-notes'),voice=document.querySelector('#voice-notes'),rect=notes.getBoundingClientRect(),vr=voice.getBoundingClientRect();
  return{compact:modal.classList.contains('report-office-compact'),type:document.querySelector('#report-type').value,details:document.querySelector('#report-context-details').open,next:document.querySelector('#report-next-step').textContent,notesVisible:rect.height>0&&rect.top>=0&&rect.bottom<innerHeight-80,voiceVisible:vr.height>0&&vr.top>=0&&vr.bottom<innerHeight-80,clock:!!document.querySelector('#field-clock-out:not([hidden])')};
 });
 assert.equal(result.compact,true,label);assert.equal(result.type,'production',label);assert.equal(result.details,false,label);assert.equal(result.next,'Done',label);assert.equal(result.notesVisible,true,label+' notes visible');assert.equal(result.voiceVisible,true,label+' voice visible');assert.equal(result.clock,false,label);
 await assertDailyActionsVisible(page,label);
 await page.click('#report-context-summary');await page.waitForSelector('#report-project',{visible:true});
 await page.select('#report-type','superintendent');
 assert.equal(await page.$eval('#report-modal',el=>el.classList.contains('report-office-compact')),false,label+' superintendent');assert.equal(await page.$eval('#report-context-details',el=>el.open),true,label+' superintendent details open');
 await page.click('#close-report');await page.waitForFunction(()=>!document.querySelector('#report-modal').open);
 assert.equal(await page.$eval('#project-detail-modal',el=>el.open),true,label+' closing the daily returns to the project');
 assert.equal(await page.$eval('#project-detail-modal',el=>el.dataset.projectId),projectId,label+' returns to the same project');
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
 if(width<760){assert(layout.modal.left>=-1&&layout.modal.right<=width+1&&layout.modal.width>=width-1,'phone modal fills viewport '+JSON.stringify(layout.modal));assert(layout.crew.top>=layout.date.bottom,`${width} date and crew stack`);}
 assert.equal(layout.position,'static','office actions use reserved layout space');await assertDailyActionsVisible(page,`${width}x${height} expanded context`);
 for(const r of [layout.date,layout.crew,...layout.buttons])assert(r.left>=layout.modal.left&&r.right<=layout.modal.right,`${width} controls stay within modal`);
 for(const selector of ['#report-date','#report-crew','#field-notes','#voice-notes','#report-photos','#report-next-step','#save-report-draft']){
  await page.$eval(selector,el=>el.scrollIntoView({block:'start'}));
  const hit=await page.$eval(selector,el=>{const r=el.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+Math.min(r.height/2,24),hit=document.elementFromPoint(x,y);return{ok:y>=0&&y<innerHeight&&(hit===el||el.contains(hit)),x,y,hit:hit?.outerHTML.slice(0,150)}});assert(hit.ok,`${width}x${height} ${selector} reachable ${JSON.stringify(hit)}`);
 }
 await page.$eval('#field-notes',el=>{el.focus();el.scrollIntoView({block:'center'})});
 if(shot){await page.$eval('#field-notes',el=>el.blur());await page.$$eval('#report-modal form, #report-modal .report-step-scroll',els=>els.forEach(el=>el.scrollTop=0));const directory=process.env.PDL_TEST_SCREENSHOTS||root;fs.mkdirSync(directory,{recursive:true});await page.screenshot({path:path.join(directory,`office-expanded-${width}-${height}.png`)});}
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
   const commandCenter=await page.evaluate(()=>{const visible=selector=>document.querySelector(selector).checkVisibility({checkVisibilityCSS:true,checkOpacity:true});return{priorityVisible:visible('#office-priorities'),setupVisible:visible('.setup-checklist'),productionOpen:document.querySelector('#dashboard-production-details').open,productionVisible:visible('.production-panel'),teamDisplay:getComputedStyle(document.querySelector('.nav-item[data-page="team"]')).display,overflow:document.documentElement.scrollWidth-innerWidth}});
   assert.ok(commandCenter.priorityVisible||commandCenter.setupVisible,'phone Overview shows priorities or setup');assert.equal(commandCenter.productionOpen,false,'production detail starts collapsed');assert.equal(commandCenter.productionVisible,false,'collapsed production detail stays out of the way');assert.notEqual(commandCenter.teamDisplay,'none','Team remains a first-class destination');assert.ok(commandCenter.overflow<=1,'phone Overview has no horizontal overflow');
   await assertNoGlobalOfficeDaily(page);
   await page.locator('#dashboard-production-details > summary').click();
   assert.equal(await page.$eval('.production-panel',el=>el.checkVisibility({checkVisibilityCSS:true,checkOpacity:true})),true,'one tap reveals production details');
   await assertProductionContrast(page);
   await page.locator('#dashboard-production-details > summary').click();
   await checkOfficeBrandMatrix(page);
   await openOfficeProjectDaily(page);
   await assertDailyActionsVisible(page,'390x844 new project daily');
   for(const width of [320,375,390,430,1280]){await checkOfficeLayout(page,width,844,true);if(width<760)await checkOfficeLayout(page,width,390,true);}
   await page.evaluate(()=>showReportStep(2));
   for(const width of [320,375,390,430,1280]){
    await page.setViewport({width,height:width<760?390:844,isMobile:true,hasTouch:true});
    for(const selector of ['#report-signature','#save-report-step2-draft','#save-report']){await page.$eval(selector,el=>{el.scrollIntoView({block:'center'});if(el.tagName==='INPUT')el.focus()});assert(await page.$eval(selector,el=>{const r=el.getBoundingClientRect(),hit=document.elementFromPoint(r.left+r.width/2,r.top+Math.min(r.height/2,24));return hit===el||el.contains(hit)}),`${width} review ${selector} reachable`)}
    assert(await page.$eval('#report-modal',el=>el.scrollWidth<=el.clientWidth+1),`${width} review no horizontal overflow`);
    if(process.env.PDL_TEST_SCREENSHOTS)await page.screenshot({path:path.join(process.env.PDL_TEST_SCREENSHOTS,`office-review-${width}.png`)});
   }
   await page.setViewport({width:390,height:844,isMobile:true,hasTouch:true});await page.$eval('#close-report',el=>el.scrollIntoView({block:'center'}));await page.click('#close-report');await page.waitForFunction(()=>Date.now()>=suppressReportOpenUntil);await page.locator('[data-office-new-daily]').click();await page.waitForSelector('#report-modal[open]');assert.equal(await page.$eval('#report-context-details',el=>el.open),false,'reopening keeps notes-first default');
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
   release();await waitForBoot(page);await assertOfficeEntry(page,'delayed shared controller');await context.close();
  }
  for(const role of ['owner','admin'])for(const width of [390,1280]){
   const context=await browser.createBrowserContext(),page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
   await page.setViewport({width,height:844,isMobile:width===390,hasTouch:width===390});await page.evaluateOnNewDocument(()=>localStorage.setItem('pdl-analytics-consent','declined'));
   await page.goto(`http://127.0.0.1:${port}/login.html`);await page.type('#email',role==='owner'?owner.email:'synthetic-admin@example.test');await page.type('#password','synthetic-owner-pass');await page.click('form#login button.primary');await waitForBoot(page);
   assert.equal(await page.evaluate(()=>currentUser.role),role);
   for(const restored of [false,true]){
    if(restored){await page.reload({waitUntil:'domcontentloaded'});await waitForBoot(page)}
    if(await page.$eval('#report-modal',el=>el.open))await page.click('#close-report');
    await navigate(page,'dashboard');await assertOfficeEntry(page,`${role} ${width} restored=${restored} dashboard → project`);
    await navigate(page,'reports');await assertOfficeEntry(page,`${role} ${width} restored=${restored} reports → project`);
   }
   assert.deepEqual(errors,[]);await context.close();
  }
  assert.equal(JSON.parse(fs.readFileSync(file)).reports.length,reportCount,'entry-point tests never create records');
  console.log('Office project daily buttons: owner/admin, mobile/desktop, fresh/restored session, no global create, exact project, return to project, notes/voice visible and superintendent escape passed. No report writes.');
 }finally{await browser?.close();child.kill();await new Promise(resolve=>child.exitCode!=null?resolve():child.once('exit',resolve));fs.rmSync(root,{recursive:true,force:true})}
})().catch(error=>{console.error(error);process.exitCode=1});
