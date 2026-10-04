'use strict';

const path = require('node:path');
const supabase = require('./supabase');
const { canonicalHash } = require('./transactional-repository');

supabase.loadLocalEnv(path.resolve(__dirname, '..'));

async function main() {
  if (!supabase.configured()) throw new Error('Supabase configuration is missing.');
  const apply = process.argv.includes('--apply');
  const snapshots = (await supabase.listCompanySnapshots()).filter(snapshot => snapshot?.company?.id && !snapshot.platform && !snapshot.company.archivedDuplicate);
  const summary = snapshots.map(snapshot => ({ id: snapshot.company.id, name: snapshot.company.name, revision: Number(snapshot.company.persistence?.revision || 0), hash: canonicalHash(snapshot), records: Object.values(snapshot).filter(Array.isArray).reduce((total, rows) => total + rows.length, 0) }));
  if (!apply) {
    console.log(JSON.stringify({ mode: 'preview', companies: summary }, null, 2));
    return;
  }
  const results = [];
  for (const snapshot of snapshots) {
    const backup = await supabase.createVerifiedBackup(snapshot);
    const current = await supabase.loadTransactionalSnapshot(snapshot.company.id);
    const saved = await supabase.saveTransactionalSnapshot(snapshot, current?.revision || 0);
    const loaded = await supabase.loadTransactionalSnapshot(snapshot.company.id);
    const expectedHash = canonicalHash(snapshot);
    if (!loaded || loaded.contentHash !== expectedHash || canonicalHash(loaded.snapshot) !== expectedHash) throw new Error(`Reconciliation failed for ${snapshot.company.name}`);
    results.push({ id: snapshot.company.id, name: snapshot.company.name, backup, revision: saved.revision, records: saved.records, hash: expectedHash });
  }
  console.log(JSON.stringify({ mode: 'applied', companies: results }, null, 2));
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });


