'use strict';

const assert = require('node:assert/strict');
const supabase = require('./database/supabase');

const previous = {
  url: process.env.SUPABASE_URL,
  key: process.env.SUPABASE_SECRET_KEY,
  enabled: process.env.PDL_SUPABASE_ENABLED,
  fetch: global.fetch
};
process.env.SUPABASE_URL = 'https://storage-config.example.test';
process.env.SUPABASE_SECRET_KEY = 'server-only-test-key';
process.env.PDL_SUPABASE_ENABLED = '1';

const attempts = new Map(), bucketConfigurations = new Map();
let existingLogoPublic = true, logoUpdated = false;
global.fetch = async (url, options = {}) => {
  const value = String(url);
  if (value.endsWith('/storage/v1/bucket')) {
    const input = JSON.parse(options.body);
    if (input.id === 'company-logos') return new Response(JSON.stringify({ message: 'resource already exists' }), { status: 409 });
    bucketConfigurations.set(input.id, input);
    return new Response('', { status: 200 });
  }
  if (value.endsWith('/storage/v1/bucket/company-logos')) {
    if (options.method === 'PUT') { existingLogoPublic = false; logoUpdated = true; return new Response('', { status: 200 }); }
    return new Response(JSON.stringify({ id:'company-logos', public:existingLogoPublic, file_size_limit:6_000_000, allowed_mime_types:['image/jpeg','image/png','image/webp'] }), { status: 200, headers: { 'content-type':'application/json' } });
  }
  const match = value.match(/\/storage\/v1\/object\/([^/]+)\//);
  assert.ok(match, `unexpected request: ${value}`);
  const bucket = match[1], count = (attempts.get(bucket) || 0) + 1;
  attempts.set(bucket, count);
  return count === 1
    ? new Response(JSON.stringify({ message: 'Bucket not found' }), { status: 400 })
    : new Response('', { status: 200 });
};

(async () => {
  try {
    await supabase.upload('estimate-documents', 'tenant/estimate.pdf', Buffer.from('pdf'), 'application/pdf');
    await supabase.upload('project-tickets', 'tenant/ticket.pdf', Buffer.from('ticket'), 'application/pdf');
    assert.equal(bucketConfigurations.get('estimate-documents').public, false);
    assert.equal(bucketConfigurations.get('estimate-documents').file_size_limit, 15_000_000);
    assert.deepEqual(bucketConfigurations.get('estimate-documents').allowed_mime_types, ['application/pdf']);
    assert.equal(bucketConfigurations.get('project-tickets').file_size_limit, 10_000_000);
    assert.deepEqual(bucketConfigurations.get('project-tickets').allowed_mime_types, ['application/pdf', 'image/jpeg', 'image/png', 'image/webp']);
    assert.equal(attempts.get('estimate-documents'), 2);
    assert.equal(attempts.get('project-tickets'), 2);
    await supabase.ensurePrivateBucket('company-logos',6_000_000,['image/jpeg','image/png','image/webp']);
    assert.equal(logoUpdated,true,'an existing public bucket must be corrected and verified');
    console.log('Private bucket configuration passed: recovery-sized buckets are created and existing public buckets are corrected and verified.');
  } finally {
    global.fetch = previous.fetch;
    if (previous.url === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = previous.url;
    if (previous.key === undefined) delete process.env.SUPABASE_SECRET_KEY; else process.env.SUPABASE_SECRET_KEY = previous.key;
    if (previous.enabled === undefined) delete process.env.PDL_SUPABASE_ENABLED; else process.env.PDL_SUPABASE_ENABLED = previous.enabled;
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
