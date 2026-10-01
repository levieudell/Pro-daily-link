const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const repoDb = path.join(__dirname, 'data', 'db.json');
const repoDbBytes = fs.readFileSync(repoDb);
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-time-cards-'));
const dbFile = path.join(tempDir, 'db.json');
fs.writeFileSync(dbFile, repoDbBytes);
fs.copyFileSync(path.join(__dirname, 'data', 'platform.json'), path.join(tempDir, 'platform.json'));
process.env.PDL_DB_FILE = dbFile;
process.env.PDL_PLATFORM_FILE = path.join(tempDir, 'platform.json');
process.env.PDL_SUPABASE_ENABLED = '0';
process.env.PDL_EMAIL_DEV_MODE = '1';
process.env.PDL_REQUIRE_AUTH = '0';
process.env.PDL_PLATFORM_KEY = 'test-platform-key-32-characters-minimum';

const {server} = require('./server');
const base = 'http://127.0.0.1:4201';
const platformKey = process.env.PDL_PLATFORM_KEY;

function quarterHours(startedAt, endedAt) {
  const elapsed = Math.max(0, (new Date(endedAt) - new Date(startedAt)) / 3600000);
  return Math.round(elapsed * 4) / 4;
}

function dailyHours(startedAt, endedAt) {
  return Math.max(0, Math.round(((new Date(endedAt) - new Date(startedAt)) / 3600000) * 100) / 100);
}

async function request(route, options = {}) {
  const headers = {'Content-Type': 'application/json', ...(options.headers || {})};
  const response = await fetch(base + route, {...options, headers});
  const type = response.headers.get('content-type') || '';
  if (!type.includes('application/json')) return {response, data: null, text: await response.text()};
  return {response, data: await response.json(), text: ''};
}

server.listen(4201, async () => {
  try {
    const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
    const platformHtml = fs.readFileSync(path.join(__dirname, 'platform.js'), 'utf8');
    const appJs = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
    assert.match(html, /Time cards/);
    assert.match(html, /CSV export/);
    assert.match(platformHtml, /Time cards on/);
    assert.match(appJs, /cache:'no-store'/);
    assert.match(appJs, /timeCards:me\.timeCards===true/);
    assert.match(appJs, /resetTeamMemberForm\(\)/);
    assert.doesNotMatch(appJs, /role\?'field'/);
    assert.match(html, /id="team-member-modal"><form method="dialog" autocomplete="off">/);
    assert.match(html, /id="member-account-role" autocomplete="off"><option value="" selected>Employee record only/);
    assert.match(appJs, /historyLines/);
    assert.match(appJs, /function timeCardApproved/);
    assert.match(appJs, /locked=timeCardApproved\(card\)/);
    assert.doesNotMatch(appJs, /localStorage\.(get|set)Item\(['"]pdl-time-cards/);
    assert.match(appJs, /filter\(input=>input\.dataset\.timecardDerived!==['"]true['"]\)/, 'date refresh must discard prior time-card-derived labor');
    assert.match(appJs, /sequence!==reportLaborLookupSequence\|\|key!==reportLaborSelectionKey\(\)/, 'stale labor lookups must not repaint a newer project or date');
    assert.match(appJs, /reportLaborLoadedKey!==reportLaborSelectionKey\(\).*await refreshReportLaborFromTimeCards\(\)/s, 'submission must wait for the selected project/date labor lookup');
    assert.match(appJs, /discardedOfflineReportDrafts\.add\(key\).*localStorage\.removeItem\(`pdl-draft-\$\{key\}`\)/s, 'Start fresh must remove and tombstone the discarded draft');
    assert.match(appJs, /discardedOfflineReportDrafts\.has\(key\)&&!notes\.trim\(\).*localStorage\.removeItem/s, 'blank autosave events must not recreate a discarded draft');
    const formCheck = new Function('team', 'escapeHtml', `
      const fields = {};
      const make = id => fields[id] || (fields[id] = {value:'', hidden:false, innerHTML:'', textContent:'', classList:{remove(){}, add(){}}});
      const $ = id => make(id);
      ${appJs.split('\n').find(line => line.startsWith('function populateMemberCrews'))}
      ${appJs.split('\n').find(line => line.startsWith('function resetTeamMemberForm'))}
      ${appJs.split('\n').find(line => line.includes("$('#member-role').onchange"))}
      make('#member-name').value = 'Crew Tester';
      make('#member-role').value = 'Laborer';
      make('#member-phone').value = '555';
      make('#member-email').value = 'kept@example.test';
      make('#member-new-crew').value = 'Crew B';
      make('#member-account-role').value = 'field';
      make('#member-crew').value = 'Crew A';
      resetTeamMemberForm();
      const cleared = {
        name: make('#member-name').value,
        role: make('#member-role').value,
        phone: make('#member-phone').value,
        email: make('#member-email').value,
        accountRole: make('#member-account-role').value
      };
      make('#member-role').value = 'Laborer';
      make('#member-role').onchange();
      const afterRoles = {};
      for (const role of ['Laborer', 'Field team member', 'Foreman', 'Crew lead', 'Superintendent']) {
        make('#member-account-role').value = 'field';
        make('#member-role').value = role;
        make('#member-role').onchange();
        afterRoles[role] = make('#member-account-role').value;
      }
      return {cleared, afterRole: make('#member-account-role').value, afterRoles};
    `);
    const formReset = formCheck([{crew: 'Crew A'}], value => String(value));
    assert.deepEqual(formReset.cleared, {name: '', role: '', phone: '', email: '', accountRole: ''});
    assert.equal(formReset.afterRole, '');
    assert.deepEqual(formReset.afterRoles, {Laborer: '', 'Field team member': '', Foreman: '', 'Crew lead': '', Superintendent: ''});

    const db = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
    assert.equal(db.company.features, undefined);
    assert.equal(db.timeCards, undefined);
    const owner = db.users.find(user => user.role === 'owner');
    const salt = crypto.randomBytes(16).toString('hex');
    owner.passwordSalt = salt;
    owner.passwordHash = crypto.scryptSync('OwnerPassword!42', salt, 64).toString('hex');
    owner.email = 'owner@example.test';
    fs.writeFileSync(dbFile, JSON.stringify(db));
    process.env.PDL_REQUIRE_AUTH = '1';

    const login = await request('/api/auth/login', {method: 'POST', body: JSON.stringify({email: 'owner@example.test', password: 'OwnerPassword!42'})});
    assert.equal(login.response.status, 200);
    const auth = {Authorization: `Bearer ${login.data.token}`};
    const meOff = await request('/api/auth/me', {headers: auth});
    assert.equal(meOff.response.headers.get('cache-control'), 'no-store');
    assert.equal(meOff.data.timeCards, false);
    const platform = {'x-pdl-platform-key': platformKey};

    for (const route of ['/api/time-cards', '/api/time-cards.csv', '/api/time-cards/approve']) {
      const hidden = await request(route, {headers: auth, method: route.endsWith('approve') ? 'POST' : 'GET', body: route.endsWith('approve') ? JSON.stringify({ids: [1]}) : undefined});
      assert.equal(hidden.response.status, 404, route);
    }
    const denied = await request('/api/platform/companies/northstar/features', {method: 'PATCH', headers: {...auth, 'x-pdl-platform-key': ''}, body: JSON.stringify({timeCards: true})});
    assert.equal(denied.response.status, 401);
    const companyPatch = await request('/api/company', {method: 'PATCH', headers: auth, body: JSON.stringify({name: 'Northstar Construction', features: {timeCards: true}})});
    assert.equal(companyPatch.response.status, 200);
    assert.notEqual(companyPatch.data.features?.timeCards, true);
    const stillOff = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
    assert.notEqual(stillOff.company.features?.timeCards, true);

    const beforeHours = await request('/api/production', {headers: auth});
    const beforeInsights = await request('/api/insights', {headers: auth});
    assert.equal(beforeHours.response.status, 200);
    assert.equal(beforeInsights.response.status, 200);

    const offStart = await request('/api/workdays/start', {method: 'POST', headers: auth, body: JSON.stringify({projectId: 1, memberIds: [1, 3]})});
    assert.equal(offStart.response.status, 201);
    assert.equal(offStart.data.projectId, 1);
    const offEnd = await request(`/api/workdays/${offStart.data.id}/end`, {method: 'POST', headers: auth, body: JSON.stringify({notes: 'Flag off workday stays the same.', foreman: 'Hours Snapshot'})});
    assert.equal(offEnd.response.status, 200);
    assert.equal(offEnd.data.report.status, 'Draft');
    assert.deepEqual(offEnd.data.report.productionEntries, []);
    const offDailyHours = dailyHours(offEnd.data.workday.startedAt, offEnd.data.workday.endedAt);
    assert.equal(offEnd.data.report.laborEntries[0].hours, offDailyHours);
    assert.equal(offEnd.data.report.laborEntries[1].hours, offDailyHours);
    assert.equal(offEnd.data.report.labor, offDailyHours ? `2 people · ${offDailyHours} hours each` : '');
    assert.equal(Object.hasOwn(offEnd.data.report, 'timeCardId'), false);
    const offKeys = Object.keys(offEnd.data.report).sort();
    const offStored = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
    assert.equal(offStored.timeCards, undefined);
    const offState = await request('/api/state', {headers: auth});
    assert.equal(Object.hasOwn(offState.data, 'timeCards'), false);
    assert.equal(offState.data.company.features?.timeCards, undefined);

    const signup = await request('/api/signup', {method: 'POST', body: JSON.stringify({companyName: 'Other Builders', ownerName: 'Bea Owner', email: 'bea-timecards@example.test', password: 'TenantPassword!42', trade: 'Concrete', employeeCount: 4, projectCount: 1, plan: 'starter', legalAccepted: true, legalVersion: '2026-09-17'})});
    assert.equal(signup.response.status, 201);
    const otherId = signup.data.company.id;
    const otherLogin = await request('/api/auth/login', {method: 'POST', headers: {'X-PDL-Company': otherId}, body: JSON.stringify({email: 'bea-timecards@example.test', password: 'TenantPassword!42'})});
    assert.equal(otherLogin.response.status, 200);
    const otherAuth = {Authorization: `Bearer ${otherLogin.data.token}`, 'X-PDL-Company': otherId};
    const otherDenied = await request(`/api/platform/companies/${otherId}/features`, {method: 'PATCH', headers: {...otherAuth, 'x-pdl-platform-key': ''}, body: JSON.stringify({timeCards: true})});
    assert.equal(otherDenied.response.status, 401);

    const overviewOff = await request('/api/platform/overview', {headers: platform});
    assert.equal(overviewOff.response.status, 200);
    assert.equal(overviewOff.data.companies.find(company => company.id === 'northstar').timeCards, false);
    assert.equal(overviewOff.data.companies.find(company => company.id === otherId).timeCards, false);

    const enabled = await request('/api/platform/companies/northstar/features', {method: 'PATCH', headers: platform, body: JSON.stringify({timeCards: true})});
    assert.equal(enabled.response.status, 200);
    assert.equal(enabled.data.timeCards, true);
    const overviewOn = await request('/api/platform/overview', {headers: platform});
    assert.equal(overviewOn.data.companies.find(company => company.id === 'northstar').timeCards, true);
    assert.equal(overviewOn.data.companies.find(company => company.id === otherId).timeCards, false);
    const turnedOn = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
    assert.equal(turnedOn.company.features.timeCards, true);
    const meOn = await request('/api/auth/me', {headers: auth});
    assert.equal(meOn.data.timeCards, true);
    assert.equal((await request('/api/state', {headers: auth})).data.company.features.timeCards, true);

    const started = await request('/api/workdays/start', {method: 'POST', headers: auth, body: JSON.stringify({projectId: 1, memberIds: [1, 3]})});
    assert.equal(started.response.status, 201);
    let cards = (await request('/api/time-cards', {headers: auth})).data;
    assert.equal(cards.length, 2);
    assert.deepEqual(cards.map(card => card.memberId).sort(), [1, 3]);
    for (const card of cards) {
      assert.equal(card.projectId, 1);
      assert.notEqual(card.projectId, 0);
      assert.equal(card.status, 'draft');
      assert.equal(card.outAt, null);
      assert.equal(card.workdayId, started.data.id);
      assert.match(card.date, /^\d{4}-\d{2}-\d{2}$/);
      assert.equal(card.history[0].action, 'Opened');
    }
    const duplicate = await request('/api/workdays/start', {method: 'POST', headers: auth, body: JSON.stringify({projectId: 1, memberIds: [1]})});
    assert.equal(duplicate.response.status, 409);
    cards = (await request('/api/time-cards', {headers: auth})).data;
    assert.equal(cards.filter(card => card.memberId === 1 && !card.outAt).length, 1);
    assert.equal(cards.length, 2);

    const ended = await request(`/api/workdays/${started.data.id}/end`, {method: 'POST', headers: auth, body: JSON.stringify({notes: 'Flag on workday still writes the same draft.', foreman: 'Hours Snapshot'})});
    assert.equal(ended.response.status, 200);
    assert.equal(ended.data.report.status, 'Draft');
    assert.deepEqual(ended.data.report.productionEntries, []);
    assert.deepEqual(Object.keys(ended.data.report).sort(), offKeys);
    assert.equal(Object.hasOwn(ended.data.report, 'timeCardId'), false);
    const onDailyHours = dailyHours(ended.data.workday.startedAt, ended.data.workday.endedAt);
    assert.equal(ended.data.report.laborEntries[0].hours, onDailyHours);
    assert.equal(ended.data.report.labor, onDailyHours ? `2 people · ${onDailyHours} hours each` : '');
    cards = (await request('/api/time-cards', {headers: auth})).data;
    assert.equal(cards.length, 2);
    for (const card of cards) {
      assert.equal(card.outAt, ended.data.workday.endedAt);
      assert.equal(card.hours, quarterHours(card.inAt, card.outAt));
      assert.equal(card.reportId, ended.data.report.id);
      assert.equal(card.status, 'draft');
      assert.equal(card.history.at(-1).action, 'Closed');
    }
    const dailyBeforeEdit = (await request('/api/state', {headers: auth})).data.reports.find(report => report.id === ended.data.report.id);

    const fieldUser = (await request('/api/users', {method: 'POST', headers: auth, body: JSON.stringify({name: 'Marcus Reed', email: 'marcus-cards@example.test', role: 'field', memberId: 1})})).data;
    assert.equal((await request('/api/auth/claim', {method: 'POST', body: JSON.stringify({email: fieldUser.email, temporaryPassword: fieldUser.temporaryPassword, password: 'FieldPassword!42'})})).response.status, 200);
    const fieldLogin = await request('/api/auth/login', {method: 'POST', body: JSON.stringify({email: 'marcus-cards@example.test', password: 'FieldPassword!42'})});
    assert.equal(fieldLogin.response.status, 200);
    const fieldAuth = {Authorization: `Bearer ${fieldLogin.data.token}`};
    const foremanUser = (await request('/api/users', {method: 'POST', headers: auth, body: JSON.stringify({name: 'Crew Foreman', email: 'foreman-cards@example.test', role: 'foreman', memberId: 1})})).data;
    assert.equal((await request('/api/auth/claim', {method: 'POST', body: JSON.stringify({email: foremanUser.email, temporaryPassword: foremanUser.temporaryPassword, password: 'ForemanPassword!42'})})).response.status, 200);
    const foremanLogin = await request('/api/auth/login', {method: 'POST', body: JSON.stringify({email: foremanUser.email, password: 'ForemanPassword!42'})});
    assert.equal(foremanLogin.response.status, 200);
    const foremanAuth = {Authorization: `Bearer ${foremanLogin.data.token}`};
    const foremanMe = await request('/api/auth/me', {headers: foremanAuth});
    assert.equal(foremanMe.data.role, 'field');
    assert.equal(foremanMe.data.accessRole, 'foreman');
    const foremanCards = await request('/api/time-cards', {headers: foremanAuth});
    assert.equal(foremanCards.response.status, 200);
    assert.ok(foremanCards.data.every(card => [1, 3].includes(card.memberId)));
    const ownCards = await request('/api/time-cards', {headers: fieldAuth});
    assert.equal(ownCards.response.status, 200);
    assert.ok(ownCards.data.length >= 1);
    assert.ok(ownCards.data.every(card => card.memberId === 1));
    const fieldState = await request('/api/state', {headers: fieldAuth});
    assert.ok(fieldState.data.timeCards.every(card => card.memberId === 1));
    assert.equal(fieldState.data.timeCards.some(card => card.memberId === 3), false);
    const otherPerson = await request('/api/time-cards?memberId=3', {headers: fieldAuth});
    assert.equal(otherPerson.response.status, 403);
    const marcus = cards.find(card => card.memberId === 1);
    const jamal = cards.find(card => card.memberId === 3);
    const fieldApprove = await request(`/api/time-cards/${marcus.id}/approve`, {method: 'POST', headers: fieldAuth, body: '{}'});
    assert.equal(fieldApprove.response.status, 403);
    const fieldEdit = await request(`/api/time-cards/${marcus.id}`, {method: 'PATCH', headers: fieldAuth, body: JSON.stringify({inAt: '2026-09-29T15:00:00.000Z', outAt: '2026-09-29T16:10:00.000Z'})});
    assert.equal(fieldEdit.response.status, 403);
    const fieldOtherSubmit = await request(`/api/time-cards/${jamal.id}/submit`, {method: 'POST', headers: fieldAuth, body: '{}'});
    assert.equal(fieldOtherSubmit.response.status, 404);
    const fieldCsv = await request('/api/time-cards.csv', {headers: fieldAuth});
    assert.equal(fieldCsv.response.status, 403);
    const activities = await request('/api/company-activities', {headers: fieldAuth});
    assert.equal(activities.response.status, 200);
    assert.ok(activities.data.some(row => row.name === 'Loading / unloading trucks'));
    const officeActivity = activities.data.find(row => row.name === 'Office');
    const manualCard = await request('/api/time-cards', {method:'POST',headers:auth,body:JSON.stringify({memberId:2,projectId:1,inAt:'2035-01-02T16:00:00.000Z',outAt:'2035-01-02T20:00:00.000Z',reason:'Missed punches entered by office'})});
    assert.equal(manualCard.response.status,201,manualCard.data.error||'');
    assert.equal(manualCard.data.status,'draft');
    assert.equal(manualCard.data.hours,4);
    const overlapCard = await request('/api/time-cards', {method:'POST',headers:auth,body:JSON.stringify({memberId:2,projectId:1,inAt:'2035-01-02T19:00:00.000Z',outAt:'2035-01-02T21:00:00.000Z',reason:'This should overlap'})});
    assert.equal(overlapCard.response.status,409);
    assert.match(overlapCard.data.error,/overlap/i);
    const deletedManual = await request(`/api/time-cards/${manualCard.data.id}`,{method:'DELETE',headers:auth,body:JSON.stringify({reason:'Duplicate office entry'})});
    assert.equal(deletedManual.response.status,200);
    assert.equal((await request('/api/time-cards',{headers:auth})).data.some(card=>card.id===manualCard.data.id),false);
    assert.ok(JSON.parse(fs.readFileSync(dbFile,'utf8')).timeCards.find(card=>card.id===manualCard.data.id)?.deletedAt);
    const companyClock = await request('/api/time-cards/company-clock', {method: 'POST', headers: fieldAuth, body: JSON.stringify({activityCodeId: officeActivity.id})});
    assert.equal(companyClock.response.status, 201);
    assert.equal(companyClock.data.projectId, null);
    assert.equal(companyClock.data.activityName, 'Office');
    const companyClockOut = await request(`/api/time-cards/${companyClock.data.id}/clock-out`, {method: 'POST', headers: fieldAuth, body: '{}'});
    assert.equal(companyClockOut.response.status, 200);
    assert.ok(companyClockOut.data.outAt);
    const leave = await request('/api/time-off-requests', {method: 'POST', headers: fieldAuth, body: JSON.stringify({startDate: '2026-10-05', endDate: '2026-10-06', type: 'vacation', note: 'Family time'})});
    assert.equal(leave.response.status, 201);
    assert.equal(leave.data.status, 'pending');
    const ownLeave = await request('/api/time-off-requests', {headers: fieldAuth});
    assert.equal(ownLeave.data.length, 1);
    const approvedLeave = await request(`/api/time-off-requests/${leave.data.id}/approve`, {method: 'POST', headers: auth, body: JSON.stringify({note: 'Crew coverage confirmed'})});
    assert.equal(approvedLeave.response.status, 200);
    assert.equal(approvedLeave.data.status, 'approved');
    const submitted = await request(`/api/time-cards/${marcus.id}/submit`, {method: 'POST', headers: fieldAuth, body: '{}'});
    assert.equal(submitted.response.status, 200);
    assert.equal(submitted.data.status, 'submitted');
    assert.equal(submitted.data.submittedBy, 'Marcus Reed');
    assert.equal(submitted.data.history.at(-1).action, 'Submitted');

    const unlinkedDb = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
    const automaticDraft = unlinkedDb.reports.find(report => report.id === ended.data.report.id);
    const submittedReport = {...automaticDraft, id: Math.max(...unlinkedDb.reports.map(report => Number(report.id))) + 1, status: 'Needs review', laborEntries: automaticDraft.laborEntries.map(entry => ({...entry})), history: [...(automaticDraft.history || []), {action: 'Submitted', by: 'Marcus Reed', at: new Date().toISOString()}]};
    unlinkedDb.reports.unshift(submittedReport);
    unlinkedDb.timeCards.find(card => card.id === marcus.id).reportId = automaticDraft.id;
    fs.writeFileSync(dbFile, JSON.stringify(unlinkedDb));

    const missingReason = await request(`/api/time-cards/${marcus.id}`, {method: 'PATCH', headers: auth, body: JSON.stringify({inAt: '2026-09-29T15:00:00.000Z', outAt: '2026-09-29T16:10:00.000Z'})});
    assert.equal(missingReason.response.status, 400);
    assert.match(missingReason.data.error, /why|corrected/i);

    const edited = await request(`/api/time-cards/${marcus.id}`, {method: 'PATCH', headers: auth, body: JSON.stringify({inAt: '2026-09-29T15:00:00.000Z', outAt: '2026-09-29T16:10:00.000Z', reason: 'Correct missed punch'})});
    assert.equal(edited.response.status, 200);
    assert.equal(edited.data.hours, 1.25);
    assert.equal(edited.data.date, '2026-09-29');
    assert.equal(edited.data.status, 'draft');
    assert.equal(edited.data.history.at(-1).action, 'Times edited');
    assert.match(edited.data.historyLines.at(-1), /^Times corrected by Levi Foreman · \d{1,2}:\d{2} [AP]M · Correct missed punch$/);
    assert.equal(edited.data.history.at(-1).before.hours, quarterHours(marcus.inAt, marcus.outAt));
    assert.equal(edited.data.original.inAt, marcus.inAt);
    const stateAfterEdit = (await request('/api/state', {headers: auth})).data;
    const dailyAfterEdit = stateAfterEdit.reports.find(report => report.id === submittedReport.id);
    assert.equal(dailyAfterEdit.laborEntries[0].hours, 1.25);
    assert.equal(stateAfterEdit.reports.find(report => report.id === automaticDraft.id).laborEntries[0].hours, quarterHours(marcus.inAt, marcus.outAt));
    assert.equal(JSON.parse(fs.readFileSync(dbFile, 'utf8')).timeCards.find(card => card.id === marcus.id).reportId, submittedReport.id);
    assert.equal(dailyAfterEdit.status, 'Needs review');

    assert.equal((await request(`/api/time-cards/${marcus.id}/approve`, {method: 'POST', headers: auth, body: '{}'})).response.status, 409);
    assert.equal((await request(`/api/time-cards/${marcus.id}/submit`, {method: 'POST', headers: auth, body: '{}'})).response.status, 200);
    const approved = await request(`/api/time-cards/${marcus.id}/approve`, {method: 'POST', headers: auth, body: '{}'});
    assert.equal(approved.response.status, 200);
    assert.equal(approved.data.status, 'approved');
    assert.equal(approved.data.approvedBy, 'Levi Foreman');
    assert.equal(approved.data.history.at(-1).action, 'Approved');
    assert.match(approved.data.historyLines.at(-1), /^Approved by Levi Foreman · \d{1,2}:\d{2} [AP]M$/);
    const suggestedLabor = await request(`/api/report-labor-suggestions?projectId=${marcus.projectId}&date=${edited.data.date}`, {headers: auth});
    assert.equal(suggestedLabor.response.status, 200);
    assert.equal(suggestedLabor.data.cardCount, 1);
    assert.deepEqual(suggestedLabor.data.laborEntries.map(row => ({memberId: row.memberId, hours: row.hours})), [{memberId: marcus.memberId, hours: approved.data.hours}]);
    const correctedApproved = await request(`/api/time-cards/${marcus.id}`, {method: 'PATCH', headers: auth, body: JSON.stringify({inAt: '2026-09-29T15:00:00.000Z', outAt: '2026-09-29T16:10:00.000Z', reason: 'Correct approved punch'})});
    assert.equal(correctedApproved.response.status, 200);
    assert.equal(correctedApproved.data.status, 'draft');
    assert.equal(correctedApproved.data.approvedBy, null);
    const lockedCard = (await request('/api/time-cards?memberId=1', {headers: auth})).data.find(card => card.id === marcus.id);
    assert.equal(lockedCard.hours, 1.25);
    assert.equal(lockedCard.status, 'draft');
    const dailyAfterApprove = (await request('/api/state', {headers: auth})).data.reports.find(report => report.id === submittedReport.id);
    assert.equal(dailyAfterApprove.status, 'Needs review');
    assert.deepEqual(dailyAfterApprove.laborEntries, dailyAfterEdit.laborEntries);

    const editedAgain = await request(`/api/time-cards/${marcus.id}`, {method: 'PATCH', headers: auth, body: JSON.stringify({inAt: '2026-09-29T15:00:00.000Z', outAt: '2026-09-29T16:10:00.000Z', reason: 'Correct missed punch'})});
    assert.equal(editedAgain.response.status, 200);
    assert.equal(editedAgain.data.hours, 1.25);
    assert.equal((await request(`/api/time-cards/${marcus.id}/submit`, {method: 'POST', headers: auth, body: '{}'})).data.status, 'submitted');
    assert.equal((await request(`/api/time-cards/${marcus.id}/approve`, {method: 'POST', headers: auth, body: '{}'})).data.status, 'approved');
    const marcusRows = JSON.parse(fs.readFileSync(dbFile, 'utf8')).timeCards.filter(card => String(card.id).trim() === String(marcus.id));
    assert.equal(marcusRows.length, 1);
    assert.equal(marcusRows[0].status, 'approved');
    assert.equal(marcusRows[0].hours, 1.25);

    const manager = (await request('/api/users', {method: 'POST', headers: auth, body: JSON.stringify({name: 'Pat Manager', email: 'pat-cards@example.test', role: 'project_manager', projectIds: [1]})})).data;
    assert.equal((await request('/api/auth/claim', {method: 'POST', body: JSON.stringify({email: manager.email, temporaryPassword: manager.temporaryPassword, password: 'ManagerPassword!42'})})).response.status, 200);
    const managerLogin = await request('/api/auth/login', {method: 'POST', body: JSON.stringify({email: 'pat-cards@example.test', password: 'ManagerPassword!42'})});
    const managerAuth = {Authorization: `Bearer ${managerLogin.data.token}`};
    assert.equal((await request('/api/time-cards', {headers: managerAuth})).response.status, 403);
    const managerTimeAccess = await request(`/api/users/${manager.id}/time-access`, {method: 'PATCH', headers: auth, body: JSON.stringify({manageTime: true})});
    assert.equal(managerTimeAccess.data.permissions.manageTime, true);
    const managerSees = await request('/api/time-cards', {headers: managerAuth});
    assert.equal(managerSees.response.status, 200);
    assert.ok(managerSees.data.some(card => card.id === jamal.id));
    const managerFlip = await request('/api/platform/companies/northstar/features', {method: 'PATCH', headers: {...managerAuth, 'x-pdl-platform-key': ''}, body: JSON.stringify({timeCards: false})});
    assert.equal(managerFlip.response.status, 401);

    const disabled = await request('/api/platform/companies/northstar/features', {method: 'PATCH', headers: platform, body: JSON.stringify({timeCards: false})});
    assert.equal(disabled.data.timeCards, false);
    assert.equal((await request('/api/time-cards', {headers: auth})).response.status, 404);
    assert.equal(Object.hasOwn((await request('/api/state', {headers: auth})).data, 'timeCards'), false);
    const hiddenStart = await request('/api/workdays/start', {method: 'POST', headers: auth, body: JSON.stringify({projectId: 1, memberIds: [6]})});
    assert.equal(hiddenStart.response.status, 201);
    const hiddenEnd = await request(`/api/workdays/${hiddenStart.data.id}/end`, {method: 'POST', headers: auth, body: JSON.stringify({notes: 'Switch off still skips time cards.', foreman: 'Hours Snapshot'})});
    assert.equal(hiddenEnd.response.status, 200);
    assert.deepEqual(Object.keys(hiddenEnd.data.report).sort(), offKeys);
    assert.equal(hiddenEnd.data.report.laborEntries[0].hours, dailyHours(hiddenEnd.data.workday.startedAt, hiddenEnd.data.workday.endedAt));
    await request('/api/platform/companies/northstar/features', {method: 'PATCH', headers: platform, body: JSON.stringify({timeCards: true})});
    const storedWhileHidden = JSON.parse(fs.readFileSync(dbFile, 'utf8')).timeCards.filter(card => card.memberId === 6);
    assert.equal(storedWhileHidden.length, 0);
    const openGuard = await request('/api/workdays/start', {method: 'POST', headers: auth, body: JSON.stringify({projectId: 1, memberIds: [6]})});
    assert.equal(openGuard.response.status, 201);
    const guardOff = await request('/api/platform/companies/northstar/features', {method: 'PATCH', headers: platform, body: JSON.stringify({timeCards: false})});
    assert.equal(guardOff.data.timeCards, false);
    assert.equal((await request(`/api/workdays/${openGuard.data.id}/end`, {method: 'POST', headers: auth, body: JSON.stringify({notes: 'Leave the open time card in place.', foreman: 'Hours Snapshot'})})).response.status, 200);
    await request('/api/platform/companies/northstar/features', {method: 'PATCH', headers: platform, body: JSON.stringify({timeCards: true})});
    const blocked = await request('/api/workdays/start', {method: 'POST', headers: auth, body: JSON.stringify({projectId: 2, memberIds: [6]})});
    assert.equal(blocked.response.status, 409);
    assert.match(blocked.data.error, /open time card/i);
    const openCards = (await request('/api/time-cards?memberId=6', {headers: auth})).data.filter(card => !card.outAt);
    assert.equal(openCards.length, 1);
    assert.equal(openCards[0].projectId, 1);
    const guardOut = new Date(Date.now() - 3600000).toISOString(), guardIn = new Date(Date.now() - 7200000).toISOString();
    const closedGuard = await request(`/api/time-cards/${openCards[0].id}`, {method: 'PATCH', headers: auth, body: JSON.stringify({inAt: guardIn, outAt: guardOut, reason: 'Close forgotten punch'})});
    assert.equal(closedGuard.response.status, 200);
    assert.equal(closedGuard.data.hours, 1);

    const second = await request('/api/workdays/start', {method: 'POST', headers: auth, body: JSON.stringify({projectId: 1, memberIds: [2]})});
    assert.equal(second.response.status, 201);
    const secondEnd = await request(`/api/workdays/${second.data.id}/end`, {method: 'POST', headers: auth, body: JSON.stringify({notes: 'Manager can approve a time card.', foreman: 'Hours Snapshot'})});
    assert.equal(secondEnd.response.status, 200);
    const diego = (await request('/api/time-cards?memberId=2', {headers: managerAuth})).data.find(card => card.workdayId === second.data.id);
    assert.ok(diego);
    assert.equal(diego.projectId, 1);
    assert.equal((await request(`/api/time-cards/${diego.id}/submit`, {method: 'POST', headers: managerAuth, body: '{}'})).response.status, 200);
    const managerApproved = await request(`/api/time-cards/${diego.id}/approve`, {method: 'POST', headers: managerAuth, body: '{}'});
    assert.equal(managerApproved.response.status, 200);
    assert.equal(managerApproved.data.status, 'approved');
    assert.equal(managerApproved.data.approvedBy, 'Pat Manager');

    const bulkStart = await request('/api/workdays/start', {method: 'POST', headers: auth, body: JSON.stringify({projectId: 1, memberIds: [6, 10]})});
    assert.equal(bulkStart.response.status, 201);
    assert.equal((await request(`/api/workdays/${bulkStart.data.id}/end`, {method: 'POST', headers: auth, body: JSON.stringify({notes: 'Bulk approve these time cards.', foreman: 'Hours Snapshot'})})).response.status, 200);
    const bulkCards = (await request('/api/time-cards', {headers: auth})).data.filter(card => card.workdayId === bulkStart.data.id);
    assert.equal(bulkCards.length, 2);
    for(const card of bulkCards)assert.equal((await request(`/api/time-cards/${card.id}/submit`, {method: 'POST', headers: auth, body: '{}'})).response.status, 200);
    const bulk = await request('/api/time-cards/approve', {method: 'POST', headers: auth, body: JSON.stringify({ids: bulkCards.map(card => card.id)})});
    assert.equal(bulk.response.status, 200);
    assert.ok(bulk.data.timeCards.every(card => card.status === 'approved'));
    const bulkStored = JSON.parse(fs.readFileSync(dbFile, 'utf8')).timeCards.filter(card => card.workdayId === bulkStart.data.id);
    assert.equal(bulkStored.length, bulkCards.length);
    assert.equal(new Set(bulkStored.map(card => String(card.id).trim())).size, bulkCards.length);
    const bulkCorrected = await request(`/api/time-cards/${bulkCards[0].id}`, {method: 'PATCH', headers: auth, body: JSON.stringify({inAt: bulkCards[0].inAt, outAt: new Date(new Date(bulkCards[0].inAt).getTime() + 7200000).toISOString(), reason: 'Approved card correction'})});
    assert.equal(bulkCorrected.response.status, 200);
    assert.equal(bulkCorrected.data.status, 'draft');

    const csv = await request('/api/time-cards.csv?from=2026-09-01&to=2026-09-30&projectId=1', {headers: auth});
    assert.equal(csv.response.status, 200);
    assert.match(csv.response.headers.get('content-type'), /text\/csv/);
    assert.match(csv.response.headers.get('content-disposition'), /filename="time-cards-2026-09-01-2026-09-30\.csv"/);
    const csvLines = csv.text.trim().split('\n');
    assert.equal(csvLines[0], 'person,job,job code,date,in,out,hours,status,approved by');
    assert.ok(csvLines.some(line => line === 'Marcus Reed,Division Street Clinic,DSC,2026-09-29,8:00 AM,9:10 AM,1.25,approved,Levi Foreman'));
    assert.equal(csv.text.includes('2026-09-29T'), false);
    assert.equal(quarterHours('2026-09-29T16:04:37.902Z', '2026-09-29T16:06:22.962Z'), 0);
    const filteredOut = await request(`/api/time-cards.csv?from=${jamal.date}&to=${jamal.date}&memberId=3&status=draft`, {headers: auth});
    assert.equal(filteredOut.text.includes('Marcus Reed'), false);
    assert.ok(filteredOut.text.includes('Jamal'));

    const otherOff = await request('/api/time-cards', {headers: otherAuth});
    assert.equal(otherOff.response.status, 404);
    const otherEnabled = await request(`/api/platform/companies/${otherId}/features`, {method: 'PATCH', headers: platform, body: JSON.stringify({timeCards: true})});
    assert.equal(otherEnabled.data.timeCards, true);
    const otherCards = await request('/api/time-cards', {headers: otherAuth});
    assert.equal(otherCards.response.status, 200);
    assert.deepEqual(otherCards.data, []);
    const crossed = await request('/api/time-cards', {headers: {Authorization: `Bearer ${login.data.token}`, 'X-PDL-Company': otherId}});
    assert.equal(crossed.response.status, 401);
    const otherReadsPrimary = await request(`/api/time-cards/${marcus.id}`, {method: 'PATCH', headers: otherAuth, body: JSON.stringify({inAt: '2026-09-29T15:00:00.000Z', outAt: '2026-09-29T18:00:00.000Z'})});
    assert.equal(otherReadsPrimary.response.status, 404);
    const northstarCards = (await request('/api/time-cards', {headers: auth})).data;
    assert.equal(northstarCards.find(card => card.id === marcus.id).hours, 1.25);
    const shortCard = await request(`/api/time-cards/${jamal.id}`, {method: 'PATCH', headers: auth, body: JSON.stringify({inAt: '2026-09-29T16:04:37.902Z', outAt: '2026-09-29T16:06:22.962Z', reason: 'Correct field test'})});
    assert.equal(shortCard.response.status, 200);
    assert.equal(shortCard.data.hours, 0);
    assert.equal(shortCard.data.date, '2026-09-29');
    const shortCsv = await request('/api/time-cards.csv?memberId=3&from=2026-09-29&to=2026-09-29', {headers: auth});
    assert.match(shortCsv.text, /Jamal Brooks,Division Street Clinic,DSC,2026-09-29,9:04 AM,9:06 AM,0,/);
    const storedZone = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
    const previousZone = storedZone.company.timezone;
    delete storedZone.company.timezone;
    fs.writeFileSync(dbFile, JSON.stringify(storedZone));
    const fallbackCsv = await request('/api/time-cards.csv?memberId=1&from=2026-09-29&to=2026-09-29', {headers: auth});
    assert.match(fallbackCsv.text, /Marcus Reed,Division Street Clinic,DSC,2026-09-29,8:00 AM,9:10 AM,1\.25,approved,Levi Foreman/);
    storedZone.company.timezone = previousZone || 'America/Los_Angeles';
    fs.writeFileSync(dbFile, JSON.stringify(storedZone));

    const originalFetch = global.fetch;
    const cloudSnapshots = new Map();
    let staleLoad = null;
    process.env.PDL_SUPABASE_ENABLED = '1';
    process.env.SUPABASE_URL = 'https://supabase.test';
    process.env.SUPABASE_SECRET_KEY = 'test-secret';
    global.fetch = async (url, options = {}) => {
      const href = String(url);
      if (!href.startsWith('https://supabase.test')) return originalFetch(url, options);
      const method = String(options.method || 'GET').toUpperCase();
      if (href.includes('/rest/v1/companies') && method === 'GET' && href.includes('id=eq.')) {
        const id = decodeURIComponent(href.match(/id=eq\.([^&]+)/)[1]);
        const row = staleLoad && staleLoad.company?.id === id ? staleLoad : cloudSnapshots.get(id);
        return new Response(JSON.stringify(row ? [{data: row}] : []), {status: 200, headers: {'Content-Type': 'application/json'}});
      }
      if (href.includes('/rest/v1/companies') && method === 'POST') {
        for (const row of JSON.parse(options.body)) if (row?.data?.company?.id) cloudSnapshots.set(row.id, row.data);
        return new Response('', {status: 201});
      }
      return new Response('[]', {status: 200, headers: {'Content-Type': 'application/json'}});
    };
    try {
      const uiHeaders = {...otherAuth, 'Content-Type': 'application/json'};
      const customer = await request('/api/customers', {method: 'POST', headers: uiHeaders, body: JSON.stringify({name: 'QA Customer'})});
      assert.equal(customer.response.status, 201);
      const project = await request('/api/projects', {method: 'POST', headers: uiHeaders, body: JSON.stringify({name: 'QA Test Job', code: 'QATE', customerId: customer.data.id, status: 'On track'})});
      assert.equal(project.response.status, 201);
      const fieldMember = await request('/api/team', {method: 'POST', headers: uiHeaders, body: JSON.stringify({name: 'Field Tester', role: 'Laborer', crew: 'QA Crew A', phone: '', email: '', initials: 'FT', hours: 0, site: 'Not assigned'})});
      const crewMember = await request('/api/team', {method: 'POST', headers: uiHeaders, body: JSON.stringify({name: 'Crew Tester', role: 'Laborer', crew: 'QA Crew A', phone: '', email: '', initials: 'CT', hours: 0, site: 'Not assigned'})});
      assert.equal(fieldMember.response.status, 201);
      assert.equal(crewMember.response.status, 201);
      assert.equal(fieldMember.data.user, undefined);
      const startedUi = await request('/api/workdays/start', {method: 'POST', headers: uiHeaders, body: JSON.stringify({projectId: project.data.id, memberIds: [fieldMember.data.id]})});
      assert.equal(startedUi.response.status, 201);
      assert.equal((await request(`/api/workdays/${startedUi.data.id}/end`, {method: 'POST', headers: uiHeaders, body: JSON.stringify({notes: 'QA test job finished.', foreman: 'QA Tester'})})).response.status, 200);
      const uiCard = (await request('/api/time-cards', {headers: uiHeaders})).data.find(card => card.memberId === fieldMember.data.id && card.workdayId === startedUi.data.id);
      assert.equal((await request(`/api/time-cards/${uiCard.id}/submit`, {method: 'POST', headers: uiHeaders, body: '{}'})).response.status, 200);
      const uiApproved = await request(`/api/time-cards/${uiCard.id}/approve`, {method: 'POST', headers: uiHeaders, body: '{}'});
      assert.equal(uiApproved.response.status, 200);
      assert.equal(uiApproved.data.status, 'approved');
      const tenantFile = path.join(tempDir, 'tenants', `${otherId}.json`);
      const approvedDisk = JSON.parse(fs.readFileSync(tenantFile, 'utf8'));
      const approvedOnDisk = approvedDisk.timeCards.find(card => card.id === uiCard.id);
      assert.equal(approvedOnDisk.status, 'approved');
      staleLoad = structuredClone(approvedDisk);
      staleLoad.timeCards.find(card => card.id === uiCard.id).status = 'submitted';
      staleLoad.timeCards.find(card => card.id === uiCard.id).approvedBy = null;
      staleLoad.timeCards.find(card => card.id === uiCard.id).approvedAt = null;
      staleLoad.company.persistence.revision = Number(approvedDisk.company.persistence.revision) - 1;
      const uiUnapproved = await request(`/api/time-cards/${uiCard.id}/unapprove`, {method: 'POST', headers: uiHeaders, body: '{}'});
      assert.equal(uiUnapproved.response.status, 200, uiUnapproved.data.error || '');
      assert.equal(uiUnapproved.data.status, 'draft');
      assert.equal(uiUnapproved.data.approvedBy, null);
      assert.equal(uiUnapproved.data.history.at(-1).action, 'Unapproved');
      assert.equal(uiUnapproved.data.history.at(-1).by, 'Bea Owner');
      assert.match(uiUnapproved.data.historyLines.at(-1), /^Unapproved by Bea Owner · \d{1,2}:\d{2} [AP]M$/);
      const uiEdited = await request(`/api/time-cards/${uiCard.id}`, {method: 'PATCH', headers: uiHeaders, body: JSON.stringify({inAt: '2026-09-29T16:04:00.000Z', outAt: '2026-09-29T16:19:00.000Z', reason: 'Correct UI test punch'})});
      assert.equal(uiEdited.response.status, 200);
      assert.equal(uiEdited.data.hours, 0.25);
      assert.equal((await request(`/api/time-cards/${uiCard.id}/submit`, {method: 'POST', headers: uiHeaders, body: '{}'})).response.status, 200);
      assert.equal((await request(`/api/time-cards/${uiCard.id}/approve`, {method: 'POST', headers: uiHeaders, body: '{}'})).data.status, 'approved');
      staleLoad = null;
      const bulkUi = await request('/api/workdays/start', {method: 'POST', headers: uiHeaders, body: JSON.stringify({projectId: project.data.id, memberIds: [fieldMember.data.id, crewMember.data.id]})});
      assert.equal(bulkUi.response.status, 201);
      assert.equal((await request(`/api/workdays/${bulkUi.data.id}/end`, {method: 'POST', headers: uiHeaders, body: JSON.stringify({notes: 'Bulk approve these QA cards.', foreman: 'QA Tester'})})).response.status, 200);
      const bulkUiCards = (await request('/api/time-cards', {headers: uiHeaders})).data.filter(card => card.workdayId === bulkUi.data.id);
      assert.equal(bulkUiCards.length, 2);
      for(const card of bulkUiCards)assert.equal((await request(`/api/time-cards/${card.id}/submit`, {method: 'POST', headers: uiHeaders, body: '{}'})).response.status, 200);
      const bulkUiApproved = await request('/api/time-cards/approve', {method: 'POST', headers: uiHeaders, body: JSON.stringify({ids: bulkUiCards.map(card => card.id)})});
      assert.equal(bulkUiApproved.response.status, 200);
      assert.ok(bulkUiApproved.data.timeCards.every(card => card.status === 'approved'));
      const bulkDisk = JSON.parse(fs.readFileSync(tenantFile, 'utf8'));
      staleLoad = structuredClone(bulkDisk);
      for (const card of staleLoad.timeCards.filter(card => card.workdayId === bulkUi.data.id)) {
        card.status = 'draft';
        card.approvedBy = null;
        card.approvedAt = null;
      }
      staleLoad.company.persistence.revision = Number(bulkDisk.company.persistence.revision) - 1;
      for (const card of bulkUiCards) {
        const undone = await request(`/api/time-cards/${card.id}/unapprove`, {method: 'POST', headers: uiHeaders, body: '{}'});
        assert.equal(undone.response.status, 200, undone.data.error || '');
        assert.equal(undone.data.status, 'draft');
        assert.match(undone.data.historyLines.at(-1), /^Unapproved by Bea Owner · \d{1,2}:\d{2} [AP]M$/);
      }
      const newerCloud = structuredClone(JSON.parse(fs.readFileSync(tenantFile, 'utf8')));
      newerCloud.company.persistence.revision = Number(newerCloud.company.persistence?.revision || 0) + 5;
      const newerCard = newerCloud.timeCards.find(card => card.id === bulkUiCards[0].id);
      newerCard.status = 'approved';
      newerCard.approvedBy = 'Cloud Office';
      newerCard.approvedAt = new Date().toISOString();
      staleLoad = newerCloud;
      const fromNewerCloud = await request(`/api/time-cards/${newerCard.id}/unapprove`, {method: 'POST', headers: uiHeaders, body: '{}'});
      assert.equal(fromNewerCloud.response.status, 200, fromNewerCloud.data.error || '');
      assert.equal(fromNewerCloud.data.history.at(-1).by, 'Bea Owner');
      assert.equal(fromNewerCloud.data.status, 'draft');
    } finally {
      staleLoad = null;
      process.env.PDL_SUPABASE_ENABLED = '0';
      delete process.env.SUPABASE_URL;
      delete process.env.SUPABASE_SECRET_KEY;
      global.fetch = originalFetch;
    }

    const legacyDb = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
    const legacyBefore = structuredClone(legacyDb.timeCards);
    const at = '2026-09-29T16:08:00.000Z';
    const punch = {projectId: 1, memberId: 1, date: '2026-09-29', inAt: '2026-09-29T16:04:00.000Z', outAt: '2026-09-29T16:19:00.000Z', hours: 0.25, workdayId: 901, reportId: null, submittedAt: null, submittedBy: null};
    const opened = {action: 'Opened', by: 'QA Tester', at: '2026-09-29T16:04:00.000Z'};
    const closed = {action: 'Closed', by: 'QA Tester', at: '2026-09-29T16:06:00.000Z'};
    const approvedEntry = {action: 'Approved', by: 'QA Tester', at};
    const unapprovedEntry = {action: 'Unapproved', by: 'QA Tester', at: '2026-09-29T16:07:00.000Z', previous: 'approved'};
    legacyDb.timeCards.push(
      {...punch, id: 901, status: 'approved', approvedBy: 'QA Tester', approvedAt: at, legacyNote: 'field-rewalk', history: [opened, closed, approvedEntry, unapprovedEntry, approvedEntry]},
      {...punch, id: 902, memberId: 3, status: 'approved', approvedBy: 'QA Tester', approvedAt: at, legacyNote: 'crew-untouched', history: [opened, closed, approvedEntry]},
      {...punch, id: 903, status: 'Approved', approvedBy: 'QA Tester', approvedAt: at, legacyNote: 'cased-status', history: [opened, closed, approvedEntry]},
      {...punch, id: 904, status: 'approved ', approvedBy: 'QA Tester', approvedAt: at, legacyNote: 'spaced-status', history: [opened, closed, approvedEntry]},
      {...punch, id: 905, status: 'approved', approvedBy: 'QA Tester', approvedAt: at, legacyNote: 'missing-history'},
      {...punch, id: 906, approvedBy: 'QA Tester', approvedAt: at, legacyNote: 'missing-status', history: [opened, closed, approvedEntry]},
      {...punch, id: 907, state: 'approved', approvedBy: 'QA Tester', approvedAt: at, legacyNote: 'state-property', history: [opened, closed, approvedEntry]},
      {...punch, id: '910', status: 'approved', approvedBy: 'QA Tester', approvedAt: at, legacyNote: 'string-id', history: [opened, closed, approvedEntry]},
      {...punch, id: 909, status: 'draft', approvedBy: null, approvedAt: null, legacyNote: 'leftover-unapproved', history: [opened, closed, approvedEntry, unapprovedEntry]},
      {...punch, id: 909, status: 'approved', approvedBy: 'QA Tester', approvedAt: at, legacyNote: 'reapproved-copy', history: [opened, closed, approvedEntry, unapprovedEntry, approvedEntry]},
      {...punch, id: 911, status: 'draft', approvedBy: null, approvedAt: null, legacyNote: 'still-draft', history: [opened, closed]}
    );
    fs.writeFileSync(dbFile, JSON.stringify(legacyDb));
    const listedLegacy = await request('/api/time-cards', {headers: auth});
    assert.equal(listedLegacy.response.status, 200);
    assert.equal(listedLegacy.data.find(card => card.legacyNote === 'field-rewalk').status, 'approved');
    const listedDuplicate = listedLegacy.data.filter(card => String(card.id).trim() === '909');
    assert.equal(listedDuplicate.length, 1);
    assert.equal(listedDuplicate[0].status, 'approved');
    assert.equal(listedDuplicate[0].legacyNote, 'reapproved-copy');
    assert.equal(listedDuplicate[0].hours, 0.25);
    assert.deepEqual(listedDuplicate[0].history.map(entry => entry.action), ['Opened', 'Closed', 'Unapproved', 'Approved']);
    const legacyCsv = await request('/api/time-cards.csv', {headers: auth});
    assert.equal(legacyCsv.response.status, 200);
    assert.match(legacyCsv.text, /approved/);
    const afterRead = JSON.parse(fs.readFileSync(dbFile, 'utf8')).timeCards;
    for (const note of ['field-rewalk', 'crew-untouched', 'cased-status', 'spaced-status', 'missing-history', 'missing-status', 'state-property', 'string-id', 'still-draft']) {
      assert.deepEqual(afterRead.find(card => card.legacyNote === note), legacyDb.timeCards.find(card => card.legacyNote === note));
    }
    assert.equal(afterRead.filter(card => String(card.id).trim() === '909').length, 1);
    assert.equal(afterRead.some(card => card.legacyNote === 'leftover-unapproved'), false);
    const reread = await request('/api/time-cards', {headers: auth});
    assert.equal(reread.response.status, 200);
    assert.deepEqual(JSON.parse(fs.readFileSync(dbFile, 'utf8')).timeCards, afterRead);
    const bulkLegacy = await request('/api/time-cards/approve', {method: 'POST', headers: auth, body: JSON.stringify({ids: [903, 902]})});
    assert.equal(bulkLegacy.response.status, 200);
    const afterBulk = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
    const cased = afterBulk.timeCards.find(card => card.legacyNote === 'cased-status');
    const crew = afterBulk.timeCards.find(card => card.legacyNote === 'crew-untouched');
    assert.equal(cased.status, 'Approved');
    assert.equal(cased.history.length, 3);
    assert.equal(cased.legacyNote, 'cased-status');
    assert.equal(crew.status, 'approved');
    assert.equal(crew.history.length, 3);
    const uiUnapprove = (id) => request(`/api/time-cards/${id}/unapprove`, {method: 'POST', headers: auth, body: '{}'});
    const fieldUndo = await uiUnapprove(901);
    assert.equal(fieldUndo.response.status, 200, fieldUndo.data.error || '');
    assert.equal(fieldUndo.data.status, 'draft');
    assert.equal(fieldUndo.data.approvedBy, null);
    assert.equal(fieldUndo.data.legacyNote, 'field-rewalk');
    assert.equal(fieldUndo.data.hours, 0.25);
    assert.equal(fieldUndo.data.history.at(-1).action, 'Unapproved');
    assert.equal(fieldUndo.data.history.at(-1).by, 'Levi Foreman');
    assert.match(fieldUndo.data.historyLines.at(-1), /^Unapproved by Levi Foreman · \d{1,2}:\d{2} [AP]M$/);
    const legacyEdit = await request('/api/time-cards/901', {method: 'PATCH', headers: auth, body: JSON.stringify({inAt: '2030-09-29T16:04:00.000Z', outAt: '2030-09-29T16:19:00.000Z', reason: 'Correct legacy punch'})});
    assert.equal(legacyEdit.response.status, 200);
    assert.equal(legacyEdit.data.hours, 0.25);
    assert.equal(legacyEdit.data.legacyNote, 'field-rewalk');
    assert.equal((await request('/api/time-cards/901/submit', {method: 'POST', headers: auth, body: '{}'})).response.status, 200);
    const fieldAgain = await request('/api/time-cards/901/approve', {method: 'POST', headers: auth, body: '{}'});
    assert.equal(fieldAgain.response.status, 200);
    assert.equal(fieldAgain.data.status, 'approved');
    assert.equal(fieldAgain.data.legacyNote, 'field-rewalk');
    for (const id of [902, 903, 904, 905, 906, 907, 910]) {
      const undone = await uiUnapprove(id);
      assert.equal(undone.response.status, 200, `${id} ${undone.data.error || ''}`);
      assert.equal(undone.data.approvedBy, null);
      assert.match(undone.data.historyLines.at(-1), /^Unapproved by Levi Foreman · \d{1,2}:\d{2} [AP]M$/);
    }
    const duplicateUndo = await uiUnapprove(909);
    assert.equal(duplicateUndo.response.status, 200, duplicateUndo.data.error || '');
    assert.equal(duplicateUndo.data.legacyNote, 'reapproved-copy');
    assert.equal(duplicateUndo.data.status, 'draft');
    assert.equal(duplicateUndo.data.hours, 0.25);
    const storedLegacy = JSON.parse(fs.readFileSync(dbFile, 'utf8')).timeCards;
    const merged909 = storedLegacy.filter(card => String(card.id).trim() === '909');
    const stateCard = storedLegacy.find(card => card.legacyNote === 'state-property');
    assert.equal(merged909.length, 1);
    assert.equal(merged909[0].status, 'draft');
    assert.equal(merged909[0].legacyNote, 'reapproved-copy');
    assert.equal(merged909[0].hours, 0.25);
    assert.equal(merged909[0].history.at(-1).action, 'Unapproved');
    assert.equal(storedLegacy.some(card => card.legacyNote === 'leftover-unapproved'), false);
    assert.equal(stateCard.state, 'approved');
    assert.equal(stateCard.status, 'draft');
    const stillDraft = await uiUnapprove(911);
    assert.equal(stillDraft.response.status, 409);
    assert.equal(stillDraft.data.error, 'Only an approved time card can be unapproved');
    const originalMarcus = legacyBefore.find(row => row.approvedBy === 'Levi Foreman');
    const marcusNow = storedLegacy.find(card => card.id === originalMarcus.id && card.memberId === originalMarcus.memberId && !card.legacyNote);
    assert.equal(marcusNow.hours, originalMarcus.hours);
    assert.equal(marcusNow.status, originalMarcus.status);
    assert.deepEqual(marcusNow.history, originalMarcus.history);

    const sameId = (cards, id) => cards.filter(card => String(card.id).trim() === String(id));
    const dedupeDb = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
    const bystander = dedupeDb.timeCards.find(card => card.legacyNote === 'still-draft');
    const openedEarly = {action: 'Opened', by: 'QA Tester', at: '2026-09-29T12:00:00.000Z'};
    const draftOnly = {action: 'Times edited', by: 'QA Tester', at: '2026-09-29T12:30:00.000Z'};
    const submittedOnly = {action: 'Submitted', by: 'QA Tester', at: '2026-09-29T13:00:00.000Z'};
    const approvedOnly = {action: 'Approved', by: 'QA Tester', at: '2026-09-29T14:00:00.000Z'};
    const baseCard = {projectId: 1, memberId: 1, date: '2026-09-29', inAt: '2026-09-29T12:00:00.000Z', outAt: '2026-09-29T13:00:00.000Z', workdayId: 1201, reportId: null};
    dedupeDb.timeCards.push(
      {...baseCard, id: 1201, status: 'draft', hours: 9, submittedAt: null, submittedBy: null, approvedBy: null, approvedAt: null, updatedAt: '2026-09-29T18:00:00.000Z', legacyNote: 'older-draft', history: [openedEarly, draftOnly]},
      {...baseCard, id: '1201', status: 'submitted', hours: 4, submittedAt: '2026-09-29T13:00:00.000Z', submittedBy: 'QA Tester', approvedBy: null, approvedAt: null, updatedAt: '2026-09-29T17:00:00.000Z', legacyNote: 'middle-submitted', history: [openedEarly, submittedOnly]},
      {...baseCard, id: 1201, status: 'approved', hours: 1.25, submittedAt: null, submittedBy: null, approvedBy: 'QA Tester', approvedAt: '2026-09-29T14:00:00.000Z', updatedAt: '2026-09-29T14:00:00.000Z', legacyNote: 'winning-approved', history: [openedEarly, approvedOnly]},
      {...baseCard, id: 1202, memberId: 11, status: 'draft', hours: 3, submittedAt: null, submittedBy: null, approvedBy: null, approvedAt: null, legacyNote: 'different-id', history: [openedEarly]}
    );
    fs.writeFileSync(dbFile, JSON.stringify(dedupeDb));
    const collapsed = await request('/api/time-cards', {headers: auth});
    assert.equal(collapsed.response.status, 200);
    const storedOnce = JSON.parse(fs.readFileSync(dbFile, 'utf8')).timeCards;
    const merged1201 = sameId(storedOnce, 1201);
    assert.equal(merged1201.length, 1);
    assert.equal(merged1201[0].status, 'approved');
    assert.equal(merged1201[0].legacyNote, 'winning-approved');
    assert.equal(merged1201[0].hours, 1.25);
    assert.equal(merged1201[0].approvedBy, 'QA Tester');
    assert.deepEqual(merged1201[0].history.map(entry => entry.action), ['Opened', 'Times edited', 'Submitted', 'Approved']);
    assert.equal(sameId(storedOnce, 1202).length, 1);
    assert.equal(sameId(storedOnce, 1202)[0].hours, 3);
    assert.equal(sameId(storedOnce, 1202)[0].status, 'draft');
    assert.equal(storedOnce.find(card => card.legacyNote === 'still-draft').hours, bystander.hours);
    await request('/api/time-cards', {headers: auth});
    assert.deepEqual(JSON.parse(fs.readFileSync(dbFile, 'utf8')).timeCards, storedOnce);
    const neverSubmittedUndo = await request('/api/time-cards/1201/unapprove', {method: 'POST', headers: auth, body: '{}'});
    assert.equal(neverSubmittedUndo.response.status, 200, neverSubmittedUndo.data.error || '');
    assert.equal(neverSubmittedUndo.data.status, 'draft');
    assert.equal(neverSubmittedUndo.data.submittedAt, null);
    assert.match(neverSubmittedUndo.data.historyLines.at(-1), /^Unapproved by Levi Foreman · \d{1,2}:\d{2} [AP]M$/);
    assert.equal(sameId(JSON.parse(fs.readFileSync(dbFile, 'utf8')).timeCards, 1201).length, 1);
    const withSubmittedAt = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
    withSubmittedAt.timeCards.push({...baseCard, id: 1205, memberId: 10, status: 'approved', hours: 2, submittedAt: '2026-09-29T13:00:00.000Z', submittedBy: 'QA Tester', approvedBy: 'Levi Foreman', approvedAt: '2026-09-29T15:00:00.000Z', legacyNote: 'was-submitted', history: [openedEarly, submittedOnly, approvedOnly]});
    fs.writeFileSync(dbFile, JSON.stringify(withSubmittedAt));
    const wasSubmittedUndo = await request('/api/time-cards/1205/unapprove', {method: 'POST', headers: auth, body: '{}'});
    assert.equal(wasSubmittedUndo.response.status, 200, wasSubmittedUndo.data.error || '');
    assert.equal(wasSubmittedUndo.data.status, 'draft');
    assert.match(wasSubmittedUndo.data.historyLines.at(-1), /^Unapproved by Levi Foreman · \d{1,2}:\d{2} [AP]M$/);
    assert.equal(sameId(JSON.parse(fs.readFileSync(dbFile, 'utf8')).timeCards, 1205).length, 1);
    const beforeReapprove = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
    beforeReapprove.timeCards.unshift({...baseCard, id: 1201, status: 'draft', hours: 9, submittedAt: null, submittedBy: null, approvedBy: null, approvedAt: null, updatedAt: '2026-09-29T19:00:00.000Z', legacyNote: 'stale-draft', history: [{action: 'Opened', by: 'QA Tester', at: '2026-09-29T12:00:00.000Z'}, {action: 'Times edited', by: 'Office', at: '2026-09-29T19:00:00.000Z'}]});
    fs.writeFileSync(dbFile, JSON.stringify(beforeReapprove));
    assert.equal((await request('/api/time-cards/1201/submit', {method: 'POST', headers: auth, body: '{}'})).response.status, 200);
    const reapprovedCycle = await request('/api/time-cards/1201/approve', {method: 'POST', headers: auth, body: '{}'});
    assert.equal(reapprovedCycle.response.status, 200, reapprovedCycle.data.error || '');
    assert.equal(reapprovedCycle.data.status, 'approved');
    assert.equal(reapprovedCycle.data.hours, 1.25);
    const cycleRows = sameId(JSON.parse(fs.readFileSync(dbFile, 'utf8')).timeCards, 1201);
    assert.equal(cycleRows.length, 1);
    assert.equal(cycleRows[0].hours, 1.25);
    assert.ok(cycleRows[0].history.some(entry => entry.action === 'Times edited' && entry.by === 'Office'));
    assert.equal(cycleRows[0].history.filter(entry => entry.action === 'Approved').length >= 1, true);
    const bulkDb = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
    const bulkOpened = {action: 'Opened', by: 'QA Tester', at: '2026-09-29T11:00:00.000Z'};
    const bulkClosed = {action: 'Closed', by: 'QA Tester', at: '2026-09-29T11:30:00.000Z'};
    bulkDb.timeCards.push(
      {...baseCard, id: 1204, memberId: 12, status: 'submitted', hours: 8, submittedAt: '2026-09-29T11:40:00.000Z', submittedBy: 'QA Tester', approvedBy: null, approvedAt: null, updatedAt: '2026-09-29T11:40:00.000Z', legacyNote: 'bulk-older', history: [bulkOpened, bulkClosed, {action: 'Submitted', by: 'QA Tester', at: '2026-09-29T11:40:00.000Z'}]},
      {...baseCard, id: '1204', memberId: 12, status: 'submitted', hours: 2.5, submittedAt: '2026-09-29T11:45:00.000Z', submittedBy: 'QA Tester', approvedBy: null, approvedAt: null, updatedAt: '2026-09-29T11:50:00.000Z', legacyNote: 'bulk-newer', history: [bulkOpened, bulkClosed, {action: 'Submitted', by: 'Crew lead', at: '2026-09-29T11:50:00.000Z'}]},
      {...baseCard, id: 1206, memberId: 13, status: 'draft', hours: 6, submittedAt: null, submittedBy: null, approvedBy: null, approvedAt: null, legacyNote: 'bulk-other', history: [bulkOpened]}
    );
    fs.writeFileSync(dbFile, JSON.stringify(bulkDb));
    const bulkDedupe = await request('/api/time-cards/approve', {method: 'POST', headers: auth, body: JSON.stringify({ids: [1204]})});
    assert.equal(bulkDedupe.response.status, 200, bulkDedupe.data.error || '');
    assert.equal(bulkDedupe.data.timeCards.length, 1);
    assert.equal(bulkDedupe.data.timeCards[0].status, 'approved');
    assert.equal(bulkDedupe.data.timeCards[0].hours, 2.5);
    const bulkDisk = JSON.parse(fs.readFileSync(dbFile, 'utf8')).timeCards;
    const bulkRows = sameId(bulkDisk, 1204);
    assert.equal(bulkRows.length, 1);
    assert.equal(bulkRows[0].hours, 2.5);
    assert.equal(bulkRows[0].status, 'approved');
    assert.equal(bulkRows[0].history.filter(entry => entry.action === 'Approved').length, 1);
    assert.ok(bulkRows[0].history.some(entry => entry.action === 'Submitted' && entry.by === 'QA Tester'));
    assert.ok(bulkRows[0].history.some(entry => entry.action === 'Submitted' && entry.by === 'Crew lead'));
    assert.equal(sameId(bulkDisk, 1206).length, 1);
    assert.equal(sameId(bulkDisk, 1206)[0].hours, 6);
    assert.equal(sameId(bulkDisk, 1206)[0].status, 'draft');
    await request('/api/time-cards', {headers: auth});
    assert.deepEqual(JSON.parse(fs.readFileSync(dbFile, 'utf8')).timeCards, bulkDisk);

    const afterHours = await request('/api/production', {headers: auth});
    const afterInsights = await request('/api/insights', {headers: auth});
    assert.deepEqual(afterHours.data, beforeHours.data);
    const insightBody = value => {const copy = {...value}; delete copy.generatedAt; return copy;};
    assert.deepEqual(insightBody(afterInsights.data), insightBody(beforeInsights.data));
    assert.equal((await request('/api/state', {headers: auth})).data.reports.find(report => report.id === ended.data.report.id).status, 'Draft');
    console.log('Time card tests passed');
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    server.close(() => fs.rmSync(tempDir, {recursive: true, force: true}));
  }
});
