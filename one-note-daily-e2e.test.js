'use strict';
// Office and a superintendent file a normal daily through the shared note flow.
// The field crew still opens the clock-tied compact note, not the office chrome.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net');
const {spawn}=require('node:child_process');
const chrome=process.env.PDL_TEST_CHROME||(process.platform==='win32'?'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe':'/usr/bin/google-chrome-stable');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'pdl-one-note-'));
const note='Poured 40 LF of curb on north side. Extra work: owner asked us to patch 2 potholes by the gate.';
async function freePort(){return new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const port=s.address().port;s.close(()=>resolve(port))})})}
async function set(page,selector,value,event='input'){await page.$eval(selector,(el,{value,event})=>{el.value=value;el.dispatchEvent(new Event(event,{bubbles:true}))},{value,event})}
async function visible(page,selector){return page.$eval(selector,el=>!el.hidden&&getComputedStyle(el).display!=='none'&&el.getBoundingClientRect().height>0)}
async function login(page,email,password){
  const response=await page.goto('http://127.0.0.1:'+page.port+'/login.html',{waitUntil:'domcontentloaded'});
  if(!response||response.status()>=400)throw new Error('login page failed '+((response&&response.status())||'no response')+' '+page.url());
  await page.waitForSelector('#email',{timeout:15000});
  await set(page,'#email',email);await set(page,'#password',password);await page.click('form#login button.primary');
  await page.waitForFunction(()=>typeof currentUser!=='undefined'&&currentUser?.id&&document.documentElement.classList.contains('workspace-ready'));
}
async function fileNoteDaily(page,{marker,memberId=null}={}){
  await page.evaluate(()=>{$('#report-context-details').open=true});
  await page.waitForSelector('#report-project',{visible:true});
  await page.evaluate(()=>{$('#report-project').value=String(projects.findIndex(p=>/Cedar Grove/.test(p.name)));$('#report-project').dispatchEvent(new Event('change',{bubbles:true}))});
  await page.waitForFunction(()=>reportLaborLoadedKey===reportLaborSelectionKey());
  await page.evaluate(memberId=>{
    const crew=$('#report-crew');if([...crew.options].some(option=>option.value==='Concrete')){crew.value='Concrete';crew.dispatchEvent(new Event('change',{bubbles:true}))}
    const input=memberId?document.querySelector(`[data-labor-member="${memberId}"]`):document.querySelector('[data-labor-member]');
    if(!input)throw new Error('crew hours field missing');
    populateReportLabor([{memberId:Number(input.dataset.laborMember),hours:2}]);
    timeCards.push({id:999001,memberId:Number(input.dataset.laborMember),projectId:projects[+$('#report-project').value].id,date:$('#report-date').value,inAt:'2026-10-17T00:00:00Z',outAt:'2026-10-17T23:00:00Z',status:'draft'});
  },memberId);
  await set(page,'#field-notes',note+' '+marker);
  const photo=path.join(root,'synthetic.png');fs.writeFileSync(photo,Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=','base64'));
  await (await page.$('#report-photos')).uploadFile(photo);
  await page.evaluate(()=>$('#report-next-step').click());
  await page.waitForFunction(()=>$('#report-form').getAttribute('data-current-step')==='2'&&!$('#report-next-step').disabled);
  assert.equal(await visible(page,'#field-review-cards'),true,'review cards');
  assert.equal(await page.evaluate(()=>fieldLaborContext().punches.length),0,'raw punches stay out of this daily');
  await page.evaluate(()=>{const row=$$('.production-entry')[0];if(!row)throw new Error('work line missing');row.querySelector('.production-quantity').value='40';row.querySelector('.production-quantity').dispatchEvent(new Event('input',{bubbles:true}));const yes=document.querySelector('[data-flag-choice="yes"]');if(!yes)throw new Error('extra Yes/No missing');yes.click()});
  await set(page,'#report-signature','Synthetic signer');
  const nextHeight=await page.$eval('#save-report',el=>el.getBoundingClientRect().height);
  assert.ok(nextHeight>=44,'send target is at least 44px');
  await page.evaluate(()=>$('#save-report').click());
  await page.waitForFunction(()=>!$('#report-modal').open,{timeout:20000});
  const saved=await page.evaluate(marker=>reports.find(row=>String(row.notes||'').includes(marker)),marker);
  assert.ok(saved?.id,'daily saved');
  assert.notEqual(saved.reportType,'superintendent','saved daily is a normal production daily');
  assert.equal(saved.status==='Draft',false,'send leaves the draft status');
  assert.equal(Number(saved.productionEntries?.[0]?.quantity),40);
  assert.equal(saved.laborEntries.reduce((sum,row)=>sum+Number(row.hours||0),0),2);
  assert.ok(saved.extraWork?.some(item=>item.extra_work===true),'extra work stays Yes/No');
  assert.ok(await page.evaluate(id=>photos.some(row=>Number(row.reportId)===Number(id)),saved.id),'photo posted with the daily');
  return saved;
}
(async()=>{
  const port=await freePort();
  const file=path.join(root,'db.json');
  const env={...process.env,PORT:String(port),PDL_STAGING:'1',PDL_STAGING_OWNER_PASSWORD:'synthetic-owner-pass',PDL_STAGING_FIELD_PASSWORD:'synthetic-field-pass',PDL_DB_FILE:file,PDL_PLATFORM_FILE:path.join(root,'platform.json'),PDL_EMAIL_DEV_MODE:'1',PDL_SUPABASE_ENABLED:'0',PDL_TRANSACTIONAL_DB:'off',OPENAI_API_KEY:''};
  for(const key of ['STRIPE_SECRET_KEY','STRIPE_WEBHOOK_SECRET','RESEND_API_KEY','INDEXNOW_KEY','SENTRY_DSN'])delete env[key];
  const child=spawn(process.execPath,['--require',require.resolve('./scripts/test-analytics-isolation.cjs'),'server.js'],{cwd:__dirname,env,stdio:['ignore','pipe','pipe']});
  let log='',browser;child.stdout.on('data',c=>log+=c);child.stderr.on('data',c=>log+=c);
  try{
    await new Promise((resolve,reject)=>{const start=Date.now();const poll=()=>log.includes('running at')?resolve():child.exitCode!=null||Date.now()-start>20000?reject(Error(log)):setTimeout(poll,100);poll()});
    const db=JSON.parse(fs.readFileSync(file));
    const field=db.users.find(user=>user.email==='levi+field@prodailylink.com');
    const memberId=Math.max(...db.team.map(member=>Number(member.id)))+1;
    const today=db.assignments.find(row=>(row.memberIds||[]).includes(1))?.date;
    db.team.push({id:memberId,name:'Synthetic Superintendent',role:'Superintendent',initials:'SS',crew:'Concrete',hours:8,site:'DEMO Cedar Grove Clinic',phone:'(503) 555-0199',email:'synthetic-super@example.test'});
    db.users.push({...field,id:Math.max(...db.users.map(user=>Number(user.id)))+1,name:'Synthetic Superintendent',email:'synthetic-super@example.test',role:'field',memberId});
    db.assignments.push({id:Math.max(0,...db.assignments.map(row=>Number(row.id)))+1,projectId:3,memberIds:[memberId],crew:'Concrete',date:today,start:'07:00',end:'15:30',activity:'Synthetic superintendent daily',acknowledgements:{}});
    fs.writeFileSync(file,JSON.stringify(db));
    browser=await require('puppeteer-core').launch({executablePath:chrome,headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
    {
      const context=await browser.createBrowserContext(),page=await context.newPage();page.port=port;page.on('dialog',dialog=>dialog.accept());const errors=[];page.on('pageerror',error=>errors.push(error.message));
      await page.setViewport({width:390,height:844,isMobile:true,hasTouch:true});
      await page.evaluateOnNewDocument(()=>localStorage.setItem('pdl-analytics-consent','declined'));
      await login(page,'levi+owner@prodailylink.com','synthetic-owner-pass');
      await page.waitForFunction(()=>currentRole==='office'&&projects.length>0);
      await page.click('.top-actions [data-open-report]');
      await page.waitForSelector('#report-modal[open]');
      await page.click('#report-context-summary');
      await page.waitForSelector('#report-project',{visible:true});
      const office=await page.evaluate(()=>({office:document.querySelector('#report-modal').classList.contains('report-office-compact'),field:document.querySelector('#report-modal').classList.contains('report-field-compact'),type:document.querySelector('#report-type').value,next:document.querySelector('#report-next-step').textContent,clock:!!document.querySelector('#field-clock-out'),typeBox:document.querySelector('#report-type').closest('label').getBoundingClientRect().height,done:document.querySelector('#report-next-step').getBoundingClientRect().height}));
      assert.equal(office.office,true);assert.equal(office.field,true);assert.equal(office.type,'production');assert.equal(office.next,'Done');assert.equal(office.clock,false);assert.equal(office.typeBox,0,'daily type stays off the note flow');assert.ok(office.done>=44);
      await fileNoteDaily(page,{marker:'OFFICE-NOTE'});
      assert.deepEqual(errors,[]);
      await context.close();
    }
    {
      const context=await browser.createBrowserContext(),page=await context.newPage();page.port=port;page.on('dialog',dialog=>dialog.accept());const errors=[];page.on('pageerror',error=>errors.push(error.message));
      await page.setViewport({width:390,height:844,isMobile:true,hasTouch:true});
      await page.evaluateOnNewDocument(()=>localStorage.setItem('pdl-analytics-consent','declined'));
      await login(page,'synthetic-super@example.test','synthetic-field-pass');
      await page.waitForFunction(()=>currentRole==='field'&&superintendentActor()&&projects.some(project=>/Cedar Grove/.test(project.name))&&!workdays.some(day=>day.status==='active'));
      await page.evaluate(()=>showPage('reports'));
      await page.waitForSelector('#reports-page.active [data-open-report]');
      await page.click('#reports-page [data-open-report]');
      await page.waitForSelector('#report-modal[open]');
      const sup=await page.evaluate(()=>{const details=document.querySelector('#report-context-details');details.open=true;const picker=document.querySelector('#report-project-picker');const box=picker.getBoundingClientRect();return {office:document.querySelector('#report-modal').classList.contains('report-office-compact'),fieldOnly:document.querySelector('#report-modal').classList.contains('report-field-compact')&&!document.querySelector('#report-modal').classList.contains('report-office-compact'),next:document.querySelector('#report-next-step').textContent,clock:!!document.querySelector('#field-clock-out:not([hidden])'),job:box.height,display:getComputedStyle(picker).display,open:details.open,typeBox:document.querySelector('#report-type').closest('label').getBoundingClientRect().height,classes:document.querySelector('#report-modal').className}});
      assert.equal(sup.office,true,'superintendent uses the shared note chrome');
      assert.equal(sup.fieldOnly,false,'superintendent is not tied to the crew clock layout');
      assert.equal(sup.next,'Done');assert.equal(sup.clock,false);assert.equal(sup.display,'block','superintendent job picker visible '+JSON.stringify(sup));assert.ok(sup.job>0,'superintendent picks the job '+JSON.stringify(sup));assert.equal(sup.typeBox,0,'daily type stays off the note flow');
      await fileNoteDaily(page,{marker:'SUPER-NOTE',memberId});
      assert.deepEqual(errors,[]);
      await context.close();
    }
    {
      const context=await browser.createBrowserContext(),page=await context.newPage();page.port=port;page.on('dialog',dialog=>dialog.accept());
      await page.setViewport({width:390,height:844,isMobile:true,hasTouch:true});
      await page.evaluateOnNewDocument(()=>localStorage.setItem('pdl-analytics-consent','declined'));
      await login(page,'levi+field@prodailylink.com','synthetic-field-pass');
      await page.waitForFunction(()=>currentRole==='field'&&!superintendentActor());
      await page.evaluate(()=>showPage('reports'));
      await page.waitForSelector('#reports-page.active [data-open-report]');
      await page.click('#reports-page [data-open-report]');
      await page.waitForSelector('#report-modal[open]');
      const crew=await page.evaluate(()=>{const modal=document.querySelector('#report-modal'),picker=document.querySelector('#report-project-picker').getBoundingClientRect();return {field:modal.classList.contains('report-field-compact'),office:modal.classList.contains('report-office-compact'),next:document.querySelector('#report-next-step').textContent,clock:!!document.querySelector('#field-clock-out:not([hidden])'),picker:picker.height,done:document.querySelector('#report-next-step').getBoundingClientRect().height}});
      assert.equal(crew.field,true);assert.equal(crew.office,false);assert.equal(crew.next,'Done');assert.equal(crew.clock,false);assert.equal(crew.picker,0);assert.ok(crew.done>=44);
      await page.click('#close-report');
      await page.waitForFunction(()=>!document.querySelector('#report-modal').open);
      await context.close();
    }
    console.log('One note daily: office, superintendent, and field crew passed.');
  }catch(error){console.error(String(log).slice(-2500));throw error}finally{await browser?.close();child.kill();await new Promise(resolve=>child.exitCode!=null?resolve():child.once('exit',resolve));fs.rmSync(root,{recursive:true,force:true})}
})().catch(error=>{console.error(error);process.exitCode=1});
