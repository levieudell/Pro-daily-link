'use strict';

const Sentry = require('@sentry/node');

const ALLOWED_DEFAULT_INTEGRATIONS = new Set([
  'InboundFilters',
  'OnUncaughtException',
  'OnUnhandledRejection'
]);
const SAFE_TAGS = new Set([
  'error_code',
  'error_name',
  'method',
  'monitoring_verification',
  'request_id',
  'route'
]);
const SAFE_STATIC_ROUTES = new Set([
  '/',
  '/app',
  '/api/account-access',
  '/api/action-center',
  '/api/ai/extract',
  '/api/ai/transcribe',
  '/api/assignments',
  '/api/assistant/context',
  '/api/assistant/interpret',
  '/api/audit-log',
  '/api/auth/claim',
  '/api/auth/company',
  '/api/auth/email-verification/confirm',
  '/api/auth/email-verification/resend',
  '/api/auth/forgot',
  '/api/auth/login',
  '/api/auth/logout',
  '/api/auth/me',
  '/api/auth/reset',
  '/api/billing',
  '/api/billing/checkout',
  '/api/billing/confirm',
  '/api/billing/portal',
  '/api/billing/webhook',
  '/api/blog',
  '/api/catalog',
  '/api/changes',
  '/api/changes/from-field',
  '/api/changes/mine',
  '/api/company',
  '/api/company-activities',
  '/api/company/contract-value-tracking',
  '/api/company/deletion-request',
  '/api/company/export',
  '/api/company/logo',
  '/api/config',
  '/api/crews',
  '/api/daily-templates',
  '/api/daily-templates/default',
  '/api/daily-templates/generate',
  '/api/demo-requests',
  '/api/estimate-imports',
  '/api/estimate-imports/analyze',
  '/api/exceptions',
  '/api/founder-offer',
  '/api/health',
  '/api/help',
  '/api/insights',
  '/api/pay-periods',
  '/api/photos',
  '/api/platform/ai-usage',
  '/api/platform/audit',
  '/api/platform/auth/bootstrap',
  '/api/platform/auth/claim',
  '/api/platform/auth/forgot',
  '/api/platform/auth/login',
  '/api/platform/auth/logout',
  '/api/platform/auth/me',
  '/api/platform/auth/reset',
  '/api/platform/blog',
  '/api/platform/demo-requests',
  '/api/platform/follow-ups',
  '/api/platform/help',
  '/api/platform/onboarding',
  '/api/platform/overview',
  '/api/platform/revenue',
  '/api/platform/support-access',
  '/api/platform/tickets',
  '/api/platform/users',
  '/api/production',
  '/api/public/stats',
  '/api/report-labor-suggestions',
  '/api/reporting-exports',
  '/api/reports',
  '/api/schedule-availability',
  '/api/schedule/mark-off',
  '/api/schedule/repeat-week',
  '/api/schedule/today',
  '/api/signup',
  '/api/state',
  '/api/subcontractors',
  '/api/team-with-account',
  '/api/time-cards',
  '/api/time-cards.csv',
  '/api/time-cards/approve',
  '/api/time-cards/company-clock',
  '/api/time-off-requests',
  '/api/users',
  '/api/weather',
  '/api/workdays/start'
]);
const ROUTE_TEMPLATES = [
  [/^\/api\/guest\/[^/]+\/ticket-scan$/, '/api/guest/:token/ticket-scan'],
  [/^\/api\/guest\/[^/]+$/, '/api/guest/:token'],
  [/^\/guest\/[^/]+$/, '/guest/:token'],
  [/^\/api\/change-order\/[^/]+\/decision$/, '/api/change-order/:token/decision'],
  [/^\/api\/change-order\/[^/]+$/, '/api/change-order/:token'],
  [/^\/api\/support-session\/[^/]+$/, '/api/support-session/:token'],
  [/^\/api\/blog\/[^/]+$/, '/api/blog/:slug'],
  [/^\/api\/files\/[^/]+\/.+$/, '/api/files/:bucket/:objectKey'],
  [/^\/api\/local-files\/.+$/, '/api/local-files/:objectKey'],
  [/^\/uploads\/.+$/, '/uploads/:objectKey'],
  [/^\/api\/platform\/companies\/[^/]+\/(features|owner-reset|archive|unarchive|demo-reset|subscription|sales-demo)$/, match => `/api/platform/companies/:companyId/${match[1]}`],
  [/^\/api\/platform\/companies\/[^/]+$/, '/api/platform/companies/:companyId'],
  [/^\/api\/platform\/(demo-requests|onboarding|tickets|follow-ups|blog|help|support-access)\/[^/]+$/, match => `/api/platform/${match[1]}/:id`],
  [/^\/api\/daily-templates\/[^/]+$/, '/api/daily-templates/:templateId'],
  [/^\/api\/pay-periods\/[^/]+\/exports\/[^/]+\.csv$/, '/api/pay-periods/:id/exports/:exportId.csv'],
  [/^\/api\/pay-periods\/[^/]+\/(summary|exports)$/, match => `/api/pay-periods/:id/${match[1]}`],
  [/^\/api\/pay-periods\/[^/]+$/, '/api/pay-periods/:id'],
  [/^\/api\/reporting-exports\/[^/]+\.csv$/, '/api/reporting-exports/:exportId.csv'],
  [/^\/api\/time-off-requests\/[^/]+\/decision$/, '/api/time-off-requests/:id/decision'],
  [/^\/api\/time-off-requests\/[^/]+$/, '/api/time-off-requests/:id'],
  [/^\/api\/time-cards\/[^/]+\/[^/]+$/, '/api/time-cards/:id/:action'],
  [/^\/api\/time-cards\/[^/]+$/, '/api/time-cards/:id'],
  [/^\/api\/workdays\/[^/]+\/end$/, '/api/workdays/:id/end'],
  [/^\/api\/workdays\/[^/]+$/, '/api/workdays/:id'],
  [/^\/api\/users\/[^/]+\/(reset-code|time-access|preferences)$/, match => `/api/users/:id/${match[1]}`],
  [/^\/api\/users\/[^/]+$/, '/api/users/:id'],
  [/^\/api\/crews\/[^/]+$/, '/api/crews/:id'],
  [/^\/api\/assignments\/[^/]+\/(acknowledge|adopt-actual-times)$/, match => `/api/assignments/:id/${match[1]}`],
  [/^\/api\/assignments\/[^/]+$/, '/api/assignments/:id'],
  [/^\/api\/reports\/[^/]+\/(approve|disposition|safety|extra-work|rate|reviewed)$/, match => `/api/reports/:id/${match[1]}`],
  [/^\/api\/reports\/[^/]+$/, '/api/reports/:id'],
  [/^\/api\/changes\/[^/]+\/submit$/, '/api/changes/:id/submit'],
  [/^\/api\/changes\/[^/]+$/, '/api/changes/:id'],
  [/^\/api\/projects\/[^/]+\/estimate-proposals\/[^/]+\/approve$/, '/api/projects/:id/estimate-proposals/:proposalId/approve'],
  [/^\/api\/projects\/[^/]+\/estimate-items\/[^/]+$/, '/api/projects/:id/estimate-items/:itemId'],
  [/^\/api\/projects\/[^/]+\/(template|tm-summary|estimate-proposals|tasks|events|messages|plans|archive|estimate-items|rate-settings)$/, match => `/api/projects/:id/${match[1]}`],
  [/^\/api\/projects\/[^/]+\/messages\/read$/, '/api/projects/:id/messages/read'],
  [/^\/api\/projects\/[^/]+\/assistant\/chat$/, '/api/projects/:id/assistant/chat'],
  [/^\/api\/projects\/[^/]+$/, '/api/projects/:id'],
  [/^\/api\/project-tickets\/[^/]+$/, '/api/project-tickets/:id'],
  [/^\/api\/project-tasks\/[^/]+\/assign$/, '/api/project-tasks/:id/assign'],
  [/^\/api\/project-tasks\/[^/]+$/, '/api/project-tasks/:id'],
  [/^\/api\/project-events\/[^/]+$/, '/api/project-events/:id'],
  [/^\/api\/catalog\/[^/]+\/apply$/, '/api/catalog/:id/apply'],
  [/^\/api\/catalog\/[^/]+$/, '/api/catalog/:id'],
  [/^\/api\/estimate-imports\/[^/]+\/(draft|approve)$/, match => `/api/estimate-imports/:id/${match[1]}`],
  [/^\/api\/estimate-imports\/[^/]+$/, '/api/estimate-imports/:id'],
  [/^\/api\/subcontractors\/[^/]+\/(profile|archive|compliance-reminder|links)$/, match => `/api/subcontractors/:id/${match[1]}`],
  [/^\/api\/subcontractors\/[^/]+$/, '/api/subcontractors/:id'],
  [/^\/api\/subcontractor-links\/[^/]+$/, '/api/subcontractor-links/:id']
];

function hostedSentryHost(value) {
  const host = String(value || '').toLowerCase();
  return host === 'sentry.io' || host.endsWith('.sentry.io');
}

function validDsn(value) {
  try {
    const parsed = new URL(String(value || '').trim());
    return parsed.protocol === 'https:'
      && /^[a-f0-9]{16,64}$/i.test(parsed.username)
      && !parsed.password
      && !parsed.port
      && hostedSentryHost(parsed.hostname)
      && /^\/\d+$/.test(parsed.pathname)
      && !parsed.search
      && !parsed.hash;
  } catch {
    return false;
  }
}

function redactOpaqueValues(value) {
  return String(value || '')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\b[A-Fa-f0-9]{32,}\b/g, '[redacted]')
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, '[redacted]')
    .replace(/\b[^\s@]+@[^\s@]+\.[^\s@]+\b/g, '[redacted-email]');
}

function sanitizeRoute(value) {
  let pathname = String(value || '').split(/[?#]/, 1)[0] || '/';
  try {
    pathname = new URL(String(value || ''), 'https://monitoring.invalid').pathname;
  } catch {}
  try { pathname = decodeURIComponent(pathname); } catch { return pathname.startsWith('/api/') ? '/api/:unmatched' : '/:unmatched'; }
  if (SAFE_STATIC_ROUTES.has(pathname)) return pathname;
  for (const [pattern, replacement] of ROUTE_TEMPLATES) {
    const match = pathname.match(pattern);
    if (match) return typeof replacement === 'function' ? replacement(match) : replacement;
  }
  return pathname.startsWith('/api/') ? '/api/:unmatched' : '/:unmatched';
}

function safeIdentifier(value, fallback) {
  const text = String(value || '').trim();
  return /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(text) ? text : fallback;
}

function safeStack(error, heading) {
  const frames = String(error?.stack || '')
    .split(/\r?\n/)
    .slice(1)
    .filter(line => /^\s*at\s/.test(line))
    .slice(0, 60)
    .map(redactOpaqueValues);
  return frames.length ? `${heading}\n${frames.join('\n')}` : heading;
}

function safeError(error, message = 'Pro Daily Link request failed') {
  const name = safeIdentifier(error?.name, 'Error');
  const safe = new Error(message);
  safe.name = name;
  safe.stack = safeStack(error, `${name}: ${message}`);
  return safe;
}

function scrubFrame(frame) {
  const clean = { ...frame };
  delete clean.vars;
  delete clean.pre_context;
  delete clean.context_line;
  delete clean.post_context;
  if (clean.filename) clean.filename = redactOpaqueValues(clean.filename);
  if (clean.abs_path) clean.abs_path = redactOpaqueValues(clean.abs_path);
  return clean;
}

function scrubSpan(span) {
  const clean = { ...span };
  delete clean.data;
  delete clean.tags;
  if (clean.description) {
    clean.description = String(clean.description).startsWith('/')
      ? sanitizeRoute(clean.description)
      : undefined;
  }
  return clean;
}

function scrubStacktrace(stacktrace) {
  return stacktrace ? {
    ...stacktrace,
    frames: (stacktrace.frames || []).map(scrubFrame)
  } : stacktrace;
}

function scrubEvent(event) {
  const clean = { ...event };
  delete clean.breadcrumbs;
  delete clean.culprit;
  delete clean.contexts;
  delete clean.debug_meta;
  delete clean.extra;
  delete clean.fingerprint;
  delete clean.logger;
  delete clean.modules;
  delete clean.request;
  delete clean.sdkProcessingMetadata;
  delete clean.server_name;
  delete clean.user;

  if (clean.message) clean.message = 'Pro Daily Link monitoring event';
  if (clean.logentry) clean.logentry = { message: 'Pro Daily Link monitoring event' };
  if (clean.transaction) clean.transaction = sanitizeRoute(clean.transaction);
  if (Array.isArray(clean.spans)) clean.spans = clean.spans.map(scrubSpan);
  if (clean.stacktrace) clean.stacktrace = scrubStacktrace(clean.stacktrace);
  if (clean.threads?.values) {
    clean.threads = {
      ...clean.threads,
      values: clean.threads.values.map(value => ({ ...value, stacktrace: scrubStacktrace(value.stacktrace) }))
    };
  }

  const tags = {};
  for (const [key, value] of Object.entries(clean.tags || {})) {
    if (!SAFE_TAGS.has(key)) continue;
    if (key === 'route') tags[key] = sanitizeRoute(value);
    else if (key === 'method') tags[key] = String(value || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 12);
    else tags[key] = redactOpaqueValues(value).slice(0, 100);
  }
  clean.tags = tags;

  if (clean.exception?.values) {
    clean.exception = {
      ...clean.exception,
      values: clean.exception.values.map(value => {
        const safeValue = { ...value };
        delete safeValue.module;
        return {
          ...safeValue,
          type: safeIdentifier(value.type, 'Error'),
          value: 'Pro Daily Link request failed',
          mechanism: value.mechanism ? {
            type: safeIdentifier(value.mechanism.type, 'generic'),
            handled: value.mechanism.handled !== false
          } : value.mechanism,
          stacktrace: scrubStacktrace(value.stacktrace)
        };
      })
    };
  }
  return clean;
}

function monitoringOptions(env) {
  return {
    dsn: String(env.SENTRY_DSN || '').trim(),
    environment: String(env.NODE_ENV || 'development').slice(0, 64),
    release: env.RENDER_GIT_COMMIT ? String(env.RENDER_GIT_COMMIT).slice(0, 80) : undefined,
    sendDefaultPii: false,
    // Production monitoring is deliberately error-only. Performance tracing
    // needs a separate privacy/cost review before it can be enabled.
    tracesSampleRate: 0,
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      graphQL: { document: false, variables: false },
      genAI: { inputs: false, outputs: false },
      databaseQueryData: false,
      stackFrameVariables: false,
      frameContextLines: 0
    },
    integrations: defaults => defaults.filter(integration => ALLOWED_DEFAULT_INTEGRATIONS.has(integration.name)),
    beforeSend: scrubEvent,
    beforeSendTransaction: scrubEvent,
    beforeSendSpan: scrubSpan
  };
}

function createMonitoring(sdk = Sentry) {
  let client = null;

  function init(env = process.env) {
    const dsn = String(env.SENTRY_DSN || '').trim();
    if (!validDsn(dsn)) {
      client = null;
      return false;
    }
    try {
      client = sdk.init(monitoringOptions(env)) || sdk.getClient?.() || null;
      return active();
    } catch {
      client = null;
      console.error('Error monitoring initialization failed. No monitoring event was queued.');
      return false;
    }
  }

  function active() {
    try {
      const dsn = client?.getDsn?.();
      return Boolean(dsn
        && dsn.protocol === 'https'
        && /^[a-f0-9]{16,64}$/i.test(String(dsn.publicKey || ''))
        && hostedSentryHost(dsn.host)
        && /^\d+$/.test(String(dsn.projectId || ''))
        && !dsn.pass
        && !dsn.port
        && !dsn.path);
    } catch {
      return false;
    }
  }

  function captureRequestException(error, details = {}) {
    if (!active()) return null;
    try {
      return sdk.withScope(scope => {
        scope.setLevel?.('error');
        scope.setTag?.('request_id', String(details.requestId || '').slice(0, 100));
        scope.setTag?.('method', String(details.method || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 12));
        scope.setTag?.('route', sanitizeRoute(details.route));
        scope.setTag?.('error_name', safeIdentifier(error?.name, 'Error'));
        if (/^[A-Z0-9_-]{1,64}$/.test(String(error?.code || ''))) scope.setTag?.('error_code', String(error.code));
        return sdk.captureException(safeError(error));
      });
    } catch {
      console.error('Error monitoring capture failed. The request error remains in Render logs.');
      return null;
    }
  }

  function captureVerification() {
    if (!active()) return null;
    try {
      return sdk.withScope(scope => {
        scope.setLevel?.('error');
        scope.setTag?.('monitoring_verification', 'true');
        const error = new Error('Controlled monitoring verification');
        error.name = 'MonitoringVerificationError';
        return sdk.captureException(safeError(error, 'Pro Daily Link monitoring verification'));
      });
    } catch {
      return null;
    }
  }

  async function flush(timeout = 10_000) {
    if (!active()) return false;
    try {
      return await sdk.flush(timeout);
    } catch {
      return false;
    }
  }

  return { active, captureRequestException, captureVerification, flush, init };
}

function installShutdownFlush(server, {
  monitor,
  processRef = process,
  timeout = 2_000
} = {}) {
  const selectedMonitor = monitor || monitoring;
  const boundedTimeout = Math.min(10_000, Math.max(1, Number(timeout) || 2_000));
  let stopping = false;
  let exited = false;

  const finish = () => {
    if (exited) return;
    exited = true;
    processRef.exit(0);
  };
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    const deadline = Date.now() + boundedTimeout;
    const forceExit = setTimeout(finish, boundedTimeout);
    await new Promise(resolve => {
      try { server.close(() => resolve()); } catch { resolve(); }
    });
    const remaining = Math.max(0, deadline - Date.now());
    if (remaining > 0 && !exited) await Promise.resolve(selectedMonitor.flush(remaining)).catch(() => false);
    clearTimeout(forceExit);
    finish();
  };

  processRef.once('SIGTERM', stop);
  processRef.once('SIGINT', stop);
  return () => {
    processRef.removeListener('SIGTERM', stop);
    processRef.removeListener('SIGINT', stop);
  };
}

const monitoring = createMonitoring();

module.exports = {
  ...monitoring,
  createMonitoring,
  hostedSentryHost,
  installShutdownFlush,
  monitoringOptions,
  redactOpaqueValues,
  safeError,
  sanitizeRoute,
  scrubEvent,
  scrubSpan,
  validDsn
};
