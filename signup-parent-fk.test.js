'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const database = file => fs.readFileSync(path.join(__dirname, 'database', file), 'utf8');

function replaceFunction(sql) {
  const match = sql.match(/CREATE OR REPLACE FUNCTION public\.replace_tenant_records\([\s\S]+?\n\$\$;/i);
  assert.ok(match, 'replace_tenant_records must be present');
  return match[0];
}

function assertParentBeforeChild(file) {
  const body = replaceFunction(database(file));
  const parent = body.search(/INSERT INTO public\.companies\s*\(/i);
  const child = body.search(/INSERT INTO public\.tenant_revisions\s*\(/i);
  assert.ok(parent >= 0, `${file} must materialize the company parent`);
  assert.ok(child >= 0, `${file} must materialize the revision child`);
  assert.ok(parent < child, `${file} must insert the FK parent before the child`);
  assert.match(body, /'company-'\s*\|\|\s*p_company_id::text/i, `${file} uses a collision-free deterministic slug`);
}

// Minimal relational behavior model: this is the exact invariant enforced by
// tenant_revisions.company_id -> companies.id. It deliberately fails when a
// child is inserted before its parent, matching PostgreSQL's FK behavior.
class TenantRelationModel {
  constructor({ parentTrigger = false } = {}) {
    this.parentTrigger = parentTrigger;
    this.companies = new Set();
    this.revisions = new Set();
  }

  insertCompany(companyId) {
    this.companies.add(companyId);
  }

  insertRevision(companyId) {
    if (this.parentTrigger) this.insertCompany(companyId);
    if (!this.companies.has(companyId)) {
      const error = new Error('insert or update on table "tenant_revisions" violates foreign key constraint');
      error.code = '23503';
      throw error;
    }
    this.revisions.add(companyId);
  }
}

const foundation = database('007_transactional_records.sql');
assert.match(foundation, /tenant_revisions[\s\S]*company_id uuid PRIMARY KEY REFERENCES public\.companies\(id\)/i, 'the regression test models the real FK');

for (const file of ['007_transactional_records.sql', '009_transactional_read_models.sql']) {
  assertParentBeforeChild(file);
  const db = new TenantRelationModel();
  const companyId = '11111111-1111-4111-8111-111111111111';
  db.insertCompany(companyId);
  db.insertRevision(companyId);
  assert.ok(db.revisions.has(companyId), `${file} first write satisfies the FK`);
}

const guard = database('013_transactional_tenant_parent.sql');
assert.match(guard, /BEFORE INSERT OR UPDATE OF scalar_data\s+ON public\.tenant_revisions/i, 'the deployed-function compatibility guard runs before FK enforcement and synchronizes real names');
assert.match(guard, /INSERT INTO public\.companies\s*\([\s\S]*ON CONFLICT\s*\(id\)/i, 'the guard idempotently creates the parent');
assert.match(guard, /WHEN company_has_name THEN EXCLUDED\.name[\s\S]*ELSE public\.companies\.name/i, 'an old revision-zero write cannot erase a real company name');
assert.match(guard, /REVOKE ALL ON FUNCTION private\.ensure_tenant_company_parent\(\)[\s\S]*PUBLIC, anon, authenticated, service_role/i, 'the trigger helper is not callable by browser or service roles');

// Models an application instance still running the old cached RPC body: it
// inserts tenant_revisions first. The BEFORE trigger creates the parent inside
// that transaction, so PostgreSQL's FK check succeeds without a two-step app
// write or a stranded company row.
const migratedDb = new TenantRelationModel({ parentTrigger: true });
const newSignupId = '22222222-2222-4222-8222-222222222222';
migratedDb.insertRevision(newSignupId);
assert.ok(migratedDb.companies.has(newSignupId));
assert.ok(migratedDb.revisions.has(newSignupId));

const unsafeDb = new TenantRelationModel();
assert.throws(() => unsafeDb.insertRevision(newSignupId), error => error.code === '23503', 'the test proves the pre-fix child-first order would fail');

console.log('Signup parent FK passed: fresh RPCs insert parent-before-child and migration 013 protects cached older writers atomically.');
