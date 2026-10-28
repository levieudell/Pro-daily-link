'use strict';

// The overview uses the same scoped action queue and project navigation as the app.
// No new data requests or write actions are introduced here.
function officePriorityItems(items = [], limit = 3) {
  const rank = { urgent: 0, high: 1, medium: 2, low: 3 };
  return [...items].sort((a, b) => (rank[a.severity] ?? 4) - (rank[b.severity] ?? 4)).slice(0, limit);
}

function officeActionDestination(item) {
  if (!item) return null;
  if (item.reportId) return { page: 'reports', reportId: item.reportId };
  if (item.subcontractorId) return { page: 'team' };
  if (item.projectId) return { page: 'projects', projectId: item.projectId };
  return { page: 'actions' };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { officePriorityItems, officeActionDestination };
} else {
  (() => {
    const text = (en, es) => preferredLanguage === 'es' ? es : en;

    // Presentation only: read the existing active destination, without changing navigation.
    const previousPage = showPage;
    showPage = function (...args) {
      const result = previousPage.apply(this, args);
      const label = $('#office-page-name'), nav = $('#main-nav .nav-item[aria-current="page"]');
      if (label && nav?.childNodes) label.textContent = [...nav.childNodes].filter(node => node.nodeType === 3).map(node => node.textContent).join('').trim();
      return result;
    };

    function renderOfficePhotoCount() {
      const output = $('#office-photo-count'), count = $('#report-photos')?.files?.length || 0;
      if (!output) return;
      output.hidden = !count;
      output.textContent = count ? text(`${count} photo${count === 1 ? '' : 's'} selected`, `${count} foto${count === 1 ? '' : 's'} seleccionada${count === 1 ? '' : 's'}`) : '';
    }
    $('#report-photos')?.addEventListener?.('change', renderOfficePhotoCount);
    if (typeof updateReportContextSummary === 'function') {
      const previousContextSummary = updateReportContextSummary;
      updateReportContextSummary = function (...args) {
        const result = previousContextSummary.apply(this, args);
        if (currentRole === 'office') {
          const selection = $('#report-context-selection'), date = $('#report-date')?.value;
          if (selection) selection.textContent = [date ? formatDate(date) : '', $('#report-crew')?.value].filter(Boolean).join(' · ');
        }
        return result;
      };
    }

    // Extra clearance is only needed when the body actually scrolls. Measure the
    // footer so review actions, wrapped labels, and safe-area padding all count.
    if (typeof ResizeObserver !== 'undefined') {
      const modal = $('#report-modal'), notes = $('#field-notes'), originalRows = notes.rows;
      let layoutFrame;
      const resize = new ResizeObserver(() => {
        cancelAnimationFrame(layoutFrame);
        layoutFrame = requestAnimationFrame(() => {
          const office = modal.classList.contains('report-office-compact');
          notes.rows = office && matchMedia('(min-width:761px)').matches ? 5 : originalRows;
          if (!office || !modal.open) return;
          const step = modal.querySelector('.report-step.active'), body = step.querySelector('.report-step-scroll'), footer = step.querySelector('.modal-actions');
          const padding = parseFloat(getComputedStyle(body).paddingBottom);
          const overflowing = body.scrollHeight - padding + 16 > body.clientHeight + 1;
          const bottom = overflowing ? `${Math.ceil(footer.getBoundingClientRect().height) + 12}px` : '16px';
          if (body.style.getPropertyValue('--office-scroll-bottom') !== bottom) body.style.setProperty('--office-scroll-bottom', bottom);
        });
      });
      modal.querySelectorAll('.report-step-scroll, .report-step-scroll > *, .modal-actions').forEach(element => resize.observe(element));
    }
    if (typeof applyFieldReportLayout === 'function') {
      const previousReportLayout = applyFieldReportLayout;
      applyFieldReportLayout = function (...args) {
        const result = previousReportLayout.apply(this, args);
        if (currentRole === 'office' && $('#report-type')?.value !== 'superintendent') {
          if (!editingReportId) $('#report-modal-title').textContent = text('New daily', 'Nuevo reporte');
          renderOfficePhotoCount();
        }
        return result;
      };
    }

    function renderOfficePriorities() {
      const host = $('#dashboard-actions'), panel = $('#office-priorities');
      if (!host || !panel) return;
      const office = currentRole === 'office';
      panel.hidden = !office || (!projects.length && !reports.length);
      if (!office) { host.replaceChildren(); return; }
      const items = actionCenter.items || [], priority = officePriorityItems(items);
      const alert = panel.querySelector('.alert');
      alert.hidden = panel.hidden;
      alert.classList.toggle('all-clear', !items.length);
      alert.querySelector('.alert-kicker').textContent = items.length
        ? text('NEXT ACTION', 'SIGUIENTE ACCIÓN') : text('ALL CLEAR', 'TODO AL DÍA');
      alert.querySelector('strong').textContent = items.length
        ? text(`${items.length} item${items.length === 1 ? '' : 's'} need${items.length === 1 ? 's' : ''} your attention`, `${items.length} pendiente${items.length === 1 ? '' : 's'} por revisar`)
        : text('You’re all caught up', 'Todo está al día');
      alert.querySelector('p').textContent = items.length
        ? text('Open an item. Review the work. Keep it moving.', 'Abra un pendiente. Revise el trabajo. Siga adelante.')
        : text('New items will appear here when the office needs to act.', 'Los nuevos pendientes aparecerán aquí cuando requieran atención.');
      const all = alert.querySelector('button');
      all.hidden = !items.length;
      all.textContent = text(`View all ${items.length} →`, `Ver los ${items.length} →`);
      const labels = { urgent: text('Urgent', 'Urgente'), high: text('Review', 'Revisar'), medium: text('Watch', 'Vigilar'), low: text('Watch', 'Vigilar') };
      host.innerHTML = priority.map((item, index) => `<button type="button" class="dashboard-action${index === 0 ? ' dashboard-action-first' : ''}" data-office-action="${escapeHtml(item.id)}">
        <span class="dashboard-action-level">${escapeHtml(labels[item.severity] || text('Review', 'Revisar'))}</span>
        <span class="dashboard-action-copy"><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.detail || '')}</small></span>
        <span class="dashboard-action-go">${text('Open', 'Abrir')} <span aria-hidden="true">→</span></span>
      </button>`).join('');
      const details = $('#dashboard-production-details');
      if (details) details.hidden = !projects.length && !reports.length;
    }

    function openDashboardProject(id) {
      if (currentRole !== 'office') return;
      const project = projects.find(row => String(row.id) === String(id) && !row.archived);
      if (!project) { notify(text('This project is no longer available.', 'Este proyecto ya no está disponible.')); return; }
      showPage('projects');
      openProject(project.id);
    }

    const previousSummary = renderDashboardSummary;
    renderDashboardSummary = function () {
      const result = previousSummary();
      renderOfficePriorities();
      return result;
    };
    const previousActions = renderActionCenter;
    renderActionCenter = function () {
      const result = previousActions();
      renderOfficePriorities();
      return result;
    };

    // Project names are real buttons, usable by keyboard as well as touch.
    const previousTable = renderTable;
    renderTable = function () {
      const result = previousTable(), watch = dashboardWatchProjects();
      $$('#project-table tr').forEach((row, index) => {
        const project = watch[index], name = row.querySelector('.project-cell strong');
        if (!project || !name) return;
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'dashboard-project-link';
        button.dataset.officeProject = String(project.id);
        button.textContent = project.name;
        name.replaceChildren(button);
        row.querySelectorAll('td').forEach((cell, column) => {
          cell.dataset.label = [text('Project', 'Proyecto'), text('Crew today', 'Personal hoy'), text('Completion', 'Avance'), text('Production', 'Producción'), text('Status', 'Estado')][column];
        });
      });
      return result;
    };

    // Office staff open the project; creating a daily stays in that project's Dailies tab.
    // Field activity keeps its existing quick daily flow.
    const previousActivities = renderActivities;
    renderActivities = function () {
      const result = previousActivities();
      if (currentRole === 'office') {
        $$('#activity-list [data-activity-project]').forEach(button => {
          const id = button.dataset.activityProject;
          const project = projects.find(row => String(row.id) === id);
          button.setAttribute('aria-label', text(`Open project: ${project?.name || ''}`, `Abrir proyecto: ${project?.name || ''}`));
          button.onclick = () => openDashboardProject(id);
        });
      }
      return result;
    };

    const previousProject = openProject;
    openProject = async function (id, view) {
      const result = await previousProject(id, view);
      const dialog = $('#project-detail-modal');
      if (currentRole !== 'office' || (view && !view.current()) || !dialog?.open || String(dialog.dataset.projectId) !== String(id)) return result;
      const pane = dialog.querySelector('[data-project-detail-pane="dailies"]');
      if (!pane || pane.querySelector('[data-office-new-daily]')) return result;
      const toolbar = document.createElement('div');
      toolbar.className = 'office-project-daily-actions';
      toolbar.innerHTML = `<p>${text('Every daily stays with this job.', 'Cada reporte se guarda con este proyecto.')}</p><button type="button" class="primary" data-office-new-daily="${escapeHtml(id)}">＋ ${text('New daily report', 'Nuevo reporte diario')}</button>`;
      pane.prepend(toolbar);
      return result;
    };

    const previousSetup = openSetupStep;
    openSetupStep = function (step) {
      if (currentRole !== 'office' || step !== 'report') return previousSetup(step);
      const active = projects.filter(project => !project.archived);
      showPage('projects');
      if (active.length === 1) {
        Promise.resolve(openProject(active[0].id)).then(() => {
          $('#project-detail-content [data-project-detail-tab="dailies"]')?.click();
        });
      }
    };

    // The empty report list should also send office staff to a project, not a global form.
    const previousReports = renderReports;
    renderReports = function (...args) {
      const result = previousReports(...args);
      if (currentRole === 'office' && !reports.length) {
        const button = $('#empty-new-report');
        if (button) {
          button.textContent = text('Open projects', 'Abrir proyectos');
          button.onclick = () => showPage('projects');
        }
      }
      return result;
    };

    document.addEventListener('click', event => {
      const create = event.target.closest('[data-office-new-daily]');
      if (create) {
        if (currentRole !== 'office') return;
        const dialog = $('#project-detail-modal'), id = create.dataset.officeNewDaily;
        const projectIndex = projects.findIndex(row => String(row.id) === id && !row.archived);
        if (!dialog?.open || String(dialog.dataset.projectId) !== id || projectIndex < 0) return;
        $('#report-photo-tags').value = '';
        syncReportPhotoTagsVisibility();
        openReport(null, { projectIndex });
        return;
      }
      const project = event.target.closest('[data-office-project]');
      if (project) { openDashboardProject(project.dataset.officeProject); return; }
      const button = event.target.closest('[data-office-action]');
      if (!button || currentRole !== 'office') return;
      const item = (actionCenter.items || []).find(row => String(row.id) === button.dataset.officeAction);
      const destination = officeActionDestination(item);
      if (!destination) { renderOfficePriorities(); return; }
      if (destination.page === 'reports') {
        const report = reports.find(row => String(row.id) === String(destination.reportId));
        if (!report) { notify(text('This report is no longer available.', 'Este reporte ya no está disponible.')); return; }
        $('#report-status-filter').value = 'all';
        showPage('reports');
        renderReports(report.id);
        const detail = $('#report-detail');
        detail.setAttribute('tabindex', '-1');
        detail.focus({ preventScroll: true });
        detail.scrollIntoView({ behavior: 'instant', block: 'start' });
      } else if (destination.page === 'team') {
        teamTab = 'subcontractors';
        showPage('team');
        renderTeamDirectory();
      } else if (destination.page === 'projects') {
        openDashboardProject(destination.projectId);
      } else showPage('actions');
    });
  })();
}
