'use strict';

const crypto = require('node:crypto');
const { stableUuid } = require('./migrate-json');

const PLATFORM_NAMESPACE_ID = stableUuid('platform', 'pro-daily-link-operations');

class PlatformRevisionConflictError extends Error {
  constructor(expected, actual = null) {
    const suffix = Number.isSafeInteger(actual) ? `, found ${actual}` : '';
    super(`Platform revision conflict: expected ${expected}${suffix}`);
    this.name = 'PlatformRevisionConflictError';
    this.code = 'PDL_PLATFORM_REVISION_CONFLICT';
    this.statusCode = 409;
    this.expected = expected;
    this.actual = actual;
  }
}

function assertPlainObject(value, label = 'Platform snapshot') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be a JSON object.`);
  }
}

function jsonClone(value) {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new TypeError('Platform state must be JSON serializable.');
  return JSON.parse(encoded);
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalValue(value[key])]));
}

function canonicalBytes(value) {
  return Buffer.from(JSON.stringify(canonicalValue(jsonClone(value))));
}

function canonicalHash(value) {
  return crypto.createHash('sha256').update(canonicalBytes(value)).digest('hex');
}

function recordKey(collection, row, position) {
  const identity = row && typeof row === 'object'
    ? [['id', row.id], ['request', row.requestId], ['slug', row.slug]].find(([, value]) => value !== undefined && value !== null && String(value) !== '')
    : null;
  if (identity) {
    const digest = crypto.createHash('sha256').update(String(identity[1])).digest('hex').slice(0, 32);
    return `${identity[0]}:${digest}`;
  }
  return `pos:${position}:${canonicalHash(row).slice(0, 32)}`;
}

function splitPlatformSnapshot(snapshot) {
  assertPlainObject(snapshot);
  const scalarData = {};
  const records = [];
  for (const [collection, rawValue] of Object.entries(snapshot)) {
    const value = jsonClone(rawValue);
    if (!Array.isArray(value) || value.length === 0) {
      scalarData[collection] = value;
      continue;
    }
    value.forEach((data, position) => {
      records.push({
        collection,
        recordKey: recordKey(collection, data, position),
        position,
        data
      });
    });
  }
  return { scalarData, records };
}

function assemblePlatformSnapshot(scalarData, records) {
  assertPlainObject(scalarData || {}, 'Platform scalar data');
  const snapshot = jsonClone(scalarData || {});
  for (const row of records || []) {
    const collection = String(row?.collection || '');
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(collection)) {
      throw new Error(`Invalid platform collection: ${collection || '(blank)'}`);
    }
    snapshot[collection] ||= [];
    if (!Array.isArray(snapshot[collection])) throw new Error(`Platform collection conflicts with scalar field: ${collection}`);
    snapshot[collection].push(jsonClone(row.data));
  }
  return snapshot;
}

function requireRevision(value, label = 'expectedRevision') {
  const revision = Number(value);
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer.`);
  }
  return revision;
}

function parseConflict(error, expectedRevision) {
  const message = String(error?.message || error || '');
  if (!/PDL_PLATFORM_REVISION_CONFLICT/i.test(message) && error?.code !== '40001') return error;
  const actualMatch = /actual=(\d+)/i.exec(message);
  return new PlatformRevisionConflictError(expectedRevision, actualMatch ? Number(actualMatch[1]) : null);
}

function normalizeRpcResult(payload) {
  if (Array.isArray(payload)) return payload[0] ?? null;
  return payload ?? null;
}

class PlatformRepository {
  constructor({ request, namespaceId = PLATFORM_NAMESPACE_ID } = {}) {
    if (typeof request !== 'function') throw new TypeError('PlatformRepository requires a server-side Supabase request function.');
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(namespaceId))) {
      throw new TypeError('Platform namespace must be a UUID.');
    }
    this.request = request;
    this.namespaceId = String(namespaceId).toLowerCase();
  }

  async load() {
    const response = await this.request('/rest/v1/rpc/load_platform_repository', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_namespace_id: this.namespaceId })
    });
    const result = normalizeRpcResult(await response.json());
    if (!result) return null;
    const revision = requireRevision(result.revision, 'stored revision');
    const records = Array.isArray(result.records) ? result.records : [];
    const snapshot = assemblePlatformSnapshot(result.scalarData ?? result.scalar_data ?? {}, records);
    const actualHash = canonicalHash(snapshot);
    const storedHash = String(result.contentHash ?? result.content_hash ?? '');
    if (!/^[a-f0-9]{64}$/.test(storedHash) || storedHash !== actualHash) {
      throw new Error('Platform repository integrity check failed while loading the current revision.');
    }
    return {
      namespaceId: this.namespaceId,
      snapshot,
      revision,
      contentHash: storedHash,
      updatedAt: result.updatedAt ?? result.updated_at ?? null,
      updatedBy: result.updatedBy ?? result.updated_by ?? null
    };
  }

  async save(snapshot, { expectedRevision, changedBy = 'platform-server' } = {}) {
    const revision = requireRevision(expectedRevision);
    assertPlainObject(snapshot);
    const cleanSnapshot = jsonClone(snapshot);
    const { scalarData, records } = splitPlatformSnapshot(cleanSnapshot);
    const contentHash = canonicalHash(cleanSnapshot);
    const payload = records.map(row => ({
      collection: row.collection,
      record_key: row.recordKey,
      position: row.position,
      data: row.data
    }));
    let response;
    try {
      response = await this.request('/rest/v1/rpc/replace_platform_repository', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          p_namespace_id: this.namespaceId,
          p_expected_revision: revision,
          p_scalar_data: scalarData,
          p_content_hash: contentHash,
          p_records: payload,
          p_changed_by: String(changedBy || 'platform-server').slice(0, 200)
        })
      });
    } catch (error) {
      throw parseConflict(error, revision);
    }
    const result = normalizeRpcResult(await response.json());
    if (!result) throw new Error('Platform repository returned no save result.');
    const savedRevision = requireRevision(result.revision, 'saved revision');
    if (savedRevision !== revision + 1) throw new Error(`Platform repository returned unexpected revision ${savedRevision}.`);
    if (String(result.contentHash ?? result.content_hash ?? '') !== contentHash) {
      throw new Error('Platform repository returned a mismatched content hash.');
    }
    const recordCount = Number(result.recordCount ?? result.record_count);
    if (!Number.isSafeInteger(recordCount) || recordCount !== records.length) {
      throw new Error('Platform repository returned a mismatched record count.');
    }
    return {
      namespaceId: this.namespaceId,
      revision: savedRevision,
      records: recordCount,
      contentHash,
      updatedAt: result.updatedAt ?? result.updated_at ?? null
    };
  }

  async verify(snapshot, expectedRevision = null) {
    assertPlainObject(snapshot);
    const current = await this.load();
    if (!current) return { ok: false, reason: 'missing' };
    const expectedHash = canonicalHash(snapshot);
    const revisionMatches = expectedRevision === null || current.revision === requireRevision(expectedRevision);
    return {
      ok: revisionMatches && current.contentHash === expectedHash,
      revision: current.revision,
      expectedHash,
      actualHash: current.contentHash,
      revisionMatches
    };
  }
}

module.exports = {
  PLATFORM_NAMESPACE_ID,
  PlatformRepository,
  PlatformRevisionConflictError,
  splitPlatformSnapshot,
  assemblePlatformSnapshot,
  canonicalHash,
  canonicalBytes,
  requireRevision,
  parseConflict
};
