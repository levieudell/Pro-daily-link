'use strict';
const crypto = require('node:crypto');
const admission = require('./tenant-admission');
const types = Object.freeze({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' });
const maxBytes = 6_000_000;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const unavailable = () => Object.assign(Error('Private photo storage is unavailable; preserve this upload for retry'), { statusCode: 503 });
function validate(companyId, descriptor) {
  const prefix = String(companyId) + '/atomic-photos/';
  if (!uuid.test(String(companyId)) || descriptor?.bucket !== 'project-photos' || !Object.hasOwn(types, descriptor.type) || !Number.isSafeInteger(descriptor.bytes) || descriptor.bytes < 1 || descriptor.bytes > maxBytes || !/^[a-f0-9]{64}$/.test(descriptor.sha256) || typeof descriptor.key !== 'string' || !descriptor.key.startsWith(prefix) || !uuid.test(descriptor.key.slice(prefix.length).split('/')[0]) || descriptor.key.slice(prefix.length) !== descriptor.key.slice(prefix.length).split('/')[0] + '/photo.' + types[descriptor.type]) throw unavailable();
  return descriptor;
}
function createStore(request) {
  const address = descriptor => '/storage/v1/object/project-photos/' + descriptor.key.split('/').map(encodeURIComponent).join('/');
  async function bucket(descriptor) {
    if (!admission.enabled()) throw unavailable();
    const response = await request('/storage/v1/bucket/project-photos'), policy = await response.json();
    if (policy.id !== 'project-photos' || policy.public !== false || policy.file_size_limit != null && (!Number.isFinite(Number(policy.file_size_limit)) || Number(policy.file_size_limit) < descriptor.bytes) || policy.allowed_mime_types != null && (!Array.isArray(policy.allowed_mime_types) || !policy.allowed_mime_types.includes(descriptor.type))) throw unavailable();
  }
  async function read(descriptor, missing = false) {
    let response;
    try { response = await request(address(descriptor)); }
    catch (error) { if (missing && error.providerStatus === 404) return null; throw unavailable(); }
    const type = String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (type !== descriptor.type) throw unavailable();
    const chunks = []; let length = 0;
    for await (const chunk of response.body) { length += chunk.length; if (length > descriptor.bytes || length > maxBytes) throw unavailable(); chunks.push(Buffer.from(chunk)); }
    const bytes = Buffer.concat(chunks);
    if (length !== descriptor.bytes || digest(bytes) !== descriptor.sha256) throw unavailable();
    return bytes;
  }
  async function get(companyId, descriptor) { validate(companyId, descriptor); await bucket(descriptor); return read(descriptor); }
  async function put(companyId, descriptor, bytes) {
    validate(companyId, descriptor);
    if (!Buffer.isBuffer(bytes) || bytes.length !== descriptor.bytes || digest(bytes) !== descriptor.sha256) throw unavailable();
    await bucket(descriptor);
    if (await read(descriptor, true)) return;
    try { await request(address(descriptor), { method: 'POST', headers: { 'Content-Type': descriptor.type, 'x-upsert': 'false' }, body: bytes }); }
    catch { if (!await read(descriptor, true)) throw unavailable(); return; }
    await read(descriptor);
  }
  // No bucket provisioning, upsert, remove, cleanup, signed/public URL or local
  // fallback exists here. Unknown outcomes retain their reserved private key.
  return { get, put };
}
module.exports = { createStore, validate, digest, types, maxBytes, uuid };
