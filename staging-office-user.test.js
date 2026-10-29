'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const seed = require('./staging-seed');

const ownerPassword = 'staging-owner-pass';
const fieldPassword = 'staging-field-pass';
const officePassword = 'staging-office-pass';
const replacementPassword = 'staging-office-next';
const seedEnv = { PDL_STAGING_OWNER_PASSWORD: ownerPassword, PDL_STAGING_FIELD_PASSWORD: fieldPassword };
const officeEnv = { PDL_STAGING: '1', PDL_STAGING_OFFICE_PASSWORD: officePassword };
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-staging-office-'));
const file = path.join(root, 'db.json');

function read() {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function officeUsers(db = read()) {
  return db.users.filter(user => String(user.email || '').toLowerCase() === seed.OFFICE_EMAIL.toLowerCase());
}

function passwordMatches(user, password) {
  return crypto.scryptSync(password, user.passwordSalt, 64).toString('hex') === user.passwordHash;
}

function withInfo(fn) {
  const lines = [];
  const original = console.info;
  console.info = (...args) => lines.push(args.map(value => String(value)).join(' '));
  try {
    return { result: fn(), lines };
  } finally {
    console.info = original;
  }
}

seed.ensureStagingDatabase(file, seedEnv);
const untouched = fs.readFileSync(file, 'utf8');
const ownerBefore = read().users.find(user => user.role === 'owner');
const fieldBefore = read().users.find(user => user.role === 'field');

const missingPassword = withInfo(() => seed.ensureStagingOfficeUser(file, { PDL_STAGING: '1' }));
assert.deepEqual(missingPassword.result, { applied: false });
assert.deepEqual(missingPassword.lines, ['Staging office demo user skipped: PDL_STAGING_OFFICE_PASSWORD unset']);
assert.equal(fs.readFileSync(file, 'utf8'), untouched);
assert.equal(officeUsers().length, 0);

const emptyPassword = withInfo(() => seed.ensureStagingOfficeUser(file, { PDL_STAGING: '1', PDL_STAGING_OFFICE_PASSWORD: '' }));
assert.deepEqual(emptyPassword.result, { applied: false });
assert.deepEqual(emptyPassword.lines, ['Staging office demo user skipped: PDL_STAGING_OFFICE_PASSWORD unset']);
assert.equal(fs.readFileSync(file, 'utf8'), untouched);

const outside = withInfo(() => seed.ensureStagingOfficeUser(file, { PDL_STAGING_OFFICE_PASSWORD: officePassword }));
assert.deepEqual(outside.result, { applied: false });
assert.deepEqual(outside.lines, []);
assert.equal(fs.readFileSync(file, 'utf8'), untouched);

for (const flag of ['0', 'true', 'yes']) {
  const result = seed.ensureStagingOfficeUser(file, { PDL_STAGING: flag, PDL_STAGING_OFFICE_PASSWORD: officePassword, NODE_ENV: 'production' });
  assert.deepEqual(result, { applied: false }, flag);
  assert.equal(fs.readFileSync(file, 'utf8'), untouched);
}

const productionUrlWithoutStaging = withInfo(() => seed.ensureStagingOfficeUser(file, {
  PDL_STAGING_OFFICE_PASSWORD: officePassword,
  NODE_ENV: 'production',
  PDL_PUBLIC_URL: 'https://app.prodailylink.com'
}));
assert.deepEqual(productionUrlWithoutStaging.result, { applied: false });
assert.deepEqual(productionUrlWithoutStaging.lines, []);
assert.equal(fs.readFileSync(file, 'utf8'), untouched);

const otherCompany = path.join(root, 'other.json');
fs.writeFileSync(otherCompany, JSON.stringify({ company: { id: 'not-the-demo', demo: true }, users: [], team: [] }));
const otherBefore = fs.readFileSync(otherCompany, 'utf8');
assert.deepEqual(seed.ensureStagingOfficeUser(otherCompany, officeEnv), { applied: false });
assert.equal(fs.readFileSync(otherCompany, 'utf8'), otherBefore);

const notDemo = path.join(root, 'not-demo.json');
fs.writeFileSync(notDemo, JSON.stringify({ company: { id: seed.COMPANY_ID, demo: false }, users: [], team: [] }));
const notDemoBefore = fs.readFileSync(notDemo, 'utf8');
assert.deepEqual(seed.ensureStagingOfficeUser(notDemo, officeEnv), { applied: false });
assert.equal(fs.readFileSync(notDemo, 'utf8'), notDemoBefore);

assert.deepEqual(seed.ensureStagingOfficeUser(path.join(root, 'missing.json'), officeEnv), { applied: false });
assert.equal(fs.existsSync(path.join(root, 'missing.json')), false);

assert.throws(
  () => seed.ensureStagingOfficeUser(file, { PDL_STAGING: '1', PDL_STAGING_OFFICE_PASSWORD: 'short' }),
  error => {
    assert.match(error.message, /PDL_STAGING_OFFICE_PASSWORD/);
    assert.equal(error.message.includes('short'), false);
    return true;
  }
);
assert.equal(fs.readFileSync(file, 'utf8'), untouched);
assert.doesNotThrow(() => seed.ensureStagingOfficeUser(file, { PDL_STAGING_OFFICE_PASSWORD: 'short' }));

const seeded = read();
seeded.reports.push({ id: 42, notes: 'keep this daily' });
fs.writeFileSync(file, JSON.stringify(seeded, null, 2));

const first = withInfo(() => seed.ensureStagingOfficeUser(file, { ...officeEnv, PDL_PUBLIC_URL: 'https://app.prodailylink.com', NODE_ENV: 'production' }));
const second = withInfo(() => seed.ensureStagingOfficeUser(file, { ...officeEnv, PDL_STAGING_OFFICE_PASSWORD: replacementPassword }));
const db = read();
const matches = officeUsers(db);
assert.equal(first.result.applied, true);
assert.equal(first.result.created, true);
assert.equal(second.result.applied, true);
assert.equal(second.result.created, false);
assert.equal(second.result.id, first.result.id);
assert.equal(matches.length, 1);
assert.equal(db.users.filter(user => user.role === 'owner').length, 1);
assert.equal(db.users.filter(user => user.role === 'field').length, 1);
assert.equal(matches[0].id, first.result.id);
assert.equal(matches[0].name, 'DEMO Office Manager');
assert.equal(matches[0].email, 'office-demo@prodailylink.com');
assert.equal(matches[0].role, 'admin');
assert.equal(matches[0].permissions.manageTime, true);
assert.equal(matches[0].companyId, seed.COMPANY_ID);
assert.equal(matches[0].status, 'Active');
assert.equal(matches[0].mustSetPassword, false);
assert.equal(passwordMatches(matches[0], replacementPassword), true);
assert.equal(passwordMatches(matches[0], officePassword), false);
assert.notEqual(matches[0].passwordSalt, undefined);
assert.equal(db.reports.length, 1);
assert.equal(db.reports[0].notes, 'keep this daily');
const members = db.team.filter(member => String(member.email || '').toLowerCase() === seed.OFFICE_EMAIL);
assert.equal(members.length, 1);
assert.equal(matches[0].memberId, members[0].id);
assert.match(`${members[0].role} ${members[0].crew}`, /office/i);
const ownerAfter = db.users.find(user => user.role === 'owner');
const fieldAfter = db.users.find(user => user.role === 'field');
assert.equal(ownerAfter.passwordHash, ownerBefore.passwordHash);
assert.equal(ownerAfter.passwordSalt, ownerBefore.passwordSalt);
assert.equal(fieldAfter.passwordHash, fieldBefore.passwordHash);
const stored = JSON.stringify(db);
assert.equal(stored.includes(officePassword), false);
assert.equal(stored.includes(replacementPassword), false);
const logged = [...first.lines, ...second.lines].join('\n');
assert.match(logged, /office-demo@prodailylink.com/);
assert.equal(logged.includes(officePassword), false);
assert.equal(logged.includes(replacementPassword), false);

db.users.push({ ...matches[0], id: 99, email: 'OFFICE-DEMO@prodailylink.com' });
db.team.push({ ...members[0], id: 98, email: seed.OFFICE_EMAIL });
fs.writeFileSync(file, JSON.stringify(db));
const collapsed = withInfo(() => seed.ensureStagingOfficeUser(file, officeEnv));
assert.equal(collapsed.lines.join('\n').includes(officePassword), false);
const afterCollapse = read();
assert.equal(officeUsers(afterCollapse).length, 1);
assert.equal(afterCollapse.team.filter(member => String(member.email || '').toLowerCase() === seed.OFFICE_EMAIL).length, 1);
assert.equal(collapsed.result.id, matches[0].id);
assert.equal(passwordMatches(officeUsers(afterCollapse)[0], officePassword), true);

seed.ensureStagingDatabase(file, seedEnv);
assert.equal(officeUsers().length, 0);
const restored = withInfo(() => seed.ensureStagingOfficeUser(file, officeEnv));
assert.equal(restored.lines.join('\n').includes(officePassword), false);
assert.equal(officeUsers().length, 1);
assert.equal(passwordMatches(officeUsers()[0], officePassword), true);
assert.equal(restored.result.created, true);

const source = fs.readFileSync(path.join(__dirname, 'staging-seed.js'), 'utf8');
const server = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
assert.equal(source.includes(officePassword), false);
assert.equal(source.includes(replacementPassword), false);
assert.doesNotMatch(source, /PDL_STAGING_OFFICE_PASSWORD\s*\|\|\s*['"`]/);
assert.equal(seed.OFFICE_ROLE, 'admin');
const stagingStart = server.indexOf("if(process.env.PDL_STAGING==='1')");
const stagingEnd = server.indexOf('Runtime configuration');
const stagingBlock = server.slice(stagingStart, stagingEnd);
assert.match(stagingBlock, /ensureStagingDatabase\(DB_FILE, process\.env\)/);
assert.match(stagingBlock, /ensureStagingOfficeUser\(DB_FILE, process\.env\)/);
assert.equal(server.slice(stagingEnd).includes('ensureStagingOfficeUser'), false);

function freePort() {
  return new Promise(resolve => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function serverEnv(port, extra = {}) {
  const env = {
    ...process.env,
    PORT: String(port),
    PDL_STAGING: '1',
    PDL_STAGING_OWNER_PASSWORD: ownerPassword,
    PDL_STAGING_FIELD_PASSWORD: fieldPassword,
    PDL_DB_FILE: file,
    PDL_PLATFORM_FILE: path.join(root, 'platform.json'),
    PDL_EMAIL_DEV_MODE: '1',
    PDL_SUPABASE_ENABLED: '0',
    PDL_TRANSACTIONAL_DB: 'off',
    PDL_PLATFORM_TRANSACTIONAL_DB: 'off',
    OPENAI_API_KEY: '',
    NODE_ENV: 'test',
    PDL_PUBLIC_URL: 'https://pdl-staging.onrender.com',
    ...extra
  };
  for (const name of ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'RESEND_API_KEY', 'INDEXNOW_KEY', 'SENTRY_DSN', 'DATABASE_URL', 'SUPABASE_URL', 'SUPABASE_SECRET_KEY']) delete env[name];
  if (!Object.hasOwn(extra, 'PDL_STAGING_OFFICE_PASSWORD')) delete env.PDL_STAGING_OFFICE_PASSWORD;
  return env;
}

async function startServer(env) {
  const child = spawn(process.execPath, ['--require', require.resolve('./scripts/test-analytics-isolation.cjs'), 'server.js'], {
    cwd: __dirname,
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let log = '';
  child.stdout.on('data', chunk => { log += chunk; });
  child.stderr.on('data', chunk => { log += chunk; });
  const deadline = Date.now() + 20000;
  while (!log.includes('running at')) {
    if (child.exitCode != null || Date.now() > deadline) {
      child.kill('SIGKILL');
      throw new Error(`staging server did not start\n${log}`);
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return {
    log: () => log,
    stop() {
      return new Promise(resolve => {
        if (child.exitCode != null) return resolve();
        child.once('exit', () => resolve());
        child.kill('SIGTERM');
        setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 5000).unref();
      });
    }
  };
}

async function login(port) {
  const response = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: seed.OFFICE_EMAIL, password: officePassword })
  });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify({ status: response.status, error: body.error || '' }));
  assert.equal(body.user.email, seed.OFFICE_EMAIL);
  assert.equal(body.user.name, 'DEMO Office Manager');
  assert.equal(body.user.role, 'admin');
  const me = await fetch(`http://127.0.0.1:${port}/api/auth/me`, { headers: { authorization: `Bearer ${body.token}` } });
  const profile = await me.json();
  assert.equal(me.status, 200);
  assert.equal(profile.role, 'admin');
  assert.equal(profile.permissions.manageTime, true);
  assert.equal(profile.name, 'DEMO Office Manager');
  return body;
}

(async () => {
  const quietPort = await freePort();
  const quiet = await startServer(serverEnv(quietPort));
  try {
    assert.equal(officeUsers().length, 0);
    assert.equal(quiet.log().includes(officePassword), false);
  } finally {
    await quiet.stop();
  }

  for (const pass of [1, 2]) {
    const port = await freePort();
    const started = await startServer(serverEnv(port, { PDL_STAGING_OFFICE_PASSWORD: officePassword }));
    try {
      assert.equal(officeUsers().length, 1, `boot ${pass}`);
      assert.equal(passwordMatches(officeUsers()[0], officePassword), true);
      assert.equal(started.log().includes(officePassword), false);
      assert.match(started.log(), /office-demo@prodailylink.com/);
      await login(port);
    } finally {
      await started.stop();
    }
  }
  fs.rmSync(root, { recursive: true, force: true });
  console.log('Staging office user checks passed.');
})().catch(error => {
  console.error(error);
  fs.rmSync(root, { recursive: true, force: true });
  process.exit(1);
});
