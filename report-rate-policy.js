'use strict';
const crypto = require('node:crypto');
const applicable = project => ['tm', 'hybrid'].includes(project?.contractType);
const approvedBefore = report => report.status === 'Approved' || (report.history || []).some(row => row.action === 'Approved') || Boolean(report.rateReview || report.rateSnapshot);
function amount(value) {
  if (!['number','string'].includes(typeof value) || String(value).trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}
function validSnapshot(snapshot) { return snapshot?.schemaVersion === 1 && amount(snapshot.laborRate) !== null && Boolean(snapshot.capturedAt && snapshot.capturedBy?.id != null); }
function withoutReportRates(report) {
  const { rateSnapshot, rateHistory, rateReview, ...safe } = report;
  return safe;
}
function captureFirstApproval(report, project, actor, now) {
  if (!applicable(project) || validSnapshot(report.rateSnapshot)) return;
  if (approvedBefore(report)) {
    report.rateReview = { status: 'Required', reason: 'legacy_missing_rate_snapshot' };
    return;
  }
  const rate = amount(project.tmSettings?.defaultLaborRate);
  if (rate === null) {
    report.rateReview = { status: 'Required', reason: 'missing_project_rate_at_approval' };
    return;
  }
  report.rateSnapshot = snapshot(project, rate, actor, now, 'first-office-approval');
}
function snapshot(project, laborRate, actor, now, source) {
  return { schemaVersion: 1, laborRate, materialMarkup: amount(project.tmSettings?.materialMarkup), equipmentMarkup: amount(project.tmSettings?.equipmentMarkup),
    capturedAt: now, capturedBy: { id: actor.id, name: actor.name, role: actor.role }, source };
}
function reviewRate(report, project, input, actor, now) {
  const fail = (message, statusCode = 400) => { throw Object.assign(new Error(message), { statusCode }); };
  if (!applicable(project) || !approvedBefore(report)) fail('Rate review requires a previously approved T&M or hybrid daily', 409);
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Rate review must be an object');
  if (Object.keys(input).some(key => !['laborRate', 'reason', 'evidenceReference'].includes(key))) fail('Only laborRate, reason and evidenceReference are supported');
  if (typeof input.reason !== 'string' || (input.evidenceReference != null && typeof input.evidenceReference !== 'string')) fail('Reason and evidence reference must be text');
  const rate = amount(input.laborRate), reason = String(input.reason || '').trim(), evidence = String(input.evidenceReference || '').trim();
  if (rate === null) fail('Labor rate must be an explicit non-negative number');
  if (!reason || reason.length > 1000) fail('Provide a rate review reason of 1–1000 characters');
  const previous = validSnapshot(report.rateSnapshot) ? structuredClone(report.rateSnapshot) : null;
  if (!previous && (!evidence || evidence.length > 1000)) fail('Missing historical rates require an evidence reference of 1–1000 characters');
  if (evidence.length > 1000) fail('Evidence reference is too long');
  const next = previous ? { ...previous, laborRate: rate, capturedAt: now, capturedBy: { id: actor.id, name: actor.name, role: actor.role }, source: 'audited-adjustment' } : { ...snapshot(project, rate, actor, now, 'legacy-review'), materialMarkup: null, equipmentMarkup: null };
  report.rateSnapshot = next;
  report.rateHistory ||= [];
  report.rateHistory.push({ id: crypto.randomUUID(), previous, next: structuredClone(next), reason, evidenceReference: evidence, actor: { id: actor.id, name: actor.name, role: actor.role }, at: now });
  report.rateReview = { status: 'Reviewed', reviewedAt: now, reviewedBy: actor.id };
  return next;
}
function summarizeRates(db, projectIndex, reports = (db.reports || []).filter(row => row.project === projectIndex && row.status === 'Approved')) {
  const groups = new Map(), missingRateReports = [];
  let laborHours = 0, knownLaborAmount = 0;
  for (const report of reports) {
    const complete = validSnapshot(report.rateSnapshot), rate = complete ? report.rateSnapshot.laborRate : null;
    if (!complete) missingRateReports.push({ reportId: report.id, dateIso: report.dateIso || null, reason: report.rateReview?.reason || 'legacy_missing_rate_snapshot' });
    for (const entry of report.laborEntries || []) {
      const excluded = (report.laborExclusions || []).find(row => Number(row.memberId) === Number(entry.memberId));
      const hours = Math.max(0, (Number(entry.hours) || 0) - (excluded ? Number(excluded.hours) || Number(entry.hours) || 0 : 0));
      const classification = (db.team || []).find(member => Number(member.id) === Number(entry.memberId))?.role || 'Unclassified labor';
      laborHours += hours;
      if (complete) knownLaborAmount += hours * rate;
      const key = JSON.stringify([classification, rate]), group = groups.get(key) || { classification, rate, hours: 0, amount: complete ? 0 : null };
      group.hours += hours;if (complete) group.amount += hours * rate;groups.set(key, group);
    }
  }
  return { approvedDailies: reports.length, laborHours, complete: missingRateReports.length === 0, laborAmount: missingRateReports.length ? null : knownLaborAmount, knownLaborAmount,
    labor: [...groups.values()], missingRateReports };
}
module.exports = { applicable, approvedBefore, captureFirstApproval, reviewRate, summarizeRates, withoutReportRates, validSnapshot, amount };
