'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const sql = fs.readFileSync(path.join(__dirname, '017_transactional_legacy_backfill.sql'), 'utf8');
const executableSql = sql.replace(/--.*$/gm, '');

assert.match(sql, /CREATE OR REPLACE FUNCTION public\.initialize_tenant_repository_from_legacy/);
assert.match(sql, /pg_advisory_xact_lock/);
assert.match(sql, /SECURITY DEFINER[\s\S]*SET search_path = ''[\s\S]*SET lock_timeout = '5s'[\s\S]*SET statement_timeout = '30s'/);
assert.match(sql, /FROM public\.companies AS company[\s\S]*FOR UPDATE/);
assert.match(sql, /source_snapshot IS DISTINCT FROM p_source_snapshot/);
assert.match(sql, /private\.tenant_tombstones[\s\S]*private\.tenant_deletion_operations/);
assert.match(sql, /PDL_BACKFILL_LEGACY_SOURCE_INELIGIBLE/);
assert.match(sql, /reconstructed_snapshot IS DISTINCT FROM source_snapshot/);
assert.match(sql, /PDL_BACKFILL_TRANSACTIONAL_DRIFT/);
assert.match(sql, /company_id, revision, scalar_data, content_hash[\s\S]*p_company_id, 0, p_scalar_data/);
assert.match(sql, /existing_state\.content_hash = p_content_hash/);
assert.match(sql, /INSERT INTO private\.tenant_directory/);
assert.match(sql, /INSERT INTO private\.tenant_active_user_emails/);
assert.match(sql, /REVOKE ALL ON FUNCTION[\s\S]*FROM PUBLIC, anon, authenticated/);
assert.match(sql, /GRANT EXECUTE ON FUNCTION[\s\S]*TO service_role/);
assert.match(sql, /pg_catalog\.aclexplode/);
assert.doesNotMatch(executableSql, /UPDATE\s+public\.companies/i, 'backfill must never rewrite the legacy authority');
assert.doesNotMatch(executableSql, /DELETE\s+FROM\s+public\.tenant_(?:revisions|records)/i, 'backfill must never replace existing transactional rows');

console.log('Transactional backfill SQL contract tests passed.');
