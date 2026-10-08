'use strict';
const assert = require('node:assert/strict'), actions = require('./workspace-actions'), time = require('./time-write-admission'), daily = require('./daily-admission'), leave = require('./time-off-admission'), review = require('./time-review-admission');
const { workspace } = require('./fixtures/roles-workspace'), registry = require('./capability-registry');
const nav = { actor: { effectiveCapabilities: registry.effective(workspace(), workspace().users[0]), immutableAccess: registry.immutable(workspace(), workspace().users[0]) } };
const values = { projectId: '101', memberId: '11', memberIds: ['11'], date: '2026-01-05', start: '08:00', end: '16:00', activity: 'Reviewed scope', text: 'Reviewed → café 👷', kind: 'todo', dueDate: '2026-01-06', startDate: '2026-01-05', endDate: '2026-01-05', allDay: true, type: 'vacation', note: 'Private', inAt: '2026-01-05T08:00:00Z', outAt: '2026-01-05T16:00:00Z', reason: 'Reviewed', dateIso: '2026-01-05', laborHours: '8', notes: 'Installed scope', label: 'Reviewed period', from: '2026-01-05', to: '2026-01-11' };
for (const [name, definition] of Object.entries(actions.definitions)) {
  const row = { id: definition[1] === 'payroll' ? '00000000-0000-4000-8000-000000000001' : name.startsWith('note') ? 'note-one' : 501, revision: 1, kind: 'todo', text: values.text };
  const built = actions.build(name, { ...values, activityCodeId: 'synthetic-office', accessRole: 'field', file: { type: 'image/png', bytes: 1, sha256: 'a'.repeat(64), lastModified: 1 }, status: 'Needs review', laborEntries: [{ memberId: 11, hours: 8 }], productionEntries: [{ estimateItemId: null, description: 'Pending measured scope', quantity: null, unit: 'SF', laborHours: 8, custom: true }] }, { ...row, projectId: 101 }, 101, 'reviewed-request-123');
  assert.equal(built.method, definition[4]); assert.ok(built.path.startsWith('/api/'));
  if (built.serverPreview && definition[6]) { const operation = ['dailies', 'workdays'].includes(definition[1]) ? daily.parse(built.previewBody) : time.parse(built.previewBody, definition[1] === 'payroll' ? 'payroll' : 'cards'); assert.equal(operation.path, built.path); assert.equal(operation.method, built.method); }
  if (name.startsWith('leave') && built.serverPreview) review.parsePreview(built.previewBody, 'leave', row.id);
  if (['cardApprove', 'cardUnapprove'].includes(name)) review.parsePreview(built.previewBody, 'cards');
  if (name === 'photoUpload') require('./photo-admission').parse(built.previewBody);
}
assert.equal(actions.allowed(nav, 'reportExport'), true); nav.actor.immutableAccess.ownerManagement = false; assert.equal(actions.allowed(nav, 'reportExport'), false);
assert.ok(leave.parse(actions.build('leaveCreate', values, {}, null, 'reviewed-request-123').body));
assert.throws(() => actions.build('grantOwner', values));
assert.equal(actions.allowed(nav, 'cardApprove'), true);
nav.actor.effectiveCapabilities.timeReview.approveCards = false; assert.equal(actions.allowed(nav, 'cardApprove'), false);
assert.equal(actions.build('noteComplete', values, { id: 'item-one', revision: 3, text: values.text, completed: false }, 101).body.completed, true);
assert.deepEqual(actions.build('noteComplete', values, { id: 'item-one', revision: 3, text: values.text, completed: false }, 101).body, {revision:3,completed:true});
console.log('Operational action contracts: every reviewed payload matches its actual closed server parser/path/method, literal Unicode, own leave, completion revisions and effective permission reductions passed.');
