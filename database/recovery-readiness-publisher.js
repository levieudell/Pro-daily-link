'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const supabase = require('./supabase');
const { PlatformRepository } = require('./platform-repository');
const { opaqueTenantRef } = require('./shadow-reconciliation');
const {
  SCHEMA,
  POINTER_SCHEMA,
  EVIDENCE_BUCKET,
  POINTER_OBJECT_KEY,
  configuredProductionTarget,
  attestationPublicKey,
  populationSha256,
  validateAttestation,
  loadRemoteAttestation,
  compareAuthority
} = require('./recovery-readiness');

const SOURCE_SCHEMA = 'pdl-recovery-readiness-source/v1';
const CLI_SCHEMA = 'pdl-recovery-readiness-publisher/v1';
const CONFIRMATION = 'PUBLISH VERIFIED RECOVERY READINESS';
const SHA256 = /^[a-f0-9]{64}$/;
const PROJECT_REF = /^[a-z0-9]{20}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;

class RecoveryReadinessPublisherError extends Error {
  constructor(code) {
    super(code);
    this.name = 'RecoveryReadinessPublisherError';
    this.code = code;
  }
}

function fail(code) {
  throw new RecoveryReadinessPublisherError(code);
}

function digest(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function exactKeys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('SOURCE_INVALID');
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) fail('SOURCE_INVALID');
}

function option(argv, name) {
  if (argv.filter(value => value === name).length > 1) throw new Error(`${name} may only be provided once.`);
  const index = argv.indexOf(name);
  if (index < 0) return '';
  const value = String(argv[index + 1] || '').trim();
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value.`);
  return value;
}

function parseArgs(argv = process.argv.slice(2)) {
  const command = String(argv[0] || '').toLowerCase();
  if (!['validate', 'publish'].includes(command)) throw new Error('Choose one command: validate or publish.');
  const source = option(argv, '--source');
  const productionTarget = option(argv, '--production-target').toLowerCase();
  const expectedAttestationSha256 = option(argv, '--expected-attestation-sha256').toLowerCase();
  const confirmAction = option(argv, '--confirm-action');
  const apply = argv.includes('--apply');
  const valueFlags = new Set([
    '--source', '--production-target', '--expected-attestation-sha256', '--confirm-action'
  ]);
  for (let index = 1; index < argv.length; index += 1) {
    const token = String(argv[index]);
    if (valueFlags.has(token)) { index += 1; continue; }
    if (token !== '--apply') throw new Error(`Unsupported recovery-readiness publisher argument: ${token.startsWith('--') ? token : '(value)'}.`);
  }
  if (argv.filter(value => value === '--apply').length > 1) throw new Error('--apply may only be provided once.');
  if (!path.isAbsolute(source)) throw new Error('--source must be an absolute JSON path.');
  if (!PROJECT_REF.test(productionTarget)) throw new Error('--production-target must be an exact Supabase project reference.');
  if (command === 'validate' && (apply || expectedAttestationSha256 || confirmAction)) {
    throw new Error('validate does not accept publish confirmation arguments.');
  }
  if (command === 'publish') {
    if (!apply) throw new Error('publish requires --apply.');
    if (!SHA256.test(expectedAttestationSha256)) {
      throw new Error('publish requires --expected-attestation-sha256 from a successful validate run.');
    }
    if (confirmAction !== CONFIRMATION) {
      throw new Error(`publish requires --confirm-action "${CONFIRMATION}".`);
    }
  }
  return { command, source, productionTarget, expectedAttestationSha256, confirmAction, apply };
}

function readSource(file) {
  const absolute = path.resolve(file);
  let stat;
  try { stat = fs.lstatSync(absolute); } catch { fail('SOURCE_UNAVAILABLE'); }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > MAX_SOURCE_BYTES) fail('SOURCE_INVALID');
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(absolute, 'utf8')); } catch { fail('SOURCE_INVALID'); }
  return parsed;
}

function buildAttestation(source, targetSha256, now = Date.now()) {
  exactKeys(source, ['schema', 'attestedAt', 'tenants', 'platform']);
  if (source.schema !== SOURCE_SCHEMA || !Array.isArray(source.tenants)) fail('SOURCE_INVALID');
  const tenantRefs = new Set();
  const tenants = source.tenants.map(value => {
    exactKeys(value, [
      'databaseCompanyId', 'revision', 'contentHash', 'portable', 'independentCopy', 'restoreDrill'
    ]);
    const databaseCompanyId = String(value.databaseCompanyId || '').toLowerCase();
    if (!UUID.test(databaseCompanyId)) fail('SOURCE_INVALID');
    const tenantRef = opaqueTenantRef(databaseCompanyId);
    if (tenantRefs.has(tenantRef)) fail('SOURCE_INVALID');
    tenantRefs.add(tenantRef);
    return {
      tenantRef,
      revision: value.revision,
      contentHash: value.contentHash,
      portable: value.portable,
      independentCopy: value.independentCopy,
      restoreDrill: value.restoreDrill
    };
  }).sort((left, right) => left.tenantRef.localeCompare(right.tenantRef));
  const attestation = {
    schema: SCHEMA,
    attestedAt: source.attestedAt,
    productionTargetSha256: targetSha256,
    populationSha256: populationSha256(tenants.map(value => value.tenantRef)),
    tenants,
    platform: source.platform
  };
  try { return validateAttestation(attestation, { targetSha256, now }); } catch { fail('SOURCE_INVALID'); }
}

function privateSigningKey(env = process.env) {
  const encoded = String(env.PDL_RECOVERY_ATTESTATION_PRIVATE_KEY || '').trim();
  if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length > 4096) fail('SIGNING_KEY_INVALID');
  try {
    const key = crypto.createPrivateKey({ key: Buffer.from(encoded, 'base64'), format: 'der', type: 'pkcs8' });
    if (key.asymmetricKeyType !== 'ed25519') fail('SIGNING_KEY_INVALID');
    return key;
  } catch (error) {
    if (error instanceof RecoveryReadinessPublisherError) throw error;
    fail('SIGNING_KEY_INVALID');
  }
}

function matchingPublicKey(privateKey, env = process.env) {
  let configured;
  try { configured = attestationPublicKey(env); } catch { fail('PUBLIC_KEY_INVALID'); }
  const derived = crypto.createPublicKey(privateKey);
  const configuredBytes = configured.export({ format: 'der', type: 'spki' });
  const derivedBytes = derived.export({ format: 'der', type: 'spki' });
  if (configuredBytes.length !== derivedBytes.length || !crypto.timingSafeEqual(configuredBytes, derivedBytes)) {
    fail('SIGNING_KEY_MISMATCH');
  }
  return configured;
}

async function downloadBytes(download, bucket, objectKey, maximum = MAX_SOURCE_BYTES) {
  let response;
  try { response = await download(bucket, objectKey); } catch { fail('REMOTE_VERIFICATION_FAILED'); }
  if (!response || typeof response.arrayBuffer !== 'function') fail('REMOTE_VERIFICATION_FAILED');
  let bytes;
  try { bytes = Buffer.from(await response.arrayBuffer()); } catch { fail('REMOTE_VERIFICATION_FAILED'); }
  if (bytes.length < 1 || bytes.length > maximum) fail('REMOTE_VERIFICATION_FAILED');
  return bytes;
}

async function putImmutable({ upload, download, objectKey, bytes }) {
  let uploadFailed = false;
  try {
    await upload(EVIDENCE_BUCKET, objectKey, bytes, 'application/json', false);
  } catch {
    // A timeout or conflict can mean the immutable object already exists. Only
    // exact bytes recovered from the provider can turn that ambiguity into a
    // verified, idempotent success.
    uploadFailed = true;
  }
  const remote = await downloadBytes(download, EVIDENCE_BUCKET, objectKey);
  if (remote.length !== bytes.length || !crypto.timingSafeEqual(remote, bytes)) {
    fail(uploadFailed ? 'IMMUTABLE_UPLOAD_OUTCOME_UNKNOWN' : 'IMMUTABLE_UPLOAD_MISMATCH');
  }
}

async function updatePointer({ upload, download, bytes }) {
  try {
    await upload(EVIDENCE_BUCKET, POINTER_OBJECT_KEY, bytes, 'application/json', true);
  } catch {
    // Resolve ambiguous provider outcomes by reading the well-known pointer.
  }
  const remote = await downloadBytes(download, EVIDENCE_BUCKET, POINTER_OBJECT_KEY, 4096);
  if (remote.length !== bytes.length || !crypto.timingSafeEqual(remote, bytes)) fail('POINTER_UPDATE_OUTCOME_UNKNOWN');
}

function defaultPlatformAuthority() {
  return new PlatformRepository({ request: supabase.request }).load();
}

async function execute(args, env = process.env, dependencies = {}) {
  if (!args || !['validate', 'publish'].includes(args.command)) fail('INVALID_ARGUMENT');
  if (args.command === 'publish' && (args.apply !== true || args.confirmAction !== CONFIRMATION ||
      !SHA256.test(String(args.expectedAttestationSha256 || '')))) {
    fail('PUBLISH_CONFIRMATION_REQUIRED');
  }
  // Bind to the independently configured production project before reading
  // either provider authority or writing any Storage object.
  const target = configuredProductionTarget(env);
  if (target.projectRef !== args.productionTarget) fail('PRODUCTION_TARGET_MISMATCH');
  if (env.PDL_TRANSACTIONAL_DB !== 'primary' || env.PDL_PLATFORM_TRANSACTIONAL_DB !== 'primary') {
    fail('REPOSITORIES_NOT_PRIMARY');
  }
  let privateKey = null;
  let publicKey = null;
  if (args.command === 'publish') {
    if (env.RENDER === 'true' || env.RENDER_SERVICE_ID || env.RENDER_INSTANCE_ID) fail('INDEPENDENT_RUNTIME_REQUIRED');
    // Key/config mistakes fail before any provider authority read. The private
    // key is held only in memory and is never serialized or returned.
    privateKey = privateSigningKey(env);
    publicKey = matchingPublicKey(privateKey, env);
  }
  const now = dependencies.now ? dependencies.now() : Date.now();
  const source = (dependencies.readSource || readSource)(args.source);
  const attestation = buildAttestation(source, target.sha256, now);
  const attestationBytes = Buffer.from(JSON.stringify(attestation));
  const attestationSha256 = digest(attestationBytes);
  if (args.command === 'publish' && attestationSha256 !== args.expectedAttestationSha256) {
    fail('ATTESTATION_DIGEST_MISMATCH');
  }
  const loadTenantAuthorities = dependencies.loadTenantAuthorities || (() => supabase.listTransactionalSnapshots());
  const loadPlatformAuthority = dependencies.loadPlatformAuthority || defaultPlatformAuthority;
  const firstAuthorities = await Promise.all([loadTenantAuthorities(), loadPlatformAuthority()]);
  const compared = compareAuthority(attestation, firstAuthorities[0], firstAuthorities[1]);
  if (args.command === 'validate') {
    return {
      schema: CLI_SCHEMA,
      command: 'validate',
      status: 'verified',
      writesPerformed: false,
      tenantCount: compared.tenantCount,
      attestedAt: attestation.attestedAt,
      attestationSha256
    };
  }
  const signature = crypto.sign(null, attestationBytes, privateKey);
  if (signature.length !== 64 || !crypto.verify(null, attestationBytes, publicKey, signature)) fail('SIGNATURE_FAILED');
  const objectKey = `recovery-readiness/attestations/${attestationSha256}.json`;
  const upload = dependencies.upload || supabase.upload;
  const download = dependencies.download || supabase.download;
  if (typeof upload !== 'function' || typeof download !== 'function') fail('PROVIDER_UNAVAILABLE');
  await putImmutable({ upload, download, objectKey, bytes: attestationBytes });
  const updatedAt = new Date(Math.max(now, Date.parse(attestation.attestedAt))).toISOString();
  const pointer = {
    schema: POINTER_SCHEMA,
    attestationObjectKey: objectKey,
    attestationSha256,
    attestationSignature: signature.toString('base64'),
    updatedAt
  };
  const pointerBytes = Buffer.from(JSON.stringify(pointer));
  await updatePointer({ upload, download, bytes: pointerBytes });
  const remoteAttestation = await loadRemoteAttestation(download, {
    now,
    targetSha256: target.sha256,
    publicKey
  });
  // Prove that nothing changed between the pre-write authority check and the
  // externally visible pointer. A mismatch leaves health fail-closed and this
  // command inconclusive rather than reporting a false success.
  const finalAuthorities = await Promise.all([loadTenantAuthorities(), loadPlatformAuthority()]);
  const finalCompared = compareAuthority(remoteAttestation, finalAuthorities[0], finalAuthorities[1]);
  return {
    schema: CLI_SCHEMA,
    command: 'publish',
    status: 'verified',
    writesPerformed: true,
    tenantCount: finalCompared.tenantCount,
    attestedAt: remoteAttestation.attestedAt,
    attestationSha256,
    pointerVerified: true,
    immutableObjectVerified: true
  };
}

function sanitizedFailure(error) {
  const code = error?.code && /^[A-Z0-9_]+$/.test(error.code)
    ? error.code
    : /argument|requires|choose one command|does not accept|may only be provided/i.test(String(error?.message || ''))
      ? 'INVALID_ARGUMENT'
      : 'PUBLISHER_FAILED';
  return {
    schema: CLI_SCHEMA,
    status: 'inconclusive',
    writesPerformed: null,
    reason: code
  };
}

async function main(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);
  const result = await execute(args, env);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

if (require.main === module) {
  supabase.loadLocalEnv(path.resolve(__dirname, '..'));
  main().catch(error => {
    process.stderr.write(`${JSON.stringify(sanitizedFailure(error))}\n`);
    process.exitCode = 2;
  });
}

module.exports = {
  SOURCE_SCHEMA,
  CLI_SCHEMA,
  CONFIRMATION,
  RecoveryReadinessPublisherError,
  parseArgs,
  readSource,
  buildAttestation,
  privateSigningKey,
  matchingPublicKey,
  execute,
  sanitizedFailure
};
