'use strict';
const crypto = require('node:crypto');
const { canonicalHash } = require('./database/transactional-repository');
const { validateAccounts } = require('./account-evidence');
const { validateWorkspace } = require('./compat-workspace-evidence');
const registry = require('./capability-registry');
const jobs = 'workspaceComplianceJobs', purpose = 'automatic-subcontractor-compliance-v1';
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const object = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key));
const fail = () => { throw Object.assign(Error('Dashboard delivery records need reconciliation.'), { statusCode: 409 }); };
const validText = value => typeof value === 'string' && value.length <= 500;
const generation = source => canonicalHash({ companyId: source.companyId, subcontractorId: source.subcontractorId, email: source.email, stages: source.items.map(row => ({ key: row.key, stage: row.stage, value: row.value ?? null })) });
function descriptor(db, sub, requirements, now) {
  const pending = requirements(sub, now).filter(item => sub.complianceReminderStages?.[item.key] !== item.stage);
  if (sub.archivedAt || sub.status === 'Archived' || sub.autoComplianceReminders !== true || typeof sub.email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(sub.email) || !pending.length) return null;
  return { companyId: db.company.id, companyName: db.company.name, subcontractorId: sub.id, email: sub.email, contact: sub.contact || sub.name, name: sub.name, items: pending.map(row => ({ key: row.key, label: row.label, state: row.state, stage: row.stage, ...(row.days !== undefined ? { days: row.days } : {}), ...(row.value !== undefined ? { value: row.value } : {}) })) };
}
function validateDescriptor(source, companyId) {
  if (!object(source, ['companyId','companyName','subcontractorId','email','contact','name','items']) || source.companyId !== companyId || !Number.isSafeInteger(source.subcontractorId) || source.subcontractorId < 1 || ![source.companyName, source.email, source.contact, source.name].every(validText) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(source.email) || !Array.isArray(source.items) || !source.items.length || source.items.length > 5) fail();
  const keys = new Set();
  for (const row of source.items) {
    const fields = ['key','label','state','stage', ...(Object.hasOwn(row || {}, 'days') ? ['days'] : []), ...(Object.hasOwn(row || {}, 'value') ? ['value'] : [])];
    if (!object(row, fields) || !['insurance','workers_comp','license','w9','agreement'].includes(row.key) || keys.has(row.key) || !validText(row.label) || !['missing','expired','expiring'].includes(row.state) || !/^(?:missing|1|7|14|30|overdue-\d+)$/.test(row.stage) || row.days !== undefined && !Number.isSafeInteger(row.days) || row.value !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(row.value)) fail();
    keys.add(row.key);
  }
}
function actorBinding(db, auth) {
  return canonicalHash({ actorId: auth.user.id, companyId: auth.companyId, role: auth.user.role, sessionId: auth.session.id, sessionHash: auth.session.tokenHash, permissions: auth.user.permissions || {}, memberId: auth.user.memberId ?? null, projectIds: auth.user.projectIds || [], assignedCrews: auth.user.assignedCrews || [], effective: registry.effective(db, auth.user), profiles: require('./role-profiles').binding(db, auth.user) });
}
function createCompliance({ repository, companyId, requirements, send, authenticateSession, accountAccess, key, clock = Date.now }) {
  if (typeof send !== 'function' || typeof authenticateSession !== 'function' || !Buffer.isBuffer(key) || key.length !== 32) throw Error('Explicit synthetic compliance contracts required');
  function proof(row) { const copy = { ...row }; delete copy.proof; return crypto.createHmac('sha256', key).update(purpose + ':' + canonicalHash(copy)).digest('hex'); }
  function sign(row) { row.proof = proof(row); return row; }
  function valid(db) {
    validateAccounts(db); validateWorkspace(db);
    const values = db[jobs] === undefined ? [] : db[jobs], seen = new Set();
    if (!Array.isArray(values) || values.length > 50000) fail();
    for (const row of values) {
      const fields = ['id','companyId','purpose','actorId','sessionHash','actorBinding','generation','sourceHash','source','status','createdAt','expiresAt','proof', ...(Object.hasOwn(row || {}, 'attemptId') ? ['attemptId'] : []), ...(Object.hasOwn(row || {}, 'finishedAt') ? ['finishedAt'] : [])];
      if (!object(row, fields) || !uuid(row.id) || seen.has(row.id) || row.companyId !== companyId || row.purpose !== purpose || !Number.isSafeInteger(row.actorId) || row.actorId < 1 || ![row.sessionHash,row.actorBinding,row.generation,row.sourceHash,row.proof].every(hash) || !['queued','sending','sent','uncertain','rejected','cancelled'].includes(row.status) || !Number.isFinite(Date.parse(row.createdAt)) || !Number.isFinite(Date.parse(row.expiresAt)) || Date.parse(row.expiresAt) <= Date.parse(row.createdAt) || Date.parse(row.expiresAt) > Date.parse(row.createdAt) + 10 * 60000 || row.attemptId !== undefined && !uuid(row.attemptId) || row.finishedAt !== undefined && !Number.isFinite(Date.parse(row.finishedAt)) || row.status === 'queued' && (row.attemptId !== undefined || row.finishedAt !== undefined) || ['sending','sent','uncertain','rejected'].includes(row.status) && !row.attemptId || !crypto.timingSafeEqual(Buffer.from(row.proof, 'hex'), Buffer.from(proof(row), 'hex'))) fail();
      validateDescriptor(row.source, companyId); if (canonicalHash(row.source) !== row.sourceHash || generation(row.source) !== row.generation) fail(); seen.add(row.id);
    }
    return values;
  }
  function current(db, job) {
    valid(db);
    const matches = (db.subcontractors || []).filter(row => row.id === job.source.subcontractorId); if (matches.length !== 1) fail();
    const auth = authenticateSession(db, job.sessionHash), source = descriptor(db, matches[0], requirements, new Date(clock()));
    return auth && auth.user.id === job.actorId && auth.companyId === companyId && ['owner','admin','project_manager'].includes(auth.user.role) && actorBinding(db, auth) === job.actorBinding && Date.parse(auth.session.expiresAt) > clock() && Date.parse(job.expiresAt) > clock() && !accountAccess(db.company).locked && source && canonicalHash(source) === job.sourceHash ? auth : null;
  }
  function stage(db, req) {
    const ledger = valid(db), at = new Date(clock()); let changed = false;
    const actor=authenticateSession(db,req.auth?.session?.tokenHash);
    if(!actor||!['owner','admin','project_manager'].includes(actor.user.role)||actor.companyId!==companyId||actorBinding(db,actor)!==actorBinding(db,req.auth)||Date.parse(actor.session.expiresAt)<=clock()||accountAccess(db.company).locked)fail();
    for (const sub of db.subcontractors || []) {
      const source = descriptor(db, sub, requirements, at); if (!source) continue; validateDescriptor(source, companyId);
      const sourceGeneration = generation(source);
      if (ledger.some(row => row.generation === sourceGeneration && !['cancelled','rejected'].includes(row.status))) continue;
      ledger.push(sign({ id: crypto.randomUUID(), companyId, purpose, actorId: req.auth.user.id, sessionHash: req.auth.session.tokenHash, actorBinding: actorBinding(db, req.auth), generation: sourceGeneration, sourceHash: canonicalHash(source), source, status: 'queued', createdAt: at.toISOString(), expiresAt: new Date(Math.min(+at + 10 * 60000, Date.parse(req.auth.session.expiresAt))).toISOString() })); changed = true;
    }
    if (changed) db[jobs] = ledger; return changed;
  }
  async function load(expected) { const loaded = await repository.load(companyId); if (!loaded || loaded.snapshot?.company?.id !== companyId || loaded.contentHash !== canonicalHash(loaded.snapshot) || expected && (loaded.revision !== expected.revision || loaded.contentHash !== expected.contentHash)) fail(); valid(loaded.snapshot); return loaded; }
  async function commit(db, revision, guard) { const result = await repository.commit(db, revision, guard); if (result.revision !== revision + 1 || result.contentHash !== canonicalHash(db)) fail(); return result; }
  const outcome = receipt => object(receipt, ['status']) && ['accepted','rejected','unknown'].includes(receipt.status) ? receipt.status : 'unknown';
  async function dispatch(id, expected) {
    let loaded = await load(expected), db = loaded.snapshot, job = valid(db).find(row => row.id === id); if (!job) fail();
    if (job.status !== 'queued') return { status: job.status === 'sending' ? 'uncertain' : job.status, revision: loaded.revision, contentHash: loaded.contentHash };
    const auth = current(db, job);
    if (!auth) { job.status = 'cancelled'; sign(job); return { status: 'cancelled', ...await commit(db, loaded.revision) }; }
    job.status = 'sending'; job.attemptId = crypto.randomUUID(); sign(job); const claim = canonicalHash(job), access = accountAccess(db.company);
    const deadline = new Date(Math.min(Date.parse(job.expiresAt), Date.parse(auth.session.expiresAt), access.status === 'Trial' ? Date.parse(db.company.trialEndsAt) : Infinity)).toISOString();
    const claimed = await commit(db, loaded.revision, { deadline });
    loaded = await load(claimed); db = loaded.snapshot; job = valid(db).find(row => row.id === id);
    if (!job || canonicalHash(job) !== claim || !current(db, job)) fail();
    let provider = 'unknown'; try { provider = outcome(await send(structuredClone(job.source), { idempotencyKey: job.id })); } catch { /* No provider bodies or error strings enter receipts. */ }
    loaded = await load(claimed); db = loaded.snapshot; job = valid(db).find(row => row.id === id);
    if (!job || canonicalHash(job) !== claim) fail();
    const stillCurrent = current(db, job);
    job.status = provider === 'accepted' && stillCurrent ? 'sent' : provider === 'rejected' ? 'rejected' : 'uncertain'; job.finishedAt = new Date(clock()).toISOString(); sign(job);
    if (job.status === 'sent') {
      const sub = db.subcontractors.find(row => row.id === job.source.subcontractorId); sub.complianceReminderStages ||= {};
      for (const item of job.source.items) sub.complianceReminderStages[item.key] = item.stage;
      sub.complianceHistory ||= []; sub.complianceHistory.push({ action: 'Automatic reminder sent', detail: job.source.items.map(item => item.label).join(', '), at: job.finishedAt }); sub.lastComplianceReminderAt = job.finishedAt;
    }
    const committed = await commit(db, loaded.revision, job.status === 'sent' ? { deadline } : undefined);
    return { status: job.status, ...committed };
  }
  return { stage, dispatch, valid };
}
module.exports = { createCompliance, descriptor, validateDescriptor, jobs };
