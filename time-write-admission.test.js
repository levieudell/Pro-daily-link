'use strict';
const assert = require('node:assert/strict');
const { fixture } = require('./fixtures/project-assistant');
const access = require('./time-write-access');
const admission = require('./time-write-admission');
const { supportedRoute } = require('./database/tenant-atomic-routes');
const db = fixture(); db.company.features.timeCards = true;
const pm = db.users.find(row => row.id === 2); pm.permissions.manageTime = true;
const policy = () => ({ version: 1, revision: 1, roles: Object.fromEntries(access.roles.map(role => [role, access.ceiling(role)])) });
assert.equal(access.actor(db, pm, false), pm, 'Default inactive draft preserves the original actor');
for (const role of ['owner', ...access.roles]) {
  const user = { role, permissions: { manageTime: true, viewTime: true } }, result = access.access(db, user);
  assert.equal(result.captureExports, ['owner', 'admin'].includes(role));
  assert.equal(result.createCards, ['owner', 'admin', 'project_manager'].includes(role));
  assert.equal(result.clockCards, ['field', 'foreman'].includes(role));
}
for (const role of ['crew', 'platform_owner', 'unknown']) assert.ok(Object.values(access.access(db, { role, permissions: { manageTime: true } })).every(value => value === false));
for (const malformed of [null, { ...policy(), roles: { ...policy().roles, owner: access.ceiling('owner') } }, { ...policy(), roles: { ...policy().roles, field: { ...access.ceiling('field'), createCards: true } } }, { ...policy(), roles: { ...policy().roles, project_manager: { ...access.ceiling('project_manager'), captureExports: true } } }, { ...policy(), roles: { ...policy().roles, admin: { ...access.ceiling('admin'), aiAssistant: true } } }]) {
  db.company.timeWritePolicyRequired = true; db.company.timeWriteRolePolicy = malformed;
  assert.ok(Object.values(access.access(db, pm)).every(value => !value));
  assert.equal(access.access(db, db.users[0]).captureExports, true);
  assert.equal(access.actor(db, pm, false), null);
}
delete db.company.timeWritePolicyRequired; delete db.company.timeWriteRolePolicy;
for (const input of [{ action: 'approve', details: {} }, { action: 'create', details: { memberId: true } }, { action: 'correct', id: 501, details: { inAt: 123, reason: 'why' } }, { action: 'correct', id: 501, details: { breaks: [{ type: 'paid_rest', missed: 'yes' }] } }, { action: 'submit', id: 501, details: { approved: true } }, { action: 'create', details: {}, permissions: {} }]) assert.throws(() => admission.parse(input, 'cards'), { statusCode: 400 });
assert.throws(() => admission.parse({ action: 'captureExport', id: 'a'.repeat(36), details: { reason: {} } }, 'payroll'), { statusCode: 400 });
const operation = admission.parse({ action: 'correct', id: 501, details: { reason: 'Synthetic correction' } }, 'cards');
db.timeCards = [{ id: 501, memberId: 11, projectId: 101, hours: 1, history: [] }, { id: 502, memberId: 13, projectId: 102, hours: 1, history: [] }];
const after = structuredClone(db); after.timeCards[0].hours = 2;
admission.validateDelta(db, after, pm, operation);
after.timeCards[1].reportId = 88;
assert.throws(() => admission.validateDelta(db, after, pm, operation), { statusCode: 409 }, 'Legacy unrelated relinking cannot be admitted');
after.timeCards[1] = structuredClone(db.timeCards[1]); after.company.billingKey = 'unsupported';
assert.throws(() => admission.validateDelta(db, after, pm, operation), { statusCode: 409 });
assert.throws(() => admission.authorize(db, pm, admission.parse({ action: 'create', details: { memberId: 13, projectId: 101 } }, 'cards'), () => []), { statusCode: 403 });
db.timeCards.push({ ...db.timeCards[0], id: ' 501 ', memberId: 13, projectId: 102 });
assert.throws(() => admission.authorize(db, pm, operation, () => []), { statusCode: 409 });
for (const path of ['/api/time-cards/action-preview', '/api/time-cards/company-clock', '/api/pay-periods/action-preview']) assert.equal(supportedRoute('POST', path), true);
for (const path of ['/api/company-activities', '/api/workdays/start', '/api/company/roles', '/api/billing/checkout']) assert.equal(supportedRoute('POST', path), false);
console.log('Time writers: exact ceilings, fail-closed typed policy, immutable owner/assistant boundaries, closed inputs, compound delta and global duplicate-ID guards passed.');
