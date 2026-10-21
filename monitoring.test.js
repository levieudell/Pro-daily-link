'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const {
  createMonitoring,
  hostedSentryHost,
  installShutdownFlush,
  monitoringOptions,
  safeError,
  sanitizeRoute,
  scrubEvent,
  validDsn
} = require('./monitoring');
const { main: verifyMonitoring } = require('./scripts/verify-monitoring');

const DSN_KEY = 'a'.repeat(32);
const DSN_HOST = 'o123.ingest.us.sentry.io';
const DSN = `https://${DSN_KEY}@${DSN_HOST}/12345`;

function fakeSdk({ deliver = true, initError = null } = {}) {
  const calls = { captures: [], flushes: [], init: [], integrations: [], scopes: [] };
  let client = null;
  let currentScope = null;
  const sdk = {
    init(options) {
      if (initError) throw initError;
      calls.init.push(options);
      calls.integrations = options.integrations([
        { name: 'InboundFilters' },
        { name: 'FunctionToString' },
        { name: 'LinkedErrors' },
        { name: 'Console' },
        { name: 'ContextLines' },
        { name: 'Http' },
        { name: 'LocalVariablesAsync' },
        { name: 'NodeFetch' },
        { name: 'RequestData' },
        { name: 'NodeSystemError' },
        { name: 'ConversationId' },
        { name: 'Context' },
        { name: 'ChildProcess' },
        { name: 'ProcessSession' },
        { name: 'Modules' },
        { name: 'OnUncaughtException' },
        { name: 'OnUnhandledRejection' }
      ]);
      client = { getDsn: () => ({ protocol: 'https', host: DSN_HOST, publicKey: DSN_KEY, projectId: '12345', pass: '', port: '', path: '' }) };
      return client;
    },
    getClient: () => client,
    withScope(run) {
      const tags = {};
      const scope = {
        level: null,
        setLevel(level) { this.level = level; },
        setTag(key, value) { tags[key] = value; }
      };
      currentScope = { scope, tags };
      calls.scopes.push(currentScope);
      try { return run(scope); } finally { currentScope = null; }
    },
    captureException(error) {
      calls.captures.push({ error, scope: currentScope });
      return `event-${calls.captures.length}`;
    },
    async flush(timeout) {
      calls.flushes.push(timeout);
      return deliver;
    }
  };
  return { calls, sdk };
}

(async () => {
  assert.equal(validDsn(''), false);
  assert.equal(validDsn('not-a-dsn'), false);
  assert.equal(validDsn(`ftp://${DSN_KEY}@${DSN_HOST}/1`), false);
  assert.equal(validDsn(`http://${DSN_KEY}@${DSN_HOST}/1`), false);
  assert.equal(validDsn('https://example.invalid/1'), false);
  assert.equal(validDsn(`https://${DSN_KEY}@example.invalid/1`), false);
  assert.equal(validDsn(`https://short@${DSN_HOST}/1`), false);
  assert.equal(validDsn(`https://${DSN_KEY}@${DSN_HOST}/not-a-project`), false);
  assert.equal(validDsn(`https://${DSN_KEY}:password@${DSN_HOST}/1`), false);
  assert.equal(validDsn(`https://${DSN_KEY}@${DSN_HOST}/prefix/1`), false);
  assert.equal(validDsn(`https://${DSN_KEY}@${DSN_HOST}/1/`), false);
  assert.equal(validDsn(`https://${DSN_KEY}@${DSN_HOST}/1?secret=value`), false);
  assert.equal(validDsn(`https://${DSN_KEY}@${DSN_HOST}/1#secret`), false);
  assert.equal(validDsn(DSN), true);
  assert.equal(hostedSentryHost('sentry.io'), true);
  assert.equal(hostedSentryHost(DSN_HOST.toUpperCase()), true);
  assert.equal(hostedSentryHost('sentry.io.example.invalid'), false);
  assert.equal(hostedSentryHost('example.invalid'), false);

  const guestToken = 'a'.repeat(48);
  const supportToken = 'A_token-value-that-must-never-leave-the-app_123456';
  const companyUuid = '7176abe8-07e4-4336-a372-1163d2f21ff9';
  const routeCases = [
    [`/api/guest/${guestToken}/ticket-scan?c=tenant-secret`, '/api/guest/:token/ticket-scan'],
    [`/guest/${guestToken}?c=tenant-secret`, '/guest/:token'],
    [`/api/change-order/${supportToken}/decision?name=Customer`, '/api/change-order/:token/decision'],
    [`/api/support-session/${supportToken}?email=person@example.com`, '/api/support-session/:token'],
    ['/api/blog/how-to-track-concrete', '/api/blog/:slug'],
    ['/api/files/project-photos/tenant/private/person%40example.com/short.jpg', '/api/files/:bucket/:objectKey'],
    ['/api/local-files/project-tickets/short.pdf', '/api/local-files/:objectKey'],
    ['/uploads/short.jpg', '/uploads/:objectKey'],
    [`/api/platform/companies/${companyUuid}/features`, '/api/platform/companies/:companyId/features'],
    [`/api/platform/companies/${companyUuid}/owner-reset`, '/api/platform/companies/:companyId/owner-reset'],
    [`/api/platform/companies/${companyUuid}/archive`, '/api/platform/companies/:companyId/archive'],
    [`/api/platform/companies/${companyUuid}/unarchive`, '/api/platform/companies/:companyId/unarchive'],
    [`/api/platform/companies/${companyUuid}/demo-reset`, '/api/platform/companies/:companyId/demo-reset'],
    [`/api/platform/companies/${companyUuid}/subscription`, '/api/platform/companies/:companyId/subscription'],
    [`/api/platform/companies/${companyUuid}/sales-demo`, '/api/platform/companies/:companyId/sales-demo'],
    ['/api/platform/demo-requests/42', '/api/platform/demo-requests/:id'],
    ['/api/platform/onboarding/42', '/api/platform/onboarding/:id'],
    ['/api/platform/tickets/42', '/api/platform/tickets/:id'],
    ['/api/platform/follow-ups/42', '/api/platform/follow-ups/:id'],
    ['/api/platform/blog/private-draft', '/api/platform/blog/:id'],
    ['/api/platform/help/42', '/api/platform/help/:id'],
    ['/api/platform/support-access/42', '/api/platform/support-access/:id'],
    ['/api/daily-templates/safety-walk', '/api/daily-templates/:templateId'],
    ['/api/pay-periods/42/summary', '/api/pay-periods/:id/summary'],
    ['/api/pay-periods/42/exports', '/api/pay-periods/:id/exports'],
    ['/api/pay-periods/42/exports/77.csv', '/api/pay-periods/:id/exports/:exportId.csv'],
    ['/api/reporting-exports/77.csv', '/api/reporting-exports/:exportId.csv'],
    ['/api/time-off-requests/42/decision', '/api/time-off-requests/:id/decision'],
    ['/api/time-cards/42/approve', '/api/time-cards/:id/:action'],
    ['/api/workdays/42/end', '/api/workdays/:id/end'],
    ['/api/users/42/preferences', '/api/users/:id/preferences'],
    ['/api/crews/42', '/api/crews/:id'],
    ['/api/assignments/42/acknowledge', '/api/assignments/:id/acknowledge'],
    ['/api/reports/42/extra-work', '/api/reports/:id/extra-work'],
    ['/api/changes/42/submit', '/api/changes/:id/submit'],
    ['/api/projects/42/template', '/api/projects/:id/template'],
    ['/api/projects/42/tm-summary', '/api/projects/:id/tm-summary'],
    ['/api/projects/42/estimate-proposals/9/approve', '/api/projects/:id/estimate-proposals/:proposalId/approve'],
    ['/api/projects/42/tasks', '/api/projects/:id/tasks'],
    ['/api/projects/42/events', '/api/projects/:id/events'],
    ['/api/projects/42/messages/read', '/api/projects/:id/messages/read'],
    ['/api/projects/42/plans', '/api/projects/:id/plans'],
    ['/api/projects/42/archive', '/api/projects/:id/archive'],
    ['/api/projects/42/estimate-items/9', '/api/projects/:id/estimate-items/:itemId'],
    ['/api/projects/42/rate-settings', '/api/projects/:id/rate-settings'],
    ['/api/projects/42/assistant/chat', '/api/projects/:id/assistant/chat'],
    ['https://app.prodailylink.com/api/projects/42?search=private', '/api/projects/:id'],
    ['/api/project-tickets/42', '/api/project-tickets/:id'],
    ['/api/project-tasks/42/assign', '/api/project-tasks/:id/assign'],
    ['/api/project-events/42', '/api/project-events/:id'],
    ['/api/catalog/42/apply', '/api/catalog/:id/apply'],
    ['/api/estimate-imports/42/draft', '/api/estimate-imports/:id/draft'],
    ['/api/subcontractors/42/compliance-reminder', '/api/subcontractors/:id/compliance-reminder'],
    ['/api/subcontractor-links/42', '/api/subcontractor-links/:id'],
    ['/api/health?company=private', '/api/health'],
    ['/api/private/person%40example.com/42', '/api/:unmatched'],
    ['/reset-password.html?token=reset-secret&tenant=tenant-secret', '/:unmatched'],
    ['/customers/acme-private', '/:unmatched'],
    ['/api/bad%ZZroute/private', '/api/:unmatched']
  ];
  for (const [route, expected] of routeCases) assert.equal(sanitizeRoute(route), expected, route);

  const original = new Error(`Private field note from person@example.com with token ${supportToken}`);
  original.name = 'TypeError';
  original.stack = `TypeError: Private field note\n    at save (${__filename}:10:2)\n    at token (${guestToken}:1:1)`;
  const protectedError = safeError(original);
  assert.equal(protectedError.name, 'TypeError');
  assert.equal(protectedError.message, 'Pro Daily Link request failed');
  assert.ok(!protectedError.stack.includes('Private field note'));
  assert.ok(!protectedError.stack.includes(guestToken));

  const scrubbed = scrubEvent({
    message: `Customer note ${supportToken}`,
    transaction: `/api/guest/${guestToken}?c=tenant-secret`,
    request: { data: { password: 'private-password' }, headers: { cookie: 'session-secret' }, query_string: 'token=reset-secret' },
    user: { email: 'person@example.com' },
    breadcrumbs: [{ message: 'private-password' }],
    culprit: 'person@example.com',
    contexts: { private: { notes: 'Customer note' } },
    debug_meta: { images: [{ code_file: 'Customer note' }] },
    extra: { database: { fieldNote: 'Customer note' } },
    fingerprint: ['private-password'],
    logger: 'private-password',
    modules: { 'private-module': 'Customer note' },
    sdkProcessingMetadata: { normalizedRequest: { url: `/guest/${guestToken}` } },
    server_name: 'person@example.com',
    tags: {
      route: `/api/change-order/${supportToken}/decision?name=Customer`,
      method: 'post<script>',
      request_id: 'safe-request-id',
      rogue: 'private-password'
    },
    spans: [{ op: 'http.server', description: `/api/support-session/${supportToken}`, data: { body: 'Customer note' } }],
    exception: {
      values: [{
        type: 'TypeError',
        module: 'private-module',
        value: 'Customer note',
        mechanism: { type: 'generic', handled: true, data: { password: 'private-password' } },
        stacktrace: { frames: [{ filename: `server-${guestToken}.js`, vars: { input: 'Customer note' }, pre_context: ['secret'], context_line: 'secret', post_context: ['secret'] }] }
      }]
    },
    threads: { values: [{ stacktrace: { frames: [{ filename: 'worker.js', vars: { note: 'Customer note' }, context_line: 'secret' }] } }] }
  });
  const serialized = JSON.stringify(scrubbed);
  for (const secret of [supportToken, guestToken, 'private-password', 'person@example.com', 'Customer note', 'session-secret', 'reset-secret', 'tenant-secret']) {
    assert.ok(!serialized.includes(secret), `monitoring payload leaked ${secret}`);
  }
  assert.equal(scrubbed.transaction, '/api/guest/:token');
  assert.equal(scrubbed.tags.route, '/api/change-order/:token/decision');
  assert.equal(scrubbed.tags.method, 'POSTSCRIPT');
  assert.equal(scrubbed.tags.rogue, undefined);
  assert.equal(scrubbed.request, undefined);
  assert.equal(scrubbed.culprit, undefined);
  assert.equal(scrubbed.debug_meta, undefined);
  assert.equal(scrubbed.logger, undefined);
  assert.equal(scrubbed.modules, undefined);
  assert.equal(scrubbed.server_name, undefined);
  assert.equal(scrubbed.exception.values[0].value, 'Pro Daily Link request failed');
  assert.equal(scrubbed.exception.values[0].module, undefined);
  assert.equal(scrubbed.exception.values[0].stacktrace.frames[0].vars, undefined);
  assert.equal(scrubbed.exception.values[0].mechanism.data, undefined);
  assert.equal(scrubbed.threads.values[0].stacktrace.frames[0].vars, undefined);
  assert.equal(scrubbed.sdkProcessingMetadata, undefined);
  assert.equal(scrubbed.spans[0].data, undefined);

  const options = monitoringOptions({
    SENTRY_DSN: DSN,
    NODE_ENV: 'production',
    RENDER_GIT_COMMIT: 'a'.repeat(40)
  });
  assert.equal(options.sendDefaultPii, false);
  assert.equal(options.tracesSampleRate, 0);
  assert.equal(options.dataCollection.userInfo, false);
  assert.equal(options.dataCollection.cookies, false);
  assert.equal(options.dataCollection.httpHeaders, false);
  assert.deepEqual(options.dataCollection.httpBodies, []);
  assert.equal(options.dataCollection.urlQueryParams, false);
  assert.equal(options.dataCollection.stackFrameVariables, false);
  assert.equal(options.dataCollection.genAI.inputs, false);
  assert.equal(options.dataCollection.genAI.outputs, false);

  const emptyFake = fakeSdk();
  const disabled = createMonitoring(emptyFake.sdk);
  assert.equal(disabled.init({}), false);
  assert.equal(disabled.init({ SENTRY_DSN: 'invalid' }), false);
  assert.equal(disabled.active(), false);
  assert.equal(disabled.captureRequestException(new Error('secret')), null);
  assert.equal(emptyFake.calls.init.length, 0);

  const failedFake = fakeSdk({ initError: new Error('synthetic init failure') });
  const originalConsoleError = console.error;
  const initErrors = [];
  console.error = message => initErrors.push(message);
  try {
    assert.equal(createMonitoring(failedFake.sdk).init({ SENTRY_DSN: DSN }), false);
  } finally {
    console.error = originalConsoleError;
  }
  assert.deepEqual(initErrors, ['Error monitoring initialization failed. No monitoring event was queued.']);

  const activeFake = fakeSdk();
  const active = createMonitoring(activeFake.sdk);
  assert.equal(active.init({ SENTRY_DSN: DSN, NODE_ENV: 'production' }), true);
  assert.equal(active.active(), true);
  assert.deepEqual(activeFake.calls.integrations.map(item => item.name), [
    'InboundFilters',
    'OnUncaughtException',
    'OnUnhandledRejection'
  ]);
  const requestEvent = active.captureRequestException(original, {
    requestId: 'request-123',
    method: 'post',
    route: `/api/guest/${guestToken}/ticket-scan?c=tenant-secret`
  });
  assert.equal(requestEvent, 'event-1');
  assert.equal(activeFake.calls.captures[0].scope.scope.level, 'error');
  assert.deepEqual(activeFake.calls.captures[0].scope.tags, {
    request_id: 'request-123',
    method: 'POST',
    route: '/api/guest/:token/ticket-scan',
    error_name: 'TypeError'
  });
  assert.ok(!activeFake.calls.captures[0].error.stack.includes('Private field note'));
  assert.equal(active.captureVerification(), 'event-2');
  assert.equal(activeFake.calls.captures[1].scope.tags.monitoring_verification, 'true');
  assert.equal(await active.flush(4321), true);
  assert.deepEqual(activeFake.calls.flushes, [4321]);

  const verifyFake = fakeSdk();
  const verify = createMonitoring(verifyFake.sdk);
  const output = [];
  assert.equal(await verifyMonitoring({ env: { SENTRY_DSN: DSN }, monitor: verify, log: line => output.push(line) }), 'event-1');
  assert.match(output[0], /^Controlled monitoring verification event queued and flushed: event-1$/);
  await assert.rejects(
    verifyMonitoring({ env: {}, monitor: createMonitoring(fakeSdk().sdk), log: () => {} }),
    /missing or invalid/
  );
  const unflushedFake = fakeSdk({ deliver: false });
  await assert.rejects(
    verifyMonitoring({ env: { SENTRY_DSN: DSN }, monitor: createMonitoring(unflushedFake.sdk), log: () => {} }),
    /did not flush the queued verification event/
  );

  const inactiveClientFake = fakeSdk();
  inactiveClientFake.sdk.init = options => {
    inactiveClientFake.calls.init.push(options);
    return { getDsn: () => ({ host: 'example.invalid', publicKey: DSN_KEY, projectId: '12345' }) };
  };
  const inactiveClient = createMonitoring(inactiveClientFake.sdk);
  assert.equal(inactiveClient.init({ SENTRY_DSN: DSN }), false);
  assert.equal(inactiveClient.active(), false);

  class FakeProcess extends EventEmitter {
    constructor() {
      super();
      this.exits = [];
    }
    exit(code) { this.exits.push(code); }
  }

  const shutdownProcess = new FakeProcess();
  const shutdownCalls = { close: 0, flush: [] };
  const shutdownOrder = [];
  shutdownProcess.exit = code => {
    shutdownProcess.exits.push(code);
    shutdownOrder.push('exit');
  };
  const removeShutdownHandlers = installShutdownFlush({
    close(done) {
      shutdownCalls.close += 1;
      shutdownOrder.push('close:start');
      setTimeout(() => {
        shutdownOrder.push('close:done');
        done();
      }, 5);
    }
  }, {
    monitor: {
      async flush(timeout) {
        shutdownCalls.flush.push(timeout);
        shutdownOrder.push('flush');
        return true;
      }
    },
    processRef: shutdownProcess,
    timeout: 100
  });
  shutdownProcess.emit('SIGTERM');
  shutdownProcess.emit('SIGINT');
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(shutdownCalls.close, 1);
  assert.equal(shutdownCalls.flush.length, 1);
  assert.ok(shutdownCalls.flush[0] > 0 && shutdownCalls.flush[0] < 100);
  assert.deepEqual(shutdownOrder, ['close:start', 'close:done', 'flush', 'exit']);
  assert.deepEqual(shutdownProcess.exits, [0]);
  removeShutdownHandlers();
  assert.equal(shutdownProcess.listenerCount('SIGTERM'), 0);
  assert.equal(shutdownProcess.listenerCount('SIGINT'), 0);

  const timeoutProcess = new FakeProcess();
  let timeoutCloseCalls = 0;
  let timeoutFlushCalls = 0;
  installShutdownFlush({ close() { timeoutCloseCalls += 1; } }, {
    monitor: { flush: () => { timeoutFlushCalls += 1; return true; } },
    processRef: timeoutProcess,
    timeout: 30
  });
  timeoutProcess.emit('SIGINT');
  await new Promise(resolve => setTimeout(resolve, 70));
  assert.equal(timeoutCloseCalls, 1);
  assert.equal(timeoutFlushCalls, 0);
  assert.deepEqual(timeoutProcess.exits, [0]);

  const flushTimeoutProcess = new FakeProcess();
  let flushTimeoutCalls = 0;
  installShutdownFlush({ close(done) { done(); } }, {
    monitor: { flush: () => { flushTimeoutCalls += 1; return new Promise(() => {}); } },
    processRef: flushTimeoutProcess,
    timeout: 30
  });
  flushTimeoutProcess.emit('SIGTERM');
  await new Promise(resolve => setTimeout(resolve, 70));
  assert.equal(flushTimeoutCalls, 1);
  assert.deepEqual(flushTimeoutProcess.exits, [0]);

  const serverSource = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  assert.match(
    serverSource,
    /monitoring:\{configured:runtimeProviders\.monitoring,verified:providerVerification\.checks\.monitoring===true\}/
  );
  assert.match(serverSource, /providerReadiness\.runtimeConfiguration\(process\.env,monitoring\.active\(\)\)/);
  assert.match(serverSource, /providerReadiness\.publicStatus\(/);
  assert.match(serverSource, /monitoring\.captureRequestException\(error,/);
  assert.match(serverSource, /monitoring\.installShutdownFlush\(server\)/);
  assert.doesNotMatch(serverSource, /monitoring:Boolean\(process\.env\.SENTRY_DSN\)/);
  assert.doesNotMatch(serverSource, /Sentry\.captureException/);

  console.log('Privacy-safe production monitoring regression tests passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
