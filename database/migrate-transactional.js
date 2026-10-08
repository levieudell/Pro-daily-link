'use strict';

const path = require('node:path');
const supabase = require('./supabase');
const { canonicalHash } = require('./transactional-repository');

supabase.loadLocalEnv(path.resolve(__dirname, '..'));

function parseArgs(argv = process.argv.slice(2)) {
  const apply = argv.includes('--apply');
  const all = argv.includes('--all');
  const companyIndex = argv.indexOf('--company-id');
  const companyId = companyIndex >= 0 ? String(argv[companyIndex + 1] || '').trim() : '';
  if (companyIndex >= 0 && !companyId) throw new Error('--company-id requires a company UUID.');
  if (apply && !companyId && !all) throw new Error('Refusing an unscoped migration. Use --company-id <uuid> for a controlled tenant migration, or --all only after cohort approval.');
  if (companyId && all) throw new Error('Choose either --company-id or --all, not both.');
  return { apply, all, companyId };
}

function selectSnapshots(snapshots, companyId) {
  const eligible = snapshots.filter(snapshot => snapshot?.company?.id && !snapshot.platform && !snapshot.company.archivedDuplicate);
  if (!companyId) return eligible;
  const selected = eligible.filter(snapshot => String(snapshot.company.id) === companyId);
  if (!selected.length) throw new Error(`Company snapshot not found: ${companyId}`);
  return selected;
}

async function main() {
  if (!supabase.configured()) throw new Error('Supabase configuration is missing.');
  const { apply, companyId } = parseArgs();
  if (apply) require('./tenant-admission').blockLegacyWriter('transactional migration apply');
  const snapshots = selectSnapshots(await supabase.listCompanySnapshots(), companyId);
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

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });

module.exports = { parseArgs, selectSnapshots };

