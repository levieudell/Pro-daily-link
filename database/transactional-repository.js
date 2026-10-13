'use strict';

const crypto = require('node:crypto');
const { Pool } = require('pg');
const { stableUuid } = require('./migrate-json');
const compatibilityBoundary = require('../compat-account-boundary');

class RevisionConflictError extends Error {
  constructor(expected, actual) {
    super(`Tenant revision conflict: expected ${expected}, found ${actual}`);
    this.name = 'RevisionConflictError';
    this.code = 'PDL_REVISION_CONFLICT';
    this.expected = expected;
    this.actual = actual;
  }
}

function databaseCompanyId(snapshotOrId) {
  const value = typeof snapshotOrId === 'object' ? snapshotOrId?.company?.id : snapshotOrId;
  if (/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(String(value))) return String(value);
  return stableUuid('legacy-company', String(value));
}

function recordKey(collection, row, index) {
  if (row && typeof row === 'object' && row.id != null) return `id:${String(row.id)}`;
  if (collection === 'sessions' && row?.tokenHash) return `token:${row.tokenHash}`;
  const digest = crypto.createHash('sha256').update(JSON.stringify(row)).digest('hex').slice(0, 24);
  return `pos:${index}:${digest}`;
}

function splitSnapshot(snapshot) {
  const scalarData = {};
  const records = [];
  for (const [collection, value] of Object.entries(snapshot || {})) {
    if (!Array.isArray(value)) {
      scalarData[collection] = value;
      continue;
    }
    value.forEach((row, position) => records.push({ collection, recordKey: recordKey(collection, row, position), position, data: row }));
  }
  return { scalarData, records };
}

function assembleSnapshot(scalarData, rows) {
  const snapshot = structuredClone(scalarData || {});
  for (const row of rows || []) {
    snapshot[row.collection] ||= [];
    snapshot[row.collection].push(row.data);
  }
  return snapshot;
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalValue(value[key])]));
}

function canonicalHash(snapshot) {
  return crypto.createHash('sha256').update(JSON.stringify(canonicalValue(snapshot))).digest('hex');
}

class TransactionalTenantRepository {
  constructor(options = {}) {
    this.pool = options.pool || new Pool({ connectionString: options.connectionString || process.env.DATABASE_URL, ssl: options.ssl ?? (process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined), max: Number(process.env.PDL_DATABASE_POOL_SIZE || 10) });
  }

  async withTenant(companyId, task, isolation = 'READ COMMITTED') {
    compatibilityBoundary.assertLegacy(companyId);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET TRANSACTION ISOLATION LEVEL ${isolation}`);
      await client.query('SELECT set_config($1,$2,true)', ['app.company_id', companyId]);
      const result = await task(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async load(companyId) {
    const id = databaseCompanyId(companyId);
    return this.withTenant(id, async client => {
      const state = await client.query('SELECT revision, scalar_data, content_hash FROM tenant_revisions WHERE company_id=$1', [id]);
      if (!state.rowCount) return null;
      const records = await client.query('SELECT collection, data FROM tenant_records WHERE company_id=$1 ORDER BY collection, position', [id]);
      const snapshot = assembleSnapshot(state.rows[0].scalar_data, records.rows);
      return { snapshot, revision: Number(state.rows[0].revision), contentHash: state.rows[0].content_hash };
    });
  }

  async save(snapshot, expectedRevision = null) {
    compatibilityBoundary.assertLegacySnapshot(snapshot);
    const id = databaseCompanyId(snapshot);
    const { scalarData, records } = splitSnapshot(snapshot);
    const hash = canonicalHash(snapshot);
    return this.withTenant(id, async client => {
      await client.query('INSERT INTO companies(id,slug,name) VALUES($1,$2,$3) ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name', [id, `company-${id}`, snapshot.company?.name || 'Company']);
      await client.query("INSERT INTO tenant_revisions(company_id,revision,scalar_data,content_hash,updated_at) VALUES($1,0,'{}'::jsonb,'',now()) ON CONFLICT(company_id) DO NOTHING", [id]);
      const locked = await client.query('SELECT revision FROM tenant_revisions WHERE company_id=$1 FOR UPDATE', [id]);
      const actual = locked.rowCount ? Number(locked.rows[0].revision) : 0;
      if (expectedRevision != null && Number(expectedRevision) !== actual) throw new RevisionConflictError(Number(expectedRevision), actual);
      const revision = actual + 1;
      await client.query(`INSERT INTO tenant_revisions(company_id,revision,scalar_data,content_hash,updated_at)
        VALUES($1,$2,$3,$4,now()) ON CONFLICT(company_id) DO UPDATE SET revision=EXCLUDED.revision,scalar_data=EXCLUDED.scalar_data,content_hash=EXCLUDED.content_hash,updated_at=now()`, [id, revision, scalarData, hash]);
      await client.query('DELETE FROM tenant_records WHERE company_id=$1', [id]);
      for (const row of records) await client.query('INSERT INTO tenant_records(company_id,collection,record_key,position,data) VALUES($1,$2,$3,$4,$5)', [id, row.collection, row.recordKey, row.position, row.data]);
      return { companyId: id, revision, contentHash: hash, records: records.length };
    }, 'SERIALIZABLE').catch(error => {
      if (error?.code === '40001' || /could not serialize/i.test(String(error?.message))) throw new RevisionConflictError(Number(expectedRevision ?? 0), -1);
      throw error;
    });
  }

  async verify(snapshot) {
    const saved = await this.load(snapshot.company?.id);
    if (!saved) return { ok: false, reason: 'missing' };
    const expectedHash = canonicalHash(snapshot);
    return { ok: saved.contentHash === expectedHash && canonicalHash(saved.snapshot) === expectedHash, revision: saved.revision, expectedHash, actualHash: canonicalHash(saved.snapshot) };
  }

  async close() { await this.pool.end(); }
}

module.exports = { TransactionalTenantRepository, RevisionConflictError, splitSnapshot, assembleSnapshot, canonicalHash, databaseCompanyId };

