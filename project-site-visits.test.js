'use strict';

// Deterministic domain and route-handler coverage. This test never opens a
// socket, calls an AI provider, or touches production/customer records.
const assert = require('node:assert/strict');
const {
  cleanText,
  evidenceHash,
  fallbackOrganize,
  normalizeReview,
  createSiteVisitsHandler
} = require('./project-site-visits');

const ids = {
  visit: '10000000-0000-4000-8000-000000000001',
  secondVisit: '10000000-0000-4000-8000-000000000002',
  entry: '20000000-0000-4000-8000-000000000001',
  secondEntry: '20000000-0000-4000-8000-000000000002'
};
const timestamp = '2026-10-26T18:00:00.000Z';

assert.equal(cleanText('  set forms\r\n  '), 'set forms');
assert.equal(cleanText('contains\u0000control'), '');
assert.equal(cleanText('x'.repeat(5001)), '');

const evidence = [
  { id: ids.entry, revision: 1, type: 'text', text: 'Concrete delivery was pushed two days. Call the supplier tomorrow.', photoIds: [] },
  { id: ids.secondEntry, revision: 1, type: 'text', text: 'Crew installed the west forms. No incident was reported.', photoIds: [] }
];
assert.equal(evidenceHash(evidence), evidenceHash(JSON.parse(JSON.stringify(evidence))), 'stable evidence produces a stable hash');
assert.notEqual(evidenceHash(evidence), evidenceHash([{ ...evidence[0], revision: 2 }, evidence[1]]), 'a revision changes the evidence hash');

const organized = fallbackOrganize({ entries: evidence, tasks: [{ id: 91, name: 'Concrete delivery' }] });
assert.equal(organized.scheduleImpacts.length, 1, 'an explicit pushed date becomes a review proposal');
assert.equal(organized.scheduleImpacts[0].taskId, 91);
assert.equal(organized.scheduleImpacts[0].shiftDays, 2);
assert.ok(organized.sections.delays.some(item => item.sourceEntryIds.includes(ids.entry)));
assert.ok(organized.sections.nextActions.some(item => item.sourceEntryIds.includes(ids.entry)));
assert.equal(fallbackOrganize({ entries: [{ ...evidence[0], text: 'Concrete looked good today.' }], tasks: [] }).scheduleImpacts.length, 0, 'ordinary field text never invents schedule work');
assert.equal(fallbackOrganize({ entries: [{ ...evidence[0], text: 'No delays today.' }], tasks: [] }).scheduleImpacts.length, 0, 'a clear no-delay statement never becomes a schedule proposal');

const normalized = normalizeReview({
  source: 'openai',
  sections: {
    workCompleted: [
      { text: 'Grounded item', sourceEntryIds: [ids.entry] },
      { text: 'Invented item', sourceEntryIds: ['missing-evidence'] }
    ]
  },
  scheduleImpacts: [
    { taskId: 9999, taskName: 'Fake target', shiftDays: 4, note: 'Possible delay', sourceEntryIds: [ids.entry] }
  ]
}, evidence, [{ id: 91, name: 'Concrete delivery' }]);
assert.deepEqual(normalized.sections.workCompleted.map(item => item.text), ['Grounded item']);
assert.equal(normalized.scheduleImpacts[0].taskId, null, 'AI cannot manufacture a task identifier');
assert.equal(normalized.scheduleImpacts[0].confidence, 'needs_review');

function fixture() {
  return {
    company: { id: 'tenant-pm-visit', name: 'QA Builders' },
    projects: [
      { id: 101, name: 'Assigned Project', site: '101 Main St' },
      { id: 102, name: 'Other Project', site: '102 Main St' }
    ],
    users: [],
    photos: [
      { id: 501, projectId: 101, siteVisitId: ids.visit },
      { id: 502, projectId: 102 }
    ],
    projectTasks: [{ id: 91, projectId: 101, name: 'Concrete delivery', startDate: '2026-10-27', endDate: '2026-10-27' }],
    projectSiteVisits: [], projectNotesTodos: [], auditLog: []
  };
}

let db = fixture();
let writes = 0;
let clock = 0;
const users = {
  owner: { id: 1, name: 'Owner', role: 'owner' },
  pm: { id: 2, name: 'Assigned PM', role: 'project_manager', projectIds: [101] },
  otherPm: { id: 3, name: 'Other PM', role: 'project_manager', projectIds: [101] },
  noScope: { id: 4, name: 'No-scope PM', role: 'project_manager', projectIds: [] },
  field: { id: 5, name: 'Field User', role: 'field' }
};
const handler = createSiteVisitsHandler({
  readDb: () => db,
  writeDb: value => { db = value; writes += 1; },
  body: async req => req.input || {},
  json: (res, status, value) => { res.status = status; res.value = value; },
  authenticatedUser: req => req.user || null,
  canAccessProject: (_db, user, projectId) => ['owner', 'admin'].includes(user.role) || (user.projectIds || []).map(Number).includes(Number(projectId)),
  organize: async ({ entries }) => ({
    source: 'openai',
    sections: {
      workCompleted: [{ text: 'Concrete delivery was pushed two days.', sourceEntryIds: [entries[0].id] }],
      safety: [], delays: [{ text: 'Concrete delivery was pushed two days.', sourceEntryIds: [entries[0].id] }],
      decisions: [], nextActions: [], potentialChanges: []
    },
    scheduleImpacts: [{ taskId: 91, taskName: 'Concrete delivery', shiftDays: 2, note: 'Concrete delivery was pushed two days.', sourceEntryIds: [entries[0].id] }]
  }),
  now: () => new Date(new Date(timestamp).getTime() + clock++ * 1000)
});

async function call(method, pathname, user, input) {
  const req = { method, user, input };
  const res = {};
  const handled = await handler(req, res, new URL(`https://qa.invalid${pathname}`));
  assert.equal(handled, true, `${method} ${pathname} is handled`);
  return res;
}

(async () => {
  let result = await call('POST', '/api/projects/101/site-visits', null, { visitId: ids.visit, requestId: 'request-auth-1' });
  assert.equal(result.status, 401);
  result = await call('POST', '/api/projects/101/site-visits', users.field, { visitId: ids.visit, requestId: 'request-role-1' });
  assert.equal(result.status, 403);
  result = await call('POST', '/api/projects/102/site-visits', users.pm, { visitId: ids.visit, requestId: 'request-scope-1' });
  assert.equal(result.status, 404, 'an assigned PM cannot access another project');

  result = await call('POST', '/api/projects/101/site-visits', users.pm, { visitId: ids.visit, requestId: 'request-start-1' });
  assert.equal(result.status, 201);
  assert.equal(result.value.status, 'active');
  const startWrites = writes;
  result = await call('POST', '/api/projects/101/site-visits', users.pm, { visitId: ids.secondVisit, requestId: 'request-start-1' });
  assert.equal(result.status, 409, 'a start request key cannot be reused for a different visit id');
  assert.equal(result.value.code, 'SITE_VISIT_REQUEST_CONFLICT');
  result = await call('POST', '/api/projects/101/site-visits', users.pm, { visitId: ids.secondVisit, requestId: 'request-start-2' });
  assert.equal(result.status, 200);
  assert.equal(result.value.id, ids.visit, 'double start resumes the active visit');
  assert.equal(writes, startWrites, 'idempotent start performs no write');

  result = await call('GET', `/api/projects/101/site-visits/${ids.visit}`, users.otherPm);
  assert.equal(result.status, 404, 'one PM cannot guess another PM\'s open visit');

  result = await call('POST', `/api/projects/101/site-visits/${ids.visit}/entries`, users.pm, {
    entryId: ids.entry, requestId: 'request-entry-1', type: 'text', text: 'Concrete delivery was pushed two days.'
  });
  assert.equal(result.status, 201);
  const entryRevision = result.value.entry.revision;
  const entryWrites = writes;
  result = await call('POST', `/api/projects/101/site-visits/${ids.visit}/entries`, users.pm, {
    entryId: ids.entry, requestId: 'request-entry-1', type: 'text', text: 'Concrete delivery was pushed two days.'
  });
  assert.equal(result.status, 200);
  assert.equal(result.value.entry.text, 'Concrete delivery was pushed two days.');
  assert.equal(writes, entryWrites, 'entry retry is idempotent');
  result = await call('POST', `/api/projects/101/site-visits/${ids.visit}/entries`, users.pm, {
    entryId: ids.entry, requestId: 'request-entry-1', type: 'text', text: 'Duplicate replay with changed evidence'
  });
  assert.equal(result.status, 409, 'changed evidence cannot reuse an idempotency key');
  assert.equal(result.value.code, 'SITE_VISIT_ENTRY_REQUEST_CONFLICT');
  assert.equal(db.projectSiteVisits[0].entries[0].text, 'Concrete delivery was pushed two days.', 'the original evidence remains intact');

  result = await call('POST', `/api/projects/101/site-visits/${ids.visit}/entries`, users.pm, {
    entryId: ids.secondEntry, requestId: 'request-photo-valid-1', type: 'photo', photoIds: [501]
  });
  assert.equal(result.status, 201, 'a photo created for this exact visit can be attached');

  result = await call('POST', `/api/projects/101/site-visits/${ids.visit}/entries`, users.pm, {
    entryId: '20000000-0000-4000-8000-000000000003', requestId: 'request-photo-1', type: 'photo', photoIds: [502]
  });
  assert.equal(result.status, 400, 'cross-project photos cannot be attached');

  result = await call('PATCH', `/api/projects/101/site-visits/${ids.visit}/entries/${ids.entry}`, users.pm, { revision: entryRevision + 5, text: 'Stale edit' });
  assert.equal(result.status, 409);
  assert.equal(result.value.code, 'SITE_VISIT_ENTRY_CONFLICT');
  result = await call('PATCH', `/api/projects/101/site-visits/${ids.visit}/entries/${ids.entry}`, users.pm, { revision: entryRevision, text: 'Concrete delivery moved two days.' });
  assert.equal(result.status, 200);
  assert.equal(result.value.visit.history.at(-1).before.text, 'Concrete delivery was pushed two days.');
  assert.equal(result.value.visit.history.at(-1).after.text, 'Concrete delivery moved two days.');

  const scheduleBefore = JSON.stringify(db.projectTasks);
  const finishRequestRevision = db.projectSiteVisits[0].revision;
  result = await call('POST', `/api/projects/101/site-visits/${ids.visit}/finish`, users.pm, { revision: finishRequestRevision });
  assert.equal(result.status, 200);
  assert.equal(result.value.status, 'review');
  assert.equal(result.value.review.scheduleImpacts[0].shiftDays, 2);
  assert.equal(JSON.stringify(db.projectTasks), scheduleBefore, 'AI organization never mutates the live schedule');
  const finishWrites = writes;
  result = await call('POST', `/api/projects/101/site-visits/${ids.visit}/finish`, users.pm, { revision: finishRequestRevision });
  assert.equal(result.status, 200, 'an exact finish retry returns the existing review');
  assert.equal(writes, finishWrites, 'an exact finish retry performs no write or second review');

  result = await call('POST', `/api/projects/101/site-visits/${ids.visit}/complete`, users.pm, {
    revision: result.value.revision,
    sections: { workCompleted: [], safety: [], delays: [], decisions: [], nextActions: [], potentialChanges: [] },
    scheduleImpacts: []
  });
  assert.equal(result.status, 200);
  assert.equal(result.value.status, 'completed');
  assert.equal(result.value.final.sections.workCompleted.length, 0, 'a PM can intentionally clear an AI suggestion');
  assert.equal(db.projectNotesTodos.length, 1, 'completion writes one shared project update');
  assert.equal(db.auditLog.at(-1).type, 'site_visit_completed');
  const completionWrites = writes;
  const completionRevision = result.value.revision;
  result = await call('POST', `/api/projects/101/site-visits/${ids.visit}/complete`, users.pm, { revision: completionRevision });
  assert.equal(result.status, 200);
  assert.equal(writes, completionWrites, 'completion retry is idempotent');
  assert.equal(db.projectNotesTodos.length, 1);

  result = await call('POST', `/api/projects/101/site-visits/${ids.visit}/entries`, users.pm, {
    entryId: ids.secondEntry, requestId: 'request-late-1', type: 'text', text: 'Late edit'
  });
  assert.equal(result.status, 409, 'raw evidence is immutable after completion');

  result = await call('GET', `/api/projects/101/site-visits/${ids.visit}`, users.owner);
  assert.equal(result.status, 200, 'office leadership can read a completed project visit');
  result = await call('GET', '/api/projects/101/site-visits', users.noScope);
  assert.equal(result.status, 404);

  console.log('project-site-visits domain and handler tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });

