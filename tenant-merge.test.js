'use strict';
// Tenant snapshot merge freshness: the founder console must show the freshest
// copy of each account, not "cloud always wins". Regression: a lagging cloud
// snapshot used to overwrite fresh local data, so healthy accounts showed
// ghost alerts ("No project created · No daily reports submitted").
const assert = require('node:assert/strict');
const { mergeTenantSnapshots, persistenceRevision } = require('./tenant-merge');
const { mergeTenantSnapshots: exported } = require('./server');

const tenant = (id, revision, name) => ({
  company: { id, name, persistence: { revision } },
  projects: [{ id: 1 }],
  reports: [{ id: 1 }]
});
const CLOUD_ID = 'platform-cloud';

assert.equal(persistenceRevision({ company: {} }), 0, 'missing revision reads as 0');
assert.equal(persistenceRevision(tenant('a', 7, 'A')), 7);

// Local-only and remote-only tenants both appear.
{
  const merged = mergeTenantSnapshots([tenant('local-1', 1, 'Local')], [tenant('remote-1', 1, 'Remote')], CLOUD_ID);
  assert.deepEqual(merged.map(t => t.company.id).sort(), ['local-1', 'remote-1']);
}

// Cloud lagging: fresh local wins even though remote comes last.
{
  const local = tenant('acme', 42, 'Acme Local Fresh');
  const remote = tenant('acme', 5, 'Acme Cloud Stale');
  const merged = mergeTenantSnapshots([local], [remote], CLOUD_ID);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].company.name, 'Acme Local Fresh', 'higher local revision wins over stale cloud copy');
}

// Cloud ahead: fresher remote wins (disk restored from an older backup).
{
  const local = tenant('acme', 3, 'Acme Local Stale');
  const remote = tenant('acme', 60, 'Acme Cloud Fresh');
  const merged = mergeTenantSnapshots([local], [remote], CLOUD_ID);
  assert.equal(merged[0].company.name, 'Acme Cloud Fresh', 'higher cloud revision wins over stale local copy');
}

// Tie: first (local) copy kept — deterministic.
{
  const merged = mergeTenantSnapshots([tenant('acme', 9, 'First')], [tenant('acme', 9, 'Second')], CLOUD_ID);
  assert.equal(merged[0].company.name, 'First');
}

// Platform cloud row and id-less snapshots never appear.
{
  const merged = mergeTenantSnapshots(
    [{ company: { id: CLOUD_ID, name: 'Platform' } }, { company: null }, {}],
    [],
    CLOUD_ID
  );
  assert.equal(merged.length, 0);
}

// server.js re-exports the same helper so the console cannot drift from tests.
assert.equal(exported, mergeTenantSnapshots);
{
  const serverSrc = require('node:fs').readFileSync(require('node:path').join(__dirname, 'server.js'), 'utf8');
  assert.ok(serverSrc.includes('mergeTenantSnapshots(local,remote,PLATFORM_CLOUD_ID)'), 'platformCompanies uses the freshness merge');
}

console.log('tenant-merge tests passed');
