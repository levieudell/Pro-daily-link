'use strict';
// Actual normal HTTP server, native adapter's closed memory CAS transport,
// owned image bytes and generated accounts. No compatibility test installer.
const assert = require('node:assert/strict'), crypto = require('node:crypto'), fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { canonicalHash } = require('./database/transactional-repository');
const nativeFetch = globalThis.fetch, blobs = new Map();
let origin, requests = 0, imageWrites = 0, casWrites = 0, companyReads = 0, uploadHook = null, beforeRead = null, commitHook = null;
globalThis.fetch = (input, options) => {
  const target = String(input?.url || input);
  assert.ok(origin && target.startsWith(origin + '/'), 'Only this fixture-owned loopback server may use a network socket');
  return nativeFetch(input, options);
};
const supabase = require('./database/supabase');
supabase.loadLocalEnv = () => {};
supabase.upload = async (bucket, key, bytes, type) => {
  imageWrites++; assert.equal(bucket, 'project-photos');
  blobs.set(bucket + '/' + key, { bytes: Buffer.from(bytes), type });
  if (uploadHook) await uploadHook({ bucket, key, bytes: Buffer.from(bytes), type, ordinal: imageWrites });
  return { bucket, objectKey: key, url: '/api/files/' + bucket + '/' + key };
};
supabase.download = async (bucket, key) => { const row = blobs.get(bucket + '/' + key); assert.ok(row, 'Only fixture-owned bytes may be read'); return new Response(row.bytes, { headers: { 'Content-Type': row.type } }); };
supabase.remove = async () => { throw Error('This fixture does not authorize cleanup of admitted image bytes'); };
const fixture = require('./roles-production-http.test'), { server } = fixture;
const ownedDirectory = path.resolve(path.dirname(process.env.PDL_DB_FILE));
assert.ok(ownedDirectory.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(ownedDirectory).startsWith('pdl-roles-production-http-'), 'Cleanup stays in the exact owned temporary directory');
const request = supabase.request;
supabase.request = async (route, options) => {
  if (route.startsWith('/rest/v1/companies?')) { companyReads++; if (beforeRead) await beforeRead(); }
  const response = await request(route, options);
  if (/^\/rest\/v1\/rpc\/commit_roles_snapshot(?:_with_platform)?$/.test(route)) { casWrites++; if (commitHook) await commitHook(JSON.parse(options.body)); }
  return response;
};
const intake = require('./roles-report-intake'), registry = require('./capability-registry');
const templateId = crypto.randomUUID();
const pmToken = crypto.randomBytes(32).toString('base64url'); fixture.tokens.set(4, pmToken);
function policy(db, familyName, role, flags) {
  const [, , prefix, , family] = registry.families.find(row => row[0] === familyName);
  db.company[prefix + 'PolicyRequired'] = true;
  db.company[prefix + 'RolePolicy'] ||= { version: 1, revision: 1, roles: Object.fromEntries(family.roles.map(role => [role, family.ceiling(role)])) };
  Object.assign(db.company[prefix + 'RolePolicy'].roles[role], flags);
}
fixture.alter(db => {
  policy(db, 'daily', 'field', { viewReports: true, createReports: true, editReports: false, approveReports: false, runWorkdays: false });
  for (const familyName of ['timeWrite', 'timeReview']) {
    const family = registry.families.find(row => row[0] === familyName)[4];
    policy(db, familyName, 'field', Object.fromEntries(family.actions.map(name => [name, false])));
  }
  db.dailyTemplates = [{ id: templateId, name: 'Synthetic required photo', category: 'daily', description: 'Owned synthetic fixture', requirements: { photo: true, signature: true, acknowledgement: false }, assignment: { crewNames: [], workTypes: [] }, versions: [{ version: 1, fields: [], createdAt: null, createdBy: null }] }];
  db.projects[0].templateId = templateId; db.projects[0].templateIds = [templateId]; db.projects[0].templateVersion = 1;
  db.projects.push({ id: 102, name: 'Foreign synthetic project', estimateItems: [{ id: 1, name: 'Synthetic wall tile', unit: 'SF', plannedQuantity: 100, budgetHours: 10, cost: 500 }] });
  db.team.push({ id: 13, name: 'Foreign synthetic member', crew: 'Foreign crew' });
  db.users.push({ id: 4, companyId: fixture.A, name: 'Synthetic restricted PM', email: 'pm@example.invalid', role: 'project_manager', status: 'Active', projectIds: [101], assignedCrews: ['Synthetic Crew'], permissions: { viewDailies: true, approveDailies: true, scheduleCrews: true } });
  db.sessions.push({ id: crypto.randomUUID(), companyId: fixture.A, userId: 4, tokenHash: crypto.createHash('sha256').update(pmToken).digest('hex'), createdAt: new Date().toISOString(), expiresAt: '2099-01-01T00:00:00.000Z' });
  policy(db, 'daily', 'project_manager', { viewReports: true, createReports: false, editReports: false, approveReports: false, runWorkdays: false });
});
function report(overrides = {}) {
  return { projectId: 101, sourceAssignmentId: null, dateIso: '2098-10-12', status: 'Needs review', notes: 'Synthetic field work', crew: 'Synthetic Crew', foreman: 'Synthetic Field', signature: 'Synthetic Field', summary: 'Synthetic reviewed work', labor: '1 hour', quantity: '1 SF', issue: '', next: 'Synthetic next step', weather: 'Clear', temperature: '70', materials: '', equipment: '', delays: '', safety: '', templateId, templateVersion: 1, customFields: {}, productionEntries: [{ estimateItemId: 1, description: 'Synthetic wall tile', quantity: 1, unit: 'SF', laborHours: 1 }], laborEntries: [{ memberId: 12, hours: 1 }], ...overrides };
}
function file(label) {
  const bytes = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from('fixture-owned-' + label)]);
  return { name: label + '.png', type: 'image/png', data: 'data:image/png;base64,' + bytes.toString('base64'), lastModified: 0 };
}
function compound(label, overrides = {}, count = 1) { return { report: report(overrides), files: Array.from({ length: count }, (_, index) => file(label + '-' + index)), caption: 'Synthetic evidence ' + label, tags: ['FIELD', 'field'] }; }
async function call(method, route, { body, user = 2, company = fixture.A, operationId = crypto.randomUUID(), token } = {}) {
  requests++;
  const response = await fetch(origin + route, { method, signal: AbortSignal.timeout(15000), headers: { 'X-PDL-Company': company, Authorization: 'Bearer ' + (token || fixture.tokens.get(user)), 'Content-Type': 'application/json', ...(method === 'GET' ? {} : { 'X-PDL-Operation': operationId }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, data: await response.json() };
}
const okay = (response, status = 200) => { assert.equal(response.status, status, JSON.stringify(response.data)); return response.data; };
const business = db => Object.fromEntries(Object.entries(db).filter(([name]) => !['rolesProviderAttempts', intake.collection].includes(name)));
const rowFor = operationId => fixture.read()[intake.collection].find(row => row.operationId === operationId);
async function main() {
  let journeys = 0;
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); }); origin = 'http://127.0.0.1:' + server.address().port;
    let before = canonicalHash(fixture.read()), writes = imageWrites;
    for (const body of [{ ...report({ status: 'Draft' }), extracted: report() }, { ...report({ status: 'Draft' }), extracted: { summary: 'Synthetic', role: 'owner' } }]) assert.equal((await call('POST', '/api/reports', { body })).status, 400);
    assert.equal(canonicalHash(fixture.read()), before); assert.equal(imageWrites, writes); journeys++;
    assert.equal((await call('POST', '/api/reports', { user: 4, body: compound('restricted-pm') })).status, 403, 'Stored PM grants cannot override the current typed create restriction');
    assert.equal((await call('POST', '/api/reports', { body: compound('foreign-project', { projectId: 102 }) })).status, 403);
    assert.equal((await call('POST', '/api/reports', { body: compound('mixed-crew', { laborEntries: [{ memberId: 12, hours: 0.5 }, { memberId: 13, hours: 0.5 }] }) })).status, 403);
    assert.equal(canonicalHash(fixture.read()), before, 'Denied source/project/whole-crew scope cannot create custody or business data'); assert.equal(imageWrites, writes); journeys++;
    const payload = report({ status: 'Draft' }), extraction = intake.projectExtracted({ ...payload, originalLanguage: 'es', englishTranslation: 'Synthetic English translation', source: 'synthetic' });
    const oldDraft = okay(await call('POST', '/api/reports', { body: { ...payload, extracted: extraction } }), 201);
    assert.equal(oldDraft.noteLanguage, 'es'); assert.equal(oldDraft.englishTranslation, 'Synthetic English translation');
    assert.ok(!('source' in oldDraft) && !('warning' in oldDraft)); journeys++;
    const input = compound('complete', { reportType: 'superintendent', safetyItems: [{ observation: 'Synthetic guarded opening', location: 'Synthetic room', company: 'Synthetic contractor', notified: 'Synthetic supervisor', action: 'Synthetic barrier', owner: 'Synthetic foreman', dueDate: '2098-10-12', status: 'open', verification: '' }], safetyTalk: 'Synthetic safety talk', safetyTalkAttendees: 'Synthetic crew', safetyInspection: 'Synthetic inspection', safetyIncident: 'No synthetic incident', noSafetyObservations: false }, 2);
    const operationId = crypto.randomUUID(), initial = fixture.read(), originalOldDraft = initial.reports.find(row => row.id === oldDraft.id), originalGrants = structuredClone(initial.users.find(row => row.id === 2).permissions);
    const completed = okay(await call('POST', '/api/reports', { body: input, operationId }), 201);
    assert.notEqual(completed.report.id, oldDraft.id, 'Create-only intent cannot silently merge an existing same-key Draft');
    assert.equal(completed.report.status, 'Needs review'); assert.equal(completed.report.reportType, 'superintendent');
    for (const name of ['safetyItems', 'safetyTalk', 'safetyTalkAttendees', 'safetyInspection', 'safetyIncident', 'noSafetyObservations']) assert.deepEqual(completed.report[name], input.report[name]);
    let saved = fixture.read(), original = rowFor(operationId);
    assert.deepEqual(saved.reports.find(row => row.id === oldDraft.id), originalOldDraft); assert.deepEqual(saved.users.find(row => row.id === 2).permissions, originalGrants);
    for (const name of ['timeCards', 'workdays', 'payPeriods', 'payPeriodExports', 'projects']) assert.deepEqual(saved[name], initial[name], 'Compound create does not mutate ' + name);
    assert.equal(original.state, 'complete'); assert.equal(original.photos.length, 2); assert.equal(original.uploads.length, 2); assert.equal(original.reportHash, canonicalHash(saved.reports.find(row => row.id === original.reportId)));
    assert.ok(original.uploads.every(row => row.state === 'attached' && blobs.has(row.bucket + '/' + row.key)));
    assert.equal(imageWrites - writes, 2); journeys++;
    before = canonicalHash(saved); writes = imageWrites;
    assert.ok([403,404].includes((await call('PATCH', '/api/reports/' + completed.report.id, { body: report({ status: 'Draft', notes: 'Unauthorized edit' }) })).status));
    assert.ok([403,404].includes((await call('POST', '/api/photos', { body: { projectId: 101, source: 'field', reportId: completed.report.id, files: [file('standalone')] } })).status));
    assert.equal(canonicalHash(fixture.read()), before); assert.equal(imageWrites, writes); journeys++;
    // Discarding the original response models lost acknowledgment. Readback and
    // the original operation replay must recover references without dispatch.
    const recovered = okay(await call('GET', '/api/company/report-intakes/' + operationId));
    assert.equal(recovered.complete, true); assert.equal(recovered.report.id, completed.report.id); assert.deepEqual(recovered.files, completed.files); assert.equal(recovered.retryAllowed, false);
    const replay = okay(await call('POST', '/api/reports', { body: input, operationId }));
    assert.equal(replay.original, true); assert.deepEqual(replay.intake.report, recovered.report); assert.equal(imageWrites, writes); assert.equal(canonicalHash(fixture.read()), before); journeys++;
    fixture.alter(db => { db.projects[0].templateIds.push('standard'); });
    const noPhotoId = crypto.randomUUID(), noPhotoInput = { ...structuredClone(input), files: [], report: { ...input.report, templateId: 'standard', dateIso: '2098-10-13', notes: 'Synthetic no-photo superintendent' } };
    let commits = casWrites; writes = imageWrites;
    const noPhoto = okay(await call('POST', '/api/reports', { body: noPhotoInput, operationId: noPhotoId }), 201);
    assert.equal(casWrites - commits, 1, 'No-provider main and safety create effects commit once'); assert.equal(imageWrites, writes);
    assert.equal(noPhoto.report.status, 'Needs review'); assert.equal(noPhoto.report.reportType, 'superintendent'); assert.equal(noPhoto.report.safetyTalk, input.report.safetyTalk); assert.deepEqual(noPhoto.files, []);
    const noPhotoLookup = okay(await call('GET', '/api/company/report-intakes/' + noPhotoId)); assert.equal(noPhotoLookup.complete, true); assert.equal(noPhotoLookup.report.id, noPhoto.report.id); assert.deepEqual(noPhotoLookup.files, []);
    before = canonicalHash(fixture.read()); commits = casWrites;
    assert.equal(okay(await call('POST', '/api/reports', { body: noPhotoInput, operationId: noPhotoId })).original, true);
    assert.equal(canonicalHash(fixture.read()), before); assert.equal(casWrites, commits); journeys++;
    const lostAckId = crypto.randomUUID(), lostAckInput = { ...structuredClone(noPhotoInput), report: { ...noPhotoInput.report, notes: 'Synthetic lost final commit acknowledgment', dateIso: '2098-10-14' } };
    commitHook = async input => { if (input.p_snapshot[intake.collection]?.some(row => row.operationId === lostAckId && row.state === 'complete')) { commitHook = null; throw Error('Synthetic final COMMIT accepted, acknowledgment lost'); } };
    const lostAck = await call('POST', '/api/reports', { body: lostAckInput, operationId: lostAckId });
    assert.equal(lostAck.status, 503, JSON.stringify(lostAck.data)); assert.equal(lostAck.data.operationId, lostAckId, 'Unknown final COMMIT carries its original finite recovery reference');
    const readStart = companyReads, savedAck = okay(await call('GET', '/api/company/report-intakes/' + lostAckId)), readsPerLookup = companyReads - readStart;
    assert.equal(savedAck.complete, true); assert.equal(savedAck.report.notes, lostAckInput.report.notes); assert.deepEqual(savedAck.files, []);
    before = canonicalHash(fixture.read()); commits = casWrites;
    assert.equal(okay(await call('POST', '/api/reports', { body: lostAckInput, operationId: lostAckId })).original, true);
    assert.equal(canonicalHash(fixture.read()), before); assert.equal(casWrites, commits); journeys++;
    assert.ok(readsPerLookup >= 2, 'Normal read recovery performs an independent final current-return load');
    const finalRead = companyReads + readsPerLookup;
    beforeRead = async () => { if (companyReads === finalRead) { beforeRead = null; fixture.alter(db => { db.company.dailyRolePolicy.roles.field.viewReports = false; db.company.dailyRolePolicy.roles.field.createReports = false; }); } };
    const revokedRead = await call('GET', '/api/company/report-intakes/' + lostAckId);
    assert.equal(revokedRead.status, 409); assert.ok(!JSON.stringify(revokedRead.data).includes(lostAckInput.report.notes), 'Revocation on the final load prevents previously assembled report delivery');
    fixture.alter(db => { db.company.dailyRolePolicy.roles.field.viewReports = true; db.company.dailyRolePolicy.roles.field.createReports = true; }); journeys++;
    const noPhotoEdit = { report: { status: 'Needs review', notes: 'Synthetic edited superintendent', productionEntries: noPhotoInput.report.productionEntries, laborEntries: noPhotoInput.report.laborEntries, ...Object.fromEntries(require('./resource-report-variants').safetyFields.map(name => [name, noPhotoInput.report[name]])), safetyTalk: 'Synthetic edited safety talk' }, files: [], caption: '', tags: [] };
    assert.equal((await call('PATCH', '/api/reports/' + noPhoto.report.id, { body: noPhotoEdit })).status, 403);
    assert.equal(canonicalHash(fixture.read()), before, 'Create proof never grants a later independent edit');
    fixture.alter(db => { db.company.dailyRolePolicy.roles.field.editReports = true; }); commits = casWrites;
    const noPhotoEdited = okay(await call('PATCH', '/api/reports/' + noPhoto.report.id, { body: noPhotoEdit }));
    assert.equal(casWrites - commits, 1, 'No-provider main and safety edit effects commit once'); assert.equal(noPhotoEdited.report.notes, noPhotoEdit.report.notes); assert.equal(noPhotoEdited.report.safetyTalk, noPhotoEdit.report.safetyTalk); assert.equal(imageWrites, writes);
    fixture.alter(db => { db.company.dailyRolePolicy.roles.field.editReports = false; }); journeys++;
    before = canonicalHash(fixture.read()); commits = casWrites;
    const noPhotoRequired = await call('POST', '/api/reports', { body: { ...noPhotoInput, report: { ...noPhotoInput.report, templateId } } });
    assert.equal(noPhotoRequired.status, 409, JSON.stringify(noPhotoRequired.data)); assert.equal(canonicalHash(fixture.read()), before, 'Failed no-provider final validation saves neither partial report nor intake'); assert.equal(casWrites, commits); journeys++;
    assert.equal((await call('GET', '/api/company/report-intakes/' + operationId, { user: 1 })).status, 403);
    assert.equal((await call('GET', '/api/company/report-intakes/' + operationId, { company: fixture.B })).status, 404);
    const secondToken = crypto.randomBytes(32).toString('base64url'); fixture.alter(db => db.sessions.push({ id: crypto.randomUUID(), companyId: fixture.A, userId: 2, tokenHash: crypto.createHash('sha256').update(secondToken).digest('hex'), createdAt: new Date().toISOString(), expiresAt: '2099-01-01T00:00:00.000Z' }));
    assert.equal((await call('GET', '/api/company/report-intakes/' + operationId, { token: secondToken })).status, 403); journeys++;
    const signed = rowFor(operationId); fixture.alter(db => { db[intake.collection].find(row => row.operationId === operationId).reportId = oldDraft.id; });
    assert.equal((await call('GET', '/api/company/report-intakes/' + operationId)).status, 409);
    fixture.alter(db => { db[intake.collection] = db[intake.collection].map(row => row.operationId === operationId ? signed : row); db.reports.find(row => row.id === completed.report.id).notes = 'Changed after original completion'; });
    const changed = okay(await call('GET', '/api/company/report-intakes/' + operationId)); assert.equal(changed.state, 'changed'); assert.equal(changed.complete, false); assert.ok(!('report' in changed) && !('files' in changed)); journeys++;
    const revokedId = crypto.randomUUID(); writes = imageWrites;
    uploadHook = async () => { uploadHook = null; fixture.alter(db => { db.company.dailyRolePolicy.roles.field.createReports = false; }); };
    const revoked = await call('POST', '/api/reports', { body: compound('revoke', {}, 2), operationId: revokedId });
    assert.equal(revoked.status, 409, JSON.stringify(revoked.data)); assert.equal(imageWrites - writes, 1, 'Revocation during first upload prevents the second dispatch');
    original = rowFor(revokedId); assert.equal(original.state, 'pending'); assert.equal(original.uploads.length, 1); assert.equal(original.photos.length, 0);
    assert.equal(fixture.read().reports.find(row => row.id === original.reportId).status, 'Draft'); assert.equal(fixture.read().rolesProviderAttempts.find(row => row.operationId === revokedId).status, 'accepted');
    const revokedStatus = okay(await call('GET', '/api/company/report-intakes/' + revokedId)); assert.equal(revokedStatus.complete, false); assert.ok(!('report' in revokedStatus) && !('files' in revokedStatus)); journeys++;
    fixture.alter(db => { db.company.dailyRolePolicy.roles.field.createReports = true; });
    const unknownId = crypto.randomUUID(), uncertainInput = compound('unknown', {}, 2); writes = imageWrites;
    uploadHook = async ({ ordinal }) => { if (ordinal === writes + 2) { uploadHook = null; throw Error('Synthetic accepted bytes with unknown acknowledgment'); } };
    const uncertain = await call('POST', '/api/reports', { body: uncertainInput, operationId: unknownId });
    assert.equal(uncertain.status, 503, JSON.stringify(uncertain.data)); assert.equal(uncertain.data.code, 'PDL_PROVIDER_OUTCOME_UNKNOWN'); assert.equal(uncertain.data.operationId, unknownId);
    original = rowFor(unknownId); saved = fixture.read(); assert.equal(original.uploads.length, 2); assert.equal(original.photos.length, 1); assert.equal(original.state, 'pending');
    assert.ok(original.uploads.every(row => blobs.has(row.bucket + '/' + row.key)), 'Both original predispatch keys remain private for reconciliation');
    assert.equal(saved.reports.find(row => row.id === original.reportId).status, 'Draft'); assert.equal(saved.photos.filter(row => row.reportId === original.reportId).length, 1);
    const unknownStatus = okay(await call('GET', '/api/company/report-intakes/' + unknownId)); assert.equal(unknownStatus.state, 'unknown'); assert.ok(!('report' in unknownStatus) && !('files' in unknownStatus));
    before = canonicalHash(saved); writes = imageWrites;
    assert.equal((await call('POST', '/api/reports', { body: uncertainInput, operationId: unknownId })).status, 409);
    assert.equal((await call('POST', '/api/reports', { body: uncertainInput })).status, 409);
    assert.equal(canonicalHash(fixture.read()), before, 'Neither original nor new operation may create another Draft after an unknown upload'); assert.equal(imageWrites, writes); journeys++;
    fixture.alter(db => { db.dailyTemplates[0].versions[0].fields = [{ id: 'synthetic-required', label: 'Synthetic required field', type: 'text', required: true }]; });
    const partialId = crypto.randomUUID(); writes = imageWrites;
    const partial = await call('POST', '/api/reports', { body: compound('known-final-failure'), operationId: partialId });
    assert.equal(partial.status, 400, JSON.stringify(partial.data)); assert.equal(partial.data.operationId, partialId, 'Known final failure retains the original recovery reference'); assert.equal(imageWrites - writes, 1);
    original = rowFor(partialId); assert.equal(original.state, 'pending'); assert.equal(original.photos.length, 1); assert.equal(original.uploads[0].state, 'attached');
    assert.equal(fixture.read().reports.find(row => row.id === original.reportId).status, 'Draft');
    const partialStatus = okay(await call('GET', '/api/company/report-intakes/' + partialId)); assert.equal(partialStatus.state, 'pending'); assert.ok(!('report' in partialStatus)); journeys++;
    fixture.alter(db => { policy(db, 'daily', 'admin', { viewReports: true, createReports: false, editReports: true, approveReports: false, runWorkdays: false }); });
    const approvedEdit = { report: { status: 'Approved', notes: 'Synthetic approved correction', productionEntries: fixture.read().reports.find(row => row.id === 1).productionEntries, laborEntries: fixture.read().reports.find(row => row.id === 1).laborEntries, reportType: 'superintendent', safetyTalk: 'Synthetic approved safety correction' }, files: [file('approved-edit')], caption: 'Approved synthetic evidence', tags: [] };
    before = canonicalHash(fixture.read()); writes = imageWrites;
    assert.equal((await call('PATCH', '/api/reports/1', { user: 3, body: approvedEdit })).status, 403);
    assert.equal(canonicalHash(fixture.read()), before); assert.equal(imageWrites, writes, 'Original approved correction needs separate approval before dispatch');
    fixture.alter(db => { db.company.dailyRolePolicy.roles.admin.approveReports = true; });
    const approvedOriginal = fixture.read().reports.find(row => row.id === 1), approvedCorrected = okay(await call('PATCH', '/api/reports/1', { user: 3, body: approvedEdit }));
    assert.equal(approvedCorrected.report.status, 'Approved'); assert.equal(approvedCorrected.report.notes, approvedEdit.report.notes); assert.equal(imageWrites - writes, 1);
    const approvedSaved = fixture.read().reports.find(row => row.id === 1);
    assert.deepEqual(approvedSaved.history.slice(0, approvedOriginal.history.length), approvedOriginal.history);
    for (const name of ['project', 'rateSnapshot', 'rateHistory', 'rateReview', 'workdayId', 'sourceAssignmentId']) assert.deepEqual(approvedSaved[name], approvedOriginal[name], 'Approved intake retains original ' + name); journeys++;
    const normalState = okay(await call('GET', '/api/state', { user: 1 }));
    assert.ok(!JSON.stringify(normalState).includes('rolesReportIntakes') && !JSON.stringify(normalState).includes('rolesProviderAttempts') && !JSON.stringify(normalState).includes('originalReportIdsHash'), 'Private custody and source beforeimages are absent from ordinary state'); journeys++;
    console.log(JSON.stringify({ passed: true, journeys, requests, imageWrites, casWrites, externalCalls: 0, normalServer: true, syntheticTransport: true, testInstallerUsed: false, nativeDeadlineClaim: false }));
  } finally {
    uploadHook = null; beforeRead = null; commitHook = null; server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); blobs.clear(); globalThis.fetch = nativeFetch; fs.rmSync(ownedDirectory, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
