'use strict';

const { estimateActuals } = require('./mcp/estimate');
const reportRates = require('./report-rate-policy');

const DAY_MS = 24 * 60 * 60 * 1000;

function round(value) { return Math.round((Number(value) || 0) * 100) / 100; }
function dateValue(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const time = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isFinite(time) ? time : null;
}
function dayDifference(later, earlier) {
  const after = dateValue(later), before = dateValue(earlier);
  return after == null || before == null ? null : Math.round((after - before) / DAY_MS);
}
function metric(estimated, actual) {
  const actualValue = round(actual);
  if (estimated == null) return { estimated: null, actual: actualValue, variance: null, percent: null };
  const estimateValue = round(estimated);
  return {
    estimated: estimateValue,
    actual: actualValue,
    variance: round(actualValue - estimateValue),
    percent: estimateValue === 0 ? null : round(actualValue / estimateValue * 100)
  };
}
function text(value) {
  if (typeof value === 'string') return value.trim();
  if (value === true) return 'Reported';
  if (value && typeof value === 'object') return String(value.text || value.message || value.description || value.observation || value.notes || value.result || value.action || '').trim();
  return '';
}
function addIssue(list, report, type, value) {
  const values = Array.isArray(value) ? value : [value];
  for (const item of values) {
    const detail = text(item);
    if (detail) list.push({ reportId: report.id, dateIso: report.dateIso || null, type, text: detail });
  }
}
function materialLines(reports) {
  const rows = [];
  for (const report of reports) {
    const entries = Array.isArray(report.materials) ? report.materials : [report.materials];
    for (const entry of entries) {
      const detail = text(entry);
      if (detail) rows.push({ reportId: report.id, dateIso: report.dateIso || null, text: detail });
    }
  }
  return rows;
}
function savedDebrief(project) {
  const saved = project.debrief || {};
  return {
    wentWell: typeof saved.wentWell === 'string' ? saved.wentWell : '',
    wentWrong: typeof saved.wentWrong === 'string' ? saved.wentWrong : '',
    doDifferently: typeof saved.doDifferently === 'string' ? saved.doDifferently : '',
    rating: Number.isInteger(saved.rating) && saved.rating >= 1 && saved.rating <= 5 ? saved.rating : null,
    updatedAt: saved.updatedAt || null,
    updatedBy: saved.updatedBy || null
  };
}

function computeJobDebrief(db, projectId, options = {}) {
  const projectIndex = (db.projects || []).findIndex(row => Number(row.id) === Number(projectId));
  if (projectIndex < 0) return null;
  const sourceProject = db.projects[projectIndex], project = options.project || sourceProject;
  const reports = (db.reports || []).filter(report => Number(report.project) === projectIndex && report.status === 'Approved');
  const reportDates = reports.map(report => report.dateIso).filter(value => dateValue(value) != null).sort();
  const actuals = estimateActuals(db).find(row => Number(row.projectId) === Number(projectId))?.items || [];
  const items = actuals.map(item => ({
    estimateItemId: item.estimateItemId,
    name: item.name,
    unit: item.unit || '',
    quantity: metric(item.plannedQuantity, item.actualQuantity),
    hours: metric(item.budgetHours, item.actualLaborHours)
  }));
  const allHoursEstimated = items.every(item => item.hours.estimated != null);
  const totals = {
    quantity: metric(items.reduce((sum, item) => sum + Number(item.quantity.estimated || 0), 0), items.reduce((sum, item) => sum + item.quantity.actual, 0)),
    hours: metric(allHoursEstimated ? items.reduce((sum, item) => sum + item.hours.estimated, 0) : null, items.reduce((sum, item) => sum + item.hours.actual, 0))
  };
  const issues = [];
  for (const report of reports) {
    addIssue(issues, report, 'delay', report.delays);
    addIssue(issues, report, 'issue', report.issue);
    addIssue(issues, report, 'flag', report.flags);
    addIssue(issues, report, 'safety_incident', report.safetyIncident);
    addIssue(issues, report, 'safety_item', report.safetyItems);
    addIssue(issues, report, 'safety_inspection', report.safetyInspection);
  }
  const changes = (db.changes || []).filter(change => Number(change.projectId) === Number(projectId));
  const summary = options.changeSummary || {};
  const changeOrders = {
    count: changes.length,
    awaitingDecision: Number(summary.awaitingDecision) || 0,
    openItems: Number(summary.openItems) || 0,
    approvedCount: Number(summary.approvedCount) || 0
  };
  if (options.includePricing === true) {
    changeOrders.openExposure = Number(summary.openExposure) || 0;
    changeOrders.approvedTotal = Number(summary.approvedTotal) || 0;
  }
  const lifecycleStatus = project.lifecycleStatus || project.status || null;
  const result = {
    projectId: sourceProject.id,
    projectName: sourceProject.name,
    lifecycleStatus,
    completed: String(lifecycleStatus || '').toLowerCase() === 'completed',
    dates: {
      plannedStart: project.startDate || null,
      plannedEnd: project.endDate || null,
      actualStart: reportDates[0] || null,
      actualEnd: reportDates.at(-1) || null,
      daysOverUnderPlan: reportDates.length ? dayDifference(reportDates.at(-1), project.endDate) : null
    },
    weatherDays: reports.filter(report => report.weatherDay === true).length,
    delayDays: reports.filter(report => report.delayDay === true).length,
    production: { items, totals },
    materials: materialLines(reports),
    changeOrders,
    issues,
    debrief: savedDebrief(sourceProject)
  };
  if (options.includePricing === true) {
    const rateSummary = reportRates.summarizeRates(db, projectIndex, reports);
    result.laborCost = rateSummary.laborAmount == null ? null : round(rateSummary.laborAmount);
    result.laborCostComplete = rateSummary.complete;
    result.laborRates = rateSummary.labor.map(row => ({ ...row, hours: round(row.hours), amount: row.amount == null ? null : round(row.amount) }));
    result.missingRateReports = rateSummary.missingRateReports;
  }
  return result;
}

module.exports = { computeJobDebrief, dayDifference, metric };
