'use strict';

// The provider call for Finish site notes must not hold the tenant-wide write
// queue. This real HTTP regression pauses the AI response, saves newer field
// evidence through a second request, then proves the stale AI result is
// rejected instead of overwriting that evidence.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-site-visit-concurrency-'));
const companyId = '22222222-2222-4222-8222-222222222222';
const projectId = 101;
const visitId = '10000000-0000-4000-8000-000000000010';
const firstEntryId = '20000000-0000-4000-8000-000000000010';
const secondEntryId = '20000000-0000-4000-8000-000000000011';
const token = 'site-visit-concurrency-author';
const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
const dbFile = path.join(root, 'db.json'), platformFile = path.join(root, 'platform.json');
const now = '2026-10-26T18:00:00.000Z';
const db = {
  company: { id: companyId, name: 'Concurrency QA', timezone: 'America/Los_Angeles' },
  projects: [{ id: projectId, name: 'Assigned Project', status: 'Active' }],
  team: [], crews: [], customers: [], assignments: [], reports: [], photos: [], workdays: [], timeCards: [], changes: [], auditLog: [], projectTasks: [], projectNotesTodos: [],
  users: [{ id: 2, companyId, name: 'Author PM', email: 'author@example.invalid', role: 'project_manager', status: 'Active', projectIds: [projectId] }],
  sessions: [{ companyId, userId: 2, tokenHash, expiresAt: '2099-01-01T00:00:00.000Z' }],
  projectSiteVisits: [{
    id: visitId, requestId: 'request-concurrency-visit', companyId, projectId, status: 'active', revision: 2,
    startedAt: now, updatedAt: now, startedBy: 'Author PM', startedByUserId: 2,
    entries: [{ id: firstEntryId, requestId: 'request-first-entry', type: 'text', text: 'Concrete was pushed two days.', photoIds: [], revision: 1, createdAt: now, createdBy: 'Author PM', createdByUserId: 2, updatedAt: now }],
    review: null, final: null, history: []
  }]
};
fs.writeFileSync(dbFile, JSON.stringify(db));
fs.writeFileSync(platformFile, JSON.stringify({ users: [], sessions: [] }));
Object.assign(process.env, {
  PDL_DB_FILE: dbFile, PDL_PLATFORM_FILE: platformFile, PDL_REQUIRE_AUTH: '1',
  PDL_SUPABASE_ENABLED: '0', PDL_TRANSACTIONAL_DB: 'off', PDL_EMAIL_DEV_MODE: '1',
  OPENAI_API_KEY: 'test-only-site-visit-key', NODE_ENV: 'test'
});
for (const key of ['SENTRY_DSN', 'RESEND_API_KEY', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET']) delete process.env[key];
require('./database/supabase').loadLocalEnv = () => {};

const nativeFetch = global.fetch;
let releaseAI, signalAIStarted;
const aiStarted = new Promise(resolve => { signalAIStarted = resolve; });
global.fetch = async (url, options) => {
  if (!String(url).startsWith('https://api.openai.com/')) return nativeFetch(url, options);
  const request = JSON.parse(options.body), evidence = JSON.parse(request.input).evidence;
  signalAIStarted();
  await new Promise(resolve => { releaseAI = resolve; });
  const output = {
    sections: {
      workCompleted: [{ text: evidence[0].text, sourceEntryIds: [evidence[0].id] }],
      safety: [], delays: [{ text: evidence[0].text, sourceEntryIds: [evidence[0].id] }],
      decisions: [], nextActions: [], potentialChanges: []
    },
    scheduleImpacts: []
  };
  return new Response(JSON.stringify({ output_text: JSON.stringify(output), usage: { input_tokens: 10, output_tokens: 10 } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};

const { server } = require('./server');
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (pathname, input, timeout = 5000) => {
    const response = await nativeFetch(base + pathname, {
      method: 'POST', signal: AbortSignal.timeout(timeout),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-PDL-Company': companyId },
      body: JSON.stringify(input)
    });
    return { status: response.status, body: await response.json() };
  };
  let finishPromise;
  try {
    finishPromise = call(`/api/projects/${projectId}/site-visits/${visitId}/finish`, { revision: 2 }, 10000);
    await Promise.race([aiStarted, sleep(2000).then(() => { throw new Error('The finish request never reached the AI organization phase'); })]);

    const concurrentPromise = call(`/api/projects/${projectId}/site-visits/${visitId}/entries`, {
      entryId: secondEntryId, requestId: 'request-second-entry', type: 'text', text: 'Supplier confirmed the revised delivery window.'
    }, 5000);
    const concurrent = await Promise.race([concurrentPromise, sleep(1200).then(() => ({ blocked: true }))]);
    if (concurrent.blocked) {
      releaseAI?.();
      await finishPromise.catch(() => {});
      assert.fail('An ordinary tenant write was blocked while the AI provider response was pending');
    }
    assert.equal(concurrent.status, 201, 'new evidence saves while organization is pending');

    releaseAI();
    const finish = await finishPromise;
    assert.equal(finish.status, 409, 'the stale organization result is rejected');
    assert.equal(finish.body.code, 'SITE_VISIT_CONFLICT');
    assert.equal(finish.body.visit.entries.length, 2, 'the conflict response returns the latest evidence');

    const persisted = JSON.parse(fs.readFileSync(dbFile));
    const visit = persisted.projectSiteVisits.find(row => row.id === visitId);
    assert.equal(visit.entries.length, 2, 'newer evidence remains authoritative');
    assert.equal(visit.entries[1].text, 'Supplier confirmed the revised delivery window.');
    assert.equal(visit.review, null, 'stale AI output never overwrites the visit review');
    assert.equal(visit.status, 'active');
    console.log('project site-visit two-phase concurrency tests passed');
  } finally {
    releaseAI?.();
    await finishPromise?.catch(() => {});
    await new Promise(resolve => server.close(resolve));
    global.fetch = nativeFetch;
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
