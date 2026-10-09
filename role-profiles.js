'use strict';
// Restrictive named profiles. Stored role, grants and resource scopes remain authoritative.
const OFFICE_ID = 'office-profile-v1', SCOPE = 'existing-role-and-assignments', MAX_PROFILES = 50, MAX_ASSIGNMENTS = 1000, MAX_RETIRED = 1000;
const fail = (statusCode, message) => { throw Object.assign(Error(message), { statusCode }); };
const object = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key));
const integer = value => Number.isSafeInteger(value) && value >= 1 && value < Number.MAX_SAFE_INTEGER - 1;
const customId = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const profileId = value => value === OFFICE_ID || customId(value);
const labelKey = value => value.normalize('NFKC').toLocaleLowerCase('en-US');
const reservedNames = new Set(['office', 'owner', 'account owner', 'admin', 'project manager', 'project_manager', 'foreman', 'field', 'crew', 'platform', 'platform owner', 'security', 'billing']);
function name(value, office = false) {
  if (typeof value !== 'string' || value !== value.trim() || !value.length || value.length > 60 || /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(value) || (office ? value !== 'Office' : reservedNames.has(labelKey(value)))) fail(400, 'Use a distinct profile name of 1 to 60 characters');
  return value;
}
const registry = () => require('./capability-registry');
const ids = () => require('./notes-access');
const normalizeRole = role => role === 'office' ? 'admin' : role;
let evaluation;
function capabilities(value, baseRole) {
  const { families, roles } = registry();
  if (!roles.includes(baseRole) || !object(value, families.map(row => row[0]))) fail(400, 'Choose one existing base role and exactly the six typed capability families');
  for (const [id, , , , module] of families) {
    try { module.validatePolicy({ version: 1, revision: 1, roles: Object.fromEntries(roles.map(role => [role, role === baseRole ? value[id] : module.ceiling(role)])) }); }
    catch { fail(400, 'Profile actions must obey the base role ceilings and view dependencies'); }
  }
  return structuredClone(value);
}
const OFFICE_INITIAL_ACTIONS = Object.freeze(['scheduling.view', 'timeOff.viewRequests', 'timeReview.viewCards', 'timeWrite.viewPayroll', 'timeWrite.viewActivities', 'daily.viewReports', 'daily.viewWorkdays', 'notes.view']);
function defaults(baseRole, officeInitial = false) {
  return Object.fromEntries(registry().families.map(([id, , , , module]) => [id, Object.fromEntries(Object.entries(module.ceiling(baseRole)).map(([action, allowed]) => [action, allowed && (!officeInitial || OFFICE_INITIAL_ACTIONS.includes(id + '.' + action))]))]));
}
function validateModel(model) {
  if (!object(model, ['version', 'revision', 'profiles', 'assignments', 'retiredIds']) || model.version !== 1 || !integer(model.revision) || !Array.isArray(model.profiles) || model.profiles.length > MAX_PROFILES || !Array.isArray(model.assignments) || model.assignments.length > MAX_ASSIGNMENTS || !Array.isArray(model.retiredIds) || model.retiredIds.length > MAX_RETIRED) fail(409, 'Named role profiles need reconciliation');
  const active = new Set(), names = new Set();
  for (const row of model.profiles) {
    if (!object(row, ['id', 'name', 'kind', 'baseRole', 'scopeInheritance', 'revision', 'capabilities']) || !profileId(row.id) || active.has(row.id) || !['office', 'custom'].includes(row.kind) || row.kind === 'office' && (row.id !== OFFICE_ID || row.baseRole !== 'admin') || row.kind === 'custom' && !customId(row.id) || row.scopeInheritance !== SCOPE || !integer(row.revision)) fail(409, 'Profile identity or immutable scope needs reconciliation');
    try { name(row.name, row.kind === 'office'); capabilities(row.capabilities, row.baseRole); } catch { fail(409, 'Profile actions or name need reconciliation'); }
    const key = labelKey(row.name); if (names.has(key)) fail(409, 'Profile names need reconciliation'); names.add(key); active.add(row.id);
  }
  if (model.retiredIds.some(id => !customId(id) || active.has(id)) || new Set(model.retiredIds).size !== model.retiredIds.length) fail(409, 'Retired profile identities need reconciliation');
  const accounts = new Set();
  for (const row of model.assignments) {
    if (!object(row, ['accountId', 'profileId']) || !integer(row.accountId) || accounts.has(row.accountId) || !active.has(row.profileId)) fail(409, 'Profile assignment identity needs reconciliation'); accounts.add(row.accountId);
  }
  return model;
}
const required = db => Boolean(db.company?.roleProfilesRequired || Object.hasOwn(db.company || {}, 'roleProfiles'));
function resolve(db) {
  if (!required(db)) return null;
  if (db.company?.roleProfilesRequired !== true || !Object.hasOwn(db.company, 'roleProfiles')) fail(409, 'Required named role profiles are missing');
  const model = validateModel(db.company.roleProfiles);
  if (!Array.isArray(db.users) || db.users.length > 10000) fail(409, 'Profile accounts need reconciliation');
  const users = new Map();
  for (const user of db.users) {
    if (!ids().numericId(user?.id) || users.has(Number(user.id))) fail(409, 'Profile account identities need reconciliation');
    users.set(Number(user.id), user);
  }
  for (const assignment of model.assignments) {
    const user = users.get(assignment.accountId);
    if (!user || user.companyId != null && user.companyId !== db.company.id) fail(409, 'Profile account binding needs reconciliation');
    if (user.role === 'owner' || !registry().roles.includes(normalizeRole(user.role))) fail(409, 'Protected accounts cannot carry named profiles');
  }
  return { model, users, assignments: new Map(model.assignments.map(row => [row.accountId, row])), profiles: new Map(model.profiles.map(row => [row.id, row])) };
}
function evidence(db) {
  if (evaluation?.db === db) { if (evaluation.error) throw evaluation.error; return evaluation.value; }
  return resolve(db);
}
function read(db) { return evidence(db)?.model || null; }
// Reuse validated evidence only during one synchronous, read-only evaluation.
// No cache survives an await, a candidate mutation, or a later request.
function evaluate(db, fn) {
  if (evaluation?.db === db || !required(db)) return fn();
  const previous = evaluation; let value, error;
  try { value = resolve(db); } catch (caught) { error = caught; }
  evaluation = { db, value, error };
  try { const result = fn(); if (typeof result?.then === 'function') throw Error('Profile evaluation must be synchronous'); return result; }
  finally { evaluation = previous; }
}
function binding(db, user) {
  if (user?.role === 'owner') return { state: 'protected' };
  if (!required(db)) return { state: 'none' };
  try {
    const { users, assignments, profiles } = evidence(db), assignment = assignments.get(Number(user?.id));
    if (!assignment) return { state: 'none' };
    const stored = users.get(Number(user.id)), profile = profiles.get(assignment.profileId);
    const state = normalizeRole(stored.role) !== profile.baseRole || normalizeRole(user.role) !== profile.baseRole ? 'role-mismatch' : stored.status === 'Active' ? 'assigned' : 'inactive';
    return { state, id: profile.id, name: profile.name, kind: profile.kind, baseRole: profile.baseRole, profileRevision: profile.revision, scopeInheritance: SCOPE };
  } catch { return { state: 'invalid' }; }
}
function restrict(db, user, family, current) {
  if (user?.role === 'owner' || !required(db)) return current;
  const mark = binding(db, user);
  if (mark.state === 'none') return current;
  if (mark.state !== 'assigned') return Object.fromEntries(Object.keys(current).map(action => [action, false]));
  const profile = read(db).profiles.find(row => row.id === mark.id);
  return Object.fromEntries(Object.entries(current).map(([action, allowed]) => [action, allowed && profile.capabilities[family][action]]));
}
function parseChange(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail(400, 'Choose a named profile operation');
  const shapes = { createOffice: ['operation'], create: ['operation', 'profileId', 'name', 'baseRole', 'capabilities'], edit: ['operation', 'profileId', 'expectedProfileRevision', 'name', 'capabilities'], delete: ['operation', 'profileId', 'expectedProfileRevision'], assign: ['operation', 'accountId', 'profileId'] };
  if (typeof input.operation !== 'string' || !Object.hasOwn(shapes, input.operation) || !object(input, shapes[input.operation])) fail(400, 'Use only the typed profile operation fields');
  if (input.operation === 'create') { if (!customId(input.profileId)) fail(400, 'Use a new canonical custom profile ID'); name(input.name); capabilities(input.capabilities, input.baseRole); }
  if (['edit', 'delete'].includes(input.operation) && (!profileId(input.profileId) || !integer(input.expectedProfileRevision))) fail(400, 'Use the current profile ID and revision');
  if (input.operation === 'edit') { name(input.name, input.profileId === OFFICE_ID); if (!object(input.capabilities, registry().families.map(row => row[0]))) fail(400, 'Use the six typed profile families'); }
  if (input.operation === 'assign' && (!integer(input.accountId) || input.profileId !== null && !profileId(input.profileId))) fail(400, 'Choose an existing account and profile, or explicitly remove its profile');
  return structuredClone(input);
}
function plan(db, input) {
  const change = parseChange(input), current = read(db), model = current ? structuredClone(current) : { version: 1, revision: 0, profiles: [], assignments: [], retiredIds: [] };
  const existing = model.profiles.find(row => row.id === change.profileId);
  if (['edit', 'delete'].includes(change.operation) && (!existing || existing.revision !== change.expectedProfileRevision)) fail(409, 'Profile changed or was retired; refresh before previewing');
  if (change.operation === 'createOffice' || change.operation === 'create') {
    const id = change.operation === 'createOffice' ? OFFICE_ID : change.profileId;
    if (model.profiles.some(row => row.id === id) || model.retiredIds.includes(id)) fail(409, 'This profile ID exists or was retired');
    const office = change.operation === 'createOffice', baseRole = office ? 'admin' : change.baseRole;
    model.profiles.push({ id, name: office ? 'Office' : change.name, kind: office ? 'office' : 'custom', baseRole, scopeInheritance: SCOPE, revision: 1, capabilities: office ? defaults('admin', true) : change.capabilities });
  } else if (change.operation === 'edit') {
    const next = capabilities(change.capabilities, existing.baseRole);
    if (existing.name === change.name && require('./database/transactional-repository').canonicalHash(existing.capabilities) === require('./database/transactional-repository').canonicalHash(next)) fail(400, 'No profile change to preview');
    existing.name = change.name; existing.capabilities = next; existing.revision++;
  } else if (change.operation === 'delete') {
    if (model.assignments.some(row => row.profileId === existing.id)) fail(409, 'Profile is assigned. Explicitly reassign or remove every affected account profile first');
    if (existing.kind === 'office') fail(400, 'Office is a protected named profile; edit its limits instead of retiring its identity');
    model.profiles = model.profiles.filter(row => row.id !== existing.id); model.retiredIds.push(existing.id);
  } else {
    const previous = model.assignments.find(row => row.accountId === change.accountId);
    if (change.profileId === null) { if (!previous) fail(400, 'This account has no profile to remove'); }
    else {
      const user = ids().uniqueNumeric(db.users, change.accountId, 'Profile account', db.company.id);
      if (!registry().roles.includes(normalizeRole(user.role)) || !existing || normalizeRole(user.role) !== existing.baseRole) fail(400, 'Profiles require the same existing base role; owner and platform accounts stay protected');
      if (previous?.profileId === change.profileId) fail(400, 'This account already has that profile');
    }
    model.assignments = model.assignments.filter(row => row.accountId !== change.accountId);
    if (change.profileId !== null) model.assignments.push({ accountId: change.accountId, profileId: change.profileId });
  }
  model.revision++; validateModel(model);
  return { ...db, company: { ...db.company, roleProfiles: model, roleProfilesRequired: true } };
}
function validateDescriptor(value) {
  if (object(value, ['state']) && ['none', 'protected', 'invalid'].includes(value.state)) return;
  if (!object(value, ['state', 'id', 'name', 'kind', 'baseRole', 'profileRevision', 'scopeInheritance']) || !['assigned', 'role-mismatch', 'inactive'].includes(value.state) || !profileId(value.id) || !['office', 'custom'].includes(value.kind) || !registry().roles.includes(value.baseRole) || !integer(value.profileRevision) || value.scopeInheritance !== SCOPE) fail(409, 'Profile impact needs reconciliation');
  try { name(value.name, value.kind === 'office'); } catch { fail(409, 'Profile impact name needs reconciliation'); }
  if (value.kind === 'office' && (value.id !== OFFICE_ID || value.baseRole !== 'admin') || value.kind === 'custom' && !customId(value.id)) fail(409, 'Profile impact identity needs reconciliation');
}
function authority(db, user) {
  try { return { revision: read(db).revision, profile: binding(db, user) }; }
  catch (error) {
    if (user?.role !== 'owner') throw error;
    return { revision: -1, profile: { state: 'protected' }, invalidModelHash: require('./database/transactional-repository').canonicalHash({ required: db.company.roleProfilesRequired ?? null, present: Object.hasOwn(db.company, 'roleProfiles'), model: db.company.roleProfiles ?? null }) };
  }
}
module.exports = { OFFICE_ID, SCOPE, OFFICE_INITIAL_ACTIONS, MAX_PROFILES, MAX_ASSIGNMENTS, MAX_RETIRED, required, read, evaluate, authority, validateModel, normalizeRole, capabilities, defaults, binding, restrict, parseChange, plan, validateDescriptor };
