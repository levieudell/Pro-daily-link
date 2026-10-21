'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const temp = fs.mkdtempSync(path.join(__dirname, '.tmp-tenant-repository-health-'));
const dbFile = path.join(temp, 'db.json');
const platformFile = path.join(temp, 'platform.json');
fs.copyFileSync(path.join(__dirname, 'data', 'db.json'), dbFile);
fs.copyFileSync(path.join(__dirname, 'data', 'platform.json'), platformFile);

Object.assign(process.env, {
  NODE_ENV: 'test',
  PDL_DB_FILE: dbFile,
  PDL_PLATFORM_FILE: platformFile,
  PDL_SUPABASE_ENABLED: '1',
  SUPABASE_URL: 'https://tenant-health.invalid',
  SUPABASE_SECRET_KEY: 'synthetic-service-role-secret',
  PDL_TRANSACTIONAL_DB: 'primary',
  PDL_PLATFORM_TRANSACTIONAL_DB: 'off'
});

const previousFetch = global.fetch;
const { tenantRepositoryHealth } = require('./server');

function response(body, status = 200) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

(async () => {
  try {
    const calls = [];
    global.fetch = async (url, options = {}) => {
      const pathname = new URL(String(url)).pathname;
      calls.push({ pathname, method: options.method, body: JSON.parse(options.body) });
      if (pathname.endsWith('/rpc/load_tenant_repository')) return response(null);
      if (pathname.endsWith('/rpc/list_tenant_directory_page')) return response({ rows: [], nextCompanyId: null });
      throw new Error(`Unexpected request: ${pathname}`);
    };

    assert.deepEqual(await tenantRepositoryHealth(), {
      mode: 'primary',
      configured: true,
      ready: true
    });
    assert.deepEqual(calls, [
      {
        pathname: '/rest/v1/rpc/load_tenant_repository',
        method: 'POST',
        body: { p_company_id: '00000000-0000-4000-8000-000000000000' }
      },
      {
        pathname: '/rest/v1/rpc/list_tenant_directory_page',
        method: 'POST',
        body: { p_after_company_id: null, p_limit: 1 }
      }
    ], 'primary readiness must exercise both atomic read models');

    global.fetch = async url => {
      assert.match(String(url), /\/rpc\/load_tenant_repository$/);
      return response('read model unavailable', 404);
    };
    assert.deepEqual(await tenantRepositoryHealth(), {
      mode: 'primary',
      configured: true,
      ready: false
    }, 'missing atomic tenant loader must fail primary readiness');

    global.fetch = async url => {
      const pathname = new URL(String(url)).pathname;
      if (pathname.endsWith('/rpc/load_tenant_repository')) return response(null);
      assert.match(pathname, /\/rpc\/list_tenant_directory_page$/);
      return response('directory unavailable', 404);
    };
    assert.deepEqual(await tenantRepositoryHealth(), {
      mode: 'primary',
      configured: true,
      ready: false
    }, 'missing tenant directory must fail primary readiness');

    console.log('Tenant repository health passed: primary readiness verifies both transactional read-model RPCs.');
  } finally {
    global.fetch = previousFetch;
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
