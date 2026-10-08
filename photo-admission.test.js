'use strict';
const assert = require('node:assert/strict'), crypto = require('node:crypto'), fs = require('node:fs');
const { fixture } = require('./fixtures/project-assistant');
const admission = require('./photo-admission'), storage = require('./database/atomic-photo-store');
async function main() {
  const db = fixture(), pm = db.users.find(row => row.id === 2), field = db.users.find(row => row.id === 4);
  pm.permissions = { viewDailies: true, approveDailies: true, manageTime: true };
  db.reports = [{ id: 51, project: 0, status: 'Draft', foreman: field.name, laborEntries: [{ memberId: 11, hours: 1, crew: 'A' }], history: [], signature: 'Original signature' }];
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'), details = { requestId: crypto.randomUUID(), projectId: 101, reportId: 51, source: 'field', file: { type: 'image/png', bytes: bytes.length, sha256: storage.digest(bytes), lastModified: 0 } };
  admission.authorize(db, field, admission.parse(details));
  for (const bad of [{ ...details, project: 0 }, { ...details, permissions: { aiAssistant: true } }, { ...details, reportId: undefined }, { ...details, file: { ...details.file, type: ['image/png'] } }, { ...details, file: { ...details.file, bytes: 0 } }, { ...details, file: { ...details.file, lastModified: 9e15 } }]) assert.throws(() => admission.parse(bad), { statusCode: 400 });
  db.reports[0].laborEntries.push({ memberId: 13, hours: 1, crew: 'B' }); for (const actor of [field, pm]) assert.throws(() => admission.authorize(db, actor, details), { statusCode: 404 }); db.reports[0].laborEntries.pop();
  db.team.push({ ...db.team[0], id: ' 11 ', crew: 'B' }); for (const actor of [field, pm]) assert.throws(() => admission.authorize(db, actor, details), { statusCode: 409 }); db.team.pop();
  db.reports[0].status = 'Approved'; assert.throws(() => admission.authorize(db, pm, details), { statusCode: 409 }); db.reports[0].status = 'Draft';
  db.workdays = [{ id: 81, projectId: 102, memberIds: [11], reportId: 51 }]; assert.throws(() => admission.authorize(db, pm, { ...details, workdayId: 81 }), { statusCode: 409 }); db.workdays = [];
  const intent = { details }, confirm = { token: 'A'.repeat(43), version: 'b'.repeat(64), confirmed: true, requestId: details.requestId, files: [{ type: 'image/png', lastModified: 0, data: 'data:image/png;base64,' + bytes.toString('base64') }] };
  assert.deepEqual(admission.decode(confirm, intent), bytes);
  for (const file of [{ ...confirm.files[0], data: 'data:image/jpeg;base64,' + bytes.toString('base64') }, { ...confirm.files[0], data: confirm.files[0].data + '\n' }, { ...confirm.files[0], lastModified: 1 }, { ...confirm.files[0], data: 'data:image/png;base64,AAAA' }]) assert.throws(() => admission.decode({ ...confirm, files: [file] }, intent), { statusCode: 400 });
  const objects = new Map(), calls = [], descriptor = { bucket: 'project-photos', key: db.company.id + '/atomic-photos/' + crypto.randomUUID() + '/photo.png', ...details.file };
  delete descriptor.lastModified; let privateBucket = true, drop = true;
  const request = async (url, input = {}) => {
    calls.push({ url, method: input.method || 'GET' });
    if (url === '/storage/v1/bucket/project-photos') return Response.json({ id: 'project-photos', public: !privateBucket, file_size_limit: storage.maxBytes, allowed_mime_types: ['image/png'] });
    if (input.method === 'POST') { assert.equal(input.headers['x-upsert'], 'false'); if (objects.has(url)) throw { providerStatus: 409 }; objects.set(url, { bytes: Buffer.from(input.body), type: input.headers['Content-Type'] }); if (drop) { drop = false; throw Error('Synthetic lost upload acknowledgement'); } return Response.json({}); }
    const value = objects.get(url); if (!value) throw { providerStatus: 404 }; return new Response(value.bytes, { headers: { 'Content-Type': value.type } });
  };
  const oldFlag = process.env.PDL_TENANT_ATOMIC; process.env.PDL_TENANT_ATOMIC = '1';
  try {
    const store = storage.createStore(request); await store.put(db.company.id, descriptor, bytes); assert.deepEqual(await store.get(db.company.id, descriptor), bytes);
    const uploads = calls.filter(row => row.method === 'POST').length; await store.put(db.company.id, descriptor, bytes); assert.equal(calls.filter(row => row.method === 'POST').length, uploads, 'Retry reuses the immutable verified object');
    privateBucket = false; await assert.rejects(store.get(db.company.id, descriptor), { statusCode: 503 }); privateBucket = true;
    const address = calls.find(row => row.method === 'POST').url; objects.get(address).bytes = Buffer.from('Wrong bytes'); await assert.rejects(store.get(db.company.id, descriptor), { statusCode: 503 });
    const before = calls.length; await assert.rejects(store.get('22222222-2222-4222-8222-222222222222', descriptor), { statusCode: 503 }); assert.equal(calls.length, before);
    assert.ok(!calls.some(row => row.method === 'DELETE' || row.url === '/storage/v1/bucket'));
  } finally { if (oldFlag === undefined) delete process.env.PDL_TENANT_ATOMIC; else process.env.PDL_TENANT_ATOMIC = oldFlag; }
  const source = fs.readFileSync('server.js', 'utf8'); assert.ok(source.includes('delete safe.photoUploadIntents;')); assert.ok(source.includes('photoUploadIntents:privatePhotoUploadIntents'));
  for (const route of ['/api/projects/101/plans', '/api/company/logo', '/api/guest/foreign', '/api/estimate-imports/analyze', '/api/local-files/legacy.jpg', '/api/photos/51/delete']) assert.equal(require('./database/tenant-atomic-routes').supportedRoute('POST', route), false);
  console.log('Photo admission unit passed: finite one-image inputs/bytes, Draft and entire crew/workday boundaries, immutable private/no-upsert keys, lost upload acknowledgement/readback/retry, changed object/private bucket/tenant rejection and no-delete/no-provisioning.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
