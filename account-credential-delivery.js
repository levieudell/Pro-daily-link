'use strict';
// Purpose-specific bearer custody. Never a scheduling or generic effect payload.
const crypto = require('node:crypto');
const { canonicalHash } = require('./database/transactional-repository');
const { validateAccounts } = require('./account-evidence');
const COLLECTION = 'accountCredentialDeliveries';
const HISTORY = 'accountCredentialDeliveryHistory';
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
  const jobs = db[COLLECTION] === undefined ? [] : db[COLLECTION], history = db[HISTORY] === undefined ? [] : db[HISTORY], ids = new Set(), generations = new Set();
  const keys = ['id', 'companyId', 'userId', 'purpose', 'generation', 'email', 'origin', 'tokenHash', 'createdAt', 'expiresAt', 'status', 'custody', 'keyVersion', 'dispatchId', 'admittedAt', 'finishedAt'];
  const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
  if (!Array.isArray(jobs) || !Array.isArray(history) || jobs.length > 10000) throw failure();
  for (const job of [...jobs, ...history]) {
    if (!job || Array.isArray(job) || Object.keys(job).some(name => !keys.includes(name)) || !uuid(job.id) || !uuid(job.generation) || ids.has(job.id) || job.companyId !== db.company.id || !Number.isSafeInteger(job.userId) || job.userId < 1 || !['password-reset', 'email-verification'].includes(job.purpose) || typeof job.email !== 'string' || email(job.email) !== job.email || !/^[0-9a-f]{64}$/.test(job.tokenHash) || !/^[A-Za-z0-9_-]{1,64}$/.test(job.keyVersion) || !Number.isFinite(Date.parse(job.createdAt)) || !Number.isFinite(Date.parse(job.expiresAt)) || !['queued', 'sending', 'sent', 'cancelled', 'rejected', 'uncertain'].includes(job.status)) throw failure();
    if (history.includes(job) && (job.custody !== undefined || !['sent', 'cancelled', 'rejected', 'uncertain'].includes(job.status))) throw failure();
    const generation = JSON.stringify([job.userId, job.purpose, job.generation]);
    if (generations.has(generation)) throw failure(); ids.add(job.id); generations.add(generation);
    validateOrigin(job.origin);
    if (job.dispatchId !== undefined && !uuid(job.dispatchId)) throw failure();
    if (job.status === 'sending' && (!uuid(job.dispatchId) || !Number.isFinite(Date.parse(job.admittedAt)))) throw failure();
  }
  return jobs;
}
function archiveFinished(db) {
  const active = jobsValid(db), done = active.filter(job => ['sent', 'cancelled', 'rejected', 'uncertain'].includes(job.status));
  for (const job of done) delete job.custody;
  if (done.length) { db[HISTORY] = [...(db[HISTORY] || []), ...done]; db[COLLECTION] = active.filter(job => !done.includes(job)); }
  // Append-only safe provenance remains addressable. No lease takeover, resend
  // or pruning of uncertain outcomes; the active queue does not fill with history.
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
  const denied = new Set([COLLECTION, HISTORY, 'accountSecretEnvelopes', 'accountActionPreviews', 'accountActionReceipts', 'workspaceDirectPreviews', 'workspaceDirectReceipts', 'workspaceAssignmentJobs', 'workspaceBillingJobs', 'workspaceBillingReceipts', 'workspaceComplianceJobs', 'workspaceReconciliations', 'rolePolicyPreviews', 'rolePolicyReceipts', 'rolePolicyAudit', 'custodyProof', 'dailyActionPreviews','dailyActionReceipts','timeWriterPreviews','timeWriterReceipts','timeReviewPreviews','timeReviewReceipts','timeOffActionReceipts','timeOffReviewPreviews','timeOffReviewReceipts', 'passwordHash', 'passwordSalt', 'setupHash', 'setupSalt', 'resetTokenHash', 'emailVerificationTokenHash', 'accountResetGeneration', 'accountVerificationGeneration', 'setupGeneration', 'setupIssuedEmail']);
  return Object.fromEntries(Object.entries(value).filter(([name]) => !denied.has(name)).map(([name, child]) => [name, stripPrivate(child)]));
}
function createCredentialDelivery({ key, keyVersion = 'synthetic-v1', origin, load, commit, send, clock = Date.now }) {
  if (!Buffer.isBuffer(key) || key.length !== 32 || typeof send !== 'function') throw failure();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(keyVersion)) throw failure();
  origin = validateOrigin(origin);
  function retire(job) { if (job.status === 'queued') job.status = 'cancelled'; else if (job.status === 'sending') { job.status = 'uncertain'; job.finishedAt = new Date(currentTime(clock)).toISOString(); } delete job.custody; }
  async function committed(db, revision, guard) {
    const result = await commit(db, revision, guard);
    if (result?.revision !== revision + 1 || result.contentHash !== canonicalHash(db)) throw failure();
    return result;
  }
  function requestReset(db, address) {
    archiveFinished(db);
    const jobs = jobsValid(db);
    const user = activeIdentity(db, address);
    if (!user) return null; // Same public response; no token or account directory.
    const now = currentTime(clock), token = crypto.randomBytes(32).toString('base64url'), generation = crypto.randomUUID();
    const job = { id: crypto.randomUUID(), keyVersion, companyId: db.company.id, userId: user.id, purpose: 'password-reset', generation,
      email: email(user.email), origin, tokenHash: digest(token), createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 30 * 60000).toISOString(), status: 'queued' };
    job.custody = seal(token, job, key);
    for (const previous of jobs) if (previous.userId === user.id && previous.purpose === job.purpose && ['queued', 'sending'].includes(previous.status)) retire(previous);
    user.resetTokenHash = job.tokenHash; user.resetExpiresAt = job.expiresAt; user.resetRequestedAt = job.createdAt; user.accountResetGeneration = generation;
    db[COLLECTION] = [...jobs, job]; archiveFinished(db);
    return { jobId: job.id };
  }
  function authorizeReset(db, address, token) {
    jobsValid(db);
    const raw = (db.users || []).find(row => email(row.email) === email(address) && row.status === 'Active');
    if (raw && !expires(raw.resetExpiresAt, currentTime(clock))) return null;
    const user = activeIdentity(db, address), now = currentTime(clock);
    if (!user || typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token) || !user.resetTokenHash || digest(token) !== user.resetTokenHash || !expires(user.resetExpiresAt, now)) return null;
    if (db.users.filter(row => row.status === 'Active' && row.resetTokenHash === user.resetTokenHash).length !== 1) throw failure();
    if (Object.hasOwn(user, 'accountResetGeneration')) {
      const matching = [...jobsValid(db), ...(db[HISTORY] || [])].filter(job => job.userId === user.id && job.purpose === 'password-reset' && job.generation === user.accountResetGeneration && job.email === email(user.email) && job.tokenHash === user.resetTokenHash && job.expiresAt === user.resetExpiresAt);
      if (matching.length !== 1) throw failure();
    }
    return { user, deadline: user.resetExpiresAt };
  }
  function consumeReset(db, user) {
    const jobs = jobsValid(db);
    delete user.resetTokenHash; delete user.resetExpiresAt; delete user.resetRequestedAt; delete user.accountResetGeneration;
    db.sessions = (db.sessions || []).filter(row => row.userId !== user.id);
    for (const job of jobs) if (job.userId === user.id && job.purpose === 'password-reset') retire(job);
    archiveFinished(db);
  }
  function requestVerification(db, userId) {
    archiveFinished(db); const user = db.users.find(row => row.id === userId && row.status === 'Active');
    if (!user || activeIdentity(db, user.email)?.id !== userId) throw failure();
    if (user.emailVerifiedAt) return null;
    const now = currentTime(clock), token = crypto.randomBytes(32).toString('base64url'), generation = crypto.randomUUID();
    const job = { id: crypto.randomUUID(), keyVersion, companyId: db.company.id, userId, purpose: 'email-verification', generation, email: email(user.email), origin, tokenHash: digest(token), createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 24 * 3600000).toISOString(), status: 'queued' };
    job.custody = seal(token, job, key);
    for (const previous of jobsValid(db)) if (previous.userId === userId && previous.purpose === job.purpose && ['queued', 'sending'].includes(previous.status)) retire(previous);
    user.emailVerificationTokenHash = job.tokenHash; user.emailVerificationExpiresAt = job.expiresAt; user.accountVerificationGeneration = generation;
    db.company.emailVerificationRequiredAt ||= job.createdAt; db[COLLECTION] = [...jobsValid(db), job]; archiveFinished(db); return { jobId: job.id };
  }
  function authorizeVerification(db, token) {
    jobsValid(db); try { validateAccounts(db); } catch { throw failure(); }
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const hash = digest(token), users = db.users.filter(row => row.status === 'Active' && row.emailVerificationTokenHash === hash);
    if (users.length > 1) throw failure(); const user = users[0];
    if (!user || !expires(user.emailVerificationExpiresAt, currentTime(clock))) return null;
    if (Object.hasOwn(user, 'accountVerificationGeneration')) {
      const matching = [...jobsValid(db), ...(db[HISTORY] || [])].filter(job => job.userId === user.id && job.purpose === 'email-verification' && job.generation === user.accountVerificationGeneration && job.email === email(user.email) && job.tokenHash === hash && job.expiresAt === user.emailVerificationExpiresAt);
      if (matching.length !== 1) throw failure();
    }
    return { user, deadline: user.emailVerificationExpiresAt };
  }
  function consumeVerification(db, user) {
    user.emailVerifiedAt = new Date(currentTime(clock)).toISOString(); delete user.emailVerificationTokenHash; delete user.emailVerificationExpiresAt; delete user.accountVerificationGeneration;
    for (const job of jobsValid(db)) if (job.userId === user.id && job.purpose === 'email-verification') retire(job);
    archiveFinished(db); // verification preserves existing sessions
  }
  function invalidate(db, userId) {
    const user = db.users.find(row => row.id === userId); if (!user) throw failure();
    for (const name of ['resetTokenHash', 'resetExpiresAt', 'resetRequestedAt', 'accountResetGeneration', 'emailVerificationTokenHash', 'emailVerificationExpiresAt', 'accountVerificationGeneration']) delete user[name];
    for (const job of jobsValid(db)) if (job.userId === userId) retire(job);
    archiveFinished(db);
  }
  function valid(db, job) {
    activeIdentity(db, job.email);
    const users = (db.users || []).filter(row => row.id === job.userId && row.status === 'Active' && (!row.companyId || row.companyId === db.company.id));
    const user = users.length === 1 && users[0];
    const current = job.purpose === 'password-reset' ? user && user.accountResetGeneration === job.generation && user.resetTokenHash === job.tokenHash && user.resetExpiresAt === job.expiresAt : user && user.accountVerificationGeneration === job.generation && user.emailVerificationTokenHash === job.tokenHash && user.emailVerificationExpiresAt === job.expiresAt;
    return user && current && job.companyId === db.company.id && job.keyVersion === keyVersion && job.origin === origin && email(user.email) === job.email && expires(job.expiresAt, currentTime(clock));
  }
  async function dispatch(companyId, jobId) {
    const loaded = await load(companyId); if (!loaded) throw failure();
    const db = structuredClone(loaded.snapshot), matches = [...jobsValid(db), ...(db[HISTORY] || [])].filter(row => row.id === jobId);
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
    const resetUrl = new URL(job.purpose === 'password-reset' ? '/reset-password.html' : '/verify-email.html', origin); resetUrl.searchParams.set('tenant', companyId); resetUrl.searchParams.set('token', token);
    let outcome = 'uncertain';
    try { const result = await send({ purpose: job.purpose, dispatchId: job.dispatchId, to: job.email, ...(job.purpose === 'password-reset' ? { resetUrl: resetUrl.href } : { verifyUrl: resetUrl.href }) });
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
    archiveFinished(latest);
    try { await committed(latest, fresh.revision); } catch { return { status: 'uncertain' }; }
    return { status: outcome };
  }
  function invalidationImpact(db, userId) { const user = db.users.find(row => row.id === userId), jobs = jobsValid(db).filter(row => row.userId === userId); return { passwordResetLinks: user?.resetTokenHash ? 1 : 0, emailVerificationLinks: user?.emailVerificationTokenHash ? 1 : 0, queuedPasswordResetDeliveries: jobs.filter(row => row.purpose === 'password-reset' && row.status === 'queued').length, admittedPasswordResetDeliveries: jobs.filter(row => row.purpose === 'password-reset' && row.status === 'sending').length, queuedVerificationDeliveries: jobs.filter(row => row.purpose === 'email-verification' && row.status === 'queued').length, admittedVerificationDeliveries: jobs.filter(row => row.purpose === 'email-verification' && row.status === 'sending').length }; }
  return { requestReset, authorizeReset, consumeReset, requestVerification, authorizeVerification, consumeVerification, invalidate, invalidationImpact, dispatch };
}
module.exports = { COLLECTION, HISTORY, createCredentialDelivery, stripPrivate, validateOrigin, expires };
