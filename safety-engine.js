'use strict';

// This starter pack records human inspections. It is not an exhaustive legal
// assessment, a competent-person qualification, or permission to start work.
const crypto = require('node:crypto');
const { validDate } = require('./schedule-availability');
const VERSION = 'or-starter-2026-10-26.1';
const SOURCES = Object.freeze({
  general: 'https://osha.oregon.gov/OSHARules/div3/div3c.pdf',
  fall: 'https://osha.oregon.gov/OSHARules/div3/div3m.pdf',
  excavation: 'https://osha.oregon.gov/OSHARules/div3/div3p.pdf',
  demolition: 'https://osha.oregon.gov/OSHARules/div3/div3t.pdf'
});
const CATALOG = Object.freeze([
  { id: 'roofing', label: 'Roofing', description: 'Roof access, fall protection, holes and skylights.', source: SOURCES.fall, version: VERSION },
  { id: 'excavation', label: 'Excavation', description: 'Competent-person inspection, utilities, protection and access.', source: SOURCES.excavation, version: VERSION },
  { id: 'framing', label: 'Framing', description: 'Edges, openings and changing work surfaces.', source: SOURCES.fall, version: VERSION },
  { id: 'demolition', label: 'Demolition', description: 'Pre-demolition survey, utilities and safe work sequence.', source: SOURCES.demolition, version: VERSION }
]);
const ROLES = new Set(['owner', 'admin', 'project_manager', 'foreman', 'field']);
const MANAGERS = new Set(['owner', 'admin', 'project_manager']);
const STATUSES = new Set(['pending', 'pass', 'fail', 'deferred', 'not_applicable']);
const COVERAGE_NOTICE = 'Oregon starter coverage only. Confirm actual work, site conditions and additional requirements with your safety lead. Completed records do not certify OSHA compliance or authorize unsafe work.';
const clone = value => structuredClone(value);
const fail = (message, statusCode = 400, code = 'SAFETY_VALIDATION') => Object.assign(new Error(message), { statusCode, code });
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
function text(value, label, max = 1500) {
  if (value == null) return '';
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) throw fail(`Enter valid ${label} (${max} characters maximum)`);
  return value.trim();
}
function inputKeys(input, allowed) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !allowed.includes(key))) throw fail('Unsupported safety fields');
}
function exactDate(value) { if (typeof value !== 'string' || !validDate(value)) throw fail('Use an exact work date (YYYY-MM-DD)'); return value; }
function inferredState(project) {
  // Parse the state suffix, never a street name. This is a conservative address
  // hint, not geocoding; an unrecognized address needs explicit confirmation.
  for (const value of [project?.siteState, project?.addressState, project?.state]) {
    const code = String(value || '').trim().toUpperCase();
    if (/^(AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC)$/.test(code)) return code;
  }
  const address = String(project?.site || project?.address || '').trim();
  const postal = address.match(/(?:^|[,\s])(AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC)\s*(?:\d{5}(?:-\d{4})?)?(?:\s*,?\s*(?:USA|United States))?\s*$/i);
  if (postal) return postal[1].toUpperCase();
  const full = address.match(/\b(Oregon|Washington|California)(?:\s+\d{5}(?:-\d{4})?)?(?:\s*,?\s*(?:USA|United States))?\s*$/i);
  if (full) return ({ oregon: 'OR', washington: 'WA', california: 'CA' })[full[1].toLowerCase()];
  return '';
}
function storedProfileFor(project) {
  const stored = project.safetyProfile;
  return stored ? clone(stored) : { revision: 0, enabled: false, state: inferredState(project), employer: '', activities: [] };
}
function profileFor(project, company) {
  const profile = storedProfileFor(project), detected = inferredState(project), employer = String(company?.name || '').trim();
  profile.state = detected;
  profile.employer = employer;
  return profile;
}
function coverageFor(project, company) {
  const state = profileFor(project, company).state, detected = inferredState(project);
  return state === 'OR' && detected === state ? 'oregon-starter' : 'manual-review';
}
function ownDays(db, projectId) { return (db.safetyDays || []).filter(day => day.companyId === db.company.id && day.projectId === projectId); }
function dayFor(db, projectId, date) { return ownDays(db, projectId).find(day => day.date === date); }
function scheduleContext(db, projectId, date) {
  const assignments = (db.assignments || []).filter(row => Number(row.projectId) === projectId && row.date === date)
    .map(row => ({ kind: 'assignment', id: row.id, task: String(row.task || row.name || ''), instructions: String(row.instructions || row.notes || ''), start: row.start || '', end: row.end || '', memberIds: [...(row.memberIds || [])].map(Number).sort((a, b) => a - b) }));
  const tasks = (db.projectTasks || []).filter(row => Number(row.projectId) === projectId && validDate(row.startDate) && row.startDate <= date && validDate(row.endDate || row.startDate) && (row.endDate || row.startDate) >= date && !row.deletedAt)
    .map(row => ({ kind: 'projectTask', id: row.id, task: String(row.name || row.task || ''), instructions: `${row.description || ''} ${row.instructions || ''}`, start: row.startDate, end: row.endDate || row.startDate, memberIds: [...(row.memberIds || [])].map(Number).sort((a, b) => a - b) }));
  return [...assignments, ...tasks]
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
}
function dayContext(db, project, date) {
  const profile = profileFor(project, db.company), schedule = scheduleContext(db, project.id, date), activities = new Set(profile.activities);
  const words = schedule.map(row => `${row.task} ${row.instructions}`).join(' ');
  for (const [activity, pattern] of Object.entries({ roofing: /\broof(?:ing|er|ers)?\b/i, excavation: /\b(?:excavat\w*|trench\w*|digging)\b/i, framing: /\bfram(?:e|ing|ers?)\b/i, demolition: /\b(?:demolition|demo|demolish\w*)\b/i })) if (pattern.test(words)) activities.add(activity);
  return { profile, schedule, activities: [...activities].sort(), fingerprint: hash({ profile, schedule, ruleVersion: VERSION, address: String(project.site || project.address || '') }) };
}
function check(id, title, activity, description, source, extra = {}) {
  return { id, title, activity, description, source, ruleVersion: VERSION, timing: 'Before work and when conditions change', requiresCompetentPerson: false,
    status: 'pending', notes: '', inspector: '', competentPerson: '', action: '', owner: '', dueDate: '', workStopped: false, ...extra };
}
function checksFor(activities) {
  const checks = [
    check('scope-confirmation', "Confirm today's work and actual site conditions", 'general', 'Review scheduled and unscheduled work, exposures and other employers. Add missing activities before confirming. This starter does not cover every trade or hazard.', SOURCES.general),
    check('site-walk', 'Walk the work area and address immediate hazards', 'general', 'Document findings, access and housekeeping; identify who can stop work and the emergency arrangements. Reinspect when conditions change.', SOURCES.general)
  ];
  if (activities.includes('roofing')) checks.push(
    check('roofing-protection', 'Confirm roof access and the fall-protection system', 'roofing', 'Record actual height, slope, edge exposure and selected system. Warning lines are not permitted as fall protection above a 2:12 slope; work outside a line needs additional protection. Have the safety lead confirm the applicable system and rescue arrangements.', SOURCES.fall),
    check('roofing-openings', 'Protect roof holes and skylights', 'roofing', 'Check covers or equivalent protection and strength. A skylight fixture alone is not presumed to be an adequate cover.', SOURCES.fall)
  );
  if (activities.includes('excavation')) checks.push(
    check('excavation-inspection', 'Record the competent-person excavation inspection', 'excavation', 'Name the designated competent person and record inspection time, soil/site conditions, findings and corrective decisions. Reinspect after rain or other hazard-increasing events. Naming a person does not establish qualification.', SOURCES.excavation, { requiresCompetentPerson: true }),
    check('excavation-protection', 'Confirm excavation protection, utilities and safe access', 'excavation', 'Document depth, soil assessment, protective-system decision, utility location, access/egress, spoil/equipment placement and other exposures with the competent person. Do not enter until hazards are controlled.', SOURCES.excavation)
  );
  if (activities.includes('framing')) checks.push(check('framing-edges', 'Protect framing edges, holes and work surfaces', 'framing', 'Confirm the applicable fall-protection method, opening protection and safe access as the structure changes.', SOURCES.fall));
  if (activities.includes('demolition')) checks.push(check('demolition-survey', 'Confirm demolition survey, utilities and work sequence', 'demolition', 'Confirm the required competent-person engineering survey and utility controls before demolition. Record the responsible person, findings and safe sequence.', SOURCES.demolition, { requiresCompetentPerson: true }));
  return checks;
}
function checkComplete(row) {
  if (!STATUSES.has(row.status) || row.status === 'pending' || !row.inspector || !row.notes) return false;
  if (row.requiresCompetentPerson && row.status !== 'not_applicable' && !row.competentPerson) return false;
  if (row.status === 'not_applicable' && !row.notes) return false;
  if (['fail', 'deferred'].includes(row.status) && (!row.notes || !row.action || !row.owner || !row.dueDate || row.workStopped !== true)) return false;
  return true;
}
function unresolvedHazards(db, projectId, date) { return ownDays(db, projectId).filter(day => day.date <= date).flatMap(day => (day.hazards || []).filter(row => row.status !== 'verified').map(row => ({ ...clone(row), date: day.date, dayRevision: day.revision }))); }
function summarize(db, project, date, day) {
  const context = dayContext(db, project, date), stale = !day || day.fingerprint !== context.fingerprint;
  const pending = day ? day.checks.filter(row => !checkComplete(row)).length : checksFor(context.activities).length;
  const hazards = unresolvedHazards(db, project.id, date);
  // Every new failure creates a stable linked hazard. Historical failed checks
  // remain original evidence after that hazard is verified; do not count them
  // forever or silently discard them when the next calendar day begins.
  const unlinkedFailures = ownDays(db, project.id).filter(row => row.date <= date)
    .flatMap(row => (row.checks || []).filter(item => ['fail', 'deferred'].includes(item.status) && !(row.hazards || []).some(hazard => hazard.sourceCheckId === item.id)));
  const unresolved = unlinkedFailures.length + hazards.length;
  const undocumentedHazards = hazards.some(row => !row.action || !row.owner || !row.dueDate || row.workStopped !== true);
  const supported = coverageFor(project, db.company) === 'oregon-starter';
  const canSubmit = Boolean(day && !stale && supported && pending === 0 && !undocumentedHazards);
  return { pending, unresolved, canSubmit, readyForWork: canSubmit && unresolved === 0, stale,
    error: !supported ? 'This jurisdiction needs a reviewed rule pack before safety finalization.' : stale ? 'Generate or refresh today’s checks after the work, profile or schedule changed.' : pending ? 'Address every required safety check before finalizing the daily.' : undocumentedHazards ? 'Record stopped work, action, owner and due date for every open hazard.' : null };
}
function safetyGate(db, projectId, date) {
  const project = (db.projects || []).find(row => Number(row.id) === Number(projectId));
  if (!project || !profileFor(project, db.company).enabled) return { enabled: false, canSubmit: true, readyForWork: false, pending: 0, unresolved: 0 };
  if (!validDate(date)) return { enabled: true, canSubmit: false, readyForWork: false, pending: 1, unresolved: 0, error: 'A valid daily work date is required.' };
  return { enabled: true, ...summarize(db, project, date, dayFor(db, project.id, date)) };
}
function projectedDay(db, project, date, day) { return day ? { ...clone(day), summary: summarize(db, project, date, day) } : null; }
function audit(day, user, action, before, after) {
  day.history.push({ action, at: new Date().toISOString(), by: user.name, userId: user.id, before: clone(before), after: clone(after) });
}
function revision(input, current) {
  if (!Number.isSafeInteger(input.revision) || input.revision !== current) throw fail('Safety record changed. Refresh and review before saving again.', 409, 'SAFETY_REVISION_CONFLICT');
}
function createSafetyHandler({ readDb, writeDb, body, json, authenticatedUser, canAccessProject }) {
  return async function handleSafety(req, res, url) {
    const route = url.pathname.match(/^\/api\/projects\/(\d+)\/safety(?:\/(profile|days)(?:\/([^/]+))?(?:\/(checks|hazards)(?:\/([^/]+))?)?)?$/);
    if (!route) return false;
    const reply = (status, data) => { json(res, status, data); return true; };
    try {
      const db = clone(readDb()), user = authenticatedUser(req, db);
      if (!user || user.status && user.status !== 'Active' || user.companyId && user.companyId !== db.company.id) return reply(401, { error: 'Authentication required' });
      if (!ROLES.has(user.role)) return reply(403, { error: 'Project team permission required' });
      const projectId = Number(route[1]), project = Number.isSafeInteger(projectId) && (db.projects || []).find(row => Number(row.id) === projectId);
      if (!project || project.archived || !canAccessProject(db, user, projectId)) return reply(404, { error: 'Project not found' });
      const canManage = MANAGERS.has(user.role), profile = profileFor(project, db.company);
      if (req.method === 'GET' && !route[2]) {
        const date = exactDate(url.searchParams.get('date'));
        return reply(200, { profile, catalog: clone(CATALOG), date, day: projectedDay(db, project, date, dayFor(db, projectId, date)), coverage: coverageFor(project, db.company), notice: COVERAGE_NOTICE, inferredState: inferredState(project), canManage, openHazards: unresolvedHazards(db, projectId, date) });
      }
      const input = await body(req);
      if (req.method === 'PUT' && route[2] === 'profile' && !route[3]) {
        if (!canManage) return reply(403, { error: 'PM or office permission required to configure safety' });
        inputKeys(input, ['revision', 'enabled', 'state', 'employer', 'activities']); revision(input, profile.revision);
        if (typeof input.enabled !== 'boolean') throw fail('Confirm whether safety checks are enabled');
        if (Object.hasOwn(input, 'state') && (typeof input.state !== 'string' || input.state && !/^[A-Z]{2}$/.test(input.state))) throw fail('Use a valid two-letter project state');
        if (Object.hasOwn(input, 'employer')) text(input.employer, 'responsible employer', 200);
        if (!Array.isArray(input.activities) || input.activities.length > CATALOG.length || input.activities.some(id => !CATALOG.some(item => item.id === id))) throw fail('Choose supported work activities');
        const detected = inferredState(project);
        if (detected && input.state && input.state !== detected) throw fail('The project address changed. Refresh safety setup to use its current jurisdiction.');
        const employer = text(db.company?.name, 'company account name', 200);
        if (input.enabled && !employer) throw fail('Add the company name in Company settings before enabling safety.');
        if (input.enabled && !detected) throw fail('Add a recognizable state to the project address before enabling safety.');
        const next = { revision: profile.revision + 1, enabled: input.enabled, state: detected, employer, activities: [...new Set(input.activities)].sort() };
        const stored = storedProfileFor(project);
        if (JSON.stringify({ ...next, revision: 0 }) === JSON.stringify({ ...stored, revision: 0 })) return reply(200, { profile });
        project.safetyProfile = next;
        project.safetyProfileHistory ||= [];
        project.safetyProfileHistory.push({ at: new Date().toISOString(), by: user.name, userId: user.id, before: stored, after: clone(next) });
        writeDb(db); return reply(200, { profile: next });
      }
      if (req.method === 'POST' && route[2] === 'days' && !route[3]) {
        if (!profile.enabled) return reply(409, { error: 'Enable the project safety profile before recording checks' });
        inputKeys(input, ['date', 'revision']); const date = exactDate(input.date), existing = dayFor(db, projectId, date), context = dayContext(db, project, date);
        revision(input, existing?.revision || 0);
        if (existing?.fingerprint === context.fingerprint) return reply(200, projectedDay(db, project, date, existing));
        const next = { id: `${projectId}:${date}`, companyId: db.company.id, projectId, date, revision: (existing?.revision || 0) + 1, ruleVersion: VERSION, coverage: coverageFor(project, db.company), activities: context.activities,
          fingerprint: context.fingerprint, checks: checksFor(context.activities), hazards: clone(existing?.hazards || []), history: clone(existing?.history || []) };
        audit(next, user, existing ? 'Checks refreshed after work or applicability changed' : 'Checks generated', existing ? { checks: existing.checks, fingerprint: existing.fingerprint } : null, { checks: next.checks, fingerprint: next.fingerprint });
        db.safetyDays ||= [];
        if (existing) db.safetyDays[db.safetyDays.indexOf(existing)] = next; else db.safetyDays.push(next);
        writeDb(db); return reply(existing ? 200 : 201, projectedDay(db, project, date, next));
      }
      if (route[2] !== 'days' || !route[3]) return reply(405, { error: 'Method not allowed' });
      const date = exactDate(route[3]), day = dayFor(db, projectId, date);
      if (!day) return reply(404, { error: 'Generate the safety day first' });
      revision(input, day.revision);
      if (req.method === 'PATCH' && route[4] === 'checks' && route[5]) {
        if (!profile.enabled) return reply(409, { error: 'Enable the project safety profile before recording checks' });
        if (day.fingerprint !== dayContext(db, project, date).fingerprint) return reply(409, { error: 'Work or applicability changed. Refresh checks before recording a response.', code: 'SAFETY_CHECKS_STALE' });
        inputKeys(input, ['revision', 'status', 'notes', 'inspector', 'competentPerson', 'action', 'owner', 'dueDate', 'workStopped']);
        const row = day.checks.find(item => item.id === route[5]); if (!row) return reply(404, { error: 'Safety check not found' });
        if (!STATUSES.has(input.status) || input.workStopped != null && typeof input.workStopped !== 'boolean') throw fail('Choose a valid check status and stopped-work response');
        const next = { ...row, status: input.status };
        for (const name of ['notes', 'inspector', 'competentPerson', 'action', 'owner', 'dueDate']) next[name] = text(input[name], name, name === 'notes' || name === 'action' ? 1500 : 200);
        if (next.dueDate) exactDate(next.dueDate);
        next.workStopped = input.workStopped === true;
        if (next.status !== 'pending' && !checkComplete(next)) throw fail('Record the inspector and findings for every response. Failed/deferred checks need a reason, corrective action, owner, due date and stopped work; inspection checks need a competent person.');
        audit(day, user, 'Check response recorded', row, next); day.checks[day.checks.indexOf(row)] = { ...next, updatedAt: new Date().toISOString(), updatedBy: user.name, updatedByUserId: user.id };
        if (['fail', 'deferred'].includes(next.status)) {
          const linked = day.hazards.find(hazard => hazard.sourceCheckId === row.id), before = linked ? clone(linked) : null;
          const followup = { ...(linked || {}), id: linked?.id || `check-${hash([date, row.id]).slice(0, 24)}`, sourceCheckId: row.id, sourceDate: date,
            observation: `${row.title}: ${next.notes}`, location: String(project.site || project.address || 'See check evidence'), status: 'open', owner: next.owner, dueDate: next.dueDate,
            action: next.action, workStopped: true, photoId: linked?.photoId || null, verification: '', createdAt: linked?.createdAt || new Date().toISOString(), createdBy: linked?.createdBy || user.name, createdByUserId: linked?.createdByUserId || user.id };
          delete followup.verifiedAt; delete followup.verifiedBy; delete followup.verifiedByUserId;
          if (linked) day.hazards[day.hazards.indexOf(linked)] = followup; else day.hazards.push(followup);
          audit(day, user, 'Failed or deferred check requires verified follow-up', before, followup);
        }
        day.revision++;
      } else if (req.method === 'POST' && route[4] === 'hazards' && !route[5]) {
        inputKeys(input, ['revision', 'observation', 'location', 'owner', 'dueDate', 'action', 'workStopped', 'photoId']);
        const observation = text(input.observation, 'hazard observation'), location = text(input.location, 'hazard location', 300);
        if (!observation || !location) throw fail('Describe the hazard and its location');
        if (input.workStopped != null && typeof input.workStopped !== 'boolean') throw fail('Record whether work is stopped');
        if (input.photoId != null && !(db.photos || []).some(photo => String(photo.id) === String(input.photoId) && (Number(photo.projectId) === projectId || Number.isInteger(photo.project) && db.projects[photo.project]?.id === projectId) && !photo.deletedAt)) throw fail('Choose a photo from this project');
        const row = { id: crypto.randomUUID(), observation, location, status: 'open', owner: text(input.owner, 'responsible person', 200), dueDate: text(input.dueDate, 'due date', 10), action: text(input.action, 'immediate action'), workStopped: input.workStopped === true, photoId: input.photoId ?? null, verification: '', createdAt: new Date().toISOString(), createdBy: user.name, createdByUserId: user.id };
        if (row.dueDate) exactDate(row.dueDate);
        day.hazards.push(row); audit(day, user, 'Hazard recorded — follow-up required', null, row); day.revision++;
      } else if (req.method === 'PATCH' && route[4] === 'hazards' && route[5]) {
        inputKeys(input, ['revision', 'status', 'verification', 'action', 'owner', 'dueDate', 'workStopped']);
        const row = day.hazards.find(item => item.id === route[5]); if (!row) return reply(404, { error: 'Hazard not found' });
        if (!['open', 'corrected', 'verified'].includes(input.status)) throw fail('Choose a valid hazard status');
        if (input.status === 'verified' && !canManage) return reply(403, { error: 'PM or office verification required' });
        const next = { ...row, status: input.status };
        if (Object.hasOwn(input, 'workStopped')) {
          if (typeof input.workStopped !== 'boolean') throw fail('Record whether work is stopped');
          next.workStopped = input.workStopped;
        }
        for (const name of ['verification', 'action', 'owner', 'dueDate']) if (Object.hasOwn(input, name)) next[name] = text(input[name], name, name === 'dueDate' ? 10 : 1500);
        if (next.dueDate) exactDate(next.dueDate);
        if ((next.status !== 'open' && !next.action) || (next.status === 'verified' && !next.verification)) throw fail('Record the corrective action and verification before closing a hazard');
        if (next.status === 'verified') Object.assign(next, { verifiedAt: new Date().toISOString(), verifiedBy: user.name, verifiedByUserId: user.id });
        else { delete next.verifiedAt; delete next.verifiedBy; delete next.verifiedByUserId; }
        audit(day, user, 'Hazard status changed', row, next); day.hazards[day.hazards.indexOf(row)] = next; day.revision++;
      } else return reply(405, { error: 'Method not allowed' });
      writeDb(db); return reply(200, projectedDay(db, project, date, day));
    } catch (error) {
      if (error.statusCode) return reply(error.statusCode, { error: error.message, code: error.code });
      throw error;
    }
  };
}

module.exports = { VERSION, CATALOG, COVERAGE_NOTICE, inferredState, profileFor, dayContext, checksFor, safetyGate, createSafetyHandler };
