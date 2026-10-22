'use strict';

const crypto = require('node:crypto');
const stripePricePolicy = require('./stripe-price-policy');

const BUCKET = 'tenant-backups';
const SCHEMA = 'pdl-provider-readiness/v1';
const POINTER_KEY = 'provider-readiness/current.json';
const ATTESTATION_PREFIX = 'provider-readiness/attestations/';
const DEFAULT_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const DEFAULT_READ_TIMEOUT_MS = 1000;
const FUTURE_SKEW_MS = 5 * 60 * 1000;
const PRICE_KEYS = stripePricePolicy.PRICE_KEYS;
const PRODUCT_KEYS = stripePricePolicy.PRODUCT_KEYS;
const RUNTIME_VERSION_KEYS = Object.freeze([
  'PDL_STRIPE_RUNTIME_KEY_VERSION',
  'PDL_STRIPE_WEBHOOK_SECRET_VERSION',
  'PDL_RESEND_RUNTIME_KEY_VERSION',
  'PDL_SENTRY_RUNTIME_DSN_VERSION'
]);

function fail(message, code = 'provider_readiness_invalid') {
  return Object.assign(new Error(message), { code });
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function strictIso(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw fail(`${label} is invalid`);
  }
  return value;
}

function normalizePublicUrl(value) {
  const parsed = new URL(String(value || '').trim());
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) throw fail('Production public URL is invalid');
  return parsed.origin + (parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/$/, ''));
}

function projectRef(env) {
  const value = String(env.PDL_PRODUCTION_SUPABASE_PROJECT_REF || '').trim().toLowerCase();
  if (!/^[a-z0-9]{20}$/.test(value)) throw fail('Production project reference is invalid');
  return value;
}

function versionMarker(env, key) {
  const value = String(env[key] || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/.test(value)) throw fail(`${key} is invalid`);
  return value;
}

function emailAddress(value, label) {
  const text = String(value || '').trim().toLowerCase();
  const match = text.match(/(?:<)?[^<>\s@]+@([^<>\s@]+)>?$/);
  if (!match || !match[1].includes('.')) throw fail(`${label} is invalid`);
  return text;
}

function configuredDistinctValues(env, keys) {
  const values = keys.map(key => String(env[key] || '').trim());
  return values.every(Boolean) && new Set(values).size === keys.length;
}

function targetDigest(env = process.env) {
  const fields = {
    publicUrl: normalizePublicUrl(env.PDL_PUBLIC_URL),
    projectRef: projectRef(env),
    stripeMode: /^(?:sk|rk)_live_/.test(String(env.STRIPE_SECRET_KEY || '')) ? 'live' : 'not-live',
    standardPortal: String(env.STRIPE_PORTAL_CONFIG_STANDARD || '').trim(),
    founderPortal: String(env.STRIPE_PORTAL_CONFIG_FOUNDER || '').trim(),
    resendFrom: emailAddress(env.RESEND_FROM, 'Resend sender'),
    resendReplyTo: emailAddress(env.RESEND_REPLY_TO, 'Resend reply-to'),
    runtimeVersions: RUNTIME_VERSION_KEYS.map(key => [key, versionMarker(env, key)]),
    prices: PRICE_KEYS.map(key => [key, String(env[key] || '').trim()]),
    products: PRODUCT_KEYS.map(key => [key, String(env[key] || '').trim()])
  };
  if (fields.stripeMode !== 'live' || !fields.standardPortal || !fields.founderPortal ||
      !configuredDistinctValues(env, PRICE_KEYS) || !configuredDistinctValues(env, PRODUCT_KEYS)) {
    throw fail('Production provider target is incomplete');
  }
  return sha256(Buffer.from(JSON.stringify(fields)));
}

function keyFromEnv(value, type) {
  const bytes = Buffer.from(String(value || '').trim(), 'base64');
  if (!bytes.length) throw fail(`Provider attestation ${type} key is missing`);
  const key = type === 'public'
    ? crypto.createPublicKey({ key: bytes, format: 'der', type: 'spki' })
    : crypto.createPrivateKey({ key: bytes, format: 'der', type: 'pkcs8' });
  if (key.asymmetricKeyType !== 'ed25519') throw fail(`Provider attestation ${type} key must be Ed25519`);
  return key;
}

function publicKey(env = process.env) {
  return keyFromEnv(env.PDL_PROVIDER_ATTESTATION_PUBLIC_KEY, 'public');
}

function privateKey(env = process.env) {
  return keyFromEnv(env.PDL_PROVIDER_ATTESTATION_PRIVATE_KEY, 'private');
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join('|') !== [...keys].sort().join('|')) {
    throw fail(`${label} shape is invalid`);
  }
}

function assertGreenReport(report) {
  const prices = Array.isArray(report?.stripe?.prices) ? report.stripe.prices : [];
  const priceKeys = new Set(prices.map(price => price?.key));
  if (!report || !Array.isArray(report.failures) || report.failures.length) throw fail('Provider verification report is not green');
  if (report.stripe?.reachable !== true || report.stripe?.liveMode !== true || report.stripe?.webhook?.status !== 'ready' ||
      report.stripe?.portals?.standard?.status !== 'ready' || report.stripe?.portals?.founder?.status !== 'ready' ||
      prices.length !== PRICE_KEYS.length || PRICE_KEYS.some(key => !priceKeys.has(key)) || prices.some(price => price.ok !== true)) {
    throw fail('Stripe verification is incomplete');
  }
  if (report.resend?.delivery !== 'verified') throw fail('Email delivery verification is incomplete');
  if (report.monitoring?.delivery !== 'verified') throw fail('Monitoring delivery verification is incomplete');
}

function createAttestation(report, env = process.env, now = new Date()) {
  assertGreenReport(report);
  const generated = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(generated.valueOf())) throw fail('Provider verification time is invalid');
  return {
    schema: SCHEMA,
    generatedAt: generated.toISOString(),
    expiresAt: new Date(generated.valueOf() + DEFAULT_MAX_AGE_MS).toISOString(),
    targetSha256: targetDigest(env),
    checks: { stripe: 'verified', email: 'verified', monitoring: 'verified' }
  };
}

function validateAttestation(attestation, bytes, pointer, env = process.env, now = Date.now()) {
  exactKeys(pointer, ['schema', 'objectKey', 'attestationSha256', 'attestationSignature', 'publishedAt'], 'Provider readiness pointer');
  if (pointer.schema !== SCHEMA || !new RegExp(`^${ATTESTATION_PREFIX}[a-f0-9]{64}\\.json$`).test(pointer.objectKey)) throw fail('Provider readiness pointer is invalid');
  if (!/^[a-f0-9]{64}$/.test(pointer.attestationSha256) || pointer.objectKey !== `${ATTESTATION_PREFIX}${pointer.attestationSha256}.json`) throw fail('Provider readiness pointer digest is invalid');
  if (sha256(bytes) !== pointer.attestationSha256) throw fail('Provider readiness digest does not match');
  const signature = Buffer.from(String(pointer.attestationSignature || ''), 'base64');
  if (!signature.length || !crypto.verify(null, bytes, publicKey(env), signature)) throw fail('Provider readiness signature is invalid');
  exactKeys(attestation, ['schema', 'generatedAt', 'expiresAt', 'targetSha256', 'checks'], 'Provider readiness attestation');
  exactKeys(attestation.checks, ['stripe', 'email', 'monitoring'], 'Provider readiness checks');
  if (attestation.schema !== SCHEMA || attestation.targetSha256 !== targetDigest(env) || Object.values(attestation.checks).some(value => value !== 'verified')) {
    throw fail('Provider readiness target or checks do not match');
  }
  const generatedAt = Date.parse(strictIso(attestation.generatedAt, 'Provider verification time'));
  const expiresAt = Date.parse(strictIso(attestation.expiresAt, 'Provider verification expiry'));
  strictIso(pointer.publishedAt, 'Provider pointer publication time');
  const maximumAge = Number(env.PDL_PROVIDER_VERIFICATION_MAX_AGE_MS || DEFAULT_MAX_AGE_MS);
  if (!Number.isSafeInteger(maximumAge) || maximumAge < 60 * 60 * 1000 || maximumAge > 24 * 60 * 60 * 1000) throw fail('Provider verification maximum age is invalid');
  if (generatedAt > now + FUTURE_SKEW_MS || expiresAt <= generatedAt || expiresAt - generatedAt > maximumAge || now > expiresAt || now - generatedAt > maximumAge) {
    throw fail('Provider readiness evidence is stale', 'provider_readiness_stale');
  }
  return { ready: true, status: 'verified', verifiedAt: attestation.generatedAt, expiresAt: attestation.expiresAt,
    checks: { stripe: true, email: true, monitoring: true } };
}

async function responseBytes(response) {
  if (!response || response.ok === false) throw fail('Provider readiness evidence is unavailable', 'provider_readiness_unavailable');
  if (Buffer.isBuffer(response)) return response;
  if (typeof response.arrayBuffer === 'function') return Buffer.from(await response.arrayBuffer());
  return Buffer.from(String(response));
}

async function publicStatus({ env = process.env, download, now = Date.now() } = {}) {
  let timer;
  try {
    if (typeof download !== 'function') throw fail('Provider readiness storage is unavailable', 'provider_readiness_unavailable');
    const load = async key => {
      try { return await responseBytes(await download(BUCKET, key)); }
      catch { throw fail('Provider readiness evidence is unavailable', 'provider_readiness_unavailable'); }
    };
    const timeout = Number(env.PDL_PROVIDER_READINESS_TIMEOUT_MS || DEFAULT_READ_TIMEOUT_MS);
    if (!Number.isSafeInteger(timeout) || timeout < 50 || timeout > 5000) throw fail('Provider readiness timeout is invalid');
    return await Promise.race([
      (async () => {
        const pointerBytes = await load(POINTER_KEY);
        const pointer = JSON.parse(pointerBytes.toString('utf8'));
        exactKeys(pointer, ['schema', 'objectKey', 'attestationSha256', 'attestationSignature', 'publishedAt'], 'Provider readiness pointer');
        if (pointer.schema !== SCHEMA || !new RegExp(`^${ATTESTATION_PREFIX}[a-f0-9]{64}\\.json$`).test(pointer.objectKey)) throw fail('Provider readiness pointer is invalid');
        const bytes = await load(pointer.objectKey);
        const attestation = JSON.parse(bytes.toString('utf8'));
        return validateAttestation(attestation, bytes, pointer, env, now);
      })(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(fail('Provider readiness evidence timed out', 'provider_readiness_unavailable')), timeout); })
    ]);
  } catch (error) {
    const reason = ['provider_readiness_stale', 'provider_readiness_unavailable'].includes(error?.code) ? error.code : 'provider_readiness_invalid';
    return { ready: false, status: reason === 'provider_readiness_stale' ? 'stale' : 'unknown', reason,
      checks: { stripe: false, email: false, monitoring: false } };
  } finally { if (timer) clearTimeout(timer); }
}

function runtimeConfiguration(env = process.env, monitoringConfigured = false) {
  const validVersion = key => {
    try { versionMarker(env, key); return true; } catch { return false; }
  };
  const validEmail = value => {
    try { emailAddress(value, 'email'); return true; } catch { return false; }
  };
  const pricesConfigured = configuredDistinctValues(env, PRICE_KEYS);
  const productsConfigured = configuredDistinctValues(env, PRODUCT_KEYS);
  return {
    email: Boolean(String(env.RESEND_API_KEY || '').trim() && validEmail(env.RESEND_FROM) && validEmail(env.RESEND_REPLY_TO) &&
      validVersion('PDL_RESEND_RUNTIME_KEY_VERSION')),
    billing: Boolean(/^(?:sk|rk)_live_/.test(String(env.STRIPE_SECRET_KEY || '')) &&
      /^whsec_[A-Za-z0-9_-]+$/.test(String(env.STRIPE_WEBHOOK_SECRET || '')) &&
      String(env.STRIPE_PORTAL_CONFIG_STANDARD || '').trim() && String(env.STRIPE_PORTAL_CONFIG_FOUNDER || '').trim() &&
      pricesConfigured && productsConfigured && validVersion('PDL_STRIPE_RUNTIME_KEY_VERSION') &&
      validVersion('PDL_STRIPE_WEBHOOK_SECRET_VERSION')),
    monitoring: Boolean(monitoringConfigured && validVersion('PDL_SENTRY_RUNTIME_DSN_VERSION'))
  };
}

async function publish({ report, env = process.env, upload, download, now = new Date() } = {}) {
  if (env.RENDER || env.RENDER_SERVICE_ID || env.RENDER_INSTANCE_ID) throw fail('Provider readiness must be published by the independent monitor');
  if (typeof upload !== 'function' || typeof download !== 'function') throw fail('Provider readiness storage is unavailable');
  const attestation = createAttestation(report, env, now);
  const bytes = Buffer.from(JSON.stringify(attestation));
  const digest = sha256(bytes);
  const signer = privateKey(env), verifier = publicKey(env);
  const derived = crypto.createPublicKey(signer).export({ format: 'der', type: 'spki' });
  const expected = verifier.export({ format: 'der', type: 'spki' });
  if (!crypto.timingSafeEqual(derived, expected)) throw fail('Provider attestation keys do not match');
  const signature = crypto.sign(null, bytes, signer).toString('base64');
  const objectKey = `${ATTESTATION_PREFIX}${digest}.json`;
  try { await upload(BUCKET, objectKey, bytes, 'application/json', false); }
  catch (error) {
    const existing = await responseBytes(await download(BUCKET, objectKey)).catch(() => null);
    if (!existing || !existing.equals(bytes)) throw error;
  }
  const restored = await responseBytes(await download(BUCKET, objectKey));
  if (!restored.equals(bytes)) throw fail('Provider attestation storage verification failed');
  const pointer = { schema: SCHEMA, objectKey, attestationSha256: digest, attestationSignature: signature, publishedAt: new Date(now).toISOString() };
  const pointerBytes = Buffer.from(JSON.stringify(pointer));
  await upload(BUCKET, POINTER_KEY, pointerBytes, 'application/json', true);
  const restoredPointer = await responseBytes(await download(BUCKET, POINTER_KEY));
  if (!restoredPointer.equals(pointerBytes)) throw fail('Provider readiness pointer verification failed');
  validateAttestation(attestation, bytes, pointer, env, new Date(now).valueOf());
  return { published: true, verifiedAt: attestation.generatedAt, expiresAt: attestation.expiresAt, attestationSha256: digest };
}

module.exports = {
  ATTESTATION_PREFIX, BUCKET, DEFAULT_MAX_AGE_MS, DEFAULT_READ_TIMEOUT_MS, POINTER_KEY, PRICE_KEYS, PRODUCT_KEYS,
  RUNTIME_VERSION_KEYS, SCHEMA, createAttestation, publicStatus, publish, runtimeConfiguration, targetDigest, validateAttestation
};
