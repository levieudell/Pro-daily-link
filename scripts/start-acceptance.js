'use strict';
// Acceptance harness only. Do not use this entry point for a production service.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const CANDIDATE = '6b52fbcba0426a2cde858725f67bb2d4cbc82853';
const EXPECTED_STRIPE_ACCOUNT = 'acct_1SqHF1FsPiiIUxge';
const ROOT_TENANT = '00000000-0000-4000-8000-000000000001';
const MARKER = '.pdl-acceptance.json';
const ENTERPRISE_OPT_IN = 'test-only';
const OWNER_OPT_IN = 'synthetic-test-owner';
const APPROVED_SERVICE = 'srv-db1noks9v7es738ebdd0';
const APPROVED_ORIGIN = 'https://pdl-paid-acceptance-20261005.onrender.com';
const OWNER_MARKER = 'pdl-enterprise-acceptance-owner-v1';
const OWNER_IDENTITY_FILE = '.pdl-acceptance-owner.json';
const OWNER = Object.freeze({ id: 1, name: 'PDL Enterprise Acceptance Owner', email: 'enterprise-test-owner@example.invalid', role: 'platform_owner', status: 'Active', mustSetPassword: false, acceptanceFixture: OWNER_MARKER });
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
const ALLOWED_PDL = new Set([...Object.keys(FORCED), 'PDL_PUBLIC_URL', 'PDL_ACCEPTANCE_DATA_DIR', 'PDL_ACCEPTANCE_ALLOW_LOOPBACK', 'PDL_ACCEPTANCE_PUBLIC_URL', 'PDL_ACCEPTANCE_STRIPE_ACCOUNT_ID', 'PDL_ACCEPTANCE_ENTERPRISE', 'PDL_ACCEPTANCE_PLATFORM_OWNER', 'PDL_ACCEPTANCE_PLATFORM_PASSWORD', 'PDL_ACCEPTANCE_ANNUAL_STARTER']);
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
  if(present(env.PDL_ACCEPTANCE_ANNUAL_STARTER) && !annualFixtureTarget(env)) reject('Annual fixture requires its exact opt-in and approved sandbox service.');
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
  const enterprise = env.PDL_ACCEPTANCE_ENTERPRISE === ENTERPRISE_OPT_IN;
  const owner = env.PDL_ACCEPTANCE_PLATFORM_OWNER === OWNER_OPT_IN;
  const passwordProvided = Object.hasOwn(env, 'PDL_ACCEPTANCE_PLATFORM_PASSWORD');
  if ((Object.hasOwn(env, 'PDL_ACCEPTANCE_ENTERPRISE') && !enterprise) || (Object.hasOwn(env, 'PDL_ACCEPTANCE_PLATFORM_OWNER') && !owner) || enterprise !== owner) reject('Enterprise acceptance requires both exact explicit opt-ins, or neither.');
  if (passwordProvided && !owner) reject('A platform fixture password requires both Enterprise acceptance opt-ins.');
  if (passwordProvided && (typeof env.PDL_ACCEPTANCE_PLATFORM_PASSWORD !== 'string' || env.PDL_ACCEPTANCE_PLATFORM_PASSWORD.length < 12)) reject('The private acceptance owner password must contain at least 12 characters.');
  if (passwordProvided && (/^\s*(?:(?:sk|rk|pk)_(?:test|live)_|whsec_)/i.test(env.PDL_ACCEPTANCE_PLATFORM_PASSWORD) || env.PDL_ACCEPTANCE_PLATFORM_PASSWORD === env.STRIPE_SECRET_KEY || env.PDL_ACCEPTANCE_PLATFORM_PASSWORD === env.STRIPE_WEBHOOK_SECRET)) reject('The acceptance owner password must be unique and must not reuse a provider credential.');
  // Render documents RENDER_SERVICE_ID as its service identifier. These checks
  // bind this fixture to the reviewed deployment, not to any arbitrary Render URL.
  if (enterprise && (local || env.RENDER !== 'true' || env.RENDER_SERVICE_ID !== APPROVED_SERVICE || env.RENDER_EXTERNAL_URL !== APPROVED_ORIGIN || publicUrl !== APPROVED_ORIGIN || (present(env.RENDER_EXTERNAL_HOSTNAME) && env.RENDER_EXTERNAL_HOSTNAME !== new URL(APPROVED_ORIGIN).hostname) || (present(env.RENDER_SERVICE_TYPE) && env.RENDER_SERVICE_TYPE !== 'web'))) reject('Enterprise acceptance is restricted to the approved Render service and origin.');
  if (present(env.PDL_PUBLIC_URL) && env.PDL_PUBLIC_URL !== publicUrl) reject('Inherited public URL does not match the acceptance origin.');
  if (present(env.PDL_ACCEPTANCE_STRIPE_ACCOUNT_ID) && env.PDL_ACCEPTANCE_STRIPE_ACCOUNT_ID !== EXPECTED_STRIPE_ACCOUNT) reject('Acceptance Stripe account metadata does not match the intended sandbox.');
  const key = env.STRIPE_SECRET_KEY || '';
  if (key && !/^(?:rk|sk)_test_[A-Za-z0-9]+$/.test(key)) reject('Only owner-entered Stripe test-mode keys are permitted.');
  if (env.STRIPE_WEBHOOK_SECRET && !/^whsec_[A-Za-z0-9]+$/.test(env.STRIPE_WEBHOOK_SECRET)) reject('Invalid acceptance webhook signing-secret format.');
  for (const name of PRICE_KEYS) if (env[name] && env[name] !== PRICES[name]) reject('Acceptance prices must match the verified sandbox catalog.');
  const port = Number(env.PORT || (local ? new URL(publicUrl).port || '80' : '10000'));
  if (!Number.isInteger(port) || port < 1 || port > 65535) reject('Invalid acceptance listening port.');
  if (local && Number(new URL(publicUrl).port || '80') !== port) reject('The local acceptance origin and listening port must match.');
  const identity = crypto.createHash('sha256').update(fs.realpathSync(root) + '\n' + publicUrl + '\n' + CANDIDATE).digest('hex').slice(0, 16);
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
  return { root, directory, publicUrl, port, local, enterprise, annual: annualFixtureTarget(env), passwordProvided, keyPresent: Boolean(key), webhookPresent: Boolean(env.STRIPE_WEBHOOK_SECRET), expectedAccount: EXPECTED_STRIPE_ACCOUNT, candidate: CANDIDATE };
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
function preparePlatformOwner(config, platform, password, identityFile) {
  if (!Array.isArray(platform.users) || !Array.isArray(platform.sessions)) reject('Acceptance platform users and sessions must be explicit arrays.');
  const marked = Object.hasOwn(platform, 'acceptancePlatformOwner');
  if (!config.enterprise) {
    if (marked || exists(identityFile) || platform.users.length || platform.sessions.length) reject('Privileged platform state requires the explicit Enterprise fixture opt-ins; no data was erased.');
    return false;
  }
  const marker = { format: OWNER_MARKER, serviceId: APPROVED_SERVICE, publicUrl: APPROVED_ORIGIN, candidate: CANDIDATE };
  const identity = user => ({ ...marker, credentialDigest: crypto.createHash('sha256').update(user.passwordSalt + '\n' + user.passwordHash).digest('hex') });
  if (!marked) {
    if (platform.users.length || platform.sessions.length) reject('Refusing to adopt existing platform users or sessions as an acceptance owner.');
    if (exists(identityFile)) reject('Incomplete acceptance owner initialization requires explicit review; it will not be reset.');
    if (!config.passwordProvided || typeof password !== 'string' || password.length < 12) reject('Initial acceptance owner setup requires a privately entered password of at least 12 characters.');
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(password, salt, 64).toString('hex');
    platform.users = [{ ...OWNER, passwordSalt: salt, passwordHash: hash }];
    platform.acceptancePlatformOwner = marker;
    // Private, separate identity evidence detects changed credentials even when
    // the owner has removed the environment password. Exclusive creation also
    // prevents concurrent initializers from replacing each other's credentials.
    try { fs.writeFileSync(identityFile, JSON.stringify(identity(platform.users[0])) + '\n', { flag: 'wx', mode: 0o600 }); }
    catch { reject('Acceptance owner identity could not be saved safely.'); }
    return true;
  }
  if (JSON.stringify(platform.acceptancePlatformOwner) !== JSON.stringify(marker) || platform.users.length !== 1) reject('The existing platform fixture identity conflicts with the approved acceptance owner.');
  const user = platform.users[0];
  const keys = [...Object.keys(OWNER), 'passwordSalt', 'passwordHash'];
  if (!user || Object.keys(user).length !== keys.length || Object.keys(user).some(key => !keys.includes(key)) || Object.entries(OWNER).some(([key, value]) => user[key] !== value) || !/^[0-9a-f]{32}$/.test(user.passwordSalt) || !/^[0-9a-f]{128}$/.test(user.passwordHash)) reject('The existing acceptance owner was changed; it will not be adopted, reset, or re-enabled.');
  let recordedIdentity;
  try { recordedIdentity = JSON.parse(fs.readFileSync(identityFile, 'utf8')); }
  catch { reject('Acceptance owner identity evidence is missing or invalid.'); }
  if (JSON.stringify(recordedIdentity) !== JSON.stringify(identity(user))) reject('Acceptance owner credentials or identity evidence changed; no credentials were reset.');
  if (platform.sessions.some(session => !session || session.userId !== OWNER.id || !/^[0-9a-f]{64}$/.test(session.tokenHash) || typeof session.id !== 'string' || !Number.isFinite(Date.parse(session.createdAt)) || !Number.isFinite(Date.parse(session.expiresAt)) || Object.keys(session).some(key => !['id', 'userId', 'tokenHash', 'createdAt', 'expiresAt'].includes(key)))) reject('The acceptance platform contains conflicting session state.');
  if (config.passwordProvided && (typeof password !== 'string' || password.length < 12 || !crypto.timingSafeEqual(crypto.scryptSync(password, user.passwordSalt, 64), Buffer.from(user.passwordHash, 'hex')))) reject('The supplied acceptance password does not match the existing fixture; no credentials were changed.');
  return false;
}
function prepareStorage(config, password) {
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
  if (db.acceptanceOnly !== true || (db.company?.id !== ROOT_TENANT && !(config.annual && db.company?.id==='synthetic-pr114-starter')) || platform.acceptanceOnly !== true) reject('State is not marked as synthetic acceptance data.');
  if (!Array.isArray(db.users) || db.users.length || !Array.isArray(db.sessions) || db.sessions.length) reject('The synthetic acceptance root must remain without users or sessions.');
  if (preparePlatformOwner(config, platform, password, path.join(dir, OWNER_IDENTITY_FILE))) {
    // Exclusive temporary write plus rename avoids a half-written password row.
    // Existing unrelated platform data is retained. Never seed a session/token.
    const temp = platformFile + '.owner-init';
    try {
      fs.writeFileSync(temp, JSON.stringify(platform, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      fs.renameSync(temp, platformFile);
    } catch { reject('Acceptance owner state could not be saved safely.'); }
  }
  assertPrivateTree(dir);
  return { dbFile, platformFile };
}
function annualFixtureTarget(env=process.env) {
  return env.PDL_ACCEPTANCE_ANNUAL_STARTER === 'test-only' && env.RENDER === 'true' && env.RENDER_SERVICE_ID === APPROVED_SERVICE && env.RENDER_EXTERNAL_URL === APPROVED_ORIGIN;
}
function prepareAnnualFixture(config) {
  if(config.local || config.publicUrl!==APPROVED_ORIGIN || !annualFixtureTarget()) reject('Annual fixture is restricted to the approved isolated service.');
  assertPrivateTree(config.directory);
  const db=seedRoot();
  db.company={id:'synthetic-pr114-starter',name:'Synthetic PR114 Starter',timezone:'Etc/UTC',plan:'starter',accountType:'standard',billingExempt:false,subscriptionStatus:'Incomplete',trialEndsAt:null,stripeCustomerId:'cus_VP7IwQLiOmXGlV',annualUpfront:{version:'annual-upfront-first-year-v1',plan:'starter',acceptedAt:'2026-10-08T15:16:51.000Z',used:false},features:{timeCards:false,templates:false}};
  const file=path.join(config.directory,'db.json');
  if(exists(file)){
    const previous=JSON.parse(fs.readFileSync(file,'utf8'));
    if(previous.company?.id==='synthetic-pr114-starter')return file;
    if(previous.company?.id!==ROOT_TENANT || Object.values(previous).some(value=>Array.isArray(value)&&value.length))reject('Annual root fixture conflicts with existing state.');
    const temp=file+'.annual-init';fs.writeFileSync(temp,JSON.stringify(db)+'\n',{flag:'wx',mode:0o600});fs.renameSync(temp,file);
  }else writeMissing(file,db);
  assertPrivateTree(config.directory);
  return file;
}
function start() {
  const annual=annualFixtureTarget();
  if(annual){
    // Owner explicitly approved reconstructing ONLY this service's disposable fixtures.
    // Narrow the old Enterprise owner mode; do not create, reset or transmit credentials.
    delete process.env.PDL_ACCEPTANCE_ENTERPRISE;
    delete process.env.PDL_ACCEPTANCE_PLATFORM_OWNER;
    delete process.env.PDL_ACCEPTANCE_PLATFORM_PASSWORD;
  }
  let password = process.env.PDL_ACCEPTANCE_PLATFORM_PASSWORD;
  let config;
  try { config = validateConfig(); }
  finally { delete process.env.PDL_ACCEPTANCE_PLATFORM_PASSWORD; }
  process.umask(0o077);
  let storage;
  try { storage = prepareStorage(config, password); }
  finally { password = undefined; }
  const annualFile=annual?prepareAnnualFixture(config):null;
  Object.assign(process.env, FORCED, PRICES, { NODE_ENV: config.local ? 'development' : 'production', PDL_PUBLIC_URL: config.publicUrl, PDL_DB_FILE: storage.dbFile, PDL_PLATFORM_FILE: storage.platformFile, PDL_ACCEPTANCE_STRIPE_ACCOUNT_ID: EXPECTED_STRIPE_ACCOUNT, PDL_ENTERPRISE_CHECKOUT_ENABLED: config.enterprise ? '1' : '0' });
  const { server } = require(path.join(ROOT, 'server'));
  server.prependListener('request', (req, res) => {
    res.setHeader('X-PDL-Acceptance', 'isolated-synthetic');
    res.setHeader('X-PDL-Candidate', CANDIDATE);
    if(annualFile && req.method==='POST' && req.url==='/api/billing/webhook')res.once('finish',()=>{
      try {const c=JSON.parse(fs.readFileSync(annualFile,'utf8')).company;
        console.log('Annual fixture receipt '+JSON.stringify({httpStatus:res.statusCode,companyId:c.id,status:c.subscriptionStatus,planPrice:c.planPrice,subscriptionId:c.stripeSubscriptionId||null,firstInvoiceId:c.annualUpfront?.firstInvoiceId||null,offerUsed:c.annualUpfront?.used===true,eventIds:c.stripeWebhookEvents||[]}));
      }catch{console.error('Annual fixture receipt unavailable');}
    });
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
module.exports = { start, PRICES, CANDIDATE, EXPECTED_STRIPE_ACCOUNT, ROOT_TENANT, PRICE_KEYS, FORCED, ENTERPRISE_OPT_IN, OWNER_OPT_IN, APPROVED_SERVICE, APPROVED_ORIGIN, OWNER, OWNER_IDENTITY_FILE, validateConfig, prepareStorage, seedRoot, annualFixtureTarget, prepareAnnualFixture };
