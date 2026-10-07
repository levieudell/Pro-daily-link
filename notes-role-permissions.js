'use strict';
const crypto = require('node:crypto');
const roles = ['admin', 'project_manager', 'foreman', 'field'];
const actions = ['view', 'create', 'edit', 'complete'];
const all = () => Object.fromEntries(actions.map(key => [key, true]));
const none = () => Object.fromEntries(actions.map(key => [key, false]));
const error = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
function exact(value, keys) { return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)); }
function permissions(value) {
  if (!exact(value, actions) || actions.some(key => typeof value[key] !== 'boolean')) throw error('Choose each supported notes permission.');
  if (!value.view && actions.slice(1).some(key => value[key])) throw error('Disable notes changes when viewing is disabled.');
  return Object.fromEntries(actions.map(key => [key, value[key]]));
}
function defaults() { return { schemaVersion: 1, revision: 0, roles: Object.fromEntries(roles.map(role => [role, all()])), customRoles: [], assignments: [], retiredIds: [] }; }
function validate(value, db) {
  if (!exact(value, ['schemaVersion', 'revision', 'roles', 'customRoles', 'assignments', 'retiredIds']) || value.schemaVersion !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0 || value.revision >= Number.MAX_SAFE_INTEGER - 1 || !exact(value.roles, roles)) throw error('Invalid notes role policy.');
  const rolePermissions = Object.fromEntries(roles.map(role => [role, permissions(value.roles[role])]));
  const validId = id => typeof id === 'string' && /^custom_[a-z0-9_-]{1,40}$/.test(id);
  if (!Array.isArray(value.retiredIds) || value.retiredIds.length > 10000 || value.retiredIds.some(id => !validId(id)) || new Set(value.retiredIds).size !== value.retiredIds.length) throw error('Invalid retired role IDs.');
  const retired = new Set(value.retiredIds), ids = new Set(), names = new Set();
  if (!Array.isArray(value.customRoles) || value.customRoles.length > 20) throw error('Use at most 20 custom notes profiles.');
  const customRoles = value.customRoles.map(row => {
    if (!exact(row, ['id', 'name', 'baseRole', 'permissions']) || !validId(row.id) || ids.has(row.id) || retired.has(row.id) || !roles.includes(row.baseRole) || typeof row.name !== 'string' || !row.name.trim() || row.name.trim().length > 60 || /[\u0000-\u001f\u007f<>]/.test(row.name)) throw error('Invalid custom notes profile.');
    const name = row.name.trim(), folded = name.toLowerCase();
    if (names.has(folded) || ['owner', 'account owner', 'admin', 'office', 'project manager', 'foreman', 'field', 'platform owner', ...roles].includes(folded)) throw error('Use a unique custom profile name.');
    ids.add(row.id); names.add(folded); return { id: row.id, name, baseRole: row.baseRole, permissions: permissions(row.permissions) };
  });
  if (!Array.isArray(value.assignments) || value.assignments.length > 10000) throw error('Invalid profile assignments.');
  const assigned = new Set(), assignments = value.assignments.map(row => {
    if (!exact(row, ['userId', 'customRoleId']) || !Number.isSafeInteger(row.userId) || assigned.has(row.userId)) throw error('Invalid profile assignment.');
    const custom = customRoles.find(item => item.id === row.customRoleId), user = (db.users || []).find(item => item.id === row.userId && item.status === 'Active' && (!item.companyId || item.companyId === db.company.id));
    const role = user?.role === 'office' ? 'admin' : user?.role;
    if (!custom || !user || role === 'owner' || role !== custom.baseRole) throw error('Assign a custom profile only to an active account with its protected baseline.');
    assigned.add(row.userId); return { userId: row.userId, customRoleId: row.customRoleId };
  });
  return { schemaVersion: 1, revision: value.revision, roles: rolePermissions, customRoles, assignments, retiredIds: [...retired] };
}
function current(db) {
  if (db.company.notesRolePolicy === undefined) return (db.users || []).some(user => user.notesCustomRoleId != null) ? { ...defaults(), roles: Object.fromEntries(roles.map(role => [role, none()])), valid: false, revision: null } : { ...defaults(), valid: true };
  // Existing assignments can outlive deactivation/role changes. Validate structure
  // using the stored policy's baseline, then check the real actor on each request.
  try {
    const raw = db.company.notesRolePolicy, synthetic = { company: db.company, users: (raw.assignments || []).map(row => ({ id: row.userId, companyId: db.company.id, status: 'Active', role: (raw.customRoles || []).find(item => item.id === row.customRoleId)?.baseRole })) };
    return { ...validate(raw, synthetic), valid: true };
  } catch { return { ...defaults(), roles: Object.fromEntries(roles.map(role => [role, none()])), valid: false, revision: null }; }
}
function access(db, user) {
  if (user?.role === 'owner') return all();
  const role = user?.role === 'office' ? 'admin' : user?.role;
  if (!roles.includes(role)) return none();
  if (db.company.notesRolePolicy === undefined && user.notesCustomRoleId != null) return none();
  const policy = current(db); if (!policy.valid) return none();
  const assigned = policy.assignments.find(row => row.userId === user.id), custom = assigned && policy.customRoles.find(row => row.id === assigned.customRoleId);
  if (user.notesCustomRoleId != null && (!assigned || assigned.customRoleId !== user.notesCustomRoleId) || assigned && user.notesCustomRoleId !== assigned.customRoleId) return none();
  if (assigned && (!custom || custom.baseRole !== role)) return none();
  const result = Object.fromEntries(actions.map(key => [key, policy.roles[role][key] && (!custom || custom.permissions[key])]));
  if (!result.view) return none(); return result;
}
function accounts(db, policy) {
  const selected = new Set(policy.assignments.map(row => row.userId));
  const rows = (db.users || []).filter(user => user.role !== 'owner' && (!user.companyId || user.companyId === db.company.id) && (selected.has(user.id) || user.notesCustomRoleId != null || user.status === 'Active' && roles.includes(user.role === 'office' ? 'admin' : user.role))).map(user => ({ id: user.id, name: user.name, role: user.role === 'office' ? 'admin' : user.role, status: user.status, eligible: user.status === 'Active' && roles.includes(user.role === 'office' ? 'admin' : user.role) }));
  for (const id of selected) if (!(db.users || []).some(user => user.id === id)) rows.push({ id, name: 'Removed account ' + id, role: null, status: 'Removed', eligible: false });
  return rows;
}
function profile(policy, id) { const assignment = policy.assignments.find(row => row.userId === id); return assignment ? policy.customRoles.find(row => row.id === assignment.customRoleId)?.name || 'Unavailable profile' : 'Base role only'; }
function impact(db, next) {
  const beforePolicy = current(db), projected = { ...db, company: { ...db.company, notesRolePolicy: next } };
  return accounts(db, beforePolicy).map(row => {
    const user = (db.users || []).find(item => item.id === row.id), active = user?.status === 'Active';
    return { ...row, beforeProfile: profile(beforePolicy, row.id), afterProfile: profile(next, row.id), before: active ? access(db, user) : none(), after: active ? access(projected, { ...user, notesCustomRoleId: next.assignments.find(item => item.userId === row.id)?.customRoleId }) : none() };
  });
}
function createHandler({ readDb, writeDb, body, json, authenticatedUser, sessionBinding, storageSupported, accountAccess, signingKey }) {
  const route = '/api/company/notes-role-permissions';
  const fingerprint = db => crypto.createHash('sha256').update(JSON.stringify([db.company.id, db.company.notesRolePolicy, (db.users || []).map(user => [user.id, user.name, user.role, user.status, user.companyId, user.projectIds, user.assignedCrews, user.memberId, user.permissions, user.notesCustomRoleId])])).digest('hex');
  const sign = (db, user, binding, value) => crypto.createHmac('sha256', signingKey()).update(JSON.stringify([fingerprint(db), user.id, binding, value])).digest('hex');
  return async (req, res, url) => {
    if (![route, route + '/preview'].includes(url.pathname)) return false;
    const reply = (status, data) => { json(res, status, data); return true; };
    const db = readDb(), user = authenticatedUser(req, db), hinted = req.headers['x-pdl-company'];
    if (!user || user.mustSetPassword || !['owner', 'admin'].includes(user.role) || hinted && hinted !== db.company.id) return reply(403, { error: 'Active Account Owner or Admin session required.' });
    res.setHeader('Cache-Control', 'private, no-store');
    const policy = current(db), supported = storageSupported();
    if (req.method === 'GET' && url.pathname === route) return reply(200, { ...policy, canEdit: user.role === 'owner' && supported && policy.valid, storageSupported: supported, users: impact(db, policy), accounts: accounts(db, policy), history: (db.auditLog || []).filter(row => row.type === 'notes_role_policy_changed').slice(-20).reverse() });
    if (user.role !== 'owner') return reply(403, { error: 'Only the Account Owner can change notes permissions.' });
    if (!supported) return reply(503, { error: 'This draft requires shared-file admission. Cloud activation needs transactional admission integration.' });
    if (accountAccess(db.company).locked) return reply(402, { error: 'The company account is locked.' });
    if (db.company.emailVerificationRequiredAt && !user.emailVerifiedAt) return reply(403, { error: 'Confirm the Account Owner email first.' });
    if (!(req.method === 'POST' && url.pathname === route + '/preview' || req.method === 'PUT' && url.pathname === route)) return reply(405, { error: 'Preview before confirming a change.' });
    try {
      const input = await body(req);
      if (!exact(input, req.method === 'POST' ? ['revision', 'policy', 'reason'] : ['revision', 'policy', 'reason', 'expiresAt', 'previewToken', 'confirm'])) throw error('Unsupported permission or role.');
      if (!policy.valid || input.revision !== policy.revision) throw error('Permissions changed. Reload and preview again.', 409);
      const next = validate(input.policy, db);
      if (next.revision !== policy.revision + 1) throw error('Use the next policy revision.');
      if (policy.retiredIds.some(id => !next.retiredIds.includes(id))) throw error('Retired IDs cannot be reused.');
      for (const before of policy.customRoles) { const after = next.customRoles.find(row => row.id === before.id); if (after && after.baseRole !== before.baseRole || !after && !next.retiredIds.includes(before.id)) throw error('Custom baselines and retired IDs are protected.'); }
      if (typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > 500) throw error('Enter a reason up to 500 characters.');
      const value = { revision: input.revision, policy: next, reason: input.reason.trim(), expiresAt: req.method === 'POST' ? Date.now() + 300000 : input.expiresAt }, binding = sessionBinding(req);
      if (!binding) throw error('Authentication required.', 403);
      if (req.method === 'POST') return reply(200, { ...value, users: impact(db, next), previewToken: sign(db, user, binding, value) });
      if (input.confirm !== true) throw error('Confirm the reviewed preview.');
      const expected = sign(db, user, binding, value);
      if (!Number.isSafeInteger(value.expiresAt) || value.expiresAt <= Date.now() || value.expiresAt > Date.now() + 300000 || typeof input.previewToken !== 'string' || !/^[a-f0-9]{64}$/.test(input.previewToken) || !crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(input.previewToken, 'hex'))) throw error('Preview expired or access changed. Preview again.', 409);
      const audit = { id: crypto.randomUUID(), type: 'notes_role_policy_changed', actorId: user.id, actor: user.name, companyId: db.company.id, at: new Date().toISOString(), reason: value.reason, before: db.company.notesRolePolicy || defaults(), after: next, users: impact(db, next) };
      for (const account of db.users || []) {
        if (account.role === 'owner' || account.companyId && account.companyId !== db.company.id) continue;
        const assignment = next.assignments.find(row => row.userId === account.id);
        if (assignment) account.notesCustomRoleId = assignment.customRoleId; else delete account.notesCustomRoleId;
      }
      db.company.notesRolePolicy = next; db.auditLog ||= []; db.auditLog.push(audit); writeDb(db);
      return reply(200, { revision: next.revision, audit });
    } catch (failure) { if (!failure.statusCode) throw failure; return reply(failure.statusCode, { error: failure.message }); }
  };
}
module.exports = { roles, actions, defaults, validate, current, access, impact, accounts, createHandler };
