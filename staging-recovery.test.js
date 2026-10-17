const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { blockStagingRecovery, MESSAGE } = require('./staging-recovery');

const source = fs.readFileSync('server.js', 'utf8');
const start = source.indexOf('const server=http.createServer(async(req,res)=>{');
const end = source.indexOf('if(mcpHttp.matches(url))', start);
assert.ok(start > 0 && end > start);
const prefix = source.slice(start, end);
assert.ok(prefix.includes('if(blockStagingRecovery(req,res,url,json))return;'), 'guard must precede all dispatch and database work');
// Execute the real HTTP callback entry, replacing everything after the guard
// with a trap. Existing-token requests must never reach credential/session work.
let downstream = 0, randomCalls = 0;
const context = { http: { createServer: handler => handler }, crypto: { randomUUID: () => 'request-id', randomBytes: () => { randomCalls++; throw Error('Token creation'); } }, secureHeaders() {}, URL, blockStagingRecovery,
  json(res, status, value) { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); },
  next() { downstream++; }, fail(error) { throw error; } };
const handler = vm.runInNewContext(`${prefix}next();}catch(error){fail(error)}});server`, context);
const previous = process.env.PDL_STAGING;
const api = ['/api/auth/forgot', '/api/auth/reset', '/api/platform/auth/forgot', '/api/platform/auth/reset'];
const pages = ['/forgot-password.html', '/reset-password.html', '/platform-forgot-password.html', '/platform-reset-password.html'];
function response() { return { headers: {}, setHeader(k, v) { this.headers[k] = v; }, writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers); }, end(value) { this.body = value; } }; }
(async () => {
  try {
    process.env.PDL_STAGING = '1';
    for (const pathname of api) for (const method of ['POST', 'GET', 'PUT', 'HEAD']) for (const query of ['', '?tenant=unknown&token=existing-link']) {
      const req = { method, url: pathname + query,
        get headers() { throw Error('Must not resolve a tenant/session'); },
        on() { throw Error('Must not parse recovery input'); } };
      const res = response();
      await handler(req, res);
      assert.equal(res.status, 403);
      assert.deepEqual(JSON.parse(res.body), { error: MESSAGE, code: 'STAGING_RECOVERY_DISABLED' });
      assert.equal(res.headers['Cache-Control'], 'no-store');
      assert.doesNotMatch(res.body, /previewToken|resetUrl|resetTokenHash|existing-link/);
    }
    for (const pathname of pages) {
      const res = response();
      await handler({ method: 'GET', url: pathname + '?token=existing-link' }, res);
      assert.equal(res.status, 200);
      assert.ok(res.body.includes(MESSAGE));
      assert.doesNotMatch(res.body, /<form|<script|existing-link/);
      assert.ok(res.body.includes(pathname.startsWith('/platform-') ? '/platform-login.html' : '/login.html'));
    }
    assert.equal(downstream, 0, 'no database, credential, session, or email operation may run');
    assert.equal(randomCalls, 0);
    // Non-staging routes retain the original dispatch, as do unrelated staging routes.
    for (const value of ['0', '', 'true']) {
      process.env.PDL_STAGING = value;
      for (const pathname of [...api, ...pages]) {
        const res = response();
        await handler({ method: 'POST', url: pathname }, res);
        assert.equal(res.body, undefined);
      }
    }
    process.env.PDL_STAGING = '1';
    const count = downstream;
    await handler({ method: 'GET', url: '/api/config' }, response());
    await handler({ method: 'GET', url: '/login.html' }, response());
    assert.equal(downstream, count + 2);
    console.log('Staging recovery guard regression tests passed');
  } finally {
    if (previous === undefined) delete process.env.PDL_STAGING; else process.env.PDL_STAGING = previous;
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
