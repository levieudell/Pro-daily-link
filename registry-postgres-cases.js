'use strict';
const assert = require('node:assert/strict'), crypto = require('node:crypto');
const { companyA, companyB } = require('./fixtures/project-assistant');
const registry = require('./capability-registry');
module.exports = async function ({ repository, change, request, bases, checkpoint, waitFor, controls, providerEvents }) {
  const load = () => repository.load(companyA), foreign = await repository.load(companyB), providers = providerEvents.length;
  const endpoint = '/api/company/role-capabilities', policy = module => ({ version: 1, revision: 1, roles: Object.fromEntries(module.roles.map(role => [role, module.ceiling(role)])) });
  const call = async (route, user = 1, expected = 200, method = 'GET', input) => { const result = await request(bases[0], method, route, input, user); assert.equal(result.status, expected, route + ': ' + JSON.stringify(result.data)); return result; };
  await change(db => {
    for (const [, , prefix] of registry.families) { delete db.company[prefix + 'RolePolicy']; delete db.company[prefix + 'PolicyRequired']; }
    db.company.features.timeCards = true;
    for (const user of db.users) { delete user.notesCustomRoleId; delete user.notesPolicyRequired; }
    Object.assign(db.users.find(row => row.id === 2), { role: 'project_manager', status: 'Active', projectIds: [101], assignedCrews: ['A'], permissions: { scheduleCrews: true, viewTime: true, manageTime: true, viewDailies: true, approveDailies: true } });
    db.users.find(row => row.id === 5).role = 'foreman';
    db.users.find(row => row.id === 3).status = 'Deactivated';
    for (const user of db.users) { user.resetTokenHash = 'Private account sentinel'; user.privateAuthorization = { tokenHash: 'Private account sentinel' }; user.preferences = { theme: 'light', private: { tokenHash: 'Private account sentinel' } }; }
  });
  let before = await load(); const metadata = await call(endpoint); assert.equal(metadata.data.domains.reduce((sum, row) => sum + row.actions.length, 0), 32); assert.equal(metadata.data.policyEditingAvailable, true); assert.equal(metadata.data.ownerImmutable, true); assert.deepEqual(await load(), before);
  const directory = await call('/api/users'); assert.ok(!JSON.stringify(directory.data).includes('Private account sentinel')); assert.ok(directory.data.every(row => !Object.hasOwn(row, 'preferences'))); assert.ok(Object.values(directory.data.find(row => row.id === 3).effectiveCapabilities).every(row => Object.values(row).every(value => !value))); assert.deepEqual(await load(), before);
  for (const user of [2, 4, 5, 7, 8, 9]) { await call(endpoint, user, 403); await call('/api/users', user, 403); }
  const foreman = await call('/api/auth/me', 5); assert.equal(foreman.data.role, 'field'); assert.equal(foreman.data.accessRole, 'foreman'); assert.equal(foreman.data.immutableAccess.assistantEligible, false); assert.equal(foreman.data.timeReviewAccess.viewCards, true);
  const foreignDirectory = await request(bases[1], 'GET', '/api/users', undefined, 1, companyB, companyB); assert.equal(foreignDirectory.status, 200); assert.equal(foreignDirectory.data[0].companyId, companyB); assert.equal(foreignDirectory.data[0].immutableAccess.assistantEligible, false); assert.deepEqual(await repository.load(companyB), foreign);
  // Session renewal changes only session expiry in the same tenant CAS.
  before = await load(); const me = await call('/api/auth/me', 2), after = await load(); assert.equal(after.revision, before.revision + 1); const oldBusiness = structuredClone(before.snapshot), newBusiness = structuredClone(after.snapshot); delete oldBusiness.sessions; delete newBusiness.sessions; assert.deepEqual(newBusiness, oldBusiness); assert.equal(me.data.permissions.scheduleCrews, true); assert.equal(me.data.effectiveCapabilities.scheduling.create, true);
  for (const [id, , prefix, , module] of registry.families) {
    await change(db => { const row = policy(module); row.roles.project_manager = Object.fromEntries(module.actions.map(action => [action, false])); db.company[prefix + 'RolePolicy'] = row; });
    const projected = await call('/api/auth/me', 2); assert.ok(Object.values(projected.data.effectiveCapabilities[id]).every(value => !value)); assert.equal(projected.data.permissions.manageTime, true); assert.equal(projected.data.permissions.scheduleCrews, true);
    const listed = (await call('/api/users')).data.find(row => row.id === 2); assert.equal(listed.permissions.manageTime, true); assert.ok(Object.values(listed.effectiveCapabilities[id]).every(value => !value));
    for (const value of [false, 0, '', null]) { await change(db => { db.company[prefix + 'RolePolicy'] = value; }); const malformed = await call('/api/auth/me', 2); assert.equal(malformed.data.capabilityPolicyState[id].state, 'invalid'); assert.ok(Object.values(malformed.data.effectiveCapabilities[id]).every(value => !value)); }
    await change(db => { delete db.company[prefix + 'RolePolicy']; });
  }
  // Active office alias uses admin internally; inactive permissions remain nonactionable.
  await change(db => { db.users.find(row => row.id === 7).role = 'office'; }); assert.equal((await call('/api/auth/me', 7)).data.accessRole, 'admin'); await change(db => { db.users.find(row => row.id === 7).role = 'admin'; });
  await call('/api/auth/me', 3, 401);
  const intact = structuredClone((await load()).snapshot);
  for (const corrupt of [db => { db.users.unshift({ ...db.users.find(row => row.id === 2), id: '02' }); }, db => { db.users.find(row => row.id === 2).name = { passwordHash: 'Private nested sentinel' }; }, db => { db.users.find(row => row.id === 2).projectIds = [{ tokenHash: 'Private nested sentinel' }]; }, db => { db.users.find(row => row.id === 2).preferences.theme = { tokenHash: 'Private nested sentinel' }; }]) {
    await change(corrupt); before = await load(); const denied = await call('/api/auth/me', 2, 409); assert.ok(!JSON.stringify(denied.data).includes('Private nested sentinel')); assert.deepEqual(await load(), before); await change(db => { Object.assign(db, structuredClone(intact)); });
  }
  await change(db => { const session = db.sessions.find(row => row.userId === 2); db.sessions.push({ ...session, id: crypto.randomUUID(), companyId: companyB }); }); before = await load(); await call('/api/auth/me', 2, 409); assert.deepEqual(await load(), before); await change(db => { Object.assign(db, structuredClone(intact)); });
  // Shared auth rejects crew/project aliases before ordinary business reads, not just DTOs.
  for (const [collection, id, user] of [['team', '011', 5], ['team', '013', 2], ['projects', '0101', 2]]) {
    await change(db => { db[collection].unshift({ ...db[collection][0], id }); }); before = await load();
    await call('/api/time-cards', user, 409); await call('/api/projects/101/assistant/context', user, 409); assert.deepEqual(await load(), before); await change(db => { Object.assign(db, structuredClone(intact)); });
  }
  for (const mutate of [user => { user.projectIds = [[101]]; }, user => { user.assignedCrews = [['A']]; }, user => { user.memberId = [11]; }, user => { user.name = { private: 'Private authority sentinel' }; }, user => { user.permissions.viewTime = 'true'; }]) {
    await change(db => { mutate(db.users.find(row => row.id === 2)); }); before = await load(); await call('/api/time-cards', 2, 409); await call('/api/projects/101/notes-todos', 2, 409); await call('/api/projects/101/assistant/context', 2, 409); assert.deepEqual(await load(), before); await change(db => { Object.assign(db, structuredClone(intact)); });
  }
  await change(db => { db.users.find(row => row.id === 2).preferences.theme = { private: 'Private preference sentinel' }; }); await call('/api/time-cards', 2); before = await load(); await call('/api/auth/me', 2, 409); assert.deepEqual(await load(), before); await change(db => { Object.assign(db, structuredClone(intact)); });
  for (const value of [['A'], { private: 'Private crew sentinel' }]) { await change(db => { db.team.find(row => row.id === 13).crew = value; }); before = await load(); await call('/api/time-cards', 2, 409); await call('/api/time-off-requests', 2, 409); await call('/api/projects/101/assistant/context', 2, 409); assert.deepEqual(await load(), before); await change(db => { Object.assign(db, structuredClone(intact)); }); }
  await change(db => { db.users.find(row => row.id === 2).projectIds.push(999999); }); const unresolved = await call('/api/auth/me', 2); assert.equal(unresolved.data.scopeState, 'unresolved'); assert.equal(unresolved.data.notesPermissions.view, true); await call('/api/projects/101/notes-todos', 2); await change(db => { Object.assign(db, structuredClone(intact)); });
  // Atomic login and owner updates return finite current capabilities, never private markers.
  const password = 'Synthetic registry password only', salt = 'registry-synthetic-salt', hash = crypto.scryptSync(password, salt, 64).toString('hex');
  await change(db => { Object.assign(db.users.find(row => row.id === 2), { passwordSalt: salt, passwordHash: hash, mustSetPassword: false }); });
  const login = await call('/api/auth/login', 2, 200, 'POST', { email: 'user2@example.invalid', password }); assert.ok(!JSON.stringify(login.data).includes('Private account sentinel')); assert.equal(login.data.user.effectiveCapabilities.scheduling.create, true);
  before = await load(); const stored = before.snapshot.users.find(row => row.id === 2); const updated = await call('/api/users/2', 1, 200, 'PATCH', { name: stored.name, permissions: stored.permissions, projectIds: stored.projectIds, assignedCrews: stored.assignedCrews }); assert.equal(updated.data.effectiveCapabilities.scheduling.create, true); assert.ok(!JSON.stringify(updated.data).includes('Private account sentinel'));
  await change(db => { db.users.push({ ...db.users.find(row => row.id === 2), id: 999999, email: 'USER2@example.invalid', status: 'Deactivated' }); }); before = await load(); await call('/api/auth/login', 2, 409, 'POST', { email: 'user2@example.invalid', password }); assert.deepEqual(await load(), before); await change(db => { Object.assign(db, structuredClone(intact)); });
  // Lists and bootstrap cannot deliver authority captured before a policy/role change.
  for (const [route, user] of [[endpoint, 1], ['/api/users', 1], ['/api/auth/me', 2], ['/api/account-access', 2]]) {
    controls.readGate = checkpoint(); const pending = request(bases[0], 'GET', route, undefined, user); await waitFor(() => controls.readGate.count === 3); await change(db => { db.company.schedulingRolePolicy = policy(registry.families[0][4]); db.company.schedulingRolePolicy.roles.project_manager.create = false; }); before = await load(); controls.readGate.resolve(); const stale = await pending; controls.readGate = null; assert.equal(stale.status, 409); assert.ok(!stale.data.effectiveCapabilities && !Array.isArray(stale.data)); assert.deepEqual(await load(), before); await change(db => { delete db.company.schedulingRolePolicy; });
  }
  // Deliberate locked-account bootstrap survives; business/owner review remains locked.
  const company = structuredClone((await load()).snapshot.company); await change(db => { Object.assign(db.company, { demo: false, billingExempt: false, subscriptionStatus: 'Past due' }); }); const lockedMe = await call('/api/auth/me'); assert.equal(lockedMe.data.accountLocked, true); before = await load(); await call(endpoint, 1, 402); await call('/api/users', 1, 402); await call('/api/account-access'); assert.deepEqual(await load(), before); await change(db => { db.company = company; });
  for (const route of ['/api/account-access', '/api/auth/me']) {
    const ends = Date.now() + 2000; await change(db => { db.company = { ...company, demo: false, billingExempt: false, trialEndsAt: new Date(ends).toISOString() }; delete db.company.subscriptionStatus; });
    before = await load(); controls.readGate = checkpoint(); const pending = request(bases[0], 'GET', route, undefined, 2); await waitFor(() => controls.readGate.count === 3); await waitFor(() => Date.now() > ends); controls.readGate.resolve(); const locked = await pending; controls.readGate = null; assert.equal(locked.status, 200); assert.equal(route.includes('/auth/') ? locked.data.accountLocked : locked.data.locked, true);
    if (route === '/api/account-access') assert.deepEqual(await load(), before); else assert.equal((await load()).revision, before.revision + 1); await change(db => { db.company = company; });
  }
  const sessions = structuredClone((await load()).snapshot.sessions), expiry = Date.now() + 3000; await change(db => { db.sessions.filter(row => row.userId === 2).forEach(row => { row.expiresAt = new Date(expiry).toISOString(); }); }); before = await load(); controls.readGate = checkpoint(); const expires = request(bases[0], 'GET', '/api/auth/me', undefined, 2); await waitFor(() => controls.readGate.count === 3); await waitFor(() => Date.now() > expiry); controls.readGate.resolve(); assert.equal((await expires).status, 401); controls.readGate = null; assert.deepEqual(await load(), before); await change(db => { db.sessions = sessions; });
  // Read-only registry cannot activate/save a policy, broaden scope or field assistant.
  before = await load(); await call(endpoint, 1, 503, 'POST', { roles: { field: { aiAssistant: true } } }); assert.deepEqual(await load(), before); await call('/api/projects/101/assistant/context', 4, 403);
  // Foreign bootstrap intentionally renewed only its synthetic session; no grants/business changed.
  const foreignAfter = await repository.load(companyB), f1 = structuredClone(foreign.snapshot), f2 = structuredClone(foreignAfter.snapshot); delete f1.sessions; delete f2.sessions; assert.deepEqual(f2, f1); assert.equal(providerEvents.length, providers);
  console.log('Registry PostgreSQL HTTP passed: immutable owner32-action review, fresh finite me/directory/foreman/inactive projections, stored/effective separation, real dependent/falsy policies, exact session-only CAS renewal, hidden aliases/nested/session/tenant containment, stale delivery and natural expiry, locked bootstrap, unsupported save and fixed assistant eligibility.');
};
