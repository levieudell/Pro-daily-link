'use strict';
const assert = require('node:assert/strict'), crypto = require('node:crypto'), fs = require('node:fs'), path = require('node:path');
const { chromium } = require('playwright');
const { workspace } = require('./fixtures/roles-workspace'), { companyA, companyB, token } = require('./fixtures/project-assistant');
const barrier = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
module.exports = async function ({ repository, change, request, bases, providerEvents }) {
  const base = bases[0], load = () => repository.load(companyA), original = structuredClone((await load()).snapshot), foreign = await repository.load(companyB), providerCount = providerEvents.length;
  const artifacts = path.resolve(process.env.PDL_ROLES_BROWSER_ARTIFACTS || 'roles-browser-evidence', 'operational'); fs.mkdirSync(artifacts, { recursive: true });
  const clean = workspace(); clean.users[6].role = 'office'; clean.users[6].permissions = { manageTime: true, viewTime: true };
  clean.assignments = [{ id: 9001, projectId: 101, memberIds: [11], date: '2098-10-12', start: '08:00', end: '16:00', activity: 'Synthetic assigned scope' }];
  clean.reports = []; clean.timeCards = []; clean.workdays = []; clean.payPeriods = []; clean.payPeriodExports = []; clean.reportingExports = [];
  clean.projects[0].estimateItems = [{ id: 1, name: 'Synthetic wall scope', unit: 'SF', plannedQuantity: 100, budgetHours: 20 }];
  const reset = async () => change(db => { for (const key of Object.keys(db)) delete db[key]; Object.assign(db, structuredClone(clean)); });
  const browser = await chromium.launch({ headless: true, ...(process.env.PDL_ROLES_BROWSER_EXECUTABLE ? { executablePath: process.env.PDL_ROLES_BROWSER_EXECUTABLE } : {}), args: ['--disable-background-networking', '--disable-component-update', '--no-first-run'] });
  const cases = [], holds = []; let context, page, mutations, errors, responses; const external = [];
  async function cookies(user = 1, company = companyA) { await context.addCookies([{ name: 'pdl_session', value: token(company,user), url: base, httpOnly: true, sameSite: 'Strict' }, { name: 'pdl_company', value: company, url: base, sameSite: 'Strict' }]); }
  async function open(route, user = 1, company = companyA) { await cookies(user,company); await page.goto(base + '/workspace.html?tenant=' + company + '&case=' + crypto.randomUUID() + '#' + route); await page.locator('#workflow-refresh').waitFor(); await page.waitForFunction(() => document.querySelector('#workspace-message').textContent === ''); }
  async function review(action, fields = {}, rowId) {
    const locator = page.locator('[data-work-action="' + action + '"]' + (rowId == null ? '' : '[data-record="' + rowId + '"]')).first(); await locator.click(); await page.locator('#work-form').waitFor();
    for (const [name,value] of Object.entries(fields)) { const element = page.locator('#work-form [name="' + name + '"]'); if (Array.isArray(value)) await element.selectOption(value.map(String)); else if (typeof value === 'boolean') await element.setChecked(value); else if (await element.evaluate(node=>node.tagName==='SELECT')) await element.selectOption(String(value)); else await element.fill(String(value)); }
    await page.locator('#work-form button[type="submit"]').click();
    try { await page.locator('#work-explicit-confirm').waitFor(); } catch (error) { throw Error(error.message + '\nWorkspace: ' + await page.locator('#workspace-message').innerText() + '\nResponses: ' + JSON.stringify(responses.slice(-6))); }
    assert.equal(await page.locator('#work-confirm').isDisabled(), true);
  }
  async function confirm() { await page.locator('#work-explicit-confirm').check(); await page.evaluate(() => { const button = document.querySelector('#work-confirm'); button.click(); button.click(); }); await page.locator('#workspace-message').filter({hasText:'Saved.'}).waitFor(); }
  async function screenshot(name) { await page.screenshot({ path: path.join(artifacts,name + '.png') }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); }
  async function test(name, run, viewport = {width:1440,height:1000}) {
    // Independent contexts model distinct clients behind the existing proxy header.
    // Keep the ordinary rate budget and one address throughout each journey.
    const clientAddress = '198.51.100.' + (cases.length + 1);
    await reset(); context = await browser.newContext({ viewport, acceptDownloads:true, extraHTTPHeaders: { 'X-Forwarded-For': clientAddress } }); mutations=[]; errors=[]; responses=[];
    await context.route('**/*', route => { if (new URL(route.request().url()).origin !== base) { external.push(route.request().url()); return route.abort(); } return route.continue(); });
    page = await context.newPage(); page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(error.message)); page.on('request', row => { if (['POST','PATCH','DELETE'].includes(row.method())) mutations.push({method:row.method(),path:new URL(row.url()).pathname,body:row.postDataJSON()}); });
    page.on('response', async row => { if (row.url().includes('/api/')) responses.push({path:new URL(row.url()).pathname,status:row.status()}); });
    try { await run(); assert.deepEqual(errors,[]); cases.push({name,viewport,clientAddress,passed:true}); console.log('Operational browser passed: ' + name); }
    catch (error) { await page.screenshot({path:path.join(artifacts,'failure.png')}).catch(()=>{}); cases.push({name,viewport,passed:false,error:error.message,clientAddress,responses,pageErrors:errors}); throw error; }
    finally { for (const hold of holds.splice(0)) hold.resolve(); await context.close(); }
  }
  try {
    await test('PM scheduling: real scoped choices, reviewed create/edit/remove and one write per double click', async () => {
      await open('schedule',2); await page.locator('[data-work-action="scheduleCreate"]').click(); assert.deepEqual(await page.locator('[name="projectId"] option').evaluateAll(rows=>rows.map(row=>row.value)),['101']); assert.deepEqual(await page.locator('[name="memberIds"] option').evaluateAll(rows=>rows.map(row=>row.value)),['11','12']); await page.locator('#workflow-cancel').click();
      const before = await load(); await review('scheduleCreate',{projectId:'101',memberIds:['11','12'],date:'2026-02-09',start:'08:00',end:'16:00',activity:'Reviewed → café 工程'}); assert.deepEqual(await load(),before); await screenshot('desktop-schedule-review'); await confirm();
      let current=await load(), row=current.snapshot.assignments.find(row=>row.date==='2026-02-09'); assert.ok(row); assert.equal(row.activity,'Reviewed → café 工程'); assert.equal(mutations.filter(row=>row.path==='/api/assignments' && row.method==='POST').length,1);
      await review('scheduleEdit',{activity:'Reviewed revision'},row.id); await confirm(); assert.equal((await load()).snapshot.assignments.find(item=>item.id===row.id).activity,'Reviewed revision');
      await review('scheduleRemove',{},row.id); await confirm(); assert.ok(!(await load()).snapshot.assignments.some(item=>item.id===row.id));
    });
    await test('narrow field notes and to-dos: deadline, literal text, completion, edit and no provider effects', async () => {
      await open('notes',4); const before=await load(); await review('noteCreate',{kind:'todo',text:'Reviewed → café 工程',dueDate:'2026-02-10'}); assert.deepEqual(await load(),before); await screenshot('mobile-todo-review'); await confirm();
      let row=(await load()).snapshot.projectNotesTodos[0]; assert.equal(row.text,'Reviewed → café 工程'); assert.equal(row.dueDate,'2026-02-10');
      await review('noteComplete',{},row.id); await confirm(); row=(await load()).snapshot.projectNotesTodos[0]; assert.equal(row.completed,true);
      await review('noteEdit',{text:'Reviewed edited text',dueDate:'2026-02-11'},row.id); await confirm(); assert.equal((await load()).snapshot.projectNotesTodos[0].text,'Reviewed edited text');
    },{width:360,height:800});
    await test('completion-only note policy toggles a to-do while text editing stays denied', async () => {
      const created=await request(base,'POST','/api/projects/101/notes-todos',{kind:'todo',text:'Completion-only to-do',requestId:crypto.randomUUID()},4); assert.equal(created.status,201); const id=created.data.item?.id || created.data.id;
      await change(db=>{const access=require('./notes-access');db.company.notesRolePolicy={version:1,revision:1,roles:Object.fromEntries(access.roles.map(role=>[role,access.ceiling(role)]))};db.company.notesRolePolicy.roles.field.edit=false;});
      await open('notes',4); assert.equal(await page.locator('[data-work-action="noteEdit"]').count(),0); await review('noteComplete',{},id); await confirm(); assert.equal((await load()).snapshot.projectNotesTodos[0].completed,true);
      const row=(await load()).snapshot.projectNotesTodos[0]; assert.equal((await request(base,'PATCH','/api/projects/101/notes-todos/'+id,{revision:row.revision,text:'Forbidden edit'},4)).status,403);
    });
    await test('reversed same-route project reads preserve the newest selection and exact edit target', async () => {
      for(const [project,text] of [[101,'Project A note'],[102,'Project B note']]) assert.equal((await request(base,'POST','/api/projects/'+project+'/notes-todos',{kind:'note',text,requestId:crypto.randomUUID()})).status,201);
      await open('notes'); const received=barrier(),release=barrier();holds.push(release);let first=true;
      await page.route('**/api/projects/101/notes-todos',async route=>{if(route.request().method()!=='GET'||!first)return route.continue();first=false;const response=await route.fetch();assert.equal(response.status(),200);received.resolve();await release.promise;await route.fulfill({response});});
      await page.locator('#workflow-refresh').click();await received.promise;await page.locator('[name="notes-project"]').selectOption('102');await page.locator('.workflow-records').filter({hasText:'Project B note'}).waitFor();release.resolve();await page.waitForTimeout(100);assert.equal(await page.locator('[name="notes-project"]').inputValue(),'102');assert.ok(!(await page.locator('.workflow-records').innerText()).includes('Project A note'));
      const target=(await load()).snapshot.projectNotesTodos.find(row=>row.projectId===102);await review('noteEdit',{text:'Newest project edit'},target.id);await confirm();assert.ok(mutations.some(row=>row.method==='PATCH'&&row.path==='/api/projects/102/notes-todos/'+target.id));assert.equal((await load()).snapshot.projectNotesTodos.find(row=>row.projectId===101).text,'Project A note');
    });
    await test('same-actor revoked CSV authority cannot release a buffered download', async () => {
      await open('cards',2); const received=barrier(),release=barrier();holds.push(release);const downloads=[];page.on('download',row=>downloads.push(row));
      await page.route('**/api/time-cards.csv',async route=>{const response=await route.fetch();assert.equal(response.status(),200);received.resolve();await release.promise;await route.fulfill({response});});
      await page.locator('#cards-download').click();await received.promise;await change(db=>{db.users[1].permissions.manageTime=false;db.users[1].permissions.viewTime=false;});release.resolve();await page.locator('#workspace-message').filter({hasText:'changed'}).waitFor();assert.equal(downloads.length,0);
    });

    await test('own partial-day leave and legacy Office compatibility review use actual typed server actions', async () => {
      await open('leave',4); await review('leaveCreate',{startDate:'2026-02-09',endDate:'2026-02-09',allDay:false,startTime:'08:00',endTime:'12:00',type:'vacation',note:'Private synthetic leave'}); await confirm();
      let row=(await load()).snapshot.timeOffRequests[0]; assert.equal(row.memberId,11); assert.equal(row.allDay,false); assert.equal(row.status,'pending');
      await open('leave',7); await review('leaveApprove',{note:'Reviewed availability'},row.id); await confirm(); row=(await load()).snapshot.timeOffRequests[0]; assert.equal(row.status,'approved'); assert.equal(mutations.filter(item=>item.path.endsWith('/approve')).length,1);
    });
    await test('field daily: pending measurement, per-person hours, edit/submit, then Office approval', async () => {
      await open('dailies',4); await page.locator('[data-work-action="dailyCreate"]').click(); await page.locator('[name="dateIso"]').fill('2026-01-05'); await page.locator('[name="memberIds"]').selectOption(['11']); await page.locator('[name="hours-11"]').fill('2'); await page.locator('[name="notes"]').fill('Installed reviewed wall scope'); await page.locator('[name="line-item"]').selectOption('1'); await page.locator('[name="line-hours"]').fill('2'); await page.locator('#work-form button[type="submit"]').click(); await page.locator('#work-explicit-confirm').waitFor(); assert.match(await page.locator('#workflow-action').innerText(),/Pending measurement/); await screenshot('desktop-daily-review'); await confirm();
      let row=(await load()).snapshot.reports[0]; assert.equal(row.laborEntries[0].hours,2); assert.equal(row.productionEntries[0].quantity,null);
      await page.locator('[data-work-action="photoUpload"][data-record="' + row.id + '"]').click(); const photoBytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64'); await page.locator('[name="photo"]').setInputFiles({name:'synthetic.png',mimeType:'image/png',buffer:photoBytes}); await page.locator('[name="caption"]').fill('Reviewed synthetic field photo'); await page.locator('#work-form button[type="submit"]').click(); await page.locator('#work-explicit-confirm').waitFor(); assert.equal((await load()).snapshot.photos.length,0); await screenshot('desktop-photo-review');
      let firstPhoto=true; await page.route('**/api/photos',async route=>{if(!firstPhoto)return route.continue();firstPhoto=false;const response=await route.fetch();assert.equal(response.status(),201);await route.abort();}); await page.locator('#work-explicit-confirm').check(); await page.locator('#work-confirm').click(); await page.locator('#workflow-recover').waitFor(); await page.locator('#workflow-recover').click(); await page.locator('#workspace-message').filter({hasText:'Saved.'}).waitFor(); const photoWrites=mutations.filter(item=>item.path==='/api/photos'); assert.equal(photoWrites.length,2); assert.deepEqual(photoWrites[0].body,photoWrites[1].body); assert.equal((await load()).snapshot.photos.length,1);
      await page.locator('[data-report-photos="' + row.id + '"]').click(); await page.locator('figure img').waitFor(); await page.waitForFunction(()=>document.querySelector('figure img')?.naturalWidth===1); assert.equal((await request(base,'GET','/api/reports/'+row.id+'/photos',undefined,3)).status,404);
      await page.locator('[data-work-action="dailyEdit"][data-record="' + row.id + '"]').click(); assert.deepEqual(await page.locator('[name="memberIds"]').evaluate(node=>[...node.selectedOptions].map(row=>row.value)),['11']); await page.locator('[name="status"]').selectOption('Needs review'); await page.locator('[name="line-quantity"]').fill('5'); await page.locator('#work-form button[type="submit"]').click(); await page.locator('#work-explicit-confirm').waitFor(); await confirm(); assert.equal((await load()).snapshot.reports[0].status,'Needs review');
      await open('dailies',7); await review('dailyApprove',{},row.id); await confirm(); assert.equal((await load()).snapshot.reports[0].status,'Approved');
      await open('dailies'); await review('reportExport',{projectId:'101',from:'2026-01-05',to:'2026-01-05',reason:'Reviewed approved daily'}); await confirm(); assert.equal((await load()).snapshot.reportingExports.length,1); await page.locator('#report-exports').click(); await page.locator('[data-report-export]').waitFor(); const delivery=page.waitForEvent('download'); await page.locator('[data-report-export]').click(); const exportDownload=await delivery; assert.match(fs.readFileSync(await exportDownload.path(),'utf8'),/Synthetic wall scope/);
    });
    await test('field company clock and own assignment acknowledgement retain their exact server scope', async () => {
      await open('schedule',4);await review('acknowledge',{},9001);await confirm();assert.equal((await load()).snapshot.assignments[0].acknowledgements['11'].status,'acknowledged');
      await open('cards',4);await page.locator('[data-work-action="clockIn"]').click();const activity=await page.locator('[name="activityCodeId"] option').first().getAttribute('value');assert.ok(activity);await page.locator('#work-form button[type="submit"]').click();await page.locator('#work-explicit-confirm').waitFor();await confirm();const card=(await load()).snapshot.timeCards[0];assert.equal(card.memberId,11);assert.equal(card.projectId,null);await review('clockOut',{},card.id);await confirm();assert.ok((await load()).snapshot.timeCards[0].outAt);
    });

    await test('field workday starts and ends actual linked time and daily records', async () => {
      await open('workdays',4); await review('workdayStart',{projectId:'101',memberIds:['11'],startNote:'Reviewed start'}); await confirm(); let current=await load(), day=current.snapshot.workdays[0]; assert.equal(day.status,'active'); assert.equal(current.snapshot.timeCards.length,1);
      await review('workdayEnd',{notes:'Reviewed actual work',next:'Continue scope'},day.id); await confirm(); current=await load(); assert.equal(current.snapshot.workdays[0].status,'complete'); assert.ok(current.snapshot.timeCards[0].outAt); assert.equal(current.snapshot.reports.length,1);
    });
    await test('time card create/own correction/submit/Office approval then owner period/export/download', async () => {
      await open('cards'); await review('cardCreate',{projectId:'101',memberId:'11',inAt:'2026-01-05T16:00:00Z',outAt:'2026-01-05T17:00:00Z',reason:'Reviewed missed card'}); await confirm(); let row=(await load()).snapshot.timeCards[0];
      await open('cards',4); await review('cardCorrect',{inAt:'2026-01-05T16:00:00Z',outAt:'2026-01-05T18:00:00Z',reason:'Reviewed own correction'},row.id); await confirm(); assert.equal((await load()).snapshot.timeCards[0].hours,2); await review('cardSubmit',{},row.id); await confirm();
      await open('cards',7); await review('cardApprove',{},row.id); await confirm(); assert.equal((await load()).snapshot.timeCards[0].status,'approved');
      await open('payroll'); await review('periodCreate',{label:'Reviewed synthetic payroll',from:'2026-01-05',to:'2026-01-11'}); await confirm(); let period=(await load()).snapshot.payPeriods[0]; await review('periodCapture',{reason:'Reviewed approved hours'},period.id); await screenshot('desktop-payroll-review'); await confirm(); assert.equal((await load()).snapshot.payPeriodExports.length,1);
      await page.locator('[data-period-download="' + period.id + '"]').click(); await page.locator('[data-export-download]').waitFor(); const delivery=page.waitForEvent('download'); await page.locator('[data-export-download]').click(); const download=await delivery; const downloaded=fs.readFileSync(await download.path(),'utf8'); assert.match(downloaded,/Jordan Sample/); assert.equal(mutations.filter(item=>item.path===('/api/pay-periods/'+period.id+'/exports')).length,1);
      await open('payroll',7); const received=barrier(),release=barrier();holds.push(release);await page.route('**/api/pay-periods/'+period.id+'/exports',async route=>{const response=await route.fetch();assert.equal(response.status(),200);received.resolve();await release.promise;await route.fulfill({response});});await page.locator('[data-period-download="'+period.id+'"]').click();await received.promise;await change(db=>{const access=require('./time-write-access');db.company.timeWriteRolePolicy={version:1,revision:1,roles:Object.fromEntries(access.roles.map(role=>[role,access.ceiling(role)]))};db.company.timeWriteRolePolicy.roles.admin.downloadExports=false;});release.resolve();await page.locator('#workspace-message').filter({hasText:'changed'}).waitFor();assert.equal(await page.locator('[data-export-download]').count(),0);
    });
    await test('lost scheduling acknowledgement: exact original request recovery and no duplicate assignment', async () => {
      await open('schedule',2); let first=true; await page.route('**/api/assignments',async route=>{ if(route.request().method()!=='POST'||!first)return route.continue(); first=false; const response=await route.fetch(); assert.equal(response.status(),201); await route.abort('connectionfailed'); });
      await review('scheduleCreate',{projectId:'101',memberIds:['11'],date:'2026-02-12',start:'08:00',end:'16:00',activity:'Unknown acknowledgement'}); await page.locator('#work-explicit-confirm').check(); await page.locator('#work-confirm').click(); await page.locator('#workflow-recover').waitFor();
      await page.locator('[data-route="projects"]').click(); await page.getByRole('heading',{name:'Projects',exact:true}).waitFor(); await page.locator('[data-route="schedule"]').click(); await page.locator('#workflow-recover').waitFor(); await page.locator('#workflow-recover').click(); await page.locator('#workspace-message').filter({hasText:'Saved.'}).waitFor();
      const writes=mutations.filter(row=>row.path==='/api/assignments' && row.method==='POST'); assert.equal(writes.length,2); assert.deepEqual(writes[0].body,writes[1].body); assert.equal((await load()).snapshot.assignments.filter(row=>row.date==='2026-02-12').length,1);
    });
    await test('non-idempotent lost edit result requires current-record reconciliation without automatic replay', async () => {
      await open('schedule',2); let first=true; await page.route('**/api/assignments/9001',async route=>{ if(route.request().method()!=='PATCH'||!first)return route.continue(); first=false; const response=await route.fetch(); assert.equal(response.status(),200); await route.abort(); });
      await review('scheduleEdit',{activity:'Saved with unknown acknowledgement'},9001); await page.locator('#work-explicit-confirm').check(); await page.locator('#work-confirm').click(); await page.locator('#workflow-reconcile').waitFor(); assert.equal(await page.locator('#workflow-recover').count(),0); await page.locator('#workflow-refresh').click(); await page.locator('#workflow-reconcile').waitFor(); assert.match(await page.locator('.workflow-records').innerText(),/Saved with unknown acknowledgement/); assert.equal(mutations.filter(row=>row.method==='PATCH').length,1); await page.locator('#workflow-reconcile').click(); await page.waitForFunction(()=>!document.querySelector('#workflow-reconcile'));
    });
    await test('permission revocation between preview and first confirm prevents a daily business write', async () => {
      await open('workdays',4); await review('workdayStart',{projectId:'101',memberIds:['11']}); await change(db=>{const access=require('./daily-access'); db.company.dailyRolePolicy={version:1,revision:1,roles:Object.fromEntries(access.roles.map(role=>[role,access.ceiling(role)]))}; db.company.dailyRolePolicy.roles.field.runWorkdays=false;});
      const before=await load(); await page.locator('#work-explicit-confirm').check(); await page.locator('#work-confirm').click(); await page.locator('#workspace-message').filter({hasText:'changed'}).waitFor(); assert.deepEqual(await load(),before); assert.equal(mutations.filter(row=>row.path==='/api/workdays/start').length,0); assert.equal(await page.locator('#work-explicit-confirm').count(),0);
    });
    await test('known successful save plus read failure retains a refresh control without repeating the save', async () => {
      await open('notes',4); let saved=false, rejected=false; await page.route('**/api/projects/101/notes-todos',async route=>{ if(route.request().method()==='POST'){const response=await route.fetch(); saved=true; return route.fulfill({response});} if(saved&&!rejected){rejected=true;return route.abort();} return route.continue();});
      await review('noteCreate',{kind:'note',text:'Known saved despite refresh failure'}); await confirm(); assert.match(await page.locator('#workspace-message').innerText(),/could not be refreshed/); assert.equal(await page.locator('#workflow-recover').count(),0); await page.locator('#workflow-refresh').click(); await page.locator('.workflow-records').filter({hasText:'Known saved despite refresh failure'}).waitFor(); assert.equal(mutations.filter(row=>row.path.endsWith('/notes-todos')).length,1);
    });
    await test('buffered private notes are inert after a tenant/session switch', async () => {
      assert.equal((await request(base,'POST','/api/projects/101/notes-todos',{kind:'note',text:'PRIVATE-BUFFERED-NOTE',requestId:crypto.randomUUID()})).status,201);
      const received=barrier(),release=barrier();holds.push(release);let first=true;
      await page.route('**/api/projects/101/notes-todos',async route=>{if(!first)return route.continue();first=false;const response=await route.fetch();assert.equal(response.status(),200);received.resolve();await release.promise;await route.fulfill({response});});
      await cookies();await page.goto(base+'/workspace.html?tenant='+companyA+'#notes');await received.promise;await cookies(1,companyB);await page.evaluate(company=>history.replaceState(null,'','/workspace.html?tenant='+company+location.hash),companyB);await page.locator('[data-route="projects"]').click();await page.getByRole('heading',{name:'Projects',exact:true}).waitFor();release.resolve();await page.waitForTimeout(100);assert.ok(!(await page.locator('#workspace-content').innerText()).includes('PRIVATE-BUFFERED-NOTE'));
    });
    await test('narrow operational forms remain readable and focusable across the admitted workflows', async () => {
      for(const [route,action] of [['schedule','scheduleCreate'],['cards','cardCreate'],['dailies','dailyCreate'],['workdays','workdayStart'],['payroll','periodCreate'],['leave','leaveCreate']]) { const user=route==='leave'?4:1; await open(route,user); await page.locator('[data-work-action="'+action+'"]').click(); await page.locator('#work-form').waitFor(); await screenshot('mobile-'+route+'-form'); const field=page.locator('#work-form input,#work-form select').first();await field.focus();assert.equal(await field.evaluate(node=>node===document.activeElement),true); }
    },{width:360,height:800});
    assert.equal(providerEvents.length,providerCount); assert.deepEqual(await repository.load(companyB),foreign);
  } finally {
    for(const hold of holds)hold.resolve();await browser.close();fs.writeFileSync(path.join(artifacts,'results.json'),JSON.stringify({cases,externalRequestsBlocked:external.length,externalRequestsAllowed:0,syntheticOnly:true},null,2));
    await change(db=>{for(const key of Object.keys(db))delete db[key];Object.assign(db,original);});
  }
};
