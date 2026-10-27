'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-site-visit-photo-'));
const companyId = '11111111-1111-4111-8111-111111111111';
const visitId = '10000000-0000-4000-8000-000000000001';
const tokens = { author: 'site-visit-photo-author', other: 'site-visit-photo-other' };
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const now = '2026-10-26T18:00:00.000Z';
const dbFile = path.join(root, 'db.json'), platformFile = path.join(root, 'platform.json');
const db = {
  company: { id: companyId, name: 'Photo QA', timezone: 'America/Los_Angeles' },
  projects: [{ id: 101, name: 'Assigned Project', status: 'Active' }], team: [], crews: [], customers: [], assignments: [], reports: [], photos: [], workdays: [], timeCards: [], changes: [], auditLog: [], projectTasks: [], projectNotesTodos: [],
  users: [
    { id: 2, companyId, name: 'Author PM', email: 'author@example.invalid', role: 'project_manager', status: 'Active', projectIds: [101] },
    { id: 3, companyId, name: 'Other PM', email: 'other@example.invalid', role: 'project_manager', status: 'Active', projectIds: [101] }
  ],
  sessions: [
    { companyId, userId: 2, tokenHash: hash(tokens.author), expiresAt: '2099-01-01T00:00:00.000Z' },
    { companyId, userId: 3, tokenHash: hash(tokens.other), expiresAt: '2099-01-01T00:00:00.000Z' }
  ],
  projectSiteVisits: [{ id: visitId, requestId: 'request-site-photo', companyId, projectId: 101, status: 'active', revision: 1, startedAt: now, updatedAt: now, startedBy: 'Author PM', startedByUserId: 2, entries: [], review: null, final: null, history: [] }]
};
fs.writeFileSync(dbFile, JSON.stringify(db));
fs.writeFileSync(platformFile, JSON.stringify({ users: [], sessions: [] }));
Object.assign(process.env, { PDL_DB_FILE: dbFile, PDL_PLATFORM_FILE: platformFile, PDL_REQUIRE_AUTH: '1', PDL_SUPABASE_ENABLED: '0', PDL_TRANSACTIONAL_DB: 'off', PDL_EMAIL_DEV_MODE: '1' });
for (const key of ['OPENAI_API_KEY', 'SENTRY_DSN', 'RESEND_API_KEY', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET']) delete process.env[key];
require('./database/supabase').loadLocalEnv = () => {};
const { server } = require('./server');
const jpeg = 'data:image/jpeg;base64,' + Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46]).toString('base64');

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (token, input) => {
    const response = await fetch(base + '/api/photos', { method: 'POST', signal: AbortSignal.timeout(10000), headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-PDL-Company': companyId }, body: JSON.stringify(input) });
    return { status: response.status, body: await response.json() };
  };
  const payload = { project: 0, projectId: 101, siteVisitId: visitId, clientTag: 'visit-photo-aaaaaaaa', caption: 'North wall ready', tags: ['Site-Visit', 'x'.repeat(100)], phase: 'site_visit', source: 'field', files: [{ name: 'north.jpg', type: 'image/jpeg', lastModified: 1700000000000, data: jpeg }] };
  try {
    let result = await call(tokens.author, payload);
    assert.equal(result.status, 201);
    assert.equal(result.body.length, 1);
    assert.equal(result.body[0].uploaderUserId, 2);
    assert.equal(result.body[0].source, 'office', 'source is derived from the signed-in PM, not trusted client text');
    assert.equal(result.body[0].siteVisitId, visitId);
    assert.ok(result.body[0].tags.every(tag => tag.length <= 40));
    const savedId = result.body[0].id;

    result = await call(tokens.author, payload);
    assert.equal(result.status, 200);
    assert.equal(result.body[0].id, savedId, 'an exact retry returns the original evidence');

    result = await call(tokens.author, { ...payload, caption: 'Changed payload' });
    assert.equal(result.status, 409, 'a reused save key cannot point at changed evidence');

    result = await call(tokens.other, payload);
    assert.equal(result.status, 404, 'another PM cannot retrieve or append to the author\'s open visit');

    result = await call(tokens.author, { ...payload, clientTag: 'visit-photo-bbbbbbbb', phase: 'unexpected' });
    assert.equal(result.status, 400);

    result = await call(tokens.author, { ...payload, clientTag: 'visit-photo-cccccccc', files: [{ name: 'fake.jpg', type: 'image/jpeg', lastModified: 1700000000000, data: 'data:image/jpeg;base64,' + Buffer.from('not an image').toString('base64') }] });
    assert.equal(result.status, 400, 'declared MIME without matching image bytes is rejected');

    const persisted = JSON.parse(fs.readFileSync(dbFile));
    assert.equal(persisted.photos.length, 1, 'retries and rejected evidence create no extra photo rows');
    assert.equal(persisted.projectSiteVisits[0].entries.length, 1, 'one visit photo creates one evidence entry');
    console.log('project site-visit photo API security tests passed');
  } finally {
    server.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
