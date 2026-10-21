'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const readiness = require('./provider-readiness');

function keyPair() {
  const pair = crypto.generateKeyPairSync('ed25519');
  return {
    publicKey: pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    privateKey: pair.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64')
  };
}

function environment(keys) {
  const env = {
    NODE_ENV: 'production',
    PDL_PUBLIC_URL: 'https://app.prodailylink.com',
    PDL_PRODUCTION_SUPABASE_PROJECT_REF: 'abcdefghijklmnopqrst',
    PDL_PROVIDER_ATTESTATION_PUBLIC_KEY: keys.publicKey,
    PDL_PROVIDER_ATTESTATION_PRIVATE_KEY: keys.privateKey,
    STRIPE_SECRET_KEY: 'rk_live_synthetic_monitor',
    STRIPE_PORTAL_CONFIG_STANDARD: 'bpc_standard123',
    STRIPE_PORTAL_CONFIG_FOUNDER: 'bpc_founder123',
    RESEND_FROM: 'Pro Daily Link <support@prodailylink.com>',
    RESEND_REPLY_TO: 'support@prodailylink.com',
    RESEND_API_KEY: 're_runtime_synthetic',
    SENTRY_DSN: 'https://0123456789abcdef@sentry.io/123456'
  };
  for (const key of readiness.PRICE_KEYS) env[key] = `price_${key.toLowerCase()}`;
  for (const key of readiness.PRODUCT_KEYS) env[key] = `prod_${key.toLowerCase()}`;
  for (const key of readiness.RUNTIME_VERSION_KEYS) env[key] = `rotation-${key.toLowerCase()}`;
  env.STRIPE_WEBHOOK_SECRET = 'whsec_runtime_synthetic';
  return env;
}

function greenReport() {
  return {
    failures: [],
    stripe: {
      reachable: true,
      liveMode: true,
      prices: readiness.PRICE_KEYS.map(key => ({ key, ok: true })),
      webhook: { status: 'ready' },
      portals: { standard: { status: 'ready' }, founder: { status: 'ready' } }
    },
    resend: { delivery: 'verified' },
    monitoring: { delivery: 'verified' }
  };
}

function storage() {
  const objects = new Map();
  return {
    objects,
    upload: async (bucket, key, bytes, type, upsert) => {
      assert.equal(bucket, readiness.BUCKET);
      assert.equal(type, 'application/json');
      if (!upsert && objects.has(key)) throw new Error('already exists');
      objects.set(key, Buffer.from(bytes));
    },
    download: async (bucket, key) => {
      assert.equal(bucket, readiness.BUCKET);
      if (!objects.has(key)) throw new Error('not found');
      return new Response(objects.get(key));
    }
  };
}

(async () => {
  const keys = keyPair(), env = environment(keys), provider = storage();
  const now = new Date('2026-10-20T18:00:00.000Z');
  const published = await readiness.publish({ report: greenReport(), env, upload: provider.upload, download: provider.download, now });
  assert.equal(published.published, true);
  assert.match(published.attestationSha256, /^[a-f0-9]{64}$/);

  const healthy = await readiness.publicStatus({ env, download: provider.download, now: now.valueOf() + 60_000 });
  assert.deepEqual(healthy.checks, { stripe: true, email: true, monitoring: true });
  assert.equal(healthy.ready, true);
  assert.equal(JSON.stringify(healthy).includes('rk_live_synthetic_monitor'), false);
  assert.equal(readiness.targetDigest({ ...env, STRIPE_SECRET_KEY: 'rk_live_rotated', STRIPE_WEBHOOK_SECRET: 'whsec_rotated',
    RESEND_API_KEY: 're_rotated', SENTRY_DSN: 'https://fedcba9876543210@sentry.io/654321' }), readiness.targetDigest(env),
  'secret material is never hashed into the target; operator rotation labels carry identity');

  const changedTarget = { ...env, STRIPE_PORTAL_CONFIG_STANDARD: 'bpc_changed1234' };
  assert.equal((await readiness.publicStatus({ env: changedTarget, download: provider.download, now: now.valueOf() + 60_000 })).ready, false);
  for (const key of [...readiness.RUNTIME_VERSION_KEYS, 'RESEND_REPLY_TO']) {
    const wrong = { ...env, [key]: key === 'RESEND_REPLY_TO' ? 'other@prodailylink.com' : 'different-rotation' };
    assert.equal((await readiness.publicStatus({ env: wrong, download: provider.download, now: now.valueOf() + 60_000 })).ready, false, `${key} must be target-bound`);
    const missingValue = { ...env }; delete missingValue[key];
    assert.equal((await readiness.publicStatus({ env: missingValue, download: provider.download, now: now.valueOf() + 60_000 })).ready, false, `${key} must be required`);
  }
  const stale = await readiness.publicStatus({ env, download: provider.download, now: now.valueOf() + readiness.DEFAULT_MAX_AGE_MS + 1 });
  assert.equal(stale.ready, false);
  assert.equal(stale.status, 'stale');

  const missing = await readiness.publicStatus({ env, download: storage().download, now: now.valueOf() });
  assert.equal(missing.reason, 'provider_readiness_unavailable');
  const timeout = await readiness.publicStatus({ env: { ...env, PDL_PROVIDER_READINESS_TIMEOUT_MS: '50' }, download: () => new Promise(() => {}), now: now.valueOf() });
  assert.equal(timeout.reason, 'provider_readiness_unavailable', 'a blocked provider evidence read must fail closed within its deadline');

  assert.deepEqual(readiness.runtimeConfiguration(env, true), { email: true, billing: true, monitoring: true });
  for (const key of ['RESEND_API_KEY', 'STRIPE_WEBHOOK_SECRET', 'SENTRY_DSN']) {
    const local = { ...env }; delete local[key];
    const configured = readiness.runtimeConfiguration(local, key !== 'SENTRY_DSN');
    assert.equal(key === 'RESEND_API_KEY' ? configured.email : key === 'STRIPE_WEBHOOK_SECRET' ? configured.billing : configured.monitoring, false);
  }

  const pointer = JSON.parse(provider.objects.get(readiness.POINTER_KEY));
  const corrupted = storage();
  corrupted.objects.set(readiness.POINTER_KEY, provider.objects.get(readiness.POINTER_KEY));
  corrupted.objects.set(pointer.objectKey, Buffer.from(provider.objects.get(pointer.objectKey)));
  const badPointer = { ...pointer, attestationSignature: Buffer.alloc(64).toString('base64') };
  corrupted.objects.set(readiness.POINTER_KEY, Buffer.from(JSON.stringify(badPointer)));
  assert.equal((await readiness.publicStatus({ env, download: corrupted.download, now: now.valueOf() })).reason, 'provider_readiness_invalid');

  await assert.rejects(() => readiness.publish({ report: { ...greenReport(), failures: ['stripe.unreachable'] }, env, upload: provider.upload, download: provider.download, now }), /not green/);
  await assert.rejects(() => readiness.publish({ report: greenReport(), env: { ...env, PDL_PROVIDER_ATTESTATION_PRIVATE_KEY: '' }, upload: provider.upload, download: provider.download, now }), /private key is missing/);
  await assert.rejects(() => readiness.publish({ report: greenReport(), env: { ...env, RENDER: 'true' }, upload: provider.upload, download: provider.download, now }), /independent monitor/);
  await assert.rejects(() => readiness.publish({ report: greenReport(), env: { ...env, PDL_PROVIDER_ATTESTATION_PRIVATE_KEY: keyPair().privateKey }, upload: provider.upload, download: provider.download, now }), /keys do not match/);

  console.log('Provider readiness passed: signed target-bound evidence is durable, freshness-bound, and fail-closed without exposing provider credentials.');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
