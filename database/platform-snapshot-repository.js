'use strict';
// The existing companies.data platform envelope has its own authority. Its
// assistant-usage tenant_records/tenant_revisions namespace is independent.
const { stableUuid } = require('./migrate-json');
const { canonicalHash, RevisionConflictError } = require('./transactional-repository');
const PLATFORM_ID = stableUuid('platform', 'pro-daily-link-operations');
const PLATFORM_NAME = 'Pro Daily Link Platform Operations';
const unavailable = () => Object.assign(Error('Shared platform authority is unavailable.'), { statusCode: 503, code: 'PDL_PLATFORM_STORAGE' });
const unknown = () => Object.assign(Error('The saved platform result is unknown. Check the original result before retrying.'), { statusCode: 503, code: 'PDL_COMMIT_OUTCOME_UNKNOWN' });
const object = value => Boolean(value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)));
function json(value, seen = new Set(), depth = 0) {
  if (depth > 100) return false;
  if (value === null || ['string', 'boolean'].includes(typeof value) || typeof value === 'number' && Number.isFinite(value)) return true;
  if (!object(value) && !Array.isArray(value) || seen.has(value)) return false;
  seen.add(value);
  const valid = (Array.isArray(value) ? [...value] : Object.values(value)).every(child => json(child, seen, depth + 1));
  seen.delete(value); return valid;
}
function envelope(snapshot, id) {
  return id === PLATFORM_ID && object(snapshot) && Object.keys(snapshot).length === 2 && Object.hasOwn(snapshot, 'company') && Object.hasOwn(snapshot, 'platform') && object(snapshot.company) && Object.keys(snapshot.company).length === 2 && snapshot.company.id === id && snapshot.company.name === PLATFORM_NAME && object(snapshot.platform) && json(snapshot);
}
function createRepository(transport, platformId) {
  if (typeof transport?.request !== 'function' || platformId !== PLATFORM_ID) throw unavailable();
  const matching = id => { if (id !== platformId) throw unavailable(); };
  return {
    async load(id = platformId) {
      matching(id);
      let rows;
      try { rows = await (await transport.request(`/rest/v1/companies?id=eq.${platformId}&select=id,data,platform_revision,platform_managed,roles_managed&limit=1`)).json(); }
      catch { throw unavailable(); }
      if (!Array.isArray(rows) || rows.length !== 1 || rows[0].id !== platformId || rows[0].platform_managed !== true || rows[0].roles_managed !== false || !envelope(rows[0].data, platformId)) throw unavailable();
      const revision = Number(rows[0].platform_revision);
      if (!['number', 'string'].includes(typeof rows[0].platform_revision) || typeof rows[0].platform_revision === 'string' && !/^(0|[1-9]\d*)$/.test(rows[0].platform_revision) || !Number.isSafeInteger(revision) || revision < 0 || revision >= Number.MAX_SAFE_INTEGER) throw unavailable();
      // A fully seeded read-only start must prove the installed contract too;
      // it cannot depend on an incidental help-seed or other write to do so.
      try {
        const ready = await (await transport.request('/rest/v1/rpc/platform_snapshot_trigger_contract', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
        if (ready !== true) throw unavailable();
      } catch { throw unavailable(); }
      const snapshot = structuredClone(rows[0].data);
      return { snapshot, revision, contentHash: canonicalHash(snapshot), managed: true };
    },
    async commit(snapshot, expectedRevision, guard) {
      if (!envelope(snapshot, platformId) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || expectedRevision >= Number.MAX_SAFE_INTEGER - 1 || !object(guard) || Object.keys(guard).length !== 1 || typeof guard.deadline !== 'string' || !Number.isFinite(Date.parse(guard.deadline)) || new Date(guard.deadline).toISOString() !== guard.deadline) throw unavailable();
      // Capture the exact original candidate and deadline before an await.
      const candidate = structuredClone(snapshot), deadline = guard.deadline;
      const body = JSON.stringify({ p_platform_id: platformId, p_expected_revision: expectedRevision, p_snapshot: candidate, p_deadline: deadline });
      if (Buffer.byteLength(body) > 16777216) throw unavailable();
      let response;
      try { response = await transport.request('/rest/v1/rpc/commit_platform_snapshot', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }); }
      catch (error) {
        if (error?.code === '40001' || /PDL_REVISION_CONFLICT|PDL_PLATFORM_DEADLINE/.test(String(error?.message))) throw new RevisionConflictError(expectedRevision, -1);
        throw unknown();
      }
      try {
        const rows = await response.json();
        if (!Array.isArray(rows) || rows.length !== 1 || !['number', 'string'].includes(typeof rows[0].revision) || typeof rows[0].revision === 'string' && !/^(0|[1-9]\d*)$/.test(rows[0].revision) || Number(rows[0].revision) !== expectedRevision + 1) throw Error('Invalid acknowledgement');
      } catch { throw unknown(); }
      return { revision: expectedRevision + 1, contentHash: canonicalHash(candidate) };
    }
  };
}
module.exports = { PLATFORM_ID, PLATFORM_NAME, envelope, createRepository };
