'use strict';
// Acceptance harness only. Do not use this entry point for a production service.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const CANDIDATE = 'dc15e21d0fe3ce7def793296de9df43bdd0a0031';
const EXPECTED_STRIPE_ACCOUNT = 'acct_1SqHF1FsPiiIUxge';
const ROOT_TENANT = '00000000-0000-4000-8000-000000000001';
const MARKER = '.pdl-acceptance.json';
// Non-secret IDs independently read back from the intended sandbox account.
const PRICES = Object.freeze({
  STRIPE_PRICE_STARTER: 'price_1UN8pAFsPiiIUxgeaaE3jemv',
  STRIPE_PRICE_STARTER_ANNUAL: 'price_1UN8pvFsPiiIUxgeB3LdijQb',
  STRIPE_PRICE_GROWTH: 'price_1UN8ppFsPiiIUxgeRqkQLSVk',
  STRIPE_PRICE_GROWTH_ANNUAL: 'price_1UN8pyFsPiiIUxge7oz1Pu39',
  STRIPE_PRICE_PRO: 'price_1UN8psFsPiiIUxgembTKfPnj',
  STRIPE_PRICE_PRO_ANNUAL: 'price_1UN8q2FsPiiIUxgewG7iFaL2',
});
const PRICE_KEYS = Object.keys(PRICES);
const FORCED = Object.freeze({ PDL_REQUIRE_AUTH: '1', PDL_SUPABASE_ENABLED: '0', PDL_TRANSACTIONAL_DB: 'off', PDL_FOUNDER_ENABLED: '0', PDL_ENTERPRISE_CHECKOUT_ENABLED: '0', PDL_EMAIL_DEV_MODE: '0' });
const ALLOWED_PDL = new Set([...Object.keys(FORCED), 'PDL_PUBLIC_URL', 'PDL_ACCEPTANCE_DATA_DIR', 'PDL_ACCEPTANCE_ALLOW_LOOPBACK', 'PDL_ACCEPTANCE_PUBLIC_URL', 'PDL_ACCEPTANCE_STRIPE_ACCOUNT_ID']);
const ALLOWED_STRIPE = new Set(['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', ...PRICE_KEYS]);
const BLOCKED = /^(?:SUPABASE_|RESEND_|OPENAI_|SENTRY_|ANTHROPIC_|SMTP_|MAILGUN_|SENDGRID_|POSTMARK_|DATABASE_|PG(?:HOST|PORT|USER|PASSWORD|DATABASE|SERVICE|PASSFILE|SSLMODE)|DOTENV_CONFIG_|NODE_OPTIONS$|NODE_PATH$)/;
class AcceptanceError extends Error {}
function reject(message) { throw new AcceptanceError(message); }
function present(value) { return value !== undefined && value !== ''; }
function exists(file) { try { fs.lstatSync(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
function requireNoEnvFiles(root) {
  for (const name of ['.env', '.env.local']) if (exists(path.join(root, name))) reject('Remove root .env and .env.local files before acceptance startup.');
}
function origin(raw, local) {
  let url;
  try { url = new URL(raw); } catch { reject('A valid acceptance public origin is required.'); }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') reject('The acceptance public URL must be an origin without credentials, paths, queries, or fragments.');
  const host = url.hostname.toLowerCase();
  if (host === 'pro-daily-link-demo.onrender.com' || host === 'prodailylink.com' || host.endsWith('.prodailylink.com')) reject('Production hosts cannot be used for acceptance.');
  if (local) {
    if (!['127.0.0.1', '[::1]'].includes(host) || url.protocol !== 'http:') reject('Local acceptance requires an explicit HTTP loopback IP.');
  } else if (url.protocol !== 'https:' || url.port || !/^[a-z0-9][a-z0-9-]*\.onrender\.com$/.test(host)) {
    reject('Use the HTTPS RENDER_EXTERNAL_URL supplied to the new Render service.');
  }
  return url.origin;
}
function validateConfig(env = process.env, root = ROOT) {
  requireNoEnvFiles(root);
  for (const [name, value] of Object.entries(env)) {
    if (!present(value)) continue;
    if (BLOCKED.test(name) || (name.startsWith('PDL_') && !ALLOWED_PDL.has(name)) || (name.startsWith('STRIPE_') && !ALLOWED_STRIPE.has(name))) reject('Inherited integration or path configuration is not permitted. Start with an isolated environment.');
    if (Object.hasOwn(FORCED, name) && value !== FORCED[name]) reject('Acceptance authentication and disabled-integration guards cannot be overridden.');
  }
  const local = env.PDL_ACCEPTANCE_ALLOW_LOOPBACK === '1';
  if (present(env.PDL_ACCEPTANCE_ALLOW_LOOPBACK) && !local) reject('Invalid local acceptance switch.');
  if (local && (present(env.RENDER_EXTERNAL_URL) || env.RENDER === 'true')) reject('Loopback mode cannot run as a Render service.');
  if (!local && present(env.PDL_ACCEPTANCE_PUBLIC_URL)) reject('Hosted acceptance must derive its origin from RENDER_EXTERNAL_URL.');
  const publicUrl = origin(local ? env.PDL_ACCEPTANCE_PUBLIC_URL : env.RENDER_EXTERNAL_URL, local);
  if (present(env.PDL_PUBLIC_URL) && env.PDL_PUBLIC_URL !== publicUrl) reject('Inherited public URL does not match the acceptance origin.');
  if (present(env.PDL_ACCEPTANCE_STRIPE_ACCOUNT_ID) && env.PDL_ACCEPTANCE_STRIPE_ACCOUNT_ID !== EXPECTED_STRIPE_ACCOUNT) reject('Acceptance Stripe account metadata does not match the intended sandbox.');
  const key = env.STRIPE_SECRET_KEY || '';
  if (key && !/^(?:rk|sk)_test_[A-Za-z0-9]+$/.test(key)) reject('Only owner-entered Stripe test-mode keys are permitted.');
  if (env.STRIPE_WEBHOOK_SECRET && !/^whsec_[A-Za-z0-9]+$/.test(env.STRIPE_WEBHOOK_SECRET)) reject('Invalid acceptance webhook signing-secret format.');
  for (const name of PRICE_KEYS) if (env[name] && env[name] !== PRICES[name]) reject('Acceptance prices must match the verified sandbox catalog.');
  const port = Number(env.PORT || (local ? new URL(publicUrl).port || '80' : '10000'));
  if (!Number.isInteger(port) || port < 1 || port > 65535) reject('Invalid acceptance listening port.');
  if (local && Number(new URL(publicUrl).port || '80') !== port) reject('The local acceptance origin and listening port must match.');
  const identity = crypto.createHash('sha256').update(fs.realpathSync(root) + '\n' + publicUrl).digest('hex').slice(0, 16);
  const directory = env.PDL_ACCEPTANCE_DATA_DIR || `/tmp/pdl-acceptance-${identity}`;
  if (!path.isAbsolute(directory) || path.normalize(directory) !== directory || path.dirname(directory) !== '/tmp' || !/^pdl-acceptance-[A-Za-z0-9-]+$/.test(path.basename(directory))) reject('Acceptance storage must be a dedicated direct /tmp/pdl-acceptance-* directory.');
  if (fs.realpathSync('/tmp') !== '/tmp') reject('Acceptance temporary storage cannot be redirected.');
  // Upload paths are hardcoded in this candidate. Keep this harness payment-only.
  const uploads = path.join(root, 'uploads');
  if (exists(uploads)) {
    if (!fs.lstatSync(uploads).isDirectory() || fs.readdirSync(uploads).some(name => name !== '.gitkeep')) reject('Acceptance requires an empty, ordinary checkout upload directory; attachment acceptance is not enabled.');
    const keep = path.join(uploads, '.gitkeep');
    if (exists(keep) && (!fs.lstatSync(keep).isFile() || !['', '\n'].includes(fs.readFileSync(keep, 'utf8')))) reject('Unexpected upload placeholder.');
  }
  return { root, directory, publicUrl, port, local, keyPresent: Boolean(key), webhookPresent: Boolean(env.STRIPE_WEBHOOK_SECRET), expectedAccount: EXPECTED_STRIPE_ACCOUNT, candidate: CANDIDATE };
}
function assertPrivateTree(file) {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()) || (stat.isFile() && stat.nlink !== 1) || (typeof process.getuid === 'function' && stat.uid !== process.getuid()) || (stat.mode & 0o077)) reject('Acceptance storage must be private, owned, and free of symlinks or hard links.');
  if (stat.isDirectory()) for (const name of fs.readdirSync(file)) assertPrivateTree(path.join(file, name));
}
function seedRoot() {
  const db = { acceptanceOnly: true, company: { id: ROOT_TENANT, name: 'Synthetic acceptance root', timezone: 'Etc/UTC', plan: 'starter', accountType: 'standard', billingExempt: false, subscriptionStatus: 'Incomplete', features: { timeCards: false, templates: false } } };
  for (const key of ['users', 'customers', 'projects', 'team', 'subcontractors', 'assignments', 'reports', 'photos', 'workdays', 'changes', 'subcontractorLinks', 'catalog', 'sessions', 'timeCards', 'timeOffRequests', 'auditLog', 'reportingExports']) db[key] = [];
  return db;
}
function writeMissing(file, value) {
  try { fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
}
function prepareStorage(config) {
  const dir = config.directory;
  const marker = { format: 'pdl-isolated-acceptance-v1', candidate: CANDIDATE, root: fs.realpathSync(config.root), publicUrl: config.publicUrl, expectedStripeAccount: EXPECTED_STRIPE_ACCOUNT };
  if (!exists(dir)) fs.mkdirSync(dir, { mode: 0o700 });
  assertPrivateTree(dir);
  const markerFile = path.join(dir, MARKER);
  if (!exists(markerFile) && fs.readdirSync(dir).length) reject('Refusing to adopt existing unmarked acceptance data.');
  writeMissing(markerFile, marker);
  let stored;
  try { stored = JSON.parse(fs.readFileSync(markerFile, 'utf8')); } catch { reject('Invalid acceptance storage marker.'); }
  if (JSON.stringify(stored) !== JSON.stringify(marker)) reject('Acceptance storage belongs to a different service or candidate.');
  const dbFile = path.join(dir, 'db.json'), platformFile = path.join(dir, 'platform.json');
  writeMissing(dbFile, seedRoot());
  writeMissing(platformFile, { acceptanceOnly: true, users: [], sessions: [], notes: [], helpItems: [], blogPosts: [], demoRequests: [], onboardingOrders: [], supportTickets: [], followUps: [], auditEvents: [] });
  let db, platform;
  try { db = JSON.parse(fs.readFileSync(dbFile, 'utf8')); platform = JSON.parse(fs.readFileSync(platformFile, 'utf8')); } catch { reject('Acceptance state is invalid; it will not be overwritten.'); }
  if (db.acceptanceOnly !== true || db.company?.id !== ROOT_TENANT || platform.acceptanceOnly !== true) reject('State is not marked as synthetic acceptance data.');
  assertPrivateTree(dir);
  return { dbFile, platformFile };
}
function start() {
  const config = validateConfig();
  process.umask(0o077);
  const storage = prepareStorage(config);
  Object.assign(process.env, FORCED, PRICES, { NODE_ENV: config.local ? 'development' : 'production', PDL_PUBLIC_URL: config.publicUrl, PDL_DB_FILE: storage.dbFile, PDL_PLATFORM_FILE: storage.platformFile, PDL_ACCEPTANCE_STRIPE_ACCOUNT_ID: EXPECTED_STRIPE_ACCOUNT });
  const { server } = require(path.join(ROOT, 'server'));
  server.prependListener('request', (req, res) => {
    res.setHeader('X-PDL-Acceptance', 'isolated-synthetic');
    res.setHeader('X-PDL-Candidate', CANDIDATE);
  });
  server.listen(config.port, config.local ? new URL(config.publicUrl).hostname.replace(/^\[|\]$/g, '') : '0.0.0.0', () => {
    console.log(`Isolated synthetic acceptance listening; candidate=${CANDIDATE}; stripe=${config.keyPresent ? 'test-prefix-only' : 'missing'}; webhook=${config.webhookPresent ? 'present' : 'missing'}.`);
    console.log('Sandbox account, email delivery, durable storage, attachments, and recovery are not certified by startup.');
  });
  server.on('error', () => { console.error('Acceptance server could not listen.'); process.exitCode = 1; });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10000).unref();
  });
  return { server, config };
}
if (require.main === module) {
  try { start(); } catch (error) {
    // Never echo inherited values, provider secrets, native error stacks, or state.
    console.error(error instanceof AcceptanceError ? `Acceptance startup refused: ${error.message}` : 'Acceptance startup failed safely.');
    process.exitCode = 1;
  }
}
module.exports = { start, PRICES, CANDIDATE, EXPECTED_STRIPE_ACCOUNT, ROOT_TENANT, PRICE_KEYS, FORCED, validateConfig, prepareStorage, seedRoot };
