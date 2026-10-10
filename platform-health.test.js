const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-platform-health-'));
const dbFile = path.join(tempDir, 'db.json');
fs.writeFileSync(dbFile, fs.readFileSync(path.join(__dirname, 'data', 'db.json')));
const platformFile = path.join(tempDir, 'platform.json');
fs.copyFileSync(path.join(__dirname, 'data', 'platform.json'), platformFile);
process.env.PDL_DB_FILE = dbFile;
process.env.PDL_PLATFORM_FILE = platformFile;
process.env.PDL_SUPABASE_ENABLED = '0';
process.env.PDL_EMAIL_DEV_MODE = '1';
process.env.PDL_REQUIRE_AUTH = '0';
process.env.PDL_PLATFORM_KEY = 'test-platform-key-32-characters-minimum';

const {server} = require('./server');
const base = 'http://127.0.0.1:4231';
const platform = {'x-pdl-platform-key': process.env.PDL_PLATFORM_KEY};
const daysAgo = n => new Date(Date.now() - n * 86400000).toISOString();

async function request(route, options = {}) {
  const headers = {'Content-Type': 'application/json', ...(options.headers || {})};
  const response = await fetch(base + route, {...options, headers});
  return {response, data: await response.json()};
}

function readDb() { return JSON.parse(fs.readFileSync(dbFile, 'utf8')); }
function writeDb(db) { fs.writeFileSync(dbFile, JSON.stringify(db)); }

async function overviewCompany() {
  const {response, data} = await request('/api/platform/overview', {headers: platform});
  assert.equal(response.status, 200);
  assert.equal(data.companies.length, 1);
  return data.companies[0];
}

server.listen(4231, async () => {
  try {
    const html = fs.readFileSync(path.join(__dirname, 'platform.js'), 'utf8');
    const serverSrc = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
    assert.match(html, /relativeDay=/, 'customer cards expose a relative latest-daily stamp');
    assert.match(html, /latest daily \$\{relativeDay\(c\.lastReport\)\}/);
    assert.match(serverSrc, /Trial ended — choose a plan/);
    assert.match(serverSrc, /Subscription \$\{access\.status\.toLowerCase\(\)\}/);
    assert.match(serverSrc, /No daily report in \$\{silentDays\} days/);

    // Paid scenario base: not a demo, standard account.
    const db = readDb();
    db.company.id = 'acme-builders';
    db.company.name = 'Acme Builders';
    db.company.demo = false;
    db.company.accountType = 'standard';
    db.company.billingExempt = false;

    // A) Expired trial surfaces as a risk instead of looking healthy.
    db.company.subscriptionStatus = 'Trial';
    db.company.trialEndsAt = daysAgo(2);
    db.company.createdAt = daysAgo(40);
    for (const report of db.reports || []) report.createdAt = daysAgo(1);
    writeDb(db);
    let company = await overviewCompany();
    assert.ok(company.health.alerts.includes('Trial ended — choose a plan'), `expired trial must alert, got ${JSON.stringify(company.health.alerts)}`);
    assert.ok(company.health.score < 100);
    assert.equal(company.subscriptionStatus, 'Trial');

    // B) Past-due subscription surfaces as a risk.
    db.company.subscriptionStatus = 'Past due';
    db.company.trialEndsAt = null;
    writeDb(db);
    company = await overviewCompany();
    assert.ok(company.health.alerts.includes('Subscription past due'), `past due must alert, got ${JSON.stringify(company.health.alerts)}`);

    // C) An account that goes quiet stops reading as healthy.
    db.company.subscriptionStatus = 'Active';
    db.company.createdAt = daysAgo(60);
    for (const report of db.reports || []) report.createdAt = daysAgo(30);
    writeDb(db);
    company = await overviewCompany();
    assert.ok(company.health.alerts.some(alert => /^No daily report in \d+ days$/.test(alert)), `silence must alert, got ${JSON.stringify(company.health.alerts)}`);

    // D) A brand-new account gets a grace window before usage alerts fire.
    db.company.createdAt = new Date().toISOString();
    db.company.trialEndsAt = new Date(Date.now() + 10 * 86400000).toISOString();
    db.projects = [];
    db.reports = [];
    writeDb(db);
    company = await overviewCompany();
    assert.ok(!company.health.alerts.includes('No project created'), `fresh account must not flag missing projects, got ${JSON.stringify(company.health.alerts)}`);
    assert.ok(!company.health.alerts.includes('No daily reports submitted'), `fresh account must not flag missing dailies, got ${JSON.stringify(company.health.alerts)}`);
    assert.equal(company.health.status, 'Healthy');

    console.log('platform-health: ok');
    server.close(() => process.exit(0));
  } catch (error) {
    console.error(error);
    server.close(() => process.exit(1));
  }
});
