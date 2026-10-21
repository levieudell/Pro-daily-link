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
  PDL_OPERATIONAL_HEALTH_TIMEOUT_MS: '50',
  PDL_REQUIRE_AUTH: '1'
});
for (const key of ['SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'RESEND_API_KEY', 'RESEND_FROM',
  'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'SENTRY_DSN']) delete process.env[key];

const supabase = require('./database/supabase');
const recoveryReadiness = require('./database/recovery-readiness');
const { server, operationalHealthRequirements } = require('./server');

(async () => {
  try {
    const healthyServices = {
      email: { configured: true },
      billing: { configured: true },
      monitoring: { configured: true },
      providerVerification: { ready: true, status: 'verified', checks: { stripe: true, email: true, monitoring: true } },
      tenantRepository: { mode: 'primary', configured: true, ready: true },
      platformRepository: { mode: 'primary', configured: true, ready: true },
      backup: { fresh: true, independentCopy: 'not-checked', restore: 'not-checked' },
      recovery: { ready: true, independentCopy: 'verified', restore: 'verified' }
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
      value => { value.services.providerVerification.checks.email = false; },
      value => { value.services.providerVerification.checks.stripe = false; },
      value => { value.services.providerVerification.checks.monitoring = false; },
      value => { value.services.email.configured = false; },
      value => { value.services.billing.configured = false; },
      value => { value.services.monitoring.configured = false; },
      value => { value.services.providerVerification.ready = false; },
      value => { value.services.recovery.ready = false; }
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
    assert.equal(body.services.providerVerification.ready, false);
    assert.equal(body.services.providerVerification.status, 'unknown');
    assert.equal(body.requirements.verifiedBackup, false);
    assert.equal(body.services.backup.independentCopy, 'not-checked');
    assert.equal(body.services.backup.restore, 'not-checked');
    assert.equal(body.services.recovery.ready, false);
    assert.equal(body.services.recovery.reason, 'repositories_not_primary');
    assert.equal(body.services.recovery.independentCopy, 'not-verified');
    assert.equal(body.services.recovery.restore, 'not-verified');
    assert.equal(operationalHealthRequirements({
      cloud: { configured: true, reachable: true },
      services: { ...structuredClone(healthyServices), recovery: undefined },
      production: true
    }).ok, false, 'a fresh same-provider tenant receipt alone must never satisfy production readiness');
    assert.equal(JSON.stringify(body).includes('SUPABASE_SECRET_KEY'), false);

    const original = {
      health: supabase.health,
      transactionalHealth: supabase.transactionalHealth,
      download: supabase.download,
      listTransactionalSnapshots: supabase.listTransactionalSnapshots,
      loadTransactionalSnapshot: supabase.loadTransactionalSnapshot,
      recoveryPublicStatus: recoveryReadiness.publicStatus
    };
    const never = () => new Promise(() => {});
    try {
      supabase.health = never;
      recoveryReadiness.publicStatus = never;
      const hungStartedAt = Date.now();
      const hung = await fetch(base + '/api/health');
      const hungElapsed = Date.now() - hungStartedAt;
      assert.equal(hung.status, 503, 'a stalled production dependency must fail readiness closed');
      const hungBody = await hung.json();
      assert.equal(hungBody.services.recovery.reason, 'health_timeout');
      assert.ok(hungElapsed < 1000, `a stalled readiness collection must respect its deadline (elapsed ${hungElapsed}ms)`);

      Object.assign(process.env, {
        NODE_ENV: 'production',
        PDL_SUPABASE_ENABLED: '1',
        SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co',
        SUPABASE_SECRET_KEY: 'synthetic-health-test',
        PDL_TRANSACTIONAL_DB: 'primary'
      });
      supabase.health = async () => ({ configured: true, reachable: true });
      supabase.transactionalHealth = async () => ({ configured: true, reachable: true });
      supabase.download = async () => { throw new Error('synthetic provider evidence unavailable'); };
      recoveryReadiness.publicStatus = async () => ({ ready: false, status: 'unknown', reason: 'test', checks: { stripe: false, email: false, monitoring: false } });
      supabase.loadTransactionalSnapshot = never;
      const authorityStartedAt = Date.now();
      const authorityHung = await fetch(base + '/api/health');
      const authorityElapsed = Date.now() - authorityStartedAt;
      assert.equal(authorityHung.status, 503, 'a stalled backup-authority read must fail readiness closed');
      assert.equal((await authorityHung.json()).services.recovery.reason, 'health_timeout');
      assert.ok(authorityElapsed < 1000, `a stalled backup-authority read must respect the same deadline (elapsed ${authorityElapsed}ms)`);

      let recoveryReads = 0, evidenceReads = 0, authorityReads = 0;
      process.env.NODE_ENV = 'development';
      recoveryReadiness.publicStatus = async () => { recoveryReads += 1; return {}; };
      supabase.download = async () => { evidenceReads += 1; return null; };
      supabase.listTransactionalSnapshots = async () => { authorityReads += 1; return []; };
      supabase.loadTransactionalSnapshot = async () => { authorityReads += 1; return null; };
      const nonproduction = await fetch(base + '/api/health');
      assert.equal(nonproduction.status, 200, 'optional provider and recovery evidence must not block nonproduction health');
      assert.deepEqual({ recoveryReads, evidenceReads, authorityReads }, { recoveryReads: 0, evidenceReads: 0, authorityReads: 0 },
        'nonproduction health must not touch recovery evidence or authoritative backup state');
    } finally {
      Object.assign(supabase, {
        health: original.health,
        transactionalHealth: original.transactionalHealth,
        download: original.download,
        listTransactionalSnapshots: original.listTransactionalSnapshots,
        loadTransactionalSnapshot: original.loadTransactionalSnapshot
      });
      recoveryReadiness.publicStatus = original.recoveryPublicStatus;
      Object.assign(process.env, { NODE_ENV: 'production', PDL_SUPABASE_ENABLED: '0', PDL_TRANSACTIONAL_DB: 'off' });
      delete process.env.SUPABASE_URL;
      delete process.env.SUPABASE_SECRET_KEY;
    }

    const blueprint = fs.readFileSync(path.join(__dirname, 'render.yaml'), 'utf8');
    const providerWorkflow = fs.readFileSync(path.join(__dirname, '.github', 'workflows', 'provider-readiness.yml'), 'utf8');
    const app = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
    assert.match(blueprint, /healthCheckPath:\s*\/api\/health\/live/);
    for (const key of ['STRIPE_PORTAL_CONFIG_STANDARD', 'STRIPE_PORTAL_CONFIG_FOUNDER', 'PDL_PROVIDER_ATTESTATION_PUBLIC_KEY',
      'PDL_STRIPE_RUNTIME_KEY_VERSION', 'PDL_STRIPE_WEBHOOK_SECRET_VERSION', 'PDL_RESEND_RUNTIME_KEY_VERSION',
      'PDL_SENTRY_RUNTIME_DSN_VERSION', 'STRIPE_PRODUCT_STARTER', 'STRIPE_PRODUCT_ASSISTED_SETUP']) {
      assert.match(blueprint, new RegExp(`- key: ${key}\\s+sync: false`));
    }
    assert.doesNotMatch(blueprint, /PDL_PROVIDER_ATTESTATION_PRIVATE_KEY|STRIPE_MONITOR_KEY|RESEND_MONITOR_API_KEY|SENTRY_MONITOR_AUTH_TOKEN/);
    assert.match(providerWorkflow, /cron: '27 \*\/6 \* \* \*'/);
    assert.match(providerWorkflow, /if: github\.ref == 'refs\/heads\/main'/);
    assert.match(providerWorkflow, /environment: production-provider-readiness/);
    assert.match(providerWorkflow, /actions\/checkout@11bd71901bbe5b1630ceea73d27597364c9af683/);
    assert.match(providerWorkflow, /actions\/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020/);
    assert.doesNotMatch(providerWorkflow, /uses: actions\/(?:checkout|setup-node)@v\d/);
    assert.match(providerWorkflow, /npm ci --ignore-scripts/);
    assert.match(providerWorkflow, /PDL_PROVIDER_ATTESTATION_PRIVATE_KEY: \$\{\{ secrets\.PDL_PROVIDER_ATTESTATION_PRIVATE_KEY \}\}/);
    for (const key of ['PDL_STRIPE_RUNTIME_KEY_VERSION', 'PDL_STRIPE_WEBHOOK_SECRET_VERSION',
      'PDL_RESEND_RUNTIME_KEY_VERSION', 'PDL_SENTRY_RUNTIME_DSN_VERSION']) {
      assert.match(providerWorkflow, new RegExp(`${key}: \\$\\{\\{ vars\\.${key} \\}\\}`));
      assert.doesNotMatch(providerWorkflow, new RegExp(`${key}: \\$\\{\\{ secrets\\.`));
    }
    assert.match(providerWorkflow, /run: node scripts\/service-smoke-test\.js --active --publish-readiness/);
    assert.ok(providerWorkflow.indexOf('npm ci --ignore-scripts') < providerWorkflow.indexOf('PDL_PROVIDER_ATTESTATION_PRIVATE_KEY:'),
      'no production secret is in scope during dependency installation');
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
