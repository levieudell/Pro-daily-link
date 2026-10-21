'use strict';
// Founder alerts — instant email to platform owners when money-moment events
// happen: demo requests (with an enterprise signal), trial signups, and the
// first time a subscription becomes Active.
//
// Every call site is fire-and-forget: an alert must never break the request
// that triggered it, and a missing email configuration must never break the
// app. Set PDL_FOUNDER_ALERTS=0 to silence the emails (audit events still
// record that an alert was suppressed).

function platformOwnerRecipients(platform) {
  return (platform.users || [])
    .filter(user => user.role === 'platform_owner' && user.status === 'Active' && Boolean(user.email))
    .map(user => user.email);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function buildAlertEmail({ badge, title, lines }) {
  const rows = (lines || []).map(([label, value]) =>
    `<tr><td style="padding:6px 14px 6px 0;color:#68716d;font-size:12px;text-transform:uppercase;letter-spacing:.04em;vertical-align:top;white-space:nowrap">${escapeHtml(label)}</td><td style="padding:6px 0;font-size:14px">${escapeHtml(value)}</td></tr>`).join('');
  return `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#111416">` +
    (badge ? `<p style="display:inline-block;background:#10251e;color:#ffd9a8;padding:4px 10px;border-radius:6px;font-size:11px;font-weight:700;letter-spacing:.06em">${escapeHtml(badge)}</p>` : '') +
    `<h1 style="font-size:22px;margin:8px 0 4px">${escapeHtml(title)}</h1>` +
    `<table style="border-collapse:collapse;margin-top:8px">${rows}</table>` +
    `<p style="color:#68716d;font-size:12px;margin-top:16px">Sent by Pro Daily Link · <a href="https://app.prodailylink.com/platform.html">Open the founder console</a></p></div>`;
}

async function sendFounderAlert({ platform, subject, badge, title, lines, env = process.env, fetchImpl = fetch, persist = null }) {
  if (env.PDL_FOUNDER_ALERTS === '0') {
    (platform.auditEvents ||= []).push({ id: crypto.randomUUID(), action: 'founder_alert_suppressed', actorName: 'System', reason: subject, companyId: null, at: new Date().toISOString() });
    if (persist) await persist(platform);
    return { sent: false, reason: 'disabled' };
  }
  const recipients = platformOwnerRecipients(platform);
  if (!recipients.length) return { sent: false, reason: 'no-recipients' };
  if (!env.RESEND_API_KEY) {
    (platform.auditEvents ||= []).push({ id: crypto.randomUUID(), action: 'founder_alert_skipped', actorName: 'System', reason: `${subject} (email not configured)`, companyId: null, at: new Date().toISOString() });
    if (persist) await persist(platform);
    return { sent: false, reason: 'email-not-configured' };
  }
  const response = await fetchImpl('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json', 'User-Agent': 'ProDailyLink/1.0' },
    body: JSON.stringify({
      from: env.RESEND_FROM || 'Pro Daily Link <support@prodailylink.com>',
      reply_to: env.RESEND_REPLY_TO || 'support@prodailylink.com',
      to: recipients,
      subject,
      html: buildAlertEmail({ badge, title, lines }),
    }),
  });
  if (!response.ok) throw new Error(`Email provider rejected the founder alert (${response.status})`);
  (platform.auditEvents ||= []).push({ id: crypto.randomUUID(), action: 'founder_alert_sent', actorName: 'System', reason: subject, companyId: null, at: new Date().toISOString() });
  if (persist) await persist(platform);
  return { sent: true, recipients };
}

function demoRequestAlert({ platform, row, persist, env, fetchImpl }) {
  const enterprise = row.companySize === '76+ employees' || /enterprise/i.test(row.notes || '');
  return sendFounderAlert({
    platform,
    persist,
    env,
    fetchImpl,
    badge: enterprise ? 'ENTERPRISE SIGNAL' : null,
    subject: `[Pro Daily Link] Demo request — ${row.company}${enterprise ? ' (enterprise)' : ''}`,
    title: `${row.name} requested a demo`,
    lines: [
      ['Company', row.company],
      ['Contact', `${row.name} <${row.email}>`],
      ...(row.phone ? [['Phone', row.phone]] : []),
      ...(row.companySize ? [['Size', row.companySize]] : []),
      ...(row.preferredTime ? [['Preferred time', row.preferredTime]] : []),
      ...(row.notes ? [['Notes', row.notes]] : []),
    ],
  });
}

function trialSignupAlert({ platform, company, persist, env, fetchImpl }) {
  return sendFounderAlert({
    platform,
    persist,
    env,
    fetchImpl,
    badge: company.founder ? 'FOUNDER COHORT' : null,
    subject: `[Pro Daily Link] New trial — ${company.name} (${company.plan})`,
    title: `${company.name} started a trial`,
    lines: [
      ['Plan', `${company.plan} · ${company.billingCycle}`],
      ['Owner', `${company.ownerName} <${company.email}>`],
      ['Team size', `${company.employeeCount} employees · ${company.projectCount} projects`],
    ],
  });
}

function subscriptionActivatedAlert({ platform, company, persist, env, fetchImpl }) {
  return sendFounderAlert({
    platform,
    persist,
    env,
    fetchImpl,
    subject: `[Pro Daily Link] Paying customer — ${company.name} (${company.plan})`,
    title: `${company.name} is now paying`,
    lines: [
      ['Plan', `${company.plan} · ${company.billingCycle}`],
      ['Amount', `$${Number(company.planPrice || 0).toLocaleString()}${company.billingCycle === 'annual' ? '/yr' : '/mo'}`],
    ],
  });
}

function renewalReviewAlert({ platform, company, reminder, persist, env, fetchImpl }) {
  const deadline = new Date(reminder.protectedUntil).toLocaleDateString('en-US', { timeZone: 'UTC', year: 'numeric', month: 'long', day: 'numeric' });
  return sendFounderAlert({
    platform,
    persist,
    env,
    fetchImpl,
    badge: 'FOUNDER RENEWAL REVIEW',
    subject: `[Pro Daily Link] Founder review — ${company.name} (${reminder.days} days)`,
    title: `${company.name} needs a founder renewal conversation`,
    lines: [
      ['Milestone', `${reminder.days}-day review`],
      ['Protected through', deadline],
      ['Plan', `${company.plan} · ${company.billingCycle}`],
      ['Next action', 'Contact the founder, agree on renewal terms, and record the decision before protection ends.'],
    ],
  });
}

module.exports = { platformOwnerRecipients, buildAlertEmail, sendFounderAlert, demoRequestAlert, trialSignupAlert, subscriptionActivatedAlert, renewalReviewAlert };
