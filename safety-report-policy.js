'use strict';

const { safetyGate } = require('./safety-engine');

// Safety answers are server-owned evidence, never a client-supplied assertion.
// The original snapshot stays attached to the daily when later checks change.
function applySafetyEvidence(db, report) {
  if (report.status === 'Draft') return null;
  const project = db.projects?.[Number(report.project)];
  if (!project?.safetyProfile?.enabled) return null;
  const gate = safetyGate(db, project.id, report.dateIso);
  if (!gate.canSubmit) return {
    status: 409,
    body: { error: gate.error || 'Review the required safety checks before submitting this daily.',
      code: 'SAFETY_CHECKS_REQUIRED', projectId: project.id, date: report.dateIso, safety: gate }
  };
  const day = (db.safetyDays || []).find(row => row.companyId === db.company.id && Number(row.projectId) === Number(project.id) && row.date === report.dateIso);
  report.safetyEvidence = structuredClone({
    dayId: day.id, dayRevision: day.revision, date: day.date,
    ruleVersion: day.ruleVersion, coverage: day.coverage, activities: day.activities,
    checks: day.checks, hazards: day.hazards,
    carriedHazards: (db.safetyDays || []).filter(row => row.companyId === db.company.id && Number(row.projectId) === Number(project.id) && row.date < report.dateIso)
      .flatMap(row => (row.hazards || []).filter(item => item.status !== 'verified').map(item => ({ ...item, date: row.date }))),
    summary: gate,
    capturedAt: new Date().toISOString()
  });
  return null;
}

// Run before any report mutations, including direct HTTP and office approval.
// Closing a time clock still creates a Draft and is deliberately never blocked.
async function guardSafetyReportRequest(req, res, url, { readDb, body, json, authenticatedUser, canAccessProject }) {
  const creating = req.method === 'POST' && url.pathname === '/api/reports';
  const editing = req.method === 'PATCH' && url.pathname.match(/^\/api\/reports\/(\d+)(\/approve)?$/);
  if (!creating && !editing) return false;
  const db = readDb(), input = await body(req);
  let report;
  if (creating) {
    const project = input.projectId != null
      ? (db.projects || []).findIndex(row => Number(row.id) === Number(input.projectId))
      : Number(input.project);
    report = { project, dateIso: input.dateIso, status: input.status === 'Draft' ? 'Draft' : 'Submitted' };
  } else {
    const saved = (db.reports || []).find(row => Number(row.id) === Number(editing[1]));
    if (!saved) return false;
    report = { ...saved, dateIso: Object.hasOwn(input, 'dateIso') ? input.dateIso : saved.dateIso,
      status: editing[2] ? 'Approved' : Object.hasOwn(input, 'status') ? input.status : saved.status };
  }
  const project = db.projects?.[Number(report.project)];
  if (project?.safetyProfile?.enabled && authenticatedUser) {
    const user = authenticatedUser(req, db);
    if (!user) { json(res, 401, { error: 'Authentication required' }); return true; }
    if (!canAccessProject(db, user, project.id)) { json(res, 404, { error: 'Project not found' }); return true; }
  }
  const denied = applySafetyEvidence(db, report);
  if (!denied) return false;
  json(res, denied.status, denied.body);
  return true;
}

module.exports = { applySafetyEvidence, guardSafetyReportRequest };
