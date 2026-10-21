'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const rpcMigrations = new Map([
  ['database/007_transactional_records.sql', 1],
  ['database/008_platform_repository.sql', 1],
  ['database/009_transactional_read_models.sql', 1],
  ['database/012_operator_reviewed_tenant_deletion.sql', 2],
  ['database/015_resumable_tenant_deletion.sql', 1],
  ['database/017_transactional_legacy_backfill.sql', 1],
  ['database/018_quarantine_legacy_normalized_artifact.sql', 4]
]);

for (const [relativePath, expectedConflicts] of rpcMigrations) {
  const sql = fs.readFileSync(path.join(__dirname, relativePath), 'utf8');
  const retryingApplicationErrors = (sql.match(/RAISE\s+EXCEPTION[\s\S]{0,300}?ERRCODE\s*=\s*'40001'/gi) || []).length;
  const terminalHttpConflicts = (sql.match(/RAISE\s+EXCEPTION[\s\S]{0,300}?ERRCODE\s*=\s*'PT409'/gi) || []).length;
  assert.equal(retryingApplicationErrors, 0,
    `${relativePath} must not label a permanent PostgREST application conflict as serialization failure 40001`);
  assert.equal(terminalHttpConflicts, expectedConflicts,
    `${relativePath} must map each permanent RPC conflict to one terminal HTTP 409`);
}

const directRepository = fs.readFileSync(path.join(__dirname, 'database/transactional-repository.js'), 'utf8');
assert.match(directRepository, /error\?\.code === '40001'[\s\S]{0,180}RevisionConflictError/,
  'the direct PostgreSQL repository must continue recognizing genuine SERIALIZABLE 40001 failures');

const previous = {
  url: process.env.SUPABASE_URL,
  key: process.env.SUPABASE_SECRET_KEY,
  enabled: process.env.PDL_SUPABASE_ENABLED,
  fetch: global.fetch
};
Object.assign(process.env, {
  SUPABASE_URL: 'https://revision-conflict.invalid',
  SUPABASE_SECRET_KEY: 'synthetic-service-role-secret',
  PDL_SUPABASE_ENABLED: '1'
});
const supabase = require('./database/supabase');
const snapshot = {
  company: { id: '11111111-1111-4111-8111-111111111111', name: 'Conflict Test' },
  reports: [{ id: 1, notes: 'Synthetic' }]
};

(async () => {
  try {
    let calls = 0;
    global.fetch = async (url, options = {}) => {
      calls += 1;
      assert.match(String(url), /\/rest\/v1\/rpc\/replace_tenant_records$/);
      assert.equal(options.method, 'POST');
      return new Response(JSON.stringify({
        code: 'PT409',
        details: null,
        hint: null,
        message: 'PDL_REVISION_CONFLICT expected=4 actual=5'
      }), { status: 409, headers: { 'Content-Type': 'application/json' } });
    };
    await assert.rejects(() => supabase.saveTransactionalSnapshot(snapshot, 4), error => {
      assert.equal(error.code, 'PDL_REVISION_CONFLICT');
      assert.equal(error.expected, 4);
      assert.equal(error.actual, 5);
      return true;
    });
    assert.equal(calls, 1, 'a terminal PT409 write conflict must never be retried by the application adapter');

    calls = 0;
    global.fetch = async () => {
      calls += 1;
      return new Response(JSON.stringify({
        code: '40001',
        message: 'PDL_REVISION_CONFLICT expected=4 actual=6'
      }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    };
    await assert.rejects(() => supabase.saveTransactionalSnapshot(snapshot, 4), error => {
      assert.equal(error.code, 'PDL_REVISION_CONFLICT');
      assert.equal(error.actual, 6);
      return true;
    });
    assert.equal(calls, 1, 'a legacy conflict response remains terminal during a rolling deployment');

    calls = 0;
    global.fetch = async () => {
      calls += 1;
      return new Response(JSON.stringify({
        code: '23505',
        message: 'duplicate key value violates unique constraint'
      }), { status: 409, headers: { 'Content-Type': 'application/json' } });
    };
    await assert.rejects(() => supabase.saveTransactionalSnapshot(snapshot, 4), error => {
      assert.equal(error.code, '23505');
      assert.equal(error.statusCode, 409);
      assert.notEqual(error.code, 'PDL_REVISION_CONFLICT');
      return true;
    });
    assert.equal(calls, 1, 'an unrelated HTTP 409 must not be mislabeled or retried as a revision conflict');

    console.log('Revision conflict HTTP tests passed: RPC SQL uses PT409, direct PostgreSQL keeps 40001, and stale writes terminate after one request.');
  } finally {
    global.fetch = previous.fetch;
    if (previous.url === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = previous.url;
    if (previous.key === undefined) delete process.env.SUPABASE_SECRET_KEY; else process.env.SUPABASE_SECRET_KEY = previous.key;
    if (previous.enabled === undefined) delete process.env.PDL_SUPABASE_ENABLED; else process.env.PDL_SUPABASE_ENABLED = previous.enabled;
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
