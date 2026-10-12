'use strict';
// Actual normal server, memory Supabase CAS, generated actors and image bytes.
// No synthetic compatibility installer, production environment or network provider.
const assert = require('node:assert/strict'), crypto = require('node:crypto'), fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { canonicalHash } = require('./database/transactional-repository');
const nativeFetch = globalThis.fetch, blobs = new Map();
let origin, requests = 0, imageWrites = 0, providerCalls = 0, emailCalls = 0, emailOutcome = 'accepted', readsHook = null;
globalThis.fetch = (input, options) => {
  const target = String(input?.url || input);
  if (target === 'https://api.openai.com/v1/responses') {
    assert.equal(options.headers.Authorization || options.headers.authorization, 'Bearer synthetic-memory-provider-only');
    const payload = JSON.parse(options.body); assert.equal(payload.input, 'Synthetic completed work');
    assert.ok(!payload.instructions.includes('Foreign synthetic member'), 'Unrelated crew facts cannot enter extraction context');
    providerCalls++;
    return Promise.resolve(new Response(JSON.stringify({ output: [{ content: [{ type: 'output_text', text: JSON.stringify({ originalLanguage: 'es', englishTranslation: 'Synthetic completed work', summary: 'Synthetic completed work', labor: '', quantity: '', productions: [], materials: '', equipment: '', delays: '', safety: '', issue: '', next: '', customFieldSuggestions: [] }) }] }] }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  }
  if (target === 'https://api.resend.com/emails') {
    assert.equal(options.headers.Authorization || options.headers.authorization, 'Bearer synthetic-memory-provider-only');
    const payload = JSON.parse(options.body); assert.equal(payload.to.length, 1); assert.ok(payload.to[0].endsWith('@example.invalid'));
    emailCalls++; if (emailOutcome === 'unknown') throw Error('Synthetic unknown email response');
    return Promise.resolve(new Response(JSON.stringify({ id: 'synthetic-email-' + emailCalls }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  }
  assert.ok(origin && target.startsWith(origin + '/'), 'Only this owned loopback HTTP server may use a network socket');
  return nativeFetch(input, options);
};
const supabase = require('./database/supabase');
supabase.loadLocalEnv = () => {};
supabase.upload = async (bucket, key, bytes, type) => { imageWrites++; blobs.set(bucket + '/' + key, { bytes: Buffer.from(bytes), type }); return { bucket, objectKey: key, url: '/api/files/' + bucket + '/' + key }; };
supabase.download = async (bucket, key) => { if (readsHook) await readsHook(); const row = blobs.get(bucket + '/' + key); assert.ok(row, 'Only this test owns the blob'); return new Response(row.bytes, { headers: { 'Content-Type': row.type } }); };
supabase.remove = async () => { throw Error('No blob deletion is authorized by this fixture'); };
const fixture = require('./roles-production-http.test'), { server } = fixture;
const ownedDirectory = path.resolve(path.dirname(process.env.PDL_DB_FILE));
assert.ok(ownedDirectory.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(ownedDirectory).startsWith('pdl-roles-production-http-'), 'Cleanup must stay in this fixture-owned temporary directory');
const registry = require('./capability-registry');
const pmToken = crypto.randomBytes(32).toString('base64url'); fixture.tokens.set(4, pmToken);
fixture.alter(db => {
  db.projects[0].customer = 'Synthetic customer';
  db.projects.push({ id: 102, name: 'Foreign synthetic project', customer: 'Foreign customer', site: 'Foreign site', estimateItems: [] });
  db.team.push({ id: 13, name: 'Foreign synthetic member', crew: 'Foreign crew' });
  db.users.push({ id: 4, companyId: fixture.A, name: 'Synthetic PM', email: 'pm@example.invalid', role: 'project_manager', status: 'Active', projectIds: [101], assignedCrews: ['Synthetic Crew'], permissions: { viewDailies: true, approveDailies: true, scheduleCrews: true } });
  db.sessions.push({ id: crypto.randomUUID(), companyId: fixture.A, userId: 4, tokenHash: crypto.createHash('sha256').update(pmToken).digest('hex'), createdAt: new Date().toISOString(), expiresAt: '2099-01-01T00:00:00.000Z' });
  db.company.pricingAccess = { enabled: false, officeMode: 'selected', userIds: [] };
  db.changes = [{ id: 77, projectId: 101, number: 'PC-077', title: 'Synthetic extra work', status: 'Potential', amount: 120, lines: [{ description: 'Synthetic material', quantity: 2, unit: 'EA', laborHours: 1, materialCost: 120 }], history: [], createdAt: new Date().toISOString(), createdBy: 'Synthetic office' }];
});
function policy(db, role, flags) {
  const family = registry.families.find(row => row[0] === 'daily'); db.company.dailyPolicyRequired = true;
  db.company.dailyRolePolicy = { version: 1, revision: 1, roles: Object.fromEntries(family[4].roles.map(role => [role, family[4].ceiling(role)])) };
  Object.assign(db.company.dailyRolePolicy.roles[role], flags);
}
async function call(method, route, { body, user = 1, company = fixture.A, raw = false } = {}) {
  requests++;
  const response = await fetch(origin + route, { method, signal: AbortSignal.timeout(10000), headers: { ...(company ? { 'X-PDL-Company': company } : {}), ...(user ? { Authorization: 'Bearer ' + fixture.tokens.get(user) } : {}), 'Content-Type': 'application/json', ...(method !== 'GET' ? { 'X-PDL-Operation': crypto.randomUUID() } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = raw ? Buffer.from(await response.arrayBuffer()) : await response.json();
  return { status: response.status, data, headers: response.headers };
}
const okay = response => { assert.equal(response.status, 200, JSON.stringify(response.data)); return response.data; };
function resetChange() { fixture.alter(db => { Object.assign(db.changes.find(row => row.id === 77), { status: 'Potential', history: [] }); for (const key of ['customerTokenHash', 'submittedAt', 'decidedAt', 'decidedBy', 'decisionNote', 'updatedAt']) delete db.changes[0][key]; }); }
async function submit() { const value = okay(await call('POST', '/api/changes/77/submit', { body: {} })); return new URL(value.url, origin).searchParams.get('t'); }
async function main() {
  let journeys = 0;
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); }); origin = 'http://127.0.0.1:' + server.address().port;
    let before = canonicalHash(fixture.read());
    assert.equal((await call('POST', '/api/changes/77/submit', { user: 4, body: {} })).status, 403, 'Pricing denied PM cannot obtain a public financial credential');
    assert.equal(canonicalHash(fixture.read()), before); journeys++;
    let token = await submit(), publicRoute = '/api/change-order/' + token;
    assert.match(token, /^[A-Za-z0-9_-]{32}$/);
    assert.ok(!JSON.stringify(fixture.read()).includes(token), 'Only the token hash is durable');
    const doc = okay(await call('GET', publicRoute, { user: null, company: null }));
    assert.equal(doc.amount, 120); assert.equal(doc.lines[0].materialCost, 120); assert.equal(doc.company.name, fixture.read().company.name);
    assert.ok(!JSON.stringify(doc).includes('customerTokenHash') && !('users' in doc));
    assert.equal((await call('GET', publicRoute, { user: null, company: fixture.B })).status, 404);
    assert.equal((await call('GET', publicRoute + 'x', { user: null, company: null })).status, 404); journeys++;
    before = canonicalHash(fixture.read());
    for (const body of [{ decision: 'Rejected', name: 'Synthetic customer' }, { decision: 'approved', name: 'x'.repeat(121) }, { decision: 'approved', name: 'Synthetic customer', projectId: 102 }]) assert.equal((await call('POST', publicRoute + '/decision', { user: null, company: null, body })).status, 400);
    assert.equal(canonicalHash(fixture.read()), before); journeys++;
    const decided = okay(await call('POST', publicRoute + '/decision', { user: null, company: null, body: { decision: 'approved', name: 'Synthetic customer', note: 'Synthetic signature' } }));
    assert.equal(decided.status, 'Approved');
    let saved = fixture.read(), historyCount = saved.changes[0].history.length, auditCount = saved.auditLog.length; before = canonicalHash(saved);
    assert.equal(okay(await call('POST', publicRoute + '/decision', { user: null, company: null, body: { decision: 'declined', name: 'Other synthetic customer' } })).already, true);
    assert.equal(canonicalHash(fixture.read()), before); assert.equal(fixture.read().changes[0].history.length, historyCount); assert.equal(fixture.read().auditLog.length, auditCount); journeys++;
    const privateRead = okay(await call('GET', '/api/changes?projectId=101'));
    assert.ok(!JSON.stringify(privateRead).includes('customerTokenHash'), 'Managed normal change reads strip token custody even with no policy'); journeys++;
    resetChange(); const old = token; token = await submit(); publicRoute = '/api/change-order/' + token;
    assert.equal((await call('GET', '/api/change-order/' + old, { user: null, company: null })).status, 404);
    before = canonicalHash(fixture.read());
    const originalRequest = supabase.request; let compete = true;
    supabase.request = async (route, options = {}) => { if (compete && route === '/rest/v1/rpc/commit_roles_snapshot') { compete = false; fixture.alter(db => { db.changes[0].customerTokenHash = crypto.createHash('sha256').update('B'.repeat(32)).digest('hex'); }); } return originalRequest(route, options); };
    const stale = await call('POST', publicRoute + '/decision', { user: null, company: null, body: { decision: 'approved', name: 'Synthetic late signer' } }); supabase.request = originalRequest;
    assert.equal(stale.status, 409); assert.equal(fixture.read().changes[0].status, 'Submitted'); assert.equal(fixture.read().changes[0].decidedBy, undefined); journeys++;
    resetChange(); token = await submit(); publicRoute = '/api/change-order/' + token;
    const image = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from('synthetic-owned-image')]);
    const uploaded = await call('POST', '/api/photos', { body: { projectId: 101, source: 'office', changeId: 77, caption: 'Synthetic shared evidence', files: [{ type: 'image/png', data: 'data:image/png;base64,' + image.toString('base64') }] } });
    assert.equal(uploaded.status, 201, JSON.stringify(uploaded.data));
    const photoId = uploaded.data[0].id, customerDoc = okay(await call('GET', publicRoute, { user: null, company: null }));
    const customerPhoto = customerDoc.photos.find(photo => photo.caption === 'Synthetic shared evidence'); assert.ok(customerPhoto);
    const bytes = await call('GET', customerPhoto.url, { user: null, company: null, raw: true }); assert.equal(bytes.status, 200); assert.deepEqual(bytes.data, image);
    assert.equal((await call('GET', publicRoute + '/photos/99999', { user: null, company: null })).status, 404); journeys++;
    fixture.alter(db => { db.photos.push({ ...db.photos.find(row => row.id === photoId), id: photoId + 1, changeId: null, caption: 'Private alias' }); });
    assert.equal((await call('GET', publicRoute + '/photos/' + photoId, { user: null, company: null })).status, 404, 'An unrelated same-byte private alias cannot be shared');
    fixture.alter(db => { db.photos = db.photos.filter(row => row.id !== photoId + 1); });
    readsHook = async () => { readsHook = null; fixture.alter(db => { db.changes[0].customerTokenHash = 'c'.repeat(64); }); };
    const heldPhoto = await call('GET', publicRoute + '/photos/' + photoId, { user: null, company: null, raw: true }); assert.ok([404, 409].includes(heldPhoto.status)); assert.notDeepEqual(heldPhoto.data, image, 'Revocation during byte read cannot deliver original bytes'); journeys++;
    fixture.alter(db => {
      db.photos = []; policy(db, 'admin', { viewReports: false, createReports: false, editReports: false, approveReports: false, viewWorkdays: false, runWorkdays: false });
      db.changes = [{ id: 77, projectId: 101, number: 'PC-077', title: 'Manual visible change', status: 'Potential', amount: 20, history: [] }, { id: 78, projectId: 101, reportId: db.reports[0].id, number: 'PC-078', title: 'Hidden report change', status: 'Submitted', amount: 900, history: [] }];
    });
    const summary = okay(await call('GET', '/api/state', { user: 3 })); assert.ok(!('changes' in summary));
    assert.deepEqual(summary.projectChanges.find(row => row.projectId === 101), { projectId: 101, awaitingDecision: 0, openItems: 1, approvedCount: 0, openExposure: 20, approvedTotal: 0 });
    assert.equal((await call('POST', '/api/changes/78/submit', { user: 3, body: {} })).status, 404); journeys++;
    fixture.alter(db => {
      delete db.company.dailyRolePolicy; delete db.company.dailyPolicyRequired; policy(db, 'field', {});
      db.workdays = [{ id: 99, projectId: 101, memberIds: [12], startedAt: new Date(Date.now() - 3600000).toISOString(), date: new Date().toISOString().slice(0, 10), status: 'active', history: [] }];
      db.timeCards = []; db.company.features = { ...db.company.features, timeCards: false }; db.company.autoAdoptActualTimes = false;
    });
    const ended = okay(await call('POST', '/api/workdays/99/end', { user: 2, body: { notes: 'Synthetic completed work', next: 'Synthetic review', language: 'es-MX' } }));
    assert.equal(ended.workday.status, 'complete'); assert.ok(ended.report.id);
    const beforeAI = canonicalHash(fixture.read().reports);
    // This sentinel is consumed only by the in-memory response above. The
    // actual server still performs its real journal admission and return fence.
    process.env.OPENAI_API_KEY = 'synthetic-memory-provider-only';
    const [photos, ai] = await Promise.all([
      call('POST', '/api/photos', { user: 2, body: { projectId: 101, source: 'field', reportId: ended.report.id, workdayId: 99, phase: 'end', files: [{ type: 'image/png', data: 'data:image/png;base64,' + image.toString('base64') }] } }),
      call('POST', '/api/ai/extract', { user: 2, body: { notes: 'Synthetic completed work', language: 'es-MX', projectId: 101, reportId: ended.report.id, estimateItems: fixture.read().projects[0].estimateItems.map(({ id, name, unit }) => ({ id, name, unit })) } })
    ]);
    assert.equal(photos.status, 201, JSON.stringify(photos.data)); assert.equal(ai.status, 200, JSON.stringify(ai.data)); assert.equal(ai.data.source, 'openai', 'Real extraction uses the accepted in-memory provider result'); assert.equal(providerCalls, 1); assert.equal(canonicalHash(fixture.read().reports), beforeAI, 'Extraction cannot save its unreviewed report draft'); journeys++;
    process.env.OPENAI_API_KEY = ''; process.env.RESEND_API_KEY = 'synthetic-memory-provider-only';
    fixture.alter(db => { db.changes[0].fieldFlag = true; db.changes[0].createdBy = db.users.find(row => row.id === 2).name; });
    resetChange(); token = await submit(); publicRoute = '/api/change-order/' + token;
    assert.equal(emailCalls, 1, 'The submit route awaits and journals its scoped field status email');
    okay(await call('POST', publicRoute + '/decision', { user: null, company: null, body: { decision: 'approved', name: 'Synthetic signed customer' } }));
    assert.equal(emailCalls, 2, 'Token authority can deliver only its named current change notification');
    assert.equal(fixture.read().rolesProviderAttempts.filter(row => row.kind === 'email').length, 2); journeys++;
    fixture.alter(db => { db.changes[0].status = 'Submitted'; }); emailOutcome = 'unknown';
    const uncertain = await call('POST', publicRoute + '/decision', { user: null, company: null, body: { decision: 'declined', name: 'Synthetic signed customer' } });
    assert.equal(uncertain.status, 503, JSON.stringify(uncertain.data)); assert.equal(uncertain.data.code, 'PDL_PROVIDER_OUTCOME_UNKNOWN'); assert.match(uncertain.data.operationId, /^[a-f0-9-]{36}$/);
    assert.equal(emailCalls, 3); assert.equal(fixture.read().changes[0].status, 'Rejected');
    assert.equal(fixture.read().rolesProviderAttempts.filter(row => row.kind === 'email').at(-1).status, 'unknown');
    before = canonicalHash(fixture.read());
    assert.equal(okay(await call('POST', publicRoute + '/decision', { user: null, company: null, body: { decision: 'approved', name: 'Synthetic replay signer' } })).already, true);
    assert.equal(emailCalls, 3, 'Unknown delivery must never be silently resent by decision replay'); assert.equal(canonicalHash(fixture.read()), before); journeys++;
    console.log(JSON.stringify({ passed: true, journeys, requests, imageWrites, aiProviderCalls: providerCalls, emailProviderCalls: emailCalls, externalCalls: 0, normalServer: true, syntheticTransport: true, testInstallerUsed: false }));
  } finally {
    readsHook = null; process.env.OPENAI_API_KEY = ''; process.env.RESEND_API_KEY = ''; server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); blobs.clear(); globalThis.fetch = nativeFetch; fs.rmSync(ownedDirectory, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
