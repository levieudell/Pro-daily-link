'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const sql = fs.readFileSync(path.join(__dirname, '018_quarantine_legacy_normalized_artifact.sql'), 'utf8');
const executable = sql.replace(/--.*$/gm, '');
const mutation = executable.match(/CREATE OR REPLACE FUNCTION public\.quarantine_legacy_normalized_artifact[\s\S]*?\$\$;/)?.[0] || '';

assert.match(sql, /86479331-4c63-5cc3-8633-a8d7fd5751b3/);
assert.match(sql, /d3abe4a7-d659-5d07-bc8d-55625616d375/);
assert.match(sql, /QUARANTINE EXACT LEGACY NORMALIZED ARTIFACT/);
assert.match(sql, /CREATE OR REPLACE FUNCTION private\.pdl_legacy_normalized_artifact_state/);
assert.match(sql, /SECURITY DEFINER[\s\S]*SET search_path = ''/);
assert.match(sql, /pg_advisory_xact_lock/);
assert.match(sql, /FROM public\.companies[\s\S]*FOR UPDATE/);
assert.match(sql, /UPDATE public\.companies\s+SET data=archive_data\s+WHERE id=target_id AND data='\{\}'::jsonb/);
assert.match(sql, /GET DIAGNOSTICS updated_count=ROW_COUNT/);
assert.match(sql, /PDL_ARTIFACT_COMPARE_AND_SWAP_FAILED/);
assert.match(sql, /preservedRowsSha256/);
assert.match(sql, /archiveDataSha256/);
assert.match(sql, /archivedDuplicate', true/);
assert.match(sql, /archived-quarantine/);
assert.match(sql, /REVOKE ALL ON FUNCTION private\.pdl_legacy_normalized_artifact_state[\s\S]*service_role/);
assert.match(sql, /REVOKE ALL ON FUNCTION public\.inspect_legacy_normalized_artifact[\s\S]*FROM PUBLIC, anon, authenticated/);
assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.quarantine_legacy_normalized_artifact[\s\S]*TO service_role/);
assert.doesNotMatch(executable, /DELETE\s+FROM/i, 'quarantine must not delete any row');
assert.doesNotMatch(mutation, /UPDATE\s+(?:public\.)?(?:users|memberships|customers|projects|team_members|subcontractors|reports|photos|assignments|workdays|changes|guest_links|audit_events|tenant_records|tenant_revisions)/i,
  'quarantine mutation must not update a user or child row');
assert.equal((mutation.match(/UPDATE\s+public\.companies/gi) || []).length, 1,
  'quarantine must contain exactly one company update');

console.log('Legacy normalized artifact quarantine SQL contract tests passed.');
