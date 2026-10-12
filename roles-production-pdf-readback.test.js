'use strict';
const assert = require('node:assert/strict'), crypto = require('node:crypto'), fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os'), vm = require('node:vm');
const pdf = require('./roles-production-pdf-readback'), assets = require('./resource-assets'), daily = require('./daily-access');
const { workspaceSnapshot } = require('./compat-workspace-fixture'), { canonicalHash } = require('./database/transactional-repository');
const bytes = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n'), key = crypto.randomBytes(32);
const is = status => error => error.statusCode === status;
let checks = 0;
async function main() {
  const source = (await fs.readFile(path.join(__dirname, 'server.js'), 'utf8')).split(/\r?\n/);
  const pricing = vm.runInNewContext(source.find(row => row.startsWith('function pricingPolicy(')) + '\n' + source.find(row => row.startsWith('function canViewPricing(')) + '\n({canViewPricing})');
  const h = { key, canViewPricing: pricing.canViewPricing, canAccessProject: (db, user, id) => daily.projectAllowed(db, user, id) };
  function seed() {
    const db = workspaceSnapshot(); db.users.push({ id: 3, companyId: db.company.id, name: 'Synthetic Admin', role: 'admin', status: 'Active' }, { id: 4, companyId: db.company.id, name: 'Synthetic PM', role: 'project_manager', status: 'Active', projectIds: [101], assignedCrews: ['Synthetic Crew'], permissions: { viewDailies: true } });
    db.projects.push({ id: 102, name: 'Foreign synthetic project', estimateItems: [] });
    const url = '/api/files/estimate-documents/' + db.company.id + '/synthetic.pdf'; db.estimateImports = [{ id: 1, url, projectId: 101, createdByUserId: 4 }]; return { db, url };
  }
  const auth = (db, userId, token = 'synthetic-current-session') => ({ companyId: db.company.id, user: db.users.find(row => row.id === userId), session: { tokenHash: crypto.createHash('sha256').update(token).digest('hex'), expiresAt: '2099-01-01T00:00:00.000Z' } });
  let { db, url } = seed();
  for (const user of [1, 3, 4]) assert.ok(pdf.resolve(db, auth(db, user), new URL(url, 'http://synthetic.invalid'), h).sourceHash); checks += 3;
  for (const method of ['POST', 'PATCH', 'DELETE']) assert.equal(pdf.route(method, url), false);
  assert.equal(pdf.route('GET', '/api/files/project-photos/' + db.company.id + '/ordinary.png'), false); assert.equal(pdf.route('GET', '/api/local-files/estimates/synthetic.pdf'), true); checks += 5;
  assert.throws(() => pdf.resolve(db, auth(db, 2), new URL(url, 'http://synthetic.invalid'), h), is(404));
  db.company.pricingAccess = { enabled: false, officeMode: 'all', userIds: [] };
  assert.throws(() => pdf.resolve(db, auth(db, 4), new URL(url, 'http://synthetic.invalid'), h), is(404)); assert.ok(pdf.resolve(db, auth(db, 1), new URL(url, 'http://synthetic.invalid'), h)); checks += 3;
  ({ db, url } = seed()); db.estimateImports[0].projectId = null; assert.ok(pdf.resolve(db, auth(db, 4), new URL(url, 'http://synthetic.invalid'), h)); db.estimateImports[0].createdByUserId = 2;
  assert.throws(() => pdf.resolve(db, auth(db, 4), new URL(url, 'http://synthetic.invalid'), h), is(404)); db.estimateImports[0].createdByUserId = '4'; assert.throws(() => pdf.resolve(db, auth(db, 1), new URL(url, 'http://synthetic.invalid'), h), is(409)); checks += 3;
  ({ db, url } = seed()); db.projectPlans = [{ id: 1, url, projectId: 102, deletedAt: '2026-10-01T00:00:00.000Z' }];
  assert.throws(() => pdf.resolve(db, auth(db, 4), new URL(url, 'http://synthetic.invalid'), h), is(404)); assert.ok(pdf.resolve(db, auth(db, 1), new URL(url, 'http://synthetic.invalid'), h)); checks += 2;
  ({ db, url } = seed()); db.estimateImports[0].bucket = 'estimate-documents'; db.estimateImports[0].objectKey = 'foreign/synthetic.pdf'; assert.throws(() => pdf.resolve(db, auth(db, 1), new URL(url, 'http://synthetic.invalid'), h), is(409));
  ({ db, url } = seed()); db.estimateImports.push({ ...db.estimateImports[0] }); assert.throws(() => pdf.resolve(db, auth(db, 1), new URL(url, 'http://synthetic.invalid'), h), is(409)); checks += 2;
  ({ db, url } = seed()); db.estimateImports = []; db.projects[0].estimateProposals = [{ id: 1, sourceFile: { name: 'Synthetic.pdf', url }, createdBy: db.users.find(row => row.id === 2).name, createdByUserId: 2 }];
  assert.throws(() => pdf.resolve(db, auth(db, 2), new URL(url, 'http://synthetic.invalid'), h), is(404)); assert.ok(pdf.resolve(db, auth(db, 4), new URL(url, 'http://synthetic.invalid'), h)); checks += 2;
  ({ db } = seed()); db.estimateImports = []; const originalAuth = auth(db, 2), op = assets.parse({ kind: 'estimatePdfProposal', method: 'POST', path: '/api/projects/101/estimate-proposals', details: { filename: 'Synthetic.pdf', data: 'data:application/pdf;base64,' + bytes.toString('base64') } });
  await assets.createCustody(h).prepareOperation(db, originalAuth, op, {}); const stored = db[assets.collection][0]; url = assets.url(db, stored);
  db.resourceReceipts = [{ operation: op }]; db.projects[0].estimateProposals = [{ id: 1, sourceFile: { name: 'Synthetic.pdf', url }, createdBy: 'An unrelated display name' }];
  assert.equal(pdf.resolve(db, originalAuth, new URL(url, 'http://synthetic.invalid'), h).stored.actorId, 2);
  assert.throws(() => pdf.resolve(db, auth(db, 2, 'new-unrelated-session'), new URL(url, 'http://synthetic.invalid'), h), is(404));
  db[assets.collection][0].actorId = 1; assert.throws(() => pdf.resolve(db, originalAuth, new URL(url, 'http://synthetic.invalid'), h), is(409)); checks += 3;
  assert.deepEqual(pdf.verified(bytes), bytes); assert.throws(() => pdf.verified(Buffer.from('not a PDF')), is(409));
  assert.throws(() => pdf.verified(Buffer.alloc(pdf.LIMIT + 1)), is(409)); checks += 3;
  assert.deepEqual(await pdf.cloudBytes(new Response(bytes, { headers: { 'Content-Type': 'application/pdf', 'Content-Length': bytes.length } })), bytes);
  await assert.rejects(pdf.cloudBytes(new Response(bytes, { headers: { 'Content-Type': 'image/png' } })), is(409));
  await assert.rejects(pdf.cloudBytes(new Response(bytes, { headers: { 'Content-Type': 'application/pdf', 'Content-Length': bytes.length + 1 } })), is(409));
  await assert.rejects(pdf.cloudBytes(new Response(bytes, { headers: { 'Content-Type': 'application/pdf', 'Content-Length': pdf.LIMIT + 1 } })), is(409)); checks += 4;
  let aborted = false, lateCancelled = false, lateResolve;
  await assert.rejects(pdf.readWithDeadline(signal => { signal.addEventListener('abort', () => { aborted = true; }); return new Promise(() => {}); }, Date.now() + 30), is(409)); assert.equal(aborted, true);
  const late = new Promise(resolve => { lateResolve = resolve; });
  await assert.rejects(pdf.readWithDeadline(() => late, Date.now() + 30), is(409));
  lateResolve(new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(bytes)); }, cancel() { lateCancelled = true; } }), { headers: { 'Content-Type': 'application/pdf' } }));
  await new Promise(resolve => setTimeout(resolve, 0)); assert.equal(lateCancelled, true);
  let bodyCancelled = false;
  await assert.rejects(pdf.readWithDeadline(() => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(bytes)); }, cancel() { bodyCancelled = true; } }), { headers: { 'Content-Type': 'application/pdf' } }), Date.now() + 30), is(409)); assert.equal(bodyCancelled, true); checks += 6;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pdl-pdf-readback-unit-')), uploadRoot = path.join(dir, 'uploads');
  try {
    await fs.mkdir(path.join(uploadRoot, 'estimates'), { recursive: true }); await fs.writeFile(path.join(uploadRoot, 'estimates', 'own.pdf'), bytes, { flag: 'wx' });
    assert.deepEqual(await pdf.localBytes(uploadRoot, 'estimates/own.pdf'), bytes);
    await assert.rejects(pdf.localBytes(uploadRoot, '../foreign.pdf'), is(404));
    await fs.writeFile(path.join(uploadRoot, 'estimates', 'invalid.pdf'), 'not a PDF', { flag: 'wx' }); await assert.rejects(pdf.localBytes(uploadRoot, 'estimates/invalid.pdf'), is(409));
    await fs.mkdir(path.join(dir, 'outside')); await fs.writeFile(path.join(dir, 'outside', 'secret.pdf'), bytes, { flag: 'wx' }); await fs.symlink(path.join(dir, 'outside'), path.join(uploadRoot, 'jump'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(pdf.localBytes(uploadRoot, 'jump/secret.pdf'), is(404)); checks += 4;
  } finally { const target = path.resolve(dir); assert.ok(target.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(target).startsWith('pdl-pdf-readback-unit-')); await fs.rm(target, { recursive: true, force: true }); }
  ({ db, url } = seed()); let calls = 0, response;
  const service = pdf.createHandler({ ...h, readDb: () => db, assertCurrent: async () => auth(db, 4), download: async () => { calls++; db.company.pricingAccess.enabled = false; return new Response(bytes, { headers: { 'Content-Type': 'application/pdf' } }); }, json: (res, status, data) => { response = { status, data }; }, raw: () => assert.fail('Revoked pricing cannot deliver bytes') });
  const before = canonicalHash(db); assert.equal(await service({ method: 'GET' }, {}, new URL(url, 'http://synthetic.invalid')), true); assert.equal(calls, 1); assert.equal(response.status, 404); assert.notEqual(canonicalHash(db), before); checks += 4;
  console.log(JSON.stringify({ passed: true, checks, providerCalls: 0, externalCalls: 0, syntheticOnly: true }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
