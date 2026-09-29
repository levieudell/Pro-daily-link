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
    assert.match(html, /Time cards/);
    assert.match(html, /CSV export/);
    assert.match(platformHtml, /Time cards on/);

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
    const submitted = await request(`/api/time-cards/${marcus.id}/submit`, {method: 'POST', headers: fieldAuth, body: '{}'});
    assert.equal(submitted.response.status, 200);
    assert.equal(submitted.data.status, 'submitted');
    assert.equal(submitted.data.submittedBy, 'Marcus Reed');
    assert.equal(submitted.data.history.at(-1).action, 'Submitted');

    const edited = await request(`/api/time-cards/${marcus.id}`, {method: 'PATCH', headers: auth, body: JSON.stringify({inAt: '2026-09-29T15:00:00.000Z', outAt: '2026-09-29T16:10:00.000Z'})});
    assert.equal(edited.response.status, 200);
    assert.equal(edited.data.hours, 1.25);
    assert.equal(edited.data.date, '2026-09-29');
    assert.equal(edited.data.status, 'submitted');
    assert.equal(edited.data.history.at(-1).action, 'Times edited');
    assert.equal(edited.data.history.at(-1).before.hours, quarterHours(marcus.inAt, marcus.outAt));
    const dailyAfterEdit = (await request('/api/state', {headers: auth})).data.reports.find(report => report.id === ended.data.report.id);
    assert.equal(dailyAfterEdit.laborEntries[0].hours, dailyBeforeEdit.laborEntries[0].hours);
    assert.equal(dailyAfterEdit.status, 'Draft');

    const approved = await request(`/api/time-cards/${marcus.id}/approve`, {method: 'POST', headers: auth, body: '{}'});
    assert.equal(approved.response.status, 200);
    assert.equal(approved.data.status, 'approved');
    assert.equal(approved.data.approvedBy, 'Levi Foreman');
    assert.equal(approved.data.history.at(-1).action, 'Approved');
    const locked = await request(`/api/time-cards/${marcus.id}`, {method: 'PATCH', headers: auth, body: JSON.stringify({inAt: '2026-09-29T12:00:00.000Z', outAt: '2026-09-29T20:00:00.000Z'})});
    assert.equal(locked.response.status, 409);
    const lockedCard = (await request('/api/time-cards?memberId=1', {headers: auth})).data.find(card => card.id === marcus.id);
    assert.equal(lockedCard.inAt, '2026-09-29T15:00:00.000Z');
    assert.equal(lockedCard.hours, 1.25);
    assert.equal(lockedCard.status, 'approved');
    const dailyAfterApprove = (await request('/api/state', {headers: auth})).data.reports.find(report => report.id === ended.data.report.id);
    assert.equal(dailyAfterApprove.status, 'Draft');
    assert.deepEqual(dailyAfterApprove.laborEntries, dailyAfterEdit.laborEntries);

    const unapproved = await request(`/api/time-cards/${marcus.id}/unapprove`, {method: 'POST', headers: auth, body: '{}'});
    assert.equal(unapproved.response.status, 200);
    assert.equal(unapproved.data.status, 'submitted');
    assert.equal(unapproved.data.approvedBy, null);
    assert.equal(unapproved.data.history.at(-1).action, 'Unapproved');
    const editedAgain = await request(`/api/time-cards/${marcus.id}`, {method: 'PATCH', headers: auth, body: JSON.stringify({inAt: '2026-09-29T15:00:00.000Z', outAt: '2026-09-29T16:10:00.000Z'})});
    assert.equal(editedAgain.response.status, 200);
    assert.equal(editedAgain.data.hours, 1.25);
    assert.equal((await request(`/api/time-cards/${marcus.id}/approve`, {method: 'POST', headers: auth, body: '{}'})).data.status, 'approved');

    const manager = (await request('/api/users', {method: 'POST', headers: auth, body: JSON.stringify({name: 'Pat Manager', email: 'pat-cards@example.test', role: 'project_manager', projectIds: [1]})})).data;
    assert.equal((await request('/api/auth/claim', {method: 'POST', body: JSON.stringify({email: manager.email, temporaryPassword: manager.temporaryPassword, password: 'ManagerPassword!42'})})).response.status, 200);
    const managerLogin = await request('/api/auth/login', {method: 'POST', body: JSON.stringify({email: 'pat-cards@example.test', password: 'ManagerPassword!42'})});
    const managerAuth = {Authorization: `Bearer ${managerLogin.data.token}`};
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
    const closedGuard = await request(`/api/time-cards/${openCards[0].id}`, {method: 'PATCH', headers: auth, body: JSON.stringify({inAt: openCards[0].inAt, outAt: new Date(new Date(openCards[0].inAt).getTime() + 3600000).toISOString()})});
    assert.equal(closedGuard.response.status, 200);
    assert.equal(closedGuard.data.hours, 1);

    const second = await request('/api/workdays/start', {method: 'POST', headers: auth, body: JSON.stringify({projectId: 1, memberIds: [2]})});
    assert.equal(second.response.status, 201);
    const secondEnd = await request(`/api/workdays/${second.data.id}/end`, {method: 'POST', headers: auth, body: JSON.stringify({notes: 'Manager can approve a time card.', foreman: 'Hours Snapshot'})});
    assert.equal(secondEnd.response.status, 200);
    const diego = (await request('/api/time-cards?memberId=2', {headers: managerAuth})).data.find(card => card.workdayId === second.data.id);
    assert.ok(diego);
    assert.equal(diego.projectId, 1);
    const managerApproved = await request(`/api/time-cards/${diego.id}/approve`, {method: 'POST', headers: managerAuth, body: '{}'});
    assert.equal(managerApproved.response.status, 200);
    assert.equal(managerApproved.data.status, 'approved');
    assert.equal(managerApproved.data.approvedBy, 'Pat Manager');

    const bulkStart = await request('/api/workdays/start', {method: 'POST', headers: auth, body: JSON.stringify({projectId: 1, memberIds: [6, 10]})});
    assert.equal(bulkStart.response.status, 201);
    assert.equal((await request(`/api/workdays/${bulkStart.data.id}/end`, {method: 'POST', headers: auth, body: JSON.stringify({notes: 'Bulk approve these time cards.', foreman: 'Hours Snapshot'})})).response.status, 200);
    const bulkCards = (await request('/api/time-cards', {headers: auth})).data.filter(card => card.workdayId === bulkStart.data.id);
    assert.equal(bulkCards.length, 2);
    const bulk = await request('/api/time-cards/approve', {method: 'POST', headers: auth, body: JSON.stringify({ids: bulkCards.map(card => card.id)})});
    assert.equal(bulk.response.status, 200);
    assert.ok(bulk.data.timeCards.every(card => card.status === 'approved'));
    const bulkLocked = await request(`/api/time-cards/${bulkCards[0].id}`, {method: 'PATCH', headers: auth, body: JSON.stringify({inAt: bulkCards[0].inAt, outAt: new Date(new Date(bulkCards[0].inAt).getTime() + 7200000).toISOString()})});
    assert.equal(bulkLocked.response.status, 409);

    const csv = await request('/api/time-cards.csv?from=2026-09-01&to=2026-09-30&projectId=1', {headers: auth});
    assert.equal(csv.response.status, 200);
    assert.match(csv.response.headers.get('content-type'), /text\/csv/);
    assert.match(csv.response.headers.get('content-disposition'), /filename="time-cards-2026-09-01-2026-09-30\.csv"/);
    const csvLines = csv.text.trim().split('\n');
    assert.equal(csvLines[0], 'person,job,job code,date,in,out,hours,status,approved by');
    assert.ok(csvLines.some(line => line === 'Marcus Reed,Division Street Clinic,DSC,2026-09-29,2026-09-29T15:00:00.000Z,2026-09-29T16:10:00.000Z,1.25,approved,Levi Foreman'));
    const filteredOut = await request('/api/time-cards.csv?from=2026-09-01&to=2026-09-30&memberId=3&status=draft', {headers: auth});
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
