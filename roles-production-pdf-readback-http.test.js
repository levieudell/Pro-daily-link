'use strict';
// Real normal server PDF creation/readback plus closed memory cloud reads.
// Local files are generated here, individually tracked and removed finally.
const assert = require('node:assert/strict'), crypto = require('node:crypto'), fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { canonicalHash } = require('./database/transactional-repository');
const nativeFetch = globalThis.fetch, blobs = new Map(), localFiles = new Set(), localLinks = new Set();
let origin, requests = 0, cloudReads = 0, casWrites = 0, readHook = null, cloudMode = 'valid', streamCancelled = false, downloadAborted = false, lateResolve = null, deadlineBodyCancelled = false;
globalThis.fetch = (input, options) => { const target = String(input?.url || input); assert.ok(origin && target.startsWith(origin + '/'), 'Only this owned loopback server may open a network socket'); return nativeFetch(input, options); };
const supabase = require('./database/supabase'); supabase.loadLocalEnv = () => {};
supabase.upload = supabase.remove = async () => { throw Error('This PDF readback fixture authorizes no cloud writes or cleanup'); };
supabase.download = async (bucket, key, { signal } = {}) => {
  cloudReads++; assert.equal(bucket, 'estimate-documents'); const value = blobs.get(bucket + '/' + key); assert.ok(value, 'Only fixture-owned PDF bytes may be downloaded'); if (readHook) await readHook();
  if (['stalled-header', 'late-header', 'stalled-body'].includes(cloudMode)) {
    assert.ok(signal instanceof AbortSignal, 'The original authorization deadline must cancel the real transport');
    signal.addEventListener('abort', () => { downloadAborted = true; }, { once: true });
    if (cloudMode !== 'stalled-body') return new Promise(resolve => { if (cloudMode === 'late-header') lateResolve = resolve; });
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(value)); }, cancel() { deadlineBodyCancelled = true; } }), { headers: { 'Content-Type': 'application/pdf' } });
  }
  if (cloudMode === 'missing') return new Response('Synthetic absent object', { status: 404 });
  if (cloudMode === 'oversize') return new Response(value, { headers: { 'Content-Type': 'application/pdf', 'Content-Length': '15000001' } });
  if (cloudMode === 'stream-limit') return new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(value)); controller.enqueue(new Uint8Array(15000000)); }, cancel() { streamCancelled = true; } }), { headers: { 'Content-Type': 'application/pdf' } });
  if (cloudMode === 'wrong-type') return new Response(value, { headers: { 'Content-Type': 'image/png' } });
  if (cloudMode === 'bad-magic') return new Response('Synthetic text is not a PDF', { headers: { 'Content-Type': 'application/pdf' } });
  return new Response(value, { headers: { 'Content-Type': 'application/pdf', 'Content-Length': value.length } });
};
const fixture = require('./roles-production-http.test'), { server } = fixture;
const ownedDirectory = path.resolve(path.dirname(process.env.PDL_DB_FILE));
assert.ok(ownedDirectory.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(ownedDirectory).startsWith('pdl-roles-production-http-'), 'Temp cleanup stays in this fixture-owned directory');
const request = supabase.request; supabase.request = async (route, options) => { const response = await request(route, options); if (/^\/rest\/v1\/rpc\/commit_roles_snapshot(?:_with_platform)?$/.test(route)) casWrites++; return response; };
const uploadRoot = path.resolve(__dirname, 'uploads'), estimateDirectory = path.join(uploadRoot, 'estimates');
const originalDirectories = new Map([[uploadRoot, fs.existsSync(uploadRoot)], [estimateDirectory, fs.existsSync(estimateDirectory)]]);
for (const [id, name, projectIds] of [[4, 'Synthetic PM', [101]], [5, 'Foreign Synthetic PM', [102]]]) {
  const token = crypto.randomBytes(32).toString('base64url'); fixture.tokens.set(id, token);
  fixture.alter(db => { db.users.push({ id, companyId: fixture.A, name, email: 'pm' + id + '@example.invalid', role: 'project_manager', status: 'Active', projectIds, assignedCrews: ['Synthetic Crew'], permissions: { viewDailies: true } }); db.sessions.push({ id: crypto.randomUUID(), companyId: fixture.A, userId: id, tokenHash: crypto.createHash('sha256').update(token).digest('hex'), createdAt: new Date().toISOString(), expiresAt: '2099-01-01T00:00:00.000Z' }); if (!db.projects.some(row => row.id === 102)) db.projects.push({ id: 102, name: 'Foreign synthetic project', estimateItems: [] }); });
}
function syntheticPdf() {
  const stream = 'BT /F1 12 Tf 50 700 Td (Deck framing 100 SF $5000.00) Tj 0 -20 Td (Total $5000.00) Tj ET';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', '<< /Length ' + Buffer.byteLength(stream) + ' >>\nstream\n' + stream + '\nendstream'];
  const chunks = [Buffer.from('%PDF-1.4\n')], offsets = [0]; let size = chunks[0].length;
  for (let index = 0; index < objects.length; index++) { offsets.push(size); const chunk = Buffer.from((index + 1) + ' 0 obj\n' + objects[index] + '\nendobj\n'); chunks.push(chunk); size += chunk.length; }
  chunks.push(Buffer.from('xref\n0 ' + (objects.length + 1) + '\n0000000000 65535 f \n' + offsets.slice(1).map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('') + 'trailer\n<< /Size ' + (objects.length + 1) + ' /Root 1 0 R >>\nstartxref\n' + size + '\n%%EOF\n')); return Buffer.concat(chunks);
}
const bytes = syntheticPdf();
function ownLocalUrl(url) {
  assert.match(url, /^\/uploads\/estimates\/[a-zA-Z0-9.-]+\.pdf$/); const target = path.resolve(uploadRoot, url.slice('/uploads/'.length));
  assert.ok(target.startsWith(estimateDirectory + path.sep) && path.dirname(target) === estimateDirectory); localFiles.add(target); return '/api/local-files/' + url.slice('/uploads/'.length);
}
async function call(method, route, { body, user = 1, company = fixture.A } = {}) {
  requests++; const response = await fetch(origin + route, { method, signal: AbortSignal.timeout(15000), headers: { 'X-PDL-Company': company, Authorization: 'Bearer ' + fixture.tokens.get(user), 'Content-Type': 'application/json', 'X-PDL-Operation': crypto.randomUUID() }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const raw = Buffer.from(await response.arrayBuffer()); let data; if (response.headers.get('content-type')?.includes('application/json')) data = JSON.parse(raw.toString());
  return { status: response.status, raw, data, headers: response.headers };
}
function pdfOkay(value) { assert.equal(value.status, 200, JSON.stringify(value.data)); assert.deepEqual(value.raw, bytes); assert.equal(value.headers.get('content-type'), 'application/pdf'); assert.equal(value.headers.get('cache-control'), 'private, no-store'); assert.equal(value.headers.get('x-content-type-options'), 'nosniff'); }
function denied(value, statuses = [400, 401, 403, 404, 409, 503]) { assert.ok(statuses.includes(value.status), JSON.stringify(value.data)); assert.notDeepEqual(value.raw, bytes); assert.ok(!value.data || !('sourceFile' in value.data) && !('bytes' in value.data)); }
async function main() {
  let journeys = 0;
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); }); origin = 'http://127.0.0.1:' + server.address().port;
    assert.equal(fixture.read().company.dailyRolePolicy, undefined, 'This proof starts with normal no-policy defaults');
    const intake = await call('POST', '/api/estimate-imports/analyze', { user: 4, body: { filename: 'Synthetic owned estimate.pdf', data: 'data:application/pdf;base64,' + bytes.toString('base64') } });
    assert.equal(intake.status, 201, JSON.stringify(intake.data)); assert.equal(intake.data.createdByUserId, 4); const localRoute = ownLocalUrl(intake.data.url);
    let before = canonicalHash(fixture.read()), writes = casWrites;
    for (const user of [1, 3, 4]) pdfOkay(await call('GET', localRoute, { user }));
    denied(await call('GET', localRoute, { user: 5 }), [404]); denied(await call('GET', localRoute, { user: 2 }), [404]);
    assert.equal(canonicalHash(fixture.read()), before); assert.equal(casWrites, writes, 'PDF reads create no custody, grants, provider attempt or business writes'); journeys++;
    const proposal = await call('POST', '/api/projects/101/estimate-proposals', { user: 2, body: { filename: 'Synthetic field scope.pdf', data: 'data:application/pdf;base64,' + bytes.toString('base64') } });
    assert.equal(proposal.status, 201, JSON.stringify(proposal.data)); const fieldFile = proposal.data.proposals.find(row => row.sourceFile)?.sourceFile; assert.ok(fieldFile); const proposalRoute = ownLocalUrl(fieldFile.url);
    for (const user of [1, 3, 4]) pdfOkay(await call('GET', proposalRoute, { user }));
    denied(await call('GET', proposalRoute, { user: 2 }), [404]); denied(await call('GET', proposalRoute, { user: 5 }), [404]); journeys++;
    const cloudKey = fixture.A + '/synthetic/' + crypto.randomUUID() + '.pdf', cloudUrl = '/api/files/estimate-documents/' + cloudKey;
    blobs.set('estimate-documents/' + cloudKey, bytes);
    fixture.alter(db => { db.estimateImports.push({ id: Math.max(...db.estimateImports.map(row => row.id)) + 1, url: cloudUrl, bucket: 'estimate-documents', objectKey: cloudKey, projectId: 101, createdByUserId: 1 }); });
    const importId = fixture.read().estimateImports.find(row => row.url === cloudUrl).id;
    before = canonicalHash(fixture.read()); writes = casWrites;
    for (const user of [1, 3, 4]) pdfOkay(await call('GET', cloudUrl, { user }));
    const reads = cloudReads; denied(await call('GET', cloudUrl, { user: 5 }), [404]); denied(await call('GET', cloudUrl, { user: 2 }), [404]);
    assert.equal(cloudReads, reads, 'Denied scope never reaches cloud byte retrieval'); assert.equal(canonicalHash(fixture.read()), before); assert.equal(casWrites, writes); journeys++;
    fixture.alter(db => { db.company.pricingAccess = { enabled: false, officeMode: 'all', userIds: [] }; });
    denied(await call('GET', cloudUrl, { user: 4 }), [404]); pdfOkay(await call('GET', cloudUrl, { user: 1 })); pdfOkay(await call('GET', cloudUrl, { user: 3 }));
    fixture.alter(db => { db.company.pricingAccess.enabled = true; }); journeys++;
    const foreignUrl = '/api/files/estimate-documents/' + fixture.B + '/synthetic.pdf';
    for (const route of [foreignUrl, cloudUrl + '?download=1', cloudUrl.replace('/synthetic/', '/synthetic%2f'), '/api/local-files/estimates/%2e%2e/source.pdf']) denied(await call('GET', route));
    denied(await call('GET', cloudUrl, { company: fixture.B }), [404]); denied(await call('GET', '/api/files/estimate-documents/' + fixture.A + '/unreferenced.pdf'), [404]); journeys++;
    fixture.alter(db => { db.projectPlans = [{ id: 71, projectId: 102, url: cloudUrl, deletedAt: '2026-10-01T00:00:00.000Z' }]; });
    denied(await call('GET', cloudUrl, { user: 4 }), [404]); pdfOkay(await call('GET', cloudUrl, { user: 1 }));
    fixture.alter(db => { db.projectPlans = []; db.estimateImports.find(row => row.id === importId).objectKey = fixture.B + '/wrong.pdf'; });
    denied(await call('GET', cloudUrl), [409]); fixture.alter(db => { db.estimateImports.find(row => row.id === importId).objectKey = cloudKey; }); journeys++;
    for (const mode of ['oversize', 'stream-limit', 'wrong-type', 'bad-magic', 'missing']) { cloudMode = mode; denied(await call('GET', cloudUrl), mode === 'missing' ? [404] : [409]); }
    assert.equal(streamCancelled, true, 'Oversize streamed bytes are cancelled before any private delivery'); cloudMode = 'valid'; journeys++;
    for (const [name, change] of [['pricing', db => { db.company.pricingAccess.enabled = false; }], ['role', db => { db.users.find(row => row.id === 4).role = 'admin'; }], ['session', db => { db.sessions = db.sessions.filter(row => row.tokenHash !== crypto.createHash('sha256').update(fixture.tokens.get(4)).digest('hex')); }], ['source binding', db => { db.estimateImports.find(row => row.id === importId).projectId = 102; }]]) {
      const original = fixture.read(); readHook = async () => { readHook = null; fixture.alter(change); };
      denied(await call('GET', cloudUrl, { user: 4 }), [401, 403, 404, 409]); fixture.alter(db => { for (const key of Object.keys(db)) delete db[key]; Object.assign(db, structuredClone(original)); });
    }
    journeys++;
    for (const mode of ['stalled-header', 'late-header', 'stalled-body']) {
      const original = fixture.read(), sessionHash = crypto.createHash('sha256').update(fixture.tokens.get(4)).digest('hex');
      const originalDeadline = Date.now() + 1600;
      fixture.alter(db => { db.sessions.find(row => row.tokenHash === sessionHash).expiresAt = new Date(originalDeadline).toISOString(); });
      writes = casWrites; downloadAborted = false; deadlineBodyCancelled = false; lateResolve = null; cloudMode = mode;
      denied(await call('GET', cloudUrl, { user: 4 }), [401, 409]);
      assert.equal(downloadAborted, true, mode + ': native transport receives original-deadline abort');
      assert.ok(Date.now() < originalDeadline + 2000, mode + ': a never-ending read cannot extend original authorization');
      assert.equal(casWrites, writes, mode + ': timed-out private reads perform no CAS');
      fixture.alter(db => { for (const key of Object.keys(db)) delete db[key]; Object.assign(db, structuredClone(original)); }); cloudMode = 'valid';
      if (mode === 'late-header') {
        assert.equal(typeof lateResolve, 'function');
        pdfOkay(await call('GET', cloudUrl, { user: 1 }));
        lateResolve(new Response(new ReadableStream({ cancel() { deadlineBodyCancelled = true; } }), { headers: { 'Content-Type': 'application/pdf' } }));
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(deadlineBodyCancelled, true, 'Late transport response body is cancelled after denial; the tenant queue is already released');
      } else if (mode === 'stalled-body') assert.equal(deadlineBodyCancelled, true, 'A pending body reader is cancelled at the original deadline');
    }
    journeys++;
    const maliciousName = 'synthetic-pdf-http-' + crypto.randomUUID() + '.pdf'; fs.mkdirSync(estimateDirectory, { recursive: true }); const badFile = path.join(estimateDirectory, maliciousName); fs.writeFileSync(badFile, 'Synthetic non-PDF', { flag: 'wx' }); localFiles.add(badFile);
    const badUrl = '/uploads/estimates/' + maliciousName; fixture.alter(db => { db.estimateImports.push({ id: Math.max(...db.estimateImports.map(row => row.id)) + 1, url: badUrl, projectId: 101, createdByUserId: 1 }); });
    denied(await call('GET', '/api/local-files/estimates/' + maliciousName), [409]); journeys++;
    const hugeName = 'synthetic-pdf-http-' + crypto.randomUUID() + '.pdf', hugeFile = path.join(estimateDirectory, hugeName);
    const descriptor = fs.openSync(hugeFile, 'wx'); try { fs.writeSync(descriptor, bytes); fs.ftruncateSync(descriptor, 15000001); } finally { fs.closeSync(descriptor); } localFiles.add(hugeFile);
    fixture.alter(db => { db.estimateImports.push({ id: Math.max(...db.estimateImports.map(row => row.id)) + 1, url: '/uploads/estimates/' + hugeName, projectId: 101, createdByUserId: 1 }); });
    denied(await call('GET', '/api/local-files/estimates/' + hugeName), [409]); journeys++;
    const outside = path.join(ownedDirectory, 'outside-upload-root'), linkName = 'synthetic-pdf-http-' + crypto.randomUUID(), link = path.join(estimateDirectory, linkName);
    fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'private.pdf'), bytes, { flag: 'wx' }); fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir'); localLinks.add(link);
    fixture.alter(db => { db.estimateImports.push({ id: Math.max(...db.estimateImports.map(row => row.id)) + 1, url: '/uploads/estimates/' + linkName + '/private.pdf', projectId: 101, createdByUserId: 1 }); });
    denied(await call('GET', '/api/local-files/estimates/' + linkName + '/private.pdf'), [404]); journeys++;
    const assets = require('./resource-assets'), daily = require('./daily-access'), snapshot = fixture.read(), field = snapshot.users.find(row => row.id === 2), fieldSession = snapshot.sessions.find(row => row.tokenHash === crypto.createHash('sha256').update(fixture.tokens.get(2)).digest('hex'));
    const auth = { companyId: fixture.A, user: field, session: fieldSession }, op = assets.parse({ kind: 'estimatePdfProposal', method: 'POST', path: '/api/projects/101/estimate-proposals', details: { filename: 'Prior synthetic custody.pdf', data: 'data:application/pdf;base64,' + bytes.toString('base64') } });
    await assets.createCustody({ key: Buffer.from(process.env.PDL_ROLE_POLICY_KEY, 'hex'), canViewPricing: () => false, canAccessProject: (db, user, id) => daily.projectAllowed(db, user, id) }).prepareOperation(snapshot, auth, op, {});
    const stored = snapshot[assets.collection][0], priorUrl = assets.url(snapshot, stored); snapshot.resourceReceipts = [{ operation: op }]; snapshot.projects[0].estimateProposals.push({ id: Math.max(...snapshot.projects[0].estimateProposals.map(row => row.id)) + 1, sourceFile: { name: 'Prior synthetic custody.pdf', url: priorUrl }, createdBy: 'An unrelated display name' });
    fixture.alter(db => { for (const key of Object.keys(db)) delete db[key]; Object.assign(db, snapshot); });
    const beforeProofRead = cloudReads; pdfOkay(await call('GET', priorUrl, { user: 2 })); assert.equal(cloudReads, beforeProofRead, 'Existing valid custody supplies its already retained bytes');
    fixture.alter(db => { db[assets.collection][0].actorId = 1; }); denied(await call('GET', priorUrl, { user: 2 }), [409]); journeys++;
    console.log(JSON.stringify({ passed: true, journeys, requests, cloudReads, casWrites, actualLocalPdfCreations: 2, originalAuthorizationDeadlineCases: 3, externalCalls: 0, normalServer: true, syntheticTransport: true, testInstallerUsed: false, newFieldAuthorProof: false, legacyFieldReadUnsupported: true, nativeDeadlineClaim: false }));
  } finally {
    readHook = null; cloudMode = 'valid'; server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); blobs.clear(); globalThis.fetch = nativeFetch;
    for (const file of localFiles) { const target = path.resolve(file); assert.ok(target.startsWith(estimateDirectory + path.sep) && path.dirname(target) === estimateDirectory); try { fs.unlinkSync(target); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
    for (const link of localLinks) { const target = path.resolve(link); assert.ok(target.startsWith(estimateDirectory + path.sep) && path.dirname(target) === estimateDirectory); if (process.platform === 'win32') fs.rmdirSync(target); else fs.unlinkSync(target); }
    for (const dir of [estimateDirectory, uploadRoot]) if (!originalDirectories.get(dir)) try { fs.rmdirSync(dir); } catch (error) { if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error; }
    fs.rmSync(ownedDirectory, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
