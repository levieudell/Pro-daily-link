'use strict';
const crypto = require('node:crypto');
const registry = require('./capability-registry');
const profiles = require('./role-profiles');
const accounts = require('./account-projections');
const notes = require('./notes-access');
const outbox = require('./assignment-email-outbox');
const { canonicalHash } = require('./database/transactional-repository');
const ROOT = '/api/company/role-policy', LIMIT = 1000, LEDGER_BYTES = 8 * 1024 * 1024, TTL = 10 * 60000;
const fail = (statusCode, message) => { throw Object.assign(Error(message), { statusCode }); };
const object = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key));
const handleId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(value);
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0 && value < Number.MAX_SAFE_INTEGER - 1;
const equal = (a, b) => canonicalHash(a) === canonicalHash(b);
const familyIds = registry.families.map(row => row[0]);
const clone = value => structuredClone(value);
function policyRevision(db) {
  const value = Object.hasOwn(db.company, 'rolePolicyRevision') ? db.company.rolePolicyRevision : 0;
  if (!integer(value)) fail(409, 'Policy revision needs reconciliation');
  return value;
}
function configuration(db) {
  const states = registry.policyState(db), policies = {};
  for (const [id, , prefix, , module] of registry.families) policies[id] = states[id].state === 'valid' ? clone(module.validatePolicy(db.company[prefix + 'RolePolicy'])) : null;
  return { policyRevision: policyRevision(db), states, policies, ...(profiles.required(db) ? { profiles: { required: true, model: clone(profiles.read(db)) } } : {}) };
}
function validateConfiguration(value) {
  if (!(object(value, ['policyRevision', 'states', 'policies']) || object(value, ['policyRevision', 'states', 'policies', 'profiles'])) || !integer(value.policyRevision) || !object(value.states, familyIds) || !object(value.policies, familyIds)) fail(409, 'Policy history needs reconciliation');
  if (Object.hasOwn(value, 'profiles')) { if (!object(value.profiles, ['required', 'model']) || value.profiles.required !== true) fail(409, 'Profile history needs reconciliation'); profiles.validateModel(value.profiles.model); }
  for (const [id, , , , module] of registry.families) {
    const state = value.states[id];
    if (!object(state, ['state', 'revision', 'required']) || !['default', 'valid', 'invalid', 'required-missing'].includes(state.state) || !integer(state.revision) || typeof state.required !== 'boolean') fail(409, 'Policy history state needs reconciliation');
    if (state.state === 'valid') { try { module.validatePolicy(value.policies[id]); } catch { fail(409, 'Policy history needs reconciliation'); } if (state.revision !== value.policies[id].revision) fail(409, 'Policy history revision needs reconciliation'); }
    else if (value.policies[id] !== null || state.revision !== 0) fail(409, 'Policy history state needs reconciliation');
  }
}
function parseRows(value) {
  if (!object(value, familyIds)) fail(400, 'Choose exactly the six supported policy families');
  const set = Object.fromEntries(registry.families.map(([id]) => [id, { version: 1, revision: 1, roles: value[id] }]));
  try { registry.validatePolicySet(set); } catch { fail(400, 'Use only valid typed role actions and immutable role ceilings'); }
  return clone(value);
}
function parseProposal(value) { return object(value, ['profileChange']) ? { profileChange: profiles.parseChange(value.profileChange) } : parseRows(value); }
function previewInput(proof) { return { requestId: proof.id, expectedRevision: proof.expectedRevision - 1, reason: proof.reason, ...(Object.hasOwn(proof.policies, 'profileChange') ? { profileChange: proof.policies.profileChange } : { policies: proof.policies }) }; }
function parseProfilePreview(input) {
  if (!object(input, ['requestId', 'expectedRevision', 'reason', 'profileChange'])) fail(400, 'Use only the typed profile preview fields');
  parsePreview({ requestId: input.requestId, expectedRevision: input.expectedRevision, reason: input.reason, policies: Object.fromEntries(registry.families.map(([id, , , , module]) => [id, Object.fromEntries(module.roles.map(role => [role, module.ceiling(role)]))])) });
  return { requestId: input.requestId, expectedRevision: input.expectedRevision, reason: input.reason, profileChange: profiles.parseChange(input.profileChange) };
}
function parsePreview(input) {
  if (!object(input, ['requestId', 'expectedRevision', 'reason', 'policies']) || !handleId(input.requestId) || !integer(input.expectedRevision) || typeof input.reason !== 'string' || input.reason !== input.reason.trim() || input.reason.length < 1 || input.reason.length > 1000 || /[\u0000-\u001f\u007f]/.test(input.reason)) fail(400, 'Provide a request ID, current tenant revision and policy-change reason');
  return { requestId: input.requestId, expectedRevision: input.expectedRevision, reason: input.reason, policies: parseRows(input.policies) };
}
function parseConfirm(input) {
  if (!object(input, ['previewId', 'version', 'requestId', 'confirmed']) || !handleId(input.previewId) || !handleId(input.requestId) || !digest(input.version) || input.confirmed !== true) fail(400, 'Preview and explicitly confirm with the original version and a request ID');
  return clone(input);
}
function plan(db, rows) {
  const after = { ...db, company: { ...db.company } }, state = registry.policyState(db), changedFamilies = [];
  for (const [id, , prefix, , module] of registry.families) {
    const current = state[id].state === 'valid' ? module.validatePolicy(db.company[prefix + 'RolePolicy']) : null;
    const defaults = Object.fromEntries(module.roles.map(role => [role, module.ceiling(role)]));
    if (current && equal(current.roles, rows[id]) || state[id].state === 'default' && equal(defaults, rows[id])) continue;
    const next = current ? current.revision + 1 : 1;
    if (!integer(next) || next < 1) fail(409, 'Policy family revision needs reconciliation');
    after.company[prefix + 'RolePolicy'] = { version: 1, revision: next, roles: clone(rows[id]) };
    after.company[prefix + 'PolicyRequired'] = true;
    changedFamilies.push(id);
  }
  if (!changedFamilies.length) fail(400, 'No role-policy change to preview');
  after.company.rolePolicyRevision = policyRevision(db) + 1;
  if (!integer(after.company.rolePolicyRevision)) fail(409, 'Policy revision needs reconciliation');
  return { after, changedFamilies };
}
function planProposal(db, value) {
  if (!Object.hasOwn(value, 'profileChange')) return plan(db, value);
  const after = profiles.plan(db, value.profileChange); after.company.rolePolicyRevision = policyRevision(db) + 1;
  if (!integer(after.company.rolePolicyRevision)) fail(409, 'Policy revision needs reconciliation');
  return { after, changedFamilies: ['profiles'] };
}
function sourceHash(db) {
  return canonicalHash(Object.fromEntries(Object.entries(db).filter(([key]) => !['rolePolicyPreviews', 'rolePolicyReceipts', 'rolePolicyAudit'].includes(key))));
}
function policyHash(db) {
  return canonicalHash({ revision: policyRevision(db), families: Object.fromEntries(registry.families.map(([id, , prefix]) => [id, ['RolePolicy', 'PolicyRequired'].map(suffix => { const key = prefix + suffix; return Object.hasOwn(db.company, key) ? { present: true, value: db.company[key] } : { present: false }; })])), ...(['roleProfiles', 'roleProfilesRequired'].some(key => Object.hasOwn(db.company, key)) ? { profiles: ['roleProfiles', 'roleProfilesRequired'].map(key => Object.hasOwn(db.company, key) ? { present: true, value: db.company[key] } : { present: false }) } : {}) });
}
function owner(req, db) {
  if (!req.auth?.session?.tokenHash || req.auth.companyId !== db.company.id || req.auth.session.companyId !== db.company.id || req.auth.user?.status !== 'Active' || req.auth.user.role !== 'owner') fail(403, 'Active company owner permission required');
  notes.validateActor(req.auth.user);
}
function authority(req, db) { return canonicalHash({ companyId: db.company.id, actorId: Number(req.auth.user.id), role: 'owner', status: 'Active', sessionHash: req.auth.session.tokenHash }); }
function impacts(db, after, baselineProjectAllowed, at) {
  if ((db.users || []).length > LIMIT || (db.projects || []).length > 10000 || (db.users || []).some(user => user.notesCustomRoleId != null)) fail(409, 'Account scopes or custom profiles need reconciliation before policy activation');
  const beforeAccounts = accounts.directory(db), afterAccounts = accounts.directory(after), profileImpact = profiles.required(db) || profiles.required(after);
  const scopedProjects = (snapshot, user, capabilities) => user.status !== 'Active' || !capabilities.notes.view ? [] : (snapshot.projects || []).filter(project => notes.projectAllowed(snapshot, registry.normalize(user), project.id, baselineProjectAllowed)).map(project => Number(project.id));
  const projected = beforeAccounts.map((before, index) => {
    const user = db.users[index], next = afterAccounts[index];
    if (user.status === 'Active' && before.scopeState !== 'resolved') fail(409, 'Active account scope needs reconciliation before policy activation');
    const changes = registry.families.flatMap(([id, , , , module]) => module.actions.filter(action => before.effectiveCapabilities[id][action] !== next.effectiveCapabilities[id][action]).map(action => ({ capability: id + '.' + action, before: before.effectiveCapabilities[id][action], after: next.effectiveCapabilities[id][action] })));
    return { accountId: before.id, name: before.name, role: before.accessRole, status: before.status, scopeState: before.scopeState, before: before.effectiveCapabilities, after: next.effectiveCapabilities, ...(profileImpact ? { profileBefore: profiles.binding(db, registry.normalize(user)), profileAfter: profiles.binding(after, registry.normalize(user)) } : {}), notesProjectsBefore: scopedProjects(db, user, before.effectiveCapabilities), notesProjectsAfter: scopedProjects(after, user, next.effectiveCapabilities), changes };
  });
  const queued = (db.assignmentEmailOutbox || []).filter(row => row.status === 'queued');
  return { accounts: projected, changedAccounts: projected.filter(row => row.changes.length || !equal(row.notesProjectsBefore, row.notesProjectsAfter) || Object.hasOwn(row, 'profileBefore') && !equal(row.profileBefore, row.profileAfter)).length, queuedAssignmentEmails: { queuedCount: queued.length, newlyIneligibleIds: queued.filter(row => outbox.authorised(db, row, at) && !outbox.authorised(after, row, at)).map(row => row.id) } };
}
function validateCapabilities(value) {
  if (!object(value, familyIds)) fail(409, 'Policy impact needs reconciliation');
  for (const [id, , , , module] of registry.families) if (!object(value[id], module.actions) || module.actions.some(action => typeof value[id][action] !== 'boolean')) fail(409, 'Policy impact needs reconciliation');
}
function validateImpact(value) {
  if (!object(value, ['accounts', 'changedAccounts', 'queuedAssignmentEmails']) || !Array.isArray(value.accounts) || value.accounts.length > LIMIT || !integer(value.changedAccounts)) fail(409, 'Policy impact needs reconciliation');
  const known = registry.families.flatMap(([id, , , , module]) => module.actions.map(action => id + '.' + action)), ids = new Set();
  for (const row of value.accounts) {
    if (!(object(row, ['accountId', 'name', 'role', 'status', 'scopeState', 'before', 'after', 'notesProjectsBefore', 'notesProjectsAfter', 'changes']) || object(row, ['accountId', 'name', 'role', 'status', 'scopeState', 'before', 'after', 'notesProjectsBefore', 'notesProjectsAfter', 'changes', 'profileBefore', 'profileAfter'])) || !notes.numericId(row.accountId) || ids.has(Number(row.accountId)) || typeof row.name !== 'string' || row.name.length > 5000 || typeof row.role !== 'string' || row.role.length > 64 || typeof row.status !== 'string' || row.status.length > 64 || !['resolved', 'unresolved'].includes(row.scopeState) || !Array.isArray(row.changes) || row.changes.length > known.length) fail(409, 'Policy impact account needs reconciliation');
    ids.add(Number(row.accountId)); validateCapabilities(row.before); validateCapabilities(row.after); if (Object.hasOwn(row, 'profileBefore')) { profiles.validateDescriptor(row.profileBefore); profiles.validateDescriptor(row.profileAfter); }
    for (const key of ['notesProjectsBefore', 'notesProjectsAfter']) if (!Array.isArray(row[key]) || row[key].length > 10000 || row[key].some(id => !notes.numericId(id)) || new Set(row[key].map(Number)).size !== row[key].length) fail(409, 'Policy project impact needs reconciliation');
    const expected = registry.families.flatMap(([id, , , , module]) => module.actions.filter(action => row.before[id][action] !== row.after[id][action]).map(action => ({ capability: id + '.' + action, before: row.before[id][action], after: row.after[id][action] })));
    if (!equal(expected, row.changes)) fail(409, 'Policy impact changes need reconciliation');
  }
  if (value.changedAccounts !== value.accounts.filter(row => row.changes.length || !equal(row.notesProjectsBefore, row.notesProjectsAfter) || Object.hasOwn(row, 'profileBefore') && !equal(row.profileBefore, row.profileAfter)).length) fail(409, 'Policy impact counts need reconciliation');
  const queued = value.queuedAssignmentEmails;
  if (!object(queued, ['queuedCount', 'newlyIneligibleIds']) || !integer(queued.queuedCount) || !Array.isArray(queued.newlyIneligibleIds) || queued.newlyIneligibleIds.length > queued.queuedCount || queued.newlyIneligibleIds.some(id => typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) || new Set(queued.newlyIneligibleIds).size !== queued.newlyIneligibleIds.length) fail(409, 'Queued policy impact needs reconciliation');
}
const proofKeys = ['id', 'companyId', 'actorId', 'actorName', 'sessionHash', 'actorHash', 'inputHash', 'reason', 'createdAt', 'expiresAt', 'expectedRevision', 'sourceHash', 'beforePolicyHash', 'afterPolicyHash', 'policies', 'before', 'after', 'changedFamilies', 'impact', 'version'];
const receiptKeys = ['id', 'previewId', 'companyId', 'actorId', 'sessionHash', 'actorHash', 'version', 'inputHash', 'policyHash', 'policyRevision', 'tenantRevision', 'committedAt'];
const auditKeys = ['id', 'kind', 'previewId', 'requestId', 'companyId', 'actorId', 'actorName', 'at', 'reason', 'before', 'after', 'impactHash', 'beforePolicyHash', 'afterPolicyHash', 'changedFamilies'];
const iso = value => typeof value === 'string' && value.length <= 100 && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const familiesValid = rows => Array.isArray(rows) && rows.length > 0 && rows.length <= familyIds.length + 1 && rows.every(id => [...familyIds, 'profiles'].includes(id)) && new Set(rows).size === rows.length;
function proofVersion(row) { return canonicalHash(Object.fromEntries(proofKeys.filter(key => key !== 'version').map(key => [key, row[key]]))); }
const controlBytes = db => Buffer.byteLength(JSON.stringify(['rolePolicyPreviews', 'rolePolicyReceipts', 'rolePolicyAudit'].map(key => db[key] || [])), 'utf8');
function reserveConfirmation(candidate, proof) {
  const reserved = clone(candidate), requestId = 'r'.repeat(128), committedAt = new Date(proof.expiresAt - 1).toISOString();
  reserved.rolePolicyReceipts ||= [];
  reserved.rolePolicyReceipts.push({ id: requestId, previewId: proof.id, companyId: proof.companyId, actorId: proof.actorId, sessionHash: proof.sessionHash, actorHash: proof.actorHash, version: proof.version, inputHash: canonicalHash({ previewId: proof.id, version: proof.version, requestId, confirmed: true }), policyHash: proof.afterPolicyHash, policyRevision: proof.after.policyRevision, tenantRevision: proof.expectedRevision + 1, committedAt });
  appendAudit(reserved, proof, 'confirmed', requestId, proof.expiresAt - 1);
  if (controlBytes(reserved) > LEDGER_BYTES) fail(409, 'Retained policy confirmation capacity reached; history requires reconciliation');
}
function ledger(db) {
  const collections = ['rolePolicyPreviews', 'rolePolicyReceipts', 'rolePolicyAudit'];
  for (const name of collections) { const rows = Object.hasOwn(db, name) ? db[name] : []; if (!Array.isArray(rows) || rows.length > (name === 'rolePolicyAudit' ? LIMIT * 2 : LIMIT) || rows.some(row => !handleId(row?.id)) || new Set(rows.map(row => row.id)).size !== rows.length) fail(409, 'Policy control identities need reconciliation'); }
  const previews = db.rolePolicyPreviews || [], receipts = db.rolePolicyReceipts || [], audit = db.rolePolicyAudit || [];
  if (controlBytes(db) > LEDGER_BYTES) fail(409, 'Retained policy history capacity reached; history requires reconciliation');
  for (const row of previews) {
    if (!object(row, proofKeys) || row.companyId !== db.company.id || !notes.numericId(row.actorId) || typeof row.actorName !== 'string' || row.actorName.length > 5000 || !iso(row.createdAt) || !integer(row.expiresAt) || row.expiresAt !== Date.parse(row.createdAt) + TTL || !integer(row.expectedRevision) || typeof row.reason !== 'string' || row.reason.length < 1 || row.reason.length > 1000 || !familiesValid(row.changedFamilies) || ['sessionHash', 'actorHash', 'inputHash', 'sourceHash', 'beforePolicyHash', 'afterPolicyHash', 'version'].some(key => !digest(row[key]))) fail(409, 'Policy preview needs reconciliation');
    try { parseProposal(row.policies); } catch { fail(409, 'Policy preview actions need reconciliation'); }
    validateConfiguration(row.before); validateConfiguration(row.after); validateImpact(row.impact);
    if (row.expectedRevision < 1 || row.inputHash !== canonicalHash(previewInput(row)) || row.actorHash !== canonicalHash({ companyId: row.companyId, actorId: Number(row.actorId), role: 'owner', status: 'Active', sessionHash: row.sessionHash }) || row.after.policyRevision !== row.before.policyRevision + 1 || proofVersion(row) !== row.version) fail(409, 'Policy preview version needs reconciliation');
  }
  if (new Set(receipts.map(row => row.previewId)).size !== receipts.length) fail(409, 'Policy confirmation identities need reconciliation');
  for (const row of receipts) {
    const proof = previews.find(item => item.id === row.previewId);
    if (!object(row, receiptKeys) || !proof || row.companyId !== db.company.id || row.actorId !== proof.actorId || row.sessionHash !== proof.sessionHash || row.actorHash !== proof.actorHash || row.version !== proof.version || row.inputHash !== canonicalHash({ previewId: row.previewId, version: row.version, requestId: row.id, confirmed: true }) || row.policyHash !== proof.afterPolicyHash || row.policyRevision !== proof.after.policyRevision || row.tenantRevision !== proof.expectedRevision + 1 || !iso(row.committedAt) || Date.parse(row.committedAt) < Date.parse(proof.createdAt) || Date.parse(row.committedAt) >= proof.expiresAt) fail(409, 'Policy receipt needs reconciliation');
  }
  for (const row of audit) {
    const proof = previews.find(item => item.id === row.previewId), receipt = receipts.find(item => item.previewId === row.previewId);
    if (!object(row, auditKeys) || !proof || !['previewed', 'confirmed'].includes(row.kind) || row.companyId !== db.company.id || row.actorId !== proof.actorId || row.actorName !== proof.actorName || row.reason !== proof.reason || row.at !== (row.kind === 'previewed' ? proof.createdAt : receipt?.committedAt) || row.requestId !== (row.kind === 'previewed' ? proof.id : receipt?.id) || row.impactHash !== canonicalHash(proof.impact) || row.beforePolicyHash !== proof.beforePolicyHash || row.afterPolicyHash !== proof.afterPolicyHash || !equal(row.before, proof.before) || !equal(row.after, proof.after) || !equal(row.changedFamilies, proof.changedFamilies)) fail(409, 'Policy audit needs reconciliation');
  }
  for (const proof of previews) if (audit.filter(row => row.previewId === proof.id && row.kind === 'previewed').length !== 1 || audit.filter(row => row.previewId === proof.id && row.kind === 'confirmed').length !== receipts.filter(row => row.previewId === proof.id).length) fail(409, 'Policy audit linkage needs reconciliation');
  return { previews, receipts, audit };
}
function previewDto(proof) { return { previewId: proof.id, version: proof.version, tenantRevision: proof.expectedRevision, expiresAt: new Date(proof.expiresAt).toISOString(), reason: proof.reason, changedFamilies: clone(proof.changedFamilies), before: clone(proof.before), after: clone(proof.after), impact: clone(proof.impact), confirmationRequired: true }; }
function receiptDto(row) { return { requestId: row.id, previewId: row.previewId, version: row.version, policyRevision: row.policyRevision, tenantRevision: row.tenantRevision, committedAt: row.committedAt, committed: true }; }
function appendAudit(db, proof, kind, requestId, at) {
  db.rolePolicyAudit ||= []; db.rolePolicyAudit.push({ id: crypto.randomUUID(), kind, previewId: proof.id, requestId, companyId: db.company.id, actorId: proof.actorId, actorName: proof.actorName, at: new Date(at).toISOString(), reason: proof.reason, before: clone(proof.before), after: clone(proof.after), impactHash: canonicalHash(proof.impact), beforePolicyHash: proof.beforePolicyHash, afterPolicyHash: proof.afterPolicyHash, changedFamilies: clone(proof.changedFamilies) });
}
function validateDelta(before, after, kind, changedFamilies) {
  const omit = (value, keys) => Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
  const controls = ['rolePolicyPreviews', 'rolePolicyReceipts', 'rolePolicyAudit'];
  if (!equal(omit(before, ['company', ...controls]), omit(after, ['company', ...controls]))) fail(409, 'Policy action changes unrelated company records');
  const properties = kind === 'confirm' ? ['rolePolicyRevision', ...changedFamilies.flatMap(id => { if (id === 'profiles') return ['roleProfiles', 'roleProfilesRequired']; const prefix = registry.families.find(row => row[0] === id)[2]; return [prefix + 'RolePolicy', prefix + 'PolicyRequired']; })] : [];
  if (!equal(omit(before.company, properties), omit(after.company, properties))) fail(409, 'Policy action changes protected company settings');
  for (const name of controls) { const old = before[name] || [], next = after[name] || [], append = name === 'rolePolicyAudit' || kind === 'preview' && name === 'rolePolicyPreviews' || kind === 'confirm' && name === 'rolePolicyReceipts'; if (!equal(old, append ? next.slice(0, -1) : next) || append && next.length !== old.length + 1) fail(409, 'Policy control history cannot be rewritten'); }
  ledger(after);
}
function validateCommitGuard(value) {
  if (!object(value, ['kind', 'actorId', 'sessionHash', 'previewId', 'version', 'requestId', 'authorizedUntil']) || !['preview', 'confirm'].includes(value.kind) || !notes.numericId(value.actorId) || !digest(value.sessionHash) || !digest(value.version) || !handleId(value.previewId) || !handleId(value.requestId) || !iso(value.authorizedUntil)) fail(409, 'Policy commit guard needs reconciliation');
  return value;
}
function createHandler({ readDb, writeDb, body, json, revision, assertCurrent, baselineProjectAllowed, accountAccess, guardCommit, now = () => Date.now() }) {
  return async function handle(req, res, url) {
    const profilePreview = req.method === 'POST' && url.pathname === ROOT + '/profiles/preview';
    const read = req.method === 'GET' && [ROOT, ROOT + '/audit', ROOT + '/profiles'].includes(url.pathname), preview = req.method === 'POST' && url.pathname === ROOT + '/preview' || profilePreview, confirm = req.method === 'POST' && url.pathname === ROOT + '/confirm';
    if (!read && !preview && !confirm) return false;
    try {
      const db = readDb(); owner(req, db); if (accountAccess(db.company).locked) fail(402, 'Company account is locked');
      const state = ledger(db);
      if (read) {
        let result;
        if (url.pathname.endsWith('/audit')) { const offset = url.searchParams.get('offset') || '0'; if (!/^(0|[1-9][0-9]*)$/.test(offset) || !integer(Number(offset))) fail(400, 'Use a valid audit offset'); result = { total: state.audit.length, offset: Number(offset), entries: clone(state.audit.slice(Number(offset), Number(offset) + 100)) }; }
        else if (url.pathname.endsWith('/profiles')) result = { version: 1, tenantRevision: revision(), policyRevision: policyRevision(db), model: clone(profiles.read(db)), accounts: accounts.directory(db).map(row => ({ id: row.id, name: row.name, role: row.accessRole, status: row.status, scopeState: row.scopeState, scope: { projectIds: row.projectIds, assignedCrews: row.assignedCrews, memberId: row.memberId }, profile: row.roleProfile || profiles.binding(db, { id: row.id, role: row.accessRole }) })), officeDefaults: profiles.defaults('admin', true), customDefaults: Object.fromEntries(registry.roles.map(role => [role, profiles.defaults(role)])), baseRoles: [...registry.roles], scopeInheritance: profiles.SCOPE, ownerImmutable: true, assistantEligibilityImmutable: true };
        else result = { version: 1, tenantRevision: revision(), ...configuration(db), defaults: Object.fromEntries(registry.families.map(([id, , , , module]) => [id, Object.fromEntries(module.roles.map(role => [role, module.ceiling(role)]))])), ownerImmutable: true, scopeImmutable: true, assistantEligibilityImmutable: true, uiAvailable: true };
        await assertCurrent(req, false); owner(req, db); json(res, 200, result); return true;
      }
      const input = preview ? (profilePreview ? parseProfilePreview(await body(req)) : parsePreview(await body(req))) : parseConfirm(await body(req)), inputHash = canonicalHash(input), actorHash = authority(req, db);
      const existing = state.previews.find(row => row.id === (preview ? input.requestId : input.previewId));
      const bind = proof => { if (proof.actorId !== Number(req.auth.user.id) || proof.sessionHash !== req.auth.session.tokenHash || proof.actorHash !== actorHash) fail(409, 'Use the original active owner session'); };
      if (preview && existing) {
        bind(existing); if (existing.inputHash !== inputHash || state.receipts.some(row => row.previewId === existing.id)) fail(409, 'This preview request ID was already used');
        if (existing.expiresAt <= now() || existing.expectedRevision !== revision() || existing.sourceHash !== sourceHash(db)) fail(409, 'Preview expired or company changed; use a new preview request ID');
        await assertCurrent(req, false); if (existing.expiresAt <= now()) fail(409, 'Policy preview expired'); json(res, 200, previewDto(existing)); return true;
      }
      if (preview) {
        if (input.expectedRevision !== revision()) fail(409, 'Company changed; refresh policy state');
        if (state.previews.length >= LIMIT) fail(409, 'Retained policy preview capacity reached; history requires reconciliation');
        const proposal = profilePreview ? { profileChange: input.profileChange } : input.policies;
        const { after, changedFamilies } = planProposal(db, proposal), at = now(), impact = impacts(db, after, baselineProjectAllowed, at);
        const proof = { id: input.requestId, companyId: db.company.id, actorId: Number(req.auth.user.id), actorName: req.auth.user.name, sessionHash: req.auth.session.tokenHash, actorHash, inputHash, reason: input.reason, createdAt: new Date(at).toISOString(), expiresAt: at + TTL, expectedRevision: revision() + 1, sourceHash: sourceHash(db), beforePolicyHash: policyHash(db), afterPolicyHash: policyHash(after), policies: proposal, before: configuration(db), after: configuration(after), changedFamilies, impact };
        proof.version = proofVersion(proof);
        const candidate = clone(db); candidate.rolePolicyPreviews ||= []; candidate.rolePolicyPreviews.push(proof); appendAudit(candidate, proof, 'previewed', proof.id, at); validateDelta(db, candidate, 'preview', []); reserveConfirmation(candidate, proof);
        await assertCurrent(req, false); owner(req, db); setGuard('preview', proof, proof.id); writeDb(candidate); json(res, 200, previewDto(proof)); return true;
      }
      const sameId = state.receipts.find(row => row.id === input.requestId), prior = state.receipts.find(row => row.previewId === input.previewId);
      if (!existing) fail(409, 'Policy preview not found'); bind(existing);
      if (existing.version !== input.version || sameId && sameId !== prior) fail(409, 'Policy version or confirmation request ID does not match');
      if (prior) {
        if (prior.id !== input.requestId || prior.inputHash !== inputHash || prior.policyHash !== policyHash(db)) fail(409, 'Policy confirmation was used or its committed policy changed');
        await assertCurrent(req, false); owner(req, db); json(res, 200, receiptDto(prior)); return true;
      }
      if (existing.expiresAt <= now() || existing.expectedRevision !== revision() || existing.sourceHash !== sourceHash(db) || existing.beforePolicyHash !== policyHash(db)) fail(409, 'Policy preview expired or company changed; preview again');
      const { after, changedFamilies } = planProposal(db, existing.policies), impact = impacts(db, after, baselineProjectAllowed, Date.parse(existing.createdAt));
      if (!equal(changedFamilies, existing.changedFamilies) || policyHash(after) !== existing.afterPolicyHash || !equal(configuration(after), existing.after) || !equal(impact, existing.impact)) fail(409, 'Policy impact changed; preview again');
      const candidate = clone(db); candidate.company = clone(after.company); candidate.rolePolicyReceipts ||= [];
      const at = now(), receipt = { id: input.requestId, previewId: existing.id, companyId: db.company.id, actorId: existing.actorId, sessionHash: existing.sessionHash, actorHash, version: existing.version, inputHash, policyHash: existing.afterPolicyHash, policyRevision: existing.after.policyRevision, tenantRevision: revision() + 1, committedAt: new Date(at).toISOString() };
      candidate.rolePolicyReceipts.push(receipt); appendAudit(candidate, existing, 'confirmed', receipt.id, at); validateDelta(db, candidate, 'confirm', changedFamilies);
      await assertCurrent(req, false); owner(req, db); if (existing.expiresAt <= now()) fail(409, 'Policy preview expired'); setGuard('confirm', existing, receipt.id); writeDb(candidate); json(res, 200, receiptDto(receipt)); return true;
      function setGuard(kind, proof, requestId) {
        const access = accountAccess(db.company), deadline = Math.min(proof.expiresAt, Date.parse(req.auth.session.expiresAt), access.status === 'Trial' ? Date.parse(db.company.trialEndsAt) : Infinity);
        if (!Number.isFinite(deadline) || deadline <= now()) fail(409, 'Policy confirmation authority expired');
        guardCommit(validateCommitGuard({ kind, actorId: proof.actorId, sessionHash: proof.sessionHash, previewId: proof.id, version: proof.version, requestId, authorizedUntil: new Date(deadline).toISOString() }));
      }
    } catch (error) { if (![400, 401, 402, 403, 404, 409].includes(error.statusCode)) throw error; json(res, error.statusCode, { error: error.message }); return true; }
  };
}
module.exports = { ROOT, LIMIT, LEDGER_BYTES, TTL, configuration, parseRows, parsePreview, parseProfilePreview, parseConfirm, plan, planProposal, impacts, ledger, controlBytes, reserveConfirmation, validateDelta, validateCommitGuard, sourceHash, policyHash, authority, createHandler };
