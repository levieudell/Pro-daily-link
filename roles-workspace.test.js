'use strict';
const assert = require('node:assert/strict'), registry = require('./capability-registry'), { currentRows, proposalErrors, labels } = require('./roles-workspace');
const { workspace } = require('./fixtures/roles-workspace');
const defaults = Object.fromEntries(registry.families.map(([id, , , , module]) => [id, Object.fromEntries(module.roles.map(role => [role, module.ceiling(role)]))]));
const state = { defaults, states: registry.policyState(workspace()), policies: {} };
assert.deepEqual(currentRows(state), defaults); assert.deepEqual(proposalErrors(defaults), []);
state.states.notes.state = 'required-missing'; assert.ok(Object.values(currentRows(state).notes).every(row => Object.values(row).every(flag => !flag)));
state.states.notes.state = 'valid'; state.policies.notes = { roles: structuredClone(defaults.notes) }; state.policies.notes.roles.field.create = false;
assert.equal(currentRows(state).notes.field.create, false); assert.equal(defaults.notes.field.create, true);
for (const [family, , , , module] of registry.families) for (const action of module.actions) for (const role of registry.roles) {
  const rows = structuredClone(defaults); rows[family][role][action] = false;
  let accepted = true; try { module.validatePolicy({ version: 1, revision: 1, roles: rows[family] }); } catch { accepted = false; }
  assert.equal(proposalErrors(rows).length === 0, accepted, family + ':' + role + ':' + action);
}
assert.match(labels.viewRequests, /existing scope/);
console.log('Roles view model passed: unchanged defaults, real invalid-policy denial, isolated current/proposed limits and validation matching every supported typed policy dependency.');
