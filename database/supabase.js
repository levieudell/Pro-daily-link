const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

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
    headers: headers(options.headers)
  });
  if (!response.ok) throw new Error(`Supabase request failed (${response.status}): ${(await response.text()).slice(0, 300)}`);
  return response;
}

async function upload(bucket, objectKey, bytes, contentType) {
  const safeKey = objectKey.split('/').map(encodeURIComponent).join('/');
  const save = () => request(`/storage/v1/object/${bucket}/${safeKey}`, {
    method: 'POST',
    headers: { 'Content-Type': contentType, 'x-upsert': 'false' },
    body: bytes
  });
  try {
    await save();
  } catch (error) {
    if (!/Bucket not found|NoSuchBucket/i.test(String(error.message))) throw error;
    await ensurePrivateBucket(bucket, 6_000_000, [contentType]);
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

async function ensurePrivateBucket(bucket, fileSizeLimit = 25_000_000, allowedMimeTypes = ['application/json']) {
  if (!configured()) return false;
  const response = await fetch(`${process.env.SUPABASE_URL}/storage/v1/bucket`, {
    method: 'POST',
    headers: headers({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ id: bucket, name: bucket, public: false, file_size_limit: fileSizeLimit, allowed_mime_types: allowedMimeTypes })
  });
  const responseText = response.ok ? '' : await response.text();
  const alreadyExists = response.status === 409 || /BucketAlreadyExists|resource already exists/i.test(responseText);
  if (!response.ok && !alreadyExists) throw new Error(`Supabase bucket setup failed (${response.status}): ${responseText.slice(0, 300)}`);
  return true;
}

async function createVerifiedBackup(snapshot) {
  if (!configured()) return null;
  await ensurePrivateBucket('tenant-backups');
  const bytes = Buffer.from(JSON.stringify(snapshot));
  const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  const companyId = snapshot.company.id;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const objectKey = `${companyId}/${stamp}-${hash.slice(0, 12)}.json`;
  await upload('tenant-backups', objectKey, bytes, 'application/json');
  const restored = Buffer.from(await (await download('tenant-backups', objectKey)).arrayBuffer());
  const restoredHash = crypto.createHash('sha256').update(restored).digest('hex');
  if (restoredHash !== hash) throw new Error('Supabase backup verification failed');
  return { bucket: 'tenant-backups', objectKey, hash, bytes: bytes.length, verifiedAt: new Date().toISOString() };
}

async function download(bucket, objectKey) {
  const safeKey = objectKey.split('/').map(encodeURIComponent).join('/');
  return request(`/storage/v1/object/${bucket}/${safeKey}`);
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

async function saveTransactionalSnapshot(snapshot, expectedRevision = 0) {
  if (!configured()) throw new Error('Supabase is not configured');
  const { splitSnapshot, canonicalHash, databaseCompanyId } = require('./transactional-repository');
  const companyId = databaseCompanyId(snapshot);
  const { scalarData, records } = splitSnapshot(snapshot);
  const payload = records.map(row => ({ collection: row.collection, record_key: row.recordKey, position: row.position, data: row.data }));
  const response = await request('/rest/v1/rpc/replace_tenant_records', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_company_id: companyId, p_expected_revision: Number(expectedRevision), p_scalar_data: scalarData, p_content_hash: canonicalHash(snapshot), p_records: payload })
  });
  const [result] = await response.json();
  return { companyId, revision: Number(result.revision), records: Number(result.record_count), contentHash: canonicalHash(snapshot) };
}

async function loadTransactionalSnapshot(companyId) {
  if (!configured()) return null;
  const { assembleSnapshot, databaseCompanyId } = require('./transactional-repository');
  const id = databaseCompanyId(companyId);
  const stateResponse = await request(`/rest/v1/tenant_revisions?company_id=eq.${encodeURIComponent(id)}&select=revision,scalar_data,content_hash&limit=1`);
  const [state] = await stateResponse.json();
  if (!state) return null;
  const recordResponse = await request(`/rest/v1/tenant_records?company_id=eq.${encodeURIComponent(id)}&select=collection,data&order=collection.asc,position.asc`);
  const records = await recordResponse.json();
  return { snapshot: assembleSnapshot(state.scalar_data, records), revision: Number(state.revision), contentHash: state.content_hash };
}

module.exports = { loadLocalEnv, configured, upload, download, remove, ensurePrivateBucket, createVerifiedBackup, loadCompanySnapshot, findCompanyByUserEmail, listCompanySnapshots, saveCompanySnapshot, loadSnapshot, saveSnapshot, saveTransactionalSnapshot, loadTransactionalSnapshot, health, request };
