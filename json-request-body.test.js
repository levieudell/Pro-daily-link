'use strict';
const assert = require('node:assert/strict'), { Readable } = require('node:stream');
const { EventEmitter } = require('node:events');
const { readJsonBody } = require('./json-request-body');
const { snapshot: fixture } = require('./compat-account-fixture');
const { split } = require('./database/compat-tenant-repository');
const { assembleSnapshot, canonicalHash } = require('./database/transactional-repository');
async function main() {
  const reason = 'Reviewed → changed · café 👷', snapshot = fixture();
  snapshot.auditLog = [{ id: 'synthetic-unicode-audit', action: reason }];
  const packed = split(snapshot), input = { p_scalar_data: packed.scalarData, p_content_hash: canonicalHash(snapshot), p_records: packed.records };
  const bytes = Buffer.from(JSON.stringify(input)), arrow = bytes.indexOf(Buffer.from('→'));
  const brokenChunks = [bytes.subarray(0, arrow + 1), bytes.subarray(arrow + 1)];
  const damaged = JSON.parse(brokenChunks.map(chunk => chunk.toString('utf8')).join(''));
  assert.notEqual(canonicalHash(assembleSnapshot(damaged.p_scalar_data, damaged.p_records)), input.p_content_hash, 'The former per-chunk decoder changes a valid snapshot and its hash');
  for (const chunks of [brokenChunks, [...bytes].map(byte => Buffer.from([byte]))]) {
    const stream = Readable.from(chunks), pending = readJsonBody(stream);
    assert.equal(readJsonBody(stream), pending, 'Repeated readers share the exact original promise');
    const parsed = await pending;
    assert.deepEqual(parsed, input);
    assert.equal(canonicalHash(assembleSnapshot(parsed.p_scalar_data, parsed.p_records)), parsed.p_content_hash);
  }
  const text = Buffer.from(JSON.stringify({ reason }));
  assert.deepEqual(await readJsonBody(Readable.from([text]), { maxBytes: text.length }), { reason });
  await assert.rejects(readJsonBody(Readable.from([text]), { maxBytes: text.length - 1 }), { statusCode: 413 });
  const over = new EventEmitter(); let drains = 0; over.resume = () => { drains++; };
  const rejected = readJsonBody(over, { maxBytes: 3 }); over.emit('data', Buffer.from('four')); over.emit('data', Buffer.alloc(100)); over.emit('end');
  await assert.rejects(rejected, { statusCode: 413 }); assert.equal(drains, 1, 'An oversized body drains once without retaining later chunks');
  assert.deepEqual(await readJsonBody(Readable.from([])), {});
  await assert.rejects(readJsonBody(Readable.from([Buffer.from('{broken')])), { statusCode: 400 });
  const transport = new Readable({ read() {} }), failure = Error('Synthetic interrupted body');
  const pending = readJsonBody(transport); transport.destroy(failure); await assert.rejects(pending, error => error === failure);
  console.log('JSON request body passed: forced multibyte stream splits preserve policy/audit text and snapshot hash, exact byte limits, cached promise, empty/syntax/transport contracts.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
