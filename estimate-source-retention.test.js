'use strict';
// Synthetic fixtures only. Every provider request is intercepted in memory, and
// local writes/fault injection are restricted to this test's files.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { buildSalesDemo } = require('./sales-demo-data');
const { createPortableBackup, collectStorageReferences, digest } = require('./database/portable-backup');
const supabase = require('./database/supabase');

const localOnly = process.argv.includes('--local-only');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-estimate-retention-'));
const dbFile = path.join(temp, 'db.json');
const uploadsDirectory = path.join(__dirname, 'uploads', 'estimates');
const providerOrigin = 'https://synthetic-estimate-retention.invalid';
const otherCompanyId = 'e5710000-0000-4000-8000-000000000002';
const guestToken = 'e'.repeat(48);
const userToken = id => `synthetic-estimate-retention-${id}`;
const db = buildSalesDemo({ companyId: 'e5710000-0000-4000-8000-000000000001' });
const projectId = db.projects[0].id;
const otherProjectId = db.projects[1].id;
const memberId = db.team[0].id;
const unassignedMemberId = db.team[1].id;
for (const key of ['reports', 'workdays', 'timeCards', 'payPeriods', 'payPeriodExports', 'reportingExports', 'projectNotesTodos', 'photos', 'projectPlans', 'projectTickets', 'changes', 'auditLog']) db[key] = [];
db.estimateImports = [];
db.projects = db.projects.slice(0, 2).map(project => ({ ...project, estimateItems: [], estimateProposals: [] }));
db.assignments = [{ id: 1, projectId, memberIds: [memberId], date: '2026-10-06', start: '07:00', end: '15:00' }];
db.company.features = { timeCards: false, templates: false };
db.company.pricingAccess = { enabled: true, officeMode: 'selected', userIds: [3] };
db.company.contractValueTracking = true;
db.users = [
  { id: 1, role: 'owner' },
  { id: 2, role: 'admin' },
  { id: 3, role: 'project_manager', projectIds: [projectId], assignedCrews: [db.team[0].crew], permissions: { viewDailies: true } },
  { id: 4, role: 'project_manager', projectIds: [projectId], assignedCrews: [db.team[0].crew], permissions: { viewDailies: true } },
  { id: 5, role: 'field', memberId },
  { id: 6, role: 'foreman', memberId },
  { id: 7, role: 'field', memberId: unassignedMemberId }
].map(user => ({ ...user, companyId: db.company.id, name: `Synthetic ${user.role} ${user.id}`, email: `estimate-${user.id}@example.invalid`, status: 'Active' }));
db.sessions = db.users.map(user => ({ userId: user.id, companyId: db.company.id, tokenHash: digest(Buffer.from(userToken(user.id))), expiresAt: '2099-01-01T00:00:00Z' }));
db.subcontractors = [{ id: 1, name: 'Synthetic estimate contractor', status: 'Active' }];
db.subcontractorLinks = [{ id: 1, tokenHash: digest(Buffer.from(guestToken)), subcontractorId: 1, projectId, status: 'Active', expiresAt: '2099-01-01T00:00:00Z' }];
const otherDb = structuredClone(db);
otherDb.company.id = otherCompanyId;
otherDb.company.name = 'Synthetic unrelated company';
otherDb.users = [{ id: 1, companyId: otherCompanyId, name: 'Other synthetic owner', role: 'owner', status: 'Active' }];
otherDb.sessions = [{ userId: 1, companyId: otherCompanyId, tokenHash: digest(Buffer.from(userToken('other'))), expiresAt: '2099-01-01T00:00:00Z' }];
otherDb.subcontractorLinks = [];
fs.mkdirSync(path.join(temp, 'tenants'));
fs.writeFileSync(dbFile, JSON.stringify(db));
fs.writeFileSync(path.join(temp, 'tenants', `${otherCompanyId}.json`), JSON.stringify(otherDb));
fs.writeFileSync(path.join(temp, 'platform.json'), JSON.stringify({ users: [], sessions: [] }));
Object.assign(process.env, {
  PDL_DB_FILE: dbFile, PDL_PLATFORM_FILE: path.join(temp, 'platform.json'), PDL_REQUIRE_AUTH: '1',
  PDL_TRANSACTIONAL_DB: 'off', PDL_SUPABASE_ENABLED: localOnly ? '0' : '1',
  SUPABASE_URL: providerOrigin, SUPABASE_SECRET_KEY: 'synthetic-not-a-secret',
  SENTRY_DSN: '', RESEND_API_KEY: '', OPENAI_API_KEY: '', STRIPE_SECRET_KEY: '', STRIPE_WEBHOOK_SECRET: ''
});
// Do not read a developer's local provider credentials, even if present.
const nativeLoadLocalEnv = supabase.loadLocalEnv;
supabase.loadLocalEnv = () => {};
const objects = new Map();
const providerReads = [];
const providerWrites = [];
const bucketRequests = [];
let estimateBucketExists = true;
let estimateBucketMaxBytes = 15_000_000;
let expectedFailureCount = 0;
const remoteSnapshots = new Map([[db.company.id, structuredClone(db)], [otherCompanyId, structuredClone(otherDb)]]);
const localFiles = new Set();
const expectedErrors = [];
let base = '';
let failAssetSave = false;
let failSnapshotSave = false;
let expectingFailure = false;
const nativeFetch = global.fetch;
const nativeWriteFileSync = fs.writeFileSync;
const nativeConsoleError = console.error;
console.error = (...args) => expectingFailure ? expectedErrors.push(args) : nativeConsoleError(...args);
fs.writeFileSync = function (filename, ...args) {
  const file = typeof filename === 'string' ? path.resolve(filename) : '';
  if (file === dbFile + '.tmp' && failSnapshotSave) throw new Error('Synthetic isolated snapshot write failure');
  if (file.startsWith(uploadsDirectory + path.sep)) {
    if (failAssetSave) throw new Error('Synthetic local PDF write failure');
    localFiles.add(file);
  }
  return nativeWriteFileSync.call(this, filename, ...args);
};
global.fetch = async (input, options = {}) => {
  const url = new URL(String(input));
  if (base && url.origin === base) return nativeFetch(input, options);
  assert.equal(url.origin, providerOrigin, 'No real provider or unrelated network call is allowed');
  assert.equal(localOnly, false, 'Local fallback must not contact a provider');
  const method = options.method || 'GET';
  if (url.pathname === '/storage/v1/bucket') {
    assert.equal(method, 'POST');
    const bucket = JSON.parse(options.body);
    bucketRequests.push(bucket);
    assert.equal(bucket.public, false, 'Synthetic buckets must remain private');
    return new Response('{}');
  }
  if (url.pathname === '/rest/v1/companies') {
    if (method === 'POST') {
      for (const row of JSON.parse(options.body)) remoteSnapshots.set(row.id, row.data);
      return new Response('[]');
    }
    assert.equal(method, 'GET');
    const filter = url.searchParams.get('id');
    const rows = [...remoteSnapshots].filter(([id]) => !filter || filter === 'eq.' + id).map(([id, data]) => ({ id, data }));
    return new Response(JSON.stringify(rows));
  }
  if (url.pathname.startsWith('/storage/v1/object/')) {
    const key = decodeURIComponent(url.pathname.slice('/storage/v1/object/'.length));
    if (method === 'POST') {
      if (key.startsWith('estimate-documents/')) {
        if (failAssetSave) return new Response('Synthetic unavailable storage', { status: 503 });
        if (!estimateBucketExists) return new Response('Bucket not found', { status: 400 });
        if (Buffer.byteLength(options.body) > estimateBucketMaxBytes) return new Response('Synthetic bucket size restriction', { status: 413 });
      }
      const type = new Headers(options.headers).get('Content-Type');
      objects.set(key, { bytes: Buffer.from(options.body), type });
      providerWrites.push(key);
      return new Response('{}');
    }
    assert.equal(method, 'GET', 'Source retention must never remove stored objects');
    providerReads.push(key);
    const object = objects.get(key);
    return object ? new Response(object.bytes, { headers: { 'content-type': object.type } }) : new Response('Missing synthetic object', { status: 404 });
  }
  throw new Error('Unexpected synthetic request: ' + method + ' ' + url.pathname);
};
const { server } = require('./server');
const {makePdf}=require('./estimate-pdf.test');
const pdf = rows => makePdf(['Description Quantity Unit Amount', ...rows]);
const importBytes = pdf(['Synthetic retaining wall 12 SF $120.00','Total $120.00']);
const proposalBytes = pdf(['Synthetic base framing 10 SF $100.00','Synthetic finish panels 8 EA $80.00','Total $180.00']);
const importPayload = { filename: 'synthetic-import.pdf', data: 'data:application/pdf;base64,' + importBytes.toString('base64') };
const proposalPayload = { filename: 'synthetic-field-multiline.pdf', data: 'data:application/pdf;base64,' + proposalBytes.toString('base64') };
const readDb = () => JSON.parse(fs.readFileSync(dbFile, 'utf8'));
const storedProject = () => readDb().projects.find(project => project.id === projectId);
const ids = rows => rows.map(row => row.id);
const proposalRoute = `/api/projects/${projectId}/estimate-proposals`;
const approvalRoute = id => `${proposalRoute}/${id}/approve`;

async function request(route, { method = 'GET', data, user = 1, companyId = db.company.id, headers = {} } = {}) {
  const response = await fetch(base + route, {
    method, headers: { ...(user == null ? {} : { Authorization: 'Bearer ' + userToken(user) }), 'X-PDL-Company': companyId, 'Content-Type': 'application/json', ...headers },
    ...(data === undefined ? {} : { body: JSON.stringify(data) })
  });
  const text = await response.text();
  let result;
  try { result = JSON.parse(text); } catch { result = text; }
  return { status: response.status, data: result };
}
async function expectRequest(route, options, expectedStatus) {
  const result = await request(route, options);
  assert.equal(result.status, expectedStatus, `${options?.method || 'GET'} ${route}: ${JSON.stringify(result.data)}`);
  return result.data;
}
async function expectUnchangedFailure(route, options, fault, expectedStatus = 500) {
  const before = fs.readFileSync(dbFile, 'utf8');
  expectingFailure = true;
  failAssetSave = fault === 'asset';
  failSnapshotSave = fault === 'snapshot';
  try { await expectRequest(route, options, expectedStatus); expectedFailureCount++; }
  finally { failAssetSave = false; failSnapshotSave = false; expectingFailure = false; }
  assert.equal(fs.readFileSync(dbFile, 'utf8'), before, `Failed ${fault} save must preserve the previous snapshot: ${route}`);
}
function verifySource(source, expectedBytes, importStyle = false) {
  const bucket = importStyle ? source.storageBucket : source.bucket;
  const objectKey = importStyle ? source.storageKey : source.objectKey;
  if (localOnly) {
    assert.equal(bucket, null);
    assert.equal(objectKey, null);
    assert.match(source.url, /^\/uploads\/estimates\//);
    const file = path.join(__dirname, source.url.slice(1));
    assert.ok(localFiles.has(file), 'Fallback source is one of this test’s new files');
    assert.equal(digest(fs.readFileSync(file)), digest(expectedBytes), 'Local source PDF remains byte-exact');
  } else {
    assert.equal(bucket, 'estimate-documents');
    assert.ok(objectKey.startsWith(db.company.id + '/'), 'Object belongs to the exact tenant');
    assert.equal(decodeURIComponent(source.url), `/api/files/${bucket}/${objectKey}`);
    const object = objects.get(`${bucket}/${objectKey}`);
    assert.ok(object, 'Reference resolves to an uploaded private object');
    assert.equal(object.type, 'application/pdf');
    assert.equal(digest(object.bytes), digest(expectedBytes), 'Uploaded source PDF remains byte-exact');
  }
}
async function verifyPendingWorkspaces(expectedIds) {
  const cases = [
    ['/api/state', 1], ['/api/state', 2], ['/api/state', 3], ['/api/state', 4], ['/api/state', 5], ['/api/state', 6],
    ['/api/state?userId=3', 1], ['/api/state?userId=4', 1], ['/api/state?userId=5', 1],
    [`/api/state?role=field&memberId=${memberId}`, 1]
  ];
  for (const [route, user] of cases) {
    const state = await expectRequest(route, { user }, 200);
    const project = state.projects.find(row => row.id === projectId);
    assert.ok(project, `${route} user ${user} includes assigned project`);
    assert.deepEqual(ids(project.estimateProposals || []), expectedIds, `${route} user ${user} exposes pending proposals only`);
    if ([3, 4, 5, 6].includes(user)) assert.equal(state.projects.some(row => row.id === otherProjectId), false, 'Project scoping is preserved');
    if ([4, 5, 6].includes(user)) assert.equal(Object.hasOwn(project, 'budget'), false, 'Pricing remains redacted');
  }
}
async function verifyReadDenial(source) {
  const readsBefore = providerReads.length;
  for (const user of [1, 2, 3, 4, 5, 6, 7]) await expectRequest(source.url, { user }, 404);
  await expectRequest(source.url, { user: null }, 401);
  // A valid guest link remains usable for its original narrow purposes only.
  await expectRequest(source.url + '?c=' + db.company.id + '&token=' + guestToken, { user: null, headers: { Authorization: 'Bearer ' + guestToken } }, 401);
  await expectRequest(source.url, { user: 'other', companyId: otherCompanyId }, 404);
  await expectRequest(source.url, { user: 1, companyId: otherCompanyId }, 401);
  if (localOnly) await expectRequest('/api/local-files/' + source.url.slice('/uploads/'.length), { user: 1 }, 404);
  assert.equal(providerReads.length, readsBefore, 'Denied source reads must not download any private object');
}
function verifyUiFiltering() {
  const app = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
  const reviewBlock = app.split('\n').find(line => line.includes('const proposals=') && line.includes('field-estimate-proposals'));
  assert.ok(reviewBlock, 'Exercise the actual field estimate review renderer');
  function render(proposals) {
    const output = [];
    vm.runInNewContext(reviewBlock, {
      p: { id: projectId, estimateProposals: proposals }, currentUser: { role: 'owner' },
      $: () => ({ insertAdjacentHTML: (_position, html) => output.push(html) }), $$: () => [],
      escapeHtml: value => String(value), Number
    });
    return output.join('');
  }
  const approved = { id: 1, name: 'APPROVED_SENTINEL', plannedQuantity: 1, unit: 'EA', status: 'Approved' };
  const pending = { id: 2, name: 'PENDING_SENTINEL', plannedQuantity: 2, unit: 'EA', status: 'Needs office review' };
  const legacy = { id: 3, name: 'LEGACY_PENDING_SENTINEL', plannedQuantity: 3, unit: 'EA' };
  const html = render([approved, pending, legacy]);
  assert.doesNotMatch(html, /APPROVED_SENTINEL|data-approve-estimate-proposal="1"/);
  assert.match(html, /PENDING_SENTINEL/);
  assert.match(html, /LEGACY_PENDING_SENTINEL/);
  assert.match(html, /2 scope lines waiting for office review/);
  assert.equal(render([approved]), '', 'No empty review panel after the final approval');
}

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = 'http://127.0.0.1:' + server.address().port;
  try {
    verifyUiFiltering();
    // Prime incidental workspace normalization before exact persistence checks.
    await expectRequest('/api/state', {}, 200);
    await expectRequest(`/api/guest/${guestToken}?c=${db.company.id}`, { user: null }, 200);
    const initialSnapshot = fs.readFileSync(dbFile, 'utf8');
    await expectRequest('/api/estimate-imports/analyze', { method: 'POST', data: importPayload, user: 5 }, 403);
    await expectRequest(`/api/projects/${otherProjectId}/estimate-proposals`, { method: 'POST', data: proposalPayload, user: 5 }, 403);
    await expectRequest(proposalRoute, { method: 'POST', data: proposalPayload, user: 7 }, 403);
    await expectRequest('/api/projects/99999/estimate-proposals', { method: 'POST', data: proposalPayload }, 404);
    await expectRequest('/api/estimate-imports/analyze', { method: 'POST', data: { data: 'not-a-pdf' } }, 400);
    await expectRequest(proposalRoute, { method: 'POST', data: { data: 'not-a-pdf' } }, 400);
    await expectRequest(proposalRoute, { method: 'POST', data: { data: 'data:application/pdf;base64,' + pdf('').toString('base64') } }, 400);
    assert.equal(fs.readFileSync(dbFile, 'utf8'), initialSnapshot, 'Rejected uploads cannot mutate the tenant');

    await expectUnchangedFailure('/api/estimate-imports/analyze', { method: 'POST', data: importPayload }, 'asset');
    await expectUnchangedFailure(proposalRoute, { method: 'POST', data: proposalPayload, user: 5 }, 'asset');
    await expectUnchangedFailure('/api/estimate-imports/analyze', { method: 'POST', data: importPayload }, 'snapshot');
    const imported = await expectRequest('/api/estimate-imports/analyze', { method: 'POST', data: importPayload }, 201);
    assert.equal(imported.id, 1);
    assert.equal(imported.lines.length, 1);
    assert.equal(imported.status, 'Draft');
    verifySource(imported, importBytes, true);
    assert.deepEqual(readDb().estimateImports[0], imported, 'Import stores its complete original source reference');
    const importApprove = { method: 'POST', data: { projectId, lines: imported.lines } };
    await expectUnchangedFailure(`/api/estimate-imports/${imported.id}/approve`, importApprove, 'snapshot');
    const approvedImport = await expectRequest(`/api/estimate-imports/${imported.id}/approve`, importApprove, 200);
    assert.equal(approvedImport.items.length, 1);
    assert.equal(approvedImport.import.status, 'Approved');
    assert.equal(approvedImport.items[0].sourceImportId, imported.id);
    verifySource(readDb().estimateImports[0], importBytes, true);

    await expectUnchangedFailure(proposalRoute, { method: 'POST', data: proposalPayload, user: 5 }, 'snapshot');
    const created = await expectRequest(proposalRoute, { method: 'POST', data: proposalPayload, user: 5 }, 201);
    assert.equal(created.created, 2);
    assert.deepEqual(ids(created.proposals), [1, 2]);
    const originalProposals = structuredClone(created.proposals);
    const source = originalProposals[0].sourceFile;
    assert.equal(source.name, proposalPayload.filename);
    assert.equal(source.contentType, 'application/pdf');
    assert.deepEqual(originalProposals[1].sourceFile, source, 'All lines share one source PDF');
    verifySource(source, proposalBytes);
    assert.deepEqual(storedProject().estimateProposals, originalProposals);
    await verifyPendingWorkspaces([1, 2]);
    await verifyReadDenial(imported);
    await verifyReadDenial(source);
    await expectRequest(approvalRoute(1), { method: 'POST', user: 5 }, 403);
    await expectRequest('/api/projects/99999/estimate-proposals/1/approve', { method: 'POST' }, 404);
    await expectUnchangedFailure(approvalRoute(1), { method: 'POST' }, 'snapshot');
    assert.deepEqual(storedProject().estimateProposals, originalProposals, 'Failed approval preserves both pending source records');

    const approvedItems = [];
    for (const [index, proposal] of originalProposals.entries()) {
      const result = await expectRequest(approvalRoute(proposal.id), { method: 'POST', user: index === 0 ? 1 : 2 }, 200);
      approvedItems.push(result.item);
      assert.equal(result.item.sourceProposalId, proposal.id);
      assert.equal(result.item.source, 'field_proposal');
      assert.equal(result.item.name, proposal.name);
      assert.deepEqual(ids(result.proposals), index === 0 ? [2] : [], 'Approval response contains remaining pending lines only');
      const retained = storedProject().estimateProposals.find(row => row.id === proposal.id);
      assert.ok(retained, 'Approval retains the original proposal rather than splicing it out');
      assert.equal(retained.status, 'Approved');
      assert.ok(Number.isFinite(Date.parse(retained.approvedAt)));
      assert.equal(retained.approvedEstimateItemId, result.item.id);
      const { status, approvedAt, approvedEstimateItemId, ...originalFields } = retained;
      const { status: originalStatus, ...expectedFields } = proposal;
      assert.deepEqual(originalFields, expectedFields, 'Original scope, attribution, and source metadata survive unchanged');
      const beforeRepeat = fs.readFileSync(dbFile, 'utf8');
      await expectRequest(approvalRoute(proposal.id), { method: 'POST' }, 409);
      assert.equal(fs.readFileSync(dbFile, 'utf8'), beforeRepeat, 'Repeat approval cannot create an item or rewrite history');
      await verifyPendingWorkspaces(index === 0 ? [2] : []);
    }
    assert.equal(storedProject().estimateItems.length, 3, 'One import and two proposals produce exactly three estimate items');
    assert.equal(storedProject().estimateProposals.length, 2, 'Approving the final line preserves the only PDF reference');

    const uploadCount = providerWrites.filter(key => key.startsWith('estimate-documents/')).length;
    const localFileCount = localFiles.size;
    const manual = await expectRequest(proposalRoute, { method: 'POST', user: 5, data: { name: 'Synthetic manual scope', plannedQuantity: 3, unit: 'LF' } }, 201);
    assert.equal(manual.created, 1);
    assert.deepEqual(ids(manual.proposals), [3], 'IDs advance past retained approved rows');
    assert.equal(manual.proposals[0].sourceFile, null);
    assert.equal(providerWrites.filter(key => key.startsWith('estimate-documents/')).length, uploadCount, 'Manual entry does not upload a PDF');
    assert.equal(localFiles.size, localFileCount);
    const concurrentApprovals = await Promise.all([request(approvalRoute(3), { method: 'POST' }), request(approvalRoute(3), { method: 'POST', user: 2 })]);
    assert.deepEqual(concurrentApprovals.map(result => result.status).sort(), [200, 409], 'Concurrent approvals succeed exactly once');
    const manualApproval = concurrentApprovals.find(result => result.status === 200).data;
    assert.equal(storedProject().estimateItems.filter(item => item.sourceProposalId === 3).length, 1, 'Concurrent approval cannot duplicate a manual estimate item');
    assert.equal(manualApproval.item.name, 'Synthetic manual scope');
    assert.deepEqual(manualApproval.proposals, []);
    assert.equal(storedProject().estimateProposals.find(row => row.id === 3).sourceFile, null);
    const nextManual = await expectRequest(proposalRoute, { method: 'POST', data: { name: 'Synthetic later pending scope', plannedQuantity: 4, unit: 'EA' } }, 201);
    assert.deepEqual(ids(nextManual.proposals), [4], 'Further creates do not expose historical approvals');
    await verifyPendingWorkspaces([4]);

    const retainedHistory = structuredClone(storedProject().estimateProposals);
    for (const item of [approvedImport.items[0], ...approvedItems]) {
      await expectRequest(`/api/projects/${projectId}/estimate-items/${item.id}`, { method: 'PATCH', data: { name: 'Edited synthetic estimate scope', plannedQuantity: 20 } }, 200);
      await expectRequest(`/api/projects/${projectId}/estimate-items/${item.id}`, { method: 'DELETE' }, 200);
    }
    assert.deepEqual(storedProject().estimateProposals, retainedHistory, 'Editing/deleting derived items cannot destroy source history');
    verifySource(readDb().estimateImports[0], importBytes, true);
    verifySource(storedProject().estimateProposals[1].sourceFile, proposalBytes);
    const contract = await expectRequest(`/api/projects/${projectId}`, { method: 'PATCH', data: { contractValue: 4321 } }, 200);
    assert.deepEqual(ids(contract.estimateProposals), [4], 'Project update response filters retained approvals');
    const archived = await expectRequest(`/api/projects/${projectId}/archive`, { method: 'PATCH', data: { archived: true } }, 200);
    assert.equal(archived.archived, true);
    assert.deepEqual(ids(archived.estimateProposals), [4], 'Archive response filters retained approvals');
    assert.deepEqual(storedProject().estimateProposals, retainedHistory, 'Archiving retains every source record');
    await verifyPendingWorkspaces([4]);
    await verifyReadDenial(imported);
    await verifyReadDenial(source);
    const finalSnapshot = readDb();
    verifySource(finalSnapshot.estimateImports[0], importBytes, true);
    verifySource(finalSnapshot.projects[0].estimateProposals[0].sourceFile, proposalBytes);

    if (localOnly) {
      await assert.rejects(createPortableBackup({ snapshot: finalSnapshot, destination: path.join(temp, 'portable') }), /Incomplete recovery set/);
      assert.equal(fs.existsSync(path.join(temp, 'portable')), false, 'Local references cannot claim a complete portable backup');
    } else {
      const references = collectStorageReferences(finalSnapshot);
      assert.equal(references.length, 2, 'Two proposal lines are deduplicated to one PDF alongside the import PDF');
      const readsBefore = providerReads.length;
      const backup = await createPortableBackup({ snapshot: finalSnapshot, destination: path.join(temp, 'portable') });
      assert.equal(backup.manifest.objects.length, 2);
      assert.equal(providerReads.length - readsBefore, 2, 'Backup downloads each referenced PDF only once');
      const expected = new Map([
        [`${imported.storageBucket}/${imported.storageKey}`, digest(importBytes)],
        [`${source.bucket}/${source.objectKey}`, digest(proposalBytes)]
      ]);
      for (const object of backup.manifest.objects) {
        assert.equal(object.sha256, expected.get(`${object.bucket}/${object.objectKey}`));
        assert.equal(object.contentType, 'application/pdf');
        assert.equal(digest(fs.readFileSync(path.join(backup.directory, object.filename))), object.sha256);
      }
      const restored = JSON.parse(fs.readFileSync(path.join(backup.directory, 'snapshot.json'), 'utf8'));
      assert.deepEqual(restored.projects[0].estimateProposals, retainedHistory);
      assert.deepEqual(restored.estimateImports, finalSnapshot.estimateImports);
      assert.deepEqual(remoteSnapshots.get(db.company.id).projects[0].estimateProposals, retainedHistory, 'Cloud snapshot preserves approved source history');
    }
    // Legacy rows are retained but cannot produce a falsely successful portable recovery set.
    for (const kind of ['import', 'proposal']) {
      const legacy = { company: { id: db.company.id }, projects: [] };
      const file = { url: '/uploads/estimates/synthetic-legacy.pdf' };
      if (kind === 'import') legacy.estimateImports = [{ id: 91, ...file }];
      else legacy.projects = [{ id: projectId, estimateProposals: [{ id: 92, status: 'Approved', sourceFile: file }] }];
      const destination = path.join(temp, 'legacy-' + kind);
      await assert.rejects(createPortableBackup({ snapshot: legacy, destination }), /Incomplete recovery set/);
      assert.equal(fs.existsSync(destination), false);
      assert.equal(kind === 'import' ? legacy.estimateImports[0].url : legacy.projects[0].estimateProposals[0].sourceFile.url, file.url, 'Backup refusal must preserve legacy references');
    }
    // Keep the existing 16 MB JSON body cap. An 8 MB PDF is supported end to end;
    // the advertised 15 MB PDF boundary already exceeds the base64 JSON cap.
    const largeBytes = Buffer.alloc(8_000_000, 32);
    proposalBytes.copy(largeBytes);
    const largePayload = { filename: 'synthetic-eight-megabytes.pdf', data: 'data:application/pdf;base64,' + largeBytes.toString('base64') };
    const boundaryRoutes = ['/api/estimate-imports/analyze', `/api/projects/${otherProjectId}/estimate-proposals`];
    if (!localOnly) {
      const bucketsBefore = bucketRequests.length;
      estimateBucketExists = false;
      try {
        for (const route of boundaryRoutes) await expectUnchangedFailure(route, { method: 'POST', data: proposalPayload }, 'missing bucket');
      } finally { estimateBucketExists = true; }
      assert.equal(bucketRequests.length, bucketsBefore, 'Missing estimate storage fails closed without creating any bucket');
      estimateBucketMaxBytes = 6_000_000;
      try {
        for (const route of boundaryRoutes) await expectUnchangedFailure(route, { method: 'POST', data: largePayload }, 'restrictive bucket');
      } finally { estimateBucketMaxBytes = 15_000_000; }
      assert.equal(bucketRequests.length, bucketsBefore, 'A restrictive bucket cannot trigger a provider configuration change');
    }
    for (const route of boundaryRoutes) {
      const result = await expectRequest(route, { method: 'POST', data: largePayload }, 201);
      if (route.includes('estimate-imports')) verifySource(result, largeBytes, true);
      else {
        const rows = result.proposals.filter(row => row.sourceFile?.name === largePayload.filename);
        assert.equal(rows.length, 2);
        verifySource(rows[0].sourceFile, largeBytes);
        assert.deepEqual(rows[1].sourceFile, rows[0].sourceFile);
      }
    }
    for (const size of [15_000_000, 15_000_001]) {
      const oversized = Buffer.alloc(size, 32);
      proposalBytes.copy(oversized);
      const data = { filename: `synthetic-${size}.pdf`, data: 'data:application/pdf;base64,' + oversized.toString('base64') };
      const writesBefore = providerWrites.length;
      const localBefore = localFiles.size;
      for (const route of boundaryRoutes) await expectUnchangedFailure(route, { method: 'POST', data }, 'existing HTTP body cap', 413);
      assert.equal(providerWrites.length, writesBefore, 'The HTTP body cap rejects before storage');
      assert.equal(localFiles.size, localBefore);
    }
    assert.equal(bucketRequests.some(bucket => bucket.id === 'estimate-documents'), false, 'Estimate ingestion must not create or reconfigure buckets');
    assert.equal(expectedErrors.length, expectedFailureCount, 'Every deliberately injected failure and body-cap rejection was exercised');
    console.log(`Estimate source retention passed (${localOnly ? 'local fallback + fail-closed backup' : 'private cloud + deduplicated/hash-verified portable backup'}): import/multiline approval history, idempotency, 10 workspace projections, UI filtering, manual scope, edit/delete/archive retention, role/tenant/project denial, upload and isolated snapshot-save failures, 8 MB PDFs, existing 16 MB HTTP cap${localOnly ? '' : ', missing/restrictive buckets fail closed without creation'}. `);
  } finally {
    await new Promise(resolve => server.close(resolve));
    global.fetch = nativeFetch;
    fs.writeFileSync = nativeWriteFileSync;
    supabase.loadLocalEnv = nativeLoadLocalEnv;
    console.error = nativeConsoleError;
    for (const file of localFiles) if (fs.existsSync(file)) fs.unlinkSync(file);
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; server.close(); });
