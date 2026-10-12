'use strict';
// Memory-only synthetic keys/accounts. No environment, provider, filesystem or
// database adapter is imported by this test or the custody implementation.
const assert = require('node:assert/strict'), crypto = require('node:crypto');
const { createCustody, COLLECTION, PLATFORM_ID, PURPOSES, LIMIT, MAX_BYTES } = require('./roles-manual-credential-custody');
const key = Buffer.alloc(32, 71), keyVersion = 'synthetic-manual-v1';
const COMPANY_ID = '11111111-1111-4111-8111-111111111111';
const NOW = Date.parse('2026-10-12T12:00:00.000Z'), code = 'Synthetic_Code_17';
const salt = 'a'.repeat(32), setupHash = crypto.scryptSync(code, salt, 64).toString('hex');
let checks = 0;
const clone = value => structuredClone(value);
const requestHash = crypto.createHash('sha256').update('synthetic reviewed original command').digest('hex');
const bootstrapScope = () => ({ kind: 'bootstrap-key', platformId: PLATFORM_ID, keyHash: 'b'.repeat(64) });
const ownerScope = () => ({ kind: 'platform-owner', platformId: PLATFORM_ID, actorId: 1, role: 'platform_owner', status: 'Active', mustSetPassword: false, sessionHash: 'c'.repeat(64), expiresAt: new Date(NOW + 3600000).toISOString() });
function fixture(purpose = 'platform-staff-create') {
  let time = NOW;
  const target = { id: 2, name: 'Synthetic Recipient', email: 'recipient@example.invalid', role: purpose === 'company-owner-reset' ? 'owner' : purpose === 'platform-bootstrap' ? 'platform_owner' : 'support', status: 'Active', setupHash, setupSalt: salt, setupExpiresAt: new Date(NOW + 7200000).toISOString() };
  // The real legacy staff-create handler omits mustSetPassword.
  if (purpose !== 'platform-staff-create') target.mustSetPassword = true;
  const db = { company: { id: purpose === 'company-owner-reset' ? COMPANY_ID : PLATFORM_ID, name: 'Synthetic only' }, users: [target], untouched: { assignments: ['keep'], providerAttempts: [] } };
  const input = { operationId: crypto.randomUUID(), purpose, scope: purpose === 'platform-bootstrap' ? bootstrapScope() : ownerScope(), targetId: 2, setupCode: code, requestHash };
  const custody = createCustody({ key, keyVersion, clock: () => time });
  return { db, input, custody, setTime(value) { time = value; } };
}
const recovery = input => { const { setupCode, ...value } = clone(input); return value; };
function deny(task, status = 409) { assert.throws(task, error => error.statusCode === status && error.code === 'PDL_MANUAL_CREDENTIAL_CUSTODY'); checks++; }
function unchanged(db, task, status = 409) { const before = JSON.stringify(db); deny(task, status); assert.equal(JSON.stringify(db), before); checks++; }
function encodedAlias(value) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_', bytes = Buffer.from(value, 'base64url');
  for (const next of alphabet) { const candidate = value.slice(0, -1) + next; if (candidate !== value && Buffer.from(candidate, 'base64url').equals(bytes)) return candidate; }
  throw Error('The synthetic alias discriminator requires unused padding bits.');
}
// Independent test fixture sealer lets retained authenticated history reach
// real capacity, without thousands of scrypt credential writes or test knobs.
function reseal(row, plaintext = code) {
  const ek = crypto.createHmac('sha256', key).update('pdl/roles/manual-credential/encryption/' + keyVersion).digest();
  const sk = crypto.createHmac('sha256', key).update('pdl/roles/manual-credential/ledger/' + keyVersion).digest();
  const scope = row.scope.kind === 'bootstrap-key' ? [row.scope.kind, row.scope.platformId, row.scope.keyHash] : [row.scope.kind, row.scope.platformId, row.scope.actorId, row.scope.role, row.scope.status, row.scope.mustSetPassword, row.scope.sessionHash, row.scope.expiresAt];
  const aad = Buffer.from(JSON.stringify([row.format, row.keyVersion, row.id, row.companyId, row.operationId, row.purpose, row.requestHash, row.targetId, row.targetRole, row.targetName, row.targetEmail, row.targetFingerprint, scope, row.createdAt, row.expiresAt]));
  const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', ek, iv); cipher.setAAD(aad);
  row.custody = { version: 1, iv: iv.toString('base64url'), ciphertext: Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]).toString('base64url'), tag: cipher.getAuthTag().toString('base64url') };
  row.signature = crypto.createHmac('sha256', sk).update(aad).update(JSON.stringify([row.custody.version, row.custody.iv, row.custody.ciphertext, row.custody.tag])).digest('hex');
  return row;
}
function resign(row) {
  // Corrupt canonical encodings or GCM ciphertext while retaining a valid MAC.
  const scope = row.scope.kind === 'bootstrap-key' ? [row.scope.kind, row.scope.platformId, row.scope.keyHash] : [row.scope.kind, row.scope.platformId, row.scope.actorId, row.scope.role, row.scope.status, row.scope.mustSetPassword, row.scope.sessionHash, row.scope.expiresAt];
  const aad = Buffer.from(JSON.stringify([row.format, row.keyVersion, row.id, row.companyId, row.operationId, row.purpose, row.requestHash, row.targetId, row.targetRole, row.targetName, row.targetEmail, row.targetFingerprint, scope, row.createdAt, row.expiresAt]));
  const sk = crypto.createHmac('sha256', key).update('pdl/roles/manual-credential/ledger/' + keyVersion).digest();
  row.signature = crypto.createHmac('sha256', sk).update(aad).update(JSON.stringify([row.custody.version, row.custody.iv, row.custody.ciphertext, row.custody.tag])).digest('hex');
  return row;
}

// All three fixed operations recover exactly the original code after a new
// process instance is created. Recovery never appends, consumes or rotates.
for (const purpose of PURPOSES) {
  const f = fixture(purpose), before = JSON.stringify(f.db), saved = f.custody.enclose(f.db, f.input), req = recovery(f.input);
  assert.equal(JSON.stringify(f.db), before); assert.equal(saved.alreadyPresent, false);
  assert.deepEqual(f.custody.projected(saved.snapshot), f.db);
  assert.equal(JSON.stringify(saved.snapshot[COLLECTION]).includes(code), false);
  assert.equal(saved.metadata.targetId, 2); assert.equal(saved.metadata.email, f.db.users[0].email);
  const restarted = createCustody({ key, keyVersion, clock: () => NOW });
  delete req.targetId;
  assert.equal(restarted.recover(saved.snapshot, req).setupCode, code);
  assert.deepEqual(restarted.recover(saved.snapshot, req).metadata, saved.metadata);
  assert.deepEqual(f.custody.enclose(saved.snapshot, f.input), { snapshot: saved.snapshot, metadata: saved.metadata, alreadyPresent: true });
  assert.equal(JSON.stringify(saved.snapshot[COLLECTION]).includes('setupHash'), false);
  assert.equal(JSON.stringify(saved.snapshot[COLLECTION]).includes('setupSalt'), false);
  assert.deepEqual(Object.keys(saved.metadata).sort(), ['operationId', 'purpose', 'companyId', 'targetId', 'targetRole', 'name', 'email', 'createdAt', 'expiresAt'].sort());
  assert.equal(saved.metadata.expiresAt, new Date(NOW + (purpose === 'platform-bootstrap' ? 7200000 : 3600000)).toISOString());
  const snapshot = JSON.stringify(saved.snapshot);
  restarted.recover(saved.snapshot, req); assert.equal(JSON.stringify(saved.snapshot), snapshot);
  // JSONB may reorder every object; tuple authentication must still work.
  const reordered = value => Array.isArray(value) ? value.map(reordered) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).reverse().map(k => [k, reordered(value[k])])) : value;
  assert.equal(restarted.recover(reordered(saved.snapshot), req).setupCode, code);
  checks += 15;
}

let f = fixture(), saved = f.custody.enclose(f.db, f.input), req = recovery(f.input);
assert.deepEqual(f.custody.recover(f.db, req), { found: false }); checks++;
for (const value of [undefined, null, false, 0, '']) {
  const db = clone(f.db); db[COLLECTION] = value;
  unchanged(db, () => f.custody.recover(db, req));
}
for (const mutate of [
  row => { row.extra = 'unknown'; }, row => { row.signature = '0'.repeat(64); },
  row => { row.companyId = COMPANY_ID; }, row => { row.requestHash = 'd'.repeat(64); },
  row => { row.targetId = 3; }, row => { row.targetRole = 'platform_owner'; },
  row => { row.targetName = { private: 'nested' }; }, row => { row.targetEmail = { private: 'nested' }; },
  row => { row.targetFingerprint = 'e'.repeat(64); }, row => { row.scope.sessionHash = 'd'.repeat(64); },
  row => { row.createdAt = 'yesterday'; }, row => { row.expiresAt = row.createdAt; },
  row => { row.custody.extra = true; }, row => { row.custody.version = 2; },
  row => { row.custody.iv = 'bad'; }, row => { row.custody.ciphertext = row.custody.ciphertext.slice(1); },
  row => { row.custody.tag = Buffer.alloc(16).toString('base64url'); }, row => { row.keyVersion = 'missing-version'; }
]) {
  const db = clone(saved.snapshot); mutate(db[COLLECTION][0]);
  unchanged(db, () => f.custody.recover(db, req));
}
for (const duplicate of ['id', 'operationId']) {
  const db = clone(saved.snapshot), row = clone(db[COLLECTION][0]);
  row.id = crypto.randomUUID(); row.operationId = crypto.randomUUID(); row[duplicate] = db[COLLECTION][0][duplicate]; reseal(row); db[COLLECTION].push(row);
  unchanged(db, () => f.custody.recover(db, req));
}
for (const changed of ['actorId', 'sessionHash', 'expiresAt']) {
  const changedReq = clone(req); changedReq.scope[changed] = changed === 'actorId' ? 3 : changed === 'sessionHash' ? 'd'.repeat(64) : new Date(NOW + 3500000).toISOString();
  unchanged(saved.snapshot, () => f.custody.recover(saved.snapshot, changedReq), 403);
}
for (const mutate of [scope => { scope.role = 'support'; }, scope => { scope.status = 'Deactivated'; }, scope => { scope.mustSetPassword = true; }, scope => { scope.sessionHash = { hash: 'c'.repeat(64) }; }, scope => { scope.expiresAt = new Date(NOW).toISOString(); }, scope => { scope.other = true; }]) {
  const changedReq = clone(req); mutate(changedReq.scope);
  unchanged(saved.snapshot, () => f.custody.recover(saved.snapshot, changedReq), 403);
}
for (const mutate of [value => { value.targetId = 3; }, value => { value.requestHash = 'e'.repeat(64); }]) {
  const changedReq = clone(req); mutate(changedReq);
  unchanged(saved.snapshot, () => f.custody.recover(saved.snapshot, changedReq));
}
for (const mutate of [value => { value.operationId = '../credential'; }, value => { value.targetId = '2'; }, value => { value.requestHash = 'not a digest'; }, value => { value.setupCode = code; }, value => { value.extra = 'unknown'; }, value => { delete value.requestHash; }]) {
  const changedReq = clone(req); mutate(changedReq);
  unchanged(saved.snapshot, () => f.custody.recover(saved.snapshot, changedReq), 400);
}
for (const mutate of [
  user => { user.status = 'Deactivated'; }, user => { user.role = 'engineering'; },
  user => { user.name = 'Different account name'; }, user => { user.email = 'different@example.invalid'; },
  user => { user.setupSalt = 'd'.repeat(32); }, user => { user.setupHash = 'f'.repeat(128); },
  user => { user.setupExpiresAt = new Date(NOW + 7100000).toISOString(); },
  user => { user.setupExpiresAt = new Date(NOW).toISOString(); }, user => { delete user.setupHash; },
  user => { user.mustSetPassword = false; }, user => { user.name = { private: 'nested' }; },
  user => { user.companyId = COMPANY_ID; }, user => { user.id = '2'; }
]) {
  const db = clone(saved.snapshot); mutate(db.users[0]);
  unchanged(db, () => f.custody.recover(db, req));
}
for (const mutate of [db => { db.users = []; }, db => { db.users.push(clone(db.users[0])); }, db => { db.users.push({ ...db.users[0], id: '02', email: 'another@example.invalid' }); }, db => { db.users.push({ ...db.users[0], id: 3, email: db.users[0].email.toUpperCase() }); }]) {
  const db = clone(saved.snapshot); mutate(db);
  unchanged(db, () => f.custody.recover(db, req));
}
const wrongCode = { ...f.input, setupCode: 'Different_Code_7' };
unchanged(f.db, () => f.custody.enclose(f.db, wrongCode));
unchanged(saved.snapshot, () => f.custody.enclose(saved.snapshot, wrongCode));
for (const value of ['', 'a'.repeat(129), 'has space', 'NonAscii_é', { secret: code }]) unchanged(f.db, () => f.custody.enclose(f.db, { ...f.input, setupCode: value }), 400);

// A valid MAC does not excuse a broken GCM payload, noncanonical byte alias,
// ciphertext containing a different code, or a relabeled current target.
for (const change of ['tag', 'ciphertext', 'alias', 'plaintext', 'fingerprint', 'target']) {
  const db = clone(saved.snapshot), row = db[COLLECTION][0];
  if (change === 'tag') { row.custody.tag = Buffer.alloc(16).toString('base64url'); resign(row); }
  if (change === 'ciphertext') { const b = Buffer.from(row.custody.ciphertext, 'base64url'); b[0] ^= 1; row.custody.ciphertext = b.toString('base64url'); resign(row); }
  if (change === 'alias') { row.custody.tag = encodedAlias(row.custody.tag); resign(row); }
  if (change === 'plaintext') reseal(row, 'Other_Valid_Code');
  if (change === 'fingerprint') { row.targetFingerprint = 'f'.repeat(64); reseal(row); }
  if (change === 'target') { row.targetId = 3; reseal(row); }
  unchanged(db, () => f.custody.recover(db, req));
}
const wrongKey = createCustody({ key: Buffer.alloc(32, 72), keyVersion, clock: () => NOW });
unchanged(saved.snapshot, () => wrongKey.recover(saved.snapshot, req));
const wrongVersion = createCustody({ key, keyVersion: 'different-version', clock: () => NOW });
unchanged(saved.snapshot, () => wrongVersion.recover(saved.snapshot, req));
for (const config of [null, false, [], {}, { key, unknown: true }, { key: 'not a key' }, { key: Buffer.alloc(31) }, { key, keyVersion: null }, { key, keyVersion: '../version' }, { key, clock: 42 }]) deny(() => createCustody(config), 503);
const mutableKey = Buffer.from(key), captured = createCustody({ key: mutableKey, keyVersion, clock: () => NOW }); mutableKey.fill(0);
assert.equal(captured.recover(saved.snapshot, req).setupCode, code); checks++;

// Historical custody remains authenticated after expiry/rotation, while only
// the current generation can be returned. Never erase history to make room.
f = fixture('platform-bootstrap'); saved = f.custody.enclose(f.db, f.input); req = recovery(f.input);
const wrongBootstrap = clone(req); wrongBootstrap.scope.keyHash = 'f'.repeat(64);
unchanged(saved.snapshot, () => f.custody.recover(saved.snapshot, wrongBootstrap), 403);
f.setTime(NOW + 7200000); assert.equal(f.custody.validate(saved.snapshot).length, 1); checks++;
unchanged(saved.snapshot, () => f.custody.recover(saved.snapshot, req));
f = fixture(); saved = f.custody.enclose(f.db, f.input); req = recovery(f.input);
const rotated = clone(saved.snapshot), newCode = 'New_Synthetic_7';
rotated.users[0].setupSalt = 'e'.repeat(32); rotated.users[0].setupHash = crypto.scryptSync(newCode, rotated.users[0].setupSalt, 64).toString('hex');
unchanged(rotated, () => f.custody.recover(rotated, req));
const newerInput = { ...f.input, operationId: crypto.randomUUID(), setupCode: newCode };
const newer = f.custody.enclose(rotated, newerInput);
assert.equal(newer.snapshot[COLLECTION].length, 2); assert.equal(f.custody.validate(newer.snapshot).length, 2);
assert.equal(f.custody.recover(newer.snapshot, recovery(newerInput)).setupCode, newCode); checks += 3;
const priorSource = JSON.stringify(rotated); newer.snapshot[COLLECTION][0].targetName = 'Candidate-only mutation';
assert.equal(JSON.stringify(rotated), priorSource); checks++;

// Staff role inheritance remains exactly the existing finite platform set.
for (const role of ['platform_owner', 'customer_success', 'onboarding', 'support', 'billing', 'engineering']) {
  const current = fixture(); current.db.users[0].role = role;
  assert.equal(current.custody.enclose(current.db, current.input).metadata.targetRole, role); checks++;
}
for (const purpose of PURPOSES) {
  const current = fixture(purpose); current.db.company.id = purpose === 'company-owner-reset' ? PLATFORM_ID : COMPANY_ID;
  unchanged(current.db, () => current.custody.enclose(current.db, current.input));
}
f = fixture('company-owner-reset'); f.db.users[0].role = 'admin'; unchanged(f.db, () => f.custody.enclose(f.db, f.input));
f = fixture('company-owner-reset'); delete f.db.users[0].mustSetPassword; unchanged(f.db, () => f.custody.enclose(f.db, f.input));
f = fixture('platform-bootstrap'); delete f.db.users[0].mustSetPassword; unchanged(f.db, () => f.custody.enclose(f.db, f.input));

f = fixture(); saved = f.custody.enclose(f.db, f.input);
const full = clone(saved.snapshot), original = full[COLLECTION][0];
for (let n = 1; n < LIMIT; n++) full[COLLECTION].push(reseal({ ...clone(original), id: crypto.randomUUID(), operationId: crypto.randomUUID() }));
assert.equal(f.custody.validate(full).length, LIMIT); assert.equal(f.custody.enclose(full, f.input).alreadyPresent, true); checks += 2;
unchanged(full, () => f.custody.enclose(full, { ...f.input, operationId: crypto.randomUUID() }));
const over = clone(full); over[COLLECTION].push(clone(original)); unchanged(over, () => f.custody.recover(over, recovery(f.input)));
const large = clone(saved.snapshot), filler = { ...clone(original), targetName: 'X'.repeat(500), targetEmail: 'x'.repeat(4880) + '@example.invalid' };
while (Buffer.byteLength(JSON.stringify(large[COLLECTION])) < MAX_BYTES) large[COLLECTION].push(reseal({ ...clone(filler), id: crypto.randomUUID(), operationId: crypto.randomUUID() }));
assert.ok(large[COLLECTION].length < LIMIT); unchanged(large, () => f.custody.recover(large, recovery(f.input)));
// A new entry must reject at the byte boundary while an exact already-stored
// operation remains available in a valid ledger just below that boundary.
large[COLLECTION].pop();
assert.equal(f.custody.validate(large).length, large[COLLECTION].length); checks++;
const addition = f.custody.enclose(f.db, { ...f.input, operationId: crypto.randomUUID() }).snapshot[COLLECTION][0];
while (Buffer.byteLength(JSON.stringify(large[COLLECTION])) + Buffer.byteLength(JSON.stringify(addition)) + 1 <= MAX_BYTES) {
  const row = reseal({ ...clone(original), id: crypto.randomUUID(), operationId: crypto.randomUUID() });
  large[COLLECTION].push(row);
}
assert.ok(Buffer.byteLength(JSON.stringify(large[COLLECTION])) <= MAX_BYTES);
assert.equal(f.custody.enclose(large, f.input).alreadyPresent, true); checks++;
unchanged(large, () => f.custody.enclose(large, { ...f.input, operationId: crypto.randomUUID() }));

console.log(`Manual credential custody: ${checks} memory-only synthetic checks passed.`);
