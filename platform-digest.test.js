const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const backupVerification = require('./database/backup-verification');

delete process.env.RESEND_API_KEY;
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-digest-'));
fs.mkdirSync(path.join(tempDir, 'tenants'));
const dbFile = path.join(tempDir, 'db.json');
fs.writeFileSync(dbFile, fs.readFileSync(path.join(__dirname, 'data', 'db.json')));
const platformFile = path.join(tempDir, 'platform.json');
process.env.PDL_DB_FILE = dbFile;
process.env.PDL_PLATFORM_FILE = platformFile;
process.env.PDL_SUPABASE_ENABLED = '0';
process.env.PDL_EMAIL_DEV_MODE = '1';
process.env.PDL_REQUIRE_AUTH = '0';

const {maybeSendWeeklyHealthDigest, nextWeeklyDigestDue, weeklyHealthDigestModel, renderWeeklyHealthDigestEmail} = require('./server');
const daysAgo = n => new Date(Date.now() - n * 86400000).toISOString();

// Seed: main tenant is a real past-due account; a second tenant is a QA-named
// internal account that must never reach the digest.
const db = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
db.company = {...db.company, id: 'acme-1', name: 'Acme Builders', demo: false, subscriptionStatus: 'Past due', trialEndsAt: null, createdAt: daysAgo(60), accountType: 'standard'};
for (const report of db.reports || []) report.createdAt = daysAgo(1);
fs.writeFileSync(dbFile, JSON.stringify(db));
fs.writeFileSync(path.join(tempDir, 'tenants', 'qa-co.json'), JSON.stringify({
  company: {id: 'qa-co', name: 'QA Sandbox Co', demo: false, subscriptionStatus: 'Past due', createdAt: daysAgo(30)},
  projects: [], reports: [], users: [], team: [], workdays: [], timeCards: [], timeOffRequests: [], photos: [], sessions: [], customers: [], changes: [], catalog: [],
}));
fs.writeFileSync(platformFile, JSON.stringify({
  users: [{id: 1, name: 'Levi', email: 'founder@example.test', role: 'platform_owner', status: 'Active'}],
  sessions: [],
}));

(async () => {
  try {
    // A verified backup receipt exists for the main tenant; the QA tenant is unverified.
    const backupSnapshot = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
    backupSnapshot.company.persistence = {revision: 1};
    const backupBytes = Buffer.from(JSON.stringify(backupSnapshot));
    const backupHash = crypto.createHash('sha256').update(backupBytes).digest('hex');
    await backupVerification.createAndRecordVerification(backupSnapshot, {directory: path.join(tempDir, '.backup-verification'),
      createBackup: async () => ({bucket: 'tenant-backups', objectKey: `${backupSnapshot.company.id}/synthetic.json`, hash: backupHash, bytes: backupBytes.length, verifiedAt: new Date().toISOString()})});

    // Scheduling: every digest lands on Monday 08:00 America/Chicago.
    assert.equal(nextWeeklyDigestDue(new Date('2026-10-07T15:00:00Z')).getTime(), Date.UTC(2026, 9, 12, 13, 0), 'Wednesday -> Monday Oct 12, 08:00 CDT = 13:00 UTC');
    assert.equal(nextWeeklyDigestDue(new Date('2026-10-12T12:00:00Z')).getTime(), Date.UTC(2026, 9, 12, 13, 0), '07:00 CDT Monday still lands on that morning');
    assert.equal(nextWeeklyDigestDue(new Date('2026-10-12T13:00:00Z')).getTime(), Date.UTC(2026, 9, 12, 13, 0), 'exactly 08:00 CDT is due now');
    assert.equal(nextWeeklyDigestDue(new Date('2026-10-12T14:00:00Z')).getTime(), Date.UTC(2026, 9, 19, 13, 0), 'after the slot, next Monday');

    // Model: internal QA account excluded, flagged account listed.
    const model = await weeklyHealthDigestModel();
    assert.equal(model.total, 1, 'QA Sandbox Co must be excluded');
    assert.equal(model.flagged.length, 1);
    assert.equal(model.flagged[0].name, 'Acme Builders');
    assert.ok(model.flagged[0].alerts.includes('Subscription past due'));
    assert.equal(model.backups.length, 2, 'backup coverage lists every workspace');
    const acmeBackup = model.backups.find(b => b.name === 'Acme Builders');
    assert.ok(acmeBackup.lastVerifiedAt, 'verified receipt is surfaced');
    assert.equal(acmeBackup.fresh, true);
    const qaBackup = model.backups.find(b => b.name === 'QA Sandbox Co');
    assert.equal(qaBackup.lastVerifiedAt, null);
    assert.equal(qaBackup.lastAttemptStatus, null);

    // Forced send delivers through the injected sender and records state.
    let delivered = null;
    const first = await maybeSendWeeklyHealthDigest({force: true, sendEmailFn: async (recipients, m) => { delivered = {recipients, m}; }});
    assert.equal(first.sent, true);
    assert.deepEqual(delivered.recipients, ['founder@example.test']);
    const html = renderWeeklyHealthDigestEmail(delivered.m);
    assert.match(html, /Acme Builders/);
    assert.match(html, /Subscription past due/);
    assert.match(html, /All 1 customer account need attention/);
    assert.match(html, /<strong>80<\/strong> Watch/);
    assert.match(html, /Backups/);
    assert.match(html, /Verified today/);
    assert.match(html, /Never verified/);
    const state = JSON.parse(fs.readFileSync(platformFile, 'utf8'));
    assert.ok(state.weeklyDigest.lastSentAt);
    assert.equal(state.weeklyDigest.flaggedCount, 1);
    assert.ok(state.auditEvents.some(event => event.action === 'weekly_health_digest_sent'), 'digest is audited');

    // A second unforced send this week is skipped and never calls the sender.
    const second = await maybeSendWeeklyHealthDigest({sendEmailFn: async () => { throw Error('must not send'); }});
    assert.equal(second.sent, false);
    assert.equal(second.reason, 'already-sent');

    // No active owner email -> clean skip.
    state.users[0].email = '';
    fs.writeFileSync(platformFile, JSON.stringify(state));
    const third = await maybeSendWeeklyHealthDigest({force: true});
    assert.equal(third.sent, false);
    assert.equal(third.reason, 'no-recipients');

    // Dev mode without a provider sends nothing over the wire but still reports sent.
    state.users[0].email = 'founder@example.test';
    fs.writeFileSync(platformFile, JSON.stringify(state));
    const dev = await maybeSendWeeklyHealthDigest({force: true});
    assert.equal(dev.sent, true);

    console.log('platform-digest: ok');
    process.exit(0);
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
})();
