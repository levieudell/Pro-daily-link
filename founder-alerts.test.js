'use strict';
// Founder alerts: instant email to platform owners on money-moment events —
// demo requests (with enterprise signal), trial signups, and the first time a
// subscription becomes Active. Alerts are fire-and-forget: they must never
// break the triggering request, and missing email config must never break the
// app. PDL_FOUNDER_ALERTS=0 silences emails while still recording the audit.
const assert = require('node:assert/strict'), fs = require('node:fs');
const founderAlerts = require('./founder-alerts');
const { platformOwnerRecipients, buildAlertEmail, sendFounderAlert, demoRequestAlert, trialSignupAlert, subscriptionActivatedAlert, renewalReviewAlert } = founderAlerts;
const server = fs.readFileSync('server.js', 'utf8');

// --- Recipients -------------------------------------------------------------
{
  const platform = { users: [
    { role: 'platform_owner', status: 'Active', email: 'levie@example.com' },
    { role: 'platform_owner', status: 'Active', email: '' },
    { role: 'platform_owner', status: 'Invited', email: 'invited@example.com' },
    { role: 'customer_success', status: 'Active', email: 'cs@example.com' },
  ] };
  assert.deepEqual(platformOwnerRecipients(platform), ['levie@example.com'], 'only active platform owners with an email receive alerts');
  assert.deepEqual(platformOwnerRecipients({}), [], 'empty platform has no recipients');
}

// --- Email body -------------------------------------------------------------
{
  const html = buildAlertEmail({ badge: 'ENTERPRISE SIGNAL', title: 'Acme <demo>', lines: [['Company', 'Acme & Sons']] });
  assert.ok(html.includes('ENTERPRISE SIGNAL'), 'badge rendered');
  assert.ok(html.includes('Acme &lt;demo&gt;'), 'title is escaped');
  assert.ok(html.includes('Acme &amp; Sons'), 'line values are escaped');
  assert.ok(html.includes('platform.html'), 'links back to the founder console');
}

// --- send behavior ----------------------------------------------------------
async function captureFetch(status = 200) {
  const calls = [];
  const fetchImpl = async (url, options) => { calls.push([url, options]); return { ok: status < 400, status }; };
  return { calls, fetchImpl };
}

(async () => {
  const env = { RESEND_API_KEY: 'test-key', RESEND_FROM: 'PDL <test@example.com>' };

  { // disabled → no send, suppression audited, persist still runs
    const { calls, fetchImpl } = await captureFetch();
    let persisted = null;
    const platform = { users: [{ role: 'platform_owner', status: 'Active', email: 'levie@example.com' }] };
    const result = await sendFounderAlert({ platform, subject: 'S', title: 'T', lines: [], env: { ...env, PDL_FOUNDER_ALERTS: '0' }, fetchImpl, persist: async p => { persisted = p; } });
    assert.deepEqual(result, { sent: false, reason: 'disabled' });
    assert.equal(calls.length, 0, 'disabled alerts never hit the email provider');
    assert.ok(platform.auditEvents.some(event => event.action === 'founder_alert_suppressed'), 'suppression is audited');
    assert.equal(persisted, platform, 'disabled alerts still persist the audit event');
  }

  { // no recipients → no send, no persist
    const { calls, fetchImpl } = await captureFetch();
    const platform = { users: [] };
    const result = await sendFounderAlert({ platform, subject: 'S', title: 'T', lines: [], env, fetchImpl, persist: async () => { throw new Error('persist must not run'); } });
    assert.deepEqual(result, { sent: false, reason: 'no-recipients' });
    assert.equal(calls.length, 0);
  }

  { // email not configured → no send, skip audited, never throws
    const { calls, fetchImpl } = await captureFetch();
    const platform = { users: [{ role: 'platform_owner', status: 'Active', email: 'levie@example.com' }] };
    const result = await sendFounderAlert({ platform, subject: 'S', title: 'T', lines: [], env: {}, fetchImpl, persist: async () => {} });
    assert.deepEqual(result, { sent: false, reason: 'email-not-configured' });
    assert.equal(calls.length, 0, 'no provider call without a key');
    assert.ok(platform.auditEvents.some(event => event.action === 'founder_alert_skipped'), 'skipped send is audited');
  }

  { // success → provider called with owners, subject, html; send audited
    const { calls, fetchImpl } = await captureFetch();
    const platform = { users: [{ role: 'platform_owner', status: 'Active', email: 'levie@example.com' }] };
    const result = await sendFounderAlert({ platform, subject: 'Subj', badge: 'B', title: 'T', lines: [['K', 'V']], env, fetchImpl, persist: async () => {} });
    assert.equal(result.sent, true);
    assert.equal(calls.length, 1);
    const [url, options] = calls[0];
    assert.equal(url, 'https://api.resend.com/emails');
    assert.equal(options.headers.Authorization, 'Bearer test-key');
    const payload = JSON.parse(options.body);
    assert.deepEqual(payload.to, ['levie@example.com']);
    assert.equal(payload.subject, 'Subj');
    assert.ok(payload.html.includes('B') && payload.html.includes('T'));
    assert.ok(platform.auditEvents.some(event => event.action === 'founder_alert_sent'), 'send is audited');
  }

  { // provider rejection surfaces to the caller (call sites .catch it)
    const { fetchImpl } = await captureFetch(500);
    await assert.rejects(() => sendFounderAlert({ platform: { users: [{ role: 'platform_owner', status: 'Active', email: 'a@b.c' }] }, subject: 'S', title: 'T', lines: [], env, fetchImpl, persist: async () => {} }), /rejected/, 'provider errors reject so fire-and-forget sites can log them');
  }

  { // demo request: enterprise signal from size or notes
    const { calls, fetchImpl } = await captureFetch();
    const platform = { users: [{ role: 'platform_owner', status: 'Active', email: 'levie@example.com' }] };
    await demoRequestAlert({ platform, row: { name: 'Sam', email: 'sam@acme.com', company: 'Acme', companySize: '76+ employees', notes: '', phone: '', preferredTime: '' }, env, fetchImpl, persist: async () => {} });
    assert.match(JSON.parse(calls[0][1].body).subject, /enterprise/, 'enterprise demo requests are flagged in the subject');
    await demoRequestAlert({ platform, row: { name: 'Sam', email: 'sam@acme.com', company: 'Acme', companySize: '11–30 employees', notes: 'Asked about enterprise rollout', phone: '', preferredTime: '' }, env, fetchImpl, persist: async () => {} });
    assert.match(JSON.parse(calls[1][1].body).subject, /enterprise/, 'enterprise mention in notes also flags the alert');
    await demoRequestAlert({ platform, row: { name: 'Sam', email: 'sam@acme.com', company: 'Acme', companySize: '11–30 employees', notes: '', phone: '', preferredTime: '' }, env, fetchImpl, persist: async () => {} });
    assert.doesNotMatch(JSON.parse(calls[2][1].body).subject, /enterprise/, 'standard demo requests are not flagged');
  }

  { // trial signup: founder badge and plan lines
    const { calls, fetchImpl } = await captureFetch();
    await trialSignupAlert({ platform: { users: [{ role: 'platform_owner', status: 'Active', email: 'levie@example.com' }] }, company: { name: 'Acme', plan: 'growth', billingCycle: 'annual', ownerName: 'Sam', email: 'sam@acme.com', employeeCount: 12, projectCount: 4, founder: true }, env, fetchImpl, persist: async () => {} });
    const payload = JSON.parse(calls[0][1].body);
    assert.match(payload.subject, /New trial — Acme \(growth\)/);
    assert.ok(payload.html.includes('FOUNDER COHORT'));
  }

  { // subscription activated: amount shown per cycle
    const { calls, fetchImpl } = await captureFetch();
    await subscriptionActivatedAlert({ platform: { users: [{ role: 'platform_owner', status: 'Active', email: 'levie@example.com' }] }, company: { name: 'Acme', plan: 'pro', billingCycle: 'monthly', planPrice: 399 }, env, fetchImpl, persist: async () => {} });
    const payload = JSON.parse(calls[0][1].body);
    assert.match(payload.subject, /Paying customer — Acme \(pro\)/);
    assert.ok(payload.html.includes('$399/mo'));
  }

  { // founder renewal review: internal milestone and action are explicit
    const { calls, fetchImpl } = await captureFetch();
    await renewalReviewAlert({ platform: { users: [{ role: 'platform_owner', status: 'Active', email: 'levie@example.com' }] },
      company: { name: 'Acme', plan: 'growth', billingCycle: 'annual' },
      reminder: { days: 60, protectedUntil: '2028-09-28T00:00:00.000Z' }, env, fetchImpl, persist: async () => {} });
    const payload = JSON.parse(calls[0][1].body);
    assert.match(payload.subject, /Founder review — Acme \(60 days\)/);
    assert.ok(payload.html.includes('September 28, 2028'));
    assert.ok(payload.html.includes('record the decision'));
  }

  // --- Server wiring contracts ----------------------------------------------
  assert.ok(server.includes("require('./founder-alerts')"), 'server loads the alerts module');
  const demoStart = server.indexOf('async function handleDemoRequest');
  const demoAlert = server.indexOf('demoRequestAlert');
  const demoPersist = server.indexOf('await writePlatform(platform)}catch{return json(res,503,{error:\'We could not confirm your demo request was saved');
  assert.ok(demoPersist > demoStart && demoAlert > demoPersist, 'demo requests persist before the non-blocking alert');
  const signupStart = server.indexOf('async function handleSignup');
  const trialAlert = server.indexOf('trialSignupAlert', signupStart);
  assert.ok(trialAlert > signupStart, 'trial signups alert from the signup handler');
  assert.ok(server.indexOf('wasNotActive=db.company.subscriptionStatus') < server.indexOf('subscriptionActivatedAlert'), 'Active transition is captured before the alert');
  assert.ok(server.indexOf("subscription.status==='trialing')db.company.subscriptionStatus='Incomplete'") < server.indexOf('subscriptionActivatedAlert'), 'paying alert fires after the founder-trialing adjustment, so founder trials do not false-positive');
  assert.ok(server.includes('retryFounderRenewalReviews'), 'server schedules founder renewal reviews');

  console.log('founder alerts: ok');
})().catch(error => { console.error(error); process.exit(1); });
