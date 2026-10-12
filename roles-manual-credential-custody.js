'use strict';
// Private original-code custody only. Callers authorize, commit this candidate
// with the credential, and fence delivery against fresh authority themselves.
// An attempted HTTP return does not consume custody or create provider evidence.
const crypto = require('node:crypto');
const COLLECTION = 'rolesManualCredentialCustody';
const PLATFORM_ID = '5a7f362f-e399-56e3-9458-e34b794a389d';
const FORMAT = 'pdl-roles-manual-v1', LIMIT = 1000, MAX_BYTES = 2 * 1024 * 1024;
const PURPOSES = ['platform-bootstrap', 'platform-staff-create', 'company-owner-reset'];
const PLATFORM_ROLES = ['platform_owner', 'customer_success', 'onboarding', 'support', 'billing', 'engineering'];
const FIELDS = ['format', 'keyVersion', 'id', 'companyId', 'operationId', 'purpose', 'requestHash', 'targetId', 'targetRole', 'targetName', 'targetEmail', 'targetFingerprint', 'scope', 'createdAt', 'expiresAt', 'custody', 'signature'];
const fail = (statusCode = 409) => { throw Object.assign(Error('The original manual credential requires current authorized recovery.'), { statusCode, code: 'PDL_MANUAL_CREDENTIAL_CUSTODY' }); };
const object = value => Boolean(value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)));
const closed = (value, keys) => object(value) && Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const operation = value => uuid(value) && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const id = value => Number.isSafeInteger(value) && value > 0;
const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const label = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
const email = value => label(value, 5000) && /^\S+@\S+\.\S+$/.test(value);
const codeBytes = bytes => bytes.length >= 8 && bytes.length <= 128 && [...bytes].every(byte => byte >= 65 && byte <= 90 || byte >= 97 && byte <= 122 || byte >= 48 && byte <= 57 || byte === 45 || byte === 95);
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
function scopeTuple(scope) {
  if (closed(scope, ['kind', 'platformId', 'keyHash']) && scope.kind === 'bootstrap-key' && scope.platformId === PLATFORM_ID && hash(scope.keyHash)) return [scope.kind, scope.platformId, scope.keyHash];
  if (closed(scope, ['kind', 'platformId', 'actorId', 'role', 'status', 'mustSetPassword', 'sessionHash', 'expiresAt']) && scope.kind === 'platform-owner' && scope.platformId === PLATFORM_ID && id(scope.actorId) && scope.role === 'platform_owner' && scope.status === 'Active' && scope.mustSetPassword === false && hash(scope.sessionHash) && iso(scope.expiresAt)) return [scope.kind, scope.platformId, scope.actorId, scope.role, scope.status, scope.mustSetPassword, scope.sessionHash, scope.expiresAt];
  fail(403);
}
function namespace(companyId, purpose, scope) {
  if (!uuid(companyId) || !PURPOSES.includes(purpose)) fail();
  if (purpose === 'company-owner-reset' ? companyId === PLATFORM_ID || scope.kind !== 'platform-owner' : companyId !== PLATFORM_ID || scope.kind !== (purpose === 'platform-bootstrap' ? 'bootstrap-key' : 'platform-owner')) fail();
}
function aad(row) {
  // Tuples keep authentication stable across JSONB object-key reordering.
  return Buffer.from(JSON.stringify([row.format, row.keyVersion, row.id, row.companyId, row.operationId, row.purpose, row.requestHash, row.targetId, row.targetRole, row.targetName, row.targetEmail, row.targetFingerprint, scopeTuple(row.scope), row.createdAt, row.expiresAt]));
}
function encoded(value, min, max) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value) || value.length > Math.ceil(max * 4 / 3) + 1) fail();
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.length < min || bytes.length > max || bytes.toString('base64url') !== value) fail();
  return bytes;
}
function target(db, targetId, purpose, now) {
  if (!object(db) || !object(db.company) || !uuid(db.company.id) || !Array.isArray(db.users) || db.users.length > 50000) fail();
  const ids = new Set(), emails = new Set();
  for (const user of db.users) {
    if (!object(user) || !id(user.id) || ids.has(user.id) || !email(user.email) || emails.has(user.email.trim().toLowerCase()) || Object.hasOwn(user, 'companyId') && user.companyId !== db.company.id) fail();
    ids.add(user.id); emails.add(user.email.trim().toLowerCase());
  }
  const user = db.users.find(row => row.id === targetId);
  if (!user || !label(user.name, 500) || user.status !== 'Active' || purpose === 'company-owner-reset' && (user.role !== 'owner' || user.mustSetPassword !== true) || purpose !== 'company-owner-reset' && (!PLATFORM_ROLES.includes(user.role) || Object.hasOwn(user, 'mustSetPassword') && user.mustSetPassword !== true) || purpose === 'platform-bootstrap' && (user.role !== 'platform_owner' || user.mustSetPassword !== true) || typeof user.setupHash !== 'string' || !/^[a-f0-9]{128}$/.test(user.setupHash) || typeof user.setupSalt !== 'string' || !/^[a-f0-9]{32}$/.test(user.setupSalt) || !iso(user.setupExpiresAt) || Date.parse(user.setupExpiresAt) <= now) fail();
  const fingerprint = digest([db.company.id, user.id, user.name, user.email, user.role, user.status, Object.hasOwn(user, 'mustSetPassword') ? user.mustSetPassword : 'absent', user.setupHash, user.setupSalt, user.setupExpiresAt]);
  return { user, fingerprint };
}
function metadata(row) {
  return { operationId: row.operationId, purpose: row.purpose, companyId: row.companyId, targetId: row.targetId, targetRole: row.targetRole, name: row.targetName, email: row.targetEmail, createdAt: row.createdAt, expiresAt: row.expiresAt };
}
function createCustody(options = {}) {
  if (!object(options) || Reflect.ownKeys(options).some(name => !['key', 'keyVersion', 'clock'].includes(name))) fail(503);
  const { key, keyVersion = 'roles-manual-v1', clock = Date.now } = options;
  if (!Buffer.isBuffer(key) || key.length !== 32 || typeof keyVersion !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(keyVersion) || typeof clock !== 'function') fail(503);
  // Copy key material: later caller mutation must not change a live instance.
  const rootKey = Buffer.from(key), encryptionKey = crypto.createHmac('sha256', rootKey).update('pdl/roles/manual-credential/encryption/' + keyVersion).digest(), signingKey = crypto.createHmac('sha256', rootKey).update('pdl/roles/manual-credential/ledger/' + keyVersion).digest();
  rootKey.fill(0);
  const now = () => { const value = clock(); if (!Number.isSafeInteger(value) || value < 0 || value > 8640000000000000) fail(503); return value; };
  const sign = row => crypto.createHmac('sha256', signingKey).update(aad(row)).update(JSON.stringify([row.custody.version, row.custody.iv, row.custody.ciphertext, row.custody.tag])).digest('hex');
  function decrypt(row) {
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey, encoded(row.custody.iv, 12, 12));
      decipher.setAAD(aad(row)); decipher.setAuthTag(encoded(row.custody.tag, 16, 16));
      const bytes = Buffer.concat([decipher.update(encoded(row.custody.ciphertext, 8, 128)), decipher.final()]);
      if (!codeBytes(bytes)) { bytes.fill(0); fail(); }
      return bytes;
    } catch { fail(); }
  }
  function validate(db) {
    if (!object(db) || !object(db.company) || !uuid(db.company.id)) fail();
    const rows = Object.hasOwn(db, COLLECTION) ? db[COLLECTION] : [];
    if (!Array.isArray(rows) || rows.length > LIMIT) fail();
    const recordIds = new Set(), operationIds = new Set();
    let bytes;
    try { bytes = Buffer.byteLength(JSON.stringify(rows)); } catch { fail(); }
    if (bytes > MAX_BYTES) fail();
    for (const row of rows) {
      if (!closed(row, FIELDS) || row.format !== FORMAT || row.keyVersion !== keyVersion || !operation(row.id) || !operation(row.operationId) || recordIds.has(row.id) || operationIds.has(row.operationId) || row.companyId !== db.company.id || !hash(row.requestHash) || !id(row.targetId) || !label(row.targetName, 500) || !email(row.targetEmail) || !hash(row.targetFingerprint) || !iso(row.createdAt) || !iso(row.expiresAt) || Date.parse(row.expiresAt) <= Date.parse(row.createdAt) || !closed(row.custody, ['version', 'iv', 'ciphertext', 'tag']) || row.custody.version !== 1 || !hash(row.signature)) fail();
      scopeTuple(row.scope); namespace(row.companyId, row.purpose, row.scope);
      if (row.purpose === 'company-owner-reset' ? row.targetRole !== 'owner' : !PLATFORM_ROLES.includes(row.targetRole) || row.purpose === 'platform-bootstrap' && row.targetRole !== 'platform_owner') fail();
      if (row.scope.kind === 'platform-owner' && Date.parse(row.expiresAt) > Date.parse(row.scope.expiresAt)) fail();
      const expected = sign(row);
      if (!crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(row.signature, 'hex'))) fail();
      const plaintext = decrypt(row); plaintext.fill(0);
      recordIds.add(row.id); operationIds.add(row.operationId);
    }
    return rows.map(metadata);
  }
  function input(db, value, enclosing) {
    const required = ['operationId', 'purpose', 'scope', 'requestHash'], extra = enclosing ? ['targetId', 'setupCode'] : Object.hasOwn(value || {}, 'targetId') ? ['targetId'] : [];
    if (!closed(value, [...required, ...extra]) || !operation(value.operationId) || !hash(value.requestHash) || !PURPOSES.includes(value.purpose) || (enclosing || extra.length) && !id(value.targetId)) fail(400);
    scopeTuple(value.scope); namespace(db?.company?.id, value.purpose, value.scope);
    const time = now();
    if (value.scope.kind === 'platform-owner' && Date.parse(value.scope.expiresAt) <= time) fail(403);
    validate(db);
    return time;
  }
  function selected(db, value, time) {
    const row = (db[COLLECTION] || []).find(item => item.operationId === value.operationId);
    if (!row) return null;
    if (row.purpose !== value.purpose || row.requestHash !== value.requestHash || Object.hasOwn(value, 'targetId') && row.targetId !== value.targetId) fail();
    if (JSON.stringify(scopeTuple(row.scope)) !== JSON.stringify(scopeTuple(value.scope))) fail(403);
    if (Date.parse(row.expiresAt) <= time) fail();
    const current = target(db, row.targetId, row.purpose, time);
    if (current.fingerprint !== row.targetFingerprint || current.user.role !== row.targetRole || current.user.name !== row.targetName || current.user.email !== row.targetEmail) fail();
    return { row, current };
  }
  function matchCode(bytes, user) {
    let actual;
    try { actual = crypto.scryptSync(bytes, user.setupSalt, 64); if (!crypto.timingSafeEqual(actual, Buffer.from(user.setupHash, 'hex'))) fail(); }
    finally { actual?.fill(0); }
  }
  function enclose(db, value) {
    const time = input(db, value, true);
    if (typeof value.setupCode !== 'string') fail(400);
    const bytes = Buffer.from(value.setupCode, 'utf8');
    try {
      if (!codeBytes(bytes)) fail(400);
      const prior = selected(db, value, time);
      if (prior) {
        const original = decrypt(prior.row);
        try { if (original.length !== bytes.length || !crypto.timingSafeEqual(original, bytes)) fail(); matchCode(original, prior.current.user); }
        finally { original.fill(0); }
        return { snapshot: db, metadata: metadata(prior.row), alreadyPresent: true };
      }
      const current = target(db, value.targetId, value.purpose, time); matchCode(bytes, current.user);
      const row = { format: FORMAT, keyVersion, id: crypto.randomUUID(), companyId: db.company.id, operationId: value.operationId, purpose: value.purpose, requestHash: value.requestHash, targetId: value.targetId, targetRole: current.user.role, targetName: current.user.name, targetEmail: current.user.email, targetFingerprint: current.fingerprint, scope: structuredClone(value.scope), createdAt: new Date(time).toISOString(), expiresAt: new Date(Math.min(Date.parse(current.user.setupExpiresAt), value.scope.kind === 'platform-owner' ? Date.parse(value.scope.expiresAt) : Infinity)).toISOString() };
      const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey, iv); cipher.setAAD(aad(row));
      row.custody = { version: 1, iv: iv.toString('base64url'), ciphertext: Buffer.concat([cipher.update(bytes), cipher.final()]).toString('base64url'), tag: cipher.getAuthTag().toString('base64url') }; row.signature = sign(row);
      const rows = [...(db[COLLECTION] || []), row];
      if (rows.length > LIMIT || Buffer.byteLength(JSON.stringify(rows)) > MAX_BYTES) fail();
      let snapshot; try { snapshot = structuredClone(db); } catch { fail(); }
      snapshot[COLLECTION] = structuredClone(rows);
      return { snapshot, metadata: metadata(row), alreadyPresent: false };
    } finally { bytes.fill(0); }
  }
  function recover(db, value) {
    const time = input(db, value, false), prior = selected(db, value, time);
    if (!prior) return { found: false };
    const bytes = decrypt(prior.row);
    try { matchCode(bytes, prior.current.user); return { found: true, metadata: metadata(prior.row), setupCode: bytes.toString('utf8') }; }
    finally { bytes.fill(0); }
  }
  function projected(db) { validate(db); const copy = structuredClone(db); delete copy[COLLECTION]; return copy; }
  return { enclose, recover, validate, projected };
}
module.exports = { COLLECTION, PLATFORM_ID, PURPOSES: Object.freeze([...PURPOSES]), LIMIT, MAX_BYTES, createCustody };
