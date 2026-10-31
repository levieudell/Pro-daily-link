'use strict';

// Safety v3 keeps one small command surface over the existing authenticated,
// project-scoped Safety API. Facts are written in focused flows; this page
// answers only: what needs doing, what needs follow-up, and where is the record.
(function () {
  const TABS = [
    { id: 'today', label: 'Today', es: 'Hoy' },
    { id: 'followup', label: 'Follow-up', es: 'Seguimiento' },
    { id: 'records', label: 'Records', es: 'Registros' }
  ];
  const FORM_CATEGORIES = new Set(['safety', 'inspection', 'incident']);
  const RECORD_FILTERS = ['all', 'checks', 'talks', 'hazards', 'dailies'];
  const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  const dateValue = value => /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) ? String(value) : '';
  const reportProjectId = (report, projectList = []) => Number(report?.projectId || projectList[Number(report?.project)]?.id || 0);
  const projectIndexById = (projectId, projectList = []) => projectList.findIndex(project => Number(project.id) === Number(projectId));
  const submittedSafetyEvidence = report => Boolean(report && report.status !== 'Draft');
  const reportDateValue = report => dateValue(report?.dateIso) || dateValue(report?.date);
  const projectReports = (rows, projectId, projectList) => (rows || []).filter(report => !report.deletedAt && reportProjectId(report, projectList) === Number(projectId));
  const assignedFormTemplates = (project, templates) => {
    const ids = Array.isArray(project?.templateIds) && project.templateIds.length ? project.templateIds.map(String) : [project?.templateId].filter(Boolean).map(String);
    return (templates || []).filter(template => ids.includes(String(template.id)) && FORM_CATEGORIES.has(template.category));
  };
  const uniqueOpenHazards = data => {
    const rows = [...(data?.openHazards || []), ...(data?.day?.hazards || []).filter(hazard => hazard.status !== 'verified')], seen = new Set();
    return rows.filter(hazard => { const key = String(hazard.id || `${hazard.observation}|${hazard.date || data?.date}`); if (seen.has(key)) return false; seen.add(key); return true; });
  };
  const statusModel = data => {
    if (!data) return { tone: 'neutral', title: 'Choose a project', detail: 'Select a project to see today’s safety work.', action: '' };
    const profile = data.profile || {}, day = data.day, summary = day?.summary || {}, open = uniqueOpenHazards(data).length;
    if (data.coverage === 'manual-review') return { tone: 'blocked', title: 'Safety review needed', detail: data.canManage ? 'This location needs a reviewed safety setup before the daily can be finalized.' : 'Ask a project manager to review this location.', action: data.canManage ? 'setup' : '' };
    if (!profile.enabled) return { tone: 'setup', title: data.canManage ? 'Turn on Safety for this project' : 'Safety setup is not ready', detail: data.canManage ? 'Company and job location are filled automatically. Confirm the work once.' : 'Ask the project manager or account owner to finish setup.', action: data.canManage ? 'setup' : '' };
    if (!day) return { tone: 'attention', title: 'Ready to start', detail: 'Start the checks prepared for today’s work.', action: 'checks' };
    if (summary.stale) return { tone: 'attention', title: 'Today’s work changed', detail: 'Update the checks before recording more responses.', action: 'checks' };
    if (summary.error) return { tone: 'blocked', title: 'Action needed', detail: summary.error, action: 'checks' };
    if (Number(summary.pending) > 0) return { tone: 'attention', title: `${summary.pending} check${summary.pending === 1 ? '' : 's'} left`, detail: 'Record what you saw. A clean check takes one tap.', action: 'checks' };
    if (Number(summary.unresolved) > 0 || open > 0) { const count = open || summary.unresolved; return { tone: summary.canSubmit ? 'followup' : 'blocked', title: `${count} follow-up${count === 1 ? '' : 's'} ${count === 1 ? 'needs' : 'need'} attention`, detail: summary.canSubmit ? 'Today’s record is complete and the open work stays visible.' : 'Add the immediate action, owner, and due date.', action: 'followups' }; }
    if (summary.readyForWork || summary.canSubmit) return { tone: 'complete', title: 'Today’s record is complete', detail: 'Checks match the work recorded for today.', action: 'records' };
    return { tone: 'neutral', title: 'Review today’s record', detail: 'Confirm current conditions before the daily is sent.', action: 'checks' };
  };

  const hazardBucket = (hazard, today) => {
    if (hazard?.status === 'corrected') return 'verification';
    if (dateValue(hazard?.dueDate) && hazard.dueDate < today) return 'overdue';
    if (hazard?.dueDate === today) return 'today';
    return 'open';
  };

  const safetyRecordRows = ({ data, reports = [], projectId, projects = [], language = 'en' } = {}) => {
    const spanish = String(language).startsWith('es'), day = data?.day || {}, rows = [];
    for (const check of day.checks || []) if (check.status && check.status !== 'pending') rows.push({ id: `check:${check.id}`, type: 'checks', when: check.updatedAt || data?.date || day.date, title: check.title || check.id, detail: spanish ? `Resultado: ${check.status}` : `Response: ${check.status}`, actor: check.updatedBy || check.recordedBy || check.inspector || '' });
    for (const talk of day.talks || []) {
      const voided = Boolean(talk.voidedAt), corrected = Boolean(talk.amendedAt), topic = talk.topic || (spanish ? 'Charla de seguridad' : 'Toolbox talk');
      const latestCorrection = Array.isArray(talk.corrections) ? talk.corrections.at(-1) : null;
      const correctionDetail = corrected ? [latestCorrection?.reason, talk.initial?.topic ? `${spanish ? 'Tema original' : 'Original topic'}: ${talk.initial.topic}` : ''].filter(Boolean).join(' · ') : '';
      const state = voided
        ? `${spanish ? 'ANULADO' : 'VOIDED'}${talk.voidReason ? ` — ${talk.voidReason}` : ''}`
        : corrected ? `${spanish ? 'Corregido · original conservado' : 'Corrected · original preserved'}${correctionDetail ? ` — ${correctionDetail}` : ''}` : '';
      rows.push({ id: `talk:${talk.id}`, type: 'talks', when: talk.voidedAt || talk.amendedAt || talk.createdAt || data?.date || day.date,
        title: voided ? `${spanish ? 'ANULADO' : 'VOIDED'} — ${topic}` : topic,
        detail: [state, `${(talk.attendees || []).length} ${spanish ? 'presentes reportados' : 'reported present'}`, talk.language || 'en'].filter(Boolean).join(' · '),
        actor: voided ? talk.voidedBy || talk.presenter || '' : corrected ? talk.amendedBy || talk.presenter || '' : talk.presenter || talk.createdBy || '', voided, corrected });
    }
    for (const hazard of day.hazards || []) rows.push({ id: `hazard:${hazard.id}`, type: 'hazards', when: hazard.createdAt || data?.date || day.date, title: hazard.observation || (spanish ? 'Peligro registrado' : 'Recorded hazard'), detail: hazard.status === 'verified' ? (spanish ? 'Cerrado y verificado' : 'Verified closed') : hazard.status === 'corrected' ? (spanish ? 'Corregido · verificar' : 'Corrected · verify') : (spanish ? 'Seguimiento abierto' : 'Follow-up open'), actor: hazard.createdBy || '' });
    for (const report of projectReports(reports, projectId, projects)) {
      if (!submittedSafetyEvidence(report)) continue;
      const when = reportDateValue(report) || report.updatedAt || report.createdAt || '';
      if (report.safetyEvidence || report.safetyInspection || report.safetyIncident) rows.push({ id: `daily:${report.id}`, type: 'dailies', when, reportId: report.id, status: report.status || '', title: spanish ? 'Registro diario enviado' : 'Submitted daily record', detail: report.safetyIncident || report.safetyInspection || (spanish ? 'Evidencia de seguridad guardada' : 'Saved safety evidence') });
    }
    return rows.sort((a, b) => String(b.when || '').localeCompare(String(a.when || '')));
  };

  const printSafetyRecordHtml = ({ data, project = {}, date = '', reports = [], projects = [], language = 'en' } = {}) => {
    const spanish = String(language).startsWith('es'), profile = data?.profile || {}, day = data?.day || {}, checks = day.checks || [], hazards = day.hazards || [], talks = day.talks || [];
    const activeTalks = talks.filter(talk => !talk.voidedAt), voidedTalks = talks.filter(talk => talk.voidedAt);
    const title = spanish ? 'Registro de actividad de seguridad' : 'Safety activity record';
    const item = (label, value) => `<div><small>${esc(label)}</small><strong>${esc(value || '—')}</strong></div>`;
    const checkRows = checks.length ? checks.map(check => `<tr><td>${esc(check.title || check.id)}</td><td>${esc(check.status || 'pending')}</td><td>${esc(check.notes || '—')}</td><td>${esc(check.recordedBy || check.updatedBy || check.inspector || '—')}</td><td>${esc(check.updatedAt || '—')}</td></tr>`).join('') : '<tr><td colspan="5">No checks recorded.</td></tr>';
    const talkArticle = (talk, voided = false) => {
      const latestCorrection = Array.isArray(talk.corrections) ? talk.corrections.at(-1) : null;
      const correction = talk.amendedAt && !voided ? `<p><b>${spanish ? 'Corrección' : 'Correction'}:</b> ${esc(latestCorrection?.reason || (spanish ? 'Registro corregido; original conservado.' : 'Record corrected; original preserved.'))}${talk.initial?.topic ? ` · <b>${spanish ? 'Tema original' : 'Original topic'}:</b> ${esc(talk.initial.topic)}` : ''}</p>` : '';
      const voidNotice = voided ? `<p><strong>${spanish ? 'ANULADO — NO CUENTA COMO CHARLA REALIZADA' : 'VOIDED — DOES NOT COUNT AS A HELD TALK'}</strong></p><p><b>${spanish ? 'Motivo' : 'Reason'}:</b> ${esc(talk.voidReason || '—')} · <b>${spanish ? 'Anulado por' : 'Voided by'}:</b> ${esc(talk.voidedBy || '—')}${talk.voidedAt ? ` · ${esc(talk.voidedAt)}` : ''}</p>` : '';
      return `<article${voided ? ' class="is-voided"' : ''}><h3>${esc(talk.topic || (spanish ? 'Charla de seguridad' : 'Toolbox talk'))}</h3>${voidNotice}<p>${esc(talk.notes || talk.outline || '')}</p><p><b>${spanish ? 'Presentador' : 'Presenter'}:</b> ${esc(talk.presenter || talk.createdBy || '—')} · <b>${spanish ? 'Idioma' : 'Language'}:</b> ${esc(talk.language || 'en')}</p><p><b>${spanish ? 'Presentes reportados' : 'Reported present'}:</b> ${esc((talk.attendees || []).map(person => person.name || person).join(', ') || '—')}</p>${correction}</article>`;
    };
    const talkRows = activeTalks.length ? activeTalks.map(talk => talkArticle(talk)).join('') : `<p>${spanish ? 'No hay charlas vigentes registradas.' : 'No active toolbox talks recorded.'}</p>`;
    const voidedTalkRows = voidedTalks.length ? `<h2>${spanish ? 'Registros de charlas anulados — solo auditoría' : 'Voided toolbox talk records — audit only'} (${voidedTalks.length})</h2>${voidedTalks.map(talk => talkArticle(talk, true)).join('')}` : '';
    const hazardRows = hazards.length ? hazards.map(hazard => `<article><h3>${esc(hazard.observation || 'Hazard')}</h3><p>${esc(hazard.location || '')}</p><p><b>${spanish ? 'Acción' : 'Action'}:</b> ${esc(hazard.action || '—')} · <b>${spanish ? 'Responsable' : 'Owner'}:</b> ${esc(hazard.owner || '—')} · <b>${spanish ? 'Vence' : 'Due'}:</b> ${esc(hazard.dueDate || '—')}</p><p><b>${spanish ? 'Estado' : 'Status'}:</b> ${esc(hazard.status || 'open')}${hazard.workStopped ? ` · ${spanish ? 'Trabajo afectado detenido' : 'Affected work stopped'}` : ''}</p></article>`).join('') : `<p>${spanish ? 'No hay peligros registrados.' : 'No hazards recorded.'}</p>`;
    const submitted = safetyRecordRows({ data, reports, projectId: project.id, projects, language }).filter(row => row.type === 'dailies').length;
    return `<!doctype html><html lang="${spanish ? 'es' : 'en'}"><head><meta charset="utf-8"><title>${esc(title)} · ${esc(project.name || '')}</title><style>body{font:14px/1.45 system-ui;color:#17201d;margin:32px}h1,h2,h3{margin:.25em 0}header{border-bottom:4px solid #ff6a1a;padding-bottom:18px}.meta{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:20px 0}.meta div,article{border:1px solid #ccd5d1;border-radius:10px;padding:12px}.meta small{display:block;color:#5f6e68}.is-voided{border:2px solid #9d3028;background:#fff4f2}table{width:100%;border-collapse:collapse;margin:10px 0 22px}th,td{border:1px solid #ccd5d1;padding:8px;text-align:left;vertical-align:top}footer{margin-top:28px;padding-top:12px;border-top:1px solid #ccd5d1;color:#5f6e68;font-size:12px}@media print{body{margin:12mm}button{display:none}}</style></head><body><header><p>PRO DAILY LINK</p><h1>${esc(title)}</h1><p>${esc(project.name || '')}</p></header><section class="meta">${item(spanish ? 'Empresa' : 'Company', profile.employer)}${item(spanish ? 'Proyecto' : 'Project', project.name)}${item(spanish ? 'Dirección' : 'Address', project.site || project.address)}${item(spanish ? 'Jurisdicción' : 'Jurisdiction', profile.state)}${item(spanish ? 'Fecha de trabajo' : 'Work date', date || day.date)}${item(spanish ? 'Versión de reglas' : 'Rule version', day.ruleVersion)}${item(spanish ? 'Revisión' : 'Revision', day.revision)}${item(spanish ? 'Reportes enviados' : 'Submitted dailies', submitted)}${item(spanish ? 'Seguimientos abiertos' : 'Open follow-ups', uniqueOpenHazards(data).length)}</section><h2>${spanish ? 'Revisiones' : 'Checks'}</h2><table><thead><tr><th>${spanish ? 'Revisión' : 'Check'}</th><th>${spanish ? 'Respuesta' : 'Response'}</th><th>${spanish ? 'Hallazgos' : 'Findings'}</th><th>${spanish ? 'Registrado por' : 'Recorded by'}</th><th>${spanish ? 'Hora' : 'Time'}</th></tr></thead><tbody>${checkRows}</tbody></table><h2>${spanish ? 'Charlas de seguridad vigentes' : 'Active toolbox talks'} (${activeTalks.length})</h2>${talkRows}${voidedTalkRows}<h2>${spanish ? 'Peligros y seguimiento' : 'Hazards and follow-up'}</h2>${hazardRows}<footer>${spanish ? 'Este registro apoya el programa de seguridad de la empresa. No reemplaza el juicio de una persona competente, las responsabilidades del empleador ni una respuesta de emergencia.' : 'This record supports the company safety program. It does not replace competent-person judgment, employer responsibilities, or an emergency response.'}</footer></body></html>`;
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { TABS, RECORD_FILTERS, esc, reportProjectId, projectIndexById, submittedSafetyEvidence, reportDateValue, projectReports, assignedFormTemplates, uniqueOpenHazards, statusModel, hazardBucket, safetyRecordRows, printSafetyRecordHtml };
    return;
  }

  const state = { identity: '', projectId: null, date: '', tab: 'today', recordFilter: 'all', showForms: false, data: null, dataKey: '', loading: false, error: '', request: 0, controller: null, mounted: false };
  const element = id => document.getElementById(id);
  const isSpanish = () => (typeof preferredLanguage !== 'undefined' ? preferredLanguage : document.documentElement.lang || 'en').startsWith('es');
  const words = {
    'Safety': 'Seguridad', 'COMPANY SAFETY': 'SEGURIDAD DE LA EMPRESA',
    'Hold the talk. Fix the hazard. Keep the record.': 'Dé la charla. Corrija el peligro. Conserve el registro.',
    'Manage forms': 'Administrar formularios', 'Project': 'Proyecto', 'Work date': 'Fecha de trabajo', 'Refresh': 'Actualizar',
    'Start safety check': 'Iniciar revisión', 'Continue safety check': 'Continuar revisión', 'Review follow-up': 'Revisar seguimiento', 'View today’s record': 'Ver registro de hoy',
    'Report hazard': 'Reportar peligro', 'Toolbox talk': 'Charla de seguridad', 'Forms': 'Formularios',
    'What needs attention': 'Lo que necesita atención', 'Nothing urgent right now.': 'Nada urgente por ahora.', 'Keep watching for changing conditions during the day.': 'Siga atento a condiciones que cambien durante el día.',
    'Checks recorded': 'Revisiones registradas', 'Open follow-ups': 'Seguimientos abiertos', 'Talks today': 'Charlas hoy', 'Forms completed': 'Formularios completados',
    'Quick actions': 'Acciones rápidas', 'The most common safety work is one tap away.': 'El trabajo de seguridad más común está a un toque.',
    'Follow-up needing attention': 'Seguimiento que necesita atención', 'No open follow-up is recorded for this project and date.': 'No hay seguimiento abierto registrado para este proyecto y fecha.',
    'Today’s record': 'Registro de hoy', 'Open the focused checklist to record or update checks and hazards.': 'Abra la lista enfocada para registrar o actualizar revisiones y peligros.',
    'No checks have been prepared for this date.': 'No se han preparado revisiones para esta fecha.', 'Needs response': 'Necesita respuesta', 'Recorded': 'Registrado',
    'Hazards and corrective actions': 'Peligros y acciones correctivas', 'No hazards are recorded for this work date. This is not a safety certification.': 'No hay peligros registrados para esta fecha. Esto no es una certificación de seguridad.',
    'Toolbox talks': 'Charlas de seguridad', 'Record the topic, attendees, and language in the existing daily log so the history stays together.': 'Registre el tema, asistentes e idioma en el reporte diario existente para mantener el historial unido.',
    'No toolbox talks are recorded for this project yet.': 'Aún no hay charlas de seguridad registradas para este proyecto.', 'Attendees not entered': 'Asistentes no ingresados',
    'Assigned forms': 'Formularios asignados', 'Complete the company’s project-specific safety, inspection, and incident forms.': 'Complete los formularios de seguridad, inspección e incidentes asignados por la empresa.',
    'No safety forms are assigned to this project.': 'No hay formularios de seguridad asignados a este proyecto.', 'Complete': 'Completo', 'Due': 'Pendiente', 'Open form': 'Abrir formulario',
    'Safety records': 'Registros de seguridad', 'Submitted evidence and follow-up history stay tied to the project.': 'La evidencia enviada y el historial de seguimiento permanecen ligados al proyecto.',
    'No safety records have been saved for this project yet.': 'Aún no se han guardado registros de seguridad para este proyecto.', 'View daily': 'Ver reporte', 'Available': 'Disponible',
    'Follow-up queue': 'Pendientes de seguimiento', 'No open follow-up is recorded.': 'No hay seguimientos abiertos.', 'Overdue': 'Vencido', 'Due today': 'Vence hoy', 'Waiting for verification': 'Esperando verificación', 'Open': 'Abierto',
    'Print safety record': 'Imprimir registro', 'All': 'Todos', 'Checks': 'Revisiones', 'Talks': 'Charlas', 'Hazards': 'Peligros', 'Dailies': 'Reportes diarios', 'No matching safety records.': 'No hay registros que coincidan.',
    'Loading the latest safety record…': 'Cargando el registro de seguridad más reciente…', 'Try again': 'Intentar de nuevo',
    'Safety records could not be loaded.': 'No se pudieron cargar los registros de seguridad.', 'Choose a project to begin.': 'Elija un proyecto para comenzar.'
  };
  const tr = text => isSpanish() && words[text] ? words[text] : text;
  const categoryLabel = category => isSpanish() ? ({ safety: 'Seguridad', inspection: 'Inspección', incident: 'Incidente' }[category] || category || 'Seguridad') : ({ safety: 'Safety', inspection: 'Inspection', incident: 'Incident' }[category] || category || 'Safety');
  const reportStatusLabel = status => isSpanish() ? ({ Draft: 'Borrador', 'Needs review': 'Necesita revisión', 'Missing data': 'Faltan datos', Approved: 'Aprobado', Submitted: 'Enviado' }[status] || status || '') : (status || '');
  const activityLabel = activity => isSpanish() ? ({ general: 'Revisión del sitio', roofing: 'Techado', excavation: 'Excavación', framing: 'Estructura', demolition: 'Demolición' }[activity] || activity || 'Revisión del sitio') : ({ general: 'Site check', roofing: 'Roofing', excavation: 'Excavation', framing: 'Framing', demolition: 'Demolition' }[activity] || activity || 'Site check');
  const identity = () => {
    const user = typeof currentUser === 'undefined' ? null : currentUser;
    const tenant = typeof signedInCompanyId === 'function' ? signedInCompanyId() : (typeof company === 'undefined' ? '' : company?.id);
    const projectScope = (user?.projectIds || []).map(Number).sort((a, b) => a - b);
    const crewScope = (user?.assignedCrews || []).map(String).sort();
    return JSON.stringify([tenant || '', user?.id || '', user?.role || '', user?.memberId || '', user?.permissions || {}, projectScope, crewScope]);
  };
  const canUseWorkspace = () => {
    const user = typeof currentUser === 'undefined' ? null : currentUser;
    if (!user) return false;
    if (user.role === 'project_manager') return ['viewDailies', 'approveDailies', 'manageSafety', 'verifySafety'].some(permission => user.permissions?.[permission] === true);
    return ['owner', 'admin', 'foreman', 'field'].includes(user.role);
  };
  function syncIdentity() {
    const next = identity();
    if (state.identity && state.identity !== next) {
      state.controller?.abort();
      state.request += 1;
      Object.assign(state, { projectId: null, tab: 'today', recordFilter: 'all', showForms: false, data: null, dataKey: '', loading: false, error: '' });
    }
    state.identity = next;
  }
  // Legacy reports identify their project by its position in the scoped project
  // collection. Keep that complete collection for resolution even though archived
  // projects do not belong in the active Safety picker.
  const allProjects = () => typeof projects === 'undefined' ? [] : projects;
  const projectList = () => allProjects().filter(project => !project.archived);
  const reportList = () => typeof reports === 'undefined' ? [] : reports;
  const templateList = () => typeof dailyTemplates === 'undefined' ? [] : dailyTemplates;
  const today = () => typeof companyTodayIso === 'function' ? companyTodayIso() : new Date().toISOString().slice(0, 10);
  const activeProject = () => projectList().find(project => Number(project.id) === Number(state.projectId));
  const reportsForProject = () => projectReports(reportList(), state.projectId, allProjects()).sort((a, b) => String(reportDateValue(b) || b.updatedAt || '').localeCompare(String(reportDateValue(a) || a.updatedAt || '')));
  const formsForProject = () => assignedFormTemplates(activeProject(), templateList());
  const canManageForms = () => ['owner', 'admin'].includes(typeof currentUser === 'undefined' ? '' : currentUser?.role);
  const formatDate = value => { if (!dateValue(value)) return value || ''; const date = new Date(`${value}T12:00:00`); return date.toLocaleDateString(isSpanish() ? 'es-MX' : 'en-US', { month: 'short', day: 'numeric', year: 'numeric' }); };
  const formatDateTime = value => { const date = new Date(value); return Number.isFinite(date.valueOf()) ? date.toLocaleString(isSpanish() ? 'es-MX' : 'en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : ''; };
  const formComplete = template => reportsForProject().some(report => String(report.templateId) === String(template.id) && reportDateValue(report) === state.date && report.status !== 'Draft');

  function ensureContext() {
    syncIdentity();
    const nav = document.querySelector('.nav-item[data-page="safety"]');
    if (nav) nav.hidden = !canUseWorkspace();
    const available = projectList();
    if (!state.date) state.date = today();
    if (!available.some(project => Number(project.id) === Number(state.projectId))) {
      const memberId = typeof currentUser === 'undefined' ? null : Number(currentUser?.memberId);
      const assignment = typeof assignments === 'undefined' ? null : assignments.find(row => row.date === state.date && (!memberId || (row.memberIds || []).map(Number).includes(memberId)) && available.some(project => Number(project.id) === Number(row.projectId)));
      state.projectId = assignment?.projectId || available[0]?.id || null;
      state.data = null;
    }
    const select = element('safety-workspace-project'), date = element('safety-workspace-date');
    if (select) {
      select.innerHTML = available.length ? available.map(project => `<option value="${esc(project.id)}">${esc(project.name)}</option>`).join('') : `<option value="">${esc(tr('Choose a project to begin.'))}</option>`;
      select.value = state.projectId == null ? '' : String(state.projectId);
    }
    if (date) date.value = state.date;
    const manage = element('safety-manage-forms'); if (manage) manage.hidden = !canManageForms();
  }

  function tabsMarkup() {
    return TABS.map(tab => {
      const active = state.tab === tab.id;
      const count = tab.id === 'followup' ? uniqueOpenHazards(state.data).length : 0;
      return `<button type="button" role="tab" id="safety-tab-${tab.id}" data-safety-workspace-tab="${tab.id}" aria-controls="safety-panel-${tab.id}" aria-selected="${active}" tabindex="${active ? '0' : '-1'}">${esc(isSpanish() ? tab.es : tab.label)}${count ? `<span>${count}</span>` : ''}</button>`;
    }).join('');
  }

  function statusMarkup(model) {
    const checks = state.data?.day?.checks || [], recorded = checks.filter(check => check.status && check.status !== 'pending').length, talks = (state.data?.day?.talks || []).filter(talk => !talk.voidedAt).length;
    return `<article class="safety-command-card safety-tone-${esc(model.tone)}"><div class="safety-command-copy"><p class="eyebrow">${esc(formatDate(state.date))} · ${esc(activeProject()?.name || tr('Safety'))}</p><h2>${esc(isSpanish() ? translatedStatus(model.title) : model.title)}</h2><p>${esc(isSpanish() ? translatedStatus(model.detail) : model.detail)}</p><div class="safety-day-facts"><span>${recorded}/${checks.length} ${esc(isSpanish() ? 'revisiones' : 'checks')}</span><span>${talks} ${esc(isSpanish() ? 'charlas' : 'talks')}</span><span>${uniqueOpenHazards(state.data).length} ${esc(isSpanish() ? 'pendientes' : 'follow-ups')}</span></div></div>${model.action ? `<button type="button" class="primary safety-command-primary" data-safety-action="${esc(model.action)}">${esc(primaryLabel(model))}</button>` : ''}</article>`;
  }

  function translatedStatus(value) {
    const map = {
      'Choose a project': 'Elija un proyecto', 'Select a project to see today’s safety work.': 'Seleccione un proyecto para ver el trabajo de seguridad de hoy.',
      'Safety review needed': 'Se necesita revisión de seguridad', 'This location needs a reviewed safety setup before the daily can be finalized.': 'Esta ubicación necesita una configuración revisada antes de finalizar el reporte.', 'Ask a project manager to review this location.': 'Pida al gerente de proyecto que revise esta ubicación.',
      'Turn on Safety for this project': 'Active Seguridad para este proyecto', 'Safety setup is not ready': 'La configuración no está lista', 'Company and job location are filled automatically. Confirm the work once.': 'La empresa y ubicación se completan automáticamente. Confirme el trabajo una vez.', 'Ask the project manager or account owner to finish setup.': 'Pida al gerente o propietario que termine la configuración.',
      'Ready to start': 'Listo para comenzar', 'Start the checks prepared for today’s work.': 'Inicie las revisiones preparadas para el trabajo de hoy.', 'Today’s work changed': 'El trabajo de hoy cambió', 'Update the checks before recording more responses.': 'Actualice las revisiones antes de registrar más respuestas.',
      'Action needed': 'Se necesita acción', 'Record what you saw. A clean check takes one tap.': 'Registre lo que vio. Una revisión sin problemas toma un toque.', 'Today’s record is complete': 'El registro de hoy está completo', 'Checks match the work recorded for today.': 'Las revisiones coinciden con el trabajo registrado.',
      'Review today’s record': 'Revisar el registro de hoy', 'Confirm current conditions before the daily is sent.': 'Confirme las condiciones antes de enviar el reporte.', 'Today’s record is complete and the open work stays visible.': 'El registro está completo y los pendientes siguen visibles.', 'Add the immediate action, owner, and due date.': 'Agregue la acción inmediata, responsable y fecha.'
    };
    const pending = String(value).match(/^(\d+) checks? left$/);
    if (pending) return `${pending[1]} ${pending[1] === '1' ? 'revisión pendiente' : 'revisiones pendientes'}`;
    const follow = String(value).match(/^(\d+) follow-ups? need attention$/);
    if (follow) return `${follow[1]} ${follow[1] === '1' ? 'seguimiento necesita' : 'seguimientos necesitan'} atención`;
    return map[value] || value;
  }

  function primaryLabel(model) {
    if (model.action === 'setup') return isSpanish() ? 'Configurar proyecto' : 'Set up project';
    if (model.action === 'followups') return tr('Review follow-up');
    if (model.action === 'records') return tr('View today’s record');
    return state.data?.day ? tr('Continue safety check') : tr('Start safety check');
  }

  function metricsMarkup() {
    const checks = state.data?.day?.checks || [], recorded = checks.filter(check => check.status && check.status !== 'pending').length, open = uniqueOpenHazards(state.data).length;
    const talks = reportsForProject().filter(report => reportDateValue(report) === state.date && String(report.safetyTalk || '').trim()).length;
    const forms = formsForProject(), completed = forms.filter(formComplete).length;
    return `<div class="safety-metric-grid"><article><small>${esc(tr('Checks recorded'))}</small><strong>${recorded}<span> / ${checks.length}</span></strong></article><article class="${open ? 'needs-action' : ''}"><small>${esc(tr('Open follow-ups'))}</small><strong>${open}</strong></article><article><small>${esc(tr('Talks today'))}</small><strong>${talks}</strong></article><article><small>${esc(tr('Forms completed'))}</small><strong>${completed}<span> / ${forms.length}</span></strong></article></div>`;
  }

  function followupMarkup() {
    const hazards = uniqueOpenHazards(state.data);
    const groups = [['overdue', tr('Overdue')], ['today', tr('Due today')], ['verification', tr('Waiting for verification')], ['open', tr('Open')]];
    const card = hazard => {
      const bucket = hazardBucket(hazard, state.date), status = hazard.status === 'corrected' ? (isSpanish() ? 'Corregido · verificar' : 'Corrected · verify') : bucket === 'overdue' ? tr('Overdue') : bucket === 'today' ? tr('Due today') : (isSpanish() ? 'Abierto' : 'Open');
      return `<article class="safety-followup-card ${bucket === 'overdue' ? 'is-overdue' : ''}"><div><span class="safety-record-state">${esc(status)}</span><h3>${esc(hazard.observation || (isSpanish() ? 'Peligro registrado' : 'Recorded hazard'))}</h3><p>${esc(hazard.location || (isSpanish() ? 'Ubicación no registrada' : 'Location not recorded'))}</p><small>${esc(hazard.owner || (isSpanish() ? 'Sin responsable' : 'Owner not assigned'))}${hazard.dueDate ? ` · ${esc(formatDate(hazard.dueDate))}` : ''}${hazard.workStopped ? ` · ${esc(isSpanish() ? 'trabajo detenido' : 'work stopped')}` : ''}</small></div><div class="safety-lifecycle" aria-label="${esc(isSpanish() ? 'Ciclo de seguimiento' : 'Follow-up lifecycle')}"><span class="is-done">${esc(isSpanish() ? 'Observado' : 'Observed')}</span><i>→</i><span class="${hazard.status === 'corrected' || hazard.status === 'verified' ? 'is-done' : ''}">${esc(isSpanish() ? 'Corregido' : 'Corrected')}</span><i>→</i><span class="${hazard.status === 'verified' ? 'is-done' : ''}">${esc(isSpanish() ? 'Verificado' : 'Verified')}</span></div><button type="button" class="primary small" data-safety-action="followups" data-hazard-date="${esc(hazard.date || state.date)}">${esc(hazard.status === 'corrected' ? (isSpanish() ? 'Verificar cierre' : 'Verify closed') : (isSpanish() ? 'Agregar corrección' : 'Add correction'))}</button></article>`;
    };
    return `<article class="panel safety-followup-panel"><div class="safety-section-heading"><div><p class="eyebrow">${esc(tr('Follow-up queue'))}</p><h2>${esc(hazards.length ? (isSpanish() ? 'Cierre cada pendiente' : 'Close every loop') : tr('No open follow-up is recorded.'))}</h2><p>${esc(isSpanish() ? 'Observado → corregido → verificado' : 'Observed → corrected → verified')}</p></div><button type="button" class="secondary" data-safety-action="hazard">＋ ${esc(tr('Report hazard'))}</button></div>${hazards.length ? groups.map(([bucket, label]) => { const rows = hazards.filter(hazard => hazardBucket(hazard, state.date) === bucket); return rows.length ? `<section class="safety-followup-group"><h3>${esc(label)} <span>${rows.length}</span></h3><div>${rows.map(card).join('')}</div></section>` : ''; }).join('') : `<div class="safety-calm-empty"><span aria-hidden="true">✓</span><div><strong>${esc(tr('No open follow-up is recorded.'))}</strong><p>${esc(tr('Keep watching for changing conditions during the day.'))}</p></div></div>`}</article>`;
  }

  function todayMarkup() {
    const model = statusModel(state.data), hazards = uniqueOpenHazards(state.data).slice().sort((a, b) => String(a.dueDate || '9999').localeCompare(String(b.dueDate || '9999'))).slice(0, 3), forms = formsForProject();
    const attention = hazards.length ? `<div class="safety-urgent-list">${hazards.map(hazard => `<button type="button" data-safety-action="followups" data-hazard-date="${esc(hazard.date || state.date)}"><span>${esc(hazard.status === 'corrected' ? (isSpanish() ? 'Verificar' : 'Verify') : hazardBucket(hazard, state.date) === 'overdue' ? tr('Overdue') : tr('Open'))}</span><strong>${esc(hazard.observation || (isSpanish() ? 'Peligro registrado' : 'Recorded hazard'))}</strong><small>${esc(hazard.owner || (isSpanish() ? 'Sin responsable' : 'Owner not assigned'))}${hazard.dueDate ? ` · ${esc(formatDate(hazard.dueDate))}` : ''}</small></button>`).join('')}</div>` : `<div class="safety-calm-empty"><span aria-hidden="true">✓</span><div><strong>${esc(tr('Nothing urgent right now.'))}</strong><p>${esc(tr('Keep watching for changing conditions during the day.'))}</p></div></div>`;
    const formPanel = state.showForms ? `<section class="panel safety-inline-tools" aria-label="${esc(isSpanish() ? 'Formularios para este trabajo' : 'Forms for this job')}"><div class="safety-section-heading"><div><p class="eyebrow">${esc(isSpanish() ? 'Formularios para este trabajo' : 'Forms for this job')}</p><h2>${esc(isSpanish() ? 'Solo lo asignado a este proyecto' : 'Only what this project needs')}</h2></div>${canManageForms() ? `<button type="button" class="secondary small" data-safety-action="manage-forms">${esc(tr('Manage forms'))}</button>` : ''}</div><div class="safety-form-grid">${forms.length ? forms.map(template => { const complete = formComplete(template); return `<article class="safety-form-card ${complete ? 'is-complete' : ''}"><div><small>${esc(categoryLabel(template.category))}</small><strong>${esc(template.name)}</strong><p>${esc(template.description || '')}</p></div><button type="button" class="${complete ? 'secondary' : 'primary'} small" data-safety-action="form" data-template-id="${esc(template.id)}">${esc(complete ? (isSpanish() ? 'Nuevo registro' : 'New record') : tr('Open form'))}</button></article>`; }).join('') : `<div class="safety-calm-empty"><span aria-hidden="true">▤</span><div><strong>${esc(tr('No safety forms are assigned to this project.'))}</strong></div></div>`}</div></section>` : '';
    return `${statusMarkup(model)}<section class="panel safety-today-actions"><div class="safety-action-grid"><button type="button" data-safety-action="hazard"><span aria-hidden="true">!</span><b>${esc(tr('Report hazard'))}</b><small>${esc(isSpanish() ? 'Registre y asigne seguimiento' : 'Record it and assign follow-up')}</small></button><button type="button" data-safety-action="talk"><span aria-hidden="true">◌</span><b>${esc(tr('Toolbox talk'))}</b><small>${esc(isSpanish() ? 'Tema, equipo e idioma' : 'Topic, crew, and language')}</small></button><button type="button" data-safety-action="open-forms" aria-expanded="${state.showForms}"><span aria-hidden="true">▤</span><b>${esc(tr('Forms'))}</b><small>${esc(forms.length ? `${forms.filter(form => !formComplete(form)).length} ${isSpanish() ? 'disponibles' : 'available'}` : (isSpanish() ? 'Ninguno asignado' : 'None assigned'))}</small></button></div><div class="safety-attention"><div class="safety-section-heading"><div><p class="eyebrow">${esc(tr('What needs attention'))}</p><h2>${esc(isSpanish() ? 'Resuelva lo importante' : 'Close the important loop')}</h2></div>${hazards.length ? `<button type="button" class="secondary small" data-safety-action="followups">${esc(tr('Review follow-up'))} →</button>` : ''}</div>${attention}</div></section>${formPanel}<p class="safety-product-promise">${esc(isSpanish() ? 'Mantenga visible el trabajo de seguridad y cree un registro confiable. No reemplaza el juicio de una persona competente ni las responsabilidades del empleador.' : 'Keep safety work visible and build a defensible record. This does not replace competent-person judgment or employer responsibilities.')}</p>`;
  }

  function talksMarkup() {
    const talks = reportsForProject().filter(report => String(report.safetyTalk || '').trim());
    return `<article class="panel safety-library-panel"><div class="safety-section-heading"><div><p class="eyebrow">${esc(tr('Toolbox talks'))}</p><h2>${esc(isSpanish() ? 'Una conversación clara, un registro confiable' : 'One clear conversation, one reliable record')}</h2><p>${esc(tr('Record the topic, attendees, and language in the existing daily log so the history stays together.'))}</p></div><button type="button" class="primary" data-safety-action="talk">＋ ${esc(tr('Start toolbox talk'))}</button></div><div class="safety-record-list">${talks.length ? talks.map(report => `<article><div class="safety-record-icon" aria-hidden="true">◌</div><div><small>${esc(formatDate(reportDateValue(report)))} · ${esc(reportStatusLabel(report.status))}</small><strong>${esc(report.safetyTalk)}</strong><p>${esc(report.safetyTalkAttendees || tr('Attendees not entered'))}</p></div><button type="button" class="secondary small" data-safety-action="report" data-report-id="${esc(report.id)}">${esc(tr('View daily'))}</button></article>`).join('') : `<div class="safety-calm-empty"><span aria-hidden="true">◌</span><div><strong>${esc(tr('No toolbox talks are recorded for this project yet.'))}</strong><p>${esc(isSpanish() ? 'Inicie una charla cuando el equipo necesite repasar un riesgo o cambio.' : 'Start one when the crew needs to review a hazard or changed condition.')}</p></div></div>`}</div></article>`;
  }

  function formsMarkup() {
    const forms = formsForProject();
    return `<article class="panel safety-library-panel"><div class="safety-section-heading"><div><p class="eyebrow">${esc(tr('Assigned forms'))}</p><h2>${esc(isSpanish() ? 'Solo los formularios que necesita este trabajo' : 'Only the forms this job needs')}</h2><p>${esc(tr('Complete the company’s project-specific safety, inspection, and incident forms.'))}</p></div>${canManageForms() ? `<button type="button" class="secondary" data-safety-action="manage-forms">${esc(tr('Manage forms'))}</button>` : ''}</div><div class="safety-form-grid">${forms.length ? forms.map(template => { const complete = formComplete(template); return `<article class="safety-form-card ${complete ? 'is-complete' : ''}"><div class="safety-form-type">${esc(categoryLabel(template.category))}</div><div><strong>${esc(template.name)}</strong><p>${esc(template.description || (isSpanish() ? 'Formulario asignado al proyecto' : 'Project-assigned form'))}</p><small>${complete ? '✓ ' + esc(tr('Complete')) : '○ ' + esc(tr('Available'))}</small></div><button type="button" class="${complete ? 'secondary' : 'primary'} small" data-safety-action="form" data-template-id="${esc(template.id)}">${complete ? esc(isSpanish() ? 'Nuevo registro' : 'New record') : esc(tr('Open form'))}</button></article>`; }).join('') : `<div class="safety-calm-empty"><span aria-hidden="true">▤</span><div><strong>${esc(tr('No safety forms are assigned to this project.'))}</strong><p>${esc(canManageForms() ? (isSpanish() ? 'Asigne únicamente los formularios que el equipo realmente usará.' : 'Assign only the forms this crew will actually use.') : (isSpanish() ? 'El administrador puede asignar formularios específicos.' : 'An administrator can assign project-specific forms.'))}</p></div></div>`}</div></article>`;
  }

  function recordRows() {
    return safetyRecordRows({ data: state.data, reports: reportList(), projectId: state.projectId, projects: allProjects(), language: isSpanish() ? 'es' : 'en' });
  }

  function recordsMarkup() {
    const rows = recordRows(), filtered = state.recordFilter === 'all' ? rows : rows.filter(row => row.type === state.recordFilter), labels = { all: 'All', checks: 'Checks', talks: 'Talks', hazards: 'Hazards', dailies: 'Dailies' };
    const label = type => tr(labels[type] || 'All');
    return `<article class="panel safety-records-panel"><div class="safety-section-heading"><div><p class="eyebrow">${esc(tr('Safety records'))}</p><h2>${esc(isSpanish() ? 'La evidencia, sin la búsqueda de papel' : 'The evidence, without the paper chase')}</h2><p>${esc(isSpanish() ? 'Filtre el historial o imprima el registro del día.' : 'Filter the history or print the selected day’s record.')}</p></div><button type="button" class="primary" data-safety-action="print">${esc(tr('Print safety record'))}</button></div><div class="safety-record-filters" role="group" aria-label="${esc(isSpanish() ? 'Filtrar registros' : 'Filter records')}">${RECORD_FILTERS.map(filter => `<button type="button" data-record-filter="${filter}" aria-pressed="${state.recordFilter === filter}">${esc(label(filter))}</button>`).join('')}</div><div class="safety-record-list">${filtered.length ? filtered.slice(0, 80).map(row => `<article><div class="safety-record-icon" aria-hidden="true">${row.type === 'hazards' ? '!' : row.type === 'talks' ? '◌' : '✓'}</div><div><small>${esc(label(row.type))} · ${esc(dateValue(row.when) ? formatDate(row.when) : formatDateTime(row.when))}${row.status ? ` · ${esc(reportStatusLabel(row.status))}` : ''}</small><strong>${esc(row.title)}</strong>${row.detail ? `<p>${esc(row.detail)}</p>` : ''}${row.actor ? `<small>${esc(row.actor)}</small>` : ''}</div>${row.reportId ? `<button type="button" class="secondary small" data-safety-action="report" data-report-id="${esc(row.reportId)}">${esc(tr('View daily'))}</button>` : ''}</article>`).join('') : `<div class="safety-calm-empty"><span aria-hidden="true">▤</span><div><strong>${esc(tr('No matching safety records.'))}</strong></div></div>`}</div></article>`;
  }

  function panelMarkup(tab) {
    if (state.loading) return `<div class="panel safety-loading" aria-busy="true"><span></span><strong>${esc(tr('Loading the latest safety record…'))}</strong></div>`;
    if (state.error) return `<div class="panel safety-error"><strong>${esc(tr('Safety records could not be loaded.'))}</strong><p>${esc(state.error)}</p><button type="button" class="secondary" data-safety-action="reload">${esc(tr('Try again'))}</button></div>`;
    if (!state.projectId) return `<div class="panel safety-error"><strong>${esc(tr('Choose a project to begin.'))}</strong></div>`;
    if (tab === 'today') return todayMarkup();
    if (tab === 'followup') return followupMarkup();
    return recordsMarkup();
  }

  function render() {
    if (!state.mounted) return;
    ensureContext();
    const tabs = element('safety-workspace-tabs'), panels = element('safety-workspace-panels');
    if (!tabs || !panels) return;
    tabs.innerHTML = tabsMarkup();
    panels.innerHTML = TABS.map(tab => `<section role="tabpanel" id="safety-panel-${tab.id}" aria-labelledby="safety-tab-${tab.id}" tabindex="0" ${state.tab === tab.id ? '' : 'hidden'}>${state.tab === tab.id ? panelMarkup(tab.id) : ''}</section>`).join('');
    const heading = element('safety-page')?.querySelector('.safety-workspace-heading');
    if (heading) { heading.querySelector('.eyebrow').textContent = tr('COMPANY SAFETY'); heading.querySelector('h1').textContent = tr('Safety'); heading.querySelector('p:last-child').textContent = tr('Hold the talk. Fix the hazard. Keep the record.'); }
    const manage = element('safety-manage-forms'); if (manage) manage.textContent = tr('Manage forms');
    const projectSelect = element('safety-workspace-project'), dateInput = element('safety-workspace-date'), refresh = element('safety-workspace-refresh'), tablist = element('safety-workspace-tabs');
    if (projectSelect?.closest('label')?.firstChild) projectSelect.closest('label').firstChild.textContent = `${tr('Project')} `;
    if (dateInput?.closest('label')?.firstChild) dateInput.closest('label').firstChild.textContent = `${tr('Work date')} `;
    if (projectSelect) projectSelect.setAttribute('aria-label', tr('Project'));
    if (dateInput) dateInput.setAttribute('aria-label', tr('Work date'));
    if (refresh) refresh.textContent = tr('Refresh');
    if (tablist) tablist.setAttribute('aria-label', isSpanish() ? 'Área de seguridad' : 'Safety workspace');
  }

  function announce(message, visible = false) {
    const notice = element('safety-workspace-notice');
    if (!notice) return;
    notice.textContent = message || '';
    notice.classList.toggle('is-quiet', !visible);
    notice.hidden = !message;
  }

  async function load(options = {}) {
    ensureContext();
    if (!canUseWorkspace()) return;
    if (!state.projectId) { state.data = null; state.error = ''; render(); return; }
    const key = `${state.identity}:${state.projectId}:${state.date}`;
    if (!options.force && !state.error && state.data && state.dataKey === key) { render(); return; }
    const request = ++state.request;
    state.controller?.abort(); state.controller = new AbortController(); state.loading = true; state.error = ''; announce(tr('Loading the latest safety record…')); render();
    try {
      const data = await api(`/api/projects/${encodeURIComponent(state.projectId)}/safety?date=${encodeURIComponent(state.date)}`, { signal: state.controller.signal });
      if (request !== state.request) return;
      state.data = data; state.dataKey = key; announce(isSpanish() ? 'Registro de seguridad actualizado.' : 'Safety record updated.');
    } catch (error) {
      if (request !== state.request || error?.name === 'AbortError') return;
      state.data = null; state.error = error.message || tr('Safety records could not be loaded.'); announce(state.error, true);
    } finally {
      if (request === state.request) { state.loading = false; render(); }
    }
  }

  function selectTab(tab, focus = false) {
    if (!TABS.some(item => item.id === tab)) return;
    state.tab = tab; render();
    if (focus) {
      const selected = element(`safety-tab-${tab}`);
      selected?.focus();
      selected?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }

  function openFocused(mode, opener, date = state.date) {
    if (!state.projectId || !window.PDLSafetyPM?.open) return;
    return window.PDLSafetyPM.open({ projectId: state.projectId, date, opener, mode });
  }

  function openReportFlow(templateId) {
    const projectIndex = projectIndexById(state.projectId, allProjects());
    if (projectIndex < 0 || typeof openReport !== 'function') return;
    const memberId = typeof currentUser === 'undefined' ? null : Number(currentUser?.memberId);
    const sourceAssignment = (typeof assignments === 'undefined' ? [] : assignments).find(row => Number(row.projectId) === Number(state.projectId) && row.date === state.date && (!memberId || (row.memberIds || []).map(Number).includes(memberId)));
    openReport(null, { projectIndex, dateIso: state.date, ...(sourceAssignment ? { assignmentId: sourceAssignment.id } : {}), ...(templateId ? { templateId } : {}) });
    const template = templateId ? templateList().find(row => String(row.id) === String(templateId)) : null;
    const structuredForm = template && FORM_CATEGORIES.has(template.category);
    if (structuredForm) {
      const type = element('report-type'); if (type) type.value = 'superintendent';
      if (typeof applyReportType === 'function') applyReportType();
      if (typeof showReportStep === 'function') showReportStep(2);
      requestAnimationFrame(() => {
        const more = element('report-more'), fields = element('report-custom-fields');
        if (more) more.open = true;
        if (typeof applyFieldReportLayout === 'function') applyFieldReportLayout();
        const target = fields?.querySelector('[data-custom-field]') || fields;
        if (target) { if (target === fields) target.tabIndex = -1; target.focus({ preventScroll: true }); target.scrollIntoView({ block: 'center' }); }
      });
    }
  }

  function openFormsSettings() {
    if (typeof showPage === 'function') showPage('settings');
    requestAnimationFrame(() => document.querySelector('[data-settings-tab="forms"]')?.click());
  }

  function printRecord() {
    const project = activeProject();
    if (!project || !state.data) return;
    const html = printSafetyRecordHtml({ data: state.data, project, date: state.date, reports: reportList(), projects: allProjects(), language: isSpanish() ? 'es' : 'en' });
    // Some browsers intentionally return null when noopener is passed in the
    // feature string. Obtain the handle first, then sever its opener before
    // writing any scoped record data into the new document.
    const printable = window.open('', '_blank');
    if (!printable) return announce(isSpanish() ? 'Permita ventanas emergentes para imprimir.' : 'Allow pop-ups to print the safety record.', true);
    printable.opener = null;
    printable.document.open();
    printable.document.write(html);
    printable.document.close();
    printable.focus();
    printable.addEventListener('load', () => printable.print(), { once: true });
  }

  function handleAction(button) {
    const action = button.dataset.safetyAction;
    if (action === 'setup') return openFocused('setup', button);
    if (action === 'checks') return openFocused('checks', button);
    if (action === 'hazard') return openFocused('hazard', button);
    if (action === 'talk') return openFocused('talk', button);
    if (action === 'followups') return openFocused('followup', button, button.dataset.hazardDate || state.date);
    if (action === 'records') return selectTab('records', true);
    if (action === 'open-forms') {
      state.showForms = !state.showForms;
      render();
      if (state.showForms) requestAnimationFrame(() => document.querySelector('.safety-inline-tools')?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' }));
      return;
    }
    if (action === 'form') return openReportFlow(button.dataset.templateId);
    if (action === 'manage-forms') return openFormsSettings();
    if (action === 'reload') return void load({ force: true });
    if (action === 'print') return printRecord();
    if (action === 'report') {
      const reportId = Number(button.dataset.reportId), report = reportList().find(row => Number(row.id) === reportId);
      if (!report || reportProjectId(report, allProjects()) !== Number(state.projectId)) return announce(isSpanish() ? 'Ese reporte ya no está disponible.' : 'That daily is no longer available.', true);
      const filter = element('report-status-filter');
      if (filter && filter.value !== 'all' && filter.value !== report.status) filter.value = 'all';
      if (typeof showPage === 'function') showPage('reports');
      if (typeof renderReports === 'function') renderReports(reportId);
      requestAnimationFrame(() => { const detail = element('report-detail'); if (detail) { detail.tabIndex = -1; detail.focus({ preventScroll: true }); detail.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' }); } });
    }
  }

  function mount() {
    if (state.mounted || !element('safety-page')) return;
    state.mounted = true; state.date = today(); ensureContext();
    element('safety-workspace-project')?.addEventListener('change', event => { state.projectId = Number(event.target.value) || null; state.data = null; state.dataKey = ''; state.showForms = false; void load({ force: true }); });
    element('safety-workspace-date')?.addEventListener('change', event => { if (!dateValue(event.target.value)) return; state.date = event.target.value; state.data = null; state.dataKey = ''; void load({ force: true }); });
    element('safety-workspace-refresh')?.addEventListener('click', () => void load({ force: true }));
    element('safety-manage-forms')?.addEventListener('click', openFormsSettings);
    element('safety-workspace-tabs')?.addEventListener('click', event => { const tab = event.target.closest('[data-safety-workspace-tab]'); if (tab) selectTab(tab.dataset.safetyWorkspaceTab, true); });
    element('safety-workspace-tabs')?.addEventListener('keydown', event => {
      const tab = event.target.closest('[data-safety-workspace-tab]'); if (!tab || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault(); const index = TABS.findIndex(item => item.id === tab.dataset.safetyWorkspaceTab);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? TABS.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + TABS.length) % TABS.length;
      selectTab(TABS[next].id, true);
    });
    element('safety-workspace-panels')?.addEventListener('click', event => {
      const filter = event.target.closest('[data-record-filter]');
      if (filter && RECORD_FILTERS.includes(filter.dataset.recordFilter)) { state.recordFilter = filter.dataset.recordFilter; render(); return; }
      const action = event.target.closest('[data-safety-action]'); if (action) handleAction(action);
    });
    if (!canUseWorkspace() && element('safety-page').classList.contains('active') && typeof showPage === 'function') showPage(typeof defaultPage === 'function' ? defaultPage() : 'dashboard', { historyMode: 'replace' });
    else { render(); if (element('safety-page').classList.contains('active')) void load(); }
  }

  if (typeof renderEverything === 'function') {
    const previousRenderEverything = renderEverything;
    renderEverything = function (...args) {
      const result = previousRenderEverything.apply(this, args); ensureContext();
      if (element('safety-page')?.classList.contains('active') && !canUseWorkspace()) showPage(typeof defaultPage === 'function' ? defaultPage() : 'dashboard', { historyMode: 'replace' });
      else { render(); if (element('safety-page')?.classList.contains('active')) void load(); }
      return result;
    };
  }
  if (typeof showPage === 'function') {
    const previousShowPage = showPage;
    showPage = function (page, ...args) {
      const next = page === 'safety' && !canUseWorkspace() ? (typeof defaultPage === 'function' ? defaultPage() : 'dashboard') : page;
      const result = previousShowPage.call(this, next, ...args);
      if (next === 'safety') void load();
      return result;
    };
  }
  window.addEventListener('pdl:safety-updated', event => { if (Number(event.detail?.projectId) === Number(state.projectId) && event.detail?.date === state.date) void load({ force: true }); });
  window.addEventListener('hashchange', () => { if (location.hash === '#safety') void load(); });
  window.PDLSafetyWorkspace = { render, refresh: () => load({ force: true }), openTab: selectTab };
  mount();
}());
