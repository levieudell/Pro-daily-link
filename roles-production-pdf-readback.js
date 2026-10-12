'use strict';
// Managed normal-server PDF delivery only. Legacy source names never establish
// author authority; this reader creates no custody, grants or file references.
const fs = require('node:fs/promises'), path = require('node:path');
const { canonicalHash } = require('./database/transactional-repository');
const assets = require('./protected-assets-admission'), custody = require('./resource-assets');
const LIMIT = 15000000, roles = ['owner', 'admin', 'project_manager', 'foreman', 'field'];
const fail = (statusCode, message) => { throw Object.assign(Error(message), { statusCode, code: 'PDL_PDF_READBACK' }); };
const id = value => Number.isSafeInteger(value) && value > 0;
const object = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));
function route(method, rawPath) {
  if (method !== 'GET' || !assets.route(method, rawPath)) return false;
  let decoded; try { decoded = decodeURIComponent(rawPath); } catch { decoded = rawPath; }
  return /^\/api\/files\/estimate-documents\/.+/.test(decoded) || /^\/api\/local-files\/estimates\/.+/.test(decoded) || /\.pdf$/i.test(decoded);
}
function rows(db, name) {
  const result = db[name] ?? [];
  if (!Array.isArray(result) || result.length > 50000 || result.some(row => !object(row) || !id(row.id) || row.companyId !== undefined && row.companyId !== db.company.id) || new Set(result.map(row => row.id)).size !== result.length) fail(409, 'PDF source identities need reconciliation.');
  return result;
}
function actor(db, auth) {
  const user = auth?.user, session = auth?.session;
  if (!user || !id(user.id) || user.status !== 'Active' || !roles.includes(user.role) || auth.companyId !== undefined && auth.companyId !== db.company.id || user.companyId !== undefined && user.companyId !== db.company.id || !session || !/^[a-f0-9]{64}$/.test(session.tokenHash || '') || !Number.isFinite(Date.parse(session.expiresAt)) || Date.parse(session.expiresAt) <= Date.now()) fail(401, 'Current PDF account and session required.');
  return { companyId: db.company.id, id: user.id, role: user.role, sessionHash: session.tokenHash, expiresAt: session.expiresAt };
}
function consistent(row, where) {
  if (!object(row) || row.companyId !== undefined && row.companyId !== where.companyId || row.url !== undefined && row.url !== where.url) fail(409, 'PDF file references need reconciliation.');
  for (const [bucket, key] of [['bucket', 'objectKey'], ['storageBucket', 'storageKey']]) {
    if (row[bucket] != null || row[key] != null) if (!where.bucket || row[bucket] !== where.bucket || row[key] !== where.key) fail(409, 'PDF file references need reconciliation.');
  }
}
function references(db, where) {
  const refs = assets.references(db, where), matches = row => row.url === where.url || where.bucket && (row.bucket === where.bucket && row.objectKey === where.key || row.storageBucket === where.bucket && row.storageKey === where.key);
  // A retained deleted alias cannot turn the same bytes into a less restricted
  // document. History stays in its original project for this bounded reader.
  for (const [name, kind] of [['projectPlans', 'plan'], ['projectTickets', 'ticket']]) for (const row of db[name] ?? []) if (row.deletedAt && matches(row)) refs.push({ kind, row, projectId: row.projectId });
  return refs;
}
function resolve(db, auth, url, h) {
  if (!object(db?.company) || typeof h?.canViewPricing !== 'function' || typeof h?.canAccessProject !== 'function') fail(503, 'Reviewed PDF authorization callbacks required.');
  const identity = actor(db, auth), where = { ...assets.location(url, db.company.id), companyId: db.company.id };
  const projects = rows(db, 'projects');
  for (const name of ['photos', 'projectPlans', 'projectTickets', 'estimateImports']) rows(db, name);
  for (const project of projects) {
    if (!Array.isArray(project.estimateProposals ?? []) || (project.estimateProposals ?? []).length > 50000 || (project.estimateProposals ?? []).some(row => !object(row) || !id(row.id)) || new Set((project.estimateProposals ?? []).map(row => row.id)).size !== (project.estimateProposals ?? []).length) fail(409, 'PDF proposal identities need reconciliation.');
  }
  const refs = references(db, where);
  if (!refs.length) fail(404, 'PDF not found.');
  for (const ref of refs) {
    consistent(ref.row, where);
    const projectId = ref.kind === 'import' ? ref.row.projectId : ref.projectId;
    if (projectId != null && (!id(projectId) || !projects.some(project => project.id === projectId))) fail(409, 'PDF project bindings need reconciliation.');
    if (ref.kind === 'import' && ref.row.createdByUserId != null && !id(ref.row.createdByUserId)) fail(409, 'Original PDF creator needs reconciliation.');
  }
  let stored = null;
  if (Object.hasOwn(db, custody.collection)) {
    if (!Buffer.isBuffer(h.key) || h.key.length !== 32) fail(503, 'Existing PDF custody requires its reviewed signing key.');
    stored = custody.createCustody({ key: h.key }).valid(db).find(row => custody.url(db, row) === where.url) || null;
    if (stored) {
      if (stored.type !== 'application/pdf') fail(409, 'Original PDF custody type needs reconciliation.');
      assets.retainedReference(db, stored, refs);
      if (stored.kind === 'estimatePdfProposal' && ['field', 'foreman'].includes(auth.user.role) && stored.actorId === auth.user.id && stored.actorRole === auth.user.role && stored.sessionHash === auth.session.tokenHash) for (const ref of refs) if (ref.kind === 'proposal') ref.sourceActorId = stored.actorId;
    }
  }
  if (refs.some(ref => !assets.authorized(db, auth.user, ref, h))) fail(404, 'PDF not found.');
  const projectIds = new Set(refs.flatMap(ref => [ref.kind === 'import' ? ref.row.projectId : ref.projectId]).filter(value => value != null));
  return { where, stored, identity, sourceHash: canonicalHash({ where, refs, stored, projects: projects.filter(project => projectIds.has(project.id)) }) };
}
function verified(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 5 || bytes.length > LIMIT || bytes.toString('ascii', 0, 5) !== '%PDF-') fail(409, 'PDF bytes could not be verified.');
  return bytes;
}
async function cloudBytes(response, { signal } = {}) {
  if (!response?.ok || !response.headers || !response.body?.getReader) fail(404, 'PDF not found.');
  const type = String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase(), length = response.headers.get('content-length');
  if (!['application/pdf', 'application/octet-stream'].includes(type) || length !== null && (!/^\d+$/.test(length) || Number(length) < 5 || Number(length) > LIMIT)) { response.body.cancel().catch(() => {}); fail(409, 'PDF delivery metadata needs reconciliation.'); }
  const reader = response.body.getReader(), chunks = []; let size = 0;
  const abort = () => { reader.cancel().catch(() => {}); };
  if (signal?.aborted) { abort(); reader.releaseLock(); fail(409, 'PDF read authorization expired.'); }
  signal?.addEventListener('abort', abort, { once: true });
  try {
    while (true) { const result = await reader.read(); if (signal?.aborted) fail(409, 'PDF read authorization expired.'); if (result.done) break; if (!(result.value instanceof Uint8Array) || (size += result.value.byteLength) > LIMIT) fail(409, 'PDF exceeds the delivery limit.'); chunks.push(Buffer.from(result.value)); }
    if (length !== null && size !== Number(length)) fail(409, 'PDF delivery length needs reconciliation.');
    return verified(Buffer.concat(chunks, size));
  } catch (error) { reader.cancel().catch(() => {}); throw error; }
  finally { signal?.removeEventListener('abort', abort); reader.releaseLock(); }
}
async function readWithDeadline(load, originalDeadline) {
  const now = Date.now();
  if (originalDeadline !== undefined && (!Number.isFinite(originalDeadline) || originalDeadline <= now)) fail(409, 'PDF read authorization expired.');
  const expires = Math.min(now + 30000, originalDeadline ?? Infinity), controller = new AbortController();
  let timer, stopped = false, response;
  const cancel = value => { try { value?.body?.cancel().catch(() => {}); } catch {} };
  const timeout = new Promise((resolve, reject) => { timer = setTimeout(() => { stopped = true; reject(Object.assign(Error('PDF read authorization or delivery deadline expired.'), { statusCode: 409, code: 'PDL_PDF_READBACK' })); controller.abort(); cancel(response); }, Math.max(1, expires - Date.now())); });
  const work = Promise.resolve().then(() => load(controller.signal)).then(value => {
    response = value;
    if (stopped || Date.now() >= expires) { cancel(value); fail(409, 'PDF read authorization expired.'); }
    return cloudBytes(value, { signal: controller.signal });
  });
  try { return await Promise.race([work, timeout]); }
  finally { clearTimeout(timer); }
}
const contained = (root, file) => { const relative = path.relative(root, file); return relative && !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative); };
const samePath = (left, right) => process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
async function localBytes(root, relative) {
  if (typeof root !== 'string' || !path.isAbsolute(root) || typeof relative !== 'string' || relative.length > 4096 || /[\\\x00-\x1f\x7f:<>"|?*]/.test(relative)) fail(400, 'Use the original contained PDF path.');
  let handle;
  try {
    const realRoot = await fs.realpath(root), selected = path.resolve(realRoot, relative), realFile = await fs.realpath(selected);
    if (!contained(realRoot, selected) || !contained(realRoot, realFile) || !samePath(selected, realFile)) fail(404, 'PDF not found.');
    handle = await fs.open(realFile, 'r'); const before = await handle.stat();
    if (!before.isFile() || before.size < 5 || before.size > LIMIT) fail(409, 'PDF exceeds the delivery limit.');
    const bytes = Buffer.alloc(before.size); let offset = 0;
    while (offset < bytes.length) { const read = await handle.read(bytes, offset, bytes.length - offset, offset); if (!read.bytesRead) fail(409, 'Complete PDF bytes unavailable.'); offset += read.bytesRead; }
    const after = await handle.stat(), currentFile = await fs.realpath(selected), current = await fs.stat(currentFile);
    if (!samePath(realFile, currentFile) || [after, current].some(value => value.dev !== before.dev || value.ino !== before.ino || value.size !== before.size || value.mtimeMs !== before.mtimeMs)) fail(409, 'PDF file changed during delivery.');
    return verified(bytes);
  } catch (error) { if (['ENOENT', 'ENOTDIR', 'ELOOP', 'EACCES', 'EPERM'].includes(error.code)) fail(404, 'PDF not found.'); throw error; }
  finally { await handle?.close(); }
}
function createHandler(h) {
  return async function handle(req, res, url) {
    if (!route(req.method, url.pathname)) return false;
    try {
      const auth = await h.assertCurrent(req), initial = resolve(h.readDb(), auth, url, h);
      let bytes;
      if (initial.stored) bytes = verified(Buffer.from(initial.stored.bytes, 'base64'));
      else if (initial.where.bucket) bytes = await readWithDeadline(signal => h.download(initial.where.bucket, initial.where.key, { signal }), h.deadline?.());
      else bytes = await localBytes(h.localRoot, initial.where.local);
      const current = resolve(h.readDb(), await h.assertCurrent(req), url, h);
      if (canonicalHash(initial.identity) !== canonicalHash(current.identity) || initial.sourceHash !== current.sourceHash) fail(409, 'Current PDF source or access changed before delivery.');
      h.raw(res, { status: 200, headers: { 'Content-Type': 'application/pdf', 'Content-Length': String(bytes.length), 'Cache-Control': 'private, no-store', 'Content-Disposition': 'inline', 'X-Content-Type-Options': 'nosniff' }, raw: bytes }); return true;
    } catch (error) {
      if (![400, 401, 402, 403, 404, 409, 503].includes(error.statusCode)) { h.json(res, 503, { error: 'PDF delivery could not be completed.', code: 'PDL_PDF_READBACK' }); return true; }
      h.json(res, error.statusCode, { error: error.message, code: error.code || 'PDL_PDF_READBACK' }); return true;
    }
  };
}
module.exports = { LIMIT, route, resolve, verified, cloudBytes, readWithDeadline, localBytes, createHandler };
