'use strict';
const registry = require('./capability-registry');
const crypto = require('node:crypto');
const identities = require('./notes-access');
const fail = (statusCode, message) => { throw Object.assign(Error(message), { statusCode }); };
const text = (value, limit = 5000) => typeof value === 'string' && value.length <= limit;
const grantKeys = Object.freeze(['scheduleCrews', 'viewTime', 'manageTime', 'viewDailies', 'approveDailies']);
function scopeList(value, numeric) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 10000 || value.some(item => numeric ? !identities.numericId(item) : !text(item, 120)) || new Set(value.map(item => numeric ? Number(item) : item)).size !== value.length) fail(409, 'Account scope needs reconciliation');
  return value.map(item => numeric ? Number(item) : item);
}
function authority(db, user) {
  if (!text(user?.name) || !text(user.role, 64) || !text(user.status, 64) || user.companyId != null && user.companyId !== db.company.id) fail(409, 'Account authority needs reconciliation');
  if (user.memberId != null && !identities.numericId(user.memberId)) fail(409, 'Account member identity needs reconciliation');
  scopeList(user.projectIds, true); scopeList(user.assignedCrews, false);
  if (user.permissions != null && (typeof user.permissions !== 'object' || Array.isArray(user.permissions))) fail(409, 'Stored account grants need reconciliation');
  for (const key of grantKeys) if (Object.hasOwn(user.permissions || {}, key) && typeof user.permissions[key] !== 'boolean') fail(409, 'Stored account grant needs reconciliation');
  // Atomic business handlers use Number-based crew/project projections. Global
  // canonical tenant identity evidence must agree before projecting authority.
  for (const row of db.team || []) if (row.crew != null && !text(row.crew, 120)) fail(409, 'Team crew scope needs reconciliation');
  for (const [rows, name] of [[db.team, 'Team member'], [db.projects, 'Project']]) for (const row of rows || []) identities.uniqueNumeric(rows, row.id, name, db.company.id);
}
function sessionUser(db, tokenHash) {
  const matches = (db.sessions || []).filter(row => row.tokenHash === tokenHash);
  if (matches.length > 1) fail(409, 'Session identity needs reconciliation');
  if (!matches.length || !(new Date(matches[0].expiresAt) > new Date())) return { status: 401 };
  const session = matches[0]; if (session.companyId !== db.company.id) return { status: 404 };
  let user; try { user = identities.uniqueNumeric(db.users, session.userId, 'Signed-in account', db.company.id); } catch (error) { if (error.statusCode === 404) return { status: 401 }; throw error; }
  if (user.status !== 'Active') return { status: 401 };
  authority(db, user);
  return { session, user, status: 200 };
}
function authenticate(req, db, assemble, tokenFor) {
  req.auth = null;
  const token = tokenFor(req); if (typeof token !== 'string' || !token) return { auth: null, status: 401 };
  const binding = sessionUser(db, crypto.createHash('sha256').update(token).digest('hex'));
  return binding.user ? assemble(req, db) : { auth: null, status: binding.status };
}
function dto(db, storedUser, { current = false, directory = false } = {}) {
  identities.uniqueNumeric(db.users, storedUser?.id, 'Account', db.company.id);
  const user = registry.normalize(storedUser);
  if (!text(user.name) || !text(user.email ?? '') || !text(user.role, 64) || !text(user.status, 64) || user.companyId != null && user.companyId !== db.company.id) fail(409, 'Account projection needs reconciliation');
  authority(db, user);
  if (user.emailVerifiedAt != null && (!text(user.emailVerifiedAt, 100) || !Number.isFinite(Date.parse(user.emailVerifiedAt))) || user.preferredLanguage != null && !text(user.preferredLanguage, 64)) fail(409, 'Account attributes need reconciliation');
  const permissions = {};
  for (const key of grantKeys) if (Object.hasOwn(user.permissions || {}, key)) {
    if (typeof user.permissions[key] !== 'boolean') fail(409, 'Stored account grant needs reconciliation');
    permissions[key] = user.permissions[key];
  }
  const preferences = {};
  if (!directory) for (const key of ['displayName', 'theme', 'profilePhoto', 'scheduleCrew', 'scheduleShowOffice']) if (Object.hasOwn(user.preferences || {}, key)) {
    const value = user.preferences[key];
    if (key === 'scheduleShowOffice' ? typeof value !== 'boolean' : !text(value, key === 'profilePhoto' ? 2100000 : key === 'displayName' ? 100 : key === 'scheduleCrew' ? 60 : 20)) fail(409, 'Account preference needs reconciliation');
    if (key === 'theme' && !['light', 'dark', 'system'].includes(value) || key === 'profilePhoto' && value && !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=\r\n]+$/.test(value)) fail(409, 'Account preference needs reconciliation');
    preferences[key] = value;
  }
  let scopeState = 'resolved';
  const resolve = (rows, id, name) => { try { identities.uniqueNumeric(rows, id, name, db.company.id); } catch (error) { if (error.statusCode !== 404) throw error; scopeState = 'unresolved'; } };
  if (user.role === 'project_manager') for (const id of scopeList(user.projectIds, true)) resolve(db.projects, id, 'Assigned project');
  if (['field', 'foreman'].includes(user.role)) { if (user.memberId == null) scopeState = 'unresolved'; else resolve(db.team, user.memberId, 'Linked account member'); }
  // These are the actual typed action gates. Resource scope remains a separate
  // server decision; a missing assignment must not invent a UI-only denial.
  const effectiveCapabilities = registry.effective(db, user), states = registry.policyState(db);
  const result = { id: Number(user.id), name: user.name, email: user.email || '', emailVerifiedAt: user.emailVerifiedAt || null,
    role: current && user.role === 'foreman' ? 'field' : user.role, accessRole: user.role, companyId: db.company.id,
    memberId: user.memberId == null ? null : Number(user.memberId), projectIds: scopeList(user.projectIds, true), assignedCrews: scopeList(user.assignedCrews, false),
    status: user.status, preferredLanguage: user.preferredLanguage || 'en', permissions, storedPermissions: { ...permissions },
    effectiveCapabilities, capabilityPolicyState: states, immutableAccess: registry.immutable(db, user), scopeState,
    availability: user.status !== 'Active' ? 'inactive' : !['owner', ...registry.roles].includes(user.role) ? 'unsupported-role' : 'active' };
  if (registry.profilesRequired(db)) result.roleProfile = require('./role-profiles').binding(db, user);
  for (const [id, , , property] of registry.families) result[property] = effectiveCapabilities[id];
  result.notesPolicyRevision = states.notes.state === 'invalid' || states.notes.state === 'required-missing' ? -1 : states.notes.revision;
  if (directory) result.baselineCapabilities = registry.baseline(db, user); else result.preferences = preferences;
  return result;
}
function directory(db) {
  return require('./role-profiles').evaluate(db, () => (db.users || []).map(user => dto(db, user, { directory: true })));
}
function createHandler({ readDb, writeDb, authenticate, token, flags, json, jsonHeaders, assertCurrent, accountAccess }) {
  return async function handle(req, res, url) {
    if (req.method !== 'GET' || !['/api/auth/me', '/api/users', '/api/company/role-capabilities', '/api/account-access'].includes(url.pathname)) return false;
    try {
      const db = readDb(), { auth, status } = module.exports.authenticate(req, db, authenticate, token);
      if (!auth) fail(status, 'Authentication required');
      const current = url.pathname === '/api/auth/me', account = url.pathname === '/api/account-access', recovery = current || account;
      if (!recovery && auth.user.role !== 'owner') fail(403, 'Account owner permission required');
      if (!recovery && accountAccess(db.company).locked) fail(402, 'Company account is locked');
      let data = current ? { ...dto(db, auth.user, { current: true }), ...flags() } : account ? null : url.pathname === '/api/users' ? directory(db) : registry.describe(db);
      await assertCurrent(req, recovery);
      // Natural trial expiry need not change the SQL revision. Recovery remains
      // available, but its lock state must be computed after the delivery fence.
      if (recovery) { const access = accountAccess(db.company); if (current) data.accountLocked = access.locked; else data = access; }
      if (current) {
        // Keep the existing signed-in bootstrap/renewal contract, including locked
        // account recovery. The original session must still be alive before CAS.
        const seconds = 30 * 86400, secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
        auth.session.expiresAt = new Date(Date.now() + seconds * 1000).toISOString(); writeDb(db);
        jsonHeaders(res, 200, data, { 'Set-Cookie': [`pdl_session=${token(req)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${seconds}${secure}`, `pdl_company=${db.company.id}; SameSite=Strict; Path=/; Max-Age=${seconds}${secure}`] });
      } else json(res, 200, data);
      return true;
    } catch (error) { if (![401, 402, 403, 404, 409].includes(error.statusCode)) throw error; json(res, error.statusCode, { error: error.message }); return true; }
  };
}
module.exports = { sessionUser, authenticate, dto, directory, createHandler };
