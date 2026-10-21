'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const temp = fs.mkdtempSync(path.join(__dirname, '.tmp-platform-primary-startup-'));
const dbFile = path.join(temp, 'db.json');
const platformFile = path.join(temp, 'platform.json');
fs.copyFileSync(path.join(__dirname, 'data', 'db.json'), dbFile);
fs.copyFileSync(path.join(__dirname, 'data', 'platform.json'), platformFile);

Object.assign(process.env, {
  NODE_ENV: 'test',
  PDL_DB_FILE: dbFile,
  PDL_PLATFORM_FILE: platformFile,
  PDL_SUPABASE_ENABLED: '1',
  SUPABASE_URL: 'https://platform-primary-startup.invalid',
  SUPABASE_SECRET_KEY: 'synthetic-service-role-secret',
  PDL_PLATFORM_TRANSACTIONAL_DB: 'primary'
});

const supabase = require('./database/supabase');
supabase.loadLocalEnv = () => {};
const calls = [];
supabase.request = async (pathname, options = {}) => {
  calls.push({ pathname, method: options.method || 'GET' });
  assert.equal(pathname, '/rest/v1/rpc/load_platform_repository');
  return { json: async () => null };
};

const { initializePlatformPersistence } = require('./server');

(async () => {
  try {
    await assert.rejects(
      initializePlatformPersistence(),
      /empty and no bootstrap snapshot was supplied/i,
      'primary mode must not recreate a missing authoritative repository from a local mirror'
    );
    assert.deepEqual(calls, [
      { pathname: '/rest/v1/rpc/load_platform_repository', method: 'POST' }
    ], 'primary startup performs a read only and never seeds missing state');
    console.log('Platform primary startup passed: missing authority fails closed without stale-state resurrection.');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
