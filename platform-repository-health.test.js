'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const temp = fs.mkdtempSync(path.join(__dirname, '.tmp-platform-health-repository-'));
const dbFile = path.join(temp, 'db.json');
const platformFile = path.join(temp, 'platform.json');
fs.copyFileSync(path.join(__dirname, 'data', 'db.json'), dbFile);
fs.copyFileSync(path.join(__dirname, 'data', 'platform.json'), platformFile);

Object.assign(process.env, {
  NODE_ENV: 'test',
  PDL_DB_FILE: dbFile,
  PDL_PLATFORM_FILE: platformFile,
  PDL_SUPABASE_ENABLED: '1',
  SUPABASE_URL: 'https://platform-health.invalid',
  SUPABASE_SECRET_KEY: 'synthetic-service-role-secret',
  PDL_PLATFORM_TRANSACTIONAL_DB: 'primary'
});

const supabase = require('./database/supabase');
const { splitPlatformSnapshot, canonicalHash } = require('./database/platform-repository');
supabase.loadLocalEnv = () => {};

const snapshot = JSON.parse(fs.readFileSync(platformFile, 'utf8'));
const split = splitPlatformSnapshot(snapshot);
let reachable = true;
supabase.request = async pathname => {
  assert.equal(pathname, '/rest/v1/rpc/load_platform_repository');
  if (!reachable) throw new Error('synthetic repository outage');
  return {
    json: async () => [{
      revision: 8,
      scalarData: split.scalarData,
      records: split.records.map(row => ({ collection: row.collection, data: row.data })),
      contentHash: canonicalHash(snapshot),
      updatedAt: '2026-10-20T12:00:00.000Z',
      updatedBy: 'health-test'
    }]
  };
};

const { initializePlatformPersistence, platformRepositoryHealth } = require('./server');

(async () => {
  try {
    await initializePlatformPersistence();
    const healthy = await platformRepositoryHealth();
    assert.deepEqual(healthy, {
      mode: 'primary',
      configured: true,
      ready: true,
      revision: 8,
      updatedAt: '2026-10-20T12:00:00.000Z'
    });

    reachable = false;
    const unhealthy = await platformRepositoryHealth();
    assert.equal(unhealthy.mode, 'primary');
    assert.equal(unhealthy.configured, true);
    assert.equal(unhealthy.ready, false);
    assert.equal(Object.hasOwn(unhealthy, 'error'), false, 'health response does not disclose internal repository errors');
    console.log('Platform repository health passed: primary readiness is live, bounded, and failure-safe.');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
