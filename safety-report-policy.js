'use strict';

const { safetyGate, profileFor } = require('./safety-engine');

// Safety answers are server-owned evidence, never a client-supplied assertion.
// The original snapshot stays attached to the daily when later checks change.
function applySafetyEvidence(db, report, actor = null) {
  // Only the server-resolved subcontractor guest route may create this
  // boundary marker. A normal authenticated report must never preserve a
  // client-supplied claim about who submitted external-employer evidence.
  if (report.source !== 'subcontractor') delete report.externalSafetyScope;
  if (report.status === 'Draft') return null;
  const project = db.projects?.[Number(report.project)];
  if (!project?.safetyProfile?.enabled) return null;
  // A subcontractor guest is a separate employer and cannot truthfully attest
  // the host contractor's competent-person checks. Accept their scoped daily,
  // label that boundary, and leave the host's canonical safety day untouched.
  if (report.source === 'subcontractor') {
    report.externalSafetyScope ||= {
      type: 'external_subcontractor', subcontractorId: report.subcontractorId ?? null,
      projectId: project.id, date: report.dateIso,
      submittedBy: { id: actor?.id ?? null, name: actor?.name || 'External subcontractor', role: actor?.role || 'subcontractor' },
      notice: 'Submitted by an external employer; host-contractor safety checks are recorded separately.',
      capturedAt: new Date().toISOString()
    };
    return null;
  }
  const gate = safetyGate(db, project.id, report.dateIso);
  if (!gate.canSubmit) return {
    status: 409,
    body: { error: gate.error || 'Review the required safety checks before submitting this daily.',
      code: 'SAFETY_CHECKS_REQUIRED', projectId: project.id, date: report.dateIso, safety: gate }
  };
  // The first non-draft capture is the submission evidence. Approval and later
  // report edits may re-run the current gate, but must never rewrite history.
  if (report.safetyEvidence && typeof report.safetyEvidence === 'object') return null;
  const day = (db.safetyDays || []).find(row => row.companyId === db.company.id && Number(row.projectId) === Number(project.id) && row.date === report.dateIso);
  const profile = profileFor(project, db.company);
  const submitterName = String(actor?.name || '').trim();
  report.safetyEvidence = structuredClone({
    dayId: day.id, dayRevision: day.revision, date: day.date,
    ruleVersion: day.ruleVersion, coverage: day.coverage, activities: day.activities,
    company: { id: db.company.id, name: db.company.name || '', timezone: db.company.timezone || 'America/Los_Angeles' },
    project: { id: project.id, name: project.name || '', address: project.site || project.address || '', jurisdiction: profile.state || '' },
    employer: profile.employer || db.company.name || '', profileRevision: profile.revision || 0,
    submittedBy: { id: actor?.id ?? null, name: submitterName || 'System record', role: actor?.role || 'system' },
    checks: day.checks, hazards: day.hazards, talks: day.talks || [],
    carriedHazards: (db.safetyDays || []).filter(row => row.companyId === db.company.id && Number(row.projectId) === Number(project.id) && row.date < report.dateIso)
      .flatMap(row => (row.hazards || []).filter(item => !['verified', 'voided'].includes(item.status)).map(item => ({ ...item, date: row.date }))),
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
  const deleting = req.method === 'DELETE' && url.pathname.match(/^\/api\/reports\/(\d+)$/);
  if (!creating && !editing && !deleting) return false;
  const db = readDb(), input = await body(req);
  let report, saved = null;
  if (creating) {
    const project = input.projectId != null
      ? (db.projects || []).findIndex(row => Number(row.id) === Number(input.projectId))
      : Number(input.project);
    report = { project, dateIso: input.dateIso, status: input.status === 'Draft' ? 'Draft' : 'Submitted' };
  } else {
    const id = Number((editing || deleting)[1]);
    saved = (db.reports || []).find(row => Number(row.id) === id);
    if (!saved) return false;
    report = { ...saved, dateIso: Object.hasOwn(input, 'dateIso') ? input.dateIso : saved.dateIso,
      status: deleting ? saved.status : editing[2] ? 'Approved' : Object.hasOwn(input, 'status') ? input.status : saved.status };
  }
  const project = db.projects?.[Number(report.project)];
  if (project?.safetyProfile?.enabled && authenticatedUser) {
    const user = authenticatedUser(req, db);
    if (!user) { json(res, 401, { error: 'Authentication required' }); return true; }
    if (!canAccessProject(db, user, project.id)) { json(res, 404, { error: 'Project not found' }); return true; }
  }
  if (deleting) {
    if (!saved.safetyEvidence) return false;
    json(res, 409, { error: 'This submitted daily contains an immutable safety record and cannot be deleted. Keep it as the historical record and add a correction instead.', code: 'SAFETY_RECORD_IMMUTABLE' });
    return true;
  }
  if (saved?.safetyEvidence && Object.hasOwn(input, 'dateIso') && input.dateIso !== saved.dateIso) {
    json(res, 409, { error: 'The work date is locked because this daily already contains a submitted safety record. Add a corrected daily for the right date.', code: 'SAFETY_RECORD_IMMUTABLE' });
    return true;
  }
  if (saved?.safetyEvidence && input.status === 'Draft') {
    json(res, 409, { error: 'A submitted safety record cannot be returned to Draft. Correct the daily while keeping its submission history.', code: 'SAFETY_RECORD_IMMUTABLE' });
    return true;
  }
  const denied = applySafetyEvidence(db, report, authenticatedUser ? authenticatedUser(req, db) : null);
  if (!denied) return false;
  json(res, denied.status, denied.body);
  return true;
}

module.exports = { applySafetyEvidence, guardSafetyReportRequest };
