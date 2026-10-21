'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const maintenanceFence = require('./maintenance-fence');
const supabase = require('./supabase');
const { verifyAttachedRuntime } = require('./reconcile-shadow');
const { releaseSha, validateRuntime, writeEvidenceExclusive } = require('./shadow-reconciliation');

const SCHEMA = 'pdl-legacy-normalized-artifact-quarantine/v1';
const STATE_SCHEMA = 'pdl-legacy-normalized-artifact-state/v1';
const QUARANTINE_SCHEMA = 'pdl-legacy-normalized-artifact-quarantine/v1';
const TARGET_COMPANY_ID = '86479331-4c63-5cc3-8633-a8d7fd5751b3';
const SURVIVING_COMPANY_ID = 'd3abe4a7-d659-5d07-bc8d-55625616d375';
const CONFIRMATION = 'QUARANTINE EXACT LEGACY NORMALIZED ARTIFACT';
const SHA256 = /^[a-f0-9]{64}$/;
const SUPABASE_PROJECT_REF = /^[a-z0-9]{20}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_PREVIEW_BYTES = 128 * 1024;

class ArtifactQuarantineError extends Error {
  constructor(code, details = null) {
    super(code);
    this.name = 'ArtifactQuarantineError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, details = null) {
  throw new ArtifactQuarantineError(code, details);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function opaqueCompanyRef(companyId) {
  return sha256(`pdl-artifact-ref:v1:${companyId}`);
}

function throwIfAborted(signal) {
  if (signal?.aborted) fail('INTERRUPTED');
}

function option(argv, name) {
  if (argv.filter(value => value === name).length > 1) throw new Error(`${name} may only be provided once.`);
  const index = argv.indexOf(name);
  if (index < 0) return '';
  const value = String(argv[index + 1] || '').trim();
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value.`);
  return value;
}

function canonicalTimestamp(value, label) {
  const parsed = Date.parse(String(value || ''));
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error(`${label} must be an exact UTC ISO timestamp with milliseconds.`);
  }
  return value;
}

function boundedInteger(value, label, minimum, maximum) {
  if (!/^\d+$/.test(String(value || ''))) throw new Error(`${label} must be an integer.`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}.`);
  }
  return number;
}

function parseArgs(argv = process.argv.slice(2)) {
  const apply = argv.includes('--apply');
  const evidence = option(argv, '--evidence');
  const productionTarget = option(argv, '--production-target').toLowerCase();
  const expectedServiceId = option(argv, '--expected-service-id');
  const expectedInstanceId = option(argv, '--expected-instance-id');
  const targetCompanyId = option(argv, '--target-company-id').toLowerCase();
  const survivingCompanyId = option(argv, '--surviving-company-id').toLowerCase();
  const archiveAt = canonicalTimestamp(option(argv, '--archive-at'), '--archive-at');
  const previewEvidence = option(argv, '--preview-evidence');
  const previewSha256 = option(argv, '--preview-sha256').toLowerCase();
  const confirmPreviewSha256 = option(argv, '--confirm-preview-sha256').toLowerCase();
  const confirmTargetCompanyId = option(argv, '--confirm-target-company-id').toLowerCase();
  const confirmPreimageSha256 = option(argv, '--confirm-preimage-sha256').toLowerCase();
  const confirmPreservedRowsSha256 = option(argv, '--confirm-preserved-rows-sha256').toLowerCase();
  const confirmArchiveDataSha256 = option(argv, '--confirm-archive-data-sha256').toLowerCase();
  const confirmAction = option(argv, '--confirm-action');
  const timeoutRaw = option(argv, '--request-timeout-ms');
  const valueFlags = new Set([
    '--evidence', '--production-target', '--expected-service-id', '--expected-instance-id',
    '--target-company-id', '--surviving-company-id', '--archive-at', '--preview-evidence',
    '--preview-sha256', '--confirm-preview-sha256', '--confirm-target-company-id',
    '--confirm-preimage-sha256', '--confirm-preserved-rows-sha256',
    '--confirm-archive-data-sha256', '--confirm-action', '--request-timeout-ms'
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index]);
    if (valueFlags.has(token)) { index += 1; continue; }
    if (token !== '--apply') throw new Error(`Unsupported artifact-quarantine argument: ${token.startsWith('--') ? token : '(value)'}.`);
  }
  if (argv.filter(value => value === '--apply').length > 1) throw new Error('--apply may only be provided once.');
  if (!path.isAbsolute(evidence)) throw new Error('--evidence must be an absolute, unused JSON path.');
  if (!SUPABASE_PROJECT_REF.test(productionTarget)) throw new Error('--production-target must be an exact Supabase project reference.');
  if (!/^srv-[a-z0-9]{20,64}$/.test(expectedServiceId)) throw new Error('--expected-service-id must be an exact Render service ID.');
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/.test(expectedInstanceId)) throw new Error('--expected-instance-id must be an exact Render instance ID.');
  if (!UUID.test(targetCompanyId) || targetCompanyId !== TARGET_COMPANY_ID) throw new Error('--target-company-id is not the one guarded artifact UUID.');
  if (!UUID.test(survivingCompanyId) || survivingCompanyId !== SURVIVING_COMPANY_ID) throw new Error('--surviving-company-id is not the verified surviving tenant UUID.');
  if (apply) {
    if (!path.isAbsolute(previewEvidence)) throw new Error('--apply requires an absolute --preview-evidence path.');
    if (!SHA256.test(previewSha256) || confirmPreviewSha256 !== previewSha256) {
      throw new Error('--apply requires matching --preview-sha256 and --confirm-preview-sha256 digests.');
    }
    if (confirmTargetCompanyId !== TARGET_COMPANY_ID) throw new Error('--apply requires exact --confirm-target-company-id.');
    if (![confirmPreimageSha256, confirmPreservedRowsSha256, confirmArchiveDataSha256].every(value => SHA256.test(value))) {
      throw new Error('--apply requires all three exact confirmation digests from preview evidence.');
    }
    if (confirmAction !== CONFIRMATION) throw new Error(`--apply requires --confirm-action "${CONFIRMATION}".`);
  } else if (previewEvidence || previewSha256 || confirmPreviewSha256 || confirmTargetCompanyId ||
             confirmPreimageSha256 || confirmPreservedRowsSha256 || confirmArchiveDataSha256 || confirmAction) {
    throw new Error('Apply-only confirmation arguments cannot be used during preview.');
  }
  return {
    apply,
    evidence,
    productionTarget,
    expectedServiceId,
    expectedInstanceId,
    targetCompanyId,
    survivingCompanyId,
    archiveAt,
    previewEvidence,
    previewSha256,
    confirmPreviewSha256,
    confirmTargetCompanyId,
    confirmPreimageSha256,
    confirmPreservedRowsSha256,
    confirmArchiveDataSha256,
    confirmAction,
    requestTimeoutMs: timeoutRaw ? boundedInteger(timeoutRaw, '--request-timeout-ms', 250, 60_000) : 10_000
  };
}

function configuredSupabaseProjectRef(env = process.env) {
  let url;
  try { url = new URL(String(env.SUPABASE_URL || '')); } catch { fail('TARGET_CONFIGURATION_INVALID'); }
  const match = /^([a-z0-9]{20})\.supabase\.co$/.exec(url.hostname.toLowerCase());
  if (url.protocol !== 'https:' || !match || url.username || url.password || url.port ||
      (url.pathname && url.pathname !== '/') || url.search || url.hash) fail('TARGET_CONFIGURATION_INVALID');
  return match[1];
}

function validateQuarantineRuntime(args, env = process.env) {
  const runtime = validateRuntime({
    scope: 'tenant',
    env,
    expectedServiceId: args.expectedServiceId,
    expectedInstanceId: args.expectedInstanceId
  });
  const actual = configuredSupabaseProjectRef(env);
  const configuredProduction = String(env.PDL_PRODUCTION_SUPABASE_PROJECT_REF || '').trim().toLowerCase();
  if (runtime.provider !== 'render' || env.NODE_ENV !== 'production' ||
      !SUPABASE_PROJECT_REF.test(configuredProduction) || configuredProduction !== args.productionTarget ||
      actual !== args.productionTarget) fail('PRODUCTION_TARGET_MISMATCH');
  return {
    ...runtime,
    projectRefSha256: sha256(`pdl-artifact-target:v1:${actual}`)
  };
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  return value;
}

function sameValue(left, right) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function sameFence(left, right) {
  return Boolean(left && right && left.digest === right.digest && left.openedAt === right.openedAt &&
    left.mode === right.mode && left.source === right.source && sameValue(left.identity, right.identity));
}

function requireSameFence(api, env, options, expected) {
  const current = api.requireVerifiedFence(env, options);
  if (!sameFence(current, expected)) fail('MAINTENANCE_FENCE_CHANGED');
  return current;
}

function validInteger(value) {
  return Number.isSafeInteger(Number(value)) && Number(value) >= 0;
}

function validateState(state, { classification = 'malformed-empty', requireReady = true } = {}) {
  if (!state || Array.isArray(state) || state.schema !== STATE_SCHEMA ||
      state.targetRef !== opaqueCompanyRef(TARGET_COMPANY_ID) ||
      state.survivingTenantRef !== opaqueCompanyRef(SURVIVING_COMPANY_ID) ||
      state.classification !== classification ||
      ![state.preimageSha256, state.preservedRowsSha256, state.survivorSnapshotSha256, state.archiveDataSha256].every(value => SHA256.test(String(value || '')))) {
    fail('PROVIDER_PAYLOAD_INVALID');
  }
  const countKeys = ['memberships', 'publicUsers', 'customers', 'projects', 'teamMembers', 'reports', 'assignments',
    'unexpectedScoped', 'privateOrTransactional', 'storageObjects', 'crossTenantReferences', 'externalSnapshotReferences'];
  const identityKeys = ['activePublicUsers', 'passwordHashesPresent', 'authUsers', 'otherMemberships', 'ownerSnapshotMatches'];
  const coverageKeys = ['customers', 'projects', 'teamMembers', 'reports', 'assignments'];
  const survivorKeys = ['users', 'customers', 'projects', 'teamMembers', 'reports', 'assignments'];
  if (!countKeys.every(key => validInteger(state.counts?.[key])) ||
      !identityKeys.every(key => validInteger(state.identity?.[key])) ||
      typeof state.identity?.companyFieldsMatch !== 'boolean' ||
      !coverageKeys.every(key => validInteger(state.coverage?.[key])) ||
      !survivorKeys.every(key => validInteger(state.survivorCounts?.[key]))) fail('PROVIDER_PAYLOAD_INVALID');
  if (requireReady && state.readyForQuarantine !== true) fail('ARTIFACT_NOT_SAFE_TO_QUARANTINE');
  if (!requireReady && state.archiveSnapshotExact !== true) fail('ARCHIVE_CLASSIFICATION_NOT_PROVEN');
  return state;
}

function publicState(state) {
  return {
    targetRef: state.targetRef,
    survivingTenantRef: state.survivingTenantRef,
    classification: state.classification,
    readyForQuarantine: state.readyForQuarantine === true,
    archiveSnapshotExact: state.archiveSnapshotExact === true,
    preimageSha256: state.preimageSha256,
    preservedRowsSha256: state.preservedRowsSha256,
    survivorSnapshotSha256: state.survivorSnapshotSha256,
    archiveDataSha256: state.archiveDataSha256,
    counts: canonical(state.counts),
    identity: canonical(state.identity),
    coverage: canonical(state.coverage),
    survivorCounts: canonical(state.survivorCounts)
  };
}

function assertNoRawIdentity(value) {
  const serialized = JSON.stringify(value);
  if (serialized.includes(TARGET_COMPANY_ID) || serialized.includes(SURVIVING_COMPANY_ID) ||
      /SUPABASE_SECRET_KEY|Bearer\s|apikey/i.test(serialized)) fail('EVIDENCE_CONTAINS_RAW_IDENTITY');
}

async function timeoutRequest(request, relativePath, options, timeoutMs, signal) {
  throwIfAborted(signal);
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener?.('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await request(relativePath, { ...options, signal: controller.signal });
  } catch (error) {
    if (signal?.aborted) fail('INTERRUPTED');
    if (controller.signal.aborted) fail('PROVIDER_TIMEOUT');
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', abort);
  }
}

async function rpc(request, name, body, timeoutMs, signal) {
  const response = await timeoutRequest(request, `/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }, timeoutMs, signal);
  if (!response || typeof response.json !== 'function') fail('PROVIDER_PAYLOAD_INVALID');
  if (response.ok === false) {
    const error = new ArtifactQuarantineError('PROVIDER_HTTP_ERROR');
    error.statusCode = Number(response.status) || 0;
    throw error;
  }
  const payload = await response.json();
  return Array.isArray(payload) ? (payload.length === 1 ? payload[0] : fail('PROVIDER_PAYLOAD_INVALID')) : payload;
}

async function readState(request, archiveAt, timeoutMs, signal) {
  return rpc(request, 'inspect_legacy_normalized_artifact', { p_archived_at: archiveAt }, timeoutMs, signal);
}

async function readStateTwice(request, archiveAt, timeoutMs, signal, expected) {
  const first = await readState(request, archiveAt, timeoutMs, signal);
  const second = await readState(request, archiveAt, timeoutMs, signal);
  validateState(first, expected);
  validateState(second, expected);
  if (!sameValue(publicState(first), publicState(second))) fail('UNSTABLE_ARTIFACT_READ');
  return second;
}

function ambiguousWrite(error) {
  const status = Number(error?.statusCode);
  return error?.code === 'PROVIDER_TIMEOUT' || error instanceof TypeError ||
    status === 408 || status === 425 || status === 429 || status >= 500 ||
    /\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|fetch failed|network error)\b/i.test(String(error?.message || ''));
}

function loadPreviewEvidence(args) {
  const stat = fs.lstatSync(args.previewEvidence);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > MAX_PREVIEW_BYTES) fail('PREVIEW_EVIDENCE_INVALID');
  const bytes = fs.readFileSync(args.previewEvidence);
  const digest = sha256(bytes);
  const sidecarPath = `${args.previewEvidence}.sha256`;
  const sidecarStat = fs.lstatSync(sidecarPath);
  if (!sidecarStat.isFile() || sidecarStat.isSymbolicLink() || sidecarStat.size !== 65 ||
      fs.readFileSync(sidecarPath, 'utf8') !== `${digest}\n` || digest !== args.previewSha256) fail('PREVIEW_EVIDENCE_INVALID');
  let value;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { fail('PREVIEW_EVIDENCE_INVALID'); }
  assertNoRawIdentity(value);
  if (value.schema !== SCHEMA || value.operation !== 'preview' || value.status !== 'ready' ||
      value.writesPerformed !== false || value.archiveAt !== args.archiveAt ||
      value.target?.projectRefSha256 !== sha256(`pdl-artifact-target:v1:${args.productionTarget}`) ||
      value.target?.serviceId !== args.expectedServiceId || value.target?.instanceId !== args.expectedInstanceId ||
      !SHA256.test(String(value.maintenanceFence?.digest || '')) ||
      !Number.isFinite(Date.parse(String(value.maintenanceFence?.openedAt || ''))) ||
      value.maintenanceFence?.mode !== 'read_only' ||
      value.preimage?.companyDataCanonical !== '{}' ||
      value.preimage?.companyDataSha256 !== sha256('{}') || value.preimage?.capturedTwice !== true) {
    fail('PREVIEW_EVIDENCE_MISMATCH');
  }
  validateState({ schema: STATE_SCHEMA, ...value.artifact }, { classification: 'malformed-empty', requireReady: true });
  if (value.artifact.preimageSha256 !== args.confirmPreimageSha256 ||
      value.artifact.preservedRowsSha256 !== args.confirmPreservedRowsSha256 ||
      value.artifact.archiveDataSha256 !== args.confirmArchiveDataSha256) fail('PREVIEW_DIGEST_CONFIRMATION_MISMATCH');
  return { value, sha256: digest };
}

function evidenceBase({ args, runtime, release, fence = null }) {
  return {
    schema: SCHEMA,
    operation: args.apply ? 'apply' : 'preview',
    archiveAt: args.archiveAt,
    releaseSha: release,
    target: {
      mode: 'production',
      projectRefSha256: runtime.projectRefSha256,
      serviceId: runtime.serviceId,
      instanceId: runtime.instanceId
    },
    maintenanceFence: fence ? {
      digest: fence.digest,
      openedAt: fence.openedAt,
      mode: fence.mode,
      source: fence.source
    } : null
  };
}

function assertMatchesPreview(state, preview) {
  if (!sameValue(publicState(state), preview.artifact)) fail('ARTIFACT_CHANGED_SINCE_PREVIEW');
}

function normalizeMutation(payload, expected) {
  if (!payload || Array.isArray(payload) || payload.status !== 'quarantined' ||
      payload.classification !== 'archived-quarantine' ||
      payload.targetRef !== opaqueCompanyRef(TARGET_COMPANY_ID) ||
      payload.survivingTenantRef !== opaqueCompanyRef(SURVIVING_COMPANY_ID) ||
      payload.preservedRowsSha256 !== expected.preservedRowsSha256 ||
      payload.archiveDataSha256 !== expected.archiveDataSha256) fail('PROVIDER_PAYLOAD_INVALID');
  return payload;
}

async function execute(args, env = process.env, dependencies = {}) {
  const signal = dependencies.signal || null;
  throwIfAborted(signal);
  if (env !== process.env && !dependencies.request) fail('REQUEST_ENV_MISMATCH');
  if (fs.existsSync(args.evidence) || fs.existsSync(`${args.evidence}.sha256`)) fail('EVIDENCE_PATH_EXISTS');
  const runtime = validateQuarantineRuntime(args, env);
  const release = releaseSha(env);
  runtime.attachedLiveness = await (dependencies.verifyAttachedRuntime || verifyAttachedRuntime)(env, {
    fetchImpl: dependencies.fetch,
    signal
  });
  const request = dependencies.request || supabase.request;
  const fenceApi = dependencies.maintenanceFence || maintenanceFence;
  const fenceOptions = {
    root: path.resolve(__dirname, '..'),
    expectedServiceId: args.expectedServiceId,
    expectedInstanceId: args.expectedInstanceId
  };
  let fence = null;
  let mutationDispatched = false;
  const startedAt = new Date().toISOString();
  let base = evidenceBase({ args, runtime, release });
  try {
    fence = fenceApi.requireVerifiedFence(env, fenceOptions);
    base = evidenceBase({ args, runtime, release, fence });
    const checkFence = () => Promise.resolve(requireSameFence(fenceApi, env, fenceOptions, fence));
    if (!args.apply) {
      await checkFence();
      const before = await readStateTwice(request, args.archiveAt, args.requestTimeoutMs, signal, {
        classification: 'malformed-empty', requireReady: true
      });
      await checkFence();
      const result = {
        ...base,
        status: 'ready',
        writesPerformed: false,
        startedAt,
        completedAt: new Date().toISOString(),
        preimage: {
          companyDataCanonical: '{}',
          companyDataSha256: sha256('{}'),
          capturedTwice: true,
          fullPreservedStateBoundBySha256: true
        },
        artifact: publicState(before),
        nextStep: 'Review this immutable evidence and supply its exact digest, target confirmation, three state digests, and confirmation phrase to apply under a verified maintenance fence.'
      };
      assertNoRawIdentity(result);
      const digest = writeEvidenceExclusive(args.evidence, result);
      return { ...result, evidence: { written: true, sha256: digest } };
    }

    const preview = loadPreviewEvidence(args);
    if (preview.value.releaseSha !== release) fail('PREVIEW_RELEASE_MISMATCH');
    if (!sameValue(preview.value.maintenanceFence, base.maintenanceFence)) fail('PREVIEW_FENCE_MISMATCH');
    await checkFence();
    const before = await readStateTwice(request, args.archiveAt, args.requestTimeoutMs, signal, {
      classification: 'malformed-empty', requireReady: true
    });
    assertMatchesPreview(before, preview.value);
    await checkFence();

    let outcomeRecoveredAfterError = false;
    try {
      mutationDispatched = true;
      const response = await rpc(request, 'quarantine_legacy_normalized_artifact', {
        p_archived_at: args.archiveAt,
        p_expected_preimage_sha256: args.confirmPreimageSha256,
        p_expected_preserved_rows_sha256: args.confirmPreservedRowsSha256,
        p_expected_archive_data_sha256: args.confirmArchiveDataSha256,
        p_confirmation: args.confirmAction
      }, args.requestTimeoutMs, signal);
      normalizeMutation(response, preview.value.artifact);
    } catch (error) {
      if (!ambiguousWrite(error)) throw error;
      await checkFence();
      try {
        const recovered = await readStateTwice(request, args.archiveAt, args.requestTimeoutMs, signal, {
          classification: 'archived-quarantine', requireReady: false
        });
        if (recovered.preservedRowsSha256 !== args.confirmPreservedRowsSha256 ||
            recovered.archiveDataSha256 !== args.confirmArchiveDataSha256) fail('POSTWRITE_STATE_MISMATCH');
        outcomeRecoveredAfterError = true;
      } catch (verificationError) {
        const unknown = new ArtifactQuarantineError('WRITE_OUTCOME_UNKNOWN');
        unknown.cause = error;
        unknown.verification = verificationError?.code || 'POSTWRITE_READ_FAILED';
        throw unknown;
      }
    }

    await checkFence();
    const after = await readStateTwice(request, args.archiveAt, args.requestTimeoutMs, signal, {
      classification: 'archived-quarantine', requireReady: false
    });
    if (after.preservedRowsSha256 !== before.preservedRowsSha256 ||
        after.preservedRowsSha256 !== args.confirmPreservedRowsSha256 ||
        after.archiveDataSha256 !== args.confirmArchiveDataSha256) fail('POSTWRITE_STATE_MISMATCH');
    await checkFence();
    const result = {
      ...base,
      status: 'verified',
      writesPerformed: true,
      startedAt,
      completedAt: new Date().toISOString(),
      previewEvidenceSha256: preview.sha256,
      before: publicState(before),
      after: publicState(after),
      outcomeRecoveredAfterError,
      verification: 'exact-preview-match,sql-compare-and-swap,preserved-state-digest,and-two-independent-post-write-reads',
      retainedData: 'all users, memberships, child rows, storage metadata, and transactional/private rows remain untouched'
    };
    assertNoRawIdentity(result);
    const digest = writeEvidenceExclusive(args.evidence, result);
    return { ...result, evidence: { written: true, sha256: digest } };
  } catch (error) {
    if (args.apply && !fs.existsSync(args.evidence) && !fs.existsSync(`${args.evidence}.sha256`)) {
      const failure = {
        ...base,
        status: 'inconclusive',
        writesPerformed: mutationDispatched ? null : false,
        writeOutcome: mutationDispatched ? 'outcome-unproven' : 'no-mutation-dispatched',
        startedAt,
        completedAt: new Date().toISOString(),
        reason: error?.code && /^[A-Z0-9_]+$/.test(error.code) ? error.code : 'ARTIFACT_QUARANTINE_FAILED',
        nextStep: 'Keep production writes fenced. Do not retry apply. Re-run the read-only inspection and reconcile this evidence first.'
      };
      try {
        assertNoRawIdentity(failure);
        error.evidenceSha256 = writeEvidenceExclusive(args.evidence, failure);
      } catch {}
    }
    throw error;
  }
}

function sanitizedResult(result) {
  return {
    ok: true,
    schema: result.schema,
    operation: result.operation,
    status: result.status,
    writesPerformed: result.writesPerformed,
    classification: result.artifact?.classification || result.after?.classification || null,
    evidenceSha256: result.evidence.sha256
  };
}

function sanitizedFailure(error) {
  const code = error?.code && /^[A-Z0-9_]+$/.test(error.code) ? error.code :
    /argument|requires|provided|unsupported|absolute|exact|matching/i.test(String(error?.message || ''))
      ? 'INVALID_ARGUMENT' : 'ARTIFACT_QUARANTINE_FAILED';
  return {
    ok: false,
    schema: SCHEMA,
    status: 'inconclusive',
    reason: code,
    writesPerformed: null,
    evidenceSha256: SHA256.test(String(error?.evidenceSha256 || '')) ? error.evidenceSha256 : null,
    message: code === 'INVALID_ARGUMENT'
      ? 'The guarded artifact-quarantine arguments are invalid. Review the runbook; no write was performed.'
      : code === 'WRITE_OUTCOME_UNKNOWN'
        ? 'The write outcome is unknown. Keep maintenance mode active and reconcile the immutable evidence before any retry.'
        : 'The artifact quarantine did not complete. Keep maintenance mode active and review the immutable evidence.'
  };
}

module.exports = {
  SCHEMA,
  STATE_SCHEMA,
  TARGET_COMPANY_ID,
  SURVIVING_COMPANY_ID,
  CONFIRMATION,
  ArtifactQuarantineError,
  opaqueCompanyRef,
  parseArgs,
  configuredSupabaseProjectRef,
  validateQuarantineRuntime,
  validateState,
  publicState,
  loadPreviewEvidence,
  execute,
  sanitizedResult,
  sanitizedFailure
};
