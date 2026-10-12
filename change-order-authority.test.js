'use strict';
const assert = require('node:assert/strict'), crypto = require('node:crypto');
const authority = require('./change-order-authority'), guards = require('./roles-production-guards');
const { workspaceSnapshot } = require('./compat-workspace-fixture');
const { canonicalHash } = require('./database/transactional-repository');
const registry = require('./capability-registry');
const token = 'A'.repeat(32), url = new URL('/api/change-order/' + token, 'http://synthetic.invalid');
const decisionUrl = new URL(url + '/decision'), at = '2026-10-12T12:00:00.000Z';
let checks = 0;
const status = code => error => error.statusCode === code;
function seed() {
  const db = workspaceSnapshot();
  db.changes = [{ id: 77, projectId: 101, number: 'PC-077', title: 'Synthetic additional work', status: 'Submitted', amount: 120, lines: [{ description: 'Material', quantity: 2, unit: 'EA', laborHours: 1, materialCost: 120 }], history: [], customerTokenHash: crypto.createHash('sha256').update(token).digest('hex'), createdAt: at, createdBy: 'Synthetic office' }];
  db.auditLog = [];
  return db;
}
function decided(db, input) {
  const next = structuredClone(db), row = next.changes[0], decision = input.decision === 'approved' ? 'Approved' : 'Rejected';
  Object.assign(row, { status: decision, decidedAt: at, decidedBy: input.name, decisionNote: input.note || null, updatedAt: at });
  row.history.push({ action: `${decision} by customer signature (${input.name})${input.note ? ` — ${input.note}` : ''}`, by: input.name, at });
  next.auditLog.push({ id: crypto.randomUUID(), type: 'project_change_decided', projectId: row.projectId, changeId: row.id, actor: input.name, detail: `${row.number} ${decision.toLowerCase()} via change order link`, at });
  return next;
}
function setPolicy(db, role, flags) {
  const daily = registry.families.find(row => row[0] === 'daily');
  db.company.dailyPolicyRequired = true;
  db.company.dailyRolePolicy = { version: 1, revision: 1, roles: Object.fromEntries(daily[4].roles.map(role => [role, daily[4].ceiling(role)])) };
  Object.assign(db.company.dailyRolePolicy.roles[role], flags);
}
async function main() {
  let db = seed(), binding = authority.resolve(db, url);
  assert.deepEqual(Object.keys(binding).sort(), ['changeId', 'companyId', 'projectId', 'tokenHash']);
  assert.equal(authority.resolve(db, new URL('/api/state', url)), null);
  assert.throws(() => authority.resolve(db, new URL(url + 'x')), status(404));
  assert.throws(() => authority.resolve(db, new URL(url + '?projectId=102')), status(400)); checks += 4;
  for (const alter of [row => { row.company.id = '22222222-2222-4222-8222-222222222222'; }, row => { row.changes[0].customerTokenHash = 'b'.repeat(64); }, row => { row.changes[0].id = 78; }, row => { row.projects.push({ id: 102 }); row.changes[0].projectId = 102; }]) {
    const next = structuredClone(db); alter(next); assert.throws(() => authority.assertSame(next, url, binding)); checks++;
  }
  const duplicate = structuredClone(db); duplicate.changes.push({ ...duplicate.changes[0], id: 78 });
  assert.throws(() => authority.resolve(duplicate, url), status(409));
  const expired = structuredClone(db); expired.changes[0].customerTokenExpiresAt = '2000-01-01T00:00:00.000Z';
  assert.throws(() => authority.resolve(expired, url), status(404)); checks += 2;
  for (const value of [{ decision: 'Rejected', name: 'Synthetic Customer' }, { decision: 'approved', name: ' ' }, { decision: 'approved', name: 'x'.repeat(121) }, { decision: 'approved', name: 'Synthetic', note: 'x'.repeat(501) }, { decision: 'approved', name: 'Synthetic', projectId: 102 }]) { assert.throws(() => authority.parseDecision(value), status(400)); checks++; }
  const input = authority.parseDecision({ decision: 'approved', name: ' Synthetic Customer ', note: ' Synthetic accepted ' }), next = decided(db, input);
  authority.validateDelta(db, next, decisionUrl, input, binding); checks++;
  for (const alter of [row => { row.projects[0].name = 'Other write'; }, row => { row.changes[0].amount = 999; }, row => { row.changes[0].history[0].by = 'Other signer'; }, row => { row.auditLog[0].projectId = 102; }, row => { row.users[0].role = 'admin'; }, row => { row.auditLog.push({ ...row.auditLog[0], id: crypto.randomUUID() }); }]) { const poisoned = structuredClone(next); alter(poisoned); assert.throws(() => authority.validateDelta(db, poisoned, decisionUrl, input, binding), status(409)); checks++; }
  authority.validateDelta(next, structuredClone(next), decisionUrl, { decision: 'declined', name: 'Another signer' }, binding);
  assert.throws(() => authority.validateDelta(next, db, decisionUrl, input, binding), status(409));
  assert.throws(() => authority.validateDelta(db, next, url, {}, binding), status(409)); checks += 3;
  db.changes[0].privateProof = 'PRIVATE-CUSTODY'; db.changes[0].lines[0].providerPayload = 'PRIVATE-PROVIDER';
  const doc = authority.document(db, binding);
  assert.equal(doc.amount, 120); assert.equal(doc.lines[0].materialCost, 120);
  assert.ok(!JSON.stringify(doc).includes('PRIVATE') && !JSON.stringify(doc).includes('customerTokenHash')); checks += 3;
  db.photos = [{ id: 9, project: 0, changeId: 77, url: `/api/files/project-photos/${db.company.id}/synthetic.png`, storageBucket: 'project-photos', storageKey: `${db.company.id}/synthetic.png` }];
  const photoUrl = new URL(url + '/photos/9'); assert.equal(authority.photo(db, photoUrl, binding).id, 9); checks++;
  const alias = { ...db.photos[0], id: 10, changeId: 88 }; db.photos.push(alias);
  assert.throws(() => authority.photo(db, photoUrl, binding), status(404)); db.photos.pop(); checks++;
  db.projectPlans = [{ id: 1, projectId: 101, url: db.photos[0].url }]; assert.throws(() => authority.photo(db, photoUrl, binding), status(404)); checks++;
  db = seed(); const pm = { id: 4, companyId: db.company.id, role: 'project_manager', status: 'Active', projectIds: [101], assignedCrews: ['Synthetic Crew'], permissions: { viewDailies: true } };
  await assert.rejects(guards.guard({ method: 'POST', auth: { user: pm } }, new URL('/api/changes/77/submit', url), db, { canViewPricing: () => false }), status(403)); checks++;
  setPolicy(db, 'project_manager', {}); db.changes.push({ ...db.changes[0], id: 78, reportId: db.reports[0].id, amount: 999 });
  const summaries = guards.changeSummaries(db, pm, { canViewPricing: () => false });
  assert.deepEqual(summaries, [{ projectId: 101, awaitingDecision: 1, openItems: 1, approvedCount: 0, openExposure: null, approvedTotal: null }]);
  const original = canonicalHash(summaries); db.reports[0] = { ...db.reports[0], laborEntries: [{ memberId: db.team[0].id, hours: 1 }] };
  assert.equal(canonicalHash(guards.changeSummaries(db, pm, { canViewPricing: () => false })), original, 'A recycled numeric report ID cannot reveal the retained derived change'); checks += 2;
  assert.deepEqual(guards.changeSummaries(db, db.users.find(row => row.role === 'field'), { canViewPricing: () => false }), [], 'State summaries cannot introduce commercial facts into the field workspace'); checks++;
  const daily = require('./daily-admission');
  assert.equal(daily.parse({ action: 'endWorkday', id: 1, details: { notes: 'Synthetic notes', next: '', language: 'es-MX' } }).details.language, 'es-MX');
  assert.throws(() => daily.parse({ action: 'endWorkday', id: 1, details: { notes: 'Synthetic notes', language: 'x'.repeat(2000) } }), status(400)); checks += 2;
  console.log(JSON.stringify({ passed: true, checks, syntheticOnly: true, externalCalls: 0 }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
