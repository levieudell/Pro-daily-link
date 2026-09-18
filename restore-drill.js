const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const supabase = require('./supabase');

const root = path.resolve(__dirname, '..');
supabase.loadLocalEnv(root);
process.env.PDL_SUPABASE_ENABLED ||= '1';

function counts(snapshot) {
  return Object.fromEntries(
    Object.entries(snapshot)
      .filter(([, value]) => Array.isArray(value))
      .map(([key, value]) => [key, value.length])
  );
}

async function main() {
  if (!supabase.configured()) throw new Error('Supabase backup storage is not configured');
  const source = JSON.parse(fs.readFileSync(path.join(root, 'data', 'db.json'), 'utf8'));
  const backup = await supabase.createVerifiedBackup(source);
  const response = await supabase.download(backup.bucket, backup.objectKey);
  const bytes = Buffer.from(await response.arrayBuffer());
  const downloadedHash = crypto.createHash('sha256').update(bytes).digest('hex');
  if (downloadedHash !== backup.hash) throw new Error('Downloaded backup hash does not match the source backup');

  const restored = JSON.parse(bytes.toString('utf8'));
  if (restored.company?.id !== source.company?.id) throw new Error('Restored tenant identity does not match');
  const sourceCounts = counts(source);
  const restoredCounts = counts(restored);
  if (JSON.stringify(sourceCounts) !== JSON.stringify(restoredCounts)) throw new Error('Restored record counts do not match');

  // Prove the payload can be instantiated as an isolated tenant without writing it
  // over any live company. Authentication artifacts are intentionally removed.
  const isolated = structuredClone(restored);
  isolated.company.id = crypto.randomUUID();
  isolated.company.name = `${restored.company.name} · restore drill`;
  isolated.sessions = [];
  isolated.users = (isolated.users || []).map(user => ({
    ...user,
    companyId: isolated.company.id,
    passwordHash: undefined,
    passwordSalt: undefined,
    setupHash: undefined,
    setupSalt: undefined,
    mustSetPassword: true
  }));
  if (isolated.company.id === source.company.id || isolated.sessions.length) throw new Error('Restore isolation failed');

  console.log(JSON.stringify({
    ok: true,
    backup: backup.objectKey,
    verifiedHash: downloadedHash,
    sourceCompany: source.company.id,
    isolatedCompany: isolated.company.id,
    records: restoredCounts,
    note: 'Restore validated in memory; live tenant data was not overwritten.'
  }, null, 2));
}

main().catch(error => {
  console.error(`Restore drill failed: ${error.message}`);
  process.exitCode = 1;
});
