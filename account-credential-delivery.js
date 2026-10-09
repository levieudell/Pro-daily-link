'use strict';
// Purpose-specific bearer custody. Never a scheduling or generic effect payload.
const crypto = require('node:crypto');
const { canonicalHash } = require('./database/transactional-repository');
const { validateAccounts } = require('./account-evidence');
const COLLECTION = 'accountCredentialDeliveries';
const digest = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const failure = () => Object.assign(Error('Credential delivery requires explicit recovery.'), { code: 'PDL_CREDENTIAL_RECOVERY', statusCode: 503 });
const currentTime = clock => Number(clock());
function expires(value, now) { const time = Date.parse(value); return Number.isFinite(time) && time > now; }
function email(value) { return String(value || '').trim().toLowerCase(); }
function activeIdentity(db, address) {
  try { validateAccounts(db); } catch { throw failure(); }
  const rows = db.users.filter(row => email(row.email) === email(address) && row.status === 'Active');
  if (rows.length > 1) throw failure();
  return rows[0] || null;
}
function validateOrigin(value) {
  let url; try { url = new URL(value); } catch { throw failure(); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw failure();
  return url.origin;
}
function aad(job) { return Buffer.from(JSON.stringify([1, job.id, job.keyVersion, job.companyId, job.userId, job.purpose, job.generation, job.email, job.origin, job.expiresAt])); }
function jobsValid(db) {
  const jobs = db[COLLECTION] === undefined ? [] : db[COLLECTION], ids = new Set(), generations = new Set();
  const keys = ['id', 'companyId', 'userId', 'purpose', 'generation', 'email', 'origin', 'tokenHash', 'createdAt', 'expiresAt', 'status', 'custody', 'keyVersion', 'dispatchId', 'admittedAt', 'finishedAt'];
  const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
  if (!Array.isArray(jobs) || jobs.length > 500) throw failure();
  for (const job of jobs) {
    if (!job || Array.isArray(job) || Object.keys(job).some(name => !keys.includes(name)) || !uuid(job.id) || !uuid(job.generation) || ids.has(job.id) || job.companyId !== db.company.id || !Number.isSafeInteger(job.userId) || job.userId < 1 || job.purpose !== 'password-reset' || typeof job.email !== 'string' || email(job.email) !== job.email || !/^[0-9a-f]{64}$/.test(job.tokenHash) || !/^[A-Za-z0-9_-]{1,64}$/.test(job.keyVersion) || !Number.isFinite(Date.parse(job.createdAt)) || !Number.isFinite(Date.parse(job.expiresAt)) || !['queued', 'sending', 'sent', 'cancelled', 'rejected', 'uncertain'].includes(job.status)) throw failure();
    const generation = JSON.stringify([job.userId, job.purpose, job.generation]);
    if (generations.has(generation)) throw failure(); ids.add(job.id); generations.add(generation);
    validateOrigin(job.origin);
    if (job.dispatchId !== undefined && !uuid(job.dispatchId)) throw failure();
    if (job.status === 'sending' && (!uuid(job.dispatchId) || !Number.isFinite(Date.parse(job.admittedAt)))) throw failure();
  }
  return jobs;
}
function descriptorHash(job) {
  const names = ['id', 'companyId', 'userId', 'purpose', 'generation', 'email', 'origin', 'tokenHash', 'createdAt', 'expiresAt', 'custody', 'keyVersion'];
  return canonicalHash(Object.fromEntries(names.map(name => [name, job[name] ?? null])));
}
function seal(token, job, key) {
  const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad(job));
  const bytes = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return { version: 1, iv: iv.toString('base64url'), ciphertext: bytes.toString('base64url'), tag: cipher.getAuthTag().toString('base64url') };
}
function open(job, key) {
  const sealed = job.custody;
  if (!sealed || sealed.version !== 1 || Object.keys(sealed).some(name => !['version', 'iv', 'ciphertext', 'tag'].includes(name))) throw failure();
  try {
    const iv = Buffer.from(sealed.iv, 'base64url'), tag = Buffer.from(sealed.tag, 'base64url'), bytes = Buffer.from(sealed.ciphertext, 'base64url');
    if (iv.length !== 12 || tag.length !== 16 || bytes.length !== 43) throw failure();
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv); decipher.setAAD(aad(job)); decipher.setAuthTag(tag);
    const token = Buffer.concat([decipher.update(bytes), decipher.final()]).toString('utf8');
    if (!/^[A-Za-z0-9_-]{43}$/.test(token) || digest(token) !== job.tokenHash) throw failure();
    return token;
  } catch { throw failure(); }
}
function stripPrivate(value) {
  if (Array.isArray(value)) return value.map(stripPrivate);
  if (!value || typeof value !== 'object') return value;
  const denied = new Set([COLLECTION, 'passwordHash', 'passwordSalt', 'setupHash', 'setupSalt', 'resetTokenHash', 'emailVerificationTokenHash', 'accountResetGeneration']);
  return Object.fromEntries(Object.entries(value).filter(([name]) => !denied.has(name)).map(([name, child]) => [name, stripPrivate(child)]));
}
function createCredentialDelivery({ key, keyVersion = 'synthetic-v1', origin, load, commit, send, clock = Date.now }) {
  if (!Buffer.isBuffer(key) || key.length !== 32 || typeof send !== 'function') throw failure();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(keyVersion)) throw failure();
  origin = validateOrigin(origin);
  async function committed(db, revision, guard) {
    const result = await commit(db, revision, guard);
    if (result?.revision !== revision + 1 || result.contentHash !== canonicalHash(db)) throw failure();
    return result;
  }
  function requestReset(db, address) {
    const jobs = jobsValid(db);
    if (!Array.isArray(jobs) || jobs.length >= 500) throw failure();
    const user = activeIdentity(db, address);
    if (!user) return null; // Same public response; no token or account directory.
    const now = currentTime(clock), token = crypto.randomBytes(32).toString('base64url'), generation = crypto.randomUUID();
    const job = { id: crypto.randomUUID(), keyVersion, companyId: db.company.id, userId: user.id, purpose: 'password-reset', generation,
      email: email(user.email), origin, tokenHash: digest(token), createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 30 * 60000).toISOString(), status: 'queued' };
    job.custody = seal(token, job, key);
    for (const previous of jobs) if (previous.userId === user.id && previous.purpose === job.purpose && previous.status === 'queued') { previous.status = 'cancelled'; delete previous.custody; }
    user.resetTokenHash = job.tokenHash; user.resetExpiresAt = job.expiresAt; user.resetRequestedAt = job.createdAt; user.accountResetGeneration = generation;
    db[COLLECTION] = [...jobs, job];
    return { jobId: job.id };
  }
  function authorizeReset(db, address, token) {
    jobsValid(db);
    const user = activeIdentity(db, address), now = currentTime(clock);
    if (!user || typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token) || !user.resetTokenHash || digest(token) !== user.resetTokenHash || !expires(user.resetExpiresAt, now)) return null;
    return { user, deadline: user.resetExpiresAt };
  }
  function consumeReset(db, user) {
    const jobs = jobsValid(db);
    delete user.resetTokenHash; delete user.resetExpiresAt; delete user.resetRequestedAt; delete user.accountResetGeneration;
    db.sessions = (db.sessions || []).filter(row => row.userId !== user.id);
    for (const job of jobs) if (job.userId === user.id && job.purpose === 'password-reset') { if (job.status === 'queued') job.status = 'cancelled'; delete job.custody; }
  }
  function valid(db, job) {
    activeIdentity(db, job.email);
    const users = (db.users || []).filter(row => row.id === job.userId && row.status === 'Active' && (!row.companyId || row.companyId === db.company.id));
    const user = users.length === 1 && users[0];
    return user && job.companyId === db.company.id && job.keyVersion === keyVersion && job.purpose === 'password-reset' && job.origin === origin && email(user.email) === job.email &&
      user.accountResetGeneration === job.generation && user.resetTokenHash === job.tokenHash && user.resetExpiresAt === job.expiresAt && expires(job.expiresAt, currentTime(clock));
  }
  async function dispatch(companyId, jobId) {
    const loaded = await load(companyId); if (!loaded) throw failure();
    const db = structuredClone(loaded.snapshot), matches = jobsValid(db).filter(row => row.id === jobId);
    if (matches.length !== 1) throw failure();
    const job = matches[0];
    // A paused original worker may resume: no lease-based reassignment/resend.
    if (job.status !== 'queued') return { status: job.status === 'sending' ? 'uncertain' : job.status };
    if (!valid(db, job)) { job.status = 'cancelled'; delete job.custody; await committed(db, loaded.revision); return { status: 'cancelled' }; }
    let token; try { token = open(job, key); } catch { job.status = 'uncertain'; delete job.custody; await committed(db, loaded.revision); return { status: 'uncertain' }; }
    job.status = 'sending'; job.dispatchId = crypto.randomUUID(); job.admittedAt = new Date(currentTime(clock)).toISOString();
    const admittedDescriptor = descriptorHash(job);
    // This guarded commit is send authorization's linearization point. Later
    // revocation invalidates token consumption; a transport cannot be recalled.
    await committed(db, loaded.revision, { deadline: job.expiresAt });
    const resetUrl = new URL('/reset-password.html', origin); resetUrl.searchParams.set('tenant', companyId); resetUrl.searchParams.set('token', token);
    let outcome = 'uncertain';
    try { const result = await send({ purpose: 'password-reset', dispatchId: job.dispatchId, to: job.email, resetUrl: resetUrl.href });
      if (result && !Array.isArray(result) && Object.keys(result).length === 1) {
        if (result.accepted === true) outcome = 'sent'; else if (result.rejected === true) outcome = 'rejected';
      }
    } catch { /* Provider bodies/errors may contain bearer data: never persist/log. */ }
    token = null;
    const fresh = await load(companyId); if (!fresh) return { status: 'uncertain' };
    const latest = structuredClone(fresh.snapshot); let row;
    try { row = jobsValid(latest).find(item => item.id === jobId); } catch { return { status: 'uncertain' }; }
    if (!row || row.dispatchId !== job.dispatchId || row.status !== 'sending' || descriptorHash(row) !== admittedDescriptor || row.admittedAt !== job.admittedAt) return { status: 'uncertain' };
    row.status = outcome; row.finishedAt = new Date(currentTime(clock)).toISOString(); delete row.custody;
    try { await committed(latest, fresh.revision); } catch { return { status: 'uncertain' }; }
    return { status: outcome };
  }
  return { requestReset, authorizeReset, consumeReset, dispatch };
}
module.exports = { COLLECTION, createCredentialDelivery, stripPrivate, validateOrigin, expires };
