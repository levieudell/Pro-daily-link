const fs = require('node:fs');
const path = require('node:path');

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
  await request(`/storage/v1/object/${bucket}/${safeKey}`, {
    method: 'POST',
    headers: { 'Content-Type': contentType, 'x-upsert': 'false' },
    body: bytes
  });
  return { bucket, objectKey, url: `/api/files/${encodeURIComponent(bucket)}/${safeKey}` };
}

async function download(bucket, objectKey) {
  const safeKey = objectKey.split('/').map(encodeURIComponent).join('/');
  return request(`/storage/v1/object/${bucket}/${safeKey}`);
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

module.exports = { loadLocalEnv, configured, upload, download, health, request };
