'use strict';
const crypto = require('node:crypto');
const daily = require('./daily-access');
const { unique, authority: dailyAuthority } = require('./daily-admission');
const storage = require('./database/atomic-photo-store');
const { canonicalHash } = require('./database/transactional-repository');
const fail = (statusCode, message) => { throw Object.assign(Error(message), { statusCode }); };
const object = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key));
const positive = value => ['number', 'string'].includes(typeof value) && /^[1-9]\d*$/.test(String(value)) && Number.isSafeInteger(Number(value));
const equal = (a, b) => canonicalHash(a ?? null) === canonicalHash(b ?? null);
const pick = (row, keys) => Object.fromEntries(keys.filter(key => Object.hasOwn(row || {}, key)).map(key => [key, row[key]]));
const project = (db, report) => unique(db.projects, db.projects?.[report.project]?.id, 'Project');
function parse(input) {
  if (!object(input, ['requestId', 'projectId', 'reportId', 'workdayId', 'source', 'phase', 'caption', 'tags', 'file']) || typeof input.requestId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(input.requestId) || !positive(input.projectId) || !positive(input.reportId) || Object.hasOwn(input, 'workdayId') && input.workdayId !== null && !positive(input.workdayId) || !['office', 'field'].includes(input.source)) fail(400, 'Choose one photo and an explicit Draft report/project');
  if (Object.hasOwn(input, 'phase') && input.phase !== null && !['start', 'end'].includes(input.phase) || Object.hasOwn(input, 'caption') && (typeof input.caption !== 'string' || input.caption.length > 500) || Object.hasOwn(input, 'tags') && (!Array.isArray(input.tags) || input.tags.length > 12 || input.tags.some(tag => typeof tag !== 'string' || tag.length > 100))) fail(400, 'Use valid photo caption, phase and tags');
  const file = input.file;
  if (!object(file, ['type', 'bytes', 'sha256', 'lastModified']) || typeof file.type !== 'string' || !Object.hasOwn(storage.types, file.type) || !Number.isSafeInteger(file.bytes) || file.bytes < 1 || file.bytes > storage.maxBytes || typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256) || Object.hasOwn(file, 'lastModified') && (!Number.isSafeInteger(file.lastModified) || file.lastModified < 0 || !Number.isFinite(new Date(file.lastModified).getTime()))) fail(400, 'Choose a nonempty valid JPG, PNG or WebP photo');
  return structuredClone(input);
}
function authorize(db, user, details, write = true) {
  const report = unique(db.reports, details.reportId, 'Report');
  if (daily.field(user)) unique(db.team, user.memberId, 'Linked photo member');
  const memberIds = (report.laborEntries || []).map(row => row.memberId);
  if (new Set(memberIds.map(Number)).size !== memberIds.length) fail(409, 'Report crew identity needs reconciliation');
  for (const id of memberIds) unique(db.team, id, 'Report crew member');
  if (!daily.reportInScope(db, user, report, write ? 'editReports' : 'viewReports') || Number(project(db, report).id) !== Number(details.projectId)) fail(404, 'Report photo not found');
  if (write && report.status !== 'Draft') fail(409, 'This bounded upload requires an existing Draft report');
  if (write && daily.field(user) && details.source !== 'field') fail(403, 'Field photos retain their field source');
  const days = [...new Set([details.workdayId, report.workdayId].filter(id => id != null).map(Number))];
  if (days.length > 1) fail(409, 'Photo workday/report bindings need reconciliation');
  const day = days.length ? unique(db.workdays, days[0], 'Workday') : null;
  if (day) { if (!Array.isArray(day.memberIds) || new Set(day.memberIds.map(Number)).size !== day.memberIds.length) fail(409, 'Workday crew identity needs reconciliation'); for (const id of day.memberIds) unique(db.team, id, 'Workday crew member'); }
  if (day && (!daily.workdayInScope(db, user, day, write ? 'runWorkdays' : 'viewWorkdays') || Number(day.projectId) !== Number(details.projectId) || Number(day.reportId) !== Number(report.id) || Number(report.workdayId) !== Number(day.id))) fail(409, 'Photo workday/report bindings need reconciliation');
  return canonicalHash({ report, day, project: project(db, report) });
}
function descriptor(intent) { return { bucket: 'project-photos', key: intent.key, ...pick(intent.details.file, ['type', 'bytes', 'sha256']) }; }
function validateIntent(db, intent) {
  const hashes = ['sessionHash', 'tokenHash', 'actorHash', 'sourceHash', 'version'];
  const keys = ['id', 'companyId', 'actorId', 'sessionHash', 'details', 'key', 'createdAt', 'state', 'tokenHash', 'actorHash', 'sourceHash', 'expectedRevision', 'version', 'expiresAt', 'photoId', 'photoHash', 'inputHash', 'committedAt'];
  const instant = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
  if (!object(intent, keys) || !storage.uuid.test(intent.id) || intent.companyId !== db.company.id || !positive(intent.actorId) || !instant(intent.createdAt) || !['pending', 'committed'].includes(intent.state) || hashes.some(key => typeof intent[key] !== 'string' || !/^[a-f0-9]{64}$/.test(intent[key])) || !Number.isSafeInteger(intent.expectedRevision) || intent.expectedRevision < 1 || !Number.isSafeInteger(intent.expiresAt) || intent.expiresAt < 0) fail(409, 'Photo proof needs reconciliation');
  let details; try { details = parse(intent.details); } catch { fail(409, 'Photo proof details need reconciliation'); }
  if (intent.key !== db.company.id + '/atomic-photos/' + intent.id + '/photo.' + storage.types[details.file.type] || intent.version !== canonicalHash(pick(intent, ['tokenHash', 'actorHash', 'sourceHash', 'expectedRevision', 'id', 'details']))) fail(409, 'Photo proof identity needs reconciliation');
  if ((db.photoUploadIntents || []).filter(row => row.id === intent.id).length !== 1 || (db.photoUploadIntents || []).filter(row => row.key === intent.key).length !== 1 || (db.photoUploadIntents || []).filter(row => Number(row.actorId) === Number(intent.actorId) && row.details?.requestId === details.requestId).length !== 1) fail(409, 'Duplicate photo proof needs reconciliation');
  if (intent.state === 'committed' ? !positive(intent.photoId) || !instant(intent.committedAt) || ['photoHash', 'inputHash'].some(key => typeof intent[key] !== 'string' || !/^[a-f0-9]{64}$/.test(intent[key])) : ['photoId', 'photoHash', 'inputHash', 'committedAt'].some(key => Object.hasOwn(intent, key))) fail(409, 'Photo proof state needs reconciliation');
  storage.validate(db.company.id, descriptor(intent)); return details;
}
function photoBindings(details, createdAt) {
  return { reportId: Number(details.reportId), workdayId: details.workdayId ? Number(details.workdayId) : null, phase: details.phase || null, source: details.source, caption: details.caption || '', tags: [...new Set((details.tags || []).map(tag => tag.trim().toLowerCase()).filter(Boolean))], capturedAt: details.file.lastModified ? new Date(details.file.lastModified).toISOString() : createdAt };
}
function photoDescriptor(db, photo) {
  const value = { bucket: photo.storageBucket, key: photo.storageKey, type: photo.contentType, bytes: photo.storageBytes, sha256: photo.storageSha256 };
  storage.validate(db.company.id, value);
  if (photo.url !== '/api/files/project-photos/' + value.key.split('/').map(encodeURIComponent).join('/')) fail(409, 'Photo storage mapping needs reconciliation');
  const aliases = [];
  const add = row => { if (row && ((row.storageBucket === value.bucket && row.storageKey === value.key) || (row.bucket === value.bucket && row.objectKey === value.key) || row.url === photo.url)) aliases.push(row); };
  for (const row of [...(db.photos || []), ...(db.projectPlans || []), ...(db.projectTickets || []), ...(db.estimateImports || [])]) add(row);
  add(db.company.logo);
  for (const item of db.projects || []) for (const row of item.estimateProposals || []) add(row.sourceFile);
  if (aliases.length !== 1 || aliases[0] !== photo) fail(409, 'Shared photo storage mappings need reconciliation');
  const intents = (db.photoUploadIntents || []).filter(row => row.key === value.key);
  if (intents.length !== 1 || intents[0].companyId !== db.company.id || intents[0].state !== 'committed' || Number(intents[0].photoId) !== Number(photo.id) || intents[0].photoHash !== canonicalHash(photo) || !equal(value, descriptor(intents[0]))) fail(409, 'Photo has no unique committed upload binding');
  const details = validateIntent(db, intents[0]);
  if (Number(db.projects?.[photo.project]?.id) !== Number(details.projectId) || !equal(pick(photo, ['reportId', 'workdayId', 'phase', 'source', 'caption', 'tags', 'capturedAt']), photoBindings(details, photo.createdAt))) fail(409, 'Photo target changed from its original upload reservation');
  return value;
}
const present = photo => pick(photo, ['id', 'project', 'reportId', 'workdayId', 'phase', 'source', 'caption', 'tags', 'capturedAt', 'uploader', 'createdAt', 'url']);
function decode(input, intent) {
  if (!object(input, ['token', 'version', 'confirmed', 'requestId', 'files']) || input.confirmed !== true || typeof input.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(input.token) || Buffer.from(input.token, 'base64url').toString('base64url') !== input.token || typeof input.version !== 'string' || !/^[a-f0-9]{64}$/.test(input.version) || input.requestId !== intent.details.requestId || !Array.isArray(input.files) || input.files.length !== 1) fail(400, 'Preview and explicitly confirm one photo with its request ID');
  const file = input.files[0], expected = intent.details.file;
  if (!object(file, ['type', 'data', 'lastModified']) || file.type !== expected.type || !equal(file.lastModified, expected.lastModified) || typeof file.data !== 'string') fail(400, 'Confirmed photo must match the preview');
  const match = file.data.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match || match[1] !== expected.type) fail(400, 'Use a canonical photo data URL');
  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.toString('base64') !== match[2] || bytes.length !== expected.bytes || storage.digest(bytes) !== expected.sha256) fail(400, 'Confirmed photo bytes must match the preview');
  return bytes;
}
function createHandler({ readDb, writeDb, body, json, raw, revision, assertCurrent, store, now = () => Date.now() }) {
  return async function handle(req, res, url) {
    const preview = req.method === 'POST' && url.pathname === '/api/photos/upload-preview', confirm = req.method === 'POST' && url.pathname === '/api/photos';
    const manifest = req.method === 'GET' && url.pathname === '/api/photos/recovery-manifest';
    const idMatch = req.method === 'GET' && url.pathname.match(/^\/api\/photos\/(\d+)(?:\/(file|export))?$/);
    const keyMatch = req.method === 'GET' && url.pathname.match(/^\/api\/files\/project-photos\/([0-9a-f-]{36})\/atomic-photos\/([0-9a-f-]{36})\/photo\.(jpg|png|webp)$/);
    if (!preview && !confirm && !manifest && !idMatch && !keyMatch) return false;
    const db = readDb(), user = req.auth.user;
    try {
      if (manifest) {
        if (user.role !== 'owner') fail(403, 'Account owner permission required');
        const objects = (db.photoUploadIntents || []).map(intent => { validateIntent(db, intent); return { id: intent.id, referenceState: intent.state === 'committed' ? 'committed' : 'reserved-uncommitted', objectPresence: 'not-certified-by-manifest', photoId: intent.photoId || null, projectId: intent.details.projectId, reportId: intent.details.reportId, workdayId: intent.details.workdayId || null, ...descriptor(intent) }; });
        await assertCurrent(req); json(res, 200, { format: 'pdl-photo-recovery-inventory-v1', companyId: db.company.id, objects, message: 'Preserve reserved and committed objects. This inventory does not certify object presence or authorize cleanup.' }); return true;
      }
      if (idMatch || keyMatch) {
        if (idMatch?.[2] === 'export' && user.role !== 'owner') fail(403, 'Account owner permission required');
        let photo;
        if (idMatch) photo = unique(db.photos, idMatch[1], 'Photo');
        else { if (keyMatch[1] !== db.company.id) fail(404, 'Photo not found'); const key = url.pathname.slice('/api/files/project-photos/'.length), rows = (db.photos || []).filter(row => row.storageBucket === 'project-photos' && row.storageKey === key); if (rows.length !== 1) fail(rows.length ? 409 : 404, 'Photo not found'); photo = rows[0]; }
        const value = photoDescriptor(db, photo);
        const intent = db.photoUploadIntents.find(row => row.key === value.key);
        authorize(db, user, intent.details, false);
        if (idMatch && !idMatch[2]) { await assertCurrent(req); json(res, 200, present(photo)); return true; }
        const bytes = await store.get(db.company.id, value); await assertCurrent(req);
        raw(res, { status: 200, headers: { 'Content-Type': value.type, 'Content-Length': String(bytes.length), 'Cache-Control': 'private, no-store', 'Content-Disposition': idMatch?.[2] === 'export' ? 'attachment; filename="photo.' + storage.types[value.type] + '"' : 'inline', 'X-Content-Type-Options': 'nosniff' }, raw: bytes }); return true;
      }
      const input = await body(req);
      if (preview) {
        const details = parse(input), sourceHash = authorize(db, user, details), intents = db.photoUploadIntents || [];
        const existing = intents.filter(row => row.actorId === user.id && row.details?.requestId === details.requestId); if (existing.length > 1) fail(409, 'Photo intent identity needs reconciliation');
        let intent = existing[0];
        if (intent) validateIntent(db, intent);
        if (intent && (!equal(intent.details, details) || intent.sessionHash !== req.auth.session.tokenHash || intent.companyId !== db.company.id)) fail(409, 'Photo request already belongs to a different upload or session');
        if (intent?.state === 'committed') fail(409, 'Photo already committed; verify the saved photo or replay its exact confirmation');
        if (!intent && intents.length >= 200) fail(409, 'Photo staging retention requires reconciliation before more uploads');
        const token = crypto.randomBytes(32).toString('base64url'), tokenHash = canonicalHash(token), actorHash = dailyAuthority(db, req), expectedRevision = revision() + 1;
        if (!intent) { const id = crypto.randomUUID(); intent = { id, companyId: db.company.id, actorId: user.id, sessionHash: req.auth.session.tokenHash, details, key: db.company.id + '/atomic-photos/' + id + '/photo.' + storage.types[details.file.type], createdAt: new Date(now()).toISOString(), state: 'pending' }; intents.push(intent); }
        storage.validate(db.company.id, descriptor(intent));
        const version = canonicalHash({ tokenHash, actorHash, sourceHash, expectedRevision, id: intent.id, details }); Object.assign(intent, { tokenHash, actorHash, sourceHash, expectedRevision, version, expiresAt: now() + 600000 });
        db.photoUploadIntents = intents; db.auditLog ||= []; db.auditLog.push({ id: crypto.randomUUID(), type: 'photo_upload_previewed', actorId: user.id, intentId: intent.id, at: new Date(now()).toISOString() });
        writeDb(db); json(res, 200, { token, version, requestId: details.requestId, details, message: 'Review and explicitly confirm this image. Preview reserves a private key and audit only; matching request retries retain that key. Unknown outcomes never authorize deletion.' }); return true;
      }
      if (!input || typeof input.token !== 'string') fail(400, 'Preview and explicitly confirm one photo');
      const matches = (db.photoUploadIntents || []).filter(row => row.tokenHash === canonicalHash(input.token)); if (matches.length !== 1) fail(409, 'Photo preview not found');
      const intent = matches[0], details = validateIntent(db, intent); if (!equal(details, intent.details) || intent.companyId !== db.company.id || intent.actorId !== user.id || intent.sessionHash !== req.auth.session.tokenHash || intent.version !== input.version || intent.actorHash !== dailyAuthority(db, req)) fail(409, 'Photo authority changed; review the upload again');
      const sourceHash = authorize(db, user, details, intent.state !== 'committed');
      if (intent.state === 'committed' && !daily.access(db, user).editReports) fail(403, 'Current photo upload permission required');
      if (sourceHash !== intent.sourceHash) fail(409, 'Photo report/workday changed; review again');
      const bytes = decode(input, intent), inputHash = canonicalHash(input), value = descriptor(intent); storage.validate(db.company.id, value);
      if (intent.state === 'committed') {
        const photo = unique(db.photos, intent.photoId, 'Photo'); if (intent.inputHash !== inputHash || !equal(intent.photoHash, canonicalHash(photo)) || !equal(value, photoDescriptor(db, photo))) fail(409, 'Committed photo changed; verify its saved identity');
        await store.get(db.company.id, value); await assertCurrent(req); json(res, 200, [present(photo)]); return true;
      }
      if (intent.state !== 'pending' || intent.expectedRevision !== revision() || intent.expiresAt < now()) fail(409, 'Company changed or photo preview expired; review again with the same request');
      const ids = (db.photos || []).map(row => row.id), photoId = ids.reduce((maximum, id) => Math.max(maximum, Number(id)), 0) + 1;
      if (ids.some(id => !positive(id)) || new Set(ids.map(Number)).size !== ids.length || !Number.isSafeInteger(photoId)) fail(409, 'Photo identities need reconciliation');
      await assertCurrent(req); await store.put(db.company.id, value, bytes); await assertCurrent(req);
      const createdAt = new Date(now()).toISOString();
      const photo = { id: photoId, project: db.projects.findIndex(row => Number(row.id) === Number(details.projectId)), ...photoBindings(details, createdAt), uploader: user.name, createdAt, url: '/api/files/project-photos/' + value.key.split('/').map(encodeURIComponent).join('/'), storageBucket: value.bucket, storageKey: value.key, contentType: value.type, storageBytes: value.bytes, storageSha256: value.sha256 };
      db.photos ||= []; db.photos.push(photo); Object.assign(intent, { state: 'committed', photoId: photo.id, photoHash: canonicalHash(photo), inputHash, committedAt: new Date(now()).toISOString() }); photoDescriptor(db, photo);
      db.auditLog ||= []; db.auditLog.push({ id: crypto.randomUUID(), type: 'photo_upload_committed', actorId: user.id, intentId: intent.id, photoId: photo.id, at: new Date(now()).toISOString() }); writeDb(db); json(res, 201, [present(photo)]); return true;
    } catch (error) { if (![400, 401, 402, 403, 404, 409, 503].includes(error.statusCode)) throw error; json(res, error.statusCode, { error: error.message }); return true; }
  };
}
module.exports = { parse, authorize, descriptor, validateIntent, photoDescriptor, decode, present, createHandler };
