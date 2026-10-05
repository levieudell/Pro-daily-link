'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const backup = require('./database/backup-verification');
const supabase = require('./database/supabase');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-backup-verification-'));
const directory = path.join(temp, '.backup-verification');
const companyId = '11111111-1111-4111-8111-111111111111';
const otherId = '22222222-2222-4222-8222-222222222222';
const snapshot = { company: { id: companyId, name: 'Synthetic backup company', persistence: { revision: 7 } },
  users: [], projects: [], reports: [], projectNotesTodos: [{ id: 'note', text: 'Private synthetic note' }] };
Object.assign(process.env, {
  PDL_DB_FILE: path.join(temp, 'db.json'), PDL_PLATFORM_FILE: path.join(temp, 'platform.json'),
  PDL_REQUIRE_AUTH: '1', PDL_SUPABASE_ENABLED: '1', PDL_TRANSACTIONAL_DB: 'off',
  SUPABASE_URL: 'https://backup-verification.example.invalid', SUPABASE_SECRET_KEY: 'synthetic-only'
});
for (const key of ['SENTRY_DSN', 'STRIPE_SECRET_KEY', 'RESEND_API_KEY', 'OPENAI_API_KEY']) delete process.env[key];

const realFetch = global.fetch;
const objects = new Map();
let mode = 'success', uploadCount = 0, releaseDownload, blockDownload = false;
let saveCount = 0, savedSnapshot, failSave = false;
global.fetch = async (url, options = {}) => {
  const address = String(url);
  if (address.startsWith('http://127.0.0.1:')) return realFetch(url, options);
  assert.ok(address.startsWith(process.env.SUPABASE_URL + '/'), 'all external calls must target the synthetic adapter');
  const route = address.slice(process.env.SUPABASE_URL.length);
  if (route === '/storage/v1/bucket') return new Response('{}');
  if (route.startsWith('/storage/v1/object/tenant-backups/')) {
    if (options.method === 'POST') {
      uploadCount++;
      if (mode === 'upload-failure') return new Response('Synthetic upload failure', { status: 503 });
      objects.set(route, Buffer.from(options.body));
      return new Response('{}');
    }
    if (blockDownload) await new Promise(resolve => { releaseDownload = resolve; });
    if (mode === 'download-failure') return new Response('Synthetic download failure', { status: 503 });
    return new Response(mode === 'hash-mismatch' ? 'Wrong downloaded bytes' : objects.get(route));
  }
  if (route === '/rest/v1/companies?on_conflict=id') {
    saveCount++;
    if (failSave) { failSave = false; return new Response('Synthetic save failure', { status: 503 }); }
    savedSnapshot = JSON.parse(options.body)[0].data;
    return new Response('{}');
  }
  if (route === '/rest/v1/companies?select=id&limit=1') return new Response(JSON.stringify([{ id: companyId }]));
  throw new Error('Unexpected synthetic request: ' + route);
};

function receipt() { return JSON.parse(fs.readFileSync(backup.receiptFile(directory, companyId), 'utf8')); }
function overwriteReceipt(value) { fs.writeFileSync(backup.receiptFile(directory, companyId), JSON.stringify(value)); }
function ageReceipt(hours) {
  const value = receipt(), at = new Date(Date.now() - hours * 3600000).toISOString();
  value.verification.verifiedAt = at;
  value.attempt.at = at;
  overwriteReceipt(value);
}
async function verify(input = snapshot, extra = {}) {
  return backup.createAndRecordVerification(input, { directory, createBackup: supabase.createVerifiedBackup, ...extra });
}

(async () => {
  let server;
  try {
    assert.equal(backup.backupDue(directory, companyId), true);
    assert.equal(backup.publicStatus(directory, companyId).fresh, false);
    const original = structuredClone(snapshot);
    blockDownload = true;
    const pending = verify();
    for (let i = 0; !releaseDownload && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 1));
    assert.ok(releaseDownload);
    assert.equal(backup.publicStatus(directory, companyId).lastAttemptStatus, 'pending');
    assert.equal(backup.publicStatus(directory, companyId).lastVerifiedAt, null, 'upload alone is not verification');
    blockDownload = false; releaseDownload();
    await pending;
    assert.deepEqual(snapshot, original, 'receipts never alter tenant records, notes or revisions');
    assert.equal(backup.publicStatus(directory, companyId).fresh, true);
    assert.equal(backup.publicStatus(directory, otherId).fresh, false, 'one tenant cannot establish coverage for another');
    assert.equal(backup.backupDue(directory, companyId), false);
    assert.equal(receipt().verification.sourceRevision, 7);
    assert.equal(fs.statSync(backup.receiptFile(directory, companyId)).mode & 0o777, 0o600);
    const publicText = JSON.stringify(backup.publicStatus(directory, companyId));
    for (const secret of [companyId, snapshot.company.name, 'Private synthetic note', receipt().verification.sha256, receipt().verification.objectKey]) {
      assert.equal(publicText.includes(secret), false, 'public health must not disclose receipt details');
    }
    assert.equal(backup.publicStatus(directory, companyId).independentCopy, 'not-checked');
    assert.equal(backup.publicStatus(directory, companyId).restore, 'not-checked');
    const restart = spawnSync(process.execPath, ['-e',
      `const b=require('./database/backup-verification');process.stdout.write(JSON.stringify(b.publicStatus(${JSON.stringify(directory)},${JSON.stringify(companyId)})))`],
    { cwd: __dirname, encoding: 'utf8' });
    assert.equal(restart.status, 0);
    assert.equal(JSON.parse(restart.stdout).lastVerifiedAt, receipt().verification.verifiedAt, 'receipt survives a real process restart on the same disk');

    // An early application-save rejection can release the tenant queue while backup I/O
    // remains pending. Coalesce that old attempt even after its normal retry interval.
    const beforeRace = receipt();
    let rejectOld, completeOld, syntheticNow = Date.now();
    const held = backup.createAndRecordVerification(snapshot, { directory, now: () => syntheticNow,
      createBackup: () => new Promise((resolve, reject) => { completeOld = resolve; rejectOld = reject; }) });
    const rejected = assert.rejects(held, /late failure/);
    syntheticNow += backup.RETRY_AFTER_MS + 1;
    assert.equal(backup.backupDue(directory, companyId, syntheticNow), false, 'in-flight I/O cannot overlap after queue release');
    assert.equal(backup.createAndRecordVerification(snapshot, { directory, createBackup: () => { throw Error('must not run'); } }), held);
    const newer = structuredClone(beforeRace);
    newer.attempt = { id: 'newer-attempt', at: new Date(syntheticNow).toISOString(), status: 'verified' };
    newer.verification.verifiedAt = newer.attempt.at;
    overwriteReceipt(newer);
    rejectOld(Error('late failure'));
    await rejected;
    assert.deepEqual(backup.readReceipt(directory, companyId, syntheticNow), newer, 'late failure preserves newer verification and attempt');
    overwriteReceipt(beforeRace);

    syntheticNow = Date.now();
    const oldStartedAt = syntheticNow;
    const oldSuccess = backup.createAndRecordVerification(snapshot, { directory, now: () => syntheticNow,
      createBackup: () => new Promise(resolve => { completeOld = resolve; }) });
    syntheticNow += 2000;
    const newest = structuredClone(beforeRace);
    newest.attempt = { id: 'newest-attempt', at: new Date(syntheticNow).toISOString(), status: 'verified' };
    newest.verification.verifiedAt = newest.attempt.at;
    overwriteReceipt(newest);
    const sourceBytes = Buffer.from(JSON.stringify(snapshot));
    completeOld({ bucket: 'tenant-backups', objectKey: companyId + '/older.json',
      bytes: sourceBytes.length, hash: crypto.createHash('sha256').update(sourceBytes).digest('hex'),
      verifiedAt: new Date(oldStartedAt + 1000).toISOString() });
    await oldSuccess;
    assert.deepEqual(backup.readReceipt(directory, companyId, syntheticNow), newest, 'out-of-order success cannot roll back newer evidence');
    overwriteReceipt(beforeRace);

    for (mode of ['upload-failure', 'download-failure', 'hash-mismatch']) {
      ageReceipt(37);
      const lastSuccess = receipt().verification.verifiedAt;
      assert.equal(backup.backupDue(directory, companyId), true);
      await assert.rejects(verify());
      const status = backup.publicStatus(directory, companyId);
      assert.equal(status.lastVerifiedAt, lastSuccess, mode + ' must preserve, not advance, verification');
      assert.equal(status.lastAttemptStatus, 'failed');
      assert.equal(status.fresh, false);
      assert.equal(backup.backupDue(directory, companyId), false, 'brief retry backoff');
      assert.equal(backup.backupDue(directory, companyId, Date.now() + backup.RETRY_AFTER_MS), true, 'failure cannot suppress retries for a day');
      mode = 'success';
      await verify();
      assert.equal(backup.publicStatus(directory, companyId).fresh, true);
    }
    ageReceipt(25);
    assert.equal(backup.backupDue(directory, companyId), true, 'daily cadence is based on verified completion');
    assert.equal(backup.publicStatus(directory, companyId).fresh, true, 'freshness and daily retry cadence are distinct');
    const lastGood = receipt();
    for (const change of [
      value => { value.companyId = otherId; },
      value => { value.verification.verifiedAt = 'invalid'; },
      value => { value.verification.verifiedAt = '2999-01-01T00:00:00Z'; },
      value => { value.verification.method = 'copied'; },
      value => { value.verification.objectKey = otherId + '/backup.json'; },
      value => { value.verification.sha256 = 'not-a-hash'; }
    ]) {
      const value = structuredClone(lastGood); change(value); overwriteReceipt(value);
      assert.equal(backup.publicStatus(directory, companyId).fresh, false);
    }
    fs.writeFileSync(backup.receiptFile(directory, companyId), '{bad json');
    assert.equal(backup.publicStatus(directory, companyId).lastVerifiedAt, null);
    assert.equal(backup.backupDue(directory, companyId), true);
    await assert.rejects(verify(snapshot, { createBackup: async () => ({ verifiedAt: new Date().toISOString() }) }), /does not match/);
    assert.equal(backup.publicStatus(directory, companyId).fresh, false);

    // Exercise real writeDb/health integration without network, email, live accounts or live storage.
    fs.rmSync(directory, { recursive: true, force: true });
    const seed = JSON.parse(fs.readFileSync(path.join(__dirname, 'data/db.json'), 'utf8'));
    seed.company = { ...seed.company, id: companyId, demo: false, subscriptionStatus: 'Active',
      persistence: { revision: 20, lastBackupAt: new Date().toISOString() } };
    seed.assignments = []; seed.workdays = []; seed.timeCards = [];
    seed.users = [{ id: 1, companyId, name: 'Synthetic Owner', email: 'owner@example.invalid', role: 'owner', status: 'Active', emailVerifiedAt: new Date().toISOString() }];
    seed.sessions = [{ id: 'synthetic-session', companyId, userId: 1, tokenHash: crypto.createHash('sha256').update('synthetic-owner-token').digest('hex'), expiresAt: '2099-01-01T00:00:00Z' }];
    seed.projectNotesTodos = snapshot.projectNotesTodos;
    fs.writeFileSync(process.env.PDL_DB_FILE, JSON.stringify(seed));
    fs.copyFileSync(path.join(__dirname, 'data/platform.json'), process.env.PDL_PLATFORM_FILE);
    server = require('./server').server;
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = 'http://127.0.0.1:' + server.address().port;
    const request = async (route, method = 'GET', input) => {
      const response = await realFetch(base + route, { method,
        headers: { Authorization: 'Bearer synthetic-owner-token', 'Content-Type': 'application/json' },
        ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
      return { status: response.status, data: await response.json() };
    };
    const health = async () => (await request('/api/health')).data.services.backup;
    assert.equal((await health()).lastVerifiedAt, null, 'legacy lastBackupAt must not be called verification');
    assert.equal((await health()).fresh, false);
    process.env.PDL_SUPABASE_ENABLED = '0';
    const beforeOffline = uploadCount;
    assert.equal((await request('/api/auth/me')).status, 200);
    assert.equal((await health()).fresh, false, 'local file save is not a verified cloud backup');
    assert.equal(uploadCount, beforeOffline);
    process.env.PDL_SUPABASE_ENABLED = '1';
    mode = 'upload-failure';
    assert.equal((await request('/api/auth/me')).status, 200);
    assert.equal((await health()).lastAttemptStatus, 'failed');
    assert.equal((await health()).fresh, false);
    const failedCount = uploadCount;
    assert.equal((await request('/api/auth/me')).status, 200);
    assert.equal(uploadCount, failedCount, 'failed verification uses bounded retry backoff');
    const failedReceipt = receipt(); failedReceipt.attempt.at = new Date(Date.now() - backup.RETRY_AFTER_MS - 100).toISOString(); overwriteReceipt(failedReceipt);
    mode = 'success';
    const saveBefore = saveCount;
    assert.equal((await request('/api/auth/me')).status, 200);
    assert.equal((await health()).fresh, true);
    assert.equal(saveCount, saveBefore + 1, 'recording verification does not add a customer snapshot write');
    assert.deepEqual(savedSnapshot.projectNotesTodos, snapshot.projectNotesTodos);

    // A rejected app save must be caught by the HTTP server while older backup I/O is
    // still pending. It cannot terminate Node or permit an overlapping upload.
    ageReceipt(37);
    blockDownload = true; releaseDownload = undefined; failSave = true;
    const beforeHeld = uploadCount;
    const originalError = console.error, expectedErrors = [];
    console.error = (...args) => expectedErrors.push(args);
    try {
      assert.equal((await request('/api/auth/me')).status, 200, 'snapshot-mode response timing is unchanged');
      for (let i = 0; !releaseDownload && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 1));
      assert.ok(releaseDownload);
      assert.equal((await health()).lastAttemptStatus, 'pending');
      const pendingReceipt = receipt(); pendingReceipt.attempt.at = new Date(Date.now() - backup.RETRY_AFTER_MS - 100).toISOString(); overwriteReceipt(pendingReceipt);
      assert.equal((await request('/api/auth/me')).status, 200, 'server remains available after persistence rejection');
      assert.equal(uploadCount, beforeHeld + 1, 'no new upload while the older one remains pending');
      mode = 'download-failure'; blockDownload = false; releaseDownload();
      for (let i = 0; backup.publicStatus(directory, companyId).lastAttemptStatus === 'pending' && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 1));
      assert.equal((await health()).lastAttemptStatus, 'failed');
      assert.equal((await health()).fresh, false);
      assert.ok(expectedErrors.some(args => args.some(value => String(value).includes('Synthetic save failure'))), 'app storage rejection reached the server error handler');
    } finally { console.error = originalError; }
    const retry = receipt(); retry.attempt.at = new Date(Date.now() - backup.RETRY_AFTER_MS - 100).toISOString(); overwriteReceipt(retry);
    mode = 'success';
    assert.equal((await request('/api/auth/me')).status, 200);
    assert.equal((await health()).fresh, true);

    const goodAt = (await health()).lastVerifiedAt;
    assert.equal((await request('/api/company', 'PATCH', { name: 'Synthetic rename',
      persistence: { lastBackupAt: '2999-01-01T00:00:00Z', lastVerifiedAt: '2999-01-01T00:00:00Z' },
      backupVerification: { verifiedAt: '2999-01-01T00:00:00Z' } })).status, 200);
    assert.equal((await health()).lastVerifiedAt, goodAt, 'client company data cannot forge a verification receipt');
    const receiptName = path.basename(backup.receiptFile(directory, companyId));
    for (const route of ['/.backup-verification/' + receiptName, '/data/.backup-verification/' + receiptName,
      '/database/backup-verification.js', '/api/local-files/.backup-verification/' + receiptName]) {
      for (const headers of [{}, { Authorization: 'Bearer synthetic-owner-token' }]) {
        const response = await realFetch(base + route, { headers });
        assert.ok([401, 404].includes(response.status), 'private receipt/module route denied: ' + route);
      }
    }
    fs.rmSync(directory, { recursive: true, force: true });
    assert.equal((await health()).fresh, false, 'ephemeral receipt loss is conservatively unknown');
    assert.equal((await health()).lastVerifiedAt, null);
    assert.equal((await request('/api/auth/me')).status, 200);
    assert.equal((await health()).fresh, true, 'a later write can re-establish verified evidence');
    console.log('Backup verification passed: upload/download/hash completion, failures/retry, legacy/local false-positive denial, scoped private receipts, client forgery denial, process restart and ephemeral reset. No production providers used.');
  } finally {
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    global.fetch = realFetch;
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
