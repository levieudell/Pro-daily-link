const assert = require('node:assert/strict');
const { buildTenantSnapshot, validateSnapshot } = require('./database/migrate-json');
const source = require('./data/db.json');

const snapshot = buildTenantSnapshot(source);
validateSnapshot(snapshot);

assert.match(snapshot.company.id, /^[0-9a-f-]{36}$/, 'company must receive a stable UUID');
assert.ok(snapshot.users.every(row => !('company_id' in row)), 'users are global identities');
assert.ok(snapshot.memberships.every(row => row.company_id === snapshot.company.id), 'memberships must carry tenant access');
for (const key of ['customers', 'projects', 'team_members', 'subcontractors', 'reports', 'assignments', 'photos', 'workdays', 'changes']) {
  assert.ok(snapshot[key].every(row => row.company_id === snapshot.company.id), `${key} must be tenant scoped`);
}

console.log('Northstar tenant migration test passed');
