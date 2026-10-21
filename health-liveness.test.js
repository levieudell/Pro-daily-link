'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { blockStagingRecovery } = require('./staging-recovery');

const source = fs.readFileSync('server.js', 'utf8');
const start = source.indexOf('const server=http.createServer(async(req,res)=>{');
const end = source.indexOf('if(mcpHttp.matches(url))', start);
assert.ok(start > 0 && end > start, 'the liveness branch must stay before MCP and all mutable dispatch');
const prefix = source.slice(start, end);
assert.ok(prefix.includes("if(req.method==='GET'&&url.pathname==='/api/health/live')"));
assert.ok(
  prefix.indexOf('if(blockStagingRecovery(req,res,url,json))return;') < prefix.indexOf("url.pathname==='/api/health/live'"),
  'the staging recovery guard must retain precedence over liveness'
);

let downstream = 0;
const context = {
  http: { createServer: handler => handler },
  crypto: { randomUUID: () => 'request-id' },
  URL,
  blockStagingRecovery,
  secureHeaders(res) { res.setHeader('X-Content-Type-Options', 'nosniff'); },
  json(res, status, value) {
    res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'});
    res.end(JSON.stringify(value));
    return value;
  },
  next() { downstream++; },
  fail(error) { throw error; }
};
const handler = vm.runInNewContext(`${prefix}next();}catch(error){fail(error)}});server`, context);

function response() {
  return {
    headers: {},
    setHeader(key, value) { this.headers[key] = value; },
    writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers); },
    end(value) { this.body = value; }
  };
}

(async () => {
  const previous = process.env.PDL_STAGING;
  try {
    process.env.PDL_STAGING = '0';
    const res = response();
    const request = {
      method: 'GET',
      url: '/api/health/live?probe=render',
      get headers() { throw new Error('liveness must not inspect authentication or tenant headers'); },
      on() { throw new Error('liveness must not read a request body'); }
    };
    await handler(request, res);
    assert.equal(res.status, 200);
    assert.equal(res.headers['Content-Type'], 'application/json; charset=utf-8');
    assert.equal(res.headers['Cache-Control'], 'no-store');
    assert.equal(res.headers['X-Content-Type-Options'], 'nosniff');
    assert.equal(res.headers['X-Request-Id'], 'request-id');
    const payload = JSON.parse(res.body);
    assert.equal(payload.ok, true);
    assert.equal(payload.kind, 'liveness');
    assert.ok(!Number.isNaN(Date.parse(payload.time)), 'liveness includes a valid UTC timestamp');
    assert.deepEqual(Object.keys(payload).sort(), ['kind', 'ok', 'time']);
    assert.equal(downstream, 0, 'liveness bypasses MCP, rate limits, authentication, databases, and providers');

    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      await handler({method, url: '/api/health/live'}, response());
    }
    assert.equal(downstream, 4, 'only GET is treated as a liveness probe');

    console.log('Health liveness endpoint regression checks passed');
  } finally {
    if (previous === undefined) delete process.env.PDL_STAGING;
    else process.env.PDL_STAGING = previous;
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
