'use strict';

// Real-browser component acceptance against the real authenticated local API.
// All records are synthetic; provider credentials and cloud access are disabled.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { reportSafetyEvidenceMarkup, responsibleEmployer, jurisdictionFromProject } = require('./safety-pm-ui');

assert.equal(
  responsibleEmployer({ name: 'Demo Builder' }, { employer: 'Old saved company name' }),
  'Demo Builder',
  'the current company account name is authoritative over a stale saved safety profile'
);
assert.equal(
  responsibleEmployer({ name: '' }, { employer: 'Saved fallback employer' }),
  '',
  'a stale saved employer cannot replace a missing company-account name'
);
assert.equal(jurisdictionFromProject({ site: '100 Synthetic Way, Portland, OR 97201' }, { state: 'WA' }), 'OR', 'postal project address controls jurisdiction');
assert.equal(jurisdictionFromProject({ address: '12 Harbor Ave, Seattle, Washington 98101' }, { state: 'OR' }), 'WA', 'full state names in project addresses are understood');
assert.equal(jurisdictionFromProject({ site: 'Address not entered' }, { state: 'OR' }), '', 'a saved jurisdiction cannot replace an incomplete project address');
assert.equal(jurisdictionFromProject({ site: 'Remote work site' }, {}), '', 'an unknown address never guesses a jurisdiction');

assert.equal(reportSafetyEvidenceMarkup({}), '', 'reports without saved evidence must not gain a safety certification');
const maliciousEvidence = reportSafetyEvidenceMarkup({ safetyEvidence: { dayRevision: 3, ruleVersion: '<img src=x onerror=alert(1)>', checks: [{ title: '<script>bad()</script>', status: 'fail', inspector: '<b>name</b>', notes: '<iframe>' }], talks: [{ topic: '<svg onload=alert(1)>', language: 'en', presenter: '<b>presenter</b>', attendees: [{ name: '<i>worker</i>' }] }], hazards: [], carriedHazards: [{ observation: '<img>', status: 'open', date: '2026-10-25' }], summary: { unresolved: 2 } } }, 101);
assert.match(maliciousEvidence, /2 unresolved/);
assert.match(maliciousEvidence, /&lt;script&gt;/);
assert.match(maliciousEvidence, /Toolbox talks \(1\)/);
assert.match(maliciousEvidence, /Presenter-reported attendance/);
assert.doesNotMatch(maliciousEvidence, /<script>|<img|<iframe>|<svg|<i>/);

const immutableSpanishReport = { dateIso: '2026-10-26', safetyEvidence: {
  date: '2026-10-26', dayRevision: 7, ruleVersion: 'or-safety-v3', capturedAt: '2026-10-26T17:30:00Z',
  checks: [{ id: 'site-walk', title: 'Recorrido del sitio', status: 'fail', recordedBy: 'Pat', competentPerson: 'Alex', notes: 'Abertura sin cubrir', action: 'Se aisló el área', owner: 'Alex', dueDate: '2026-10-27' }],
  talks: [
    { topic: 'Protección contra caídas', language: 'es', presenter: 'Pat', attendees: [{ name: 'Alex' }], amendedAt: '2026-10-26T17:00:00Z', amendedBy: 'Pat' },
    { topic: 'Registro duplicado', language: 'en', presenter: 'Pat', attendees: [], voidedAt: '2026-10-26T17:10:00Z', voidedBy: 'Morgan', voidReason: 'Duplicado' }
  ],
  hazards: [{ observation: 'Abertura', status: 'corrected', date: '2026-10-26', location: '', action: 'Cubierta', owner: '', dueDate: '2026-10-27', verification: 'Pendiente', workStopped: true }],
  carriedHazards: [], summary: { unresolved: 2 }
} };
const immutableSpanishSnapshot = structuredClone(immutableSpanishReport);
const spanishEvidence = reportSafetyEvidenceMarkup(immutableSpanishReport, 101, 'es');
assert.match(spanishEvidence, /EVIDENCIA DIARIA GUARDADA/);
assert.match(spanishEvidence, /Registro de seguridad al enviarse/);
assert.match(spanishEvidence, /2 sin resolver/);
assert.match(spanishEvidence, /Respuestas de inspección \(1\)/);
assert.match(spanishEvidence, /Charlas de seguridad \(2\)/);
assert.match(spanishEvidence, /Registro anulado/);
assert.match(spanishEvidence, /original conservado en el historial de auditoría/);
assert.match(spanishEvidence, /Peligros y seguimiento pendiente \(1\)/);
assert.match(spanishEvidence, /Abrir registro de seguridad actual/);
assert.doesNotMatch(spanishEvidence, /Safety record at submission|SAVED DAILY EVIDENCE|Open current safety record/);
assert.deepEqual(immutableSpanishReport, immutableSpanishSnapshot, 'localizing saved evidence never rewrites the immutable report snapshot');

let chromium;
for (const dependency of ['playwright', process.env.PDL_PLAYWRIGHT_MODULE, path.join(os.homedir(), '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'node', 'node_modules', 'playwright')].filter(Boolean)) {
  try { chromium = require(dependency).chromium; break; } catch { /* Try an installed runtime. */ }
}
if (!chromium) throw new Error('Install or configure Playwright before running safety browser acceptance.');
const executablePath = process.env.PDL_BROWSER_PATH || [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'
].find(file => fs.existsSync(file));

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-safety-browser-'));
const companyId = '11111111-1111-4111-8111-111111111111';
const date = '2026-10-26';
const bearer = 'synthetic-safety-browser-owner';
const user = { id: 1, companyId, name: 'Morgan Lee', role: 'owner', status: 'Active', email: 'morgan@example.invalid' };
const company = { id: companyId, name: 'Demo Builder', timezone: 'America/Los_Angeles', demo: true, features: {} };
const projects = [{ id: 101, name: 'Oak Street — roof replacement', site: '100 Synthetic Way, Portland, OR 97201', status: 'Active', customerId: 1, estimateItems: [] }];
const photos = [{ id: 1, project: 0, caption: 'West roof opening — inspection photo', createdAt: '2026-10-26T15:00:00Z' }];
const db = {
  company, projects, photos, users: [user],
  sessions: [{ userId: user.id, companyId, tokenHash: crypto.createHash('sha256').update(bearer).digest('hex'), expiresAt: '2099-01-01T00:00:00Z' }],
  customers: [{ id: 1, name: 'Synthetic customer' }],
  team: [{ id: 11, name: 'Demo crew member', crew: 'Roof crew' }],
  assignments: [{ id: 1, projectId: 101, memberIds: [11], crew: 'Roof crew', task: 'Roofing work', date, start: '08:00', end: '16:00' }],
  workdays: [], reports: [], subcontractors: [], subcontractorLinks: [], changes: [], catalog: []
};
const dbFile = path.join(temp, 'db.json');
fs.writeFileSync(dbFile, JSON.stringify(db));
fs.writeFileSync(path.join(temp, 'platform.json'), JSON.stringify({ users: [], sessions: [] }));
let child, browser, base, log = '';

async function start() {
  const dependencyRoot = [path.resolve(__dirname, 'node_modules'), path.resolve(__dirname, '..', 'backoffice-command-center-worktree', 'node_modules'), path.resolve(__dirname, '..', 'repo', 'node_modules')].find(folder => fs.existsSync(path.join(folder, 'stripe')) && fs.existsSync(path.join(folder, '@heycatch', 'sdk'))) || path.resolve(__dirname, '..', 'node_modules');
  const env = { ...process.env, NODE_PATH: [dependencyRoot, process.env.NODE_PATH].filter(Boolean).join(path.delimiter), PDL_DB_FILE: dbFile, PDL_PLATFORM_FILE: path.join(temp, 'platform.json'), PDL_REQUIRE_AUTH: '1', PDL_SUPABASE_ENABLED: '0', PDL_TRANSACTIONAL_DB: 'off', PDL_PLATFORM_TRANSACTIONAL_DB: 'off', PDL_EMAIL_DEV_MODE: '1', NODE_ENV: 'test' };
  for (const key of ['PDL_STAGING', 'SENTRY_DSN', 'RESEND_API_KEY', 'OPENAI_API_KEY', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'DATABASE_URL']) delete env[key];
  child = spawn(process.execPath, ['-e', "const {server}=require('./server');server.listen(0,'127.0.0.1',()=>console.log('SAFETY_BROWSER_PORT='+server.address().port));"], { cwd: __dirname, env, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Synthetic browser server failed to start: ' + log)), 15000);
    child.stdout.on('data', bytes => { log += String(bytes); const port = log.match(/SAFETY_BROWSER_PORT=(\d+)/); if (port) { base = 'http://127.0.0.1:' + port[1]; clearTimeout(timer); resolve(); } });
    child.stderr.on('data', bytes => { log += String(bytes); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error('Synthetic browser server exited ' + code + ': ' + log)); });
  });
}

const harness = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>PDL Safety acceptance</title><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/design-system.css"><link rel="stylesheet" href="/safety-pm-ui.css"></head><body><button id="open-safety-pm" data-open-safety-pm>Safety today</button><div id="report-list"></div><div id="report-detail"></div><script>
let currentUser=${JSON.stringify(user)},company=${JSON.stringify(company)},projects=${JSON.stringify(projects)},photos=${JSON.stringify(photos)},team=${JSON.stringify(db.team)},assignments=${JSON.stringify(db.assignments)},currentRole='office',reports=[];
function signedInCompanyId(){return company.id}
function companyTodayIso(){return '${date}'}
function renderEverything(){}
function renderReports(selected){document.getElementById('report-list').innerHTML='<button class="report-list-item active" data-report="'+Number(selected)+'">Selected daily</button>';document.getElementById('report-detail').innerHTML='<div class="ai-banner">Daily summary</div>';return 'existing-render-result'}
async function api(url,options={}){const response=await fetch(url,{...options,headers:{'Content-Type':'application/json',...(options.headers||{})}}),data=await response.json();if(!response.ok){const error=new Error(data.error||'Request failed');error.status=response.status;error.code=data.code;throw error}return data}
</script><script src="/safety-pm-ui.js"></script></body></html>`;

async function responseAfter(page, pathPart, action, method) {
  const result = page.waitForResponse(response => response.url().includes(pathPart) && (!method || response.request().method() === method));
  await action();
  const response = await result;
  assert.ok(response.ok(), await response.text());
  return response;
}

(async () => {
  try {
    await start();
    browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, extraHTTPHeaders: { Authorization: 'Bearer ' + bearer, 'X-PDL-Company': companyId } });
    // Third-party content cannot receive even synthetic auth headers.
    await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
    await context.route(base + '/__safety-ui', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: harness }));
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(base + '/__safety-ui');
    await page.getByRole('button', { name: 'Safety today', exact: true }).click();
    const dialog = page.locator('#safety-pm-dialog');
    await dialog.locator('[data-safety-profile]').waitFor();
    const profile = dialog.locator('[data-safety-profile]');
    assert.equal(await profile.locator('[name="employer"]').inputValue(), company.name, 'project setup auto-fills the signed-in company name');
    assert.equal(await profile.locator('[name="state"]').inputValue(), 'OR', 'project setup auto-selects Oregon from the project address');
    await profile.locator('[name="activities"][value="roofing"]').check();
    const profileSave = await responseAfter(page, '/safety/profile', () => profile.getByRole('button', { name: 'Turn on Safety' }).click(), 'PUT');
    const savedProfile = await profileSave.json();
    assert.equal(savedProfile.profile.employer, company.name, 'the server receives the company-account employer without retyping it');
    assert.equal(savedProfile.profile.state, 'OR', 'the server receives the project-address jurisdiction without reselecting it');
    await page.evaluate(dateValue => PDLSafety.open(101, dateValue, 'setup'), date);
    await dialog.locator('[data-safety-turn-off]').waitFor();
    await page.evaluate(dateValue => PDLSafety.open(101, dateValue, 'checks'), date);
    assert.equal(await dialog.locator('[data-safety-profile]').count(), 0, 'configured setup does not sit above the focused daily task');
    await dialog.locator('[data-safety-check="scope-confirmation"]').waitFor({ state: 'attached' });
    const prepared = await (await context.request.get(base + `/api/projects/101/safety?date=${date}`)).json();
    assert.equal(prepared.day.checks.length, 4, 'the compact setup auto-prepares the day once');
    for (const expected of prepared.day.checks) {
      await dialog.locator(`[data-safety-check="${expected.id}"]`).waitFor();
      const form = dialog.locator('[data-safety-check]');
      assert.equal(await form.getAttribute('data-safety-check'), expected.id, 'the runner advances one focused check at a time');
      await responseAfter(page, '/checks/' + expected.id, () => form.getByRole('button', { name: 'Looks good', exact: true }).click(), 'PATCH');
    }
    await dialog.getByText('Today’s safety check is complete', { exact: true }).waitFor();
    assert.equal(await dialog.locator('.safety-demo').count(), 0, 'the prospect-demo builder is removed from the live safety workflow');

    await page.evaluate(dateValue => PDLSafety.open(101, dateValue, 'talk'), date);
    const talk = dialog.locator('[data-safety-talk]');
    await talk.waitFor();
    assert.equal(await talk.locator('[name="attendeeIds"]:checked').count(), 1, 'scheduled crew is selected for presenter-reported attendance');
    await talk.locator('[name="topic"]').fill('Roof access and opening protection');
    await talk.locator('[name="notes"]').fill('Reviewed access, openings, and stop-work expectations.');
    await responseAfter(page, '/talks', () => talk.getByRole('button', { name: 'Save toolbox talk', exact: true }).click(), 'POST');
    const talked = await (await context.request.get(base + `/api/projects/101/safety?date=${date}`)).json();
    assert.equal(talked.day.talks[0].presenter, user.name, 'the signed-in presenter is server-owned');
    assert.deepEqual(talked.day.talks[0].attendees.map(row => row.name), ['Demo crew member']);
    await page.evaluate(dateValue => PDLSafety.open(101, dateValue, 'talk'), date);
    await dialog.getByText('Correct record', { exact: true }).click();
    const correction = dialog.locator('[data-talk-action="amend"]');
    await correction.locator('[name="reason"]').fill('Correcting the topic wording while preserving the original.');
    await correction.locator('[name="topic"]').fill('Roof access, openings, and stop-work expectations');
    await responseAfter(page, '/talks/', () => correction.getByRole('button', { name: 'Save correction', exact: true }).click(), 'PATCH');
    const correctedTalk = await (await context.request.get(base + `/api/projects/101/safety?date=${date}`)).json();
    assert.equal(correctedTalk.day.talks[0].topic, 'Roof access, openings, and stop-work expectations');
    assert.equal(correctedTalk.day.talks[0].initial.topic, 'Roof access and opening protection', 'correction preserves the original talk evidence');
    await dialog.getByText('Void duplicate or wrong record', { exact: true }).waitFor();
    await page.evaluate(dateValue => { assignments = []; return PDLSafety.open(101, dateValue, 'talk'); }, date);
    await dialog.getByText('Schedule at least one crew member before recording attendance.', { exact: true }).first().waitFor();
    assert.equal(await dialog.getByRole('button', { name: 'Save toolbox talk', exact: true }).isDisabled(), true, 'attendance cannot be recorded without a scheduled crew member');
    await page.evaluate(rows => { assignments = rows; }, db.assignments);

    await page.evaluate(dateValue => PDLSafety.open(101, dateValue, 'hazard'), date);
    const hazard = dialog.locator('[data-safety-hazard-create]');
    await hazard.waitFor();
    await hazard.locator('[name="observation"]').fill('Unprotected roof opening at west stair');
    await hazard.locator('[name="location"]').fill('West roof stair landing');
    await hazard.locator('[name="action"]').fill('Stopped affected work and barricaded the opening pending cover installation.');
    await hazard.locator('[name="outcome"][value="followup"]').check();
    await hazard.locator('[name="workStoppedChoice"][value="yes"]').check();
    await hazard.locator('[name="owner"]').fill('Roof crew lead');
    await hazard.locator('[name="dueDate"]').fill(date);
    await hazard.locator('[name="photoId"]').selectOption('1');
    await responseAfter(page, '/hazards', () => hazard.getByRole('button', { name: 'Save hazard', exact: true }).click(), 'POST');
    const savedHazard = dialog.locator('[data-safety-hazard-update]');
    await savedHazard.waitFor();
    const unstopped = await (await context.request.get(base + `/api/projects/101/safety?date=${date}`)).json();
    assert.equal(unstopped.day.summary.canSubmit, true, 'documented stopped work can be submitted while follow-up remains open');
    assert.equal(unstopped.day.hazards[0].status, 'open', 'recording protection does not resolve the hazard');
    await responseAfter(page, '/hazards/', () => savedHazard.getByRole('button', { name: 'Mark corrected', exact: true }).click(), 'PATCH');
    await dialog.locator('[data-next-status="verified"]').waitFor();
    const verifyHazard = dialog.locator('[data-next-status="verified"]');
    await verifyHazard.locator('[name="verification"]').fill('PM inspected the secured rated cover at 09:10 before affected work resumed.');
    await responseAfter(page, '/hazards/', () => verifyHazard.getByRole('button', { name: 'Verify closed', exact: true }).click(), 'PATCH');
    await dialog.getByText('No open follow-up', { exact: true }).first().waitFor();
    const submitted = await context.request.post(base + '/api/reports', { data: { projectId: 101, project: 0, dateIso: date, notes: 'Synthetic inspected roofing daily.', status: 'Submitted', reportType: 'superintendent', extracted: { reportType: 'superintendent' }, productionEntries: [], laborEntries: [] } });
    assert.equal(submitted.status(), 201, await submitted.text());
    const saved = await submitted.json();
    assert.ok(saved.safetyEvidence, 'actual submitted report includes server-owned saved evidence');
    assert.equal(await page.evaluate(report => { reports = [report]; return renderReports(report.id); }, saved), 'existing-render-result', 'wrapper preserves the original render return');
    const evidence = page.locator('#report-detail [data-safety-evidence]');
    assert.match(await evidence.innerText(), /Safety record at submission/);
    assert.match(await evidence.innerText(), /0 unresolved/);
    assert.match(await evidence.textContent(), /Morgan Lee/);
    assert.match(await evidence.textContent(), /Toolbox talks \(1\)/);
    assert.match(await evidence.textContent(), /Roof access, openings, and stop-work expectations/);
    assert.match(await evidence.textContent(), /Demo crew member/);
    await page.evaluate(id => renderReports(id), saved.id);
    assert.equal(await evidence.count(), 1, 'repeated daily rendering must not duplicate saved evidence');
    const currentRead = await (await context.request.get(base + `/api/projects/101/safety?date=${date}`)).json();
    const failed = await context.request.patch(base + `/api/projects/101/safety/days/${date}/checks/roofing-protection`, { data: { revision: currentRead.day.revision, status: 'fail', inspector: 'Later inspector', notes: 'LATER CONDITION: edge protection changed.', action: 'Stopped affected roofing work.', owner: 'Roof lead', dueDate: date, workStopped: true } });
    assert.equal(failed.status(), 200, await failed.text());
    await page.evaluate(id => renderReports(id), saved.id);
    assert.match(await evidence.innerText(), /0 unresolved/, 'historical evidence must retain the saved unresolved count');
    assert.doesNotMatch(await evidence.textContent(), /LATER CONDITION/, 'rendering historical evidence must not substitute current answers');
    assert.equal(await evidence.locator('[data-open-safety-pm]').getAttribute('data-project-id'), '101');
    await dialog.evaluate(node => { node.scrollTop = 0; });
    fs.mkdirSync(path.join(__dirname, 'output'), { recursive: true });
    await page.screenshot({ path: path.join(__dirname, 'output', 'safety-v3-desktop.png'), fullPage: true });
    assert.equal(await dialog.evaluate(node => node.scrollWidth > node.clientWidth), false, 'desktop dialog must not overflow horizontally');
    assert.equal(await dialog.locator('[data-safety-body]').evaluate(node => getComputedStyle(node).marginLeft), '0px', 'the app sidebar margin must not indent the dialog body');
    await page.setViewportSize({ width: 390, height: 844 });
    await dialog.evaluate(node => { node.scrollTop = 0; });
    await page.screenshot({ path: path.join(__dirname, 'output', 'safety-v3-mobile.png'), fullPage: true });
    assert.equal(await dialog.evaluate(node => node.scrollWidth > node.clientWidth), false, '390px dialog must not overflow horizontally');
    await page.evaluate(() => PDLSafety.close());
    await evidence.locator('details').evaluateAll(nodes => nodes.forEach(node => { node.open = true; }));
    await evidence.screenshot({ path: path.join(__dirname, 'output', 'safety-v3-report-evidence.png') });
    assert.equal(await evidence.evaluate(node => node.scrollWidth > node.clientWidth), false, 'saved daily evidence must fit a mobile report');
    await page.evaluate(dateValue => PDLSafety.open(101, dateValue, 'hazard'), date);
    await dialog.locator('[data-safety-hazard-create]').waitFor();
    await dialog.locator('[data-safety-hazard-create] textarea[name="observation"]').fill('Unsaved scope-bound draft');
    await page.evaluate(() => { currentUser = { ...currentUser, id: 99 }; renderEverything(); });
    assert.equal(await dialog.evaluate(node => node.open), false);
    assert.equal(await dialog.locator('[data-safety-body]').innerText(), '', 'closing safety wipes account-specific UI data');
    await page.evaluate(({ userValue, dateValue }) => { currentUser = userValue; renderEverything(); return PDLSafety.open(101, dateValue, 'setup'); }, { userValue: user, dateValue: date });
    await dialog.locator('[data-safety-turn-off]').waitFor();
    page.once('dialog', prompt => prompt.accept());
    await responseAfter(page, '/safety/profile', () => dialog.locator('[data-safety-turn-off]').click(), 'PUT');
    const disabledProfile = await (await context.request.get(base + `/api/projects/101/safety?date=${date}`)).json();
    assert.equal(disabledProfile.profile.enabled, false, 'an owner can explicitly remove the daily safety gate from project setup');
    assert.deepEqual(errors, [], 'browser must not raise runtime errors');
    console.log('Safety v3 browser acceptance passed: compact setup, focused checks, hazard follow-up, toolbox attendance/correction, evidence, owner disable, mobile overflow and scope cleanup.');
  } finally {
    await browser?.close();
    if (child && child.exitCode == null) { const stopped = once(child, 'exit'); child.kill('SIGTERM'); await stopped; }
    const tempRoot = path.resolve(os.tmpdir()) + path.sep;
    if (!path.resolve(temp).startsWith(tempRoot)) throw new Error('Synthetic cleanup target escaped the temp directory.');
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
