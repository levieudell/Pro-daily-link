'use strict';
// Analytics privacy posture: the HeyCatch tracker and the Meta (Facebook)
// ad-measurement pixel are consent-first and public-pages-only. Signed-in
// app pages and subcontractor guest pages never load them, no client-side
// identity is ever set, and the privacy policy discloses what the remaining
// server-side billing events share.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { isPublicFile } = require('./public-file-policy');
const analytics = fs.readFileSync('analytics.js', 'utf8');
const app = fs.readFileSync('app.js', 'utf8');
const server = fs.readFileSync('server.js', 'utf8');
const privacy = fs.readFileSync('privacy.html', 'utf8');
const signup = fs.readFileSync('signup.js', 'utf8');
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
for (const file of ['landing.html', 'login.html', 'signup.html', 'privacy.html', 'blog.html', 'about.html', 'support.html', 'terms.html', 'forgot-password.html'])
  assert.ok(read(file).includes('/analytics.js'), `${file} keeps the consent-gated loader`);

// Token-bearing account recovery pages never load third-party code and remove
// credentials from browser history immediately after reading them.
for (const [htmlFile, scriptFile] of [['reset-password.html', 'reset-password.js'], ['verify-email.html', 'verify-email.js']]) {
  assert.ok(!read(htmlFile).includes('analytics.js'), `${htmlFile} must not load analytics beside a credential`);
  assert.ok(read(scriptFile).includes("history.replaceState(null,'',`${location.pathname}${location.hash}`)"), `${scriptFile} scrubs the credential URL`);
}
const platformReset = read('platform-reset-password.html');
assert.ok(!platformReset.includes('analytics.js'), 'platform reset must not load analytics beside its credential');
const platformTokenRead = platformReset.indexOf("token=params.get('token')||''");
const platformTokenScrub = platformReset.indexOf("history.replaceState(null,'',`${location.pathname}${location.hash}`)");
assert.ok(platformTokenRead >= 0 && platformTokenScrub > platformTokenRead, 'platform reset captures then immediately scrubs its credential URL');
assert.ok(platformTokenScrub < platformReset.indexOf("$('#reset').onsubmit"), 'platform token is scrubbed before user interaction');

// The signed-in app no longer carries any analytics plumbing.
assert.ok(!/PDLAnalytics|setIdentity|resetIdentity|identifyAnalyticsUser/.test(app), 'app.js has no analytics identity plumbing');

// The disclosure matches reality: policy names HeyCatch, describes the
// consent gate, the account-page exclusion, and the billing events that the
// server still shares — and the server code those statements describe is
// still present.
assert.match(privacy, /HeyCatch/, 'policy names the analytics provider');
assert.match(privacy, /consent banner/i, 'policy describes the opt-in');
assert.match(privacy, /never run inside the signed-in application/, 'policy promises the app is not tracked');
assert.match(privacy, /account owner’s name and email/, 'policy discloses billing-event identity');
assert.ok(server.includes('trackBillingEvent'), 'server billing events still exist for the policy to describe');
assert.ok(server.includes("require('@heycatch/sdk')"), 'server-side provider wiring intact');

// The Meta (Facebook) pixel ships with the same guarantees: it loads only
// inside the consent-gated starter, uses the owner's pixel id, and its
// script tag is injected nowhere else. The consent banner and the policy
// must name Meta so the choice is informed.
assert.ok(analytics.includes("PDL_FACEBOOK_PIXEL_ID = '2581023075730326'"), 'pixel id is wired to the owner account');
assert.ok(analytics.indexOf("window.fbq('init', PDL_FACEBOOK_PIXEL_ID)") > analytics.indexOf('function startFacebookPixel'), 'pixel init lives inside the consent-gated starter');
assert.ok(analytics.indexOf("window.fbq('track', 'PageView')") > analytics.indexOf('function startFacebookPixel'), 'PageView fires only after the pixel starts');
assert.equal((analytics.match(/connect\.facebook\.net/g) || []).length, 1, 'pixel script is injected exactly once, inside the gated starter');
assert.ok(analytics.indexOf('startFacebookPixel();') > analytics.indexOf("accept.onclick"), 'pixel starts from the Accept action');
assert.ok(analytics.indexOf("if (consent === 'accepted') { startAnalytics().catch(() => {}); startFacebookPixel(); }") > analytics.indexOf('const consent = readConsent()'), 'pixel restarts for returning visitors who already accepted');
assert.match(analytics, /Meta&#39;s ad measurement pixel/, 'consent banner names Meta');
assert.match(privacy, /Meta for advertising measurement/, 'policy names Meta in the providers list');
assert.match(privacy, /Meta&#39;s advertising measurement pixel only after a visitor chooses “Accept”/, 'policy describes the pixel consent gate');

// Signup conversion: fired only after the server confirms the account was
// created, and only if the pixel is present (consent accepted).
assert.ok(signup.indexOf("fbq('track','Signup')") > signup.indexOf('if(!response.ok)throw new Error(data.error);'), 'Signup event fires after confirmed account creation');
assert.ok(signup.includes("if(typeof fbq==='function')"), 'Signup event is a no-op without the pixel');

// Private surfaces stay clean of the pixel too.
for (const file of ['index.html', 'guest.html', 'app.js'])
  assert.ok(!read(file).includes('fbq') && !read(file).includes('fbevents'), `${file} must not touch the pixel`);

console.log('analytics consent contracts: ok');
