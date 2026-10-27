'use strict';

// Overview-first Safety workspace. It intentionally reads the existing scoped
// safety endpoint, daily reports and assigned templates. Check, hazard and form
// writes stay in their established workflows so there is one source of truth.
(function () {
  const TABS = [
    { id: 'overview', label: 'Overview', es: 'Resumen' },
    { id: 'today', label: 'Today', es: 'Hoy' },
    { id: 'talks', label: 'Toolbox talks', es: 'Charlas de seguridad' },
    { id: 'forms', label: 'Forms', es: 'Formularios' },
    { id: 'records', label: 'Records', es: 'Registros' }
  ];
  const FORM_CATEGORIES = new Set(['safety', 'inspection', 'incident']);
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
    if (data.coverage === 'manual-review') return { tone: 'blocked', title: 'Manual safety review required', detail: data.canManage ? 'This jurisdiction does not have a reviewed starter check pack.' : 'Ask a project manager or account owner to review this jurisdiction before using the starter checks.', action: data.canManage ? (profile.enabled ? 'checks' : 'setup') : '' };
    if (!profile.enabled) return { tone: 'setup', title: data.canManage ? 'Set up project safety' : 'Safety setup is not enabled', detail: data.canManage ? 'Confirm the responsible employer, jurisdiction, and work performed once for this project.' : 'Ask the project manager or account owner to complete the project setup.', action: data.canManage ? 'setup' : '' };
    if (!day) return { tone: 'attention', title: 'Prepare today’s checks', detail: 'Build today’s checklist from the project setup and scheduled work.', action: 'checks' };
    if (summary.stale) return { tone: 'attention', title: 'Today’s checks need a refresh', detail: 'The work or project setup changed. Refresh before recording more responses.', action: 'checks' };
    if (summary.error) return { tone: 'blocked', title: 'Documentation is blocked', detail: summary.error, action: 'checks' };
    if (Number(summary.pending) > 0) return { tone: 'attention', title: `${summary.pending} check${summary.pending === 1 ? '' : 's'} still need a response`, detail: 'Record the actual conditions before the daily is submitted.', action: 'checks' };
    if (Number(summary.unresolved) > 0 || open > 0) return { tone: summary.canSubmit ? 'followup' : 'blocked', title: summary.canSubmit ? 'Documentation complete; follow-up remains open' : 'Open items need documentation', detail: summary.canSubmit ? 'The daily can be submitted, but this is not clearance to continue affected work.' : 'Record the protection, owner, and due date before submitting.', action: 'followups' };
    if (summary.readyForWork) return { tone: 'complete', title: 'Today’s starter documentation is complete', detail: 'No open items are recorded. Continue monitoring changing conditions.', action: 'checks' };
    if (summary.canSubmit) return { tone: 'ready', title: 'Ready to submit', detail: 'Required documentation is recorded for this work date.', action: 'checks' };
    return { tone: 'neutral', title: 'Review today’s record', detail: 'Open the checklist to confirm the current conditions.', action: 'checks' };
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { TABS, esc, reportProjectId, projectIndexById, submittedSafetyEvidence, reportDateValue, projectReports, assignedFormTemplates, uniqueOpenHazards, statusModel };
    return;
  }

  const state = { identity: '', projectId: null, date: '', tab: 'overview', data: null, dataKey: '', loading: false, error: '', request: 0, controller: null, mounted: false };
  const element = id => document.getElementById(id);
  const isSpanish = () => (typeof preferredLanguage !== 'undefined' ? preferredLanguage : document.documentElement.lang || 'en').startsWith('es');
  const words = {
    'Safety': 'Seguridad', 'FIELD SAFETY': 'SEGURIDAD EN CAMPO',
    'See what needs attention, complete today’s records, and find the evidence later.': 'Vea qué necesita atención, complete los registros de hoy y encuentre la evidencia después.',
    'Manage forms': 'Administrar formularios', 'Project': 'Proyecto', 'Work date': 'Fecha de trabajo', 'Refresh': 'Actualizar',
    'Complete today’s checks': 'Completar revisiones de hoy', 'Flag a hazard': 'Registrar un peligro', 'Start toolbox talk': 'Iniciar charla de seguridad', 'Open forms': 'Abrir formularios',
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
    if (user.role === 'project_manager') return user.permissions?.viewDailies === true || user.permissions?.approveDailies === true;
    return ['owner', 'admin', 'foreman', 'field'].includes(user.role);
  };
  function syncIdentity() {
    const next = identity();
    if (state.identity && state.identity !== next) {
      state.controller?.abort();
      state.request += 1;
      Object.assign(state, { projectId: null, tab: 'overview', data: null, dataKey: '', loading: false, error: '' });
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
      return `<button type="button" role="tab" id="safety-tab-${tab.id}" data-safety-workspace-tab="${tab.id}" aria-controls="safety-panel-${tab.id}" aria-selected="${active}" tabindex="${active ? '0' : '-1'}">${esc(isSpanish() ? tab.es : tab.label)}</button>`;
    }).join('');
  }

  function statusMarkup(model) {
    const summary = state.data?.day?.summary || {}, canSubmit = summary.canSubmit === true, ready = summary.readyForWork === true;
    return `<article class="safety-command-card safety-tone-${esc(model.tone)}"><div class="safety-command-copy"><p class="eyebrow">${esc(formatDate(state.date))} · ${esc(activeProject()?.name || tr('Safety'))}</p><h2>${esc(isSpanish() ? translatedStatus(model.title) : model.title)}</h2><p>${esc(isSpanish() ? translatedStatus(model.detail) : model.detail)}</p><div class="safety-readiness"><span class="${canSubmit ? 'is-ready' : ''}">${canSubmit ? '✓' : '○'} ${esc(isSpanish() ? 'Documentación lista para enviar' : 'Documentation ready to submit')}</span><span class="${ready ? 'is-ready' : summary.unresolved ? 'is-open' : ''}">${ready ? '✓' : '○'} ${esc(isSpanish() ? 'Listo para el trabajo registrado' : 'Ready for the recorded work')}</span></div></div>${model.action ? `<button type="button" class="primary safety-command-primary" data-safety-action="${esc(model.action)}">${esc(primaryLabel(model))}</button>` : ''}</article>`;
  }

  function translatedStatus(value) {
    const map = {
      'Choose a project': 'Elija un proyecto', 'Select a project to see today’s safety work.': 'Seleccione un proyecto para ver el trabajo de seguridad de hoy.',
      'Manual safety review required': 'Se requiere revisión manual de seguridad', 'This jurisdiction does not have a reviewed starter check pack.': 'Esta jurisdicción no tiene un paquete inicial de revisiones aprobado.',
      'Set up project safety': 'Configurar seguridad del proyecto', 'Safety setup is not enabled': 'La configuración de seguridad no está habilitada',
    'Confirm the responsible employer, jurisdiction, and work performed once for this project.': 'Confirme el empleador responsable, la jurisdicción y el trabajo realizado una vez para este proyecto.', 'Ask a project manager or account owner to review this jurisdiction before using the starter checks.': 'Pida a un gerente de proyecto o propietario que revise esta jurisdicción antes de usar las revisiones iniciales.',
      'Ask the project manager or account owner to complete the project setup.': 'Pida al gerente de proyecto o propietario que complete la configuración.',
      'Prepare today’s checks': 'Preparar revisiones de hoy', 'Build today’s checklist from the project setup and scheduled work.': 'Cree la lista de hoy a partir del proyecto y el trabajo programado.',
      'Today’s checks need a refresh': 'Las revisiones de hoy necesitan actualizarse', 'The work or project setup changed. Refresh before recording more responses.': 'El trabajo o la configuración cambió. Actualice antes de registrar más respuestas.',
      'Documentation is blocked': 'La documentación está bloqueada', 'Documentation complete; follow-up remains open': 'Documentación completa; el seguimiento sigue abierto',
      'The daily can be submitted, but this is not clearance to continue affected work.': 'El reporte puede enviarse, pero esto no autoriza continuar el trabajo afectado.',
      'Open items need documentation': 'Los pendientes necesitan documentación', 'Record the protection, owner, and due date before submitting.': 'Registre la protección, responsable y fecha antes de enviar.',
      'Today’s starter documentation is complete': 'La documentación inicial de hoy está completa', 'No open items are recorded. Continue monitoring changing conditions.': 'No hay pendientes registrados. Continúe vigilando las condiciones.',
      'Ready to submit': 'Listo para enviar', 'Required documentation is recorded for this work date.': 'La documentación requerida está registrada para esta fecha.',
      'Review today’s record': 'Revisar el registro de hoy', 'Open the checklist to confirm the current conditions.': 'Abra la lista para confirmar las condiciones actuales.'
    };
    const pending = String(value).match(/^(\d+) checks? still need a response$/);
    if (pending) return `${pending[1]} revisiones necesitan respuesta`;
    return map[value] || value;
  }

  function primaryLabel(model) {
    if (model.action === 'setup') return isSpanish() ? 'Configurar proyecto' : 'Set up project';
    if (model.action === 'followups') return isSpanish() ? 'Revisar seguimientos' : 'Review follow-ups';
    return tr('Complete today’s checks');
  }

  function metricsMarkup() {
    const checks = state.data?.day?.checks || [], recorded = checks.filter(check => check.status && check.status !== 'pending').length, open = uniqueOpenHazards(state.data).length;
    const talks = reportsForProject().filter(report => reportDateValue(report) === state.date && String(report.safetyTalk || '').trim()).length;
    const forms = formsForProject(), completed = forms.filter(formComplete).length;
    return `<div class="safety-metric-grid"><article><small>${esc(tr('Checks recorded'))}</small><strong>${recorded}<span> / ${checks.length}</span></strong></article><article class="${open ? 'needs-action' : ''}"><small>${esc(tr('Open follow-ups'))}</small><strong>${open}</strong></article><article><small>${esc(tr('Talks today'))}</small><strong>${talks}</strong></article><article><small>${esc(tr('Forms completed'))}</small><strong>${completed}<span> / ${forms.length}</span></strong></article></div>`;
  }

  function followupMarkup() {
    const hazards = uniqueOpenHazards(state.data);
    if (!hazards.length) return `<div class="safety-calm-empty"><span aria-hidden="true">✓</span><div><strong>${esc(tr('No open follow-up is recorded for this project and date.'))}</strong><p>${esc(isSpanish() ? 'Siga observando las condiciones que cambian durante el día.' : 'Keep watching for conditions that change during the day.')}</p></div></div>`;
    return `<div class="safety-followup-list">${hazards.slice(0, 4).map(hazard => `<article><span class="safety-record-state">${esc(hazard.status === 'corrected' ? (isSpanish() ? 'Corregido · verificar' : 'Corrected · verify') : (isSpanish() ? 'Abierto' : 'Open'))}</span><div><strong>${esc(hazard.observation || (isSpanish() ? 'Peligro registrado' : 'Recorded hazard'))}</strong><p>${esc(hazard.location || (isSpanish() ? 'Ubicación no registrada' : 'Location not recorded'))}</p><small>${esc(hazard.owner || (isSpanish() ? 'Sin responsable' : 'Owner not assigned'))}${hazard.dueDate ? ` · ${esc(isSpanish() ? 'vence' : 'due')} ${esc(formatDate(hazard.dueDate))}` : ''}</small></div></article>`).join('')}</div>`;
  }

  function overviewMarkup() {
    const model = statusModel(state.data);
    return `${statusMarkup(model)}${metricsMarkup()}<div class="safety-overview-grid"><article class="panel safety-quick-actions"><div class="safety-section-heading"><div><p class="eyebrow">${esc(tr('Quick actions'))}</p><h2>${esc(tr('The most common safety work is one tap away.'))}</h2></div></div><div class="safety-action-grid"><button type="button" data-safety-action="checks"><span aria-hidden="true">✓</span><b>${esc(tr('Complete today’s checks'))}</b><small>${esc(isSpanish() ? 'Registrar condiciones y revisiones' : 'Record conditions and inspections')}</small></button><button type="button" data-safety-action="hazard"><span aria-hidden="true">!</span><b>${esc(tr('Flag a hazard'))}</b><small>${esc(isSpanish() ? 'Asignar acción y seguimiento' : 'Assign action and follow-up')}</small></button><button type="button" data-safety-action="talk"><span aria-hidden="true">◌</span><b>${esc(tr('Start toolbox talk'))}</b><small>${esc(isSpanish() ? 'Tema, asistentes e idioma' : 'Topic, attendees, and language')}</small></button><button type="button" data-safety-action="open-forms"><span aria-hidden="true">▤</span><b>${esc(tr('Open forms'))}</b><small>${esc(isSpanish() ? 'Revisiones e incidentes asignados' : 'Assigned inspections and incidents')}</small></button></div></article><article class="panel safety-followup-panel"><div class="safety-section-heading"><div><p class="eyebrow">${esc(tr('Follow-up needing attention'))}</p><h2>${uniqueOpenHazards(state.data).length ? esc(isSpanish() ? 'Cierre el ciclo' : 'Close the loop') : esc(isSpanish() ? 'Sin pendientes abiertos' : 'No open items')}</h2></div>${uniqueOpenHazards(state.data).length ? '<button type="button" class="secondary small" data-safety-action="followups">Review →</button>' : ''}</div>${followupMarkup()}</article></div>`;
  }

  function todayMarkup() {
    const day = state.data?.day, checks = day?.checks || [], hazards = day?.hazards || [];
    const checkRows = checks.length ? checks.map(check => `<article class="safety-today-row"><span class="safety-check-dot safety-check-${esc(check.status || 'pending')}" aria-hidden="true"></span><div><strong>${esc(check.title || check.id)}</strong><small>${esc(activityLabel(check.activity))}</small></div><span>${esc(check.status === 'pending' ? tr('Needs response') : tr('Recorded'))}</span></article>`).join('') : `<div class="safety-calm-empty"><span aria-hidden="true">○</span><div><strong>${esc(tr('No checks have been prepared for this date.'))}</strong><p>${esc(isSpanish() ? 'Prepare la lista cuando esté listo para comenzar.' : 'Prepare the checklist when the team is ready to begin.')}</p></div></div>`;
    const hazardRows = hazards.length ? hazards.map(hazard => `<article class="safety-today-row"><span class="safety-hazard-mark" aria-hidden="true">!</span><div><strong>${esc(hazard.observation)}</strong><small>${esc(hazard.location || '')}</small></div><span>${esc(hazard.status === 'verified' ? (isSpanish() ? 'Cerrado y verificado' : 'Verified closed') : (isSpanish() ? 'Seguimiento abierto' : 'Follow-up open'))}</span></article>`).join('') : `<p class="safety-empty-copy">${esc(tr('No hazards are recorded for this work date. This is not a safety certification.'))}</p>`;
    return `<article class="panel safety-today-panel"><div class="safety-section-heading"><div><p class="eyebrow">${esc(formatDate(state.date))}</p><h2>${esc(tr('Today’s record'))}</h2><p>${esc(tr('Open the focused checklist to record or update checks and hazards.'))}</p></div><button type="button" class="primary" data-safety-action="checks">${esc(tr('Complete today’s checks'))}</button></div><div class="safety-today-list">${checkRows}</div><div class="safety-subsection-heading"><h3>${esc(tr('Hazards and corrective actions'))}</h3><button type="button" class="secondary small" data-safety-action="hazard">＋ ${esc(tr('Flag a hazard'))}</button></div><div class="safety-today-list">${hazardRows}</div><p class="safety-coverage-note">${esc(isSpanish() ? 'Revisiones iniciales de Oregón · no es una certificación de cumplimiento' : (state.data?.notice || 'Oregon starter checks · not a compliance certification'))}</p></article>`;
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
    const rows = [];
    for (const report of reportsForProject()) {
      if (!submittedSafetyEvidence(report)) continue;
      const when = reportDateValue(report), common = { when, reportId: report.id, status: report.status || '' };
      if (report.safetyEvidence) rows.push({ ...common, kind: isSpanish() ? 'Evidencia diaria guardada' : 'Saved daily evidence', title: report.safetyEvidence.summary?.unresolved ? `${report.safetyEvidence.summary.unresolved} ${isSpanish() ? 'pendientes guardados al enviar' : 'unresolved at submission'}` : (isSpanish() ? 'Documentación guardada al enviar' : 'Documentation saved at submission') });
      if (String(report.safetyInspection || '').trim()) rows.push({ ...common, kind: isSpanish() ? 'Inspección' : 'Inspection', title: report.safetyInspection });
      if (String(report.safetyIncident || '').trim()) rows.push({ ...common, kind: isSpanish() ? 'Incidente' : 'Incident', title: report.safetyIncident });
    }
    for (const entry of state.data?.day?.history || []) rows.push({ when: entry.at || state.date, kind: isSpanish() ? 'Historial del proyecto' : 'Project safety history', title: entry.action || entry.type || (isSpanish() ? 'Registro actualizado' : 'Record updated'), detail: entry.by || entry.actor?.name || entry.actor || '' });
    return rows.sort((a, b) => String(b.when || '').localeCompare(String(a.when || ''))).slice(0, 40);
  }

  function recordsMarkup() {
    const rows = recordRows();
    return `<article class="panel safety-library-panel"><div class="safety-section-heading"><div><p class="eyebrow">${esc(tr('Safety records'))}</p><h2>${esc(isSpanish() ? 'Evidencia que puede encontrar después' : 'Evidence you can find later')}</h2><p>${esc(isSpanish() ? 'La evidencia enviada de cualquier fecha y la actividad de la fecha seleccionada permanecen ligadas al proyecto.' : 'Submitted evidence from any date and activity from the selected date stay tied to the project.')}</p></div></div><div class="safety-record-list">${rows.length ? rows.map(row => `<article><div class="safety-record-icon" aria-hidden="true">✓</div><div><small>${esc(row.kind)} · ${esc(dateValue(row.when) ? formatDate(row.when) : formatDateTime(row.when))}${row.status ? ` · ${esc(reportStatusLabel(row.status))}` : ''}</small><strong>${esc(row.title)}</strong>${row.detail ? `<p>${esc(row.detail)}</p>` : ''}</div>${row.reportId ? `<button type="button" class="secondary small" data-safety-action="report" data-report-id="${esc(row.reportId)}">${esc(tr('View daily'))}</button>` : ''}</article>`).join('') : `<div class="safety-calm-empty"><span aria-hidden="true">▤</span><div><strong>${esc(tr('No safety records have been saved for this project yet.'))}</strong><p>${esc(isSpanish() ? 'Los registros enviados y el historial aparecerán aquí.' : 'Submitted records and follow-up history will appear here.')}</p></div></div>`}</div></article>`;
  }

  function panelMarkup(tab) {
    if (state.loading) return `<div class="panel safety-loading" aria-busy="true"><span></span><strong>${esc(tr('Loading the latest safety record…'))}</strong></div>`;
    if (state.error) return `<div class="panel safety-error"><strong>${esc(tr('Safety records could not be loaded.'))}</strong><p>${esc(state.error)}</p><button type="button" class="secondary" data-safety-action="reload">${esc(tr('Try again'))}</button></div>`;
    if (!state.projectId) return `<div class="panel safety-error"><strong>${esc(tr('Choose a project to begin.'))}</strong></div>`;
    if (tab === 'overview') return overviewMarkup();
    if (tab === 'today') return todayMarkup();
    if (tab === 'talks') return talksMarkup();
    if (tab === 'forms') return formsMarkup();
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
    if (heading) { heading.querySelector('.eyebrow').textContent = tr('FIELD SAFETY'); heading.querySelector('h1').textContent = tr('Safety'); heading.querySelector('p:last-child').textContent = tr('See what needs attention, complete today’s records, and find the evidence later.'); }
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

  function openFocused(action, opener) {
    if (!state.projectId) return;
    const done = action === 'hazard' && window.PDLSafetyPM?.open
      ? window.PDLSafetyPM.open({ projectId: state.projectId, date: state.date, opener })
      : window.PDLSafety?.open(state.projectId, state.date);
    if (action === 'hazard') Promise.resolve(done).then(() => {
      const dialog = element('safety-pm-dialog'), openHazard = dialog?.querySelector('[data-safety-open-hazard]');
      if (openHazard) return openHazard.click();
      const prepare = dialog?.querySelector('[data-safety-generate]'), setup = dialog?.querySelector('[data-safety-profile] input, [data-safety-profile] button');
      const notice = dialog?.querySelector('[data-safety-notice]');
      if (notice) { notice.textContent = prepare ? 'Prepare today’s checks before adding the hazard.' : 'Complete the project safety setup before adding the hazard.'; notice.hidden = false; notice.classList.add('is-error'); }
      (prepare || setup)?.focus();
    });
  }

  function openReportFlow(templateId = null, talk = false) {
    const projectIndex = projectIndexById(state.projectId, allProjects());
    if (projectIndex < 0 || typeof openReport !== 'function') return;
    const memberId = typeof currentUser === 'undefined' ? null : Number(currentUser?.memberId);
    const sourceAssignment = (typeof assignments === 'undefined' ? [] : assignments).find(row => Number(row.projectId) === Number(state.projectId) && row.date === state.date && (!memberId || (row.memberIds || []).map(Number).includes(memberId)));
    openReport(null, { projectIndex, dateIso: state.date, ...(sourceAssignment ? { assignmentId: sourceAssignment.id } : {}), ...(templateId ? { templateId } : {}) });
    const template = templateId ? templateList().find(row => String(row.id) === String(templateId)) : null;
    const structuredForm = template && FORM_CATEGORIES.has(template.category);
    if (talk || structuredForm) {
      const type = element('report-type'); if (type) type.value = 'superintendent';
      if (typeof applyReportType === 'function') applyReportType();
    }
    if (talk || structuredForm) {
      if (typeof showReportStep === 'function') showReportStep(2);
      requestAnimationFrame(() => {
        if (talk) return element('safety-talk')?.focus();
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

  function handleAction(button) {
    const action = button.dataset.safetyAction;
    if (['setup', 'checks', 'followups', 'hazard'].includes(action)) return openFocused(action, button);
    if (action === 'talk') return openReportFlow(null, true);
    if (action === 'open-forms') return selectTab('forms', true);
    if (action === 'form') return openReportFlow(button.dataset.templateId);
    if (action === 'manage-forms') return openFormsSettings();
    if (action === 'reload') return void load({ force: true });
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
    element('safety-workspace-project')?.addEventListener('change', event => { state.projectId = Number(event.target.value) || null; state.data = null; state.dataKey = ''; void load({ force: true }); });
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
    element('safety-workspace-panels')?.addEventListener('click', event => { const action = event.target.closest('[data-safety-action]'); if (action) handleAction(action); });
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
