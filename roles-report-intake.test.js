'use strict';
const assert = require('node:assert/strict'), crypto = require('node:crypto');
const intake = require('./roles-report-intake'), registry = require('./capability-registry');
const { workspaceSnapshot } = require('./compat-workspace-fixture');
let checks = 0;
const is = code => error => error.statusCode === code;
const image = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from('synthetic-intake-image')]);
function data() { return { report: { projectId: 101, dateIso: '2098-10-12', status: 'Needs review', notes: 'Synthetic field work', signature: 'Synthetic Field', summary: 'Synthetic field work', productionEntries: [{ estimateItemId: 1, description: 'Synthetic wall tile', quantity: 1, unit: 'SF', laborHours: 1 }], laborEntries: [{ memberId: 12, hours: 1 }] }, files: [{ name: 'synthetic.png', type: 'image/png', data: 'data:image/png;base64,' + image.toString('base64'), lastModified: 0 }], caption: 'Synthetic evidence', tags: ['FIELD', 'field'] }; }
function seed() {
  const db = workspaceSnapshot(), user = db.users.find(row => row.id === 2), tokenHash = crypto.createHash('sha256').update('synthetic-current-session').digest('hex');
  const session = { id: crypto.randomUUID(), companyId: db.company.id, userId: user.id, tokenHash, expiresAt: '2099-01-01T00:00:00.000Z' }; db.sessions.push(session);
  const family = registry.families.find(row => row[0] === 'daily'); db.company.dailyPolicyRequired = true;
  db.company.dailyRolePolicy = { version: 1, revision: 1, roles: Object.fromEntries(family[4].roles.map(role => [role, family[4].ceiling(role)])) };
  Object.assign(db.company.dailyRolePolicy.roles.field, { createReports: true, editReports: false, approveReports: false, runWorkdays: false });
  return { db, auth: { companyId: db.company.id, user, session } };
}
async function main() {
  let { db, auth } = seed(), value = data();
  const projected = intake.projectExtracted({ ...value.report, role: 'owner', history: [{ action: 'Approved' }], englishTranslation: 'Synthetic translated field work', originalLanguage: 'es' });
  assert.deepEqual(projected, { summary: 'Synthetic field work', originalLanguage: 'es', englishTranslation: 'Synthetic translated field work' });
  assert.throws(() => intake.validateExtracted({ ...projected, role: 'owner' }), is(400));
  assert.throws(() => intake.validateExtracted({ summary: {} }), is(400));
  assert.throws(() => intake.validateExtracted({ englishTranslation: 'x'.repeat(20001) }), is(400)); checks += 4;
  const normal = intake.normalizeReport({ ...value.report, project: 0, extracted: projected }, db);
  assert.equal(normal.permission, 'createReports'); assert.equal(normal.details.noteLanguage, 'es'); assert.equal(normal.details.englishTranslation, projected.englishTranslation);
  assert.throws(() => intake.normalizeReport({ ...value.report, project: 1 }, db), is(400));
  assert.throws(() => intake.normalizeReport({ ...value.report, extracted: value.report }, db), is(400)); checks += 5;
  const parsed = intake.parseCompound(value, db, 'POST', '/api/reports'); assert.deepEqual(parsed.tags, ['field']); assert.match(parsed.files[0].sha256, /^[a-f0-9]{64}$/); checks += 2;
  const noPhotos = { ...structuredClone(value), files: [] };
  assert.throws(() => intake.parseCompound(noPhotos, db, 'POST', '/api/reports'), is(400));
  noPhotos.report.reportType = 'superintendent'; noPhotos.report.safetyTalk = 'Synthetic safety talk';
  assert.equal(intake.parseCompound(noPhotos, db, 'POST', '/api/reports').files.length, 0);
  assert.throws(() => intake.parseCompound({ ...noPhotos, report: { ...noPhotos.report, safetyTalk: {} } }, db, 'POST', '/api/reports'), is(400)); checks += 3;
  for (const mutate of [row => { row.report.role = 'owner'; }, row => { row.report.rateSnapshot = { laborRate: 999 }; }, row => { row.report.status = 'Approved'; }, row => { row.files[0].assetId = crypto.randomUUID(); }, row => { row.files[0].type = 'image/jpeg'; }, row => { row.files[0].data += '='; }, row => { row.files[0].lastModified = -1; }, row => { row.files = Array(9).fill(row.files[0]); }, row => { row.actorId = 1; }, row => { row.tags = ['x'.repeat(81)]; }]) { const bad = structuredClone(value); mutate(bad); assert.throws(() => intake.parseCompound(bad, db, 'POST', '/api/reports'), is(400)); checks++; }
  let invoked = 0, staged = 0, ctx = { db, rolesOperationId: crypto.randomUUID() };
  const h = { key: crypto.randomBytes(32), context: () => ctx, body: async () => value, stage: () => { staged++; }, commit: async () => {}, json: () => {}, presentReport: (db, user, report) => report, invoke: async () => { invoked++; return { status: 400, data: { error: 'Synthetic actual handler rejected the initial draft' } }; } };
  const service = intake.createHandler(h), req = { method: 'POST', auth }, url = new URL('/api/reports', 'http://synthetic.invalid');
  await assert.rejects(service.handle(req, {}, url), is(400)); assert.equal(invoked, 1); assert.equal(service.valid(db).length, 1); assert.ok(staged > 0); checks += 4;
  const original = structuredClone(db), row = db[intake.collection][0]; row.actorId = 1;
  assert.throws(() => service.valid(db), is(409)); ctx.db = original; checks++;
  assert.equal(service.status(original, req, ctx.rolesOperationId).retryAllowed, false); checks++;
  const revoked = structuredClone(original); revoked.company.dailyRolePolicy.roles.field.viewReports = false; revoked.company.dailyRolePolicy.roles.field.createReports = false;
  assert.throws(() => service.status(revoked, req, ctx.rolesOperationId), is(403)); checks++;
  const other = structuredClone(original); other.sessions = other.sessions.filter(row => row.tokenHash !== auth.session.tokenHash);
  assert.throws(() => service.status(other, req, ctx.rolesOperationId), is(401)); checks++;
  const beforeReplay = invoked;
  await service.handle(req, {}, url); assert.equal(invoked, beforeReplay, 'A pending original operation cannot create or dispatch again'); checks++;
  ({ db, auth } = seed()); db.company.dailyRolePolicy.roles.field.createReports = false; ctx = { db, rolesOperationId: crypto.randomUUID() };
  await assert.rejects(service.handle({ method: 'POST', auth }, {}, url), is(403)); assert.equal(invoked, beforeReplay); assert.equal(db[intake.collection], undefined); checks += 3;
  console.log(JSON.stringify({ passed: true, checks, providerCalls: 0, externalCalls: 0, syntheticOnly: true }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
