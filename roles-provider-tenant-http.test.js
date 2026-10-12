'use strict';
// Real normal HTTP ingress, generated actors, closed memory tenant/shared
// platform CAS, and owned provider responses. No application test installer.
const assert = require('node:assert/strict'), crypto = require('node:crypto'), fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { canonicalHash } = require('./database/transactional-repository');
const nativeFetch = globalThis.fetch, nativeError = console.error, blobs = new Map();
let origin, requests = 0, casWrites = 0, imageDispatches = 0, emailDispatches = 0, providerHook = null, expectedEvidenceLogs = 0;
console.error = (...values) => { const error = values[1]; if (typeof values[0] === 'string' && /^\[[a-f0-9-]{36}\]$/.test(values[0]) && error instanceof Error && error.code === 'PDL_ROLES_EVIDENCE') { expectedEvidenceLogs++; return; } nativeError(...values); };
globalThis.fetch = async (input, options) => {
  const target = String(input?.url || input);
  if (target === 'https://api.resend.com/emails') {
    assert.equal(options.headers.Authorization || options.headers.authorization, 'Bearer synthetic-tenant-provider-memory-only');
    const payload = JSON.parse(options.body); assert.equal(payload.to.length, 1); assert.ok(payload.to[0].endsWith('@example.invalid'));
    emailDispatches++; if (providerHook) await providerHook('email');
    return new Response(JSON.stringify({ id: 'synthetic-email-' + emailDispatches }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  assert.ok(origin && target.startsWith(origin + '/'), 'Only the fixture-owned loopback server may open a network socket');
  return nativeFetch(input, options);
};
const supabase = require('./database/supabase'); supabase.loadLocalEnv = () => {};
supabase.upload = async (bucket, key, bytes, type) => { imageDispatches++; assert.equal(bucket, 'project-photos'); blobs.set(bucket + '/' + key, { bytes: Buffer.from(bytes), type }); if (providerHook) await providerHook('storage-upload'); return { bucket, objectKey: key, url: '/api/files/' + bucket + '/' + key }; };
supabase.download = supabase.remove = async () => { throw Error('This provider-evidence fixture authorizes no reads or cleanup of stored bytes'); };
const fixture = require('./roles-production-http.test'), { server } = fixture;
const ownedDirectory = path.resolve(path.dirname(process.env.PDL_DB_FILE));
assert.ok(ownedDirectory.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(ownedDirectory).startsWith('pdl-roles-production-http-'), 'Cleanup stays in the exact owned temporary directory');
const request = supabase.request;
supabase.request = async (route, options) => { const response = await request(route, options); if (/^\/rest\/v1\/rpc\/commit_roles_snapshot(?:_with_platform)?$/.test(route)) casWrites++; return response; };
const baseline = fixture.read(), originalFieldSessionHash = crypto.createHash('sha256').update(fixture.tokens.get(2)).digest('hex');
function restore(snapshot = baseline) { fixture.alter(db => { for (const name of Object.keys(db)) delete db[name]; Object.assign(db, structuredClone(snapshot)); }); }
function photoBody(label) { const bytes = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from('synthetic-tenant-provider-' + label)]); return { projectId: 101, source: 'field', caption: 'Synthetic ' + label, files: [{ type: 'image/png', data: 'data:image/png;base64,' + bytes.toString('base64') }] }; }
function attempt(overrides = {}) { return { id: crypto.randomUUID(), companyId: fixture.A, actorId: 2, operationId: crypto.randomUUID(), ordinal: 1, kind: 'storage-upload', digest: crypto.randomBytes(32).toString('hex'), status: 'unknown', at: new Date().toISOString(), ...overrides }; }
async function call(method, route, { body, user = 1, operationId = crypto.randomUUID() } = {}) {
  requests++;
  const response = await fetch(origin + route, { method, signal: AbortSignal.timeout(15000), headers: { 'X-PDL-Company': fixture.A, 'Content-Type': 'application/json', ...(user === null ? {} : { Authorization: 'Bearer ' + fixture.tokens.get(user) }), 'X-PDL-Operation': operationId }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, data: await response.json(), operationId };
}
const okay = response => { assert.equal(response.status, 200, JSON.stringify(response.data)); return response.data; };
const noPrivate = (response, label) => { assert.ok(response.status >= 400, label + ': ' + JSON.stringify(response.data)); for (const key of ['projects', 'users', 'reports', 'photos', 'rolesProviderAttempts', 'digest', 'credential', 'setupCode', 'resetTokenHash']) assert.ok(!Object.hasOwn(response.data, key), label + ': private business or descriptor data cannot be delivered'); };
async function main() {
  let journeys = 0, malformedCases = 0, descriptorCases = 0;
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); }); origin = 'http://127.0.0.1:' + server.address().port;
    process.env.RESEND_API_KEY = 'synthetic-tenant-provider-memory-only'; process.env.PDL_PUBLIC_URL = origin; process.env.PDL_EMAIL_DEV_MODE = '0';
    const malformed = [
      ['foreign company', row => { row.companyId = fixture.B; }], ['missing actor', row => { delete row.actorId; }], ['string actor', row => { row.actorId = '2'; }], ['negative actor', row => { row.actorId = -1; }],
      ['extra descriptor field', row => { row.publicUrl = 'synthetic-private-marker'; }], ['wrong operation UUID version', row => { row.operationId = 'aaaaaaaa-aaaa-1aaa-8aaa-aaaaaaaaaaaa'; }], ['invalid ordinal', row => { row.ordinal = 0; }],
      ['unsupported kind', row => { row.kind = 'dictionary-permission'; }], ['unknown status', row => { row.status = 'complete'; }], ['suppressed storage outcome', row => { row.status = 'suppressed'; row.finishedAt = row.at; }],
      ['unknown with completion', row => { row.finishedAt = row.at; }], ['accepted without completion', row => { row.status = 'accepted'; }], ['completion predates admission', row => { row.status = 'accepted'; row.finishedAt = new Date(Date.parse(row.at) - 1).toISOString(); }],
      ['noncanonical admission date', row => { row.at = '2026-10-12'; }], ['malformed digest', row => { row.digest = 'not-a-digest'; }],
      ['credential wrong kind', row => { row.credential = { purpose: 'password-reset', userId: 2, tokenHash: 'a'.repeat(64) }; }],
      ['credential extra field', row => { row.kind = 'email'; row.credential = { purpose: 'password-reset', userId: 2, tokenHash: 'a'.repeat(64), recipient: 'custody@example.invalid' }; }],
      ['credential wrong purpose', row => { row.kind = 'email'; row.credential = { purpose: 'grant-owner', userId: 2, tokenHash: 'a'.repeat(64) }; }],
      ['credential string user', row => { row.kind = 'email'; row.credential = { purpose: 'password-reset', userId: '2', tokenHash: 'a'.repeat(64) }; }],
      ['credential nonprimitive hash', row => { row.kind = 'email'; row.credential = { purpose: 'password-reset', userId: 2, tokenHash: {} }; }]
    ];
    for (const [name, change] of malformed) {
      restore(); const row = attempt(); change(row); fixture.alter(db => { db.rolesProviderAttempts = [row]; });
      const before = canonicalHash(fixture.read()), writes = casWrites, dispatched = imageDispatches + emailDispatches;
      const read = await call('GET', '/api/state'); assert.equal(read.status, 503, name + ': ' + JSON.stringify(read.data)); noPrivate(read, name);
      const effect = await call('POST', '/api/photos', { user: 2, body: photoBody(name) }); assert.equal(effect.status, 503, name + ': ' + JSON.stringify(effect.data)); noPrivate(effect, name);
      assert.equal(canonicalHash(fixture.read()), before, name + ': no business/custody normalization'); assert.equal(casWrites, writes); assert.equal(imageDispatches + emailDispatches, dispatched); malformedCases++;
    }
    for (const name of ['duplicate ID', 'duplicate operation ordinal', 'nonarray collection']) {
      restore(); const first = attempt(), second = attempt(); if (name === 'duplicate ID') second.id = first.id; if (name === 'duplicate operation ordinal') second.operationId = first.operationId;
      fixture.alter(db => { db.rolesProviderAttempts = name === 'nonarray collection' ? { row: first } : [first, second]; });
      const before = canonicalHash(fixture.read()), writes = casWrites, dispatched = imageDispatches;
      const read = await call('GET', '/api/company/provider-operations'); assert.equal(read.status, 503, name + ': ' + JSON.stringify(read.data)); noPrivate(read, name);
      const effect = await call('POST', '/api/photos', { user: 2, body: photoBody(name) }); assert.equal(effect.status, 503); noPrivate(effect, name);
      assert.equal(canonicalHash(fixture.read()), before); assert.equal(casWrites, writes); assert.equal(imageDispatches, dispatched); malformedCases++;
    }
    journeys++;
    restore(); fixture.alter(db => { db.rolesProviderAttempts = [attempt({ kind: 'founder-alert', status: 'suppressed', finishedAt: new Date().toISOString() })]; db.rolesProviderAttempts[0].at = db.rolesProviderAttempts[0].finishedAt; });
    const permitted = okay(await call('GET', '/api/company/provider-operations')); assert.equal(permitted[0].status, 'suppressed'); assert.ok(!('digest' in permitted[0])); journeys++;
    const storageDescriptorChanges = [
      ['actor', row => { row.actorId = 1; }], ['company', row => { row.companyId = fixture.B; }], ['operation', row => { row.operationId = crypto.randomUUID(); }], ['ordinal', row => { row.ordinal += 1; }],
      ['kind', row => { row.kind = 'ai'; }], ['digest', row => { row.digest = 'b'.repeat(64); }], ['admission timestamp', row => { row.at = new Date(Date.parse(row.at) + 1).toISOString(); }],
      ['completed status', row => { row.status = 'accepted'; row.finishedAt = row.at; }], ['malformed added field', row => { row.untrusted = true; }]
    ];
    for (const [name, change] of storageDescriptorChanges) {
      restore(); const operationId = crypto.randomUUID(), body = photoBody('descriptor-' + name), dispatched = imageDispatches, writes = casWrites; let changed, original, admittedWrites;
      providerHook = async kind => {
        assert.equal(kind, 'storage-upload'); providerHook = null; original = fixture.read().rolesProviderAttempts.find(row => row.operationId === operationId); assert.equal(original.status, 'unknown');
        admittedWrites = casWrites; fixture.alter(db => { change(db.rolesProviderAttempts.find(row => row.id === original.id)); }); changed = fixture.read();
      };
      const response = await call('POST', '/api/photos', { user: 2, body, operationId });
      assert.equal(response.status, 503, name + ': ' + JSON.stringify(response.data)); assert.equal(response.data.operationId, operationId, name + ': original finite ambiguity reference'); noPrivate(response, name);
      assert.equal(imageDispatches - dispatched, 1); assert.equal(casWrites - writes, 1, name + ': only original admission may commit'); assert.equal(casWrites, admittedWrites, name + ': changed descriptor cannot receive an outcome CAS');
      assert.equal(canonicalHash(fixture.read()), canonicalHash(changed), name + ': no business/source rebase or forged outcome'); assert.deepEqual(fixture.read().photos, baseline.photos);
      const saved = canonicalHash(fixture.read()), replayWrites = casWrites;
      const replay = await call('POST', '/api/photos', { user: 2, body, operationId }); noPrivate(replay, name + ' replay');
      assert.equal(imageDispatches - dispatched, 1, name + ': no same-operation resend'); assert.equal(casWrites, replayWrites); assert.equal(canonicalHash(fixture.read()), saved); descriptorCases++;
    }
    journeys++;
    for (const [name, change] of [
      ['credential recipient identity', row => { row.credential.userId = 1; }], ['credential generation', row => { row.credential.tokenHash = 'c'.repeat(64); }], ['credential purpose', row => { row.credential.purpose = 'email-verification'; }]
    ]) {
      restore(); const operationId = crypto.randomUUID(), dispatched = emailDispatches, writes = casWrites; let changed;
      providerHook = async kind => { assert.equal(kind, 'email'); providerHook = null; fixture.alter(db => { const row = db.rolesProviderAttempts.find(row => row.operationId === operationId); assert.equal(row.actorId, null); assert.equal(row.credential.purpose, 'password-reset'); change(row); }); changed = fixture.read(); };
      const response = await call('POST', '/api/auth/forgot', { user: null, body: { email: baseline.users.find(row => row.id === 2).email }, operationId });
      assert.equal(response.status, 503, name + ': ' + JSON.stringify(response.data)); assert.equal(response.data.operationId, operationId); noPrivate(response, name);
      assert.equal(emailDispatches - dispatched, 1); assert.equal(casWrites - writes, 1); assert.equal(canonicalHash(fixture.read()), canonicalHash(changed));
      const saved = canonicalHash(fixture.read()), replayWrites = casWrites;
      noPrivate(await call('POST', '/api/auth/forgot', { user: null, body: { email: baseline.users.find(row => row.id === 2).email }, operationId }), name + ' replay');
      assert.equal(emailDispatches - dispatched, 1); assert.equal(casWrites, replayWrites); assert.equal(canonicalHash(fixture.read()), saved); descriptorCases++;
    }
    journeys++;
    for (const [name, change] of [
      ['role revoked', db => { db.users.find(row => row.id === 2).role = 'foreman'; }], ['session revoked', db => { db.sessions = db.sessions.filter(row => row.tokenHash !== originalFieldSessionHash); }], ['concurrent business', db => { db.projects[0].name = 'Synthetic concurrent project correction'; }]
    ]) {
      restore(); const operationId = crypto.randomUUID(), body = photoBody(name), dispatched = imageDispatches, writes = casWrites; let changed, original;
      providerHook = async kind => { assert.equal(kind, 'storage-upload'); providerHook = null; original = fixture.read().rolesProviderAttempts.find(row => row.operationId === operationId); fixture.alter(change); changed = fixture.read(); };
      const response = await call('POST', '/api/photos', { user: 2, body, operationId });
      assert.ok([401, 403, 409].includes(response.status), name + ': ' + JSON.stringify(response.data)); assert.equal(response.data.operationId, operationId, name + ': original known-result reference'); noPrivate(response, name);
      assert.equal(imageDispatches - dispatched, 1); assert.equal(casWrites - writes, 2, name + ': exactly original admission and known outcome commits');
      const current = fixture.read(), outcome = current.rolesProviderAttempts.find(row => row.id === original.id);
      assert.equal(outcome.status, 'accepted'); assert.ok(Number.isFinite(Date.parse(outcome.finishedAt))); assert.deepEqual(Object.fromEntries(Object.entries(outcome).filter(([key]) => !['status', 'finishedAt'].includes(key))), Object.fromEntries(Object.entries(original).filter(([key]) => key !== 'status')));
      const expected = structuredClone(changed); Object.assign(expected.rolesProviderAttempts.find(row => row.id === original.id), { status: 'accepted', finishedAt: outcome.finishedAt });
      assert.equal(canonicalHash(current), canonicalHash(expected), name + ': outcome evidence confers no business rebase or new photo reference'); journeys++;
    }
    restore(); const operationId = crypto.randomUUID();
    const accepted = await call('POST', '/api/photos', { user: 2, body: photoBody('ordinary-current'), operationId }); assert.equal(accepted.status, 201, JSON.stringify(accepted.data));
    assert.equal(fixture.read().rolesProviderAttempts[0].status, 'accepted'); assert.equal(fixture.read().photos.length, (baseline.photos || []).length + 1);
    const read = okay(await call('GET', '/api/company/provider-operations')); assert.equal(read[0].operationId, operationId); assert.ok(!('digest' in read[0]) && !('actorId' in read[0])); journeys++;
    console.log(JSON.stringify({ passed: true, journeys, malformedCases, descriptorCases, requests, casWrites, imageDispatches, emailDispatches, expectedEvidenceLogs, externalCalls: 0, normalServer: true, syntheticTransport: true, testInstallerUsed: false, nativeDeadlineClaim: false }));
  } finally {
    providerHook = null; process.env.RESEND_API_KEY = ''; server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); blobs.clear(); globalThis.fetch = nativeFetch; console.error = nativeError; fs.rmSync(ownedDirectory, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
