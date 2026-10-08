'use strict';
const assert = require('node:assert/strict'), crypto = require('node:crypto');
const { companyA, companyB } = require('./fixtures/project-assistant');
const { canonicalHash } = require('./database/transactional-repository');
const access = require('./daily-access'), time = require('./time-write-access');
module.exports = async function ({ repository, change, request, slowRequest, bases, startWorker, checkpoint, waitFor, controls, providerEvents }) {
  const load = () => repository.load(companyA), foreign = await repository.load(companyB), providers = providerEvents.length;
  const policy = module => ({ version: 1, revision: 1, roles: Object.fromEntries(module.roles.map(role => [role, module.ceiling(role)])) });
  const confirmation = pre => ({ token: pre.data.token, version: pre.data.version, confirmed: true, requestId: crypto.randomUUID() });
  const proposal = (action, details = {}, id) => ({ action, details, ...(id ? { id } : {}) });
  const preview = async (action, details = {}, id, user = 2, worker = 0, expected = 200) => {
    const result = await request(bases[worker], 'POST', '/api/daily-actions/preview', proposal(action, details, id), user); assert.equal(result.status, expected, action + ': ' + JSON.stringify(result.data)); return result;
  };
  const commit = async (pre, route, method = 'POST', user = 2, worker = 1, expected = 200, conf = confirmation(pre)) => {
    const result = await request(bases[worker], method, route, conf, user); assert.equal(result.status, expected, route + ': ' + JSON.stringify(result.data)); return { result, conf };
  };
  const details = (status = 'Draft', memberId = 11, projectId = 101) => ({ projectId, dateIso: '2026-01-05', status, notes: 'Installed synthetic framing.', signature: 'Synthetic signed name', productionEntries: [{ estimateItemId: 1, description: 'Framing', quantity: 1, unit: 'EA', laborHours: 2 }], laborEntries: [{ memberId, hours: 2 }] });
  const report = (id = 51, memberId = 11, project = 0) => ({ id, project, date: 'Jan 5', dateIso: '2026-01-05', foreman: 'Synthetic user 4', status: 'Draft', notes: 'Installed synthetic framing.', originalNotes: 'Installed synthetic framing.', signature: 'Existing signature', summary: 'Installed synthetic framing.', productionEntries: [{ estimateItemId: 1, description: 'Framing', quantity: 1, unit: 'EA', laborHours: 2 }], laborEntries: [{ memberId, hours: 2, crew: memberId === 13 ? 'B' : 'A' }], flags: [], history: [] });
  const business = db => canonicalHash(Object.fromEntries(Object.entries(db).filter(([name]) => !['dailyActionPreviews', 'dailyActionReceipts', 'auditLog'].includes(name))));
  await change(db => {
    db.company.features.timeCards = true; db.company.features.templates = false; db.company.timezone = 'America/Los_Angeles';
    for (const name of ['timeWriteRolePolicy', 'timeWritePolicyRequired', 'timeReviewRolePolicy', 'timeReviewPolicyRequired', 'dailyRolePolicy', 'dailyPolicyRequired']) delete db.company[name];
    db.company.pricingAccess = { enabled: false, officeMode: 'selected', userIds: [] };
    Object.assign(db.users.find(row => row.id === 2), { role: 'project_manager', projectIds: [101], assignedCrews: ['A'], permissions: { viewDailies: true, approveDailies: true, manageTime: true } });
    db.users.find(row => row.id === 7).permissions = { manageTime: true };
    db.reports = []; db.workdays = []; db.timeCards = []; db.photos = []; db.payPeriods = []; db.payPeriodExports = []; db.reportingExports = [];
    db.assignments = [{ id: 81, projectId: 101, memberIds: [11, 12], date: '2026-01-05', start: '08:00', end: '16:00' }];
    db.projects[0].contractType = 'tm'; db.projects[0].tmSettings = { defaultLaborRate: 75 }; db.projects[0].estimateItems = [{ id: 1, name: 'Framing', unit: 'EA', plannedQuantity: 10, budgetHours: 20, cost: 100 }];
    db.projects[1].estimateItems = [{ id: 1, name: 'Private work', unit: 'EA', plannedQuantity: 10 }];
  });
  let before = await load();
  for (const [method, route] of [['POST', '/api/reports'], ['PATCH', '/api/reports/51'], ['PATCH', '/api/reports/51/approve'], ['POST', '/api/workdays/start'], ['POST', '/api/workdays/81/end'], ['POST', '/api/reporting-exports']]) assert.equal((await request(bases[0], method, route, {}, 1)).status, 400);
  for (const route of ['/api/reports/51/safety', '/api/reports/51/disposition', '/api/reports/51/rate-review']) assert.equal((await request(bases[0], 'PATCH', route, { files: [{ type: 'image/png', data: 'data:image/png;base64,AAAA' }] }, 1)).status, 503);
  for (const route of ['/api/state', '/api/action-center', '/api/exceptions', '/api/production', '/api/insights', '/api/files/project-photos/foreign', '/api/local-files/foreign.jpg']) assert.equal((await request(bases[0], 'GET', route, undefined, 1)).status, 503);
  assert.deepEqual(await load(), before);
  for (const user of [6, 8, 9]) await preview('createReport', details(), undefined, user, 0, 403);
  await preview('createReport', details('Draft', 13), undefined, 2, 0, 403);
  await preview('createReport', details('Draft', 11, 102), undefined, 5, 0, 403);
  await preview('createReport', { ...details(), projectId: 999, project: 0 }, undefined, 2, 0, 400);
  await preview('createReport', { ...details(), extracted: { privateSentinel: 'INJECTED' } }, undefined, 2, 0, 400);
  const createPre = await preview('createReport', details(), undefined, 4); let current = await load(); assert.equal(current.revision, before.revision + 1); assert.equal(business(current.snapshot), business(before.snapshot));
  assert.ok(!JSON.stringify(current.snapshot.dailyActionPreviews).includes(createPre.data.token));
  bases.push(await startWorker());
  const created = await commit(createPre, '/api/reports', 'POST', 4, bases.length - 1, 201), id = created.result.data.id;
  assert.equal(created.result.data.status, 'Draft'); assert.equal(created.result.data.signature, 'Synthetic signed name');
  before = await load(); await commit(createPre, '/api/reports', 'POST', 4, 0, 200, created.conf); assert.deepEqual(await load(), before);
  assert.equal((await request(bases[0], 'POST', '/api/photos', { projectId: 101, reportId: id, source: 'field', files: [{ type: 'image/png', data: 'data:image/png;base64,AAAA' }] }, 4)).status, 400);
  assert.deepEqual(await load(), before, 'Interrupted upload preserves the persisted draft identity and content');
  // Implicit same-key Draft replacement and unrelated tenant cleanup cannot be staged.
  await preview('createReport', details(), undefined, 4, 0, 409); assert.deepEqual(await load(), before);
  const retryPre = await preview('editReport', { status: 'Draft', summary: 'Retry keeps one existing draft' }, id, 4);
  await commit(retryPre, '/api/reports/' + id, 'PATCH', 4);
  const balanced = { status: 'Needs review', productionEntries: details().productionEntries, laborEntries: details().laborEntries };
  await preview('editReport', { ...balanced, productionEntries: [{ ...balanced.productionEntries[0], laborHours: 1.98 }] }, id, 4, 0, 400);
  const submitted = await commit(await preview('editReport', balanced, id, 4), '/api/reports/' + id, 'PATCH', 4);
  assert.equal(submitted.result.data.signature, 'Synthetic signed name'); assert.equal(submitted.result.data.status, 'Needs review');
  await preview('editReport', { status: 'Approved' }, id, 4, 0, 409);
  for (const user of [4, 5, 6, 8, 9]) await preview('approveReport', {}, id, user, 0, 403);
  const approvalPre = await preview('approveReport', {}, id), approved = await commit(approvalPre, '/api/reports/' + id + '/approve', 'PATCH');
  assert.equal(approved.result.data.status, 'Approved'); assert.equal(approved.result.data.signature, 'Synthetic signed name'); assert.equal(approved.result.data.rateSnapshot, undefined, 'Nonpricing PM cannot receive captured financial details');
  current = await load(); assert.equal(current.snapshot.reports[0].rateSnapshot.laborRate, 75); assert.equal(current.snapshot.projects[0].production, 10);
  assert.equal((await request(bases[0], 'GET', '/api/reports/' + id, undefined, 4)).data.rateSnapshot, undefined);
  before = await load(); await commit(approvalPre, '/api/reports/' + id + '/approve', 'PATCH', 2, 1, 200, approved.conf); assert.deepEqual(await load(), before);

  // A cached priced result must not survive company pricing-access revocation.
  await change(db => { db.company.pricingAccess = { enabled: true, officeMode: 'selected', userIds: [2] }; });
  const pricedPre = await preview('editReport', { summary: 'Priced office correction', status: 'Approved' }, id), priced = await commit(pricedPre, '/api/reports/' + id, 'PATCH');
  assert.equal(priced.result.data.rateSnapshot.laborRate, 75);
  const revokePre = await preview('editReport', { summary: 'Revoked before confirmation', status: 'Approved' }, id);
  await change(db => { db.company.pricingAccess.enabled = false; }); before = await load();
  await commit(pricedPre, '/api/reports/' + id, 'PATCH', 2, 0, 409, priced.conf);
  await commit(revokePre, '/api/reports/' + id, 'PATCH', 2, 1, 409);
  assert.equal((await request(bases[1], 'GET', '/api/reports/' + id, undefined, 2)).data.rateSnapshot, undefined); assert.deepEqual(await load(), before);

  // Source AND resulting crew scope; no daily PATCH can alter linked card/workday.
  await change(db => { db.reports = [report(), report(52, 13, 1), { ...report(53), laborEntries: [{ memberId: 11, hours: 1, crew: 'A' }, { memberId: 13, hours: 1, crew: 'B' }] }]; });
  let read = await request(bases[0], 'GET', '/api/reports', undefined, 2); assert.deepEqual(read.data.map(row => row.id), [51]);
  await preview('editReport', { summary: 'Mixed crew denied' }, 53, 2, 0, 404); await preview('approveReport', {}, 52, 2, 0, 404);
  await preview('editReport', { status: 'Draft', laborEntries: [{ memberId: 13, hours: 2 }] }, 51, 2, 0, 403);
  await change(db => { db.reports.push({ ...report(51, 13, 1), id: ' 51 ' }); }); before = await load(); await preview('editReport', { summary: 'Hidden duplicate' }, 51, 2, 0, 409); assert.deepEqual(await load(), before);
  await change(db => { db.reports = [report()]; db.timeCards = [{ id: 501, projectId: 101, memberId: 11, workdayId: 91, inAt: '2026-01-05T08:00:00Z', outAt: '2026-01-05T09:00:00Z', hours: 1, status: 'draft' }]; db.workdays = [{ id: 91, projectId: 101, memberIds: [11], status: 'complete', reportId: 51 }]; });
  const immutableBefore = (await load()).snapshot;
  await commit(await preview('editReport', { status: 'Draft', laborEntries: [{ memberId: 11, hours: 3 }] }, 51), '/api/reports/51', 'PATCH'); current = await load(); assert.deepEqual(current.snapshot.timeCards, immutableBefore.timeCards); assert.deepEqual(current.snapshot.workdays, immutableBefore.workdays);
  await change(db => { db.reports = []; db.workdays = []; db.timeCards = []; });
  await preview('startWorkday', { projectId: 101, memberIds: [11, 13] }, undefined, 2, 0, 403);
  await preview('startWorkday', { projectId: 102, memberIds: [11] }, undefined, 5, 0, 403);
  const startPre = await preview('startWorkday', { projectId: 101, memberIds: [11, 12], startNote: 'Synthetic crew starts' }, undefined, 4), started = await commit(startPre, '/api/workdays/start', 'POST', 4, 1, 201), dayId = started.result.data.id;
  assert.equal(started.result.data.status, 'active'); current = await load(); assert.equal(current.snapshot.timeCards.length, 2); assert.ok(current.snapshot.timeCards.every(row => row.status === 'draft' && row.outAt === null));
  before = await load(); await commit(startPre, '/api/workdays/start', 'POST', 4, 0, 200, started.conf); assert.deepEqual(await load(), before);
  // Anchor synthetic existing start 68 minutes ago; preserve .01 report elapsed
  // versus .25 card rounding without changing the original computation helpers.
  let startAt = new Date(Date.now() - 68 * 60000).toISOString(); await change(db => { db.workdays[0].startedAt = startAt; db.timeCards.forEach(row => { row.inAt = startAt; }); });
  for (const corrupt of [row => { row.projectId = 102; }, row => { row.memberId = 13; }, row => { row.deletedAt = '2026-01-01'; }, row => { row.status = 'approved'; }, row => { row.Status = 'approved'; }, row => { row.state = 'submitted'; }, row => { row.payrollLockedAt = '2026-01-01'; }]) {
    const original = structuredClone((await load()).snapshot.timeCards[0]); await change(db => { corrupt(db.timeCards[0]); }); before = await load(); await preview('endWorkday', { notes: 'Synthetic completed work' }, dayId, 4, 0, 409); assert.deepEqual(await load(), before); await change(db => { db.timeCards[0] = original; });
  }
  const intactCards = structuredClone((await load()).snapshot.timeCards);
  for (const corrupt of [db => { db.timeCards.pop(); }, db => { db.timeCards.push({ ...db.timeCards[0], id: 999 }); }, db => { db.workdays[0].startedAt = 'invalid'; }]) {
    const intactDay = structuredClone((await load()).snapshot.workdays[0]); await change(corrupt); before = await load(); await preview('endWorkday', { notes: 'Needs source reconciliation' }, dayId, 4, 0, 409); assert.deepEqual(await load(), before); await change(db => { db.timeCards = structuredClone(intactCards); db.workdays[0] = intactDay; });
  }
  await change(db => { db.company.timeWriteRolePolicy = policy(time); db.company.timeWriteRolePolicy.roles.field.clockCards = false; }); before = await load(); await preview('endWorkday', { notes: 'No policy bypass' }, dayId, 4, 0, 403); assert.deepEqual(await load(), before); await change(db => { delete db.company.timeWriteRolePolicy; });
  // Reanchor after adversarial source checks; clocks still use actual confirmation
  // time, so a slower worker may legitimately cross a hundredth-hour boundary.
  startAt = new Date(Date.now() - 68 * 60000).toISOString(); await change(db => { db.workdays[0].startedAt = startAt; db.timeCards.forEach(row => { row.inAt = startAt; }); });
  const endPre = await preview('endWorkday', { notes: 'Synthetic completed work', foreman: 'Synthetic user 4' }, dayId, 4), ended = await commit(endPre, '/api/workdays/' + dayId + '/end', 'POST', 4);
  const elapsed = Math.max(0, Math.round((Date.parse(ended.result.data.workday.endedAt) - Date.parse(startAt)) / 3600000 * 100) / 100);
  assert.equal(ended.result.data.report.status, 'Draft'); assert.equal(ended.result.data.report.signature, ''); assert.deepEqual(ended.result.data.report.productionEntries, []); assert.ok(ended.result.data.report.laborEntries.every(row => row.hours === elapsed)); assert.notEqual(elapsed, 1.25, 'Report elapsed hundredths remain distinct from gross card quarter rounding');
  current = await load(); assert.ok(current.snapshot.timeCards.every(row => row.hours === 1.25 && row.status === 'draft' && row.reportId === ended.result.data.report.id));
  before = current; await commit(endPre, '/api/workdays/' + dayId + '/end', 'POST', 4, 0, 200, ended.conf); assert.deepEqual(await load(), before);

  // Current originating session, slow/in-flight role-policy and entire crew
  // revocation; same durable proof has exactly one SQL winner across workers.
  await change(db => { db.reports = [report()]; db.workdays = []; db.timeCards = []; });
  const racePre = await preview('editReport', { summary: 'One correction' }, 51), raceInput = confirmation(racePre); controls.gate = checkpoint(); controls.gate.expected = 99; before = await load();
  const races = bases.slice(0, 2).map(base => request(base, 'PATCH', '/api/reports/51', raceInput, 2)); await waitFor(() => controls.gate.count === 2); assert.deepEqual(await load(), before); controls.gate.resolve(); const raced = await Promise.all(races); controls.gate = null; assert.deepEqual(raced.map(row => row.status).sort(), [200, 409]);
  current = await load(); assert.equal(current.revision, before.revision + 1); await commit(racePre, '/api/reports/51', 'PATCH', 2, 1, 200, raceInput); assert.deepEqual(await load(), current);
  const livePre = await preview('editReport', { summary: 'Revoked candidate' }, 51), liveInput = confirmation(livePre); controls.gate = checkpoint(); controls.gate.expected = 99;
  const pending = request(bases[0], 'PATCH', '/api/reports/51', liveInput, 2); await waitFor(() => controls.gate.count === 1); await change(db => { db.users.find(row => row.id === 2).assignedCrews = ['B']; }); before = await load(); controls.gate.resolve(); assert.equal((await pending).status, 409); controls.gate = null; assert.deepEqual(await load(), before);
  assert.equal((await request(bases[1], 'PATCH', '/api/reports/51', liveInput, 2)).status, 404); await change(db => { db.users.find(row => row.id === 2).assignedCrews = ['A']; });
  const slowPre = await preview('editReport', { summary: 'Slow revoked actor' }, 51), slowInput = confirmation(slowPre), slow = await slowRequest(bases[0], 2, slowInput, '/api/reports/51', 'PATCH');
  await change(db => { db.company.dailyRolePolicy = policy(access); db.company.dailyRolePolicy.roles.project_manager.editReports = false; }); before = await load(); slow.done(); assert.equal((await slow.result).status, 403); assert.deepEqual(await load(), before); await change(db => { delete db.company.dailyRolePolicy; });
  const lossPre = await preview('editReport', { summary: 'Lost acknowledgement recovery' }, 51), lossInput = confirmation(lossPre); controls.dropAck = true; await commit(lossPre, '/api/reports/51', 'PATCH', 2, 0, 503, lossInput); controls.dropAck = false;
  before = await load(); await commit(lossPre, '/api/reports/51', 'PATCH', 2, 1, 200, lossInput); assert.deepEqual(await load(), before);
  const rejectPre = await preview('editReport', { summary: 'Rejected entire report' }, 51); before = await load(); controls.rejectCommit = true; await commit(rejectPre, '/api/reports/51', 'PATCH', 2, 0, 503); controls.rejectCommit = false; assert.deepEqual(await load(), before);
  assert.equal((await request(bases[0], 'GET', '/api/reports/51', undefined, 2, companyB)).status, 401);
  const stalePre = await preview('editReport', { summary: 'Stale report source' }, 51); await change(db => { db.reports[0].notes = 'A later explicit source edit'; }); before = await load(); await commit(stalePre, '/api/reports/51', 'PATCH', 2, 1, 409); assert.deepEqual(await load(), before);
  const sessionPre = await preview('editReport', { summary: 'Original live session only' }, 51), sessionInput = confirmation(sessionPre), secondToken = 'synthetic-daily-second-session';
  await change(db => { db.sessions.push({ ...db.sessions.find(row => row.userId === 2), tokenHash: crypto.createHash('sha256').update(secondToken).digest('hex') }); }); before = await load();
  assert.equal((await request(bases[1], 'PATCH', '/api/reports/51', sessionInput, 2, companyA, companyA, secondToken)).status, 409); assert.deepEqual(await load(), before);
  const originalSessions = structuredClone(before.snapshot.sessions); await change(db => { db.sessions.filter(row => row.userId === 2).forEach(row => { row.expiresAt = '2000-01-01T00:00:00Z'; }); }); before = await load();
  assert.equal((await request(bases[0], 'PATCH', '/api/reports/51', sessionInput, 2)).status, 401); assert.equal((await request(bases[1], 'GET', '/api/reports/51', undefined, 2)).status, 401); assert.deepEqual(await load(), before); await change(db => { db.sessions = originalSessions; });
  const rolePre = await preview('editReport', { summary: 'Removed role ceiling' }, 51), originalActor = structuredClone((await load()).snapshot.users.find(row => row.id === 2));
  await change(db => { db.users.find(row => row.id === 2).role = 'crew'; }); before = await load(); await commit(rolePre, '/api/reports/51', 'PATCH', 2, 1, 403); assert.equal((await request(bases[0], 'GET', '/api/reports/51', undefined, 2)).status, 403); assert.deepEqual(await load(), before); await change(db => { Object.assign(db.users.find(row => row.id === 2), originalActor); });
  await change(db => { db.company.dailyPolicyRequired = true; db.company.dailyRolePolicy = { ...policy(access), roles: { ...policy(access).roles, owner: access.ceiling('owner') } }; }); before = await load(); await preview('editReport', { summary: 'Reject malicious owner policy' }, 51, 2, 0, 403); assert.equal((await request(bases[0], 'GET', '/api/reports/51', undefined, 1)).status, 200); assert.deepEqual(await load(), before); await change(db => { delete db.company.dailyPolicyRequired; delete db.company.dailyRolePolicy; });

  // Existing configured signatures/photos remain mandatory before submission.
  await change(db => { db.company.features.templates = true; db.dailyTemplates = [{ id: 'synthetic-photo', name: 'Synthetic photo form', requirements: { photo: true, signature: true }, versions: [{ version: 1, fields: [] }] }]; db.reports[0].templateId = 'synthetic-photo'; db.reports[0].templateVersion = 1; db.reports[0].signature = ''; });
  await preview('editReport', { status: 'Needs review' }, 51, 4, 0, 400);
  await preview('editReport', { status: 'Needs review', signature: 'Explicit signature' }, 51, 4, 0, 409);
  await change(db => { db.photos = [{ id: 301, project: 0, reportId: 51, source: 'field', url: '/api/blocked-synthetic-photo' }]; });
  const photoReady = await commit(await preview('editReport', { status: 'Needs review', signature: 'Explicit signature' }, 51, 4), '/api/reports/51', 'PATCH', 4); assert.equal(photoReady.result.data.signature, 'Explicit signature');
  await change(db => { db.company.features.templates = false; });
  await commit(await preview('approveReport', {}, 51), '/api/reports/51/approve', 'PATCH');
  for (const user of [2, 4, 5, 7, 8, 9]) { await preview('captureExport', { projectId: 101, from: '2026-01-05', to: '2026-01-05' }, undefined, user, 0, 403); assert.equal((await request(bases[0], 'GET', '/api/reporting-exports', undefined, user)).status, 403); }
  const exportPre = await preview('captureExport', { projectId: 101, from: '2026-01-05', to: '2026-01-05' }, undefined, 1), exportSaved = await commit(exportPre, '/api/reporting-exports', 'POST', 1, 1, 201), exportId = exportSaved.result.data.id;
  const exportPath = '/api/reporting-exports/' + exportId, fixedJSON = await request(bases[0], 'GET', exportPath, undefined, 1), fixedCSV = await request(bases[0], 'GET', exportPath + '.csv', undefined, 1);
  assert.equal(fixedJSON.data.snapshot.reports[0].signature, 'Explicit signature'); assert.equal(fixedJSON.data.snapshot.reports[0].rateSnapshot.laborRate, 75); assert.equal(fixedCSV.status, 200);
  assert.deepEqual(fixedJSON.data.snapshot.totals.financial, (await load()).snapshot.reportingExports[0].snapshot.totals.financial); assert.equal(fixedJSON.data.snapshot.totals.financial.complete, true); assert.equal(fixedJSON.data.snapshot.totals.financial.laborAmount, 150); assert.equal(fixedJSON.data.snapshot.totals.financial.approvedDailies, 1); assert.equal(fixedJSON.data.snapshot.project.tmSettings.defaultLaborRate, 75);
  await commit(await preview('editReport', { signature: 'Later correction', status: 'Approved' }, 51, 1), '/api/reports/51', 'PATCH', 1);
  const v2 = await commit(await preview('captureExport', { projectId: 101, from: '2026-01-05', to: '2026-01-05', supersedesId: exportId, reason: 'Explicit corrected signature version' }, undefined, 1), '/api/reporting-exports', 'POST', 1, 1, 201); assert.equal(v2.result.data.version, 2);
  assert.deepEqual((await request(bases[1], 'GET', exportPath, undefined, 1)).data, fixedJSON.data); assert.equal((await request(bases[1], 'GET', exportPath + '.csv', undefined, 1)).data, fixedCSV.data);
  await change(db => { delete db.reports[0].rateSnapshot; db.reports[0].rateReview = { status: 'Required', reason: 'legacy_missing_rate_snapshot' }; });
  const incomplete = await commit(await preview('captureExport', { projectId: 101, from: '2026-01-05', to: '2026-01-05', supersedesId: v2.result.data.id, reason: 'Synthetic historical rate gap' }, undefined, 1), '/api/reporting-exports', 'POST', 1, 1, 201);
  assert.equal(incomplete.result.data.snapshot.totals.financial.complete, false); assert.equal(incomplete.result.data.snapshot.totals.financial.laborAmount, null); assert.equal(incomplete.result.data.snapshot.totals.financial.labor[0].amount, null); assert.equal(incomplete.result.data.snapshot.totals.financial.missingRateReports[0].reportId, 51);
  controls.readGate = checkpoint(); const readPending = request(bases[0], 'GET', '/api/reports/51', undefined, 2); await waitFor(() => controls.readGate.count === 3);
  await change(db => { db.company.dailyRolePolicy = policy(access); db.company.dailyRolePolicy.roles.project_manager.viewReports = false; db.company.dailyRolePolicy.roles.project_manager.createReports = false; db.company.dailyRolePolicy.roles.project_manager.editReports = false; db.company.dailyRolePolicy.roles.project_manager.approveReports = false; db.company.dailyRolePolicy.roles.project_manager.runWorkdays = false; });
  controls.readGate.resolve(); assert.equal((await readPending).status, 409); controls.readGate = null;
  assert.equal((await request(bases[1], 'GET', '/api/reports/51', undefined, 2)).status, 403);
  await change(db => { delete db.company.dailyRolePolicy; db.reportingExports.push({ ...db.reportingExports[0], id: crypto.randomUUID(), companyId: companyB }); }); before = await load(); assert.equal((await request(bases[0], 'GET', '/api/reporting-exports', undefined, 1)).status, 409); assert.deepEqual(await load(), before);
  assert.equal(providerEvents.length, providers); assert.deepEqual(await repository.load(companyB), foreign);
  console.log('Daily/workday PostgreSQL HTTP passed: durable cross-worker/restart preview and originating-session replay, report/photo interruption identity, no implicit Draft merge/cleanup, allocation/signature/submission/approval/rate privacy, entire source/target crew, linked open/close invariants and separate rounding, typed-time policy, concurrent/stale/slow/inflight revocation and SQL rollback/lost ack, owner-only immutable reporting JSON/CSV versions, fenced scope reads and tenant IDOR; no byte-storage/provider calls.');
};
