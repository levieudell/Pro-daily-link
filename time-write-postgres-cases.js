'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { companyA, companyB } = require('./fixtures/project-assistant');
const { canonicalHash } = require('./database/transactional-repository');
const access = require('./time-write-access');
const field = require('./time-card-field-access');
module.exports = async function ({ repository, change, request, slowRequest, bases, startWorker, checkpoint, waitFor, controls, providerEvents }) {
  const load = () => repository.load(companyA), providers = providerEvents.length, foreign = await repository.load(companyB);
  const card = (id = 501, memberId = 11, projectId = 101) => ({ id, memberId, projectId, date: '2026-01-05', inAt: '2026-01-05T08:00:00Z', outAt: '2026-01-05T09:08:00Z', hours: 1.25, status: 'draft', breaks: [], history: [] });
  const policy = () => ({ version: 1, revision: 1, roles: Object.fromEntries(access.roles.map(role => [role, access.ceiling(role)])) });
  const confirmation = preview => ({ token: preview.data.token, version: preview.data.version, confirmed: true, requestId: crypto.randomUUID() });
  const input = (action, details = {}, id) => ({ action, details, ...(id ? { id } : {}) });
  const preview = async (action, details = {}, id, user = 2, worker = 0, expected = 200) => {
    const kind = ['createPeriod', 'editPeriod', 'captureExport'].includes(action) ? 'pay-periods' : 'time-cards';
    const result = await request(bases[worker], 'POST', '/api/' + kind + '/action-preview', input(action, details, id), user);
    assert.equal(result.status, expected, action + ': ' + JSON.stringify(result.data)); return result;
  };
  const commit = async (pre, route, method = 'POST', user = 2, worker = 1, expected = 200, conf = confirmation(pre)) => {
    const result = await request(bases[worker], method, route, conf, user); assert.equal(result.status, expected, route + ': ' + JSON.stringify(result.data)); return { result, conf };
  };
  const business = db => canonicalHash(Object.fromEntries(Object.entries(db).filter(([name]) => !['auditLog', 'timeWriterPreviews', 'timeWriterReceipts'].includes(name))));
  await change(db => {
    db.company.features.timeCards = true;
    for (const name of ['timeReviewRolePolicy', 'timeReviewPolicyRequired', 'timeWriteRolePolicy', 'timeWritePolicyRequired']) delete db.company[name];
    Object.assign(db.users.find(row => row.id === 2), { role: 'project_manager', projectIds: [101], assignedCrews: ['A'], permissions: { manageTime: true } });
    db.users.find(row => row.id === 7).permissions = { manageTime: true };
    db.timeCards = []; db.payPeriods = []; db.payPeriodExports = []; db.workdays = []; db.reports = []; db.assignments = [];
    db.companyActivityCodes = [{ id: 'synthetic-office', name: 'Synthetic office', active: true }];
    db.team.find(row => row.id === 11).name = '=Synthetic own'; db.team.find(row => row.id === 12).name = 'Managed crew'; db.team.find(row => row.id === 13).name = 'PRIVATE FOREIGN CREW';
  });
  // All original writers now require an explicit durable preview. No business
  // changes, paid calls or successful body bytes escape a rejected request.
  let before = await load();
  for (const [method, route] of [['POST', '/api/time-cards'], ['PATCH', '/api/time-cards/501'], ['DELETE', '/api/time-cards/501'], ['POST', '/api/time-cards/501/submit'], ['POST', '/api/time-cards/company-clock'], ['POST', '/api/pay-periods']]) assert.equal((await request(bases[0], method, route, {}, 1)).status, 400);
  assert.deepEqual(await load(), before);
  for (const user of [4, 5, 6, 8, 9]) await preview('create', { memberId: 11, projectId: 101 }, undefined, user, 0, 403);
  await preview('create', { memberId: 13, projectId: 101 }, undefined, 2, 0, 403);
  await preview('create', { memberId: 11, projectId: 102 }, undefined, 2, 0, 403);
  const manual = await preview('create', { memberId: 11, projectId: 101, inAt: '2026-01-05T08:00:00Z', outAt: '2026-01-05T09:08:00Z', reason: 'Synthetic manual' });
  let current = await load(); assert.equal(current.revision, before.revision + 1); assert.equal(business(current.snapshot), business(before.snapshot));
  assert.ok(!JSON.stringify(current.snapshot.timeWriterPreviews).includes(manual.data.token));
  const workerAfterPreview = await startWorker(); bases.push(workerAfterPreview);
  const created = await commit(manual, '/api/time-cards', 'POST', 2, bases.length - 1, 201); const id = created.result.data.id;
  assert.equal(created.result.data.hours, 1.25); assert.equal(created.result.data.status, 'draft');
  before = await load(); await commit(manual, '/api/time-cards', 'POST', 2, 0, 200, created.conf); assert.deepEqual(await load(), before);
  await change(db => { db.sessions.push({ ...db.sessions.find(row => row.userId === 2), tokenHash: crypto.createHash('sha256').update('new-writer-session').digest('hex') }); });
  assert.equal((await request(bases[0], 'POST', '/api/time-cards', created.conf, 2, companyA, companyA, 'new-writer-session')).status, 409);
  const meal = [{ type: 'unpaid_meal', startedAt: '2026-01-05T08:30:00Z', endedAt: '2026-01-05T08:37:00Z' }, { type: 'paid_rest', startedAt: '2026-01-05T08:40:00Z', endedAt: '2026-01-05T08:50:00Z' }];
  const corrected = await commit(await preview('correct', { reason: 'Actual breaks', breaks: meal }, id), '/api/time-cards/' + id, 'PATCH');
  assert.equal(corrected.result.data.hours, 1.25, 'Gross quarter rounding, unpaid subtraction, then quarter rounding stays exact');
  await commit(await preview('submit', {}, id), '/api/time-cards/' + id + '/submit');
  let approval = await request(bases[0], 'POST', '/api/time-cards/review-preview', { ids: [id], decision: 'approve' }, 2);
  await commit(approval, '/api/time-cards/' + id + '/approve', 'POST', 2, 0);
  const returnedDraft = await commit(await preview('correct', { reason: 'Office correction' }, id), '/api/time-cards/' + id, 'PATCH');
  assert.equal(returnedDraft.result.data.status, 'draft'); for (const name of ['approvedAt', 'approvedBy', 'submittedAt', 'submittedBy']) assert.equal(returnedDraft.result.data[name], null);
  const removedPreview = await preview('remove', { reason: 'Synthetic removed' }, id), removed = await commit(removedPreview, '/api/time-cards/' + id, 'DELETE');
  before = await load(); await commit(removedPreview, '/api/time-cards/' + id, 'DELETE', 2, 0, 200, removed.conf); assert.deepEqual(await load(), before);

  // Own-card locks and derived draft labor/single-person workday semantics.
  await change(db => { db.timeCards = [card(), card(502, 12), card(503, 13, 102)]; db.timeCards[0].privateSentinel = 'PRIVATE-CARD-METADATA'; });
  await preview('correct', { reason: 'Crew is not own' }, 502, 5, 0, 404);
  await preview('submit', {}, 503, 2, 0, 404);
  current = await load(); const ownRevision = field.revision(current.snapshot.timeCards[0]);
  await preview('correct', { reason: 'Revision required' }, 501, 4, 0, 409);
  await preview('correct', { reason: 'No instant coercion', revision: ownRevision, inAt: true }, 501, 4, 0, 400);
  const ownPre = await preview('correct', { reason: 'Own actual breaks', revision: ownRevision, breaks: meal }, 501, 4);
  const ownSaved = await commit(ownPre, '/api/time-cards/501', 'PATCH', 4); assert.equal(ownSaved.result.data.hours, 1.25); assert.ok(!JSON.stringify(ownSaved.result.data).includes('PRIVATE-CARD-METADATA'));
  await change(db => { const own = db.timeCards.find(row => row.id === 501); own.workdayId = 81; own.reportId = 91; db.workdays = [{ id: 81, projectId: 101, memberIds: [11], reportId: 91, status: 'active', startedAt: own.inAt, endedAt: null }]; db.reports = [{ id: 91, project: 0, status: 'Draft', dateIso: own.date, laborEntries: [{ memberId: 11, hours: 1.25, crew: 'A' }, { memberId: 12, hours: 3, crew: 'A' }], productionEntries: [{ id: 1, quantity: 8, laborHours: 4.25 }], history: [] }]; });
  current = await load(); const dayPre = await preview('correct', { reason: 'End my workday', revision: field.revision(current.snapshot.timeCards[0]), outAt: '2026-01-05T10:08:00Z' }, 501, 4);
  await commit(dayPre, '/api/time-cards/501', 'PATCH', 4);
  current = await load(); assert.equal(current.snapshot.workdays[0].status, 'complete'); assert.equal(current.snapshot.reports[0].laborEntries[1].hours, 3); assert.equal(current.snapshot.reports[0].productionEntries[0].quantity, 8);
  for (const invalidate of [db => { db.workdays[0].status = 'active'; db.workdays[0].memberIds = [11, 12]; }, db => { db.workdays[0].status = 'complete'; db.timeCards[0].approvedBy = 'Office'; }, db => { db.timeCards[0].approvedBy = null; db.payPeriodExports = [{ id: crypto.randomUUID(), companyId: companyA, periodId: crypto.randomUUID(), summary: { records: [{ id: 501 }] } }]; }]) {
    await change(invalidate); current = await load(); before = current;
    await preview('correct', { reason: 'Locked', revision: field.revision(current.snapshot.timeCards[0]) }, 501, 4, 0, 409); assert.deepEqual(await load(), before);
  }
  await change(db => { db.payPeriodExports = []; db.workdays = []; db.reports = []; db.timeCards = [{ ...card(), reportId: 91 }, { ...card(502, 13, 102), reportId: 92 }]; db.reports = [{ id: 91, project: 0, dateIso: '2026-01-05', status: 'Draft', laborEntries: [{ memberId: 11, hours: 1.25, crew: 'A' }], history: [] }, { id: 92, project: 1, dateIso: '2026-01-05', status: 'Draft', laborEntries: [{ memberId: 13, hours: 1.25, crew: 'B' }], history: [] }, { id: 93, project: 1, dateIso: '2026-01-05', status: 'Approved', laborEntries: [{ memberId: 13, hours: 1.25, crew: 'B' }], history: [] }]; });
  before = await load(); await preview('correct', { reason: 'Reject hidden helper relink' }, 501, 2, 0, 409); assert.deepEqual(await load(), before);
  await change(db => { db.reports = []; db.timeCards = [card()]; db.timeCards.push({ ...card(501, 13, 102), id: ' 501 ' }); });
  before = await load(); await preview('correct', { reason: 'Duplicate' }, 501, 2, 0, 409); assert.deepEqual(await load(), before);

  // New previews are durable across workers. Same proof has one CAS winner;
  // stale, slow-body, in-flight and replay authority all use current sessions.
  await change(db => { db.timeCards = [card()]; });
  const racing = confirmation(await preview('submit', {}, 501)); before = await load(); controls.gate = checkpoint(); controls.gate.expected = 99;
  const racers = bases.slice(0, 2).map(base => request(base, 'POST', '/api/time-cards/501/submit', racing, 2));
  await waitFor(() => controls.gate.count === 2); assert.deepEqual(await load(), before); controls.gate.resolve(); const raceResults = await Promise.all(racers); controls.gate = null;
  assert.deepEqual(raceResults.map(row => row.status).sort(), [200, 409]); current = await load(); assert.equal(current.revision, before.revision + 1);
  await commit({ data: racing }, '/api/time-cards/501/submit', 'POST', 2, 1, 200, racing); assert.deepEqual(await load(), current);
  await change(db => { db.timeCards[0] = card(); });
  const stale = confirmation(await preview('submit', {}, 501)); await change(db => { db.timeCards[0].hours = 2; });
  assert.equal((await request(bases[1], 'POST', '/api/time-cards/501/submit', stale, 2)).status, 409);
  const boundSession = confirmation(await preview('submit', {}, 501));
  const originalSession = structuredClone((await load()).snapshot.sessions.find(row => row.userId === 2));
  await change(db => { db.sessions.find(row => row.tokenHash === originalSession.tokenHash).expiresAt = '2000-01-01'; });
  before = await load(); assert.equal((await request(bases[1], 'POST', '/api/time-cards/501/submit', boundSession, 2)).status, 401); assert.deepEqual(await load(), before);
  await change(db => { Object.assign(db.sessions.find(row => row.tokenHash === originalSession.tokenHash), originalSession); });
  const inflight = confirmation(await preview('submit', {}, 501)); controls.gate = checkpoint(); controls.gate.expected = 99;
  const pending = request(bases[0], 'POST', '/api/time-cards/501/submit', inflight, 2); await waitFor(() => controls.gate.count === 1);
  await change(db => { db.users.find(row => row.id === 2).assignedCrews = ['B']; }); before = await load(); controls.gate.resolve(); assert.equal((await pending).status, 409); controls.gate = null; assert.deepEqual(await load(), before);
  assert.equal((await request(bases[1], 'POST', '/api/time-cards/501/submit', inflight, 2)).status, 404);
  await change(db => { db.users.find(row => row.id === 2).assignedCrews = ['A']; });
  const slowInput = confirmation(await preview('submit', {}, 501)), slow = await slowRequest(bases[0], 2, slowInput, '/api/time-cards/501/submit');
  await change(db => { db.company.timeWriteRolePolicy = policy(); db.company.timeWriteRolePolicy.roles.project_manager.submitCards = false; }); before = await load(); slow.done(); assert.equal((await slow.result).status, 403); assert.deepEqual(await load(), before);
  await change(db => { delete db.company.timeWriteRolePolicy; });
  const lossPre = await preview('submit', {}, 501), lossInput = confirmation(lossPre); controls.dropAck = true;
  assert.equal((await request(bases[0], 'POST', '/api/time-cards/501/submit', lossInput, 2)).status, 503); controls.dropAck = false;
  before = await load(); await commit(lossPre, '/api/time-cards/501/submit', 'POST', 2, 1, 200, lossInput); assert.deepEqual(await load(), before);
  await change(db => { db.timeCards[0] = card(); });
  const rejectPre = await preview('submit', {}, 501); before = await load(); controls.rejectCommit = true;
  await commit(rejectPre, '/api/time-cards/501/submit', 'POST', 2, 0, 503); controls.rejectCommit = false; assert.deepEqual(await load(), before);
  await change(db => { db.timeCards = []; db.workdays = []; db.reports = []; });
  const openPre = await preview('companyClock', { activityCodeId: 'synthetic-office' }, undefined, 4), opened = await commit(openPre, '/api/time-cards/company-clock', 'POST', 4, 1, 201);
  assert.equal(opened.result.data.outAt, null); assert.equal(opened.result.data.status, 'draft');
  const closed = await commit(await preview('clockOut', {}, opened.result.data.id, 4), '/api/time-cards/' + opened.result.data.id + '/clock-out', 'POST', 4);
  assert.equal(closed.result.data.hours, Math.max(0, Math.round((Date.parse(closed.result.data.outAt) - Date.parse(closed.result.data.inAt)) / 3600000 * 4) / 4));
  assert.equal(closed.result.data.status, 'draft');

  // Period/export calculations call the original module, retain saved timezone,
  // fixed versions and office eligibility; summaries/CSVs are scoped/projection-only.
  await change(db => { db.timeCards = [{ ...card(), status: 'approved', approvedBy: 'Office', inAt: '2026-01-06T07:00:00Z', outAt: '2026-01-06T10:00:00Z', date: 'WRONG DISPLAY DATE', hours: 3, privateSentinel: 'PRIVATE-METADATA' }, { ...card(502, 12), status: 'approved', approvedBy: 'Office' }, { ...card(503, 13, 102), status: 'approved', approvedBy: 'Office' }]; });
  const periodPre = await preview('createPeriod', { label: 'Synthetic saved zone', from: '2026-01-05', to: '2026-01-05' }, undefined, 7);
  const periodCreated = await commit(periodPre, '/api/pay-periods', 'POST', 7, 1, 201), periodId = periodCreated.result.data.id;
  await change(db => { db.company.timezone = 'UTC'; });
  let summary = await request(bases[0], 'GET', '/api/pay-periods/' + periodId + '/summary', undefined, 2);
  assert.equal(summary.status, 200); assert.equal(summary.data.approvedCount, 2); assert.equal(summary.data.period.timeZone, 'America/Los_Angeles'); assert.ok(!JSON.stringify(summary.data).includes('PRIVATE')); assert.equal(summary.data.records[0].date, '2026-01-05');
  const pmCsv = await request(bases[0], 'GET', '/api/time-cards.csv', undefined, 2); assert.equal(pmCsv.status, 200); assert.ok(!pmCsv.data.includes('PRIVATE')); assert.ok(pmCsv.data.includes("'=Synthetic own"));
  // Buffer export bytes, then fence against the latest SQL revision before
  // publishing them. A revoke committed during generation yields JSON denial.
  controls.readGate = checkpoint();
  const readingCsv = request(bases[0], 'GET', '/api/time-cards.csv', undefined, 2);
  await waitFor(() => controls.readGate.count === 3);
  await change(db => { db.company.timeWriteRolePolicy = policy(); db.company.timeWriteRolePolicy.roles.project_manager.downloadCards = false; });
  controls.readGate.resolve(); const fencedCsv = await readingCsv; controls.readGate = null;
  assert.equal(fencedCsv.status, 409); assert.ok(!fencedCsv.headers.get('content-type').includes('text/csv')); assert.ok(!JSON.stringify(fencedCsv.data).includes('PRIVATE'));
  await change(db => { delete db.company.timeWriteRolePolicy; });
  const pmSession = structuredClone((await load()).snapshot.sessions.find(row => row.userId === 2)), expiry = Date.now() + 3000;
  await change(db => { db.sessions.find(row => row.tokenHash === pmSession.tokenHash).expiresAt = new Date(expiry).toISOString(); });
  before = await load(); controls.readGate = checkpoint();
  const expiringCsv = request(bases[0], 'GET', '/api/time-cards.csv', undefined, 2);
  await waitFor(() => controls.readGate.count === 3); await waitFor(() => Date.now() > expiry);
  controls.readGate.resolve(); const expiredCsv = await expiringCsv; controls.readGate = null;
  assert.equal(expiredCsv.status, 401); assert.ok(!expiredCsv.headers.get('content-type').includes('text/csv')); assert.deepEqual(await load(), before, 'Natural session expiry changes no tenant revision');
  await change(db => { Object.assign(db.sessions.find(row => row.tokenHash === pmSession.tokenHash), pmSession); });
  const unlockedCompany = structuredClone((await load()).snapshot.company), trialEnd = Date.now() + 3000;
  await change(db => { Object.assign(db.company, { demo: false, billingExempt: false, subscriptionStatus: 'Trial', trialEndsAt: new Date(trialEnd).toISOString() }); });
  before = await load(); controls.readGate = checkpoint();
  const expiringTrialCsv = request(bases[0], 'GET', '/api/time-cards.csv', undefined, 2);
  await waitFor(() => controls.readGate.count === 3); await waitFor(() => Date.now() > trialEnd);
  controls.readGate.resolve(); const endedTrialCsv = await expiringTrialCsv; controls.readGate = null;
  assert.equal(endedTrialCsv.status, 402); assert.ok(!endedTrialCsv.headers.get('content-type').includes('text/csv')); assert.deepEqual(await load(), before, 'Natural account lock changes no tenant revision');
  await change(db => { db.company = unlockedCompany; });
  for (const user of [2, 4, 5, 6, 8, 9]) { await preview('captureExport', {}, periodId, user, 0, 403); assert.equal((await request(bases[0], 'GET', '/api/pay-periods/' + periodId + '/exports', undefined, user)).status, 403); }
  const exportPre = await preview('captureExport', {}, periodId, 7), exportSaved = await commit(exportPre, '/api/pay-periods/' + periodId + '/exports', 'POST', 7, 1, 201), fixed = exportSaved.result.data;
  assert.equal(fixed.version, 1); assert.equal(fixed.summary.approvedCount, 3); assert.ok(!JSON.stringify(fixed).includes('PRIVATE-METADATA'));
  const fixedPath = '/api/pay-periods/' + periodId + '/exports/' + fixed.id;
  const fixedJSON = await request(bases[0], 'GET', fixedPath, undefined, 7), fixedCSV = await request(bases[1], 'GET', fixedPath + '.csv', undefined, 7);
  assert.equal(fixedCSV.status, 200); assert.ok(fixedCSV.data.includes("'=Synthetic own")); assert.ok(!fixedCSV.data.includes('PRIVATE-METADATA'));
  await preview('editPeriod', { label: 'Forbidden reset', from: '2026-01-05', to: '2026-01-06', reason: 'why' }, periodId, 7, 0, 409);
  current = await load(); await preview('correct', { reason: 'Captured field lock', revision: field.revision(current.snapshot.timeCards[0]) }, 501, 4, 0, 409);
  const captureRace = confirmation(await preview('captureExport', { supersedesId: fixed.id, reason: 'Version correction' }, periodId, 7)); controls.gate = checkpoint(); controls.gate.expected = 99;
  const capturing = request(bases[0], 'POST', '/api/pay-periods/' + periodId + '/exports', captureRace, 7); await waitFor(() => controls.gate.count === 1);
  await change(db => { db.timeCards[0].hours = 4; }); before = await load(); controls.gate.resolve(); assert.equal((await capturing).status, 409); controls.gate = null; assert.deepEqual(await load(), before);
  await preview('captureExport', { supersedesId: fixed.id }, periodId, 7, 0, 400);
  const correctedExport = await commit(await preview('captureExport', { supersedesId: fixed.id, reason: 'Explicit fixed correction' }, periodId, 7), '/api/pay-periods/' + periodId + '/exports', 'POST', 7, 1, 201);
  assert.equal(correctedExport.result.data.version, 2); assert.equal(correctedExport.result.data.supersedesId, fixed.id);
  assert.deepEqual((await request(bases[0], 'GET', fixedPath, undefined, 7)).data, fixedJSON.data); assert.equal((await request(bases[0], 'GET', fixedPath + '.csv', undefined, 7)).data, fixedCSV.data);
  const beforeFailure = await load(); controls.rejectCommit = true;
  await preview('captureExport', { supersedesId: correctedExport.result.data.id, reason: 'Rejected preview persistence' }, periodId, 7, 0, 503); controls.rejectCommit = false; assert.deepEqual(await load(), beforeFailure);
  await change(db => { db.payPeriodExports.push({ ...db.payPeriodExports[0], id: crypto.randomUUID(), companyId: companyB }); });
  before = await load();
  for (const route of ['/api/pay-periods', '/api/pay-periods/' + periodId + '/summary', '/api/pay-periods/' + periodId + '/exports']) assert.equal((await request(bases[0], 'GET', route, undefined, 7)).status, 409);
  assert.deepEqual(await load(), before);
  await change(db => { db.payPeriodExports = db.payPeriodExports.filter(row => row.companyId === companyA); });
  await change(db => { db.company.timeWriteRolePolicy = policy(); db.company.timeWriteRolePolicy.roles.admin.downloadExports = false; });
  before = await load(); assert.equal((await request(bases[0], 'GET', fixedPath + '.csv', undefined, 7)).status, 403); assert.deepEqual(await load(), before);
  assert.equal((await request(bases[0], 'POST', '/api/time-cards/action-preview', input('create', { memberId: 11, projectId: 101 }), 2, companyB)).status, 401);
  await change(db => { db.company.timeWriteRolePolicy.roles.project_manager.captureExports = true; });
  assert.equal((await request(bases[0], 'GET', '/api/pay-periods', undefined, 2)).status, 403);
  assert.equal((await request(bases[0], 'GET', fixedPath, undefined, 1)).status, 200, 'Owner fixed access cannot be disabled by malformed policy');
  await change(db => { delete db.company.timeWriteRolePolicy; db.company.features.timeCards = false; });
  for (const route of ['/api/time-cards.csv', '/api/pay-periods', fixedPath + '.csv', '/api/company-activities']) assert.equal((await request(bases[0], 'GET', route, undefined, 1)).status, 404);
  assert.equal(providerEvents.length, providers); assert.deepEqual(await repository.load(companyB), foreign);
  console.log('Time-writer PostgreSQL/HTTP passed: durable cross-worker/restart preview, no-business preview, own/PM scope, gross/meal rounding and locks, frozen unrelated cards/reports/workdays, concurrent confirmation/stale/inflight/slow-body revocation, lost/rejected commit, real clocks, saved-zone fixed version exports, scoped escaped CSV/private projection, immutable owner and tenant IDOR. No provider/payment calls.');
};
