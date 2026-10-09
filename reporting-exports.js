'use strict';
const crypto = require('node:crypto');
const csvCell = require('./csv-cell');
const rates = require('./report-rate-policy');

function fail(message, statusCode = 400) { throw Object.assign(new Error(message), { statusCode }); }
function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
function createReportingExport(db, input, actor, now = new Date().toISOString()) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Export filters must be an object');
  const allowed = new Set(['projectId', 'from', 'to', 'supersedesId', 'reason']);
  if (Object.keys(input).some(key => !allowed.has(key))) fail('Supported filters are projectId, from and to; version controls are supersedesId and reason; status is always Approved');
  if (!validDate(input.from) || !validDate(input.to) || input.from > input.to) fail('Choose a valid inclusive date range');
  const index = (db.projects || []).findIndex(project => String(project.id) === String(input.projectId));
  if (index < 0) fail('Project not found', 404);
  const project = db.projects[index];
  const prior = (db.reportingExports || []).filter(record => String(record.companyId) === String(db.company.id) &&
    String(record.filters.projectId) === String(project.id) && record.filters.from === input.from && record.filters.to === input.to);
  const latest = prior.at(-1), reason = String(input.reason || '').trim();
  if (input.reason != null && typeof input.reason !== 'string') fail('Export reason must be text');
  if (latest && input.supersedesId !== latest.id) fail('Use the latest export version as supersedesId before creating a correction', 409);
  if (!latest && input.supersedesId) fail('Prior export does not match this project and period', 409);
  if ((latest && !reason) || reason.length > 1000) fail('A new version requires a reason of 1–1000 characters');
  const approved = (db.reports || []).filter(report => report.project === index && report.status === 'Approved');
  // A display label such as "Oct 4" has no year; never silently assign it to a period.
  if (approved.some(report => !validDate(report.dateIso))) fail('Approved reports need explicit ISO dates before a period export can be captured', 409);
  const reports = approved.filter(report => report.dateIso >= input.from && report.dateIso <= input.to)
    .sort((a, b) => a.dateIso.localeCompare(b.dateIso) || String(a.id).localeCompare(String(b.id)));
  const quantities = new Map();
  let laborHours = 0;
  for (const report of reports) {
    for (const entry of report.laborEntries || []) {
      const excluded = (report.laborExclusions || []).find(row => Number(row.memberId) === Number(entry.memberId));
      const hours = Math.max(0, (Number(entry.hours) || 0) - (excluded ? Number(excluded.hours) || Number(entry.hours) || 0 : 0));
      if (!Number.isFinite(hours) || hours < 0) fail('Approved labor contains an invalid value', 409);
      laborHours += hours;
    }
    for (const entry of report.productionEntries || []) {
      const quantity = Number(entry.quantity || 0);
      if (!Number.isFinite(quantity) || quantity < 0) fail('Approved production contains an invalid value', 409);
      const identity = JSON.stringify([entry.estimateItemId ?? null, entry.description || '', entry.unit || '']);
      const total = quantities.get(identity) || { estimateItemId: entry.estimateItemId ?? null, description: entry.description || '', unit: entry.unit || '', quantity: 0 };
      total.quantity += quantity;
      quantities.set(identity, total);
    }
  }
  const financial = rates.applicable(project) ? rates.summarizeRates(db, index, reports) : null;
  const memberIds = new Set(reports.flatMap(report => (report.laborEntries || []).map(entry => Number(entry.memberId))));
  const team = (db.team || []).filter(member => memberIds.has(Number(member.id))).map(({id,name,role,crew}) => ({id,name,role,crew}));
  const snapshot = structuredClone({ project, reports, team, totals: { approvedReports: reports.length, laborHours, production: [...quantities.values()], financial } });
  const snapshotJson = JSON.stringify(snapshot);
  const id = crypto.randomUUID();
  return {
    id, companyId: db.company.id, schemaVersion: 2, seriesId: latest?.seriesId || prior[0]?.id || id,
    version: latest ? (latest.version || prior.length) + 1 : 1, supersedesId: latest?.id || null, reason,
    kind: 'approved-period-snapshot', filters: { projectId: project.id, from: input.from, to: input.to, status: 'Approved' },
    createdBy: { id: actor.id, name: actor.name, role: actor.role }, createdAt: now,
    includedApprovals: reports.map(report => ({ reportId: report.id, history: structuredClone((report.history || []).filter(entry => entry.action === 'Approved')) })),
    snapshotSha256: crypto.createHash('sha256').update(snapshotJson).digest('hex'), snapshot
  };
}
function reportingExportCsv(record) {
  const rows = [['Export ID','Version','Type','Report ID','Date','Description','Quantity','Unit','Labor hours','Captured labor rate','Labor amount','Rate status']];
  const tm = rates.applicable(record.snapshot.project);
  for (const report of record.snapshot.reports) {
    const known = rates.validSnapshot(report.rateSnapshot), rate = tm && known ? report.rateSnapshot.laborRate : null;
    const status = !tm ? 'Not applicable' : known ? 'Captured' : 'Review required';
    for (const entry of report.productionEntries || []) rows.push([record.id, record.version || 1, 'Production', report.id, report.dateIso, entry.description || '', entry.quantity, entry.unit || '', entry.laborHours || 0, '', '', '']);
    for (const entry of report.laborEntries || []) {
      const member = (record.snapshot.team || []).find(row => Number(row.id) === Number(entry.memberId));
      const excluded = (report.laborExclusions || []).find(row => Number(row.memberId) === Number(entry.memberId));
      const counted = Math.max(0, (Number(entry.hours) || 0) - (excluded ? Number(excluded.hours) || Number(entry.hours) || 0 : 0));
      rows.push([record.id, record.version || 1, 'Labor', report.id, report.dateIso, member ? `${member.name} (${member.role || 'Unclassified labor'})` : `Member ${entry.memberId ?? ''}`, '', '', counted, rate ?? '', rate === null ? '' : Number(counted) * rate, status]);
    }
  }
  return rows.map(row => row.map(csvCell).join(',')).join('\r\n');
}
module.exports = { createReportingExport, reportingExportCsv };
