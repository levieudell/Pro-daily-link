'use strict';
// Change orders step 1 — field voice-flagging: a field user can flag extra
// work from the daily report (POST /api/changes/from-field), gets a PC number
// back, can attach photos to their own flag, and the office sees the flag in
// the Action Center until it is dispositioned. Amounts stay office-only.
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-change-flag-')), companyId = '22112211-2211-4221-8221-221122112211', ownerToken = 'synthetic-change-owner', fieldToken = 'synthetic-change-field', otherFieldToken = 'synthetic-change-other';
const db = {
  company: { id: companyId, name: 'Synthetic flagging', demo: true, timezone: 'UTC' },
  projects: [{ id: 101, name: 'Synthetic Job', estimateItems: [] }, { id: 202, name: 'Other Job', estimateItems: [] }],
  team: [{ id: 7, name: 'Sam Foreman', crew: 'A' }, { id: 9, name: 'Pat Laborer', crew: 'B' }],
  assignments: [{ id: 1, projectId: 101, date: '2026-10-11', crew: 'A', memberIds: [7] }, { id: 2, projectId: 101, date: '2026-10-11', crew: 'B', memberIds: [9] }],
  reports: [], photos: [], workdays: [], timeCards: [], changes: [], customers: [], catalog: [],
  users: [
    { id: 1, name: 'Synthetic owner', role: 'owner', status: 'Active', companyId },
    { id: 2, name: 'Sam Foreman', memberId: 7, role: 'field', status: 'Active', companyId },
    { id: 3, name: 'Pat Laborer', memberId: 9, role: 'field', status: 'Active', companyId },
  ],
  sessions: [
    { companyId, userId: 1, tokenHash: crypto.createHash('sha256').update(ownerToken).digest('hex'), expiresAt: '2099-01-01' },
    { companyId, userId: 2, tokenHash: crypto.createHash('sha256').update(fieldToken).digest('hex'), expiresAt: '2099-01-01' },
    { companyId, userId: 3, tokenHash: crypto.createHash('sha256').update(otherFieldToken).digest('hex'), expiresAt: '2099-01-01' },
  ],
};
const file = path.join(root, 'db.json');
fs.writeFileSync(file, JSON.stringify(db));
fs.writeFileSync(path.join(root, 'platform.json'), JSON.stringify({ users: [], sessions: [] }));
Object.assign(process.env, { PDL_DB_FILE: file, PDL_PLATFORM_FILE: path.join(root, 'platform.json'), PDL_REQUIRE_AUTH: '1', PDL_SUPABASE_ENABLED: '0', PDL_TRANSACTIONAL_DB: 'off', PDL_EMAIL_DEV_MODE: '1' });
for (const name of ['OPENAI_API_KEY', 'SENTRY_DSN', 'RESEND_API_KEY', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET']) delete process.env[name];
require('./database/supabase').loadLocalEnv = () => {};
const { server } = require('./server'), nativeFetch = global.fetch;
let base;
global.fetch = (url, options) => { assert.ok(String(url).startsWith(base + '/'), 'only synthetic localhost requests permitted'); return nativeFetch(url, options); };
async function call(method, route, body, auth = ownerToken) {
  const response = await fetch(base + route, { method, signal: AbortSignal.timeout(10000), headers: { 'Content-Type': 'application/json', 'x-pdl-company': companyId, Authorization: 'Bearer ' + auth }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, data: await response.json() };
}
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

(async () => {
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = 'http://127.0.0.1:' + server.address().port;

    // Field flags extra work on an assigned project.
    const flagged = await call('POST', '/api/changes/from-field', { projectId: 101, title: 'Hit unexpected bedrock, had to rip 40 CY more', hours: 6, quantity: 40, unit: 'CY', date: '2026-10-11', amount: 5000 }, fieldToken);
    assert.equal(flagged.status, 201);
    assert.equal(flagged.data.number, 'PC-001', 'flag gets a tracking number');
    assert.equal(flagged.data.status, 'Potential');
    assert.equal(flagged.data.fieldFlag, true);
    assert.equal(flagged.data.createdBy, 'Sam Foreman');
    assert.equal(flagged.data.amount, undefined, 'field responses never carry an amount');
    assert.equal(flagged.data.hours, 6);
    assert.equal(flagged.data.quantity, 40);
    assert.equal(flagged.data.unit, 'CY');
    assert.ok(!('amount' in flagged.data));

    // Stored record keeps amount at 0 no matter what the field sent.
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    const storedChange = stored.changes.find(change => change.id === flagged.data.id);
    assert.equal(storedChange.amount, 0, 'amount is forced to 0 for field flags');
    assert.ok(stored.auditLog.some(entry => entry.type === 'project_change_flagged' && entry.changeId === flagged.data.id), 'flag is audited');

    // Field cannot flag work on projects they are not assigned to.
    const scoped = await call('POST', '/api/changes/from-field', { projectId: 202, title: 'Not my job' }, fieldToken);
    assert.equal(scoped.status, 404, 'unassigned projects are invisible to the field user');
    // Unknown project.
    assert.equal((await call('POST', '/api/changes/from-field', { projectId: 999, title: 'X' }, fieldToken)).status, 404);
    // Description required.
    assert.equal((await call('POST', '/api/changes/from-field', { projectId: 101, title: '  ' }, fieldToken)).status, 400);

    // Office-only invariants hold: field still blocked from office change routes.
    assert.equal((await call('GET', '/api/changes?projectId=101', null, fieldToken)).status, 403, 'field cannot list all changes');
    assert.equal((await call('POST', '/api/changes', { projectId: 101, title: 'Office entry' }, fieldToken)).status, 403, 'field cannot use the office endpoint');
    assert.equal((await call('POST', '/api/changes/from-field', { projectId: 101, title: 'Office posing as field' }, ownerToken)).status, 403, 'the field endpoint rejects office roles');

    // Office sees the flag in the Changes tab with the foreman credited.
    const officeList = await call('GET', '/api/changes?projectId=101');
    const officeView = officeList.data.find(change => change.id === flagged.data.id);
    assert.equal(officeView.fieldFlag, true);
    assert.equal(officeView.createdBy, 'Sam Foreman');
    assert.equal(officeView.amount, 0);

    // Action Center surfaces the flag until dispositioned.
    const center = await call('GET', '/api/action-center');
    const item = center.data.items.find(row => row.id === `change-flag-${flagged.data.id}`);
    assert.ok(item, 'flag appears in the office Action Center');
    assert.equal(item.severity, 'high');
    assert.match(item.title, /Extra work flagged from the field/);
    assert.match(item.detail, /PC-001/);
    // Office moves it out of Potential → the Action Center item clears.
    const moved = await call('PATCH', `/api/changes/${flagged.data.id}`, { status: 'Pricing' });
    assert.equal(moved.status, 200);
    const cleared = await call('GET', '/api/action-center');
    assert.ok(!cleared.data.items.some(row => row.id === `change-flag-${flagged.data.id}`), 'dispositioned flags leave the Action Center');

    // Photos: the flag owner attaches evidence; others cannot.
    const attached = await call('POST', '/api/photos', { project: 0, projectId: 101, source: 'field', changeId: flagged.data.id, files: [{ type: 'image/png', data: PNG, name: 'bedrock.png' }] }, fieldToken);
    assert.equal(attached.status, 201, 'flag owner can attach photos');
    const afterPhotos = JSON.parse(fs.readFileSync(file, 'utf8'));
    const photo = afterPhotos.photos.find(row => row.changeId === flagged.data.id);
    assert.ok(photo, 'photo row carries the change link');
    assert.deepEqual(afterPhotos.changes.find(change => change.id === flagged.data.id).photoIds, [photo.id], 'change records the photo ids');
    // Another field user cannot attach to someone else's flag.
    const denied = await call('POST', '/api/photos', { project: 0, projectId: 101, source: 'field', changeId: flagged.data.id, files: [{ type: 'image/png', data: PNG, name: 'x.png' }] }, otherFieldToken);
    assert.equal(denied.status, 403, 'field users can only add photos to their own flag');
    // A change from another project is rejected as a link target.
    const officeChange = await call('POST', '/api/changes', { projectId: 202, title: 'Office change on 202' });
    const wrongProject = await call('POST', '/api/photos', { project: 0, projectId: 101, source: 'field', changeId: officeChange.data.id, files: [{ type: 'image/png', data: PNG, name: 'y.png' }] }, fieldToken);
    assert.equal(wrongProject.status, 400, 'photos must link to a change on the same project');

    // --- Client wiring contracts ---------------------------------------------
    const index = fs.readFileSync('index.html', 'utf8'), app = fs.readFileSync('app.js', 'utf8');
    assert.ok(index.includes('id="flag-extra-work"'), 'daily form carries the Flag extra work button');
    assert.ok(index.includes('id="flag-change-modal"'), 'flag dialog exists');
    assert.ok(index.includes('id="flag-change-voice-status"'), 'flag dialog has a live listening status line');
    assert.ok(app.includes("$('#flag-extra-work').onclick"), 'button is wired');
    assert.ok(app.includes("'/api/changes/from-field'"), 'client posts to the field endpoint');
    assert.match(app, /Flagged to the office as \$\{change\.number\}/, 'foreman sees the tracking number');
    assert.ok(app.includes('Reportado a la oficina como'), 'Spanish confirmation copy');
    assert.ok(app.includes('changeId=null,isCurrent'), 'uploadPhotos accepts a change link');
    assert.ok(app.includes('changeId:change.id'), 'save flow attaches photos to the created flag');
    assert.ok(app.includes('Created by ${escapeHtml(change.createdBy'), 'office card credits the actual creator');
    assert.ok(index.includes('app.js?v=20261013-roles-uxa'), 'cache-buster pinned');

    console.log('Change field-flagging API passed: field-scoped creation, amount pinning, office visibility, action-center lifecycle, photo ownership, and client wiring.');
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    global.fetch = nativeFetch;
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; server.close(); });
