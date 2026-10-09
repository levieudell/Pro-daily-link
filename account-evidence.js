'use strict';
// Canonical security evidence for the quarantined compatibility source slice.
// This does not normalize or grant authority to an ambiguous legacy record.
const ROLES = new Set(['owner', 'admin', 'office', 'project_manager', 'foreman', 'field']);
const FLAGS = new Set(['scheduleCrews', 'viewTime', 'manageTime', 'viewDailies', 'approveDailies']);
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const id = value => Number.isSafeInteger(value) && value > 0;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const failure = () => Object.assign(Error('Canonical account evidence is required.'), { code: 'PDL_COMPAT_ACCOUNT_EVIDENCE', statusCode: 503 });
function validateAccounts(db) {
  if (!uuid(db?.company?.id) || !Array.isArray(db.users)) throw failure();
  const ids = new Set(), addresses = new Set();
  for (const user of db.users) {
    if (!object(user) || !id(user.id) || ids.has(user.id) || typeof user.name !== 'string' || typeof user.email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(user.email) || !ROLES.has(user.role) || !['Active', 'Deactivated', 'Inactive'].includes(user.status) || user.companyId !== undefined && user.companyId !== db.company.id) throw failure();
    const address = user.email.trim().toLowerCase();
    if (addresses.has(address)) throw failure(); ids.add(user.id); addresses.add(address);
    if (user.memberId !== undefined && user.memberId !== null && !id(user.memberId)) throw failure();
    if (user.projectIds !== undefined && (!Array.isArray(user.projectIds) || user.projectIds.some(value => !id(value)) || new Set(user.projectIds).size !== user.projectIds.length)) throw failure();
    if (user.assignedCrews !== undefined && (!Array.isArray(user.assignedCrews) || user.assignedCrews.some(value => typeof value !== 'string' || !value.trim()) || new Set(user.assignedCrews).size !== user.assignedCrews.length)) throw failure();
    if (user.permissions !== undefined && (!object(user.permissions) || Object.entries(user.permissions).some(([name, value]) => !FLAGS.has(name) || typeof value !== 'boolean'))) throw failure();
    if (user.mustSetPassword !== undefined && typeof user.mustSetPassword !== 'boolean') throw failure();
    for (const name of ['passwordHash', 'passwordSalt', 'setupHash', 'setupSalt', 'resetTokenHash', 'emailVerificationTokenHash', 'accountResetGeneration']) if (user[name] !== undefined && (typeof user[name] !== 'string' || !user[name])) throw failure();
  }
  const sessions = db.sessions === undefined ? [] : db.sessions, sessionIds = new Set(), hashes = new Set();
  if (!Array.isArray(sessions)) throw failure();
  for (const session of sessions) {
    if (!object(session) || !uuid(session.id) || sessionIds.has(session.id) || typeof session.tokenHash !== 'string' || !/^[0-9a-f]{64}$/.test(session.tokenHash) || hashes.has(session.tokenHash) || !id(session.userId) || !ids.has(session.userId) || session.companyId !== db.company.id || typeof session.expiresAt !== 'string' || !Number.isFinite(Date.parse(session.expiresAt)) || session.createdAt !== undefined && (typeof session.createdAt !== 'string' || !Number.isFinite(Date.parse(session.createdAt)))) throw failure();
    sessionIds.add(session.id); hashes.add(session.tokenHash);
  }
  return db;
}
module.exports = { validateAccounts };
