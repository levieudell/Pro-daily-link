'use strict';
const { canonicalHash, databaseCompanyId } = require('./transactional-repository');
const enabled = () => process.env.PDL_TENANT_ATOMIC === '1';
const unavailable = message => Object.assign(new Error(message), { code: 'PDL_TENANT_ADMISSION', statusCode: 503 });
const unknownCommit = () => Object.assign(new Error('Tenant commit outcome is unknown. Verify the saved revision or replay an idempotent action before retrying.'), { code: 'PDL_COMMIT_OUTCOME_UNKNOWN', statusCode: 503 });
function requireRevision(revision) {
  if (!Number.isSafeInteger(revision) || revision < 0 || revision >= Number.MAX_SAFE_INTEGER) throw unavailable('An explicit safe expected tenant revision is required.');
  return revision;
}
function blockLegacyWriter(operation) { if (enabled()) throw unavailable('Atomic tenant admission does not support ' + operation + '.'); }
function createAdmission({ load, commit, mirror = async () => {} }) {
  async function begin(companyId) {
    const loaded = await load(companyId);
    if (!loaded || !Number.isSafeInteger(loaded.revision) || loaded.revision < 0 || databaseCompanyId(loaded.snapshot) !== databaseCompanyId(companyId) || loaded.contentHash !== canonicalHash(loaded.snapshot)) throw unavailable('An initialized consistent tenant snapshot is required.');
    return { atomic: true, companyId: loaded.snapshot.company.id, db: structuredClone(loaded.snapshot), transactionalRevision: loaded.revision, pending: [], dirty: false, closed: false, deferResponse: true };
  }
  function stage(context, snapshot) {
    if (!context?.atomic || context.closed || String(snapshot?.company?.id) !== String(context.companyId)) throw unavailable('A current matching tenant admission is required.');
    context.db = snapshot; context.candidate = structuredClone(snapshot); context.dirty = true;
  }
  async function finish(context) {
    if (!context?.atomic || context.closed) throw unavailable('Tenant admission is unavailable.');
    context.closed = true;
    if (!context.dirty) return { committed: false };
    requireRevision(context.transactionalRevision);
    let result;
    try { result = await commit(context.candidate, context.transactionalRevision, context.policyGuard); }
    catch (error) {
      if (error?.code === 'PDL_REVISION_CONFLICT' || error?.commitRejected === true) throw error;
      throw unknownCommit();
    }
    if (result?.revision !== context.transactionalRevision + 1 || result.contentHash !== canonicalHash(context.candidate)) throw unknownCommit();
    context.transactionalRevision = result.revision;
    // This is a disposable mirror, never an authorization/load fallback. A
    // post-commit mirror failure cannot claim that an authoritative save failed.
    let mirrored = true;
    try { await mirror(context.candidate, result); } catch { mirrored = false; }
    return { committed: true, revision: result.revision, mirrored };
  }
  return { begin, stage, finish };
}
module.exports = { enabled, unavailable, unknownCommit, requireRevision, blockLegacyWriter, createAdmission };
