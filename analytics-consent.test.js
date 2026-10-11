'use strict';
// Analytics privacy posture: the HeyCatch tracker is consent-first and
// public-pages-only. Signed-in app pages and subcontractor guest pages never
// load it, no client-side identity is ever set, and the privacy policy
// discloses what the remaining server-side billing events share.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { isPublicFile } = require('./public-file-policy');
const analytics = fs.readFileSync('analytics.js', 'utf8');
const app = fs.readFileSync('app.js', 'utf8');
const server = fs.readFileSync('server.js', 'utf8');
const privacy = fs.readFileSync('privacy.html', 'utf8');
const read = file => fs.readFileSync(file, 'utf8');

// The loader is consent-first: it never identifies anyone and initializes
// only inside startAnalytics (after an accepted consent), never at load time.
assert.ok(!/setIdentity|resetIdentity|identifyAnalyticsUser/.test(analytics), 'client tracker never sets or resets identity');
assert.ok(analytics.includes('pdl-analytics-consent'), 'consent choice is persisted');
assert.ok(analytics.includes('Accept') && analytics.includes('Decline'), 'banner offers an explicit choice');
assert.ok(analytics.indexOf('analytics.init(') > analytics.indexOf('async function startAnalytics'), 'init lives inside the consent-gated starter');
assert.ok(analytics.indexOf('const consent = readConsent()') > analytics.indexOf('async function startAnalytics'), 'module boot only reads consent');
assert.equal(isPublicFile(process.cwd(), path.join(process.cwd(), 'analytics.js')), true, 'loader remains publicly served');

// Private surfaces never load the tracker; public pages keep it (gated).
for (const file of ['index.html', 'guest.html'])
  assert.ok(!read(file).includes('analytics.js'), `${file} must not load the tracker`);
for (const file of ['landing.html', 'login.html', 'signup.html', 'privacy.html', 'blog.html', 'about.html', 'support.html', 'terms.html', 'forgot-password.html', 'reset-password.html', 'verify-email.html'])
  assert.ok(read(file).includes('/analytics.js'), `${file} keeps the consent-gated loader`);

// The signed-in app no longer carries any analytics plumbing.
assert.ok(!/PDLAnalytics|setIdentity|resetIdentity|identifyAnalyticsUser/.test(app), 'app.js has no analytics identity plumbing');

// The disclosure matches reality: policy names HeyCatch, describes the
// consent gate, the account-page exclusion, and the billing events that the
// server still shares — and the server code those statements describe is
// still present.
assert.match(privacy, /HeyCatch/, 'policy names the analytics provider');
assert.match(privacy, /consent banner/i, 'policy describes the opt-in');
assert.match(privacy, /never runs inside the signed-in application/, 'policy promises the app is not tracked');
assert.match(privacy, /account owner’s name and email/, 'policy discloses billing-event identity');
assert.ok(server.includes('trackBillingEvent'), 'server billing events still exist for the policy to describe');
assert.ok(server.includes("require('@heycatch/sdk')"), 'server-side provider wiring intact');

console.log('analytics consent contracts: ok');
