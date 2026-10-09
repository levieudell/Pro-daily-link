'use strict';
const fs = require('node:fs'), path = require('node:path');
const { Pool } = require('pg');
const { A } = require('./compat-account-fixture');
const { split, CompatTenantRepository } = require('./database/compat-tenant-repository');
const { canonicalHash } = require('./database/transactional-repository');
async function nativeFixture() {
  const connectionString = process.env.TEST_COMPAT_DATABASE_URL, url = new URL(connectionString);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !/^\/(?:pdl_compat_|compat_test)/.test(url.pathname)) throw Error('Explicit local synthetic database required');
  const admin = new Pool({ connectionString, ssl: false, max: 4 }), repository = new CompatTenantRepository({ connectionString, companyId: A, synthetic: true });
  await admin.query("DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF; IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF; IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN; END IF; END $$");
  await admin.query("CREATE TABLE IF NOT EXISTS public.companies(id uuid PRIMARY KEY,slug text,name text,data jsonb); CREATE OR REPLACE FUNCTION public.app_company_id() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('app.company_id',true),'')::uuid $$");
  for (const file of ['007_transactional_records.sql', '008_require_explicit_revision.sql']) await admin.query(fs.readFileSync(path.join(__dirname, 'database', file), 'utf8'));
  async function reset(db) { const pieces = split(db); await admin.query('INSERT INTO public.companies(id,slug,name) VALUES($1,$2,$3) ON CONFLICT(id) DO NOTHING', [A, 'synthetic-lifecycle', 'Synthetic Lifecycle']); await admin.query('DELETE FROM public.tenant_records WHERE company_id=$1', [A]); await admin.query('DELETE FROM public.tenant_revisions WHERE company_id=$1', [A]); await admin.query('SELECT * FROM public.replace_tenant_records($1,0,$2::jsonb,$3,$4::jsonb)', [A, JSON.stringify(pieces.scalarData), canonicalHash(db), JSON.stringify(pieces.records.map(row => ({ collection: row.collection, record_key: row.recordKey, position: row.position, data: row.data })))]); }
  return { repository, admin, reset, close: async () => { await repository.close(); await admin.end(); } };
}
module.exports = { nativeFixture };
