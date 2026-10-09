'use strict';
// In-place account adapter over the reviewed tenant revision/record contract.
// Construction is test-only until the complete writer inventory is integrated.
const { Pool } = require('pg');
const { canonicalHash, splitSnapshot, assembleSnapshot, RevisionConflictError } = require('./transactional-repository');
const unavailable = () => Object.assign(Error('Consistent account storage unavailable.'), { statusCode: 503, code: 'PDL_COMPAT_STORAGE' });
function split(snapshot) {
  const result = splitSnapshot(snapshot);
  // Preserve absent/null/empty distinctly without changing main's old adapter.
  for (const [name, value] of Object.entries(snapshot)) if (Array.isArray(value) && !value.length) result.scalarData[name] = [];
  return result;
}
class CompatTenantRepository {
  constructor({ connectionString, companyId, synthetic = false }) {
    let url; try { url = new URL(connectionString); } catch { throw unavailable(); }
    if (process.env.NODE_ENV !== 'test' || process.env.PDL_COMPAT_ACCOUNT_SYNTHETIC !== '1' || !synthetic || !['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !/^\/(?:pdl_compat_|compat_test)/.test(url.pathname)) throw unavailable();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(companyId)) throw unavailable();
    this.companyId = companyId;
    this.pool = new Pool({ connectionString, max: 4, ssl: false });
  }
  matching(id) { if (id !== this.companyId) throw unavailable(); }
  async transaction(task, isolation = 'READ COMMITTED') {
    const client = await this.pool.connect();
    let committing = false;
    try {
      await client.query('BEGIN'); await client.query('SET TRANSACTION ISOLATION LEVEL ' + isolation);
      await client.query('SELECT set_config($1,$2,true)', ['app.company_id', this.companyId]);
      const result = await task(client); committing = true; await client.query('COMMIT'); return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      if (error.code === '40001') throw new RevisionConflictError(-1, -1);
      // Never propagate connection/provider bodies or candidate credentials.
      if (error.code === 'PDL_REVISION_CONFLICT' || error.code === 'PDL_COMPAT_STORAGE') throw error;
      if (committing) throw Object.assign(Error('The saved account result is unknown. Check sign-in before explicitly retrying.'), { statusCode: 503, code: 'PDL_COMMIT_OUTCOME_UNKNOWN' });
      throw unavailable();
    } finally { client.release(); }
  }
  async load(id) {
    this.matching(id);
    return this.transaction(async client => {
      const state = await client.query('SELECT revision, scalar_data, content_hash FROM public.tenant_revisions WHERE company_id=$1', [id]);
      if (state.rowCount !== 1) throw unavailable();
      const row = state.rows[0], revision = Number(row.revision);
      if (!Number.isSafeInteger(revision) || revision < 0) throw unavailable();
      const records = await client.query('SELECT collection, position, data FROM public.tenant_records WHERE company_id=$1 ORDER BY collection, position', [id]);
      const snapshot = assembleSnapshot(row.scalar_data, records.rows);
      if (snapshot.company?.id !== id || canonicalHash(snapshot) !== row.content_hash) throw unavailable();
      return { snapshot, revision, contentHash: row.content_hash };
    }, 'REPEATABLE READ');
  }
  async commit(snapshot, expectedRevision, guard) {
    this.matching(snapshot?.company?.id);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || expectedRevision >= Number.MAX_SAFE_INTEGER) throw unavailable();
    if (guard !== undefined && (!guard || Object.keys(guard).length !== 1 || typeof guard.deadline !== 'string' || !Number.isFinite(Date.parse(guard.deadline)))) throw unavailable();
    const { scalarData, records } = split(snapshot), hash = canonicalHash(snapshot);
    const payload = records.map(row => ({ collection: row.collection, record_key: row.recordKey, position: row.position, data: row.data }));
    return this.transaction(async client => {
      const locked = await client.query('SELECT revision FROM public.tenant_revisions WHERE company_id=$1 FOR UPDATE', [this.companyId]);
      if (locked.rowCount !== 1) throw unavailable();
      if (Number(locked.rows[0].revision) !== expectedRevision) throw new RevisionConflictError(expectedRevision, Number(locked.rows[0].revision));
      // Evaluate deadline AFTER the actual database row lock. A blocked worker
      // must not accept a token/session that expired while awaiting its turn.
      if (guard) { const result = await client.query('SELECT clock_timestamp() < $1::timestamptz AS valid', [guard.deadline]); if (result.rows[0]?.valid !== true) throw new RevisionConflictError(expectedRevision, expectedRevision); }
      const result = await client.query('SELECT * FROM public.replace_tenant_records($1,$2,$3::jsonb,$4,$5::jsonb)', [this.companyId, expectedRevision, JSON.stringify(scalarData), hash, JSON.stringify(payload)]);
      const row = result.rows[0];
      if (result.rowCount !== 1 || Number(row.revision) !== expectedRevision + 1 || Number(row.record_count) !== records.length) throw unavailable();
      return { revision: Number(row.revision), contentHash: hash };
    });
  }
  async close() { await this.pool.end(); }
}
module.exports = { CompatTenantRepository, split };
