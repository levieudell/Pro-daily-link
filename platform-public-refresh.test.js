'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const temp = fs.mkdtempSync(path.join(__dirname, '.tmp-platform-public-refresh-'));
const dbFile = path.join(temp, 'db.json');
const platformFile = path.join(temp, 'platform.json');
fs.copyFileSync(path.join(__dirname, 'data', 'db.json'), dbFile);

const initial = {
  users: [], sessions: [], auditEvents: [], helpItems: [],
  blogPosts: [{ id: 'post-one', title: 'First', slug: 'first', excerpt: 'First post', content: 'One', category: 'Field operations', author: 'PDL', status: 'Published', publishedAt: '2026-10-20T10:00:00.000Z', updatedAt: '2026-10-20T10:00:00.000Z' }]
};
fs.writeFileSync(platformFile, JSON.stringify(initial, null, 2));

Object.assign(process.env, {
  NODE_ENV: 'test', PDL_REQUIRE_AUTH: '0', PDL_DB_FILE: dbFile, PDL_PLATFORM_FILE: platformFile,
  PDL_SUPABASE_ENABLED: '1', SUPABASE_URL: 'https://public-refresh.invalid', SUPABASE_SECRET_KEY: 'synthetic-service-role-secret',
  PDL_PLATFORM_TRANSACTIONAL_DB: 'primary'
});

const supabase = require('./database/supabase');
const { splitPlatformSnapshot, canonicalHash } = require('./database/platform-repository');
supabase.loadLocalEnv = () => {};
let remote = structuredClone(initial), revision = 3;
supabase.request = async pathname => {
  assert.equal(pathname, '/rest/v1/rpc/load_platform_repository');
  const split = splitPlatformSnapshot(remote);
  return { json: async () => ({
    revision, scalarData: split.scalarData,
    records: split.records.map(row => ({ collection: row.collection, data: row.data })),
    contentHash: canonicalHash(remote), updatedAt: new Date().toISOString(), updatedBy: 'external-instance'
  }) };
};

const { server, initializePlatformPersistence } = require('./server');

(async () => {
  try {
    await initializePlatformPersistence();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    let response = await fetch(`${base}/api/blog`);
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).map(row => row.slug), ['first']);

    remote = structuredClone(remote);
    remote.blogPosts.unshift({ id: 'post-two', title: 'Second', slug: 'second', excerpt: 'Fresh post', content: 'Two', category: 'Field operations', author: 'PDL', status: 'Published', publishedAt: '2026-10-20T11:00:00.000Z', updatedAt: '2026-10-20T11:00:00.000Z' });
    revision += 1;

    response = await fetch(`${base}/api/blog`);
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).map(row => row.slug), ['second', 'first'], 'public readers refresh platform content written by another instance');
    console.log('Platform public refresh passed: Help/Blog readers see cross-instance commits without a process restart.');
  } finally {
    if (server.listening) await new Promise(resolve => server.close(resolve));
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
