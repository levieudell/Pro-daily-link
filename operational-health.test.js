'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-operational-health-'));
const dbFile = path.join(temp, 'db.json');
const platformFile = path.join(temp, 'platform.json');
fs.copyFileSync(path.join(__dirname, 'data', 'db.json'), dbFile);
fs.copyFileSync(path.join(__dirname, 'data', 'platform.json'), platformFile);

Object.assign(process.env, {
  NODE_ENV: 'production',
  PDL_DB_FILE: dbFile,
  PDL_PLATFORM_FILE: platformFile,
  PDL_SUPABASE_ENABLED: '0',
  PDL_TRANSACTIONAL_DB: 'off',
  PDL_PLATFORM_TRANSACTIONAL_DB: 'off',
  PDL_REQUIRE_AUTH: '1'
});
for (const key of ['SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'RESEND_API_KEY', 'RESEND_FROM',
  'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'SENTRY_DSN']) delete process.env[key];

const { server, operationalHealthRequirements } = require('./server');

(async () => {
  try {
    const healthyServices = {
      email: true,
      billing: true,
      monitoring: true,
      tenantRepository: { mode: 'primary', configured: true, ready: true },
      platformRepository: { mode: 'primary', configured: true, ready: true },
      backup: { fresh: true, independentCopy: 'not-checked', restore: 'not-checked' }
    };
    assert.deepEqual(operationalHealthRequirements({
      cloud: { configured: true, reachable: true },
      services: healthyServices,
      production: true
    }), {
      ok: true,
      requirements: {
        database: true,
        tenantRepository: true,
        platformRepository: true,
        email: true,
        billingWebhook: true,
        monitoring: true,
        verifiedBackup: true
      }
    });

    for (const mutate of [
      value => { value.cloud.reachable = false; },
      value => { value.services.tenantRepository.ready = false; },
      value => { value.services.platformRepository.mode = 'shadow'; },
      value => { value.services.email = false; },
      value => { value.services.billing = false; },
      value => { value.services.monitoring = false; },
      value => { value.services.backup.fresh = false; }
    ]) {
      const input = { cloud: { configured: true, reachable: true }, services: structuredClone(healthyServices), production: true };
      mutate(input);
      assert.equal(operationalHealthRequirements(input).ok, false, 'every production dependency must fail readiness closed');
    }

    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const live = await fetch(base + '/api/health/live');
    assert.equal(live.status, 200, 'liveness must stay healthy while dependencies are unconfigured');
    assert.deepEqual(await live.json().then(value => ({ ok: value.ok, kind: value.kind })), { ok: true, kind: 'liveness' });

    const readiness = await fetch(base + '/api/health');
    assert.equal(readiness.status, 503, 'production readiness must fail closed');
    const body = await readiness.json();
    assert.equal(body.ok, false);
    assert.equal(body.kind, 'operational-readiness');
    assert.deepEqual(body.cloud, { configured: false, reachable: false });
    assert.equal(body.requirements.database, false);
    assert.equal(body.requirements.tenantRepository, false);
    assert.equal(body.requirements.platformRepository, false);
    assert.equal(body.requirements.email, false);
    assert.equal(body.requirements.billingWebhook, false);
    assert.equal(body.requirements.monitoring, false);
    assert.equal(body.requirements.verifiedBackup, false);
    assert.equal(body.services.backup.independentCopy, 'not-checked');
    assert.equal(body.services.backup.restore, 'not-checked');
    assert.equal(JSON.stringify(body).includes('SUPABASE_SECRET_KEY'), false);

    const blueprint = fs.readFileSync(path.join(__dirname, 'render.yaml'), 'utf8');
    const app = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
    assert.match(blueprint, /healthCheckPath:\s*\/api\/health\/live/);
    assert.match(app, /fetch\('\/api\/health\/live'/);
    console.log('Operational health passed: Render liveness is isolated and production readiness fails closed on every required dependency.');
  } finally {
    if (server.listening) await new Promise(resolve => server.close(resolve));
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
