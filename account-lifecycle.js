'use strict';
const crypto = require('node:crypto');
const { canonicalHash } = require('./database/transactional-repository');
const { accountOperation } = require('./compat-route-inventory');
const plan = require('./account-lifecycle-plan');
const { fingerprint } = require('./account-secret-recovery');
const registry = require('./capability-registry'), profiles = require('./role-profiles');
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const fail = (status, message) => plan.fail(status, message);
function privateRows(db, name) { const value = db[name] === undefined ? [] : db[name]; if (!Array.isArray(value)) fail(409, 'Account operation history needs reconciliation'); return value; }
const sessionBinding = auth => canonicalHash({ id: auth.session.id, hash: auth.session.tokenHash, userId: auth.user.id, companyId: auth.companyId });
function authorityState(db) { const copy = structuredClone(db); delete copy.accountActionPreviews; delete copy.accountActionReceipts; delete copy.accountSecretEnvelopes; return canonicalHash(copy); }
function impact(result) { const sanitize = value => value ? { ...value, setupExpiresAt: null } : null; return { before: sanitize(result.before), after: sanitize(result.after), manualTemporaryPassword: Boolean(result.temporaryPassword), expiresAfterHours: result.temporaryPassword ? 72 : null }; }
function createAccountLifecycle({ credentials, secretRecovery, proofKey, proofVersion = 'synthetic-review-v1', clock = Date.now }) {
  if (!Buffer.isBuffer(proofKey) || proofKey.length !== 32) fail(503, 'Account review proof is unavailable');
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(proofVersion)) fail(503, 'Account review version is unavailable');
  const proof = row => { const copy = { ...row }; delete copy.proof; return crypto.createHmac('sha256', proofKey).update('account-lifecycle-v1:' + canonicalHash(copy)).digest('hex'); };
  const sign = row => { const versioned = { ...row, proofVersion }; return { ...versioned, proof: proof(versioned) }; };
  function records(db, name) {
    const values = privateRows(db, name), seen = new Set();
    const names = name === 'accountActionPreviews' ? ['id', 'companyId', 'ownerId', 'sessionBinding', 'operationId', 'operation', 'input', 'reason', 'impact', 'impactHash', 'authorityHash', 'expectedRevision', 'expiresAt', 'proof', 'proofVersion'] : ['operationId', 'previewId', 'companyId', 'ownerId', 'sessionBinding', 'action', 'targetId', 'targetFingerprint', 'reviewRevision', 'committedRevision', 'status', 'result', 'envelopeId', 'at', 'proof', 'proofVersion'];
    for (const row of values) {
      if (!row || Array.isArray(row) || Object.keys(row).sort().join(',') !== names.slice().sort().join(',') || !uuid(row.operationId) || seen.has(row.operationId) || row.companyId !== db.company.id || !Number.isSafeInteger(row.ownerId) || row.ownerId < 1 || !/^[a-f0-9]{64}$/.test(row.sessionBinding) || typeof row.proof !== 'string' || !/^[a-f0-9]{64}$/.test(row.proof) || !crypto.timingSafeEqual(Buffer.from(row.proof, 'hex'), Buffer.from(proof(row), 'hex'))) fail(409, 'Account review history needs reconciliation');
      seen.add(row.operationId);
      if (row.proofVersion !== proofVersion) fail(409, 'The original review key version requires reconciliation');
    }
    return values;
  }
  async function handle(req, res, url, context, hooks) {
    const db = context.db, json = (status, data) => hooks.json(res, status, data), input = req.method === 'GET' ? {} : await hooks.body(req);
    const now = Number(clock()), apiPath = url.pathname;
    if (req.method === 'POST' && apiPath === '/api/auth/claim') {
      plan.closed(input, ['email', 'temporaryPassword', 'setupCode', 'password']);
      if (typeof input.email !== 'string' || typeof input.password !== 'string' || input.temporaryPassword !== undefined && typeof input.temporaryPassword !== 'string' || input.setupCode !== undefined && typeof input.setupCode !== 'string') fail(400, 'Enter valid password setup fields');
      const code = input.temporaryPassword || input.setupCode, users = db.users.filter(row => row.status === 'Active' && row.email.trim().toLowerCase() === input.email.trim().toLowerCase()), user = users.length === 1 && users[0];
      if (!user || !user.mustSetPassword || !Number.isFinite(Date.parse(user.setupExpiresAt)) || Date.parse(user.setupExpiresAt) <= now || user.setupIssuedEmail !== undefined && user.setupIssuedEmail !== user.email || typeof code !== 'string' || !hooks.verifyCredential(code, user.setupSalt, user.setupHash)) return json(401, { error: 'Invalid or expired temporary password' });
      if (db.users.filter(row => row.status === 'Active' && row.setupHash === user.setupHash && row.setupSalt === user.setupSalt).length !== 1) fail(409, 'Temporary password identity needs reconciliation');
      if (input.password.length < 10) fail(400, 'Password must be at least 10 characters');
      context.guard = { deadline: user.setupExpiresAt }; const credential = hooks.credentialHash(input.password); user.passwordHash = credential.hash; user.passwordSalt = credential.salt; user.mustSetPassword = false;
      for (const name of ['setupHash', 'setupSalt', 'setupExpiresAt', 'setupGeneration', 'setupIssuedEmail']) delete user[name]; secretRecovery.invalidate(db, user.id);
      hooks.stage(context, db); return json(200, { ok: true }); // claim keeps existing sessions
    }
    if (req.method === 'POST' && apiPath === '/api/auth/email-verification/confirm') {
      plan.closed(input, ['token']); if (typeof input.token !== 'string') fail(400, 'Enter a valid verification token');
      const authorized = credentials.authorizeVerification(db, input.token); if (!authorized) return json(401, { error: 'This email confirmation link is invalid or expired' });
      context.guard = { deadline: authorized.deadline }; credentials.consumeVerification(db, authorized.user); hooks.stage(context, db); return json(200, { ok: true, email: authorized.user.email });
    }
    if (req.method === 'GET' && apiPath === '/api/health') return json(200, { ok: true, authRequired: true, productionReady: false });
    const auth = hooks.authenticate(req, db).auth;
    if (!auth) return json(401, { error: 'Authentication required' });
    if (req.method === 'GET' && apiPath === '/api/account-identity') return json(200, { id: auth.user.id, companyId: auth.companyId, role: auth.user.role, accountSessionBinding: sessionBinding(auth) });
    if (req.method === 'POST' && apiPath === '/api/auth/email-verification/resend') {
      plan.closed(input, []); const queued = credentials.requestVerification(db, auth.user.id); if (!queued) return json(200, { ok: true, alreadyVerified: true }); context.deliveryJob = queued.jobId; hooks.stage(context, db); return json(200, { ok: true });
    }
    if (!apiPath.startsWith('/api/users') && !apiPath.startsWith('/api/account-actions') && apiPath !== '/api/team-with-account') return false;
    if (auth.user.role !== 'owner') return json(403, { error: 'Account owner permission required' });
    if (req.method === 'GET' && apiPath === '/api/users') return json(200, plan.directory(db));
    const operation = accountOperation(req.method, apiPath);
    if (operation?.action === 'preferences') { const result = plan.apply(db, auth, operation, input, { clock, credentialHash: hooks.credentialHash, billingPlan: hooks.billingPlan }); hooks.stage(context, db); return json(200, result.result); }
    if (operation) return json(409, { error: 'Review the account change before confirming it.', code: 'ACCOUNT_REVIEW_REQUIRED' });
    if (req.method !== 'POST') return false;
    if (apiPath === '/api/account-actions/preview') {
      plan.closed(input, ['method', 'path', 'input', 'reason', 'operationId']);
      const op = accountOperation(input.method, input.path); if (!op || op.action === 'preferences' || !uuid(input.operationId) || typeof input.reason !== 'string' || input.reason.trim().length < 8 || input.reason.length > 500) fail(400, 'Choose a supported account action and explain the change');
      if (records(db, 'accountActionPreviews').some(row => row.operationId === input.operationId) || records(db, 'accountActionReceipts').some(row => row.operationId === input.operationId)) fail(409, 'This account operation already exists; check its original result');
      const simulated = structuredClone(db), result = plan.apply(simulated, auth, op, input.input, { clock, credentialHash: hooks.credentialHash, billingPlan: hooks.billingPlan }, () => 'Preview0'), currentImpact = impact(result);
      const record = { id: crypto.randomUUID(), companyId: db.company.id, ownerId: auth.user.id, sessionBinding: sessionBinding(auth), operationId: input.operationId, operation: op, input: result.normalized, reason: input.reason.trim(), impact: currentImpact, impactHash: canonicalHash(currentImpact), authorityHash: authorityState(db), expectedRevision: context.transactionalRevision + 1, expiresAt: new Date(Math.min(now + 15 * 60000, Date.parse(auth.session.expiresAt))).toISOString() };
      db.accountActionPreviews = [...records(db, 'accountActionPreviews'), sign(record)]; hooks.stage(context, db); return json(200, { previewId: record.id, operationId: record.operationId, expectedRevision: record.expectedRevision, expiresAt: record.expiresAt, impact: currentImpact, reason: record.reason });
    }
    if (apiPath === '/api/account-actions/confirm') {
      plan.closed(input, ['previewId', 'operationId', 'expectedRevision', 'confirmed']);
      if (!uuid(input.previewId) || !uuid(input.operationId) || !Number.isSafeInteger(input.expectedRevision) || input.confirmed !== true) fail(400, 'Explicitly confirm the reviewed account change');
      const existing = records(db, 'accountActionReceipts').filter(row => row.operationId === input.operationId);
      if (existing.length) { if (existing.length !== 1 || existing[0].previewId !== input.previewId || existing[0].reviewRevision !== input.expectedRevision) fail(409, 'Check the original confirmed account operation'); return recover(existing, auth, context, json); }
      const matches = records(db, 'accountActionPreviews').filter(row => row.id === input.previewId); if (matches.length !== 1) fail(409, 'Account preview needs reconciliation'); const preview = matches[0];
      if (preview.companyId !== db.company.id || preview.ownerId !== auth.user.id || preview.sessionBinding !== sessionBinding(auth) || preview.operationId !== input.operationId || preview.expectedRevision !== input.expectedRevision || preview.expectedRevision !== context.transactionalRevision || preview.authorityHash !== authorityState(db) || !Number.isFinite(Date.parse(preview.expiresAt)) || Date.parse(preview.expiresAt) <= now || preview.impactHash !== canonicalHash(preview.impact)) fail(409, 'Account authority changed; review a new preview');
      const normalized = plan.normalize(db, preview.operation.action, preview.input); if (canonicalHash(normalized) !== canonicalHash(preview.input)) fail(409, 'Account proposal needs reconciliation');
      const result = plan.apply(db, auth, preview.operation, normalized, { clock, credentialHash: hooks.credentialHash, billingPlan: hooks.billingPlan }); if (canonicalHash(impact(result)) !== preview.impactHash) fail(409, 'Account impact changed; review again');
      const target = db.users.find(row => row.id === result.targetId); secretRecovery.invalidate(db, target.id); credentials.invalidate(db, target.id);
      const envelopeId = result.temporaryPassword ? secretRecovery.enclose(db, auth, preview.operationId, target, result.temporaryPassword) : null; result.temporaryPassword = null;
      const receipt = sign({ operationId: preview.operationId, previewId: preview.id, companyId: db.company.id, ownerId: auth.user.id, sessionBinding: sessionBinding(auth), action: preview.operation.action, targetId: target.id, targetFingerprint: fingerprint(db, target), reviewRevision: preview.expectedRevision, committedRevision: context.transactionalRevision + 1, status: result.status, result: result.result, envelopeId, at: new Date(now).toISOString() });
      db.accountActionReceipts = [...records(db, 'accountActionReceipts'), receipt]; db.auditLog ||= []; db.auditLog.push({ id: crypto.randomUUID(), type: 'account_change_confirmed', operationId: receipt.operationId, userId: target.id, actor: auth.user.name, action: receipt.action, reason: preview.reason, before: preview.impact.before, after: preview.impact.after, at: receipt.at });
      context.guard = { deadline: preview.expiresAt }; context.accountReturn = receipt.operationId; hooks.stage(context, db); return json(result.status, result.result);
    }
    if (apiPath === '/api/account-actions/recover') { plan.closed(input, ['operationId']); if (!uuid(input.operationId)) fail(400, 'Choose an original account operation'); return recover(records(db, 'accountActionReceipts').filter(row => row.operationId === input.operationId), auth, context, json); }
    if (['/api/account-actions/status', '/api/account-actions/reconcile'].includes(apiPath)) {
      plan.closed(input, apiPath.endsWith('/status') ? ['operationId'] : ['operationId', 'expectedRevision', 'confirmed', 'reason']);
      if (!uuid(input.operationId)) fail(400, 'Choose the original account operation');
      const receipts = records(db, 'accountActionReceipts').filter(row => row.operationId === input.operationId), previews = records(db, 'accountActionPreviews').filter(row => row.operationId === input.operationId), original = receipts[0] || previews[0];
      if (receipts.length > 1 || previews.length > 1 || !original || original.ownerId !== auth.user.id || original.sessionBinding !== sessionBinding(auth)) fail(409, 'The original operation requires current owner reconciliation');
      const result = { operationId: input.operationId, outcome: receipts.length ? 'committed' : 'no-receipt-in-current-revision', currentRevision: context.transactionalRevision, accounts: plan.directory(db), confirmedAction: receipts.length ? { action: receipts[0].action, targetId: receipts[0].targetId, at: receipts[0].at } : null, notice: 'The original proof and audit remain retained. Closing this browser recovery item does not resend the action or assert that an unknown outcome was unsaved.' };
      if (apiPath.endsWith('/reconcile')) {
        if (input.confirmed !== true || input.expectedRevision !== context.transactionalRevision || typeof input.reason !== 'string' || input.reason.trim().length < 8 || input.reason.length > 500) fail(409, 'Review the current accounts and explicitly confirm reconciliation');
        db.auditLog ||= []; db.auditLog.push({ id: crypto.randomUUID(), type: 'account_original_result_reconciled', operationId: input.operationId, actor: auth.user.name, reason: input.reason.trim(), observedOutcome: result.outcome, at: new Date(now).toISOString() }); hooks.stage(context, db);
      }
      return json(200, result);
    }
    return false;
  }
  function recover(matches, auth, context, json) {
    if (matches.length !== 1) fail(409, 'No committed result is available for this original operation'); const row = matches[0], db = context.db, target = db.users.find(user => user.id === row.targetId);
    if (row.companyId !== db.company.id || row.ownerId !== auth.user.id || row.sessionBinding !== sessionBinding(auth) || !target || fingerprint(db, target) !== row.targetFingerprint) fail(409, 'This original account operation requires current owner review');
    context.accountReturn = row.operationId; return json(row.status, row.result);
  }
  function deliver(context, db, auth) {
    const matches = records(db, 'accountActionReceipts').filter(row => row.operationId === context.accountReturn); if (matches.length !== 1) fail(409, 'Account receipt needs reconciliation'); const receipt = matches[0];
    const target = db.users.find(user => user.id === receipt.targetId); if (auth.user.role !== 'owner' || receipt.ownerId !== auth.user.id || receipt.companyId !== auth.companyId || receipt.sessionBinding !== sessionBinding(auth) || !target || fingerprint(db, target) !== receipt.targetFingerprint) fail(409, 'Account authority changed before result delivery');
    context.response.data = { ...receipt.result, ...(receipt.envelopeId ? secretRecovery.recover(db, auth, receipt.operationId) : {}) };
  }
  return { handle, deliver, sessionBinding, directory: plan.directory, actor: registry.actor, profiles, invalidateManual: secretRecovery.invalidate };
}
module.exports = { createAccountLifecycle, authorityState, sessionBinding };
