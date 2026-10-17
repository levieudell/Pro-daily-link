'use strict';
// The latest explicit non-empty next step wins. Empty text never overwrites.
// A first send keeps the clock-out next. A second punch on the same job
// merges into that daily and keeps B's next step when B entered one.
// A shorter review edit replaces the stored text. An empty save keeps it.
// Sending the daily submits the closed punch so the time card is not left draft.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const NEXT_A = `${'Form the east curb and stage the pump before the inspector walks it. '.repeat(8)}`.slice(0, 332);
const NEXT_B = `${'Finish the east curb, confirm the pump, and leave the forms up for the inspector. '.repeat(8)}`.slice(0, 400);
assert.equal(NEXT_A.length, 332);
assert.equal(NEXT_B.length, 400);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-next-merge-'));
const companyId = '7176abe8-07e4-4336-a372-1163d2f21ff9';
const token = 'synthetic-next-merge-session';
const db = {
  company: { id: companyId, name: 'Synthetic next merge', demo: true, timezone: 'UTC', features: { timeCards: true } },
  projects: [
    { id: 101, name: 'Synthetic clinic', code: 'SYN', estimateItems: [{ id: 1, name: 'Curb', plannedQuantity: 800, unit: 'LF', budgetHours: 80 }] },
    { id: 102, name: 'Synthetic second job', code: 'SYN-2', estimateItems: [{ id: 1, name: 'Gutter', plannedQuantity: 600, unit: 'LF', budgetHours: 60 }] }
  ],
  team: [{ id: 11, name: 'Synthetic worker', crew: 'A' }, { id: 12, name: 'Second worker', crew: 'B' }],
  assignments: [], reports: [], photos: [], workdays: [], timeCards: [],
  users: [{ id: 1, name: 'Synthetic owner', role: 'owner', status: 'Active', companyId }],
  sessions: [{ companyId, userId: 1, tokenHash: crypto.createHash('sha256').update(token).digest('hex'), expiresAt: '2099-01-01' }],
  customers: [], changes: [], catalog: []
};
const file = path.join(root, 'db.json');
fs.writeFileSync(file, JSON.stringify(db));
fs.writeFileSync(path.join(root, 'platform.json'), JSON.stringify({ users: [], sessions: [] }));
Object.assign(process.env, { PDL_DB_FILE: file, PDL_PLATFORM_FILE: path.join(root, 'platform.json'), PDL_REQUIRE_AUTH: '1', PDL_SUPABASE_ENABLED: '0', PDL_TRANSACTIONAL_DB: 'off', PDL_EMAIL_DEV_MODE: '1' });
for (const name of ['OPENAI_API_KEY', 'SENTRY_DSN', 'RESEND_API_KEY', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'PDL_STAGING']) delete process.env[name];
require('./database/supabase').loadLocalEnv = () => {};
const { server } = require('./server');

function pinPunch(workdayId, minutes) {
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  const startedAt = new Date(Date.now() - (minutes * 60 + 20) * 1000).toISOString();
  for (const day of stored.workdays) if (day.id === workdayId) day.startedAt = startedAt;
  for (const card of stored.timeCards) if (card.workdayId === workdayId && !card.outAt) card.inAt = startedAt;
  fs.writeFileSync(file, JSON.stringify(stored));
}

function sendPayload(report, next) {
  const hours = (report.laborEntries || []).reduce((sum, row) => sum + (Number(row.hours) || 0), 0);
  return {
    status: 'Needs review',
    notes: report.notes,
    next,
    foreman: report.foreman,
    laborEntries: report.laborEntries,
    productionEntries: [{ estimateItemId: 1, description: 'Curb', quantity: 40, unit: 'LF', laborHours: Math.round(hours * 100) / 100 }]
  };
}

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const call = async (method, route, input) => {
    const response = await fetch(base + route, { method, signal: AbortSignal.timeout(10000), headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', 'x-pdl-company': companyId }, ...(input ? { body: JSON.stringify(input) } : {}) });
    const data = await response.json();
    return { status: response.status, data };
  };
  try {
    const startA = await call('POST', '/api/workdays/start', { projectId: 101, memberIds: [11] });
    assert.equal(startA.status, 201, JSON.stringify(startA.data));
    pinPunch(startA.data.id, 2);
    const endA = await call('POST', '/api/workdays/' + startA.data.id + '/end', { notes: 'Poured 40 LF of curb.', next: NEXT_A });
    assert.equal(endA.status, 200, JSON.stringify(endA.data));
    assert.equal(endA.data.attached, false);
    assert.equal(endA.data.report.next, NEXT_A);
    const sentA = await call('PATCH', '/api/reports/' + endA.data.report.id, sendPayload(endA.data.report, NEXT_A));
    assert.equal(sentA.status, 200, JSON.stringify(sentA.data));
    assert.equal(sentA.data.next, NEXT_A);
    const startB = await call('POST', '/api/workdays/start', { projectId: 101, memberIds: [11] });
    assert.equal(startB.status, 201, JSON.stringify(startB.data));
    pinPunch(startB.data.id, 5);
    const endB = await call('POST', '/api/workdays/' + startB.data.id + '/end', { notes: 'Set the remaining curb.', next: NEXT_B });
    assert.equal(endB.status, 200, JSON.stringify(endB.data));
    assert.equal(endB.data.attached, true);
    assert.equal(endB.data.report.id, endA.data.report.id);
    assert.equal(endB.data.report.next, NEXT_B, 'the newest explicit next step wins when the second punch merges');
    assert.equal((endB.data.report.laborEntries || []).reduce((sum, row) => sum + (Number(row.minutes) || 0), 0), 7);
    const state = await call('GET', '/api/state');
    const clinic = state.data.reports.filter(report => report.projectId === 101 || state.data.projects[report.project]?.id === 101);
    assert.equal(clinic.length, 1);
    const shorter = await call('PATCH', '/api/reports/' + endB.data.report.id, sendPayload(endB.data.report, 'Call the office.'));
    assert.equal(shorter.status, 200, JSON.stringify(shorter.data));
    assert.equal(shorter.data.next, 'Call the office.', 'a shorter review edit replaces the stored next step');
    const emptied = await call('PATCH', '/api/reports/' + endB.data.report.id, sendPayload(endB.data.report, '   '));
    assert.equal(emptied.status, 200, JSON.stringify(emptied.data));
    assert.equal(emptied.data.next, 'Call the office.', 'an empty save keeps the stored next step');
    const newer = 'N' + NEXT_B.slice(1);
    const replaced = await call('PATCH', '/api/reports/' + endB.data.report.id, sendPayload(endB.data.report, newer));
    assert.equal(replaced.status, 200, JSON.stringify(replaced.data));
    assert.equal(replaced.data.next, newer, 'a later explicit next step wins');
    const cards = (await call('GET', '/api/time-cards')).data.filter(card => Number(card.reportId) === Number(endA.data.report.id));
    assert.equal(cards.length, 2);
    assert.ok(cards.every(card => card.status === 'submitted' && card.outAt), JSON.stringify(cards.map(card => card.status)));
    const gutterStart = await call('POST', '/api/workdays/start', { projectId: 102, memberIds: [12] });
    assert.equal(gutterStart.status, 201, JSON.stringify(gutterStart.data));
    pinPunch(gutterStart.data.id, 2);
    const gutterEnd = await call('POST', '/api/workdays/' + gutterStart.data.id + '/end', { notes: 'Set 20 LF of gutter.', next: NEXT_A });
    assert.equal(gutterEnd.data.attached, false);
    assert.equal(gutterEnd.data.report.next, NEXT_A, 'a first clock-out stores the next step');
    assert.equal(gutterEnd.data.timeCards[0].status, 'draft');
    const gutterSent = await call('PATCH', '/api/reports/' + gutterEnd.data.report.id, { ...sendPayload(gutterEnd.data.report, ''), productionEntries: [{ estimateItemId: 1, description: 'Gutter', quantity: 20, unit: 'LF', laborHours: sendPayload(gutterEnd.data.report, '').productionEntries[0].laborHours }] });
    assert.equal(gutterSent.status, 200, JSON.stringify(gutterSent.data));
    assert.equal(gutterSent.data.next, NEXT_A, 'a first send with an empty next step keeps the clock-out text');
    const gutterCards = (await call('GET', '/api/time-cards')).data.filter(card => Number(card.reportId) === Number(gutterEnd.data.report.id));
    assert.equal(gutterCards[0].status, 'submitted');
    const gutterAgain = await call('POST', '/api/workdays/start', { projectId: 102, memberIds: [12] });
    assert.equal(gutterAgain.status, 201, JSON.stringify(gutterAgain.data));
    pinPunch(gutterAgain.data.id, 5);
    const gutterMerge = await call('POST', '/api/workdays/' + gutterAgain.data.id + '/end', { notes: 'Finished the remaining gutter.', next: '' });
    assert.equal(gutterMerge.status, 200, JSON.stringify(gutterMerge.data));
    assert.equal(gutterMerge.data.attached, true);
    assert.equal(gutterMerge.data.report.id, gutterEnd.data.report.id);
    assert.equal(gutterMerge.data.report.next, NEXT_A, 'a second punch with no next step keeps the earlier text');
    const notedStart = await call('POST', '/api/workdays/start', { projectId: 102, memberIds: [11] });
    assert.equal(notedStart.status, 201, JSON.stringify(notedStart.data));
    pinPunch(notedStart.data.id, 2);
    const notedEnd = await call('POST', '/api/workdays/' + notedStart.data.id + '/end', { notes: 'Short check-in. Next: backfill curb.', next: '' });
    assert.equal(notedEnd.status, 200, JSON.stringify(notedEnd.data));
    assert.equal(notedEnd.data.attached, false);
    assert.equal(notedEnd.data.report.next, 'backfill curb.', 'a Next: clause in the clock-out notes sets the next step');
    const typedStart = await call('POST', '/api/workdays/start', { projectId: 102, memberIds: [11] });
    assert.equal(typedStart.status, 201, JSON.stringify(typedStart.data));
    pinPunch(typedStart.data.id, 2);
    const typedEnd = await call('POST', '/api/workdays/' + typedStart.data.id + '/end', { notes: 'Short check-in. Next: backfill curb.', next: 'Stage the pump.' });
    assert.equal(typedEnd.status, 200, JSON.stringify(typedEnd.data));
    assert.equal(typedEnd.data.attached, true);
    assert.equal(typedEnd.data.report.next, 'Stage the pump.', 'the dedicated next field wins over a Next: clause');
    const keepStart = await call('POST', '/api/workdays/start', { projectId: 102, memberIds: [11] });
    assert.equal(keepStart.status, 201, JSON.stringify(keepStart.data));
    pinPunch(keepStart.data.id, 2);
    const keepEnd = await call('POST', '/api/workdays/' + keepStart.data.id + '/end', { notes: 'Finished the remaining gutter.', next: '' });
    assert.equal(keepEnd.status, 200, JSON.stringify(keepEnd.data));
    assert.equal(keepEnd.data.report.next, 'Stage the pump.', 'notes without a next step keep the stored text');
    assert.match(keepEnd.data.report.notes, /Short check-in\. Next: backfill curb\./);
    assert.match(keepEnd.data.report.notes, /Finished the remaining gutter\./);
    assert.match(keepEnd.data.report.summary, /Finished the remaining gutter/);
    const again = await call('POST', '/api/workdays/start', { projectId: 102, memberIds: [11] });
    pinPunch(again.data.id, 1);
    const emptyNote = await call('POST', '/api/workdays/' + again.data.id + '/end', { notes: 'Finished the remaining gutter.', next: '   ' });
    assert.equal(emptyNote.data.attached, true);
    assert.equal(emptyNote.data.report.next, 'Stage the pump.');
    assert.equal(emptyNote.data.report.notes.match(/Finished the remaining gutter\./g).length, 1);
    const latest = emptyNote.data.report;
    const minutesOf = report => (report?.laborEntries || []).reduce((sum, row) => sum + (Number(row.minutes) || 0), 0);
    const staleBody = {
      status: 'Draft',
      notes: 'Stale note from the phone.',
      next: 'Stale next',
      laborEntries: [{ memberId: 11, hours: 0.02, minutes: 1 }],
      productionEntries: latest.productionEntries || [],
      updatedAt: notedEnd.data.report.updatedAt
    };
    const stale = await call('PATCH', '/api/reports/' + latest.id, staleBody);
    assert.equal(stale.status, 409, JSON.stringify(stale.data));
    assert.equal(stale.data.error, 'This daily was updated, reloading');
    assert.match(stale.data.report.notes, /Short check-in/);
    assert.match(stale.data.report.notes, /Finished the remaining gutter/);
    assert.equal(/Stale note|Stale next/.test(`${stale.data.report.notes}\n${stale.data.report.next}`), false);
    assert.equal(stale.data.report.next, 'Stage the pump.');
    assert.ok(minutesOf(stale.data.report) > 1, JSON.stringify(stale.data.report.laborEntries));
    const kept = (await call('GET', '/api/state')).data.reports.find(row => row.id === latest.id);
    assert.equal(kept.next, 'Stage the pump.');
    assert.match(kept.notes, /Finished the remaining gutter/);
    assert.equal(minutesOf(kept), minutesOf(stale.data.report));
    const allowed = await call('PATCH', '/api/reports/' + latest.id, {
      status: 'Draft',
      notes: stale.data.report.notes,
      next: 'Call after the conflict.',
      laborEntries: stale.data.report.laborEntries,
      productionEntries: stale.data.report.productionEntries,
      updatedAt: stale.data.report.updatedAt
    });
    assert.equal(allowed.status, 200, JSON.stringify(allowed.data));
    assert.equal(allowed.data.next, 'Call after the conflict.');
    assert.match(allowed.data.notes, /Finished the remaining gutter/);
    assert.equal(/Stale note/.test(allowed.data.notes), false);
    const omitted = await call('PATCH', '/api/reports/' + latest.id, {
      status: 'Draft',
      notes: allowed.data.notes,
      next: allowed.data.next,
      laborEntries: allowed.data.laborEntries,
      productionEntries: allowed.data.productionEntries
    });
    assert.equal(omitted.status, 200, JSON.stringify(omitted.data));
    assert.equal(omitted.data.next, 'Call after the conflict.');
    const beforeCount = (await call('GET', '/api/state')).data.reports.length;
    const posted = await call('POST', '/api/reports', {
      status: 'Draft',
      projectId: 102,
      dateIso: omitted.data.dateIso,
      foreman: omitted.data.foreman,
      notes: omitted.data.notes,
      next: 'Posted stale next',
      laborEntries: omitted.data.laborEntries,
      productionEntries: omitted.data.productionEntries,
      updatedAt: notedEnd.data.report.updatedAt
    });
    assert.equal(posted.status, 409, JSON.stringify(posted.data));
    assert.equal(posted.data.error, 'This daily was updated, reloading');
    assert.equal(posted.data.report.next, 'Call after the conflict.');
    assert.equal(/Posted stale next|Stale note/.test(`${posted.data.report.notes}\n${posted.data.report.next}`), false);
    assert.equal((await call('GET', '/api/state')).data.reports.length, beforeCount);
    console.log('Next-step merge checks passed.');
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
