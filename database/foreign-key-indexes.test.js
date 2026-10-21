'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const migrationPath = path.join(__dirname, '016_foreign_key_indexes.sql');
const sql = fs.readFileSync(migrationPath, 'utf8');

const expectedIndexes = new Map([
  ['assignments_project_id_idx', 'public.assignments (project_id)'],
  ['audit_events_actor_user_id_idx', 'public.audit_events (actor_user_id)'],
  ['audit_events_company_id_idx', 'public.audit_events (company_id)'],
  ['changes_project_id_idx', 'public.changes (project_id)'],
  ['changes_report_id_idx', 'public.changes (report_id)'],
  ['guest_links_project_id_idx', 'public.guest_links (project_id)'],
  ['guest_links_subcontractor_id_idx', 'public.guest_links (subcontractor_id)'],
  ['memberships_user_id_idx', 'public.memberships (user_id)'],
  ['photos_project_id_idx', 'public.photos (project_id)'],
  ['photos_report_id_idx', 'public.photos (report_id)'],
  ['projects_customer_id_idx', 'public.projects (customer_id)'],
  ['reports_project_id_idx', 'public.reports (project_id)'],
  ['reports_subcontractor_id_idx', 'public.reports (subcontractor_id)'],
  ['reports_submitted_by_idx', 'public.reports (submitted_by)'],
  ['subcontractors_company_id_idx', 'public.subcontractors (company_id)'],
  ['team_members_company_id_idx', 'public.team_members (company_id)'],
  ['workdays_project_id_idx', 'public.workdays (project_id)'],
]);

assert.match(sql, /^BEGIN;/m, 'migration must be transactional');
assert.match(sql, /^COMMIT;/m, 'migration must commit explicitly');
assert.match(sql, /SET\s+LOCAL\s+lock_timeout\s*=\s*'5s'/i, 'migration must fail quickly behind an unexpected lock');
assert.match(sql, /SET\s+LOCAL\s+statement_timeout\s*=\s*'60s'/i, 'migration must have a bounded execution time');
assert.doesNotMatch(sql, /\b(?:DROP|DELETE|TRUNCATE|ALTER\s+TABLE)\b/i,
  'index migration must remain additive');

for (const [indexName, target] of expectedIndexes) {
  const escapedTarget = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  assert.match(
    sql,
    new RegExp(`CREATE\\s+INDEX\\s+IF\\s+NOT\\s+EXISTS\\s+${indexName}\\s+ON\\s+${escapedTarget}`, 'i'),
    `${indexName} must cover ${target}`,
  );
}

assert.equal(
  [...sql.matchAll(/CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS/gi)].length,
  expectedIndexes.size,
  'migration must contain exactly the reviewed foreign-key indexes',
);
assert.match(sql, /indisvalid/i, 'evidence must reject invalid indexes');
assert.match(sql, /indisready/i, 'evidence must reject incomplete indexes');
assert.match(sql, /indkey/i, 'evidence must validate leading index columns');

console.log(`foreign key index migration: ${expectedIndexes.size} covering indexes verified`);
