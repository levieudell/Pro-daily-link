'use strict';

const assert = require('node:assert/strict');
const security = require('./platform-security');

assert.equal(security.platformAuthRequired({}), true, 'platform auth fails closed by default');
assert.equal(security.platformAuthRequired({ NODE_ENV: 'development' }), true, 'development alone is not a bypass');
assert.equal(security.platformAuthRequired({ NODE_ENV: 'development', PDL_PLATFORM_DEV_BYPASS: '1' }), false, 'explicit local-development bypass works');
assert.equal(security.platformAuthRequired({ NODE_ENV: 'test', PDL_REQUIRE_AUTH: '0' }), false, 'legacy explicit local test bypass remains supported');
assert.equal(security.platformAuthRequired({ NODE_ENV: 'production', PDL_PLATFORM_DEV_BYPASS: '1', PDL_REQUIRE_AUTH: '0' }), true, 'production always requires authentication');

const request = (forwarded, remoteAddress = '10.0.0.7') => ({
  headers: forwarded === undefined ? {} : { 'x-forwarded-for': forwarded },
  socket: { remoteAddress }
});

assert.equal(security.clientAddress(request('198.51.100.8'), {}), '10.0.0.7', 'forwarded headers are ignored without configured trusted hops');
assert.equal(security.clientAddress(request('192.0.2.10, 198.51.100.8'), { PDL_TRUST_PROXY_HOPS: '1' }), '198.51.100.8', 'one trusted proxy selects the right-most address');
assert.equal(security.clientAddress(request('192.0.2.10, 198.51.100.8'), { PDL_TRUST_PROXY_HOPS: '2' }), '192.0.2.10', 'multiple trusted hops walk the chain from the right');
assert.equal(security.clientAddress(request('not-an-ip'), { PDL_TRUST_PROXY_HOPS: '1' }), '10.0.0.7', 'malformed forwarded addresses fall back to the socket');
assert.equal(security.clientAddress(request('198.51.100.8', '::ffff:127.0.0.1'), { PDL_TRUST_PROXY_HOPS: '2' }), '127.0.0.1', 'short chains fall back to a normalized socket address');
assert.equal(security.normalizedAddress('[2001:db8::1]:443'), '2001:db8::1');

console.log('Platform security policy passed: fail-closed authentication and proxy-safe client addressing.');
