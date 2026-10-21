'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const sql = fs.readFileSync(path.join(__dirname, 'database', '008_platform_repository.sql'), 'utf8');

for (const table of ['platform_state', 'platform_records', 'platform_revision_log']) {
  assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS private\\.${table}`, 'i'));
  assert.match(sql, new RegExp(`ALTER TABLE private\\.${table} ENABLE ROW LEVEL SECURITY`, 'i'));
  assert.match(sql, new RegExp(`ALTER TABLE private\\.${table} FORCE ROW LEVEL SECURITY`, 'i'));
  assert.match(sql, new RegExp(`REVOKE ALL ON TABLE private\\.${table} FROM PUBLIC, anon, authenticated, service_role`, 'i'));
}

assert.match(sql, /CREATE OR REPLACE FUNCTION public\.load_platform_repository/i);
assert.match(sql, /CREATE OR REPLACE FUNCTION public\.replace_platform_repository/i);
assert.equal((sql.match(/SECURITY DEFINER/gi) || []).length, 2);
assert.equal((sql.match(/SET search_path = ''/g) || []).length, 2);
assert.match(sql, /FOR UPDATE/i, 'CAS write must lock the platform revision row');
assert.match(sql, /current_revision <> p_expected_revision/i);
assert.match(sql, /PDL_PLATFORM_REVISION_CONFLICT expected=% actual=%/i);
assert.match(sql, /INSERT INTO private\.platform_revision_log/i);
assert.match(sql, /REVOKE ALL ON FUNCTION public\.load_platform_repository\(uuid\)[\s\S]*FROM PUBLIC, anon, authenticated/i);
assert.match(sql, /REVOKE ALL ON FUNCTION public\.replace_platform_repository\(uuid,bigint,jsonb,text,jsonb,text\)[\s\S]*FROM PUBLIC, anon, authenticated/i);
assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.load_platform_repository\(uuid\) TO service_role/i);
assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.replace_platform_repository\(uuid,bigint,jsonb,text,jsonb,text\) TO service_role/i);
assert.doesNotMatch(sql, /GRANT\s+(SELECT|INSERT|UPDATE|DELETE|ALL)[\s\S]{0,100}TO\s+(anon|authenticated)/i);

console.log('Platform repository migration security tests passed.');
