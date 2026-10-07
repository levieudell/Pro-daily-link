'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const model = require('./role-policy-prototype');
const draft = () => model.emptyDraft('synthetic_company');
const actor = (role = 'project_manager') => ({ id: 3, companyId: 'synthetic_company', role, projectIds: [101], assignedCrews: ['Crew A'], permissions: {} });
const copy = value => JSON.parse(JSON.stringify(value));
const baseline = ['schedule.view', 'schedule.create', 'dailies.view', 'dailies.approve', 'time.view'];
assert.strictEqual(model.modelOperations(undefined, actor(), baseline), baseline, 'missing policy is exact passthrough');
assert.strictEqual(model.modelOperations({ malicious: true }, actor('owner'), baseline), baseline, 'owner admission stays outside policy');
for (const role of model.BUILT_IN_ROLES) {
  const all = model.OPERATIONS.filter(row => row.roles.includes(role)).map(row => row.id), account = actor(role), before = copy(account);
  for (const operation of all) {
    const policy = draft(); policy.builtInRoles[role].deniedOperations = [operation];
    for (const existing of [all, all.filter(id => !id.endsWith('.approve')), [], [operation]]) {
      const after = model.modelOperations(policy, account, existing);
      assert(after.every(id => existing.includes(id)), 'caps cannot grant'); assert(!after.includes(operation));
      assert.deepEqual(account, before, 'role, existing grants and scopes remain untouched');
    }
  }
}
const policy = draft();
policy.customRoles.push({ id: 'custom_daily_reviewer', name: 'Daily reviewer', baseRole: 'project_manager', allowedOperations: ['dailies.view', 'dailies.approve'] });
const customActor = { ...actor(), customRoleId: 'custom_daily_reviewer' };
assert.deepEqual(model.modelOperations(policy, customActor, baseline), ['dailies.view', 'dailies.approve']);
assert.deepEqual(model.modelOperations(policy, customActor, ['dailies.view']), ['dailies.view'], 'custom role cannot add a raw grant');
policy.builtInRoles.project_manager.deniedOperations = ['dailies.view'];
assert.deepEqual(model.modelOperations(policy, customActor, baseline), [], 'custom role inherits built-in restriction and view prerequisite');
assert.deepEqual(model.modelOperations(policy, { ...customActor, role: 'field' }, baseline), [], 'custom baseline cannot reclassify actor');
assert.deepEqual(model.modelOperations(policy, { ...customActor, companyId: 'other_company' }, baseline), [], 'tenant mismatch');
assert.deepEqual(model.modelOperations(policy, { ...customActor, customRoleId: 'custom_deleted' }, baseline), [], 'deleted role fails closed');
for (const mutate of [
  p => { p.schemaVersion = 99; }, p => { p.revision = -1; }, p => { p.builtInRoles.owner = { deniedOperations: [] }; },
  p => { p.builtInRoles.admin.deniedOperations.push('billing.manage'); }, p => { p.builtInRoles.field.deniedOperations.push('dailies.approve'); },
  p => { p.customRoles = [{ id: 'custom_assistant', name: 'Assistant', baseRole: 'field', allowedOperations: ['assistant.use'] }]; },
  p => { p.customRoles = [{ id: 'custom_owner', name: 'Owner', baseRole: 'admin', allowedOperations: [] }]; },
  p => { p.customRoles = [{ id: 'custom_owner', name: 'New owner', baseRole: 'owner', allowedOperations: [] }]; },
  p => { p.customRoles = [{ id: 'custom_bad', name: '<script>', baseRole: 'admin', allowedOperations: [] }]; },
  p => { p.customRoles = [{ id: 'custom_bad', name: 'Approver', baseRole: 'field', allowedOperations: ['dailies.view', 'dailies.approve'] }]; },
  p => { p.customRoles = [{ id: 'custom_bad', name: 'Approver', baseRole: 'admin', allowedOperations: ['dailies.approve'] }]; },
  p => { p.customRoles = [{ id: 'custom_bad', name: 'Reviewer', baseRole: 'admin', allowedOperations: [], projectIds: [999] }]; },
  p => { p.customRoles = [{ id: 'custom_bad', name: 'Reviewer', baseRole: 'admin', allowedOperations: [] }, { id: 'custom_bad', name: 'Other', baseRole: 'admin', allowedOperations: [] }]; }
]) {
  const malicious = draft(); mutate(malicious); assert.throws(() => model.validateDraft(malicious));
  assert.deepEqual(model.modelOperations(malicious, actor(), baseline), [], 'invalid policy fails closed in model');
}
const previous = draft(), proposed = draft(); proposed.revision = 1;
assert.equal(model.validateRevision(previous, proposed, 0).revision, 1);
assert.throws(() => model.validateRevision(previous, proposed, 1));
assert.throws(() => model.validateRevision(proposed, proposed, 1), /Stale/);
const changedTenant = copy(proposed); changedTenant.companyId = 'other_company';
assert.throws(() => model.validateRevision(previous, changedTenant, 0));
const customBefore = copy(policy), changedBase = copy(policy); customBefore.revision = 1; changedBase.revision = 2; changedBase.customRoles[0].baseRole = 'admin';
assert.throws(() => model.validateRevision(customBefore, changedBase, 1), /protected baseline/);
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
assert(!server.includes('role-policy-prototype'), 'standalone model must not claim runtime enforcement');
console.log('Standalone full-role policy model: supported operations, no escalation, named restricted baselines, immutable owner/tenant/scopes and revision validation passed');
