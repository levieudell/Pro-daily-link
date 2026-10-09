'use strict';
// Manual temporary passwords are separate from email custody and safe receipts.
const crypto = require('node:crypto');
const { canonicalHash } = require('./database/transactional-repository');
const { validateAccounts } = require('./account-evidence');
const COLLECTION = 'accountSecretEnvelopes';
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const fail = () => Object.assign(Error('This temporary password requires current owner recovery.'), { statusCode: 409, code: 'PDL_COMPAT_SECRET_RECOVERY' });
const fingerprint = (db, user) => canonicalHash({ id: user.id, email: user.email, role: user.role, status: user.status, memberId: user.memberId ?? null, projectIds: user.projectIds ?? [], assignedCrews: user.assignedCrews ?? [], permissions: user.permissions ?? {}, mustSetPassword: user.mustSetPassword === true, setupHash: user.setupHash ?? null, setupSalt: user.setupSalt ?? null, setupExpiresAt: user.setupExpiresAt ?? null, setupGeneration: user.setupGeneration ?? null, effective: require('./capability-registry').effective(db, user), profile: require('./role-profiles').required(db) ? require('./role-profiles').authority(db, user) : null });
function rows(db) {
  const value = db[COLLECTION] === undefined ? [] : db[COLLECTION], ids = new Set();
  const names = ['id', 'companyId', 'ownerId', 'sessionId', 'sessionHash', 'operationId', 'targetId', 'generation', 'targetFingerprint', 'createdAt', 'expiresAt', 'custody', 'status', 'keyVersion'];
  if (!Array.isArray(value)) throw fail();
  for (const row of value) {
    if (!row || Array.isArray(row) || Object.keys(row).some(name => !names.includes(name)) || !uuid(row.id) || ids.has(row.id) || !uuid(row.operationId) || !uuid(row.sessionId) || !uuid(row.generation) || row.companyId !== db.company.id || !Number.isSafeInteger(row.ownerId) || row.ownerId < 1 || !Number.isSafeInteger(row.targetId) || row.targetId < 1 || !/^[a-f0-9]{64}$/.test(row.sessionHash) || !/^[a-f0-9]{64}$/.test(row.targetFingerprint) || !Number.isFinite(Date.parse(row.createdAt)) || !Number.isFinite(Date.parse(row.expiresAt)) || !['available', 'invalidated'].includes(row.status)) throw fail();
    ids.add(row.id);
    if (typeof row.keyVersion !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(row.keyVersion) || row.status === 'invalidated' && row.custody !== undefined) throw fail();
  }
  return value;
}
function aad(row) { return Buffer.from(JSON.stringify([1, row.keyVersion, row.id, row.companyId, row.ownerId, row.sessionId, row.sessionHash, row.operationId, row.targetId, row.generation, row.targetFingerprint, row.expiresAt])); }
function createSecretRecovery({ key, keyVersion = 'synthetic-manual-v1', clock = Date.now }) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw fail();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(keyVersion)) throw fail();
  function enclose(db, auth, operationId, user, secret) {
    validateAccounts(db); rows(db);
    if (auth.user.role !== 'owner' || !uuid(operationId) || !uuid(auth.session.id) || typeof secret !== 'string' || !/^[A-Za-z0-9_-]{8}$/.test(secret) || user.status !== 'Active' || user.mustSetPassword !== true || Date.parse(user.setupExpiresAt) <= clock()) throw fail();
    invalidate(db, user.id); user.setupGeneration = crypto.randomUUID(); user.setupIssuedEmail = user.email;
    const row = { id: crypto.randomUUID(), keyVersion, companyId: db.company.id, ownerId: auth.user.id, sessionId: auth.session.id, sessionHash: auth.session.tokenHash, operationId, targetId: user.id, generation: user.setupGeneration, targetFingerprint: fingerprint(db, user), createdAt: new Date(clock()).toISOString(), expiresAt: user.setupExpiresAt, status: 'available' };
    const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(aad(row));
    const bytes = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]); row.custody = { version: 1, iv: iv.toString('base64url'), ciphertext: bytes.toString('base64url'), tag: cipher.getAuthTag().toString('base64url') };
    db[COLLECTION] = [...rows(db), row]; return row.id;
  }
  function recover(db, auth, operationId) {
    validateAccounts(db); if (!uuid(operationId) || auth?.user.role !== 'owner' || auth.user.status !== 'Active' || auth.companyId !== db.company.id || Date.parse(auth.session.expiresAt) <= clock()) throw fail();
    const matches = rows(db).filter(row => row.operationId === operationId);
    if (matches.length !== 1) throw fail(); const row = matches[0], user = db.users.find(value => value.id === row.targetId);
    if (row.keyVersion !== keyVersion || row.status !== 'available' || row.ownerId !== auth.user.id || row.sessionId !== auth.session.id || row.sessionHash !== auth.session.tokenHash || !user || user.status !== 'Active' || user.setupGeneration !== row.generation || user.setupIssuedEmail !== user.email || fingerprint(db, user) !== row.targetFingerprint || Date.parse(row.expiresAt) <= clock()) throw fail();
    const custody = row.custody;
    if (!custody || custody.version !== 1 || Object.keys(custody).sort().join(',') !== 'ciphertext,iv,tag,version') throw fail();
    try { const iv = Buffer.from(custody.iv, 'base64url'), tag = Buffer.from(custody.tag, 'base64url'), bytes = Buffer.from(custody.ciphertext, 'base64url'); if (iv.length !== 12 || tag.length !== 16 || bytes.length !== 8) throw fail(); const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv); decipher.setAAD(aad(row)); decipher.setAuthTag(tag); const secret = Buffer.concat([decipher.update(bytes), decipher.final()]).toString('utf8'); if (!/^[A-Za-z0-9_-]{8}$/.test(secret)) throw fail(); return { temporaryPassword: secret, expiresAt: row.expiresAt }; } catch { throw fail(); }
  }
  function invalidate(db, targetId) { for (const row of rows(db)) if (row.targetId === targetId) { row.status = 'invalidated'; delete row.custody; } }
  return { enclose, recover, invalidate, invalidationImpact: (db, targetId) => rows(db).filter(row => row.targetId === targetId && row.status === 'available').length };
}
module.exports = { COLLECTION, createSecretRecovery, fingerprint };
