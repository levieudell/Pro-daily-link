'use strict';
const assert = require('node:assert/strict'), crypto = require('node:crypto');
const { workspace } = require('./fixtures/roles-workspace'), { companyA, companyB, token } = require('./fixtures/project-assistant');
const registry = require('./capability-registry');
module.exports = async function ({ repository, change, request, bases, checkpoint, waitFor, controls, providerEvents }) {
  const load = () => repository.load(companyA), saved = structuredClone((await load()).snapshot), foreign = await repository.load(companyB), providers = providerEvents.length;
  const reset = async value => change(db => { for (const key of Object.keys(db)) delete db[key]; Object.assign(db, structuredClone(value)); });
  const clean = workspace();
  for (const [id, role] of [[8, 'crew'], [9, 'platform_owner']]) {
    clean.users.push({ id, companyId: companyA, name: 'Synthetic excluded role', email: role + '@example.invalid', role, status: 'Active' });
    clean.sessions.push({ userId: id, companyId: companyA, tokenHash: crypto.createHash('sha256').update(token(companyA, id)).digest('hex'), expiresAt: '2099-01-01T00:00:00Z' });
  }
  const call = async (user = 1, expected = 200, route = '/api/navigation') => { const result = await request(bases[0], 'GET', route, undefined, user); assert.equal(result.status, expected, route + ': ' + JSON.stringify(result.data)); return result.data; };
  try {
    await reset(clean); let before = await load();
    const config = await fetch(bases[0] + '/api/config').then(row => row.json()); assert.deepEqual(config, { authRequired: true, scopedWorkspace: true });
    const owner = await call(), manager = await call(2), field = await call(4), foreman = await call(5);
    assert.deepEqual(manager.projects.map(row => row.id), [101]); assert.deepEqual(manager.team.map(row => row.id), [11]); assert.deepEqual(manager.customers.map(row => row.id), [1]);
    assert.deepEqual(field.customers, []); assert.deepEqual(foreman.customers, []); assert.deepEqual(field.projects.map(row => row.id), [101, 102]);
    assert.ok(!JSON.stringify(owner).includes('PRIVATE-')); assert.equal(owner.settings.roles, true); assert.equal((await call(7)).settings.roles, false);
    assert.equal(owner.sessionBinding, (await call()).sessionBinding); assert.notEqual(owner.sessionBinding, (await call(7)).sessionBinding); assert.deepEqual(await load(), before, 'Navigation never renews session or commits');
    for (const user of [8, 9]) await call(user, 403);
    await call(1, 503, '/api/state'); assert.equal((await request(bases[0], 'GET', '/api/navigation', undefined, 1, companyB)).status, 401);
    const foreignRead = await request(bases[1], 'GET', '/api/navigation', undefined, 1, companyB, companyB); assert.equal(foreignRead.status, 200); assert.equal(foreignRead.data.company.id, companyB); assert.deepEqual(await repository.load(companyB), foreign);
    for (const file of ['workspace.html', 'roles-workspace.js', 'roles-workspace.css']) assert.equal((await fetch(bases[0] + '/' + file)).status, 200);
    for (const file of ['scoped-navigation.js', 'role-policy-api.js', 'database/role-policy-commit.sql']) assert.equal((await fetch(bases[0] + '/' + file)).status, 404);
    await change(db => { db.company.notesRolePolicy = { version: 1, revision: 1, roles: Object.fromEntries(registry.roles.map(role => [role, require('./notes-access').ceiling(role)])) }; }); assert.deepEqual((await call(4)).projects.map(row => row.id), [101]);
    await reset(clean); await change(db => { db.projects[0].customerId = '1'; }); assert.deepEqual((await call(2)).customers, []);
    await reset(clean); await change(db => { for (const [, , prefix, , module] of registry.families) db.company[prefix + 'RolePolicy'] = { version: 1, revision: 1, roles: Object.fromEntries(registry.roles.map(role => [role, Object.fromEntries(module.actions.map(action => [action, false]))])) }; });
    const restricted = await call(2); assert.deepEqual(restricted.projects, []); assert.deepEqual(restricted.team, []); assert.deepEqual(restricted.customers, []);
    const admin = await call(7); assert.equal(admin.projects.length, 2); assert.ok(admin.projects.every(row => Object.values(row.views).every(flag => !flag))); assert.equal(admin.immutableMetadataDirectory, true);
    for (const mutate of [db => { db.customers = false; }, db => { db.customers[0].name = { secret: 'PRIVATE-OBJECT' }; }, db => { db.projects[0].companyId = companyB; }, db => { db.team.unshift({ id: '011', name: 'PRIVATE-ALIAS', crew: 'A' }); }, db => { db.assignments[0].memberIds = [[11]]; }, db => { db.reports[0].project = [1]; }]) {
      await reset(clean); await change(mutate); before = await load(); const denied = await call(1, 409); assert.ok(!JSON.stringify(denied).includes('PRIVATE-')); assert.deepEqual(await load(), before);
    }
    await reset(clean); await change(db => { db.company = { ...db.company, demo: false, billingExempt: false, subscriptionStatus: 'Past due' }; }); before = await load(); await call(1, 402); assert.deepEqual(await load(), before);
    for (const mutate of [db => { db.users[1].role = 'field'; db.users[1].memberId = 11; }, db => { db.users[1].status = 'Deactivated'; }, db => { db.company.notesRolePolicy = false; }]) {
      await reset(clean); controls.readGate = checkpoint(); const delayed = request(bases[0], 'GET', '/api/navigation', undefined, 2);
      await waitFor(() => controls.readGate.count === 3); await change(mutate); before = await load(); controls.readGate.resolve(); controls.readGate = null;
      assert.equal((await delayed).status, 409); assert.deepEqual(await load(), before);
    }
    await reset(clean); const expires = Date.now() + 2000; await change(db => { db.sessions.find(row => row.userId === 2).expiresAt = new Date(expires).toISOString(); });
    controls.readGate = checkpoint(); const delayed = request(bases[0], 'GET', '/api/navigation', undefined, 2); await waitFor(() => controls.readGate.count === 3); await waitFor(() => Date.now() > expires); controls.readGate.resolve(); controls.readGate = null; assert.equal((await delayed).status, 401);
    assert.equal(providerEvents.length, providers); assert.deepEqual(await repository.load(companyB), foreign);
    console.log('Navigation PostgreSQL passed: public mode/finite assets, non-renewing read-only projection, strict PM customers, name-only notes activation shrink, actual mixed-crew views, unsupported roles/raw state, malformed/foreign/locked data, and delayed role/policy/session revocation.');
  } finally { controls.readGate?.resolve(); controls.readGate = null; await reset(saved); }
};
