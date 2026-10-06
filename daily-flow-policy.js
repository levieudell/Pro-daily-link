'use strict';

function explicitSafety(notes) {
  // Preserve observations verbatim. Absence of a match never means no incidents.
  return (String(notes || '').match(/[^.!?\n]+[.!?]?/g) || [])
    .map(text => text.trim())
    .filter(text => /\b(safety|hazard|incident|injur\w*|near[- ]miss|unguarded|unprotected|unsafe|fall protection|PPE|exposed wire\w*|seguridad|peligro\w*|incidente\w*|lesion\w*|sin protecci[oó]n)\b/i.test(text))
    .join(' ');
}

function previousNextSteps(db, projectId, date) {
  const index = (db.projects || []).findIndex(project => Number(project.id) === Number(projectId));
  if (index < 0) return null;
  // Only a dated, submitted daily is a source. Do not resurrect an older plan
  // when the latest submitted daily has intentionally cleared its next steps.
  const latest = (db.reports || []).filter(report => Number(report.project) === index &&
    ['Needs review', 'Approved'].includes(report.status) &&
    /^\d{4}-\d{2}-\d{2}$/.test(report.dateIso || '') && report.dateIso < date)
    .sort((a, b) => b.dateIso.localeCompare(a.dateIso) || Number(b.id) - Number(a.id))[0];
  return latest?.next?.trim() ? { reportId: latest.id, date: latest.dateIso,
    status: latest.status, text: String(latest.next).slice(0, 5000) } : null;
}

function canEndWorkday(db, user, workday, managerAllowed) {
  if (!user) return false;
  if (['owner', 'admin'].includes(user.role)) return true;
  if (['field', 'foreman'].includes(user.role)) return (workday.memberIds || []).map(Number).includes(Number(user.memberId));
  return user.role === 'project_manager' && user.permissions?.manageTime === true && managerAllowed(db, user, workday);
}

module.exports = { explicitSafety, previousNextSteps, canEndWorkday };
