'use strict';
// Durable backup receipts: Render has no persistent disk, so the verified-
// backup receipt must be mirrored into the tenant-backups bucket and restored
// at boot. Without this, every deploy wipes the receipt and /api/health
// reports the backup as "not fresh" until an unrelated write happens to
// re-trigger verification.
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-receipt-cloud-')), companyId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const hash = token => crypto.createHash('sha256').update(token).digest('hex');
const db = {
  company: { id: companyId, name: 'Receipt tenant', demo: true, timezone: 'UTC', persistence: { revision: 3 } },
  projects: [], team: [], assignments: [], workdays: [], timeCards: [], timeOffRequests: [], reports: [], photos: [], auditLog: [], customers: [], users: [{ id: 1, name: 'Owner', role: 'owner', status: 'Active', companyId }], sessions: []
};
const file = path.join(root, 'db.json'); fs.writeFileSync(file, JSON.stringify(db)); fs.writeFileSync(path.join(root, 'platform.json'), JSON.stringify({ users: [], sessions: [] }));
Object.assign(process.env, { PDL_DB_FILE: file, PDL_PLATFORM_FILE: path.join(root, 'platform.json'), PDL_REQUIRE_AUTH: '1', PDL_SUPABASE_ENABLED: '1', SUPABASE_URL: 'https://synthetic.invalid', SUPABASE_SECRET_KEY: 'synthetic-secret', PDL_TRANSACTIONAL_DB: 'off', PDL_EMAIL_DEV_MODE: '1' });
for (const name of ['OPENAI_API_KEY', 'SENTRY_DSN', 'RESEND_API_KEY', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET']) delete process.env[name];
require('./database/supabase').loadLocalEnv = () => {};
const backup = require('./database/backup-verification');
const supabase = require('./database/supabase');
const receiptDir = path.join(root, '.backup-verification');
const verifiedAt = new Date(Date.now() - 60 * 1000).toISOString();
const cloudReceipt = {
  version: 1, companyId,
  attempt: { id: 'attempt-1', at: verifiedAt, status: 'verified' },
  verification: { method: 'upload-download-sha256', verifiedAt, bucket: 'tenant-backups', objectKey: `${companyId}/2026-01-01-abc.json`, sha256: 'a'.repeat(64), bytes: 42, sourceRevision: 3, sourceContentHash: 'b'.repeat(64) }
};
const uploads = [];
supabase.download = async (bucket, objectKey) => {
  assert.equal(bucket, 'tenant-backups');
  assert.equal(objectKey, `${companyId}/_receipt.json`);
  return { arrayBuffer: async () => Buffer.from(JSON.stringify(cloudReceipt)) };
};
supabase.upload = async (bucket, objectKey, bytes, contentType, upsert) => {
  uploads.push({ bucket, objectKey, body: bytes.toString('utf8'), contentType, upsert });
};
const { restoreBackupReceipt, mirrorBackupReceipt } = require('./server');
(async () => {
  try {
    assert.equal(backup.publicStatus(receiptDir, companyId).fresh, false, 'no local receipt yet');

    // Boot restore pulls the cloud receipt onto local disk.
    await restoreBackupReceipt(companyId);
    const restored = backup.readReceipt(receiptDir, companyId);
    assert.equal(restored.verification.verifiedAt, verifiedAt, 'cloud receipt restored locally');
    assert.equal(backup.publicStatus(receiptDir, companyId).fresh, true, 'restored receipt establishes freshness after a restart');
    assert.equal(backup.publicStatus(receiptDir, companyId).restore, 'not-checked', 'a restored snapshot receipt is not falsely promoted to restore-drill evidence');
    assert.equal(backup.publicStatus(receiptDir, companyId).lastAttemptStatus, 'verified');

    // Restore is idempotent and never clobbers a local receipt.
    fs.writeFileSync(backup.receiptFile(receiptDir, companyId), JSON.stringify({ ...cloudReceipt, attempt: { id: 'attempt-local', at: verifiedAt, status: 'failed' } }));
    await restoreBackupReceipt(companyId);
    assert.equal(backup.readReceipt(receiptDir, companyId).attempt.id, 'attempt-local', 'existing local receipt wins');

    // Mirror pushes the receipt back to the bucket with upsert enabled.
    await mirrorBackupReceipt(companyId);
    assert.equal(uploads.length, 1, 'one mirror upload');
    assert.equal(uploads[0].upsert, true, 'receipt overwrites previous mirror');
    assert.equal(JSON.parse(uploads[0].body).companyId, companyId);

    // A corrupt cloud object must not create a local receipt.
    supabase.download = async () => ({ arrayBuffer: async () => Buffer.from('not json') });
    fs.rmSync(backup.receiptFile(receiptDir, companyId));
    await restoreBackupReceipt(companyId);
    assert.equal(backup.readReceipt(receiptDir, companyId), null, 'corrupt cloud receipt ignored');

    // Server contract: startup self-heal exists and the write path mirrors receipts.
    const serverSrc = fs.readFileSync('server.js', 'utf8');
    assert.ok(serverSrc.includes('startBackupSelfHeal'), 'startup self-heal runs at boot');
    assert.ok(serverSrc.includes('backupBootTimer'), 'self-heal scheduled after listen');
    assert.ok(serverSrc.includes('mirrorBackupReceipt(db.company.id)'), 'write-path backups mirror receipts');
    assert.ok(serverSrc.includes('receiptObjectKey'), 'receipt object key defined');

    console.log('durable backup receipts: restore, idempotence, mirror, corruption guard: ok');
  } catch (error) { console.error('backup-receipt-cloud FAILED:', error.message); process.exitCode = 1; }
})();
