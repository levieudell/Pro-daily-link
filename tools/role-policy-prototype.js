'use strict';

// Standalone review model. No app/server import, persistence, accounts, or grants.
// Existing operations must come from audited server admission, never a client.
const BUILT_IN_ROLES = Object.freeze(['admin', 'project_manager', 'foreman', 'field']);
const ALL = ['admin', 'project_manager', 'foreman', 'field'];
const OFFICE = ['admin', 'project_manager'];
const FIELD = ['foreman', 'field'];
const OPERATIONS = Object.freeze([
  { id: 'schedule.view', roles: ALL },
  { id: 'schedule.create', roles: OFFICE, requires: ['schedule.view'] },
  { id: 'schedule.edit', roles: OFFICE, requires: ['schedule.view'] },
  { id: 'schedule.delete', roles: OFFICE, requires: ['schedule.view'] },
  { id: 'schedule.acknowledge', roles: FIELD, requires: ['schedule.view'] },
  { id: 'dailies.view', roles: ALL },
  { id: 'dailies.create', roles: ALL, requires: ['dailies.view'] },
  { id: 'dailies.edit', roles: ALL, requires: ['dailies.view'] },
  { id: 'dailies.delete', roles: OFFICE, requires: ['dailies.view'] },
  { id: 'dailies.approve', roles: OFFICE, requires: ['dailies.view'] },
  { id: 'time.view', roles: ALL },
  { id: 'time.create', roles: OFFICE, requires: ['time.view'] },
  { id: 'time.edit', roles: ALL, requires: ['time.view'] },
  { id: 'time.delete', roles: OFFICE, requires: ['time.view'] },
  { id: 'time.submit', roles: ALL, requires: ['time.view'] },
  { id: 'time.approve', roles: OFFICE, requires: ['time.view'] },
  { id: 'time.unapprove', roles: OFFICE, requires: ['time.view'] },
  { id: 'notes.view', roles: ALL },
  { id: 'notes.create', roles: ALL, requires: ['notes.view'] },
  { id: 'notes.edit', roles: ALL, requires: ['notes.view'] },
  { id: 'notes.complete', roles: ALL, requires: ['notes.view'] },
  { id: 'plans.view', roles: ALL },
  { id: 'plans.create', roles: OFFICE, requires: ['plans.view'] },
  { id: 'photos.view', roles: ALL },
  { id: 'photos.create', roles: ALL, requires: ['photos.view'] }
].map(row => Object.freeze({ ...row, roles: Object.freeze([...row.roles]), requires: Object.freeze(row.requires || []) })));
const byId = new Map(OPERATIONS.map(row => [row.id, row]));
function exact(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function invalid(message) { throw new Error(message); }
function operationList(value, role) {
  if (!Array.isArray(value) || value.length > OPERATIONS.length || new Set(value).size !== value.length) invalid('Invalid operation list');
  for (const id of value) if (!byId.has(id) || !byId.get(id).roles.includes(role)) invalid('Operation outside restricted baseline');
  return [...value].sort();
}
function validateDraft(value) {
  if (!exact(value, ['schemaVersion', 'companyId', 'revision', 'builtInRoles', 'customRoles', 'retiredCustomRoleIds']) || value.schemaVersion !== 2 ||
    typeof value.companyId !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(value.companyId) ||
    !Number.isSafeInteger(value.revision) || value.revision < 0 || value.revision >= Number.MAX_SAFE_INTEGER - 1) invalid('Invalid versioned policy');
  if (!exact(value.builtInRoles, BUILT_IN_ROLES)) invalid('Only supported non-owner roles are editable');
  const builtInRoles = Object.fromEntries(BUILT_IN_ROLES.map(role => {
    const row = value.builtInRoles[role];
    if (!exact(row, ['deniedOperations'])) invalid('Invalid role restrictions');
    return [role, { deniedOperations: operationList(row.deniedOperations, role) }];
  }));
  if (!Array.isArray(value.customRoles) || value.customRoles.length > 20) invalid('Invalid custom roles');
  if (!Array.isArray(value.retiredCustomRoleIds) || value.retiredCustomRoleIds.length > 10000 ||
    new Set(value.retiredCustomRoleIds).size !== value.retiredCustomRoleIds.length ||
    value.retiredCustomRoleIds.some(id => typeof id !== 'string' || !/^custom_[a-z0-9_-]{1,40}$/.test(id))) invalid('Invalid retired role IDs');
  const retired = new Set(value.retiredCustomRoleIds);
  const ids = new Set(), names = new Set();
  const customRoles = value.customRoles.map(row => {
    if (!exact(row, ['id', 'name', 'baseRole', 'allowedOperations']) || !BUILT_IN_ROLES.includes(row.baseRole) ||
      typeof row.id !== 'string' || !/^custom_[a-z0-9_-]{1,40}$/.test(row.id) || ids.has(row.id) || retired.has(row.id) ||
      typeof row.name !== 'string' || row.name.trim().length < 1 || row.name.trim().length > 60 || /[\u0000-\u001f\u007f<>]/.test(row.name)) invalid('Invalid named custom role');
    const name = row.name.trim(), folded = name.toLowerCase();
    if (names.has(folded) || ['owner', 'account owner', 'admin', 'office', 'project manager', 'foreman', 'field', 'platform owner', 'platform admin'].includes(folded)) invalid('Duplicate or reserved role name');
    ids.add(row.id); names.add(folded);
    const allowedOperations = operationList(row.allowedOperations, row.baseRole), allowed = new Set(allowedOperations);
    for (const id of allowed) if (byId.get(id).requires.some(required => !allowed.has(required))) invalid('Custom role is missing a required view');
    return { id: row.id, name, baseRole: row.baseRole, allowedOperations };
  });
  return { schemaVersion: 2, companyId: value.companyId, revision: value.revision, builtInRoles, customRoles, retiredCustomRoleIds: [...retired].sort() };
}
function emptyDraft(companyId) {
  return { schemaVersion: 2, companyId, revision: 0, builtInRoles: Object.fromEntries(BUILT_IN_ROLES.map(role => [role, { deniedOperations: [] }])), customRoles: [], retiredCustomRoleIds: [] };
}
function validateRevision(current, proposed, expectedRevision) {
  const previous = validateDraft(current), next = validateDraft(proposed);
  if (previous.companyId !== next.companyId || expectedRevision !== previous.revision || next.revision !== previous.revision + 1) invalid('Stale revision or different tenant');
  if (previous.retiredCustomRoleIds.some(id => !next.retiredCustomRoleIds.includes(id))) invalid('Role retirement is permanent');
  for (const before of previous.customRoles) {
    const after = next.customRoles.find(row => row.id === before.id);
    if (!after && !next.retiredCustomRoleIds.includes(before.id)) invalid('Retire removed custom role IDs permanently');
    if (after && before.baseRole !== after.baseRole) invalid('Create a new role ID to change its protected baseline');
  }
  return next;
}
function modelOperations(draft, account, existingOperations) {
  // Owner/security decisions stay with existing admission, outside this model.
  // Missing policy passes baseline through exactly; no configured defaults saved.
  if (account.role === 'owner') return existingOperations;
  if (draft === undefined) return account.customRoleId != null ? [] : existingOperations;
  if (!BUILT_IN_ROLES.includes(account.role)) return [];
  let policy;
  try { policy = validateDraft(draft); } catch { return []; }
  if (account.companyId !== policy.companyId) return [];
  let custom = null;
  if (account.customRoleId != null) {
    custom = policy.customRoles.find(row => row.id === account.customRoleId);
    if (!custom || custom.baseRole !== account.role) return [];
  }
  const denied = new Set(policy.builtInRoles[account.role].deniedOperations), chosen = custom && new Set(custom.allowedOperations);
  const filtered = existingOperations.filter(id => byId.get(id)?.roles.includes(account.role) && !denied.has(id) && (!chosen || chosen.has(id)));
  const available = new Set(filtered);
  return filtered.filter(id => byId.get(id).requires.every(required => available.has(required)));
}
module.exports = { BUILT_IN_ROLES, OPERATIONS, emptyDraft, validateDraft, validateRevision, modelOperations };
