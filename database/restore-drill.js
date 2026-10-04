const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const supabase = require('./supabase');

const root = path.resolve(__dirname, '..');
supabase.loadLocalEnv(root);

const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function validateSnapshot(snapshot) {
  assert.ok(snapshot && typeof snapshot === 'object', 'Backup must contain a JSON object');
  assert.ok(snapshot.company?.id, 'Backup is missing company identity');
  for (const collection of ['users', 'projects', 'reports']) {
    assert.ok(Array.isArray(snapshot[collection]), `Backup is missing ${collection}`);
  }
}

async function main() {
  const source = path.resolve(process.env.PDL_DB_FILE || path.join(root, 'data', 'db.json'));
  assert.ok(fs.existsSync(source), `Source database not found: ${source}`);
  const original = fs.readFileSync(source);
  const snapshot = JSON.parse(original.toString('utf8'));
  validateSnapshot(snapshot);

  const drillDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-restore-drill-'));
  try {
    const restoredFile = path.join(drillDirectory, 'restored.json');
    fs.writeFileSync(restoredFile, original, { flag: 'wx' });
    const restored = fs.readFileSync(restoredFile);
    const restoredSnapshot = JSON.parse(restored.toString('utf8'));
    validateSnapshot(restoredSnapshot);
    assert.equal(digest(restored), digest(original), 'Restored backup hash does not match its source');
    assert.deepEqual(restoredSnapshot, snapshot, 'Restored backup data does not match its source');

    let cloud = null;
    if (supabase.configured() && !process.argv.includes('--local-only')) {
      cloud = await supabase.createVerifiedBackup(snapshot);
      assert.equal(cloud.hash, digest(original), 'Verified cloud backup hash does not match its source');
    }

    console.log(`Backup restore drill passed for ${snapshot.company.name || snapshot.company.id}.`);
    console.log(`Verified ${original.length.toLocaleString()} bytes with SHA-256 ${digest(original).slice(0, 16)}…${cloud ? ` and private cloud object ${cloud.objectKey}` : ''}`);
  } finally {
    fs.rmSync(drillDirectory, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(`Backup restore drill failed: ${error.message}`);
  process.exitCode = 1;
});
