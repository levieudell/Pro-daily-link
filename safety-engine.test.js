'use strict';

const assert = require('node:assert/strict');
const { VERSION, inferredState, safetyGate, createSafetyHandler, checksFor } = require('./safety-engine');
const { applySafetyEvidence } = require('./safety-report-policy');

const date = '2026-10-26';
const owner = { id: 1, name: 'PM One', companyId: 'tenant-one', status: 'Active', role: 'owner' };
const field = { ...owner, id: 2, name: 'Field Two', role: 'field' };
const pm = { ...owner, id: 3, role: 'project_manager', projectIds: [101], permissions: { viewDailies: true, manageSafety: true, verifySafety: true } };
const readOnlyPm = { ...owner, id: 4, role: 'project_manager', projectIds: [101], permissions: { viewDailies: true } };
const setupPm = { ...readOnlyPm, id: 5, permissions: { viewDailies: true, manageSafety: true } };
function fixture() {
  return { company: { id: 'tenant-one', name: 'Synthetic Contractor' }, projects: [{ id: 101, name: 'Oak site', site: '100 Main St, Portland, OR 97201' }, { id: 102, site: 'Seattle, WA 98101' }],
    team: [{ id: 1, name: 'Roofer One', crew: 'Roof crew' }, { id: 2, name: 'Other Worker', crew: 'Other crew' }],
    assignments: [{ id: 1, projectId: 101, date, task: 'Roofing west wing', memberIds: [1] }], photos: [{ id: 1, project: 0 }, { id: 2, projectId: 102 }], safetyDays: [] };
}
function harness(options = {}) {
  let db = fixture(), writes = 0;
  const handler = createSafetyHandler({ readDb: () => db, writeDb: next => { db = structuredClone(next); writes++; }, body: async req => req.input,
    json: (res, status, data) => Object.assign(res, { status, data }), authenticatedUser: req => req.user,
    canAccessProject: (_db, user, projectId) => user.role === 'owner' || user.role === 'admin' || (user.role === 'project_manager' ? user.projectIds.includes(projectId) : projectId === 101),
    canAccessDate: options.canAccessDate });
  async function call(method, suffix = '', input, user = owner, projectId = 101) {
    const res = {}; const matched = await handler({ method, input, user }, res, new URL(`http://localhost/api/projects/${projectId}/safety${suffix}`));
    assert.equal(matched, true); return res;
  }
  return { call, get db() { return db; }, get writes() { return writes; },
    async enable(activities = ['roofing'], state = 'OR', projectId = 101) { return call('PUT', '/profile', { revision: 0, enabled: true, state, employer: 'Synthetic Contractor', activities }, owner, projectId); },
    async generate(revision = 0, workDate = date) { return call('POST', '/days', { date: workDate, revision }); } };
}
async function complete(h, overrides = {}, workDate = date) {
  const currentDay = () => h.db.safetyDays.find(day => day.companyId === h.db.company.id && day.projectId === 101 && day.date === workDate);
  for (const row of currentDay().checks) {
    const result = await h.call('PATCH', `/days/${workDate}/checks/${row.id}`, { revision: currentDay().revision, status: 'pass', inspector: 'PM One', competentPerson: row.requiresCompetentPerson ? 'Designated Inspector' : '', notes: 'Conditions checked at 07:15; work scope confirmed.', ...overrides });
    assert.equal(result.status, 200, JSON.stringify(result.data));
  }
}

(async () => {
  assert.equal(inferredState({ site: '100 Main, OR 97201' }), 'OR');
  assert.equal(inferredState({ address: 'Portland Oregon' }), 'OR');
  assert.equal(inferredState({ site: '123 Washington Street, Portland, OR 97201' }), 'OR');
  assert.equal(inferredState({ site: '123 Oregon Avenue, Seattle, WA 98101' }), 'WA');
  assert.equal(inferredState({ site: '123 Oregon Avenue, Austin, TX 78701' }), 'TX');
  assert.equal(inferredState({ site: '123 Washington Street, Portland, Oregon' }), 'OR');
  assert.equal(inferredState({ site: '123 Washington Street' }), '');
  assert.equal(inferredState({ site: 'Portland, OR' }), 'OR');
  assert.equal(inferredState({ site: '123 Oregon Avenue, Austin, TX 78701-1234, USA' }), 'TX');
  assert.equal(inferredState({ site: 'Portland' }), '');
  assert.equal(checksFor(['roofing', 'excavation']).length, 6);

  const h = harness();
  assert.equal((await h.call('GET', `?date=${date}`, undefined, null)).status, 401);
  assert.equal((await h.call('GET', `?date=${date}`, undefined, { ...owner, companyId: 'tenant-other' })).status, 401);
  assert.equal((await h.call('GET', `?date=${date}`, undefined, { ...owner, status: 'Inactive' })).status, 401);
  assert.equal((await h.call('GET', `?date=${date}`, undefined, { ...owner, role: 'guest' })).status, 403);
  assert.equal((await h.call('GET', '?date=2026-02-30')).status, 400);
  assert.equal((await h.call('GET', `?date=${date}`, undefined, pm, 102)).status, 404);
  assert.equal((await h.call('PUT', '/profile', {}, field)).status, 403);
  assert.equal((await h.call('PUT', '/profile', { revision: 0, enabled: true, state: 'OR', employer: 'ignored', activities: ['roofing'] }, readOnlyPm)).status, 403, 'read-only PM cannot configure safety');
  assert.equal((await h.call('GET', `?date=${date}`, undefined, readOnlyPm)).data.canManage, false);
  const delegatedSetup = harness();
  assert.equal((await delegatedSetup.call('PUT', '/profile', { revision: 0, enabled: true, state: 'OR', employer: 'ignored', activities: ['roofing'] }, setupPm)).status, 200, 'manageSafety permits PM setup');
  assert.equal((await delegatedSetup.call('GET', `?date=${date}`, undefined, setupPm)).data.canVerify, false, 'setup permission does not imply verification');
  const dateScoped = harness({ canAccessDate: (_db, user, _projectId, workDate) => user.role !== 'field' || workDate === date });
  await dateScoped.enable();
  assert.equal((await dateScoped.call('GET', `?date=2026-10-27`, undefined, field)).status, 404, 'field safety reads are date-scoped');
  assert.equal((await dateScoped.call('POST', '/days', { date: '2026-10-27', revision: 0 }, field)).status, 404, 'field safety writes are date-scoped');
  const defaults = await h.call('GET', `?date=${date}`);
  assert.equal(defaults.data.profile.employer, h.db.company.name, 'responsible employer comes from the company account');
  assert.equal(defaults.data.profile.state, 'OR', 'jurisdiction comes from the project address');
  assert.equal((await h.enable()).status, 200);
  assert.equal(safetyGate(h.db, 101, date).canSubmit, false, 'enabled day cannot bypass missing generated checks');
  assert.equal(safetyGate(h.db, 101, 'not-a-date').canSubmit, false);
  const first = await h.generate();
  assert.equal(first.status, 201); assert.equal(first.data.ruleVersion, VERSION); assert.equal(first.data.checks.length, 4);
  assert.equal(first.data.history[0].userId, owner.id);
  const oldWrites = h.writes;
  assert.equal((await h.generate(1)).status, 200); assert.equal(h.writes, oldWrites, 'same generation does not rewrite evidence');
  assert.equal((await h.generate(0)).status, 409);
  assert.equal((await h.call('PATCH', `/days/${date}/checks/site-walk`, { revision: 1, status: 'pass', inspector: 'PM', updatedBy: 'spoof' })).status, 400);
  assert.equal((await h.call('PATCH', `/days/${date}/checks/site-walk`, { revision: 1, status: 'fail', inspector: 'PM' })).status, 400);
  assert.equal((await h.call('PATCH', `/days/${date}/checks/site-walk`, { revision: 1, status: 'not_applicable', inspector: 'PM' })).status, 400);
  const oneTap = harness(); await oneTap.enable(); await oneTap.generate();
  const oneTapPass = await oneTap.call('PATCH', `/days/${date}/checks/site-walk`, { revision: 1, status: 'pass', inspector: 'Forged inspector' }, field);
  assert.equal(oneTapPass.status, 200, 'a deliberate clean check is one API action');
  const recordedPass = oneTapPass.data.checks.find(row => row.id === 'site-walk');
  assert.equal(recordedPass.inspector, field.name, 'authenticated actor is the inspector of record');
  assert.equal(recordedPass.recordedByUserId, field.id);
  assert.match(recordedPass.notes, /no issue observed/i, 'clean checks retain a truthful standard observation');
  await complete(h);
  assert.equal(safetyGate(h.db, 101, date).canSubmit, true);
  assert.equal(safetyGate(h.db, 101, date).readyForWork, true);
  let rev = h.db.safetyDays[0].revision;
  assert.equal((await h.call('POST', `/days/${date}/talks`, { revision: rev, topic: 'Roof edges and openings', notes: 'Reviewed access and stop-work expectations.', language: 'en', attendeeIds: [2] }, field)).status, 400, 'unscheduled workers cannot be placed on a project talk roster');
  assert.equal((await h.call('POST', `/days/${date}/talks`, { revision: rev, topic: 'Roof edges', notes: '', language: 'en', attendeeIds: [1], presenter: 'Forged presenter' }, field)).status, 400, 'clients cannot forge presenter identity');
  const talkResult = await h.call('POST', `/days/${date}/talks`, { revision: rev, topic: 'Roof edges and openings', notes: 'Reviewed access and stop-work expectations.', language: 'en', attendeeIds: [1] }, field);
  assert.equal(talkResult.status, 200);
  assert.equal(talkResult.data.talks[0].presenter, field.name);
  assert.equal(talkResult.data.talks[0].presenterUserId, field.id);
  assert.deepEqual(talkResult.data.talks[0].attendees.map(row => row.memberId), [1]);
  const originalTalk = structuredClone(talkResult.data.talks[0]);
  const amendedTalk = await h.call('PATCH', `/days/${date}/talks/${originalTalk.id}`, { revision: talkResult.data.revision, action: 'amend', reason: 'Clarified the topic after review', topic: 'Roof edges, openings, and rescue', notes: 'Reviewed access, rescue, and stop-work expectations.', language: 'en', attendeeIds: [1] }, field);
  assert.equal(amendedTalk.status, 200);
  assert.equal(amendedTalk.data.talks[0].initial.topic, originalTalk.topic, 'correction retains the original toolbox talk');
  assert.equal(amendedTalk.data.talks[0].corrections.at(-1).by, field.name);
  const twiceAmendedTalk = await h.call('PATCH', `/days/${date}/talks/${originalTalk.id}`, { revision: amendedTalk.data.revision, action: 'amend', reason: 'Corrected the attendance after supervisor review', topic: 'Roof edges, openings, rescue, and access', notes: 'Reviewed access, rescue, openings, and stop-work expectations.', language: 'en', attendeeIds: [1] }, field);
  assert.equal(twiceAmendedTalk.status, 200);
  assert.equal(twiceAmendedTalk.data.talks[0].corrections.length, 2);
  for (const correction of twiceAmendedTalk.data.talks[0].corrections) {
    assert.equal(Object.hasOwn(correction.before, 'corrections'), false, 'correction before snapshot is flat');
    assert.equal(Object.hasOwn(correction.after, 'corrections'), false, 'correction after snapshot is flat');
    assert.equal(Object.hasOwn(correction.before, 'history'), false, 'correction snapshot does not embed history');
    assert.equal(Object.hasOwn(correction.after, 'history'), false, 'correction snapshot does not embed history');
  }
  const correctionAudit = twiceAmendedTalk.data.history.at(-1);
  assert.equal(Object.hasOwn(correctionAudit.before, 'corrections'), false, 'day audit uses the bounded talk snapshot');
  assert.equal(Object.hasOwn(correctionAudit.after, 'corrections'), false, 'day audit cannot recursively clone talk corrections');
  assert.equal((await h.call('PATCH', `/days/${date}/talks/${originalTalk.id}`, { revision: twiceAmendedTalk.data.revision, action: 'void', reason: 'Not delivered' }, { ...field, id: 99 })).status, 403, 'another field user cannot void the presenter record');
  rev = twiceAmendedTalk.data.revision;
  let failed = await h.call('PATCH', `/days/${date}/checks/roofing-protection`, { revision: rev, status: 'deferred', inspector: 'PM One', notes: 'Anchor not inspected', action: 'Keep roof work stopped until inspected', owner: 'Roof foreman', dueDate: date, workStopped: false });
  assert.equal(failed.status, 400);
  failed = await h.call('PATCH', `/days/${date}/checks/roofing-protection`, { revision: rev, status: 'deferred', inspector: 'PM One', notes: 'Anchor not inspected', action: 'Keep roof work stopped until inspected', owner: 'Roof foreman', dueDate: date, workStopped: true });
  assert.equal(failed.status, 200); assert.equal(failed.data.summary.canSubmit, true, 'documented stoppage may be submitted'); assert.equal(failed.data.summary.readyForWork, false, 'documentation does not clear unresolved work');
  assert.equal((await h.call('PATCH', `/days/${date}/checks/site-walk`, { revision: rev, status: 'pass', inspector: 'PM' })).status, 409);

  h.db.assignments[0].instructions = 'Excavation added at east trench';
  assert.equal(safetyGate(h.db, 101, date).canSubmit, false, 'schedule changes invalidate signoff');
  const staleRev = h.db.safetyDays[0].revision;
  assert.equal((await h.call('PATCH', `/days/${date}/checks/site-walk`, { revision: staleRev, status: 'pass', inspector: 'PM' })).status, 409);
  const refreshed = await h.generate(staleRev);
  assert.equal(refreshed.data.checks.length, 6); assert.equal(refreshed.data.summary.pending, 6);
  assert.ok(refreshed.data.history.some(row => row.before?.checks?.some(item => item.status === 'deferred')), 'old answers preserved in audit');
  const cp = await h.call('PATCH', `/days/${date}/checks/excavation-inspection`, { revision: refreshed.data.revision, status: 'pass', inspector: 'PM' });
  assert.equal(cp.status, 400, 'competent-person check cannot pass unnamed');
  await complete(h);
  const linked = h.db.safetyDays[0].hazards.find(row => row.sourceCheckId === 'roofing-protection');
  const closeLinked = await h.call('PATCH', `/days/${date}/hazards/${linked.id}`, { revision: h.db.safetyDays[0].revision, status: 'verified', action: 'Anchor inspected', verification: 'Safety lead verified anchor' }, pm);
  assert.equal(closeLinked.status, 200);
  rev = h.db.safetyDays[0].revision;
  assert.equal((await h.call('POST', `/days/${date}/hazards`, { revision: rev, observation: 'Opening', location: 'East', photoId: 2 })).status, 400, 'cannot attach another project photo');
  const hazard = await h.call('POST', `/days/${date}/hazards`, { revision: rev, observation: '<img src=x onerror=alert(1)>', location: 'East floor', photoId: 1 }, field);
  const reportedHazard = hazard.data.hazards.find(row => !row.sourceCheckId);
  assert.equal(hazard.status, 200); assert.equal(hazard.data.summary.canSubmit, false); assert.equal(reportedHazard.createdByUserId, field.id);
  const hazardId = reportedHazard.id;
  assert.equal((await h.call('PATCH', `/days/${date}/hazards/${hazardId}`, { revision: hazard.data.revision, status: 'verified', action: 'Covered', verification: 'Saw cover' }, field)).status, 403);
  let corrected = await h.call('PATCH', `/days/${date}/hazards/${hazardId}`, { revision: hazard.data.revision, status: 'corrected', action: 'Guard installed', owner: 'Foreman', dueDate: date, workStopped: true }, field);
  assert.equal(corrected.status, 200); assert.equal(corrected.data.summary.canSubmit, true); assert.equal(corrected.data.summary.readyForWork, false);
  const verified = await h.call('PATCH', `/days/${date}/hazards/${hazardId}`, { revision: corrected.data.revision, status: 'verified', verification: 'PM inspected guard attachment' }, pm);
  assert.equal(verified.status, 200); assert.equal(verified.data.summary.unresolved, 0); assert.equal(verified.data.hazards.find(row => row.id === hazardId).verifiedByUserId, pm.id);
  assert.ok(verified.data.history.length > 5);

  const submittedReport = { project: 0, dateIso: date, status: 'Submitted', foreman: 'Forged client submitter', history: [{ action: 'Submitted', by: 'Forged client submitter', at: new Date().toISOString() }] };
  assert.equal(applySafetyEvidence(h.db, submittedReport, owner), null);
  const submissionEvidence = structuredClone(submittedReport.safetyEvidence);
  assert.equal(submissionEvidence.company.name, h.db.company.name);
  assert.equal(submissionEvidence.project.name, h.db.projects[0].name);
  assert.equal(submissionEvidence.project.jurisdiction, 'OR');
  assert.equal(submissionEvidence.talks.length, 1);
  assert.deepEqual(submissionEvidence.submittedBy, { id: owner.id, name: owner.name, role: owner.role }, 'snapshot attribution comes only from the trusted actor');
  h.db.safetyDays[0].revision++;
  h.db.safetyDays[0].hazards.push({ id: 'after-submit', status: 'open', observation: 'Later condition', action: 'Stopped', owner: 'PM', dueDate: date, workStopped: true });
  submittedReport.status = 'Approved';
  assert.equal(applySafetyEvidence(h.db, submittedReport), null, 'approval may validate current safety state');
  assert.deepEqual(submittedReport.safetyEvidence, submissionEvidence, 'approval and later safety changes cannot rewrite submission evidence');

  const other = harness();
  assert.equal((await other.enable(['roofing'], 'OR', 102)).status, 400, 'a stale client must refresh instead of overriding the project address');
  const derivedWashington = await other.enable(['roofing'], 'WA', 102);
  assert.equal(derivedWashington.status, 200);
  assert.equal(derivedWashington.data.profile.state, 'WA', 'Washington is derived from the project address');
  assert.equal(derivedWashington.data.profile.employer, other.db.company.name, 'client employer is not authoritative');
  const unsupported = await other.call('POST', '/days', { date, revision: 0 }, owner, 102);
  assert.equal(unsupported.status, 201); assert.equal(unsupported.data.coverage, 'manual-review'); assert.equal(unsupported.data.summary.canSubmit, false);
  assert.equal(safetyGate(other.db, 101, date).enabled, false, 'other disabled project unchanged');
  const texas = harness(); texas.db.projects[0].site = '123 Oregon Avenue, Austin, TX 78701';
  assert.equal((await texas.enable(['roofing'], 'OR')).status, 400, 'a stale Oregon value cannot override a Texas project address');
  const derivedTexas = await texas.enable(['roofing'], 'TX');
  assert.equal(derivedTexas.status, 200); assert.equal(derivedTexas.data.profile.state, 'TX', 'a Texas address cannot be saved as Oregon');
  assert.equal((await texas.call('GET', `?date=${date}`)).data.coverage, 'manual-review');
  const unknown = harness(); unknown.db.projects[0].site = 'Remote work site';
  assert.equal((await unknown.enable(['roofing'], 'OR')).status, 400, 'safety cannot be enabled by guessing when the project address has no state');
  const unnamed = harness(); unnamed.db.company.name = '';
  assert.equal((await unnamed.enable()).status, 400, 'safety cannot be enabled without the company account name');
  const renamed = harness(); await renamed.enable(); await renamed.generate(); await complete(renamed);
  assert.equal(safetyGate(renamed.db, 101, date).canSubmit, true);
  renamed.db.company.name = 'Renamed Contractor';
  const renamedRead = await renamed.call('GET', `?date=${date}`);
  assert.equal(renamedRead.data.profile.employer, 'Renamed Contractor', 'company rename is reflected without stale profile text');
  assert.equal(safetyGate(renamed.db, 101, date).canSubmit, false, 'company rename invalidates prior safety signoff');
  const isolated = harness(); await isolated.enable();
  isolated.db.safetyDays.push({ ...first.data, companyId: 'tenant-other', date, projectId: 101 });
  assert.equal((await isolated.call('GET', `?date=${date}`)).data.day, null, 'foreign tenant records omitted');
  await isolated.generate(); await complete(isolated);
  const project = isolated.db.projects[0]; project.safetyProfile.revision++;
  assert.equal(safetyGate(isolated.db, 101, date).canSubmit, false, 'profile revisions invalidate checks');
  const tasks = harness(); await tasks.enable([]);
  tasks.db.projectTasks = [{ id: 9, projectId: 101, name: 'Excavation', startDate: '2026-10-25', endDate: '2026-10-27' }];
  assert.equal((await tasks.generate()).data.checks.length, 6, 'project schedule and crew assignments both add activities');
  await complete(tasks); tasks.db.projectTasks[0].name = 'Demolition';
  assert.equal(safetyGate(tasks.db, 101, date).canSubmit, false, 'project schedule changes invalidate old responses');
  const scheduledActivity = harness(); await scheduledActivity.enable([]);
  scheduledActivity.db.assignments[0].activity = 'Excavation at the east trench';
  scheduledActivity.db.assignments[0].instructions = '';
  assert.ok((await scheduledActivity.generate()).data.checks.some(check => check.activity === 'excavation'), 'assignment activity automatically adds the relevant safety checks');
  tasks.db.projects[0].site = '100 Main St, Seattle, WA 98101';
  const moved = await tasks.call('GET', `?date=${date}`);
  assert.equal(moved.data.profile.state, 'WA', 'project move updates the displayed jurisdiction');
  assert.equal(moved.data.coverage, 'manual-review', 'later address changes cannot keep Oregon coverage');
  const overnight = harness(); await overnight.enable(); await overnight.generate(); await complete(overnight);
  let original = overnight.db.safetyDays[0];
  const failureInput = { revision: original.revision, status: 'fail', inspector: 'PM', notes: 'Anchor unavailable', action: 'Keep roof work stopped', owner: 'Foreman', dueDate: date, workStopped: true };
  let open = await overnight.call('PATCH', `/days/${date}/checks/roofing-protection`, failureInput);
  const stableHazardId = open.data.hazards[0].id;
  open = await overnight.call('PATCH', `/days/${date}/checks/roofing-protection`, { ...failureInput, revision: open.data.revision });
  assert.equal(open.data.hazards.length, 1, 'repeated failure uses one stable follow-up');
  assert.equal(open.data.hazards[0].id, stableHazardId);
  const tomorrow = '2026-10-27'; await overnight.generate(0, tomorrow); await complete(overnight, {}, tomorrow);
  let tomorrowState = await overnight.call('GET', `?date=${tomorrow}`);
  assert.equal(tomorrowState.data.day.summary.unresolved, 1, 'prior-day failed check remains unresolved');
  assert.equal(tomorrowState.data.day.summary.readyForWork, false);
  assert.equal(tomorrowState.data.openHazards[0].date, date);
  overnight.db.assignments[0].instructions = 'Changed after original inspection';
  const fixed = await overnight.call('PATCH', `/days/${date}/hazards/${stableHazardId}`, { revision: overnight.db.safetyDays[0].revision, status: 'verified', action: 'Installed inspected anchor', verification: 'PM verified the new anchor' }, pm);
  assert.equal(fixed.status, 200, 'stale checklist does not block recording a corrective action');
  assert.equal(fixed.data.summary.stale, true, 'correction does not implicitly revalidate stale checklist');
  assert.equal(fixed.data.checks.find(row => row.id === 'roofing-protection').status, 'fail', 'original failure evidence remains unchanged');
  tomorrowState = await overnight.call('GET', `?date=${tomorrow}`);
  assert.equal(tomorrowState.data.day.summary.unresolved, 0); assert.equal(tomorrowState.data.day.summary.readyForWork, true);
  console.log('Safety engine tests passed: authentication, project isolation, optimistic revisions, stale scope, competent person, documented stoppage, hazards and audit evidence.');
})().catch(error => { console.error(error); process.exitCode = 1; });
