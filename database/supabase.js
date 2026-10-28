const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MANAGED_PRIVATE_BUCKETS = Object.freeze({
  'company-logos': [6_000_000, ['image/jpeg', 'image/png', 'image/webp']],
  'project-photos': [6_000_000, ['image/jpeg', 'image/png', 'image/webp']],
  'estimate-documents': [15_000_000, ['application/pdf']],
  'project-tickets': [10_000_000, ['application/pdf', 'image/jpeg', 'image/png', 'image/webp']],
  'tenant-backups': [25_000_000, ['application/json']]
});

function loadLocalEnv(root) {
  const file = path.join(root, '.env.local');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const index = line.indexOf('=');
    if (index < 1) continue;
    const key = line.slice(0, index);
    if (!(key in process.env)) process.env[key] = line.slice(index + 1);
  }
}

function configured() {
  return process.env.PDL_SUPABASE_ENABLED === '1' && Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SECRET_KEY);
}

function headers(extra = {}) {
  if (!configured()) throw new Error('Supabase is not configured');
  return {
    apikey: process.env.SUPABASE_SECRET_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
    ...extra
  };
}

async function request(relativePath, options = {}) {
  const response = await fetch(`${process.env.SUPABASE_URL}${relativePath}`, {
    ...options,
    signal: options.signal || AbortSignal.timeout(15000),
    headers: headers(options.headers)
  });
  if (!response.ok) {
    const responseText = (await response.text()).slice(0, 300);
    let responseBody = null;
    try { responseBody = JSON.parse(responseText); } catch {}
    const error = new Error(`Supabase request failed (${response.status}): ${responseText}`);
    error.statusCode = response.status;
    if (typeof responseBody?.code === 'string' && responseBody.code.length <= 32) error.code = responseBody.code;
    throw error;
  }
  return response;
}

function normalizeTenantRevisionConflict(error, expectedRevision) {
  const message = String(error?.message || error || '');
  const code = String(error?.code || '');
  const knownConflictCode = code === 'PT409' || code === '40001' || code === 'PDL_REVISION_CONFLICT';
  if (!/PDL_REVISION_CONFLICT/i.test(message) || (!knownConflictCode && Number(error?.statusCode) !== 409)) return error;
  const actualMatch = /actual=(\d+)/i.exec(message);
  const { RevisionConflictError } = require('./transactional-repository');
  return new RevisionConflictError(Number(expectedRevision), actualMatch ? Number(actualMatch[1]) : -1);
}

function normalizeRpcResult(payload) {
  if (Array.isArray(payload)) return payload[0] ?? null;
  return payload ?? null;
}

function transientReadError(error) {
  const status = Number(error?.statusCode);
  if (status === 408 || status === 425 || status === 429 || status >= 500) return true;
  return error instanceof TypeError || /\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|fetch failed|network error)\b/i.test(String(error?.message || error || ''));
}

async function readRpc(functionName, params, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await request(`/rest/v1/rpc/${functionName}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params)
      });
      return normalizeRpcResult(await response.json());
    } catch (error) {
      lastError = error;
      if (attempt === attempts || !transientReadError(error)) throw error;
      await new Promise(resolve => setTimeout(resolve, 10 * (2 ** (attempt - 1))));
    }
  }
  throw lastError;
}

async function upload(bucket, objectKey, bytes, contentType, upsert = false, requestOptions = {}) {
  if (MANAGED_PRIVATE_BUCKETS[bucket]) await ensurePrivateBucket(bucket, ...MANAGED_PRIVATE_BUCKETS[bucket], requestOptions);
  const safeKey = objectKey.split('/').map(encodeURIComponent).join('/');
  const save = () => request(`/storage/v1/object/${bucket}/${safeKey}`, {
    method: 'POST',
    headers: { 'Content-Type': contentType, 'x-upsert': upsert ? 'true' : 'false' },
    body: bytes,
    signal: requestOptions.signal
  });
  try {
    await save();
  } catch (error) {
    if (!/Bucket not found|NoSuchBucket/i.test(String(error.message))) throw error;
    const [fileSizeLimit, allowedMimeTypes] = MANAGED_PRIVATE_BUCKETS[bucket] || [Math.max(6_000_000, Buffer.byteLength(bytes)), [contentType]];
    await ensurePrivateBucket(bucket, fileSizeLimit, allowedMimeTypes, requestOptions);
    await save();
  }
  return { bucket, objectKey, url: `/api/files/${encodeURIComponent(bucket)}/${safeKey}` };
}

async function remove(bucket, objectKey) {
  if (!configured()) return false;
  const safeKey = objectKey.split('/').map(encodeURIComponent).join('/');
  await request(`/storage/v1/object/${bucket}/${safeKey}`, { method: 'DELETE' });
  return true;
}

async function ensurePrivateBucket(bucket, fileSizeLimit = 25_000_000, allowedMimeTypes = ['application/json'], requestOptions = {}) {
  if (!configured()) return false;
  const response = await fetch(`${process.env.SUPABASE_URL}/storage/v1/bucket`, {
    method: 'POST',
    headers: headers({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ id: bucket, name: bucket, public: false, file_size_limit: fileSizeLimit, allowed_mime_types: allowedMimeTypes }),
    signal: requestOptions.signal
  });
  const responseText = response.ok ? '' : await response.text();
  const alreadyExists = response.status === 409 || /BucketAlreadyExists|resource already exists/i.test(responseText);
  if (!response.ok && !alreadyExists) throw new Error(`Supabase bucket setup failed (${response.status}): ${responseText.slice(0, 300)}`);
  if (alreadyExists) {
    const readBucket = async () => {
      const current = await request(`/storage/v1/bucket/${encodeURIComponent(bucket)}`, { signal: requestOptions.signal });
      return current.json();
    };
    const matches = value => {
      const mime = Array.isArray(value?.allowed_mime_types) ? value.allowed_mime_types : [];
      return value?.public === false && Number(value?.file_size_limit) === Number(fileSizeLimit) &&
        mime.length === allowedMimeTypes.length && allowedMimeTypes.every(type => mime.includes(type));
    };
    let current = await readBucket();
    if (!matches(current)) {
      await request(`/storage/v1/bucket/${encodeURIComponent(bucket)}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: bucket, name: bucket, public: false, file_size_limit: fileSizeLimit, allowed_mime_types: allowedMimeTypes }),
        signal: requestOptions.signal
      });
      current = await readBucket();
    }
    if (!matches(current)) throw new Error(`Supabase bucket ${bucket} is not private or does not match its required limits.`);
  }
  return true;
}

async function verifyManagedPrivateBuckets() {
  if (!configured()) return false;
  for (const [bucket, configuration] of Object.entries(MANAGED_PRIVATE_BUCKETS)) {
    await ensurePrivateBucket(bucket, ...configuration);
  }
  return true;
}

async function listByPrefix(bucket, prefix) {
  if (!configured()) throw new Error('Supabase is not configured');
  const normalized = String(prefix || '').replaceAll('\\', '/').replace(/^\/+|\/+$/g, '');
  if (!normalized || normalized.includes('..')) throw new Error('A safe storage prefix is required');
  const rows = [];
  for (let offset = 0; offset < 100_000; offset += 1000) {
    const response = await request(`/storage/v1/object/list/${encodeURIComponent(bucket)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefix: normalized, limit: 1000, offset, sortBy: { column: 'name', order: 'asc' } })
    });
    const page = await response.json();
    if (!Array.isArray(page)) throw new Error(`Supabase returned an invalid object listing for ${bucket}`);
    for (const object of page) {
      const name = String(object?.name || '').replaceAll('\\', '/').replace(/^\/+/, '');
      if (!name || name.includes('..')) throw new Error(`Supabase returned an unsafe object name for ${bucket}`);
      const objectKey = name.startsWith(`${normalized}/`) ? name : `${normalized}/${name}`;
      if (!objectKey.startsWith(`${normalized}/`)) throw new Error(`Supabase returned a cross-prefix object for ${bucket}`);
      rows.push({ bucket, objectKey });
    }
    if (page.length < 1000) return rows;
  }
  throw new Error(`Supabase object listing exceeded the safety limit for ${bucket}/${normalized}`);
}

async function createVerifiedBackup(snapshot, requestOptions = {}) {
  if (!configured()) return null;
  await ensurePrivateBucket('tenant-backups', ...MANAGED_PRIVATE_BUCKETS['tenant-backups'], requestOptions);
  const bytes = Buffer.from(JSON.stringify(snapshot));
  const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  const { tenantStorageNamespace } = require('./transactional-repository');
  const companyId = tenantStorageNamespace(snapshot);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const objectKey = `${companyId}/${stamp}-${hash.slice(0, 12)}.json`;
  await upload('tenant-backups', objectKey, bytes, 'application/json', false, requestOptions);
  const restored = Buffer.from(await (await download('tenant-backups', objectKey, requestOptions)).arrayBuffer());
  const restoredHash = crypto.createHash('sha256').update(restored).digest('hex');
  if (restoredHash !== hash) throw new Error('Supabase backup verification failed');
  return { bucket: 'tenant-backups', objectKey, hash, bytes: bytes.length, verifiedAt: new Date().toISOString() };
}

async function download(bucket, objectKey, requestOptions = {}) {
  const safeKey = objectKey.split('/').map(encodeURIComponent).join('/');
  return request(`/storage/v1/object/${bucket}/${safeKey}`, { signal: requestOptions.signal });
}

async function loadCompanySnapshot(companyId) {
  if (!configured()) return null;
  const response = await request(`/rest/v1/companies?id=eq.${encodeURIComponent(companyId)}&select=data&limit=1`);
  const rows = await response.json();
  return rows[0]?.data || null;
}

async function findCompanyByUserEmail(email) {
  if (!configured()) return null;
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized) return null;
  const response = await request('/rest/v1/companies?select=id,data&limit=1000');
  const rows = await response.json();
  const matches = rows.filter(row => !row.data?.company?.archivedDuplicate && (row.data?.users || []).some(user =>
    user.status === 'Active' && String(user.email || '').trim().toLowerCase() === normalized
  ));
  matches.sort((a, b) => {
    const activityA = (a.data?.projects || []).length + (a.data?.reports || []).length;
    const activityB = (b.data?.projects || []).length + (b.data?.reports || []).length;
    return activityB - activityA || new Date(b.data?.company?.createdAt || 0) - new Date(a.data?.company?.createdAt || 0);
  });
  const match = matches[0];
  return match?.id || null;
}

async function listCompanySnapshots() {
  if (!configured()) return [];
  const response = await request('/rest/v1/companies?select=data&limit=1000');
  const rows = await response.json();
  return rows.map(row => row.data).filter(snapshot => snapshot?.company?.id);
}

async function saveCompanySnapshot(snapshot) {
  if (!configured()) return false;
  const id = snapshot.company.id;
  await request('/rest/v1/companies?on_conflict=id', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify([{ id, slug: `company-${id}`, name: snapshot.company.name, data: snapshot }])
  });
  return true;
}

async function loadSnapshot(id) {
  return loadCompanySnapshot(id);
}

async function saveSnapshot(id, name, data) {
  if (!configured()) return false;
  await request('/rest/v1/companies?on_conflict=id', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify([{ id, slug: `snapshot-${id}`, name, data }])
  });
  return true;
}

async function health() {
  if (!configured()) return { configured: false, reachable: false };
  try {
    const response = await request('/rest/v1/companies?select=id&limit=1');
    return { configured: true, reachable: response.ok };
  } catch (error) {
    return { configured: true, reachable: false, error: error.message };
  }
}

async function transactionalHealth() {
  if (!configured()) return { configured: false, reachable: false };
  try {
    // Exercise both the atomic tenant loader and the compact directory used by
    // login/back-office reads. A valid-but-absent tenant makes this read-only.
    await readRpc('load_tenant_repository', { p_company_id: '00000000-0000-4000-8000-000000000000' }, 1);
    const directory = await readRpc('list_tenant_directory_page', { p_after_company_id: null, p_limit: 1 }, 1);
    if (!directory || typeof directory !== 'object' || Array.isArray(directory) || !Array.isArray(directory.rows)) {
      throw new Error('Supabase returned an invalid tenant directory health response');
    }
    return { configured: true, reachable: true };
  } catch {
    return { configured: true, reachable: false };
  }
}

async function saveTransactionalSnapshot(snapshot, expectedRevision = 0) {
  if (!configured()) throw new Error('Supabase is not configured');
  const { splitSnapshot, canonicalHash, databaseCompanyId } = require('./transactional-repository');
  const companyId = databaseCompanyId(snapshot);
  const { scalarData, records } = splitSnapshot(snapshot);
  const payload = records.map(row => ({ collection: row.collection, record_key: row.recordKey, position: row.position, data: row.data }));
  let response;
  try {
    response = await request('/rest/v1/rpc/replace_tenant_records', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_company_id: companyId, p_expected_revision: Number(expectedRevision), p_scalar_data: scalarData, p_content_hash: canonicalHash(snapshot), p_records: payload })
    });
  } catch (error) {
    throw normalizeTenantRevisionConflict(error, expectedRevision);
  }
  const [result] = await response.json();
  return { companyId, revision: Number(result.revision), records: Number(result.record_count), contentHash: canonicalHash(snapshot) };
}

async function purgeTransactionalTenant(companyId, expectedRevision, deletionRequestId) {
  if (!configured()) throw new Error('Supabase is not configured');
  const { databaseCompanyId } = require('./transactional-repository');
  const id = databaseCompanyId(companyId);
  if (!Number.isSafeInteger(Number(expectedRevision)) || Number(expectedRevision) < 0) throw new Error('Expected tenant revision is required');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(deletionRequestId || ''))) throw new Error('Deletion request ID is required');
  const response = await request('/rest/v1/rpc/purge_tenant_repository', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_company_id: id, p_expected_revision: Number(expectedRevision), p_deletion_request_id: String(deletionRequestId).toLowerCase() })
  });
  const result = normalizeRpcResult(await response.json());
  const confirmedRequestId = requiredUuid(result?.deletionRequestId ?? result?.deletion_request_id, 'Deletion request ID');
  if (!result || result.deleted !== true || String(result.companyId || result.company_id || '').toLowerCase() !== id || confirmedRequestId !== String(deletionRequestId).toLowerCase()) throw new Error('Supabase did not confirm tenant deletion');
  const tombstoneVersion = nonNegativeInteger(result.tombstoneVersion ?? result.tombstone_version, 'tenant tombstone version');
  const terminalRevision = nonNegativeInteger(result.terminalRevision ?? result.terminal_revision, 'terminal tenant revision');
  if (tombstoneVersion < 1 || terminalRevision !== Number(expectedRevision)) throw new Error('Supabase did not confirm the terminal tenant tombstone');
  return { deleted: true, companyId: id, deletionRequestId: confirmedRequestId, deletedAt: result.deletedAt || result.deleted_at || null, tombstoneVersion, terminalRevision };
}

async function beginTransactionalTenantDeletion(companyId, expectedRevision, deletionRequestId) {
  if (!configured()) throw new Error('Supabase is not configured');
  const { databaseCompanyId } = require('./transactional-repository');
  const id = databaseCompanyId(companyId);
  if (!Number.isSafeInteger(Number(expectedRevision)) || Number(expectedRevision) < 0) throw new Error('Expected tenant revision is required');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(deletionRequestId || ''))) throw new Error('Deletion request ID is required');
  const response = await request('/rest/v1/rpc/begin_tenant_repository_purge', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_company_id: id, p_expected_revision: Number(expectedRevision), p_deletion_request_id: String(deletionRequestId).toLowerCase() })
  });
  const result = normalizeRpcResult(await response.json());
  const lockedRevision = nonNegativeInteger(result?.lockedRevision ?? result?.locked_revision, 'locked tenant revision');
  const confirmedRequestId = requiredUuid(result?.deletionRequestId ?? result?.deletion_request_id, 'Deletion request ID');
  if (!result || result.locked !== true || String(result.companyId || result.company_id || '').toLowerCase() !== id || lockedRevision !== Number(expectedRevision) || confirmedRequestId !== String(deletionRequestId).toLowerCase()) {
    throw new Error('Supabase did not confirm the tenant deletion lock');
  }
  return {
    locked: true,
    companyId: id,
    deletionRequestId: confirmedRequestId,
    lockedRevision,
    startedAt: result.startedAt ?? result.started_at ?? null,
    resumed: result.resumed === true
  };
}

async function transactionalTenantDeletionStatus(companyId) {
  if (!configured()) throw new Error('Supabase is not configured');
  const { databaseCompanyId } = require('./transactional-repository');
  const id = databaseCompanyId(companyId);
  const result = await readRpc('tenant_repository_deletion_status', { p_company_id: id });
  const status = String(result?.status || '');
  if (!['not_started', 'locked', 'deleted'].includes(status) || String(result.companyId || result.company_id || '').toLowerCase() !== id) {
    throw new Error('Supabase returned an invalid tenant deletion status');
  }
  if (status === 'not_started') return { status, companyId: id };
  const deletionRequestId = requiredUuid(result.deletionRequestId ?? result.deletion_request_id, 'Deletion request ID');
  if (status === 'locked') {
    return {
      status,
      companyId: id,
      deletionRequestId,
      lockedRevision: nonNegativeInteger(result.lockedRevision ?? result.locked_revision, 'locked tenant revision'),
      startedAt: result.startedAt ?? result.started_at ?? null
    };
  }
  const tombstoneVersion = nonNegativeInteger(result.tombstoneVersion ?? result.tombstone_version, 'tenant tombstone version');
  if (tombstoneVersion < 1) throw new Error('Supabase returned an invalid tenant tombstone version');
  return {
    status,
    companyId: id,
    deletionRequestId,
    terminalRevision: nonNegativeInteger(result.terminalRevision ?? result.terminal_revision, 'terminal tenant revision'),
    tombstoneVersion,
    deletedAt: result.deletedAt ?? result.deleted_at ?? null
  };
}

function requiredUuid(value, label) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(normalized)) {
    throw new Error(`${label} is invalid`);
  }
  return normalized;
}

function parseTenantEmailConflict(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('Supabase returned an invalid tenant email conflict');
  const normalizedEmail = String(row.normalizedEmail ?? row.normalized_email ?? '').trim().toLowerCase();
  if (!normalizedEmail || normalizedEmail.length > 320 || !normalizedEmail.includes('@')) throw new Error('Supabase returned an invalid tenant email conflict');
  return {
    normalizedEmail,
    retainedCompanyId: requiredUuid(row.retainedCompanyId ?? row.retained_company_id, 'Retained company ID'),
    conflictedCompanyId: requiredUuid(row.conflictedCompanyId ?? row.conflicted_company_id, 'Conflicted company ID'),
    authorizedCompanyId: requiredUuid(row.authorizedCompanyId ?? row.authorized_company_id, 'Authorized company ID'),
    detectedAt: row.detectedAt ?? row.detected_at ?? null,
    resolvedAt: row.resolvedAt ?? row.resolved_at ?? null,
    resolvedBy: row.resolvedBy ?? row.resolved_by ?? null,
    resolutionNote: row.resolutionNote ?? row.resolution_note ?? null
  };
}

async function listTenantEmailConflicts(limit = 100) {
  if (!configured()) return [];
  const safeLimit = Math.min(500, Math.max(1, Number.isSafeInteger(Number(limit)) ? Number(limit) : 100));
  const result = await readRpc('list_tenant_email_conflicts', { p_limit: safeLimit });
  if (!result || typeof result !== 'object' || Array.isArray(result) || !Array.isArray(result.rows)) {
    throw new Error('Supabase returned an invalid tenant email conflict queue');
  }
  return result.rows.map(parseTenantEmailConflict);
}

async function resolveTenantEmailConflict({ email, authorizedCompanyId, resolvedBy, resolutionNote = null } = {}) {
  if (!configured()) throw new Error('Supabase is not configured');
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!normalizedEmail || normalizedEmail.length > 320 || !normalizedEmail.includes('@')) throw new Error('Conflict email is required');
  const companyId = requiredUuid(authorizedCompanyId, 'Authorized company ID');
  const operator = String(resolvedBy || '').trim();
  if (!operator) throw new Error('Resolving operator is required');
  const response = await request('/rest/v1/rpc/resolve_tenant_email_conflict', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      p_email: normalizedEmail,
      p_authorized_company_id: companyId,
      p_resolved_by: operator.slice(0, 200),
      p_resolution_note: String(resolutionNote || '').trim().slice(0, 1000) || null
    })
  });
  const result = normalizeRpcResult(await response.json());
  if (!result || result.resolved !== true || requiredUuid(result.authorizedCompanyId ?? result.authorized_company_id, 'Resolved company ID') !== companyId) {
    throw new Error('Supabase did not confirm tenant email conflict resolution');
  }
  return {
    resolved: true,
    normalizedEmail: String(result.normalizedEmail ?? result.normalized_email ?? normalizedEmail).trim().toLowerCase(),
    authorizedCompanyId: companyId,
    affectedConflicts: nonNegativeInteger(result.affectedConflicts ?? result.affected_conflicts, 'affected email conflicts'),
    resolvedAt: result.resolvedAt ?? result.resolved_at ?? null
  };
}

async function loadTransactionalSnapshot(companyId) {
  if (!configured()) return null;
  const { databaseCompanyId } = require('./transactional-repository');
  const id = databaseCompanyId(companyId);
  const result = await readRpc('load_tenant_repository', { p_company_id: id });
  return result ? parseTransactionalRepositoryRow(result, id) : null;
}

function nonNegativeInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`Supabase returned an invalid ${label}`);
  return number;
}

function parseTransactionalRepositoryRow(row, expectedDatabaseCompanyId = null) {
  const { assembleSnapshot, canonicalHash } = require('./transactional-repository');
  if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('Supabase returned an invalid transactional tenant');
  const databaseCompanyId = String(row.databaseCompanyId ?? row.database_company_id ?? row.companyId ?? row.company_id ?? '').toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(databaseCompanyId)) {
    throw new Error('Supabase returned an invalid transactional tenant company ID');
  }
  if (expectedDatabaseCompanyId && databaseCompanyId !== String(expectedDatabaseCompanyId).toLowerCase()) {
    throw new Error('Supabase returned the wrong transactional tenant');
  }
  const scalarData = row.scalarData ?? row.scalar_data;
  if (!scalarData || typeof scalarData !== 'object' || Array.isArray(scalarData)) {
    throw new Error(`Transactional tenant scalar data is invalid for ${databaseCompanyId}`);
  }
  const records = row.records;
  if (!Array.isArray(records)) throw new Error(`Transactional tenant records are invalid for ${databaseCompanyId}`);
  const snapshot = assembleSnapshot(scalarData, records);
  const actualHash = canonicalHash(snapshot);
  const contentHash = String(row.contentHash ?? row.content_hash ?? '');
  if (!/^[a-f0-9]{64}$/.test(contentHash) || contentHash !== actualHash) {
    throw new Error(`Transactional tenant integrity check failed for ${databaseCompanyId}`);
  }
  return {
    companyId: String(snapshot.company?.id || databaseCompanyId),
    databaseCompanyId,
    snapshot,
    revision: nonNegativeInteger(row.revision, `transactional revision for ${databaseCompanyId}`),
    contentHash
  };
}

function parseTenantDirectoryRow(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('Supabase returned an invalid tenant directory row');
  const company = row.company;
  if (!company || typeof company !== 'object' || Array.isArray(company)) throw new Error('Supabase returned invalid tenant directory company data');
  const companyId = String(row.companyId ?? row.company_id ?? company.id ?? '').trim();
  const databaseCompanyId = String(row.databaseCompanyId ?? row.database_company_id ?? '').toLowerCase();
  if (!companyId) throw new Error('Supabase returned a tenant directory row without a company ID');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(databaseCompanyId)) {
    throw new Error(`Supabase returned an invalid directory database ID for ${companyId}`);
  }
  return {
    companyId,
    databaseCompanyId,
    revision: nonNegativeInteger(row.revision, `directory revision for ${companyId}`),
    company,
    users: nonNegativeInteger(row.users, `user count for ${companyId}`),
    projects: nonNegativeInteger(row.projects, `project count for ${companyId}`),
    reports: nonNegativeInteger(row.reports, `report count for ${companyId}`),
    lastReport: row.lastReport ?? row.last_report ?? null,
    updatedAt: row.updatedAt ?? row.updated_at ?? null
  };
}

async function collectKeysetRpc(functionName, pageSize, parseRow) {
  const rows = [];
  const seenCompanyIds = new Set();
  const seenCursors = new Set();
  let cursor = null;
  for (;;) {
    const page = await readRpc(functionName, { p_after_company_id: cursor, p_limit: pageSize });
    if (!page || typeof page !== 'object' || Array.isArray(page) || !Array.isArray(page.rows)) {
      throw new Error(`Supabase returned an invalid ${functionName} page`);
    }
    for (const rawRow of page.rows) {
      const row = parseRow(rawRow);
      const identity = String(row.databaseCompanyId || row.companyId || '');
      if (!identity || seenCompanyIds.has(identity)) throw new Error(`Supabase returned a duplicate tenant in ${functionName}`);
      seenCompanyIds.add(identity);
      rows.push(row);
    }
    const next = page.nextCompanyId ?? page.next_company_id ?? null;
    if (next == null || next === '') return rows;
    const normalized = String(next).toLowerCase();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(normalized)) {
      throw new Error(`Supabase returned an invalid ${functionName} cursor`);
    }
    if (seenCursors.has(normalized) || normalized === cursor) throw new Error(`Supabase repeated the ${functionName} cursor`);
    seenCursors.add(normalized);
    cursor = normalized;
  }
}

async function listTransactionalSnapshots() {
  if (!configured()) return [];
  return collectKeysetRpc('list_tenant_repository_page', 100, parseTransactionalRepositoryRow);
}

async function listTransactionalTenantSummaries() {
  if (!configured()) return [];
  return collectKeysetRpc('list_tenant_directory_page', 500, parseTenantDirectoryRow);
}

async function findTransactionalCompanyIdByUserEmail(email) {
  if (!configured()) return null;
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized || normalized.length > 320) return null;
  const result = await readRpc('find_tenant_company_by_email', { p_email: normalized });
  if (!result) return null;
  const companyId = String(result.companyId ?? result.company_id ?? '').trim();
  const databaseCompanyId = String(result.databaseCompanyId ?? result.database_company_id ?? '').toLowerCase();
  if (!companyId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(databaseCompanyId)) {
    throw new Error('Supabase returned an invalid tenant email lookup');
  }
  nonNegativeInteger(result.revision, `directory revision for ${companyId}`);
  return companyId;
}

async function findTransactionalCompanyIdByPublicToken(kind, tokenHash) {
  if (!configured()) return null;
  const normalizedKind = String(kind || '').trim().toLowerCase();
  const normalizedHash = String(tokenHash || '').trim().toLowerCase();
  if (!['guest', 'change_order'].includes(normalizedKind)) throw new Error('Public link kind is invalid');
  if (!/^[a-f0-9]{64}$/.test(normalizedHash)) throw new Error('Public link token hash must be SHA-256');
  const result = await readRpc('find_tenant_company_by_public_token', {
    p_kind: normalizedKind,
    p_token_hash: normalizedHash
  });
  if (!result) return null;
  const companyId = String(result.companyId ?? result.company_id ?? '').trim();
  const databaseCompanyId = String(result.databaseCompanyId ?? result.database_company_id ?? '').toLowerCase();
  if (!companyId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(databaseCompanyId)) {
    throw new Error('Supabase returned an invalid public link tenant lookup');
  }
  nonNegativeInteger(result.revision, `public link directory revision for ${companyId}`);
  return companyId;
}

module.exports = { MANAGED_PRIVATE_BUCKETS, loadLocalEnv, configured, upload, download, remove, ensurePrivateBucket, verifyManagedPrivateBuckets, listByPrefix, createVerifiedBackup, loadCompanySnapshot, findCompanyByUserEmail, listCompanySnapshots, saveCompanySnapshot, loadSnapshot, saveSnapshot, saveTransactionalSnapshot, beginTransactionalTenantDeletion, purgeTransactionalTenant, transactionalTenantDeletionStatus, listTenantEmailConflicts, resolveTenantEmailConflict, loadTransactionalSnapshot, listTransactionalSnapshots, listTransactionalTenantSummaries, findTransactionalCompanyIdByUserEmail, findTransactionalCompanyIdByPublicToken, health, transactionalHealth, request };
