const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const repoDb = path.join(__dirname, 'data', 'db.json');
const fixturePath = path.join(__dirname, 'fixtures', 'hours-safety-snapshot.json');
const repoDbBytes = fs.readFileSync(repoDb);
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-hours-safety-'));
const dbFile = path.join(tempDir, 'db.json');
fs.writeFileSync(dbFile, repoDbBytes);
fs.copyFileSync(path.join(__dirname, 'data', 'platform.json'), path.join(tempDir, 'platform.json'));
process.env.PDL_DB_FILE = dbFile;
process.env.PDL_PLATFORM_FILE = path.join(tempDir, 'platform.json');
process.env.PDL_SUPABASE_ENABLED = '0';
process.env.PDL_EMAIL_DEV_MODE = '1';
process.env.PDL_REQUIRE_AUTH = '0';
process.env.PDL_PLATFORM_KEY = 'test-platform-key-32-characters-minimum';

const {server, prepareWorkspace, rekeyDuplicateAssignments} = require('./server');
const base = 'http://127.0.0.1:4199';

function hoursSnapshot(production, insights) {
  const projects = production.projects.map(project => {
    const items = project.items.map(item => {
      const planned = Number(item.plannedQuantity) || 0;
      const quantity = Number(item.actualQuantity) || 0;
      const laborHours = Number(item.actualLaborHours) || 0;
      const budgetHours = Number(item.budgetHours) || 0;
      const earned = planned > 0 ? quantity * budgetHours / planned : 0;
      return {
        estimateItemId: item.estimateItemId,
        name: item.name,
        unit: item.unit,
        plannedQuantity: planned,
        quantity,
        laborHours,
        budgetHours,
        quantityPercent: item.quantityPercent,
        laborPercent: item.laborPercent,
        efficiency: laborHours > 0 ? earned / laborHours * 100 : null
      };
    });
    const totals = items.reduce((sum, item) => {
      sum.quantity += item.quantity;
      sum.laborHours += item.laborHours;
      sum.budgetHours += item.budgetHours;
      sum.earned += item.plannedQuantity > 0 ? item.quantity * item.budgetHours / item.plannedQuantity : 0;
      return sum;
    }, {quantity: 0, laborHours: 0, budgetHours: 0, earned: 0});
    return {
      projectId: project.projectId,
      items,
      totals: {
        quantity: totals.quantity,
        laborHours: totals.laborHours,
        budgetHours: totals.budgetHours,
        efficiency: totals.laborHours > 0 ? totals.earned / totals.laborHours * 100 : null
      }
    };
  });
  const grand = projects.reduce((sum, project) => {
    sum.quantity += project.totals.quantity;
    sum.laborHours += project.totals.laborHours;
    sum.budgetHours += project.totals.budgetHours;
    sum.earned += project.totals.efficiency == null ? 0 : project.totals.laborHours * project.totals.efficiency / 100;
    return sum;
  }, {quantity: 0, laborHours: 0, budgetHours: 0, earned: 0});
  const insightLines = insights.records.map(row => ({
    reportId: row.reportId,
    date: row.date,
    projectId: row.projectId,
    projectName: row.projectName,
    estimateItemId: row.estimateItemId,
    scope: row.scope,
    crew: row.crew,
    unit: row.unit,
    quantity: row.quantity,
    laborHours: row.laborHours,
    targetHoursPerUnit: row.targetHoursPerUnit
  }));
  return {
    seededReports: 22,
    projects,
    totals: {
      quantity: grand.quantity,
      laborHours: grand.laborHours,
      budgetHours: grand.budgetHours,
      efficiency: grand.laborHours > 0 ? grand.earned / grand.laborHours * 100 : null
    },
    insightTotals: {
      quantity: insightLines.reduce((sum, row) => sum + row.quantity, 0),
      laborHours: insightLines.reduce((sum, row) => sum + row.laborHours, 0),
      lines: insightLines.length
    },
    insightLines
  };
}

function clientLineHours(report) {
  const entries = report.productionEntries || [];
  const reportLabor = (report.laborEntries || []).reduce((sum, row) => sum + (Number(row.hours) || 0), 0);
  return entries.reduce((sum, entry) => sum + (Number(entry.laborHours) || 0 || (entries.length === 1 ? reportLabor : 0)), 0);
}

function loadClientHoursFns() {
  const source = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
  const dashboard = source.split('\n').find(line => line.startsWith('function dashboardProduction'));
  const assignment = source.split('\n').find(line => line.startsWith('function assignmentActualHours'));
  if (!dashboard || !assignment) throw new Error('Client hours functions were not found in app.js');
  return new Function('reports', 'projects', `${dashboard}\n${assignment}\nreturn {dashboardProduction, assignmentActualHours};`);
}

async function request(route, options = {}) {
  const headers = {'Content-Type': 'application/json', ...(options.headers || {})};
  const response = await fetch(base + route, {...options, headers});
  const data = await response.json();
  return {response, data};
}

function item(snapshot, projectId, estimateItemId) {
  return snapshot.projects.find(project => project.projectId === projectId).items.find(row => row.estimateItemId === estimateItemId);
}

server.listen(4199, async () => {
  try {
    const seeded = JSON.parse(repoDbBytes.toString());
    assert.equal(seeded.reports.length, 22);
    assert.equal(seeded.reports.some(report => report.templateId || report.customFields || report.timeCardId), false);
    const memoryCopy = JSON.parse(repoDbBytes.toString());
    assert.equal(rekeyDuplicateAssignments(memoryCopy), false);
    assert.equal(prepareWorkspace(memoryCopy), false);
    assert.deepEqual(memoryCopy, JSON.parse(repoDbBytes.toString()));

    const insightsRead = await request('/api/insights');
    const productionRead = await request('/api/production');
    const stateRead = await request('/api/state');
    const actionCenterRead = await request('/api/action-center');
    assert.equal(insightsRead.response.status, 200);
    assert.equal(productionRead.response.status, 403);
    assert.equal(stateRead.response.status, 200);
    assert.equal(actionCenterRead.response.status, 200);
    assert.equal(stateRead.data.reports.length, 22);
    assert.deepEqual(fs.readFileSync(dbFile), repoDbBytes);
    assert.deepEqual(fs.readFileSync(repoDb), repoDbBytes);

    const db = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
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

    const insights = await request('/api/insights', {headers: auth});
    const production = await request('/api/production', {headers: auth});
    assert.equal(insights.response.status, 200);
    assert.equal(production.response.status, 200);
    assert.equal(insights.data.records.every(row => row.reportId !== 8), true);
    const live = hoursSnapshot(production.data, insights.data);
    if (process.env.CAPTURE_HOURS_SNAPSHOT === '1') {
      fs.mkdirSync(path.dirname(fixturePath), {recursive: true});
      fs.writeFileSync(fixturePath, `${JSON.stringify(live, null, 2)}\n`);
      console.log('Captured hours safety snapshot');
    } else {
      const expected = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
      assert.deepEqual(live, expected);
    }

    const state = (await request('/api/state', {headers: auth})).data;
    const {dashboardProduction, assignmentActualHours} = loadClientHoursFns()(state.reports, state.projects);
    const approved = state.reports.filter(report => report.status === 'Approved');
    const serverLabor = production.data.projects.reduce((sum, project) => sum + project.items.reduce((itemSum, row) => itemSum + Number(row.actualLaborHours), 0), 0);
    assert.equal(approved.reduce((sum, report) => sum + clientLineHours(report), 0), serverLabor);
    const windowed = dashboardProduction('This week');
    const now = new Date();
    const weekStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7));
    const windowHours = approved.filter(report => {
      const date = new Date(`${report.dateIso}T12:00:00`);
      return date >= weekStart && date <= now;
    }).reduce((sum, report) => sum + clientLineHours(report), 0);
    assert.equal(windowed.groups.reduce((sum, group) => sum + group.actual, 0), windowHours);
    const seen = new Set();
    let assignedHours = 0;
    let laborHours = 0;
    for (const report of approved) {
      const projectId = state.projects[report.project].id;
      for (const entry of report.laborEntries || []) {
        laborHours += Number(entry.hours) || 0;
        const key = `${projectId}|${report.dateIso}|${entry.memberId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        assignedHours += assignmentActualHours({date: report.dateIso, projectId}, entry.memberId);
      }
    }
    assert.equal(assignedHours, laborHours);
    const pour = assignmentActualHours({date: '2026-09-21', projectId: 1}, 1);
    const pourExpected = approved.filter(report => report.dateIso === '2026-09-21' && state.projects[report.project].id === 1).reduce((sum, report) => sum + (report.laborEntries || []).filter(entry => Number(entry.memberId) === 1).reduce((hours, entry) => hours + (Number(entry.hours) || 0), 0), 0);
    assert.equal(pour, pourExpected);
    assert.ok(pour > 0);

    const beforeEdit = state.reports.find(report => report.id === 1);
    const edited = await request('/api/reports/1', {method: 'PATCH', headers: auth, body: JSON.stringify({weather: 'Overcast snapshot'})});
    assert.equal(edited.response.status, 200);
    const afterEdit = (await request('/api/state', {headers: auth})).data.reports.find(report => report.id === 1);
    assert.deepEqual(Object.keys(afterEdit).sort(), Object.keys(beforeEdit).sort());
    for (const key of Object.keys(beforeEdit)) {
      if (key === 'weather' || key === 'history') continue;
      assert.deepEqual(afterEdit[key], beforeEdit[key], key);
    }
    assert.equal(afterEdit.weather, 'Overcast snapshot');
    assert.equal(afterEdit.history.length, beforeEdit.history.length + 1);
    assert.match(afterEdit.history.at(-1).action, /Corrected/);
    assert.equal(Object.hasOwn(afterEdit, 'templateId'), false);
    assert.equal(Object.hasOwn(afterEdit, 'customFields'), false);
    const rejected = await request('/api/reports/1', {method: 'PATCH', headers: auth, body: JSON.stringify({status: 'Needs review', productionEntries: [{estimateItemId: 1, description: 'Foundation concrete', quantity: 1, unit: 'CY', laborHours: 9}], laborEntries: [{memberId: 1, hours: 1}]})});
    assert.equal(rejected.response.status, 400);
    assert.match(rejected.data.error, /Crew hours/);
    const unchanged = (await request('/api/state', {headers: auth})).data.reports.find(report => report.id === 1);
    assert.deepEqual(unchanged, afterEdit);
    const rejectedCreate = await request('/api/reports', {method: 'POST', headers: auth, body: JSON.stringify({projectId: 1, dateIso: '2026-09-18', notes: 'Mismatched old daily', foreman: 'Hours Snapshot', productionEntries: [{estimateItemId: 1, description: 'Foundation concrete', quantity: 1, unit: 'CY', laborHours: 8}], laborEntries: [{memberId: 1, hours: 4}]})});
    assert.equal(rejectedCreate.response.status, 400);
    assert.equal((await request('/api/state', {headers: auth})).data.reports.some(report => report.notes === 'Mismatched old daily'), false);

    const baseline = hoursSnapshot((await request('/api/production', {headers: auth})).data, (await request('/api/insights', {headers: auth})).data);
    const guestLink = (await request('/api/subcontractors/1/links', {method: 'POST', headers: auth, body: JSON.stringify({projectId: 1, mode: 'progress', expiresAt: '2099-12-31'})})).data;
    const guestToken = new URL(`http://localhost${guestLink.url}`).pathname.split('/').pop();
    const guestDaily = await request(`/api/guest/${guestToken}`, {method: 'POST', body: JSON.stringify({startedAt: '2026-09-18T15:00:00.000Z', endedAt: '2026-09-18T23:00:00.000Z', crewCount: 2, notes: 'Guest hours should stay off the bid.', signature: 'Cascade Electric'})});
    assert.equal(guestDaily.response.status, 201);
    const guestReport = (await request('/api/state', {headers: auth})).data.reports.find(report => report.id === guestDaily.data.reportId);
    assert.equal(guestReport.status, 'Needs review');
    assert.deepEqual(guestReport.productionEntries, []);
    assert.deepEqual(guestReport.laborEntries, []);
    assert.equal(Object.hasOwn(guestReport, 'templateId'), false);
    const workday = (await request('/api/workdays/start', {method: 'POST', headers: auth, body: JSON.stringify({projectId: 1, memberIds: [1, 3]})})).data;
    const ended = await request(`/api/workdays/${workday.id}/end`, {method: 'POST', headers: auth, body: JSON.stringify({notes: 'Workday draft should stay off the bid.', foreman: 'Hours Snapshot'})});
    assert.equal(ended.response.status, 200);
    assert.equal(ended.data.report.status, 'Draft');
    assert.deepEqual(ended.data.report.productionEntries, []);
    assert.ok(ended.data.report.laborEntries.length === 2);
    const drafted = await request(`/api/reports/${ended.data.report.id}`, {method: 'PATCH', headers: auth, body: JSON.stringify({status: 'Draft', laborEntries: [{memberId: 1, hours: 8, crew: 'Concrete'}, {memberId: 3, hours: 4, crew: 'Framing'}], productionEntries: []})});
    assert.equal(drafted.response.status, 200);
    assert.deepEqual(hoursSnapshot((await request('/api/production', {headers: auth})).data, (await request('/api/insights', {headers: auth})).data), baseline);
    assert.equal((await request(`/api/reports/${guestReport.id}/approve`, {method: 'PATCH', headers: auth})).response.status, 200);
    assert.equal((await request(`/api/reports/${ended.data.report.id}/approve`, {method: 'PATCH', headers: auth})).response.status, 200);
    assert.deepEqual(hoursSnapshot((await request('/api/production', {headers: auth})).data, (await request('/api/insights', {headers: auth})).data), baseline);

    const multi = (await request('/api/reports', {method: 'POST', headers: auth, body: JSON.stringify({projectId: 2, dateIso: '2026-09-18', notes: 'Old shaped multi-line daily', foreman: 'Hours Snapshot', productionEntries: [{estimateItemId: 1, description: 'Wood framing', quantity: 100, unit: 'SF', laborHours: 6}, {estimateItemId: 1, description: 'Wood framing', quantity: 40, unit: 'SF', laborHours: 4}], laborEntries: [{memberId: 1, hours: 6}, {memberId: 3, hours: 4}]})})).data;
    assert.equal(Object.hasOwn(multi, 'templateId'), false);
    assert.equal(Object.hasOwn(multi, 'customFields'), false);
    assert.equal(Object.hasOwn(multi, 'timeCardId'), false);
    assert.deepEqual(hoursSnapshot((await request('/api/production', {headers: auth})).data, (await request('/api/insights', {headers: auth})).data), baseline);
    assert.equal((await request(`/api/reports/${multi.id}/approve`, {method: 'PATCH', headers: auth})).response.status, 200);
    const afterMulti = hoursSnapshot((await request('/api/production', {headers: auth})).data, (await request('/api/insights', {headers: auth})).data);
    const framingBefore = item(baseline, 2, 1);
    const framingAfter = item(afterMulti, 2, 1);
    assert.equal(framingAfter.quantity, framingBefore.quantity + 140);
    assert.equal(framingAfter.laborHours, framingBefore.laborHours + 10);
    assert.equal(afterMulti.totals.laborHours, baseline.totals.laborHours + 10);
    assert.equal(afterMulti.totals.quantity, baseline.totals.quantity + 140);
    const multiLines = afterMulti.insightLines.filter(row => row.reportId === multi.id).map(row => ({crew: row.crew, quantity: row.quantity, laborHours: row.laborHours}));
    const concreteShare = 6 / 10;
    const framingShare = 4 / 10;
    assert.deepEqual(multiLines, [
      {crew: 'Concrete', quantity: 100 * concreteShare, laborHours: 6 * concreteShare},
      {crew: 'Framing', quantity: 100 * framingShare, laborHours: 6 * framingShare},
      {crew: 'Concrete', quantity: 40 * concreteShare, laborHours: 4 * concreteShare},
      {crew: 'Framing', quantity: 40 * framingShare, laborHours: 4 * framingShare}
    ]);

    const fallback = (await request('/api/reports', {method: 'POST', headers: auth, body: JSON.stringify({projectId: 1, dateIso: '2026-09-17', status: 'Draft', notes: 'Old shaped single line with crew-hour fallback', foreman: 'Hours Snapshot', productionEntries: [{estimateItemId: 1, description: 'Foundation concrete', quantity: 5, unit: 'CY', laborHours: 0}], laborEntries: [{memberId: 2, hours: 8}, {memberId: 6, hours: 4}]})})).data;
    assert.equal(fallback.productionEntries[0].laborHours, 0);
    assert.equal(Object.hasOwn(fallback, 'templateId'), false);
    assert.deepEqual(hoursSnapshot((await request('/api/production', {headers: auth})).data, (await request('/api/insights', {headers: auth})).data), afterMulti);
    assert.equal((await request(`/api/reports/${fallback.id}/approve`, {method: 'PATCH', headers: auth})).response.status, 200);
    const afterFallback = hoursSnapshot((await request('/api/production', {headers: auth})).data, (await request('/api/insights', {headers: auth})).data);
    const concreteBefore = item(afterMulti, 1, 1);
    const concreteAfter = item(afterFallback, 1, 1);
    assert.equal(concreteAfter.quantity, concreteBefore.quantity + 5);
    assert.equal(concreteAfter.laborHours, concreteBefore.laborHours + 12);
    assert.equal(afterFallback.totals.laborHours, afterMulti.totals.laborHours + 12);
    const fallbackLines = afterFallback.insightLines.filter(row => row.reportId === fallback.id).map(row => ({crew: row.crew, quantity: row.quantity, laborHours: row.laborHours}));
    assert.deepEqual(fallbackLines, [
      {crew: 'Concrete', quantity: 5 * (8 / 12), laborHours: 12 * (8 / 12)},
      {crew: 'Framing', quantity: 5 * (4 / 12), laborHours: 12 * (4 / 12)}
    ]);

    const withLines = await request(`/api/reports/${ended.data.report.id}`, {method: 'PATCH', headers: auth, body: JSON.stringify({status: 'Approved', productionEntries: [{estimateItemId: 2, description: 'Slab on grade', quantity: 20, unit: 'SF', laborHours: 12}], laborEntries: [{memberId: 1, hours: 8, crew: 'Concrete'}, {memberId: 3, hours: 4, crew: 'Framing'}]})});
    assert.equal(withLines.response.status, 200);
    const afterLines = hoursSnapshot((await request('/api/production', {headers: auth})).data, (await request('/api/insights', {headers: auth})).data);
    assert.equal(item(afterLines, 1, 2).laborHours, item(afterFallback, 1, 2).laborHours + 12);
    assert.equal(item(afterLines, 1, 2).quantity, item(afterFallback, 1, 2).quantity + 20);
    assert.deepEqual(fs.readFileSync(repoDb), repoDbBytes);
    console.log('Hours safety snapshot tests passed');
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    server.close(() => fs.rmSync(tempDir, {recursive: true, force: true}));
  }
});
