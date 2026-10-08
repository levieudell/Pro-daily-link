'use strict';
const assert = require('node:assert/strict'), { verify } = require('./tenant-readiness'), { canonicalHash } = require('./database/transactional-repository');
async function main() {
  const companyId = '00000000-0000-4000-8000-000000000001', config = { enabled: true, companyId }, snapshot = { company: { id: companyId }, empty: [], nullable: null };
  const good = { protocol_version: 1, initialized: true, mandatory_revision: true, guarded_policy: true, service_only: true, forced_rls: true }, loaded = { revision: 1, snapshot, contentHash: canonicalHash(snapshot) };
  let reads = 0; const load = async target => { assert.equal(target, companyId); reads++; return loaded; };
  await verify(config, { load, protocol: async () => good }); assert.equal(reads, 1);
  for (const key of Object.keys(good)) { reads = 0; await assert.rejects(verify(config, { load, protocol: async () => ({ ...good, [key]: key === 'protocol_version' ? 2 : false }) }), /readiness/); assert.equal(reads, 0); }
  for (const bad of [null, { ...loaded, revision: 0 }, { ...loaded, contentHash: '0'.repeat(64) }, { ...loaded, snapshot: { company: { id: 'foreign' } } }]) await assert.rejects(verify(config, { load: async () => bad, protocol: async () => good }), /readiness/);
  await verify({ enabled: false }, { load: () => assert.fail(), protocol: () => assert.fail() });
  console.log('Dedicated startup readiness: exact typed protocol, mandatory revisions, service privileges/RLS, initialized canonical snapshot, no lookup after failure and unchanged legacy path passed.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
