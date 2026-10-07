'use strict';

// Restriction caps, never an alternate source of grants or resource scope.
const crypto = require('node:crypto');
const CAPABILITIES = Object.freeze([
  { key: 'scheduleCrews', label: 'Create and edit crew schedules' },
  { key: 'viewDailies', label: 'View assigned daily reports' },
  { key: 'approveDailies', label: 'Approve assigned daily reports' },
  { key: 'viewTime', label: 'View assigned time records' },
  { key: 'manageTime', label: 'Create, correct and approve assigned time records' }
]);
const keys = CAPABILITIES.map(row => row.key);
const defaults = () => Object.fromEntries(keys.map(key => [key, true]));
function problem(message, statusCode = 400) { return Object.assign(new Error(message), { statusCode }); }
function exactObject(value, allowed) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => allowed.includes(key));
}
function validateCaps(value) {
  if (!exactObject(value, keys) || keys.some(key => !Object.hasOwn(value, key) || typeof value[key] !== 'boolean')) throw problem('Choose a valid restriction for each supported Project Manager capability.');
  if (!value.viewDailies && value.approveDailies || !value.viewTime && value.manageTime) throw problem('Block approval or management when the related view permission is blocked.');
  return Object.fromEntries(keys.map(key => [key, value[key]]));
}
function policy(company = {}) {
  const raw = company.roleRestrictions;
  if (raw === undefined) return { schemaVersion: 1, revision: 0, projectManager: defaults(), valid: true };
  try {
    if (!exactObject(raw, ['schemaVersion', 'revision', 'projectManager']) || raw.schemaVersion !== 1 || !Number.isSafeInteger(raw.revision) || raw.revision < 1 || raw.revision >= Number.MAX_SAFE_INTEGER) throw problem('Invalid stored restrictions.');
    return { schemaVersion: 1, revision: raw.revision, projectManager: validateCaps(raw.projectManager), valid: true };
  } catch {
    // Corrupt policy cannot remove owner access or enable any new permission.
    return { schemaVersion: 1, revision: null, projectManager: Object.fromEntries(keys.map(key => [key, false])), valid: false };
  }
}
function effectiveUser(company, user) {
  if (!user || user.role !== 'project_manager' || company?.roleRestrictions === undefined) return user;
  const caps = policy(company).projectManager, grants = user.permissions || {};
  const viewDailies = caps.viewDailies && (grants.viewDailies === true || grants.approveDailies === true);
  const viewTime = caps.viewTime && (grants.viewTime === true || grants.manageTime === true);
  return { ...user, permissions: { ...grants,
    scheduleCrews: caps.scheduleCrews && grants.scheduleCrews === true,
    viewDailies, approveDailies: viewDailies && caps.approveDailies && grants.approveDailies === true,
    viewTime, manageTime: viewTime && caps.manageTime && grants.manageTime === true
  } };
}
function baseline(user) {
  const grants = user.permissions || {};
  return { scheduleCrews: grants.scheduleCrews === true,
    viewDailies: grants.viewDailies === true || grants.approveDailies === true, approveDailies: grants.approveDailies === true,
    viewTime: grants.viewTime === true || grants.manageTime === true, manageTime: grants.manageTime === true };
}
function impact(db, caps) {
  const proposed = { roleRestrictions: { schemaVersion: 1, revision: 1, projectManager: caps } };
  return (db.users || []).filter(user => user.role === 'project_manager' && user.status === 'Active' && (!user.companyId || user.companyId === db.company.id)).map(user => {
    const before = baseline(effectiveUser(db.company, user)), after = baseline(effectiveUser(proposed, user));
    return { id: user.id, name: user.name, before, after, changes: keys.filter(key => before[key] !== after[key]) };
  });
}
function governedMutation(method, pathname) {
  return ['POST', 'PATCH', 'PUT', 'DELETE'].includes(method) && (
    /^\/api\/assignments(?:\/\d+)?$/.test(pathname) ||
    /^\/api\/reports(?:\/\d+(?:\/(?:approve|disposition|safety))?)?$/.test(pathname) ||
    /^\/api\/workdays\//.test(pathname) ||
    /^\/api\/time-cards(?:\/[^/]+(?:\/(?:approve|unapprove|submit))?)?$/.test(pathname) ||
    /^\/api\/time-off-requests\/[^/]+\/(?:approve|decline)$/.test(pathname) ||
    pathname === '/api/company-activities' || pathname.startsWith('/api/pay-periods') || pathname.startsWith('/api/company/role-restrictions')
  );
}
function blockedRoute(company, user, method, pathname) {
  if (user?.role !== 'project_manager' || company?.roleRestrictions === undefined) return false;
  const caps = policy(company).projectManager;
  // Existing aggregate routes are separate from /state. Deny their report data too.
  if (!caps.viewDailies && (pathname === '/api/reports' || /^\/api\/reports\/\d+/.test(pathname) ||
    ['/api/insights', '/api/exceptions', '/api/production', '/api/catalog'].includes(pathname) ||
    /^\/api\/projects\/\d+\/tm-summary$/.test(pathname) || pathname.startsWith('/api/reporting-exports') ||
    /^\/api\/workdays\/\d+\/end$/.test(pathname))) return true;
  // Office workday helpers create or close time records and must not bypass the cap.
  if (!caps.manageTime && method !== 'GET' && pathname.startsWith('/api/workdays/')) return true;
  return false;
}
function createHandler({ readDb, writeDb, body, json, authenticatedUser, sessionBinding, accountAccess, now = Date.now }) {
  // Ephemeral signatures require a new preview after a process restart. No saved grants.
  const secret = crypto.randomBytes(32), route = '/api/company/role-restrictions';
  const fingerprint = db => crypto.createHash('sha256').update(JSON.stringify([
    db.company.id, db.company.roleRestrictions, (db.users || []).map(user => [user.id, user.name, user.role, user.status, user.companyId, user.projectIds, user.assignedCrews, user.permissions])
  ])).digest('hex');
  function signature(db, user, binding, input, expiresAt) {
    return crypto.createHmac('sha256', secret).update(JSON.stringify([fingerprint(db), user.id, binding, input.revision, input.projectManager, input.reason, expiresAt])).digest('hex');
  }
  return async function handle(req, res, url) {
    if (url.pathname !== route && url.pathname !== route + '/preview') return false;
    let db = readDb(), user = authenticatedUser(req, db);
    const hintedCompany = String(req.headers['x-pdl-company'] || '').trim();
    if (hintedCompany && hintedCompany !== String(db.company.id)) { json(res, 403, { error: 'This session does not match the selected company.' }); return true; }
    if (!user || user.mustSetPassword || !['owner', 'admin'].includes(user.role)) { json(res, 403, { error: 'Sign in as the Account Owner or an Admin to review role restrictions.' }); return true; }
    const access = accountAccess(db.company);
    if (access.locked) { json(res, 402, { error: access.reason, code: 'subscription_required', access }); return true; }
    res.setHeader('Cache-Control', 'private, no-store');
    if (req.method === 'GET' && url.pathname === route) {
      const current = policy(db.company);
      json(res, 200, { ...current, canEdit: user.role === 'owner', capabilities: CAPABILITIES, users: impact(db, current.projectManager),
        history: (db.auditLog || []).filter(row => row.type === 'role_restrictions_changed').slice(-20).reverse() });
      return true;
    }
    if (user.role !== 'owner') { json(res, 403, { error: 'Only the Account Owner can change role restrictions.' }); return true; }
    if (db.company.emailVerificationRequiredAt && !user.emailVerifiedAt) { json(res, 403, { error: 'Confirm the Account Owner email before changing role restrictions.' }); return true; }
    if (!(req.method === 'POST' && url.pathname === route + '/preview' || req.method === 'PUT' && url.pathname === route)) { json(res, 405, { error: 'Use preview before confirming a restriction change.' }); return true; }
    try {
      const raw = await body(req);
      // Recheck identity after the body and reject role changes, expiration and tenant mismatch.
      db = readDb(); user = authenticatedUser(req, db);
      if (user?.role !== 'owner' || user.mustSetPassword) throw problem('Account Owner access is no longer active.', 403);
      if (!exactObject(raw, ['revision', 'projectManager', 'reason', ...(req.method === 'PUT' ? ['previewToken', 'expiresAt', 'confirm'] : [])])) throw problem('Unsupported role or capability.');
      const current = policy(db.company);
      if (!current.valid) throw problem('Stored restrictions need repair before editing. Project Manager capabilities are blocked.', 409);
      if (!Number.isSafeInteger(raw.revision) || raw.revision < 0) throw problem('A valid restriction revision is required.');
      if (raw.revision !== current.revision) throw problem('These restrictions changed. Refresh and preview again.', 409);
      const projectManager = validateCaps(raw.projectManager);
      if (typeof raw.reason !== 'string' || !raw.reason.trim() || raw.reason.length > 500) throw problem('Explain why these restrictions are changing (up to 500 characters).');
      const input = { revision: raw.revision, projectManager, reason: raw.reason.trim() }, binding = sessionBinding(req);
      if (!binding) throw problem('Authentication required.', 403);
      const changes = keys.filter(key => current.projectManager[key] !== projectManager[key]);
      if (!changes.length) throw problem('Choose a restriction change before previewing.');
      if (req.method === 'POST') {
        const expiresAt = now() + 5 * 60 * 1000;
        json(res, 200, { ...input, changes, users: impact(db, projectManager), expiresAt, previewToken: signature(db, user, binding, input, expiresAt) }); return true;
      }
      if (raw.confirm !== true) throw problem('Confirm the preview before saving.');
      if (!Number.isSafeInteger(raw.expiresAt) || raw.expiresAt <= now() || raw.expiresAt > now() + 5 * 60 * 1000 || typeof raw.previewToken !== 'string' || !/^[a-f0-9]{64}$/.test(raw.previewToken)) throw problem('This preview expired. Preview again.', 409);
      const expected = signature(db, user, binding, input, raw.expiresAt);
      if (!crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(raw.previewToken, 'hex'))) throw problem('The preview, users or their access changed. Preview again.', 409);
      const at = new Date(now()).toISOString(), next = { schemaVersion: 1, revision: current.revision + 1, projectManager };
      const audit = { id: crypto.randomUUID(), type: 'role_restrictions_changed', companyId: db.company.id, actor: user.name, actorId: user.id, detail: `Project Manager restrictions changed: ${changes.join(', ')}. Reason: ${input.reason}`, reason: input.reason, before: { schemaVersion: 1, revision: current.revision, projectManager: current.projectManager }, after: next, users: impact(db, projectManager), at };
      db.company.roleRestrictions = next; db.auditLog ||= []; db.auditLog.push(audit); writeDb(db);
      json(res, 200, { ...next, canEdit: true, audit }); return true;
    } catch (error) {
      if (!error.statusCode) throw error;
      json(res, error.statusCode, { error: error.message }); return true;
    }
  };
}
module.exports = { CAPABILITIES, policy, validateCaps, effectiveUser, impact, governedMutation, blockedRoute, createHandler };
