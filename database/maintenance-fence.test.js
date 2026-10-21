'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const {
  PUBLIC_MESSAGE,
  maintenanceLockFile,
  inspectMaintenanceFence,
  openMaintenanceFence,
  closeMaintenanceFence,
  requireVerifiedFence,
  assertWritesAllowed,
  guardHttpMutation
} = require('./maintenance-fence');
const { parseArgs } = require('./maintenance-lock');
const { PlatformRepository } = require('./platform-repository');
const backupVerification = require('./backup-verification');
const { createOAuth } = require('../mcp/oauth');

function code(expected) {
  return error => error?.code === expected;
}

function fakeResponse() {
  return {
    statusCode: 0,
    payload: null,
    writeHead(status) { this.statusCode = status; },
    end(raw) { this.payload = raw ? JSON.parse(raw) : null; }
  };
}

function request(port, method, pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname, headers }, response => {
      let raw = '';
      response.on('data', chunk => { raw += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body: raw ? JSON.parse(raw) : null }));
    });
    req.on('error', reject);
    req.end();
  });
}

function reservePort() {
  return new Promise((resolve, reject) => {
    const probe = http.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close(error => error ? reject(error) : resolve(port));
    });
  });
}

function waitForOutput(child, expected, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => finish(new Error(`Timed out waiting for child startup. stderr=${stderr}`)), timeoutMs);
    const finish = error => {
      clearTimeout(timer);
      child.stdout.off('data', onStdout);
      child.stderr.off('data', onStderr);
      child.off('exit', onExit);
      if (error) reject(error); else resolve(stdout);
    };
    const onStdout = chunk => {
      stdout += chunk.toString();
      if (stdout.includes(expected)) finish();
    };
    const onStderr = chunk => { stderr += chunk.toString(); };
    const onExit = (code, signal) => finish(new Error(`Child exited before startup (${code ?? signal}). stderr=${stderr}`));
    child.stdout.on('data', onStdout);
    child.stderr.on('data', onStderr);
    child.on('exit', onExit);
  });
}

function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise(resolve => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, 5_000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.kill('SIGTERM');
  });
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-maintenance-fence-'));
  const data = path.join(root, 'data');
  fs.mkdirSync(data, { recursive: true });
  const lockFile = path.join(data, 'maintenance.json');
  const env = {
    NODE_ENV: 'test',
    PDL_DB_FILE: path.join(data, 'db.json'),
    PDL_MAINTENANCE_LOCK_FILE: lockFile,
    PDL_MAINTENANCE_MODE: '1'
  };
  try {
    assert.throws(() => maintenanceLockFile({ ...env, PDL_MAINTENANCE_LOCK_FILE: 'relative.json' }), code('MAINTENANCE_PATH_INVALID'));
    const invalidMode = inspectMaintenanceFence({ ...env, PDL_MAINTENANCE_MODE: 'true' });
    assert.equal(invalidMode.enforced, true);
    assert.equal(invalidMode.reason, 'MAINTENANCE_MODE_INVALID');
    assert.throws(() => assertWritesAllowed({ ...env, PDL_MAINTENANCE_MODE: 'true' }), code('MAINTENANCE_READ_ONLY'));
    assert.throws(() => openMaintenanceFence({ ...env, PDL_MAINTENANCE_MODE: '0' }, { apply: true }), code('MAINTENANCE_ENVIRONMENT_FENCE_REQUIRED'));
    assert.throws(() => openMaintenanceFence(env), code('MAINTENANCE_APPLY_REQUIRED'));

    const opened = openMaintenanceFence(env, { apply: true });
    assert.equal(opened.verified, true);
    assert.equal(opened.environmentEnabled, true);
    assert.equal(opened.source, 'environment_and_lock');
    assert.match(opened.digest, /^[a-f0-9]{64}$/);
    assert.equal(fs.existsSync(lockFile), true);
    assert.equal(fs.existsSync(`${lockFile}.sha256`), true);
    if (process.platform !== 'win32') assert.equal(fs.statSync(lockFile).mode & 0o777, 0o600);
    assert.throws(() => openMaintenanceFence(env, { apply: true }), code('MAINTENANCE_FENCE_EXISTS'));

    assert.throws(() => assertWritesAllowed(env), code('MAINTENANCE_READ_ONLY'));
    const getResponse = fakeResponse();
    assert.equal(guardHttpMutation({ method: 'GET' }, getResponse, () => {}, env), false);
    assert.equal(guardHttpMutation({ method: 'HEAD' }, fakeResponse(), () => {}, env), false);
    const postResponse = fakeResponse();
    const reply = (res, status, payload) => { res.statusCode = status; res.payload = payload; };
    assert.equal(guardHttpMutation({ method: 'POST' }, postResponse, reply, env), true);
    assert.equal(postResponse.statusCode, 503);
    assert.deepEqual(postResponse.payload, { error: PUBLIC_MESSAGE, code: 'MAINTENANCE_READ_ONLY' });

    assert.throws(() => closeMaintenanceFence(env, { expectedDigest: opened.digest }), code('MAINTENANCE_APPLY_REQUIRED'));
    assert.throws(() => closeMaintenanceFence(env, { apply: true, expectedDigest: '0'.repeat(64) }), code('MAINTENANCE_EXPECTED_DIGEST_MISMATCH'));
    assert.equal(fs.existsSync(lockFile), true, 'a failed close must preserve the lock');
    const closed = closeMaintenanceFence(env, { apply: true, expectedDigest: opened.digest });
    assert.equal(closed.verified, false);
    assert.equal(closed.environmentEnabled, true);
    assert.equal(closed.enforced, true, 'the environment fence remains active after removing instance artifacts');
    assert.equal(fs.existsSync(lockFile), false);
    assert.equal(fs.existsSync(`${lockFile}.sha256`), false);
    assert.equal(inspectMaintenanceFence({ ...env, PDL_MAINTENANCE_MODE: '0' }).enforced, false);

    const tamperRoot = path.join(root, 'tamper');
    fs.mkdirSync(tamperRoot);
    const tamperEnv = { ...env, PDL_DB_FILE: path.join(tamperRoot, 'db.json'), PDL_MAINTENANCE_LOCK_FILE: path.join(tamperRoot, 'lock.json') };
    const tamper = openMaintenanceFence(tamperEnv, { apply: true });
    fs.appendFileSync(tamperEnv.PDL_MAINTENANCE_LOCK_FILE, 'x');
    const corrupt = inspectMaintenanceFence(tamperEnv);
    assert.equal(corrupt.enforced, true);
    assert.equal(corrupt.verified, false);
    assert.equal(corrupt.reason, 'MAINTENANCE_FENCE_CORRUPT');
    assert.throws(() => closeMaintenanceFence(tamperEnv, { apply: true, expectedDigest: tamper.digest }), code('MAINTENANCE_FENCE_CORRUPT'));

    const failClosedRoot = path.join(root, 'fail-closed');
    fs.mkdirSync(failClosedRoot);
    const failClosedEnv = { ...env, PDL_DB_FILE: path.join(failClosedRoot, 'db.json'), PDL_MAINTENANCE_LOCK_FILE: path.join(failClosedRoot, 'lock.json') };
    const failClosedFence = openMaintenanceFence(failClosedEnv, { apply: true });
    const originalUnlink = fs.unlinkSync;
    fs.unlinkSync = function failSidecarUnlink(target, ...args) {
      if (String(target) === `${failClosedEnv.PDL_MAINTENANCE_LOCK_FILE}.sha256`) throw new Error('synthetic close failure');
      return originalUnlink.call(this, target, ...args);
    };
    try {
      assert.throws(
        () => closeMaintenanceFence(failClosedEnv, { apply: true, expectedDigest: failClosedFence.digest }),
        /synthetic close failure/
      );
    } finally {
      fs.unlinkSync = originalUnlink;
    }
    const stranded = inspectMaintenanceFence(failClosedEnv);
    assert.equal(stranded.enforced, true, 'a partial close must fail closed');
    assert.equal(stranded.verified, false);
    originalUnlink(`${failClosedEnv.PDL_MAINTENANCE_LOCK_FILE}.sha256`);

    const productionRoot = path.join(root, 'production');
    fs.mkdirSync(productionRoot);
    const production = {
      NODE_ENV: 'production',
      PDL_DB_FILE: path.join(productionRoot, 'db.json'),
      PDL_MAINTENANCE_LOCK_FILE: path.join(productionRoot, 'lock.json'),
      PDL_MAINTENANCE_MODE: '1',
      RENDER: 'true',
      RENDER_SERVICE_TYPE: 'web',
      RENDER_SERVICE_ID: 'srv-dal9vt5bedkc73bpru30',
      RENDER_INSTANCE_ID: 'instance-abc',
      RENDER_GIT_COMMIT: 'a'.repeat(40),
      IS_PULL_REQUEST: 'false'
    };
    const expected = { apply: true, expectedServiceId: production.RENDER_SERVICE_ID, expectedInstanceId: production.RENDER_INSTANCE_ID };
    const productionOff = { ...production, PDL_MAINTENANCE_MODE: '0' };
    assert.doesNotThrow(() => assertWritesAllowed(productionOff), 'normal outgoing instance should be writable before the transition artifact exists');
    assert.throws(() => openMaintenanceFence(productionOff, expected), code('MAINTENANCE_ENVIRONMENT_FENCE_REQUIRED'));
    assert.throws(() => openMaintenanceFence(productionOff, { ...expected, apply: false, transition: true }), code('MAINTENANCE_APPLY_REQUIRED'));
    assert.throws(() => openMaintenanceFence(productionOff, { apply: true, transition: true }), code('MAINTENANCE_RUNTIME_IDENTITY_MISMATCH'));
    assert.throws(() => openMaintenanceFence(productionOff, { ...expected, transition: true }), code('MAINTENANCE_RUNTIME_IDENTITY_MISMATCH'));
    const transitionOptions = { ...expected, transition: true, expectedReleaseSha: production.RENDER_GIT_COMMIT };
    const stagedFence = openMaintenanceFence(productionOff, transitionOptions);
    assert.equal(stagedFence.verified, true);
    assert.equal(stagedFence.enforced, true);
    assert.equal(stagedFence.source, 'lock');
    assert.throws(() => assertWritesAllowed(productionOff), code('MAINTENANCE_READ_ONLY'));
    const stagedMismatch = inspectMaintenanceFence({ ...productionOff, RENDER_INSTANCE_ID: 'different-outgoing-instance' });
    assert.equal(stagedMismatch.enforced, true);
    assert.equal(stagedMismatch.verified, false);
    assert.equal(stagedMismatch.reason, 'MAINTENANCE_FENCE_IDENTITY_MISMATCH');
    assert.throws(() => assertWritesAllowed({ ...productionOff, RENDER_INSTANCE_ID: 'different-outgoing-instance' }), code('MAINTENANCE_READ_ONLY'));
    const stagedPost = fakeResponse();
    assert.equal(guardHttpMutation({ method: 'POST' }, stagedPost, reply, productionOff), true);
    assert.throws(
      () => closeMaintenanceFence(productionOff, { ...transitionOptions, expectedDigest: stagedFence.digest }),
      code('MAINTENANCE_CLOSE_REQUIRES_ENVIRONMENT_FENCE')
    );

    const replacementRoot = path.join(root, 'replacement-production');
    fs.mkdirSync(replacementRoot);
    const replacement = {
      ...production,
      RENDER_INSTANCE_ID: 'replacement-instance',
      PDL_DB_FILE: path.join(replacementRoot, 'db.json'),
      PDL_MAINTENANCE_LOCK_FILE: path.join(replacementRoot, 'lock.json')
    };
    const replacementExpected = {
      apply: true,
      expectedServiceId: replacement.RENDER_SERVICE_ID,
      expectedInstanceId: replacement.RENDER_INSTANCE_ID
    };
    const replacementBeforeLock = inspectMaintenanceFence(replacement);
    assert.equal(replacementBeforeLock.verified, false);
    assert.equal(replacementBeforeLock.enforced, true, 'the replacement environment must fail closed before its local artifact exists');
    assert.throws(() => assertWritesAllowed(replacement), code('MAINTENANCE_READ_ONLY'));
    const replacementFence = openMaintenanceFence(replacement, replacementExpected);
    assert.equal(replacementFence.verified, true);
    assert.equal(replacementFence.enforced, true);
    assert.equal(requireVerifiedFence(replacement, { ...replacementExpected, minimumAgeMs: 0 }).digest, replacementFence.digest, 'production reconciliation requires both the environment and exact local artifact');
    closeMaintenanceFence(replacement, { ...replacementExpected, expectedDigest: replacementFence.digest });

    const normalProductionRoot = path.join(root, 'normal-production');
    fs.mkdirSync(normalProductionRoot);
    const normalProduction = {
      ...production,
      PDL_DB_FILE: path.join(normalProductionRoot, 'db.json'),
      PDL_MAINTENANCE_LOCK_FILE: path.join(normalProductionRoot, 'lock.json')
    };
    assert.throws(() => openMaintenanceFence(normalProduction, { apply: true }), code('MAINTENANCE_RUNTIME_IDENTITY_MISMATCH'));
    const productionFence = openMaintenanceFence(normalProduction, expected);
    const required = requireVerifiedFence(normalProduction, { ...expected, minimumAgeMs: 0 });
    assert.equal(required.digest, productionFence.digest);
    assert.equal(required.identity.instanceId, production.RENDER_INSTANCE_ID);
    assert.throws(() => requireVerifiedFence({ ...normalProduction, RENDER_INSTANCE_ID: 'different-instance' }, { ...expected, minimumAgeMs: 0 }), code('MAINTENANCE_RUNTIME_IDENTITY_MISMATCH'));
    assert.throws(() => closeMaintenanceFence(normalProduction, {
      ...expected,
      expectedInstanceId: 'different-instance',
      expectedDigest: productionFence.digest
    }), code('MAINTENANCE_RUNTIME_IDENTITY_MISMATCH'));
    closeMaintenanceFence(normalProduction, { ...expected, expectedDigest: productionFence.digest });

    const corruptTransitionRoot = path.join(root, 'corrupt-transition');
    fs.mkdirSync(corruptTransitionRoot);
    const corruptTransitionEnv = {
      ...productionOff,
      PDL_DB_FILE: path.join(corruptTransitionRoot, 'db.json'),
      PDL_MAINTENANCE_LOCK_FILE: path.join(corruptTransitionRoot, 'lock.json')
    };
    const corruptTransition = openMaintenanceFence(corruptTransitionEnv, transitionOptions);
    fs.appendFileSync(corruptTransitionEnv.PDL_MAINTENANCE_LOCK_FILE, 'tampered');
    assert.equal(inspectMaintenanceFence(corruptTransitionEnv).enforced, true, 'a corrupt staged artifact must fail closed');
    assert.throws(() => assertWritesAllowed(corruptTransitionEnv), code('MAINTENANCE_READ_ONLY'));
    assert.throws(() => closeMaintenanceFence({ ...corruptTransitionEnv, PDL_MAINTENANCE_MODE: '1' }, { ...transitionOptions, expectedDigest: corruptTransition.digest }), code('MAINTENANCE_FENCE_CORRUPT'));

    assert.deepEqual(parseArgs(['close', '--apply', '--expected-digest', 'b'.repeat(64)]), {
      action: 'close', apply: true, transition: false, expectedDigest: 'b'.repeat(64), expectedServiceId: '', expectedInstanceId: '', expectedReleaseSha: '', lockFile: ''
    });
    assert.equal(parseArgs(['open', '--apply', '--transition', '--expected-service-id', production.RENDER_SERVICE_ID, '--expected-instance-id', production.RENDER_INSTANCE_ID, '--expected-release-sha', production.RENDER_GIT_COMMIT]).transition, true);
    assert.throws(() => parseArgs(['close', '--apply']), /requires --apply and --expected-digest/);

    // Integration: the server's pre-routing guard returns a specific 503,
    // while the persistence boundaries independently reject direct writes.
    const serverRoot = path.join(root, 'server');
    fs.mkdirSync(serverRoot);
    const dbFile = path.join(serverRoot, 'db.json');
    const platformFile = path.join(serverRoot, 'platform.json');
    const sessionToken = 'maintenance-session-token';
    const serverSnapshot = {
      company: { id: 'maintenance-test', name: 'Maintenance Test', features: {} },
      users: [{ id: 1, companyId: 'maintenance-test', name: 'Test User', email: 'test@example.invalid', role: 'owner', status: 'Active' }],
      sessions: [{ id: 'session-1', companyId: 'maintenance-test', userId: 1, tokenHash: crypto.createHash('sha256').update(sessionToken).digest('hex'), expiresAt: new Date(Date.now() + 3_600_000).toISOString() }]
    };
    fs.writeFileSync(dbFile, JSON.stringify(serverSnapshot));
    fs.writeFileSync(platformFile, JSON.stringify({ users: [], notes: [] }));
    process.env.NODE_ENV = 'test';
    process.env.PDL_SUPABASE_ENABLED = '0';
    process.env.PDL_DB_FILE = dbFile;
    process.env.PDL_PLATFORM_FILE = platformFile;
    process.env.PDL_MAINTENANCE_MODE = '1';
    process.env.PDL_MAINTENANCE_LOCK_FILE = path.join(serverRoot, 'lock.json');
    const integrated = openMaintenanceFence(process.env, { apply: true });
    const serverModule = require('../server');
    let directRepositoryRequests = 0;
    const directRepository = new PlatformRepository({
      request: async () => { directRepositoryRequests += 1; throw new Error('repository request must not run'); },
      assertWrite: () => assertWritesAllowed(process.env, { root: serverRoot })
    });
    await assert.rejects(() => directRepository.save({ users: [] }, { expectedRevision: 0 }), code('MAINTENANCE_READ_ONLY'));
    assert.equal(directRepositoryRequests, 0, 'a direct platform repository write reached Supabase while maintenance was active');
    assert.throws(() => serverModule.writeDb({ company: { id: 'maintenance-test', features: {} } }), code('MAINTENANCE_READ_ONLY'));
    await assert.rejects(() => serverModule.writePlatform({ users: [] }), code('MAINTENANCE_READ_ONLY'));
    await assert.rejects(() => serverModule.retryPendingPlatformAudits(), code('MAINTENANCE_READ_ONLY'));
    await assert.rejects(() => serverModule.retryPendingTenantDeletionCleanup(), code('MAINTENANCE_READ_ONLY'));
    await assert.rejects(() => serverModule.maybeSendWeeklyHealthDigest({ force: true, sendEmailFn: async () => {} }), code('MAINTENANCE_READ_ONLY'));
    const blockedBackupDirectory = path.join(serverRoot, 'blocked-backup-receipts');
    let blockedBackupCalls = 0;
    await assert.rejects(() => backupVerification.createAndRecordVerification(serverSnapshot, {
      directory: blockedBackupDirectory,
      createBackup: async () => { blockedBackupCalls += 1; },
      assertWrite: () => assertWritesAllowed(process.env, { root: serverRoot })
    }), code('MAINTENANCE_READ_ONLY'));
    assert.equal(blockedBackupCalls, 0, 'maintenance backup verification reached durable storage');
    assert.equal(fs.existsSync(blockedBackupDirectory), false, 'maintenance backup verification wrote a receipt');
    let destructiveStorageCalls = 0;
    await assert.rejects(() => serverModule.purgeExpiredTicketFiles({ projectTickets: [] }, new Date(), {
      root: serverRoot,
      storage: { remove: async () => { destructiveStorageCalls += 1; return true; } }
    }), code('MAINTENANCE_READ_ONLY'));
    assert.equal(destructiveStorageCalls, 0, 'a background cleanup reached storage while maintenance was active');
    const connectorToken = 'pdlm_existing-maintenance-token';
    const oauthFile = path.join(serverRoot, 'oauth.json');
    let oauthCloudLoads = 0;
    const oauth = createOAuth({
      file: oauthFile,
      loadCloud: async () => {
        oauthCloudLoads += 1;
        return {
          clients: [],
          codes: [],
          tickets: [],
          idempotency: [],
          tokens: [{
            accessHash: crypto.createHash('sha256').update(connectorToken).digest('hex'),
            refreshHash: 'unused',
            family: 'maintenance-family',
            clientId: 'existing-client',
            userId: 1,
            companyId: 'maintenance-test',
            role: 'owner',
            name: 'Test User',
            memberId: null,
            scopes: ['daily:read'],
            resource: 'https://app.prodailylink.com/mcp',
            accessExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
            refreshExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
            revoked: false
          }]
        };
      },
      saveCloud: async () => { throw new Error('read-only OAuth must not save'); },
      assertWrite: () => assertWritesAllowed(process.env, { root: serverRoot })
    });
    const connectorAuth = await oauth.authenticate(`Bearer ${connectorToken}`);
    assert.equal(connectorAuth?.companyId, 'maintenance-test', 'cloud-backed OAuth reads must remain available without hydrating the local cache');
    assert.equal((await oauth.authenticate(`Bearer ${connectorToken}`))?.userId, 1);
    assert.equal(oauthCloudLoads, 1);
    assert.equal(fs.existsSync(oauthFile), false, 'maintenance OAuth read unexpectedly wrote a local cache');
    await new Promise((resolve, reject) => serverModule.server.listen(0, '127.0.0.1', error => error ? reject(error) : resolve()));
    const port = serverModule.server.address().port;
    const blocked = await request(port, 'POST', '/api/auth/company');
    assert.equal(blocked.status, 503);
    assert.equal(blocked.body.code, 'MAINTENANCE_READ_ONLY');
    const live = await request(port, 'GET', '/api/health/live');
    assert.equal(live.status, 200);
    assert.equal(live.body.kind, 'liveness');
    const beforeRead = fs.readFileSync(dbFile);
    const me = await request(port, 'GET', '/api/auth/me', {
      Cookie: `pdl_company=maintenance-test; pdl_session=${sessionToken}`
    });
    assert.equal(me.status, 200, 'state-mutating auth GET must degrade to a read during maintenance');
    const state = await request(port, 'GET', '/api/state', {
      Cookie: `pdl_company=maintenance-test; pdl_session=${sessionToken}`
    });
    assert.equal(state.status, 200, 'the primary workspace read must stay available during maintenance');
    assert.equal(fs.readFileSync(dbFile).equals(beforeRead), true, 'a GET during maintenance changed tenant persistence');
    await new Promise(resolve => serverModule.server.close(resolve));
    closeMaintenanceFence(process.env, { apply: true, expectedDigest: integrated.digest });

    // Rolling replacement proof: production maintenance mode without a local
    // artifact must boot far enough for an operator to reach liveness and SSH,
    // while all writes fail closed until the replacement artifact is opened.
    const startupRoot = path.join(root, 'replacement-startup');
    fs.mkdirSync(startupRoot);
    const startupDb = path.join(startupRoot, 'db.json');
    const startupPlatform = path.join(startupRoot, 'platform.json');
    const startupLock = path.join(startupRoot, 'lock.json');
    const startupSession = 'replacement-startup-session';
    fs.writeFileSync(startupDb, JSON.stringify({
      company: { id: 'replacement-startup', name: 'Replacement Startup', features: {} },
      users: [{ id: 1, companyId: 'replacement-startup', name: 'Read Only User', email: 'readonly@example.invalid', role: 'owner', status: 'Active' }],
      sessions: [{ id: 'startup-session', companyId: 'replacement-startup', userId: 1, tokenHash: crypto.createHash('sha256').update(startupSession).digest('hex'), expiresAt: new Date(Date.now() + 3_600_000).toISOString() }]
    }));
    fs.writeFileSync(startupPlatform, JSON.stringify({ users: [{ id: 'existing-platform-owner' }], notes: [] }));
    const startupPort = await reservePort();
    const child = spawn(process.execPath, ['server.js'], {
      cwd: path.resolve(__dirname, '..'),
      env: {
        ...process.env,
        NODE_ENV: 'production',
        PORT: String(startupPort),
        PDL_DB_FILE: startupDb,
        PDL_PLATFORM_FILE: startupPlatform,
        PDL_MAINTENANCE_LOCK_FILE: startupLock,
        PDL_MAINTENANCE_MODE: '1',
        PDL_SUPABASE_ENABLED: '0',
        PDL_TRANSACTIONAL_DB: 'off',
        PDL_PLATFORM_TRANSACTIONAL_DB: 'off',
        PDL_REQUIRE_AUTH: '1',
        RENDER: 'true',
        RENDER_SERVICE_TYPE: 'web',
        RENDER_SERVICE_ID: production.RENDER_SERVICE_ID,
        RENDER_INSTANCE_ID: 'replacement-startup-instance',
        RENDER_GIT_COMMIT: 'c'.repeat(40),
        IS_PULL_REQUEST: 'false',
        SUPABASE_URL: '',
        SUPABASE_SECRET_KEY: '',
        RESEND_API_KEY: '',
        STRIPE_SECRET_KEY: '',
        SENTRY_DSN: ''
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    try {
      await waitForOutput(child, `Pro Daily Link running at http://localhost:${startupPort}`);
      const startupLive = await request(startupPort, 'GET', '/api/health/live');
      assert.equal(startupLive.status, 200, 'replacement did not expose liveness before its local artifact was opened');
      const startupState = await request(startupPort, 'GET', '/api/state', {
        Cookie: `pdl_company=replacement-startup; pdl_session=${startupSession}`
      });
      assert.equal(startupState.status, 200, 'replacement did not serve authenticated read-only state before its local artifact was opened');
      const startupWrite = await request(startupPort, 'POST', '/api/auth/company');
      assert.equal(startupWrite.status, 503);
      assert.equal(startupWrite.body.code, 'MAINTENANCE_READ_ONLY');
      assert.equal(fs.existsSync(startupLock), false, 'startup unexpectedly created an instance maintenance artifact');
    } finally {
      await stopChild(child);
    }

    // Production uses a nonempty primary platform repository. Prove that its
    // read-only initialization loads that authority without attempting a
    // bootstrap save, still binds, and remains write-blocked before a local
    // replacement artifact exists.
    const primaryPort = await reservePort();
    const primaryScript = `
      const supabase = require('./database/supabase');
      const { splitPlatformSnapshot, canonicalHash } = require('./database/platform-repository');
      supabase.loadLocalEnv = () => {};
      const snapshot = { users: [{ id: 'existing-platform-owner', role: 'platform_owner', status: 'Active' }], notes: [] };
      const split = splitPlatformSnapshot(snapshot);
      supabase.request = async pathname => {
        if (pathname !== '/rest/v1/rpc/load_platform_repository') throw new Error('maintenance startup attempted a platform mutation');
        return { json: async () => ({ revision: 7, scalarData: split.scalarData, records: split.records, contentHash: canonicalHash(snapshot), updatedAt: '2026-10-20T00:00:00.000Z', updatedBy: 'cutover-test' }) };
      };
      const app = require('./server');
      app.initializePlatformPersistence().then(() => app.server.listen(Number(process.env.PORT), '127.0.0.1', () => console.log('PRIMARY_READY:' + process.env.PORT))).catch(error => { console.error(error); process.exit(2); });
      process.on('SIGTERM', () => app.server.close(() => process.exit(0)));
    `;
    const primaryChild = spawn(process.execPath, ['-e', primaryScript], {
      cwd: path.resolve(__dirname, '..'),
      env: {
        ...process.env,
        NODE_ENV: 'production',
        PORT: String(primaryPort),
        PDL_DB_FILE: startupDb,
        PDL_PLATFORM_FILE: startupPlatform,
        PDL_MAINTENANCE_LOCK_FILE: path.join(startupRoot, 'primary-lock.json'),
        PDL_MAINTENANCE_MODE: '1',
        PDL_SUPABASE_ENABLED: '1',
        PDL_TRANSACTIONAL_DB: 'off',
        PDL_PLATFORM_TRANSACTIONAL_DB: 'primary',
        PDL_REQUIRE_AUTH: '1',
        RENDER: 'true',
        RENDER_SERVICE_TYPE: 'web',
        RENDER_SERVICE_ID: production.RENDER_SERVICE_ID,
        RENDER_INSTANCE_ID: 'replacement-primary-instance',
        RENDER_GIT_COMMIT: 'd'.repeat(40),
        IS_PULL_REQUEST: 'false',
        SUPABASE_URL: 'https://maintenance-startup.invalid',
        SUPABASE_SECRET_KEY: 'synthetic-maintenance-startup-key',
        RESEND_API_KEY: '',
        STRIPE_SECRET_KEY: '',
        SENTRY_DSN: ''
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    try {
      await waitForOutput(primaryChild, `PRIMARY_READY:${primaryPort}`);
      assert.equal((await request(primaryPort, 'GET', '/api/health/live')).status, 200);
      const primaryWrite = await request(primaryPort, 'POST', '/api/auth/company');
      assert.equal(primaryWrite.status, 503);
      assert.equal(primaryWrite.body.code, 'MAINTENANCE_READ_ONLY');
    } finally {
      await stopChild(primaryChild);
    }

    console.log('Maintenance fence integrity, identity, HTTP, persistence, no-overwrite, and safe-close tests passed.');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
