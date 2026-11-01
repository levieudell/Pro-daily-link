(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ReportWorkDetails = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';
  const unit = value => String(value || '').trim().toUpperCase().replace(/^(LINEAR FEET|LINEAL FEET|FT|FEET)$/, 'LF');
  function rows(report, project, reports = []) {
    const projectId = project?.id;
    return (report?.productionEntries || []).filter(Boolean).map(line => {
      const estimate = (project?.estimateItems || []).find(item => String(item.id) === String(line.estimateItemId));
      const comparable = estimate && unit(line.unit) === unit(estimate.unit);
      const quantity = Math.max(0, Number(line.quantity) || 0);
      const approved = comparable ? reports.filter(other => other !== report && (report.id == null || String(other.id) !== String(report.id)) && other.status === 'Approved' &&
        (other.projectId != null ? String(other.projectId) === String(projectId) : other.project === report.project))
        .flatMap(other => other.productionEntries || []).filter(row => String(row.estimateItemId) === String(estimate.id) && unit(row.unit) === unit(estimate.unit))
        .reduce((sum, row) => sum + Math.max(0, Number(row.quantity) || 0), 0) : 0;
      const planned = comparable && estimate.plannedQuantity != null && estimate.plannedQuantity !== '' && Number.isFinite(Number(estimate.plannedQuantity)) ? Math.max(0, Number(estimate.plannedQuantity)) : null;
      const current = comparable ? (report.productionEntries || []).filter(row => row && String(row.estimateItemId) === String(estimate.id) && unit(row.unit) === unit(estimate.unit))
        .reduce((sum, row) => sum + Math.max(0, Number(row.quantity) || 0), 0) : quantity;
      const over = planned === null ? 0 : Math.max(0, Math.round((approved + current - planned) * 1000000) / 1000000);
      return { ...line, quantity, estimateName: estimate?.name || '', planned, approved, total: approved + current, over };
    });
  }
  return { rows };
});
