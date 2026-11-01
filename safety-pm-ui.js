'use strict';

// Project safety is served by the same authenticated, tenant-scoped API as the daily.
// Draft input lives only in this open dialog; it is cleared when the account changes.
(function () {
  const TRADES = ['roofing', 'excavation', 'framing', 'demolition'];
  const LABELS = { roofing: 'Roofing', excavation: 'Excavation', framing: 'Framing', demolition: 'Demolition' };
  const STATUS = { pending: 'Needs check', pass: 'Checked', fail: 'Failed — unresolved', deferred: 'Deferred — unresolved', not_applicable: 'Not applicable' };
  const STATE_CODES = /^(AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC)$/;
  const STATE_LABELS = { OR: 'Oregon — starter coverage', WA: 'Washington — manual review needed', CA: 'California — manual review needed' };
  const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  const responsibleEmployer = (account, profile = {}) => account
    ? String(account.name || '').trim()
    : String(profile?.employer || '').trim();
  function jurisdictionFromProject(project, profile = {}) {
    for (const value of [project?.siteState, project?.addressState, project?.state]) {
      const code = String(value || '').trim().toUpperCase();
      if (STATE_CODES.test(code)) return code;
    }
    const address = String(project?.site || project?.address || '').trim();
    const postal = address.match(/(?:^|[,\s])(AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC)\s*(?:\d{5}(?:-\d{4})?)?(?:\s*,?\s*(?:USA|United States))?\s*$/i);
    if (postal) return postal[1].toUpperCase();
    const full = address.match(/\b(Oregon|Washington|California)(?:\s+\d{5}(?:-\d{4})?)?(?:\s*,?\s*(?:USA|United States))?\s*$/i);
    if (full) return ({ oregon: 'OR', washington: 'WA', california: 'CA' })[full[1].toLowerCase()];
    if (project) return '';
    const fallback = String(profile?.state || '').trim().toUpperCase();
    return STATE_CODES.test(fallback) ? fallback : '';
  }
  const sourceLink = source => {
    const value = typeof source === 'string' ? source : source?.url;
    try { const url = new URL(value); return url.protocol === 'https:' ? `<a href="${esc(url.href)}" target="_blank" rel="noopener noreferrer">Read the rule source ↗</a>` : ''; } catch { return ''; }
  };
  const statusLabel = status => STATUS[status] || 'Needs review';
  const workDate = value => /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) ? `${String(value).slice(5,7)}/${String(value).slice(8,10)}/${String(value).slice(0,4)}` : String(value || '');
  const dateTime = value => { const date = new Date(value); return Number.isFinite(date.valueOf()) ? date.toLocaleString('en-US', {year:'numeric',month:'2-digit',day:'2-digit',hour:'numeric',minute:'2-digit'}) : ''; };
  const catalogRows = catalog => Array.isArray(catalog) ? catalog : Array.isArray(catalog?.activities) ? catalog.activities : [];
  const unresolved = day => (day?.hazards || []).filter(item => !['verified', 'voided'].includes(item.status));

  function reportSafetyEvidenceMarkup(report, projectId, appLanguage = 'en') {
    const evidence = report?.safetyEvidence;
    if (!evidence || typeof evidence !== 'object') return '';
    const spanish = String(appLanguage || '').toLowerCase().startsWith('es');
    const copy = value => spanish ? ({
      'SAVED DAILY EVIDENCE': 'EVIDENCIA DIARIA GUARDADA',
      'Safety record at submission': 'Registro de seguridad al enviarse',
      unresolved: 'sin resolver',
      'saved revision': 'revisión guardada',
      'Rule version not recorded': 'Versión de reglas no registrada',
      captured: 'capturado',
      'This is the safety snapshot saved with this daily, not the current project record. Unresolved items remain unresolved in this snapshot even if corrected later.': 'Esta es la evidencia de seguridad guardada con este reporte diario, no el registro actual del proyecto. Los pendientes permanecen sin resolver en esta evidencia aunque se corrijan después.',
      'Inspection responses': 'Respuestas de inspección',
      'Recorded by': 'Registrado por',
      'competent person': 'persona competente',
      Findings: 'Hallazgos', Action: 'Acción', 'Follow-up': 'Seguimiento', due: 'vence',
      'Not recorded': 'No registrado',
      'Toolbox talks': 'Charlas de seguridad',
      'Voided record': 'Registro anulado', Spanish: 'Español', English: 'Inglés',
      'Presented by': 'Presentado por',
      'recorded user': 'usuario registrado',
      'Voided by': 'Anulado por',
      'Corrected by': 'Corregido por',
      'original preserved in the audit history': 'original conservado en el historial de auditoría',
      'Presenter-reported attendance': 'Asistencia reportada por el presentador',
      'Hazards and carried follow-up': 'Peligros y seguimiento pendiente',
      'Safety hazard': 'Peligro de seguridad',
      'Verified closed': 'Cierre verificado', 'Recorded in error': 'Registrado por error',
      'Corrected - needs verification': 'Corregido - necesita verificación',
      'Open - unresolved': 'Abierto - sin resolver',
      'Originally recorded': 'Registrado originalmente',
      'Location not recorded': 'Ubicación no registrada',
      Unassigned: 'Sin responsable', Verification: 'Verificación',
      'Affected work recorded as stopped.': 'El trabajo afectado se registró como detenido.',
      'No hazards were included in this saved record. This is not a hazard-free certification.': 'No se incluyeron peligros en este registro guardado. Esto no certifica que el sitio estuviera libre de peligros.',
      'Open current safety record': 'Abrir registro de seguridad actual',
      'Needs check': 'Necesita revisión', Checked: 'Revisado',
      'Failed — unresolved': 'Falló — sin resolver',
      'Deferred — unresolved': 'Aplazado — sin resolver',
      'Not applicable': 'No aplica', 'Needs review': 'Necesita revisión',
      'Toolbox talk': 'Charla de seguridad'
    }[value] || value) : value;
    const evidenceDateTime = value => { const valueDate = new Date(value); return Number.isFinite(valueDate.valueOf()) ? dateTime(value) : ''; };
    const checks = Array.isArray(evidence.checks) ? evidence.checks : [];
    const talks = Array.isArray(evidence.talks) ? evidence.talks : [];
    const hazards = [...(Array.isArray(evidence.hazards) ? evidence.hazards : []), ...(Array.isArray(evidence.carriedHazards) ? evidence.carriedHazards : [])];
    const count = Number.isSafeInteger(evidence.summary?.unresolved) ? evidence.summary.unresolved : checks.filter(check => ['fail', 'deferred'].includes(check.status)).length + hazards.filter(hazard => !['verified', 'voided'].includes(hazard.status)).length;
    const checkStatus = status => copy(STATUS[status] || 'Needs review');
    const hazardStatus = status => copy(status === 'voided' ? 'Recorded in error' : status === 'verified' ? 'Verified closed' : status === 'corrected' ? 'Corrected - needs verification' : 'Open - unresolved');
    const details = hazards.map(hazard => `<li><strong>${esc(hazard.observation || copy('Safety hazard'))}</strong><span class="safety-evidence-status">${esc(hazardStatus(hazard.status))}</span>${hazard.date ? `<small>${esc(copy('Originally recorded'))} ${esc(workDate(hazard.date))}</small>` : ''}${hazard.createdBy ? `<small>${esc(copy('Recorded by'))} ${esc(hazard.createdBy)}${hazard.createdAt ? ` · ${esc(evidenceDateTime(hazard.createdAt))}` : ''}</small>` : ''}<p>${esc(hazard.location || copy('Location not recorded'))}</p><p>${esc(copy('Action'))}: ${esc(hazard.action || copy('Not recorded'))}</p><p>${esc(copy('Follow-up'))}: ${esc(hazard.owner || copy('Unassigned'))}${hazard.dueDate ? ` · ${esc(copy('due'))} ${esc(workDate(hazard.dueDate))}` : ''}</p>${hazard.voidReason ? `<p>${esc(copy('Recorded in error'))}: ${esc(hazard.voidReason)} · ${esc(hazard.voidedBy || '')}</p>` : ''}${hazard.verification ? `<p>${esc(copy('Verification'))}: ${esc(hazard.verification)}</p>` : ''}${hazard.workStopped ? `<small>${esc(copy('Affected work recorded as stopped.'))}</small>` : ''}</li>`).join('');
    const talkDetails = talks.map(talk => {
      const attendees = Array.isArray(talk.attendees) ? talk.attendees.map(row => typeof row === 'string' ? row : row?.name).filter(Boolean) : [];
      const correction = talk.voidedAt ? `${copy('Voided by')} ${talk.voidedBy || copy('recorded user')}${talk.voidReason ? ` — ${talk.voidReason}` : ''}` : talk.amendedAt ? `${copy('Corrected by')} ${talk.amendedBy || copy('recorded user')}; ${copy('original preserved in the audit history')}` : '';
      return `<li><strong>${esc(talk.topic || copy('Toolbox talk'))}</strong><span class="safety-evidence-status">${esc(copy(talk.voidedAt ? 'Voided record' : talk.language === 'es' ? 'Spanish' : 'English'))}</span><small>${esc(copy('Presented by'))} ${esc(talk.presenter || copy('Not recorded'))}${talk.recordedAt ? ` · ${esc(evidenceDateTime(talk.recordedAt))}` : ''}</small>${correction ? `<p><strong>${esc(correction)}</strong></p>` : ''}${talk.notes ? `<p>${esc(talk.notes)}</p>` : ''}<p>${esc(copy('Presenter-reported attendance'))}: ${esc(attendees.length ? attendees.join(', ') : copy('Not recorded'))}</p></li>`;
    }).join('');
    return `<section class="report-safety-evidence" data-safety-evidence><div class="safety-evidence-heading"><div><small>${esc(copy('SAVED DAILY EVIDENCE'))}</small><h3>${esc(copy('Safety record at submission'))}</h3></div><strong class="safety-evidence-total ${count ? 'is-unresolved' : ''}">${esc(count)} ${esc(copy('unresolved'))}</strong></div><p class="safety-evidence-meta">${esc(workDate(evidence.date || report.dateIso || ''))} · ${esc(copy('saved revision'))} ${esc(evidence.dayRevision)} · ${esc(evidence.ruleVersion || copy('Rule version not recorded'))}${evidence.capturedAt ? ` · ${esc(copy('captured'))} ${esc(evidenceDateTime(evidence.capturedAt))}` : ''}</p><p>${esc(copy('This is the safety snapshot saved with this daily, not the current project record. Unresolved items remain unresolved in this snapshot even if corrected later.'))}</p><details><summary>${esc(copy('Inspection responses'))} (${checks.length})</summary><ol>${checks.map(check => `<li><strong>${esc(check.title || check.id)}</strong><span class="safety-evidence-status">${esc(checkStatus(check.status))}</span><small>${esc(copy('Recorded by'))} ${esc(check.recordedBy || check.inspector || copy('Not recorded'))}${check.competentPerson ? ` · ${esc(copy('competent person'))}: ${esc(check.competentPerson)}` : ''}</small><p>${esc(copy('Findings'))}: ${esc(check.notes || copy('Not recorded'))}</p>${check.action ? `<p>${esc(copy('Action'))}: ${esc(check.action)}</p>` : ''}${check.owner ? `<p>${esc(copy('Follow-up'))}: ${esc(check.owner)}${check.dueDate ? ` · ${esc(copy('due'))} ${esc(workDate(check.dueDate))}` : ''}</p>` : ''}</li>`).join('')}</ol></details>${talks.length ? `<details><summary>${esc(copy('Toolbox talks'))} (${talks.length})</summary><ol>${talkDetails}</ol></details>` : ''}${hazards.length ? `<details><summary>${esc(copy('Hazards and carried follow-up'))} (${hazards.length})</summary><ol>${details}</ol></details>` : `<p>${esc(copy('No hazards were included in this saved record. This is not a hazard-free certification.'))}</p>`}${Number.isSafeInteger(Number(projectId)) && Number(projectId) > 0 ? `<button type="button" class="secondary" data-open-safety-pm data-project-id="${esc(projectId)}" data-date="${esc(evidence.date || report.dateIso || '')}">${esc(copy('Open current safety record'))}</button>` : ''}</section>`;
  }

  // Exposed only for plain renderer tests; Node never initializes a browser session.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { esc, sourceLink, statusLabel, catalogRows, unresolved, reportSafetyEvidenceMarkup, responsibleEmployer, jurisdictionFromProject };
    return;
  }

  const COPY_ES = {
    'Safety today': 'Seguridad de hoy', 'Check the work. Fix what matters. Keep the record.': 'Revise el trabajo. Corrija lo importante. Guarde el registro.',
    'Change project or date': 'Cambiar proyecto o fecha', Project: 'Proyecto', 'Work date': 'Fecha de trabajo', Reload: 'Actualizar',
    'Project safety setup': 'Configuración de seguridad', 'Turn on Safety': 'Activar Seguridad', 'Save setup': 'Guardar configuración',
    Company: 'Empresa', Jurisdiction: 'Jurisdicción', 'From Company settings': 'Desde la configuración de la empresa', 'From project address': 'Desde la dirección del proyecto',
    'Edit work types': 'Editar tipos de trabajo', 'Work prepared for this project': 'Trabajo preparado para este proyecto',
    'Safety checks are not enabled here yet': 'Las revisiones de seguridad aún no están activadas',
    'Ask the project manager or account owner to turn on Safety for this project.': 'Pida al gerente del proyecto o al propietario que active Seguridad para este proyecto.',
    'Manual safety review required': 'Se requiere revisión manual de seguridad', 'Checks prepared for today': 'Revisiones preparadas para hoy',
    Check: 'Revisión', of: 'de', 'Looks good': 'Se ve bien', 'Needs action': 'Necesita acción', 'Not applicable': 'No aplica',
    'Who completed the inspection?': '¿Quién realizó la inspección?', 'Why does this not apply?': '¿Por qué no aplica?',
    'What did you find?': '¿Qué encontró?', 'What did you do immediately?': '¿Qué hizo de inmediato?',
    'Who owns the follow-up?': '¿Quién es responsable del seguimiento?', 'Due date': 'Fecha límite',
    'Affected work is stopped until this is resolved': 'El trabajo afectado está detenido hasta resolverlo',
    'Save & next': 'Guardar y seguir', 'Save check': 'Guardar revisión', Back: 'Atrás', Done: 'Listo',
    'Today’s safety check is complete': 'La revisión de seguridad de hoy está completa', 'checks recorded': 'revisiones registradas',
    'follow-up assigned': 'seguimiento asignado', 'follow-ups assigned': 'seguimientos asignados', 'View follow-up': 'Ver seguimiento',
    'Report a hazard': 'Reportar un peligro', 'Record a toolbox talk': 'Registrar charla de seguridad',
    'What did you see?': '¿Qué vio?', 'Where was it?': '¿Dónde estaba?', 'What protected people right away?': '¿Qué protegió a las personas de inmediato?',
    'What happens next?': '¿Qué sigue?', 'Fixed now — PM verification needed': 'Corregido ahora — requiere verificación del gerente', 'Needs follow-up': 'Necesita seguimiento',
    'Was affected work stopped or kept clear?': '¿Se detuvo o aisló el trabajo afectado?', Yes: 'Sí', No: 'No', 'Save hazard': 'Guardar peligro',
    'Talk topic': 'Tema de la charla', 'Key points or notes (optional)': 'Puntos clave o notas (opcional)', Language: 'Idioma', English: 'Inglés', Spanish: 'Español',
    'Crew reported present': 'Personal reportado presente', 'Save toolbox talk': 'Guardar charla', 'Follow-up': 'Seguimiento',
    'Open hazard': 'Peligro abierto', 'Corrected — waiting for verification': 'Corregido — esperando verificación', 'Verified closed': 'Cerrado y verificado',
    'Corrective action': 'Acción correctiva', 'Mark corrected': 'Marcar corregido', 'Verification findings': 'Hallazgos de verificación', 'Verify closed': 'Verificar cierre',
    'No open follow-up': 'No hay seguimientos abiertos', 'Keep watching for changing conditions.': 'Siga observando condiciones cambiantes.',
    'Review source': 'Ver fuente', 'Saving…': 'Guardando…', 'Safety record updated.': 'Registro de seguridad actualizado.'
  };
  const CHECK_ES = {
    'scope-confirmation': ['Confirme el trabajo y las condiciones reales de hoy', 'Revise el trabajo programado y no programado, las exposiciones y a otros empleadores en el sitio.'],
    'site-walk': ['Recorra el área de trabajo y atienda peligros inmediatos', 'Revise acceso, orden y limpieza, arreglos de emergencia y condiciones que hayan cambiado.'],
    'roofing-protection': ['Confirme el acceso al techo y el sistema contra caídas', 'Revise altura, pendiente, bordes expuestos, protección seleccionada y plan de rescate.'],
    'roofing-openings': ['Proteja aberturas y tragaluces', 'Revise cubiertas u otra protección adecuada para cada abertura.'],
    'excavation-inspection': ['Registre la inspección de excavación de la persona competente', 'Confirme condiciones, sistema protector, acceso y decisiones correctivas con la persona competente designada.'],
    'excavation-protection': ['Confirme protección, servicios y acceso seguro de la excavación', 'Revise profundidad, suelo, servicios, acceso, material excavado y otras exposiciones.'],
    'framing-edges': ['Proteja bordes, aberturas y superficies de trabajo', 'Confirme protección contra caídas y acceso seguro mientras cambia la estructura.'],
    'demolition-survey': ['Confirme el estudio de demolición, servicios y secuencia', 'Confirme el estudio requerido, controles de servicios y secuencia segura con la persona competente.']
  };
  let active = null, sequence = 0, dialog = null, returnFocus = null;
  const user = () => typeof currentUser === 'undefined' ? null : currentUser;
  const language = () => ((typeof preferredLanguage !== 'undefined' ? preferredLanguage : user()?.preferredLanguage || document.documentElement.lang || 'en').startsWith('es') ? 'es' : 'en');
  const tr = value => language() === 'es' ? (COPY_ES[value] || value) : value;
  const activityLabel = value => language() === 'es' ? ({ roofing: 'Techos', excavation: 'Excavación', framing: 'Estructura', demolition: 'Demolición', general: 'Revisión del sitio' }[value] || value) : (LABELS[value] || value || 'Site check');
  const checkText = (check, index) => language() === 'es' ? (CHECK_ES[check.id]?.[index] || (index ? check.description : check.title) || '') : ((index ? check.description : check.title) || '');
  const identity = () => JSON.stringify([
    typeof signedInCompanyId === 'function' ? signedInCompanyId() : '',
    typeof company === 'undefined' ? '' : company?.id,
    user()?.id, user()?.role, user()?.projectIds, user()?.permissions, user()?.assignedCrews,
    typeof currentRole === 'undefined' ? '' : currentRole
  ]);
  const permitted = () => user()?.id && ['owner', 'admin', 'project_manager', 'foreman', 'field'].includes(user()?.role);
  const projectList = () => typeof projects === 'undefined' ? [] : projects.filter(project => !project.archived);
  const today = () => typeof companyTodayIso === 'function' ? companyTodayIso() : new Date().toISOString().slice(0, 10);
  const current = state => Boolean(state && active === state && state.sequence === sequence && state.identity === identity() && permitted() && dialog?.open);
  const base = state => `/api/projects/${encodeURIComponent(state.projectId)}/safety`;
  const dayBase = state => `${base(state)}/days/${encodeURIComponent(state.date)}`;
  const value = (form, name) => String(new FormData(form).get(name) || '').trim();

  function close() {
    const reportReturn = active?.reportReturn;
    sequence++;
    active?.controller?.abort();
    active = null;
    if (dialog?.open) dialog.close();
    if (dialog) dialog.querySelector('[data-safety-body]').replaceChildren();
    if (returnFocus?.isConnected) returnFocus.focus();
    if (reportReturn) void refreshDailySafety(reportReturn);
  }

  function dailyContext() {
    const modal = document.getElementById('report-modal');
    if (!modal?.open) return null;
    return { identity: identity(), projectId: projects[Number(document.getElementById('report-project')?.value)]?.id,
      date: document.getElementById('report-date')?.value, sequence: reportAnalyzeSequence };
  }

  async function refreshDailySafety(context) {
    const matches = () => JSON.stringify(dailyContext()) === JSON.stringify(context);
    if (!matches()) return;
    try {
      const data = await api(`${base(context)}?date=${encodeURIComponent(context.date)}`);
      if (!matches()) return;
      const ready = data.profile?.enabled === false || data.day?.summary?.canSubmit === true;
      showReportMessage(ready
        ? (language() === 'es' ? 'Seguridad revisada. Puede intentar enviar el parte.' : 'Safety reviewed. You can try sending the daily now.')
        : (data.day?.summary?.error || 'Review the remaining safety checks before sending this daily.'),
        ready ? 'success' : 'error', ready ? '' : 'SAFETY_CHECKS_REQUIRED');
    } catch (error) {
      if (matches()) showReportMessage('Safety status could not be checked. Review safety checks before sending.', 'error', 'SAFETY_CHECKS_REQUIRED');
    }
  }

  function notice(state, text, error = false) {
    if (!current(state)) return;
    const target = dialog.querySelector('[data-safety-notice]');
    target.textContent = text;
    target.hidden = !text;
    target.setAttribute('role', error ? 'alert' : 'status');
    target.classList.toggle('is-error', error);
  }

  function busy(state, enabled) {
    if (!current(state)) return;
    state.busy = enabled;
    dialog.querySelector('[data-safety-body]').setAttribute('aria-busy', String(enabled));
    dialog.querySelectorAll('[data-safety-body] button,[data-safety-body] input,[data-safety-body] select,[data-safety-body] textarea,[data-safety-context] input,[data-safety-context] select,[data-safety-reload]').forEach(node => { node.disabled = enabled; });
  }

  function captureDrafts(state, except) {
    if (!current(state)) return [];
    return [...dialog.querySelectorAll('form[data-form-key]')].filter(form => form.dataset.dirty === 'true' && form.dataset.formKey !== except).map(form => ({
      key: form.dataset.formKey,
      revision: form.dataset.revision,
      open: form.closest('details')?.open,
      values: [...form.querySelectorAll('input,textarea,select')].map(node => ({ name: node.name, value: node.value, checked: node.checked }))
    }));
  }

  function restoreDrafts(state, drafts) {
    for (const draft of drafts) {
      const form = [...dialog.querySelectorAll('form[data-form-key]')].find(node => node.dataset.formKey === draft.key);
      if (!form) continue;
      form.dataset.revision = draft.revision;
      form.dataset.dirty = 'true';
      for (const saved of draft.values) {
        const node = [...form.elements].find(input => input.name === saved.name && (input.type !== 'checkbox' || input.value === saved.value));
        if (!node) continue;
        node.value = saved.value;
        if (node.type === 'checkbox') node.checked = saved.checked;
      }
      if (draft.open && form.closest('details')) form.closest('details').open = true;
      revealConditional(form);
    }
    state.dirty = drafts.length > 0;
  }

  function revisionField(state) { return esc(state.data?.day?.revision || 0); }
  function fields(names, initial = {}) {
    return names.map(([name, label, type, required]) => `<label>${esc(label)}${type === 'textarea' ? `<textarea name="${name}" rows="2" maxlength="${name === 'observation' ? 1000 : 1000}" ${required ? 'required' : ''}>${esc(initial[name])}</textarea>` : `<input name="${name}" type="${type || 'text'}" value="${esc(initial[name])}" ${required ? 'required' : ''} ${type !== 'date' ? 'maxlength="300"' : ''}>`}</label>`).join('');
  }

  function photoPicker(state) {
    const rows = typeof photos === 'undefined' ? [] : photos;
    const projectIndex = typeof projects === 'undefined' ? -1 : projects.findIndex(project => Number(project.id) === Number(state.projectId));
    const available = rows.filter(photo => !photo.deletedAt && (Number(photo.projectId) === Number(state.projectId) || projectIndex >= 0 && Number(photo.project) === projectIndex));
    return `<label>Attach a project photo (optional)<select name="photoId"><option value="">No photo selected</option>${available.map(photo => `<option value="${esc(photo.id)}">${esc(photo.caption || 'Project photo')}${photo.createdAt ? ` · ${esc(dateTime(photo.createdAt))}` : ''}</option>`).join('')}</select></label>`;
  }

  function hazardStopControl(hazard) {
    return `<label class="safety-checkbox"><input type="checkbox" name="workStopped" ${hazard.workStopped === true ? 'checked' : ''}><span>Affected work has been stopped pending resolution</span></label>`;
  }

  function profileMarkup(state) {
    const profile = state.data.profile || {}, configured = profile.enabled === true;
    if (configured && state.mode !== 'setup') return '';
    if (!state.data.canManage) return !configured ? `<section class="safety-v3-empty"><span aria-hidden="true">○</span><h3>${esc(tr('Safety checks are not enabled here yet'))}</h3><p>${esc(tr('Ask the project manager or account owner to turn on Safety for this project.'))}</p></section>` : '';
    const project = projectList().find(row => Number(row.id) === Number(state.projectId));
    const account = typeof company === 'undefined' ? null : company, accountEmployer = String(account?.name || '').trim();
    const employer = responsibleEmployer(account, profile);
    const inferred = String(state.data.inferredState || '').trim().toUpperCase();
    const jurisdiction = inferred || jurisdictionFromProject(project, profile);
    const stateLabel = jurisdiction === 'OR' ? (language() === 'es' ? 'Oregón' : 'Oregon') : jurisdiction || (language() === 'es' ? 'No encontrada' : 'Not found');
    const address = String(project?.site || project?.address || '').trim();
    const ready = Boolean(accountEmployer && inferred), activities = profile.activities || [], canDisable = ['owner', 'admin'].includes(String(user()?.role || '').toLowerCase());
    return `<section class="safety-v3-setup ${configured ? 'is-configured' : ''}"><div class="safety-v3-section-title"><div><small>${esc(tr('Project safety setup'))}</small><h3>${esc(configured ? (language() === 'es' ? 'Seguridad activada' : 'Safety is on') : (language() === 'es' ? 'Configure una vez' : 'Set it once'))}</h3></div>${configured ? '<span class="safety-v3-badge is-good">✓ On</span>' : ''}</div><form data-form-key="profile" data-safety-profile data-revision="${esc(profile.revision || 0)}"><input name="employer" type="hidden" value="${esc(employer)}"><input name="state" type="hidden" value="${esc(jurisdiction)}"><input name="enabled" type="hidden" value="true"><div class="safety-v3-source-grid"><article class="${accountEmployer ? 'is-ready' : 'is-missing'}"><small>${esc(tr('Company'))}</small><strong>${esc(employer || (language() === 'es' ? 'Falta el nombre' : 'Name missing'))}</strong><span>${accountEmployer ? `✓ ${esc(tr('From Company settings'))}` : esc(language() === 'es' ? 'Agregue el nombre en Configuración de empresa.' : 'Add the company name in Company settings.')}</span></article><article class="${inferred ? 'is-ready' : 'is-missing'}"><small>${esc(tr('Jurisdiction'))}</small><strong>${esc(stateLabel)}</strong><span>${inferred ? `✓ ${esc(tr('From project address'))}` : esc(language() === 'es' ? 'Agregue el estado a la dirección del proyecto.' : 'Add a state to the project address.')}</span>${address ? `<em>${esc(address)}</em>` : ''}</article></div><div class="safety-v3-work-summary"><small>${esc(tr('Work prepared for this project'))}</small><div class="safety-v3-chips">${activities.length ? activities.map(item => `<span>${esc(activityLabel(item))}</span>`).join('') : `<span class="is-muted">${esc(language() === 'es' ? 'Elija el trabajo realizado en esta obra' : 'Choose the work performed on this job')}</span>`}</div><p>${esc(language() === 'es' ? 'Solo los trabajos seleccionados agregan revisiones específicas. Registre otros peligros por separado.' : 'Only selected work types add trade checks. Add site-specific hazards separately.')}</p></div><details class="safety-v3-advanced" ${configured ? '' : 'open'}><summary>${esc(tr('Edit work types'))}</summary><fieldset><legend class="sr-only">${esc(tr('Work prepared for this project'))}</legend><div class="safety-trades">${TRADES.map(trade => `<label><input type="checkbox" name="activities" value="${trade}" ${activities.includes(trade) ? 'checked' : ''}><span>${esc(activityLabel(trade))}</span></label>`).join('')}</div></fieldset></details><p class="safety-v3-guardrail">${esc(language() === 'es' ? 'Los registros de seguridad se requieren con los reportes diarios de este proyecto.' : 'Safety records are required with this project’s dailies.')}</p><button class="primary safety-v3-primary" type="submit" ${ready ? '' : 'disabled'}>${esc(tr(configured ? 'Save setup' : 'Turn on Safety'))}</button>${configured && canDisable ? `<button class="secondary safety-v3-turn-off" type="button" data-safety-turn-off>${esc(language() === 'es' ? 'Desactivar Seguridad' : 'Turn off Safety')}</button>` : ''}</form></section>`;
  }

  function demoMarkup(state) {
    return '';
  }

  function checkMarkup(state, check) {
    const initial = { ...check, inspector: check.inspector || user()?.name || '' }, status = check.status || 'pending', needsPerson = check.requiresCompetentPerson === true;
    return `<article class="safety-check safety-status-${esc(status)}"><div class="safety-check-head"><div><small>${esc(check.activity === 'general' ? 'Site check' : LABELS[check.activity] || check.activity || 'Site check')}${check.timing ? ` · ${esc(check.timing)}` : ''}</small><h3>${esc(check.title)}</h3></div><span class="safety-state">${esc(statusLabel(status))}</span></div>${check.description ? `<p>${esc(check.description)}</p>` : ''}<details class="safety-response"><summary>${status === 'pending' ? 'Record check' : 'Review or update response'}</summary><form data-form-key="check-${esc(check.id)}" data-safety-check="${esc(check.id)}" data-revision="${revisionField(state)}"><div class="safety-grid"><label>Response<select name="status" required><option value="pending" ${status === 'pending' ? 'selected' : ''}>Choose a response</option>${['pass', 'fail', 'deferred', 'not_applicable'].map(option => `<option value="${option}" ${status === option ? 'selected' : ''}>${esc(STATUS[option])}</option>`).join('')}</select></label>${fields([['inspector', 'Person recording the check', 'text', true]], initial)}${needsPerson ? fields([['competentPerson', 'Competent person who inspected this work', 'text', true]], initial) : ''}</div>${needsPerson ? '<p class="safety-help">Record the actual designated competent person. Entering a name does not establish qualification or site presence.</p>' : ''}${fields([['notes', 'Findings or reason this does not apply', 'textarea']], initial)}<div data-response-unresolved ${['fail', 'deferred'].includes(status) ? '' : 'hidden'}><div class="safety-warning">This remains unresolved. Record the protection or work stoppage and follow-up; a documented response does not clear the work.</div>${fields([['action', 'Immediate protection / corrective action', 'textarea']], initial)}<div class="safety-grid">${fields([['owner', 'Person responsible for follow-up', 'text'], ['dueDate', 'Follow-up due date', 'date']], initial)}</div><label class="safety-checkbox"><input type="checkbox" name="workStopped" ${check.workStopped ? 'checked' : ''}><span>Affected work is stopped pending resolution</span></label></div><div class="safety-form-actions"><button class="primary" type="submit">Save response</button></div></form></details><details class="safety-rule"><summary>Why this check appears</summary><p>${esc(check.ruleVersion || state.data.day?.ruleVersion || '')}</p>${sourceLink(check.source)}</details>${check.updatedBy || check.updatedAt ? `<small class="safety-help">Last recorded by ${esc(check.updatedBy || '')}${check.updatedAt ? ` · ${esc(dateTime(check.updatedAt))}` : ''}</small>` : ''}</article>`;
  }

  function hazardMarkup(state, hazard) {
    const status = hazard.status || 'open', canVerify = state.data.canManage;
    return `<article class="safety-hazard ${status === 'verified' ? 'is-verified' : ''}"><div class="safety-check-head"><div><small>${esc(hazard.location || 'Location not recorded')}</small><h3>${esc(hazard.observation)}</h3></div><span class="safety-state">${esc(status === 'verified' ? 'Verified closed' : status === 'corrected' ? 'Corrected — verify' : 'Open hazard')}</span></div><p>${esc(hazard.action || 'No immediate action recorded.')}</p><small class="safety-help">Follow-up: ${esc(hazard.owner || 'Unassigned')}${hazard.dueDate ? ` · due ${esc(workDate(hazard.dueDate))}` : ''}${hazard.date && hazard.date !== state.date ? ` · reported ${esc(hazard.date)}` : ''}</small>${hazard.workStopped ? '<p class="safety-work-stopped">Affected work stopped</p>' : ''}${hazard.photoId ? `<p class="safety-help">Project photo attached</p>` : ''}${hazard.date && hazard.date !== state.date ? `<button type="button" class="secondary" data-safety-select-date="${esc(hazard.date)}">Open ${esc(hazard.date)} follow-up</button>` : ''}${status !== 'verified' && (!hazard.date || hazard.date === state.date) ? `<details class="safety-response"><summary>Update follow-up</summary><form data-form-key="hazard-${esc(hazard.id)}" data-safety-hazard-update="${esc(hazard.id)}" data-revision="${revisionField(state)}"><label>Status<select name="status"><option value="open" ${status === 'open' ? 'selected' : ''}>Open — follow-up needed</option><option value="corrected" ${status === 'corrected' ? 'selected' : ''}>Corrected — needs verification</option>${canVerify ? '<option value="verified">Verified closed by PM / office</option>' : ''}</select></label>${fields([['action', 'Corrective action', 'textarea'], ['owner', 'Responsible person', 'text'], ['dueDate', 'Follow-up due date', 'date'], ['verification', 'Verification findings', 'textarea']], hazard)}${hazardStopControl(hazard)}<button class="primary" type="submit">Save follow-up</button></form></details>` : hazard.verification ? `<p>${esc(hazard.verification)}</p>` : ''}</article>`;
  }

  function dayMarkup(state) {
    const day = state.data.day, profile = state.data.profile || {};
    if (!profile.enabled) return '';
    if (!day) return '<section class="safety-empty"><h3>Prepare today’s checks</h3><p>Use the project setup and scheduled work to prepare the record. Confirm actual site conditions before work starts.</p><button class="primary" type="button" data-safety-generate>Prepare checks</button></section>';
    const summary = day.summary || {}, checks = day.checks || [], hazards = day.hazards || [], count = checks.filter(check => check.status !== 'pending').length;
    const stale = summary.stale === true;
    const banner = stale ? 'Work or setup changed. Refresh checks before recording or submitting this daily.' : summary.pending > 0 ? 'Required checks still need a response.' : summary.unresolved > 0 || unresolved(day).length ? 'Documentation recorded. Unresolved safety issues still need action.' : summary.readyForWork ? 'Required starter checks are recorded. Continue to monitor changing conditions.' : 'Review required checks and project coverage before proceeding.';
    const older = (state.data.openHazards || []).filter(hazard => !hazards.some(item => item.id === hazard.id));
    return `<section class="safety-day"><div class="safety-progress"><div><small>DAILY SAFETY RECORD</small><h3>${count} of ${checks.length} checks recorded</h3><p>${esc(banner)}</p></div><strong class="safety-open-count">${Number(summary.unresolved || 0)}<span>unresolved</span></strong></div><div class="safety-progress-track" role="progressbar" aria-label="Checks recorded" aria-valuenow="${count}" aria-valuemin="0" aria-valuemax="${checks.length || 1}"><span style="width:${checks.length ? Math.round(count / checks.length * 100) : 0}%"></span></div>${summary.error ? `<p class="safety-warning">${esc(summary.error)}</p>` : ''}<div class="safety-day-toolbar"><p class="safety-help">${esc((day.activities || []).map(trade => LABELS[trade] || trade).join(' · '))}</p><button type="button" class="secondary" data-safety-generate>${stale ? 'Refresh changed checks' : 'Refresh from schedule'}</button></div><div class="safety-checks">${checks.map(check => checkMarkup(state, check)).join('')}</div><section class="safety-hazards-section"><div class="safety-section-title"><div><small>SEE IT. RECORD IT. FOLLOW THROUGH.</small><h3>Hazards & corrective actions</h3></div><button type="button" class="secondary" data-safety-open-hazard>＋ Flag a hazard</button></div><p class="safety-help">Saved hazards appear in this project’s safety view. No email, SMS or push alert is sent by this MVP.</p><details class="safety-hazard-create"><summary>Record a hazard</summary><form data-form-key="new-hazard" data-safety-hazard-create data-revision="${revisionField(state)}">${fields([['observation', 'What is the hazard?', 'textarea', true], ['location', 'Where is it?', 'text', true], ['action', 'Immediate protective action', 'textarea', true]], {})}<div class="safety-grid">${fields([['owner', 'Person responsible for follow-up', 'text', true], ['dueDate', 'Due date', 'date', true]], {})}</div>${photoPicker(state)}<label class="safety-checkbox"><input name="workStopped" type="checkbox"><span>Affected work has been stopped</span></label><p class="safety-help">Respond to immediate danger on site first. This record is not an emergency dispatch.</p><button class="primary" type="submit">Save hazard</button></form></details><div class="safety-hazards">${hazards.length ? hazards.map(hazard => hazardMarkup(state, hazard)).join('') : '<p class="safety-help">No hazards recorded for this date. That is not a hazard-free certification.</p>'}${older.length ? `<h4>Earlier unresolved hazards</h4>${older.map(hazard => hazardMarkup(state, hazard)).join('')}<p class="safety-help">Select the hazard’s original date to update its record.</p>` : ''}</div></section><details class="safety-history"><summary>Evidence history (${(day.history || []).length})</summary><ol>${(day.history || []).slice().reverse().map(entry => `<li><strong>${esc(entry.action || entry.type || 'Updated')}</strong><small>${esc(entry.by || entry.actor?.name || entry.actor || '')} · ${esc(dateTime(entry.at))}</small>${entry.checkId ? `<span>Check: ${esc(entry.checkId)}</span>` : ''}${entry.hazardId ? `<span>Hazard: ${esc(entry.hazardId)}</span>` : ''}</li>`).join('')}</ol><p class="safety-help">Rule pack: ${esc(day.ruleVersion)} · daily revision ${esc(day.revision)}</p></details></section>`;
  }

  function scheduledMembers(state) {
    const rows = typeof assignments === 'undefined' ? [] : assignments;
    const ids = new Set(rows.filter(row => Number(row.projectId) === Number(state.projectId) && row.date === state.date).flatMap(row => (row.memberIds || []).map(Number)));
    return (typeof team === 'undefined' ? [] : team).filter(member => ids.has(Number(member.id)));
  }

  function v3CheckChoices(status) {
    return `<div class="safety-v3-choice" role="group" aria-label="${esc(language() === 'es' ? 'Resultado de la revisión' : 'Check result')}"><button type="button" class="safety-v3-choice-good ${status === 'pass' ? 'is-selected' : ''}" data-check-choice="pass"><span aria-hidden="true">✓</span>${esc(tr('Looks good'))}</button><button type="button" class="safety-v3-choice-action ${['fail', 'deferred'].includes(status) ? 'is-selected' : ''}" data-check-choice="fail"><span aria-hidden="true">!</span>${esc(tr('Needs action'))}</button><button type="button" class="safety-v3-choice-na ${status === 'not_applicable' ? 'is-selected' : ''}" data-check-choice="not_applicable">${esc(tr('Not applicable'))}</button></div>`;
  }

  function v3CheckRunner(state) {
    const day = state.data.day, profile = state.data.profile || {};
    if (!profile.enabled) return '';
    if (state.data.coverage === 'manual-review') return `<section class="safety-v3-empty is-warning"><span aria-hidden="true">!</span><h3>${esc(tr('Manual safety review required'))}</h3><p>${esc(language() === 'es' ? 'Este proyecto está fuera de la cobertura inicial revisada de Oregón. Un responsable de seguridad debe revisar los requisitos aplicables.' : 'This project is outside the reviewed Oregon starter coverage. A safety lead must review the applicable requirements.')}</p></section>`;
    if (!day) return `<section class="safety-v3-loading" aria-busy="true"><span></span><strong>${esc(language() === 'es' ? 'Preparando las revisiones…' : 'Preparing checks…')}</strong></section>`;
    const checks = day.checks || [], completed = checks.filter(check => check.status && check.status !== 'pending').length, open = new Set([...unresolved(day), ...(state.data.openHazards || [])].filter(row => !['verified', 'voided'].includes(row.status)).map(row => row.id)).size;
    if (!checks.length) return `<section class="safety-v3-empty"><h3>${esc(language() === 'es' ? 'No hay revisiones preparadas' : 'No checks prepared')}</h3></section>`;
    if (completed === checks.length && state.checkIndex == null) return `<section class="safety-v3-complete"><span class="safety-v3-complete-mark" aria-hidden="true">✓</span><small>${esc(tr('Checks prepared for today'))}</small><h3>${esc(tr('Today’s safety check is complete'))}</h3><p><strong>${completed}</strong> ${esc(tr('checks recorded'))} · <strong>${open}</strong> ${esc(tr(open === 1 ? 'follow-up assigned' : 'follow-ups assigned'))}</p><div class="safety-v3-complete-actions">${open ? `<button type="button" class="primary" data-safety-mode="followup">${esc(tr('View follow-up'))}</button>` : ''}<button type="button" class="secondary" data-safety-close>${esc(tr('Done'))}</button></div></section>`;
    const pendingIndex = checks.findIndex(check => check.status === 'pending');
    const index = Math.max(0, Math.min(checks.length - 1, Number.isSafeInteger(state.checkIndex) ? state.checkIndex : (pendingIndex >= 0 ? pendingIndex : 0)));
    state.checkIndex = index;
    const check = checks[index], status = check.status || 'pending', needsPerson = check.requiresCompetentPerson === true, exception = ['fail', 'deferred'].includes(status), notApplicable = status === 'not_applicable';
    return `<section class="safety-v3-runner"><div class="safety-v3-progress-row"><div><small>${esc(tr('Check'))} ${index + 1} ${esc(tr('of'))} ${checks.length}</small><strong>${completed} ${esc(tr('checks recorded'))}</strong></div><div class="safety-v3-progress" role="progressbar" aria-label="Checks recorded" aria-valuemin="0" aria-valuemax="${checks.length}" aria-valuenow="${completed}"><span style="width:${Math.round(completed / checks.length * 100)}%"></span></div></div><article class="safety-v3-check"><div class="safety-v3-check-type">${esc(activityLabel(check.activity))}</div><h3>${esc(checkText(check, 0))}</h3><p>${esc(checkText(check, 1))}</p><form data-form-key="check-${esc(check.id)}" data-safety-check="${esc(check.id)}" data-revision="${esc(day.revision || 0)}"><input type="hidden" name="status" value="${esc(status)}"><input type="hidden" name="inspector" value="${esc(user()?.name || '')}">${v3CheckChoices(status)}<div data-check-competent ${needsPerson && status !== 'pending' && status !== 'not_applicable' ? '' : 'hidden'}><label>${esc(tr('Who completed the inspection?'))}<input name="competentPerson" value="${esc(check.competentPerson || '')}" maxlength="200"><small>${esc(language() === 'es' ? 'Ingrese a la persona competente realmente designada. Un nombre no demuestra su calificación.' : 'Enter the actual designated competent person. A name does not establish qualification.')}</small></label></div><div data-check-na ${notApplicable ? '' : 'hidden'}><label>${esc(tr('Why does this not apply?'))}<textarea name="notes" rows="3" maxlength="1500">${esc(notApplicable ? check.notes : '')}</textarea></label></div><div data-check-action ${exception ? '' : 'hidden'}><div class="safety-v3-alert"><strong>${esc(tr('Needs action'))}</strong><span>${esc(language() === 'es' ? 'Proteja a las personas primero y documente el seguimiento.' : 'Protect people first, then record the follow-up.')}</span></div><label>${esc(tr('What did you find?'))}<textarea name="finding" rows="3" maxlength="1500">${esc(exception ? check.notes : '')}</textarea></label><label>${esc(tr('What did you do immediately?'))}<textarea name="action" rows="3" maxlength="1500">${esc(check.action || '')}</textarea></label><div class="safety-v3-grid"><label>${esc(tr('Who owns the follow-up?'))}<input name="owner" value="${esc(check.owner || '')}" maxlength="200"></label><label>${esc(tr('Due date'))}<input name="dueDate" type="date" value="${esc(check.dueDate || state.date)}"></label></div><label class="safety-v3-toggle"><input name="workStopped" type="checkbox" ${check.workStopped ? 'checked' : ''}><span>${esc(tr('Affected work is stopped until this is resolved'))}</span></label></div><div class="safety-v3-sticky"><button type="button" class="secondary" data-check-nav="back" ${index === 0 ? 'disabled' : ''}>← ${esc(tr('Back'))}</button><button type="submit" class="primary" data-check-save ${status === 'pending' ? 'disabled' : ''}>${esc(index + 1 < checks.length ? tr('Save & next') : tr('Save check'))}</button></div></form><details class="safety-v3-source"><summary>${esc(tr('Review source'))}</summary><p>${esc(check.ruleVersion || day.ruleVersion || '')}</p>${sourceLink(check.source)}</details></article></section>`;
  }

  function v3HazardCreate(state) {
    const day = state.data.day;
    if (!day) return `<section class="safety-v3-loading" aria-busy="true"><span></span><strong>${esc(language() === 'es' ? 'Preparando el registro…' : 'Preparing today’s record…')}</strong></section>`;
    const project = projectList().find(row => Number(row.id) === Number(state.projectId)), location = String(project?.site || project?.address || '');
    return `<section class="safety-v3-action"><div class="safety-v3-section-title"><div><small>${esc(language() === 'es' ? 'VEA · PROTEJA · REGISTRE' : 'SEE IT · PROTECT · RECORD')}</small><h3>${esc(tr('Report a hazard'))}</h3></div></div><form data-form-key="new-hazard" data-safety-hazard-create data-revision="${esc(day.revision || 0)}"><label>${esc(tr('What did you see?'))}<textarea name="observation" rows="4" maxlength="1500" required autofocus></textarea></label><label>${esc(tr('Where was it?'))}<input name="location" value="${esc(location)}" maxlength="300" required></label><label>${esc(tr('What protected people right away?'))}<textarea name="action" rows="3" maxlength="1500" required></textarea></label><fieldset class="safety-v3-segment"><legend>${esc(tr('What happens next?'))}</legend><label><input type="radio" name="outcome" value="fixed" checked><span>${esc(tr('Fixed now — PM verification needed'))}</span></label><label><input type="radio" name="outcome" value="followup"><span>${esc(tr('Needs follow-up'))}</span></label></fieldset><fieldset class="safety-v3-segment"><legend>${esc(tr('Was affected work stopped or kept clear?'))}</legend><label><input type="radio" name="workStoppedChoice" value="yes" required><span>${esc(language() === 'es' ? 'Sí — protegido mientras se resuelve' : 'Yes — protected while follow-up is open')}</span></label><label><input type="radio" name="workStoppedChoice" value="no" required><span>${esc(language() === 'es' ? 'No — el reporte diario queda bloqueado hasta verificar' : 'No — the daily stays blocked until verified')}</span></label></fieldset><div data-hazard-followup hidden><div class="safety-v3-grid"><label>${esc(tr('Who owns the follow-up?'))}<input name="owner" maxlength="200"></label><label>${esc(tr('Due date'))}<input name="dueDate" type="date" value="${esc(state.date)}"></label></div></div>${photoPicker(state)}<p class="safety-v3-guardrail">${esc(language() === 'es' ? 'Atienda un peligro inmediato en el sitio primero. Este registro no llama a servicios de emergencia.' : 'Respond to immediate danger on site first. This record does not dispatch emergency services.')}</p><div class="safety-v3-sticky"><button type="button" class="secondary" data-safety-mode="checks">← ${esc(tr('Back'))}</button><button type="submit" class="primary">${esc(tr('Save hazard'))}</button></div></form></section>`;
  }

  function v3Talk(state) {
    const day = state.data.day;
    if (!day) return `<section class="safety-v3-loading" aria-busy="true"><span></span><strong>${esc(language() === 'es' ? 'Preparando el registro…' : 'Preparing today’s record…')}</strong></section>`;
    const members = scheduledMembers(state), suggested = (day.activities || []).map(activityLabel).join(' / ');
    const attendance = selected => members.length ? members.map(member => `<label><input type="checkbox" name="attendeeIds" value="${esc(member.id)}" ${selected == null || selected.has(Number(member.id)) ? 'checked' : ''}><span><b>${esc(member.name)}</b><small>${esc(member.crew || '')}</small></span></label>`).join('') : `<p class="safety-v3-inline-error" role="alert">${esc(language() === 'es' ? 'Programe al menos a una persona del equipo antes de registrar la asistencia.' : 'Schedule at least one crew member before recording attendance.')}</p>`;
    const records = (day.talks || []).slice().reverse().map(talk => {
      const voided = Boolean(talk.voidedAt), canCorrect = !voided && (state.data.canManage === true || Number(talk.presenterUserId) === Number(user()?.id)), selected = new Set((talk.attendees || []).map(row => Number(row.memberId)));
      const history = talk.amendedAt ? (language() === 'es' ? `Corregido por ${talk.amendedBy || 'usuario'} · ${dateTime(talk.amendedAt)}` : `Corrected by ${talk.amendedBy || 'user'} · ${dateTime(talk.amendedAt)}`) : talk.recordedAt ? dateTime(talk.recordedAt) : '';
      return `<article class="safety-v3-talk-record ${voided ? 'is-voided' : ''}"><div><span>${esc(voided ? (language() === 'es' ? 'Anulado' : 'Voided') : talk.language === 'es' ? tr('Spanish') : tr('English'))}</span><h4>${esc(talk.topic || (language() === 'es' ? 'Charla de seguridad' : 'Toolbox talk'))}</h4><small>${esc(language() === 'es' ? 'Presentado por' : 'Presented by')} ${esc(talk.presenter || '')}${history ? ` · ${esc(history)}` : ''}</small></div><p>${esc((talk.attendees || []).map(row => row.name).filter(Boolean).join(', ') || (language() === 'es' ? 'Asistencia no registrada' : 'Attendance not recorded'))}</p>${voided ? `<p class="safety-v3-inline-error">${esc(language() === 'es' ? 'Registro anulado' : 'Record voided')}: ${esc(talk.voidReason || '')}</p>` : ''}${canCorrect ? `<details><summary>${esc(language() === 'es' ? 'Corregir registro' : 'Correct record')}</summary><form data-form-key="talk-amend-${esc(talk.id)}" data-safety-talk-update="${esc(talk.id)}" data-talk-action="amend" data-revision="${esc(day.revision || 0)}"><label>${esc(language() === 'es' ? 'Motivo de la corrección' : 'Why are you correcting this record?')}<textarea name="reason" rows="2" maxlength="500" required></textarea></label><label>${esc(tr('Talk topic'))}<input name="topic" maxlength="300" value="${esc(talk.topic || '')}" required></label><label>${esc(tr('Key points or notes (optional)'))}<textarea name="notes" rows="3" maxlength="2000">${esc(talk.notes || '')}</textarea></label><label>${esc(tr('Language'))}<select name="language"><option value="en" ${talk.language !== 'es' ? 'selected' : ''}>${esc(tr('English'))}</option><option value="es" ${talk.language === 'es' ? 'selected' : ''}>${esc(tr('Spanish'))}</option></select></label><fieldset class="safety-v3-attendance"><legend>${esc(tr('Crew reported present'))}</legend>${attendance(selected)}</fieldset><button class="primary" type="submit" ${members.length ? '' : 'disabled aria-disabled="true"'}>${esc(language() === 'es' ? 'Guardar corrección' : 'Save correction')}</button></form></details><details><summary>${esc(language() === 'es' ? 'Anular registro duplicado o incorrecto' : 'Void duplicate or wrong record')}</summary><form data-form-key="talk-void-${esc(talk.id)}" data-safety-talk-update="${esc(talk.id)}" data-talk-action="void" data-revision="${esc(day.revision || 0)}"><label>${esc(language() === 'es' ? 'Por qué se anula' : 'Why is this record being voided?')}<textarea name="reason" rows="2" maxlength="500" required></textarea></label><button class="secondary" type="submit">${esc(language() === 'es' ? 'Anular registro' : 'Void record')}</button></form></details>` : ''}</article>`;
    }).join('');
    return `<section class="safety-v3-action"><div class="safety-v3-section-title"><div><small>${esc(language() === 'es' ? 'HABLE · CONFIRME · REGISTRE' : 'TALK · CONFIRM · RECORD')}</small><h3>${esc(tr('Record a toolbox talk'))}</h3></div></div><form data-form-key="toolbox-talk" data-safety-talk data-revision="${esc(day.revision || 0)}"><label>${esc(tr('Talk topic'))}<input name="topic" maxlength="300" value="${esc(suggested)}" required autofocus></label><label>${esc(tr('Key points or notes (optional)'))}<textarea name="notes" rows="4" maxlength="1500"></textarea></label><label>${esc(tr('Language'))}<select name="language"><option value="en">${esc(tr('English'))}</option><option value="es" ${language() === 'es' ? 'selected' : ''}>${esc(tr('Spanish'))}</option></select></label><fieldset class="safety-v3-attendance"><legend>${esc(tr('Crew reported present'))}</legend>${attendance(null)}</fieldset><p class="safety-v3-guardrail">${esc(language() === 'es' ? 'El registro mostrará que el presentador reportó a estas personas presentes. No firma por ellas.' : 'The record shows who the presenter reported present. It does not sign for them.')}</p><div class="safety-v3-sticky"><button type="button" class="secondary" data-safety-mode="checks">← ${esc(tr('Back'))}</button><button type="submit" class="primary" ${members.length ? '' : 'disabled aria-disabled="true"'}>${esc(tr('Save toolbox talk'))}</button></div></form>${records ? `<section class="safety-v3-talk-records"><div class="safety-v3-section-title"><div><small>${esc(language() === 'es' ? 'EVIDENCIA DEL DÍA' : 'TODAY’S EVIDENCE')}</small><h3>${esc(language() === 'es' ? 'Charlas registradas' : 'Recorded talks')}</h3></div></div>${records}</section>` : ''}</section>`;
  }

  function v3HazardCard(state, hazard) {
    const status = hazard.status || 'open', canVerify = state.data.canVerify === true, differentDate = hazard.date && hazard.date !== state.date;
    let controls = '';
    if (differentDate) controls = `<button type="button" class="secondary" data-safety-select-date="${esc(hazard.date)}">${esc(tr('Open hazard'))} →</button>`;
    else if (status === 'open') controls = `<form data-form-key="hazard-${esc(hazard.id)}" data-safety-hazard-update="${esc(hazard.id)}" data-next-status="corrected" data-revision="${esc(state.data.day?.revision || 0)}"><label>${esc(tr('Corrective action'))}<textarea name="action" rows="3" required>${esc(hazard.action || '')}</textarea></label><div class="safety-v3-grid"><label>${esc(tr('Who owns the follow-up?'))}<input name="owner" value="${esc(hazard.owner || '')}" required></label><label>${esc(tr('Due date'))}<input name="dueDate" type="date" value="${esc(hazard.dueDate || state.date)}" required></label></div><label class="safety-v3-toggle"><input type="checkbox" name="workStopped" ${hazard.workStopped ? 'checked' : ''}><span>${esc(tr('Affected work is stopped until this is resolved'))}</span></label><button type="submit" class="primary">${esc(tr('Mark corrected'))}</button></form>`;
    else if (status === 'corrected' && canVerify) controls = `<form data-form-key="hazard-${esc(hazard.id)}" data-safety-hazard-update="${esc(hazard.id)}" data-next-status="verified" data-revision="${esc(state.data.day?.revision || 0)}"><label>${esc(tr('Verification findings'))}<textarea name="verification" rows="3" required></textarea></label><input type="hidden" name="action" value="${esc(hazard.action || '')}"><input type="hidden" name="owner" value="${esc(hazard.owner || '')}"><input type="hidden" name="dueDate" value="${esc(hazard.dueDate || '')}"><input type="hidden" name="workStopped" value="${hazard.workStopped ? 'true' : 'false'}"><button type="submit" class="primary">${esc(tr('Verify closed'))}</button></form>`;
    else if (status === 'corrected') controls = `<p class="safety-v3-guardrail">${esc(language() === 'es' ? 'Esperando verificación del gerente u oficina.' : 'Waiting for a PM or office verifier.')}</p>`;
    if (!differentDate && canVerify && status !== 'voided') controls += `<details class="safety-v3-advanced"><summary>${esc(language() === 'es' ? 'Registro incorrecto' : 'Recorded in error')}</summary><p>${esc(language() === 'es' ? 'Explique el error. El registro original y el motivo quedan en el historial. Esto no certifica que el trabajo sea seguro.' : 'Explain the error. The original record and your reason stay in the audit history. This does not certify that the work is safe.')}</p><form data-form-key="hazard-void-${esc(hazard.id)}" data-safety-hazard-void="${esc(hazard.id)}" data-revision="${esc(state.data.day?.revision || 0)}"><label>${esc(language() === 'es' ? 'Motivo' : 'Reason')}<textarea name="reason" required maxlength="1500" rows="3"></textarea></label><button type="submit" class="secondary">${esc(language() === 'es' ? 'Guardar corrección' : 'Save correction')}</button></form></details>`;
    return `<article class="safety-v3-followup is-${esc(status)}"><div class="safety-v3-followup-head"><span>${esc(status === 'corrected' ? tr('Corrected — waiting for verification') : tr('Open hazard'))}</span>${hazard.workStopped ? `<b>${esc(language() === 'es' ? 'Trabajo detenido' : 'Work stopped')}</b>` : ''}</div><h3>${esc(hazard.observation || tr('Open hazard'))}</h3><p>${esc(hazard.location || '')}</p><small>${esc(hazard.owner || (language() === 'es' ? 'Sin responsable' : 'Owner not assigned'))}${hazard.dueDate ? ` · ${esc(tr('Due date'))} ${esc(workDate(hazard.dueDate))}` : ''}</small>${controls}</article>`;
  }

  function v3Followup(state) {
    const own = state.data.day?.hazards || [], hazards = [...own, ...(state.data.openHazards || []).filter(row => !own.some(item => item.id === row.id))].filter(item => !['verified', 'voided'].includes(item.status));
    return `<section class="safety-v3-action"><div class="safety-v3-section-title"><div><small>${esc(tr('Follow-up'))}</small><h3>${esc(hazards.length ? (language() === 'es' ? `${hazards.length} pendientes` : `${hazards.length} items need follow-up`) : (language() === 'es' ? 'Seguimiento al día' : 'Follow-up is clear'))}</h3></div></div>${hazards.length ? `<div class="safety-v3-followups">${hazards.map(hazard => v3HazardCard(state, hazard)).join('')}</div>` : `<div class="safety-v3-empty"><span aria-hidden="true">✓</span><h3>${esc(tr('No open follow-up'))}</h3><p>${esc(tr('Keep watching for changing conditions.'))}</p></div>`}<div class="safety-v3-bottom-back"><button type="button" class="secondary" data-safety-mode="checks">← ${esc(tr('Back'))}</button></div></section>`;
  }

  function v3DayMarkup(state) {
    if (!state.data.profile?.enabled) return '';
    if (state.mode === 'setup') return '';
    if (state.mode === 'hazard') return v3HazardCreate(state);
    if (state.mode === 'talk') return v3Talk(state);
    if (state.mode === 'followup') return v3Followup(state);
    return v3CheckRunner(state);
  }

  function paint(state, drafts = []) {
    if (!current(state)) return;
    const project = projectList().find(row => Number(row.id) === Number(state.projectId));
    dialog.querySelector('#safety-pm-title').textContent = state.mode === 'hazard' ? tr('Report a hazard') : state.mode === 'talk' ? tr('Record a toolbox talk') : state.mode === 'followup' ? tr('Follow-up') : state.mode === 'setup' ? tr('Project safety setup') : tr('Safety today');
    dialog.querySelector('[data-safety-body]').innerHTML = `<div class="safety-v3-context-line"><span>${esc(project?.name || 'Project')}</span><b>·</b><span>${esc(workDate(state.date))}</span></div>${profileMarkup(state)}${v3DayMarkup(state)}`;
    restoreDrafts(state, drafts);
    dialog.querySelectorAll('form[data-safety-check]').forEach(revealConditional);
  }

  function renderDemo(state) {
    if (!current(state)) return;
    const host = dialog.querySelector('[data-demo-preview]');
    if (!host) return;
    const trade = dialog.querySelector('[data-demo-trade]').value;
    const prospect = dialog.querySelector('[data-demo-company]').value.trim();
    const pack = catalogRows(state.data.catalog).find(row => row.id === trade || row.activity === trade);
    host.innerHTML = `<small>DEMO BRIEF${prospect ? ` · ${esc(prospect)}` : ''}</small><h4>${esc(LABELS[trade])} in Oregon</h4><p>${esc(pack?.description || 'Coverage for this trade needs review before a demo is promised.')}</p><ol><li>Prepare activity checks from the daily schedule.</li><li>Record an inspection and demonstrate a failed check.</li><li>Assign a hazard, review the daily, then verify the correction.</li></ol><p><strong>${pack ? 'Starter workflow available for preview' : 'Coverage review needed'}</strong> · not a compliance determination</p>${sourceLink(pack?.source)}`;
  }

  async function load(state, options = {}) {
    if (!current(state)) return;
    const request = ++state.load;
    busy(state, true);
    try {
      let data = await api(`${base(state)}?date=${encodeURIComponent(state.date)}`, { signal: state.controller.signal });
      if (!current(state) || request !== state.load) return;
      if (data.profile?.enabled && data.coverage !== 'manual-review' && !data.day) {
        await api(`${base(state)}/days`, { method: 'POST', body: JSON.stringify({ date: state.date, revision: 0 }), signal: state.controller.signal });
        data = await api(`${base(state)}?date=${encodeURIComponent(state.date)}`, { signal: state.controller.signal });
        if (!current(state) || request !== state.load) return;
      }
      state.data = data;
      if (options.advance) {
        const checks = data.day?.checks || [], from = checks.findIndex(check => check.id === options.advance);
        const after = checks.findIndex((check, index) => index > from && check.status === 'pending'), any = checks.findIndex(check => check.status === 'pending');
        state.checkIndex = after >= 0 ? after : any >= 0 ? any : null;
      }
      if (options.preserve) {
        notice(state, 'This record changed. Your unsaved input is still here. Use Reload to review the latest saved record before re-entering it.', true);
      } else {
        paint(state, options.drafts || []);
        notice(state, options.message || '');
      }
    } catch (error) {
      if (current(state) && request === state.load) notice(state, error.message || 'Safety checks could not be loaded.', true);
    } finally { if (current(state) && request === state.load) busy(state, false); }
  }

  async function mutate(state, path, method, input, form, message, options = {}) {
    if (!current(state) || state.busy) return;
    const drafts = captureDrafts(state, form?.dataset.formKey);
    busy(state, true);
    notice(state, 'Saving…');
    try {
      const result = await api(path, { method, body: JSON.stringify(input), signal: state.controller.signal });
      if (!current(state)) return;
      state.dirty = false;
      if (form) form.dataset.dirty = 'false';
      await load(state, { drafts, message, advance: options.advance });
      window.dispatchEvent(new CustomEvent('pdl:safety-updated', { detail: { projectId: state.projectId, date: state.date } }));
      return result;
    } catch (error) {
      if (!current(state)) return;
      if (error.status === 409) {
        // Obtain current state but preserve both old form revisions and typed input.
        // A retry must not silently rebase a stale response onto a newer inspection.
        await load(state, { preserve: true });
      } else notice(state, `${error.message || 'The save could not be confirmed.'} Your input is still here.`, true);
    } finally { if (current(state)) busy(state, false); }
  }

  function revealConditional(form) {
    if (!form?.hasAttribute('data-safety-check')) return;
    const status = form.elements.status.value, required = ['fail', 'deferred'].includes(status), check = active?.data?.day?.checks?.find(row => row.id === form.dataset.safetyCheck);
    const legacy = form.querySelector('[data-response-unresolved]');
    if (legacy) {
      legacy.hidden = !required;
      for (const name of ['action', 'owner', 'dueDate', 'workStopped']) if (form.elements[name]) form.elements[name].required = required;
      if (form.elements.notes) form.elements.notes.required = status !== 'pending';
      return;
    }
    const action = form.querySelector('[data-check-action]'), na = form.querySelector('[data-check-na]'), competent = form.querySelector('[data-check-competent]');
    if (action) action.hidden = !required;
    if (na) na.hidden = status !== 'not_applicable';
    if (competent) competent.hidden = !(check?.requiresCompetentPerson && status !== 'pending' && status !== 'not_applicable');
    form.querySelectorAll('[data-check-choice]').forEach(button => button.classList.toggle('is-selected', button.dataset.checkChoice === status || button.dataset.checkChoice === 'fail' && status === 'deferred'));
    if (form.elements.finding) form.elements.finding.required = required;
    for (const name of ['action', 'owner', 'dueDate', 'workStopped']) if (form.elements[name]) form.elements[name].required = required;
    if (form.elements.notes) form.elements.notes.required = status === 'not_applicable';
    if (form.elements.competentPerson) form.elements.competentPerson.required = Boolean(check?.requiresCompetentPerson && status !== 'pending' && status !== 'not_applicable');
    const save = form.querySelector('[data-check-save]'); if (save) save.disabled = status === 'pending';
  }

  function mount() {
    if (dialog) return;
    dialog = document.createElement('dialog');
    dialog.id = 'safety-pm-dialog';
    dialog.className = 'safety-pm-dialog';
    dialog.setAttribute('aria-labelledby', 'safety-pm-title');
    dialog.innerHTML = `<div class="safety-shell"><header class="safety-header"><div><p class="safety-eyebrow">PRO DAILY LINK · SAFETY</p><h2 id="safety-pm-title">${esc(tr('Safety today'))}</h2><p data-safety-subtitle>${esc(tr('Check the work. Fix what matters. Keep the record.'))}</p></div><button type="button" class="safety-close" data-safety-close aria-label="Close safety">×</button></header><details class="safety-context" data-safety-context><summary>${esc(tr('Change project or date'))}</summary><div><label>${esc(tr('Project'))}<select data-safety-project></select></label><label>${esc(tr('Work date'))}<input type="date" data-safety-date required></label><button type="button" class="secondary" data-safety-reload>${esc(tr('Reload'))}</button></div></details><p data-safety-notice role="status" aria-live="polite" class="safety-notice" hidden></p><main data-safety-body></main><footer class="safety-footer"><button type="button" class="secondary" data-safety-close data-return-daily hidden>Return to daily</button><strong>${esc(language() === 'es' ? 'Revisiones iniciales de Oregón' : 'Oregon starter checks')}</strong><span>${esc(language() === 'es' ? 'Apoya su programa de seguridad; no certifica cumplimiento ni reemplaza el criterio de una persona competente.' : 'Supports your safety program; does not certify compliance or replace competent-person judgment.')}</span></footer></div>`;
    document.body.append(dialog);
    dialog.addEventListener('cancel', event => { if (active?.dirty && !confirm(language() === 'es' ? '¿Cerrar Seguridad? Se perderán los datos no guardados.' : 'Close Safety? Unsaved input will be lost.')) event.preventDefault(); else close(); });
    dialog.addEventListener('close', () => { if (!dialog.open && active) close(); });
    dialog.addEventListener('input', event => { const state = active; if (!current(state)) return; const form = event.target.closest('form'); if (form) { state.dirty = true; form.dataset.dirty = 'true'; } });
    dialog.addEventListener('change', event => {
      const state = active;
      if (!current(state)) return;
      if (event.target.matches('[data-safety-project],[data-safety-date]')) {
        if (state.dirty && !confirm('Change project or date? Unsaved safety input will be lost.')) {
          dialog.querySelector('[data-safety-project]').value = String(state.projectId);
          dialog.querySelector('[data-safety-date]').value = state.date;
          return;
        }
        void open({ projectId: dialog.querySelector('[data-safety-project]').value, date: dialog.querySelector('[data-safety-date]').value, mode: state.mode, opener: returnFocus });
      }
      if (event.target.name === 'status') revealConditional(event.target.closest('form'));
      if (event.target.name === 'outcome') {
        const form = event.target.form, followup = value(form, 'outcome') === 'followup', host = form.querySelector('[data-hazard-followup]');
        host.hidden = !followup;
        for (const name of ['owner', 'dueDate']) form.elements[name].required = followup;
      }
    });
    dialog.addEventListener('click', event => {
      const button = event.target.closest('button'), state = active;
      if (!button || !current(state)) return;
      if (button.hasAttribute('data-safety-close')) { if (!state.dirty || confirm(language() === 'es' ? '¿Cerrar Seguridad? Se perderán los datos no guardados.' : 'Close Safety? Unsaved input will be lost.')) close(); return; }
      if (button.hasAttribute('data-safety-reload')) { if (!state.dirty || confirm('Reload the latest saved record? Your unsaved input will be lost.')) { state.dirty = false; void load(state); } return; }
      if (button.hasAttribute('data-safety-generate')) { if (state.dirty && !confirm('Refresh the checks? Save or discard your current input first. Discard it now?')) return; void mutate(state, `${base(state)}/days`, 'POST', { date: state.date, revision: state.data.day?.revision || 0 }, null, 'Checks refreshed. Confirm the actual work and site conditions.'); return; }
      if (button.hasAttribute('data-safety-turn-off')) {
        const profile = state.data.profile || {};
        if (!confirm(language() === 'es' ? '¿Desactivar Seguridad para este proyecto? Los reportes diarios ya no exigirán estas revisiones.' : 'Turn off Safety for this project? Daily reports will no longer require these checks.')) return;
        void mutate(state, `${base(state)}/profile`, 'PUT', { revision: Number(profile.revision || 0), enabled: false, state: profile.state || state.data.inferredState || '', employer: profile.employer || String((typeof company === 'undefined' ? null : company)?.name || ''), activities: profile.activities || [] }, null, language() === 'es' ? 'Seguridad desactivada para este proyecto.' : 'Safety turned off for this project.');
        return;
      }
      if (button.hasAttribute('data-safety-mode')) { if (state.dirty && !confirm(language() === 'es' ? '¿Descartar los datos no guardados?' : 'Discard unsaved input?')) return; state.mode = button.dataset.safetyMode; state.dirty = false; paint(state); return; }
      if (button.hasAttribute('data-check-choice')) {
        const form = button.closest('form'), choice = button.dataset.checkChoice;
        form.elements.status.value = choice; form.dataset.dirty = 'true'; state.dirty = true; revealConditional(form);
        const check = state.data.day?.checks?.find(row => row.id === form.dataset.safetyCheck);
        if (choice === 'pass' && !check?.requiresCompetentPerson) form.requestSubmit();
        else form.querySelector(choice === 'not_applicable' ? '[name="notes"]' : choice === 'fail' ? '[name="finding"]' : '[name="competentPerson"]')?.focus();
        return;
      }
      if (button.hasAttribute('data-check-nav')) { state.checkIndex = Math.max(0, (state.checkIndex || 0) - 1); state.dirty = false; paint(state); return; }
      if (button.hasAttribute('data-safety-select-date')) { if (!state.dirty || confirm('Open the earlier record? Unsaved input will be lost.')) void open({ projectId: state.projectId, date: button.dataset.safetySelectDate, mode: 'followup', opener: returnFocus }); return; }
    });
    dialog.addEventListener('submit', event => {
      const form = event.target, state = active;
      if (!current(state) || !form.matches('form[data-form-key]')) return;
      event.preventDefault();
      if (state.busy || !form.reportValidity()) return;
      const revision = Number(form.dataset.revision);
      if (form.hasAttribute('data-safety-profile')) {
        const input = { revision, enabled: value(form, 'enabled') === 'true', state: value(form, 'state'), employer: value(form, 'employer'), activities: [...form.querySelectorAll('[name="activities"]:checked')].map(node => node.value) };
        void mutate(state, `${base(state)}/profile`, 'PUT', input, form, language() === 'es' ? 'Seguridad activada. Las revisiones de hoy están listas.' : 'Safety is on. Today’s checks are ready.');
      } else if (form.hasAttribute('data-safety-check')) {
        const status = value(form, 'status');
        if (status === 'pending') { notice(state, language() === 'es' ? 'Elija una respuesta antes de guardar.' : 'Choose a response before saving.', true); return; }
        const check = state.data.day?.checks?.find(row => row.id === form.dataset.safetyCheck), notes = status === 'not_applicable' ? value(form, 'notes') : ['fail', 'deferred'].includes(status) ? value(form, 'finding') : '';
        if (status === 'not_applicable' && !notes) { notice(state, tr('Why does this not apply?'), true); form.elements.notes.focus(); return; }
        if (check?.requiresCompetentPerson && status !== 'not_applicable' && !value(form, 'competentPerson')) { notice(state, tr('Who completed the inspection?'), true); form.elements.competentPerson.focus(); return; }
        const input = { revision, status, notes, inspector: user()?.name || '', competentPerson: value(form, 'competentPerson'), action: value(form, 'action'), owner: value(form, 'owner'), dueDate: value(form, 'dueDate'), workStopped: form.elements.workStopped?.checked === true };
        if (!['fail', 'deferred'].includes(status)) Object.assign(input, { action: '', owner: '', dueDate: '', workStopped: false });
        if (status === 'not_applicable') input.competentPerson = '';
        void mutate(state, `${dayBase(state)}/checks/${encodeURIComponent(form.dataset.safetyCheck)}`, 'PATCH', input, form, language() === 'es' ? 'Revisión guardada.' : 'Check saved.', { advance: form.dataset.safetyCheck });
      } else if (form.hasAttribute('data-safety-hazard-void')) {
        void mutate(state, `${dayBase(state)}/hazards/${encodeURIComponent(form.dataset.safetyHazardVoid)}/void`, 'PATCH', { revision, reason: value(form, 'reason') }, form, language() === 'es' ? 'Corrección guardada; original conservado.' : 'Correction saved; original preserved.');
      } else if (form.hasAttribute('data-safety-hazard-create')) {
        const fixed = value(form, 'outcome') === 'fixed', stopped = value(form, 'workStoppedChoice') === 'yes';
        const input = { revision, observation: value(form, 'observation'), location: value(form, 'location'), action: value(form, 'action'), owner: fixed ? user()?.name || '' : value(form, 'owner'), dueDate: fixed ? state.date : value(form, 'dueDate'), workStopped: stopped };
        if (value(form, 'photoId')) input.photoId = Number(value(form, 'photoId'));
        void (async () => {
          const result = await mutate(state, `${dayBase(state)}/hazards`, 'POST', input, form, fixed ? (language() === 'es' ? 'Peligro guardado como corregido; falta verificación.' : 'Hazard saved as corrected; verification is still required.') : (language() === 'es' ? 'Peligro guardado y seguimiento asignado.' : 'Hazard saved and follow-up assigned.'));
          if (fixed && result && current(state)) {
            const rows = result.hazards || result.day?.hazards || [], newest = rows.slice().sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))[0];
            const nextRevision = result.revision || result.day?.revision;
            if (newest && Number.isSafeInteger(Number(nextRevision))) await mutate(state, `${dayBase(state)}/hazards/${encodeURIComponent(newest.id)}`, 'PATCH', { revision: Number(nextRevision), status: 'corrected', verification: '', action: input.action, owner: input.owner, dueDate: input.dueDate, workStopped: stopped }, null, language() === 'es' ? 'Corregido; esperando verificación.' : 'Corrected; waiting for verification.');
          }
          if (current(state)) { state.mode = 'followup'; paint(state); }
        })();
      } else if (form.hasAttribute('data-safety-talk')) {
        const input = { revision, topic: value(form, 'topic'), notes: value(form, 'notes'), language: value(form, 'language'), attendeeIds: [...form.querySelectorAll('[name="attendeeIds"]:checked')].map(node => Number(node.value)) };
        void (async () => { const result = await mutate(state, `${dayBase(state)}/talks`, 'POST', input, form, language() === 'es' ? 'Charla guardada con el personal reportado presente.' : 'Toolbox talk saved with the reported attendance.'); if (result && current(state)) { state.mode = 'checks'; paint(state); } })();
      } else if (form.hasAttribute('data-safety-talk-update')) {
        const action = form.dataset.talkAction;
        const input = { revision, action, reason: value(form, 'reason') };
        if (action === 'amend') Object.assign(input, { topic: value(form, 'topic'), notes: value(form, 'notes'), language: value(form, 'language'), attendeeIds: [...form.querySelectorAll('[name="attendeeIds"]:checked')].map(node => Number(node.value)) });
        void mutate(state, `${dayBase(state)}/talks/${encodeURIComponent(form.dataset.safetyTalkUpdate)}`, 'PATCH', input, form, action === 'void' ? (language() === 'es' ? 'Registro anulado; la evidencia original permanece en el historial.' : 'Record voided; the original evidence remains in history.') : (language() === 'es' ? 'Corrección guardada con el original preservado.' : 'Correction saved with the original preserved.'));
      } else if (form.hasAttribute('data-safety-hazard-update')) {
        const status = form.dataset.nextStatus, rawStopped = value(form, 'workStopped');
        const input = { revision, status, verification: value(form, 'verification'), action: value(form, 'action'), owner: value(form, 'owner'), dueDate: value(form, 'dueDate'), workStopped: form.elements.workStopped?.type === 'checkbox' ? form.elements.workStopped.checked : rawStopped === 'true' };
        void mutate(state, `${dayBase(state)}/hazards/${encodeURIComponent(form.dataset.safetyHazardUpdate)}`, 'PATCH', input, form, status === 'verified' ? (language() === 'es' ? 'Cierre verificado.' : 'Closure verified.') : (language() === 'es' ? 'Corrección guardada; falta verificación.' : 'Correction saved; verification is still required.'));
      }
    });
  }

  async function open(options = {}) {
    if (!permitted()) return;
    const available = projectList();
    mount();
    active?.controller?.abort();
    sequence++;
    const projectId = Number(options.projectId) || available[0]?.id;
    const state = { sequence, identity: identity(), projectId, date: /^\d{4}-\d{2}-\d{2}$/.test(String(options.date)) ? options.date : today(), mode: ['checks', 'hazard', 'talk', 'followup', 'setup'].includes(options.mode) ? options.mode : 'checks', checkIndex: null, controller: new AbortController(), load: 0, data: {}, dirty: false, busy: false };
    state.reportReturn = options.opener?.closest('#report-modal') ? (active?.reportReturn || dailyContext()) : null;
    active = state;
    const back = dialog.querySelector('[data-return-daily]');
    back.hidden = !state.reportReturn;
    back.textContent = language() === 'es' ? 'Volver al parte' : 'Return to daily';
    returnFocus = options.opener || returnFocus || document.activeElement;
    dialog.querySelector('[data-safety-project]').innerHTML = available.map(project => `<option value="${esc(project.id)}">${esc(project.name)}</option>`).join('');
    dialog.querySelector('[data-safety-project]').value = String(projectId);
    dialog.querySelector('[data-safety-date]').value = state.date;
    dialog.querySelector('#safety-pm-title').textContent = state.mode === 'hazard' ? tr('Report a hazard') : state.mode === 'talk' ? tr('Record a toolbox talk') : state.mode === 'followup' ? tr('Follow-up') : state.mode === 'setup' ? tr('Project safety setup') : tr('Safety today');
    dialog.querySelector('[data-safety-body]').innerHTML = `<section class="safety-v3-loading" aria-busy="true"><span></span><strong>${esc(language() === 'es' ? 'Cargando Seguridad…' : 'Loading Safety…')}</strong></section>`;
    if (!dialog.open) dialog.showModal();
    if (!projectId || !available.some(project => Number(project.id) === Number(projectId))) { notice(state, 'Choose an accessible project to open safety checks.', true); return; }
    await load(state);
  }

  document.addEventListener('click', event => {
    if (event.target.closest('#logout-button,#profile-logout-button,#subscription-lock-logout')) { close(); return; }
    const opener = event.target.closest('#report-open-safety,[data-open-safety-pm]');
    if (!opener) return;
    event.preventDefault();
    const reportSelect = document.getElementById('report-project'), reportDate = document.getElementById('report-date');
    const reportProject = opener.closest('#report-modal') && typeof projects !== 'undefined' ? projects[Number(reportSelect?.value)]?.id : null;
    void open({ projectId: opener.dataset.projectId || reportProject, date: opener.dataset.date || (reportProject ? reportDate?.value : undefined), mode: opener.dataset.safetyMode || 'checks', opener });
  });
  if (typeof renderEverything === 'function') {
    const previousRender = renderEverything;
    renderEverything = function (...args) { if (active && active.identity !== identity()) close(); return previousRender.apply(this, args); };
  }
  if (typeof loadRole === 'function') {
    const previousLoadRole = loadRole;
    loadRole = async function (...args) { close(); return previousLoadRole.apply(this, args); };
  }
  if (typeof renderActionCenter === 'function') {
    const previousRenderActions = renderActionCenter;
    renderActionCenter = function (...args) {
      const result = previousRenderActions.apply(this, args);
      for (const item of typeof actionCenter === 'undefined' ? [] : actionCenter.items || []) {
        if (item.type !== 'safety_engine') continue;
        const button = [...document.querySelectorAll('[data-action-id]')].find(node => node.dataset.actionId === String(item.id));
        if (button) button.onclick = () => open({ projectId: item.projectId, date: item.safetyDate, opener: button });
      }
      return result;
    };
  }
  if (typeof renderReports === 'function') {
    const previousRenderReports = renderReports;
    renderReports = function (...args) {
      const result = previousRenderReports.apply(this, args), host = document.getElementById('report-detail');
      if (!host) return result;
      host.querySelectorAll('[data-safety-evidence]').forEach(node => node.remove());
      // Read the actual selected list item after PDL's existing filter/sort wrappers.
      const selected = document.querySelector('#report-list .report-list-item.active')?.dataset.report;
      const report = typeof reports === 'undefined' ? null : reports.find(row => Number(row.id) === Number(selected));
      if (!report?.safetyEvidence) return result;
      const projectId = report.projectId || (typeof projects === 'undefined' ? null : projects[Number(report.project)]?.id);
      const markup = reportSafetyEvidenceMarkup(report, projectId, language());
      const summary = host.querySelector('.ai-banner');
      if (summary) summary.insertAdjacentHTML('afterend', markup);
      else host.insertAdjacentHTML('beforeend', markup);
      return result;
    };
  }
  window.addEventListener('pagehide', close);
  window.addEventListener('hashchange', close);
  window.addEventListener('storage', event => { if (['pdl-company-id', 'pdl-role'].includes(event.key)) close(); });
  window.PDLSafetyPM = { open, close };
  window.PDLSafety = { open: (projectId, date, mode = 'checks') => open({ projectId, date, mode }), close };
}());
