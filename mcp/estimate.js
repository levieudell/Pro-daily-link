'use strict';

// Same approved-report rollup the production screen uses. Drafts do not move
// done, remaining, or used hours until the office approves them.
function estimateActuals(db) {
  const approved = (db.reports || []).filter(report => report.status === 'Approved');
  return (db.projects || []).map((project, projectIndex) => ({
    projectId: project.id,
    items: (project.estimateItems || []).map(item => {
      const entries = approved.filter(report => report.project === projectIndex).flatMap(report => (report.productionEntries || []).filter(entry => entry.estimateItemId === item.id).map(entry => ({ entry, report })));
      const actualQuantity = entries.reduce((sum, row) => sum + Number(row.entry.quantity || 0), 0);
      const actualLaborHours = entries.reduce((sum, row) => {
        const rawLabor = (row.report.laborEntries || []).reduce((total, labor) => total + Number(labor.hours || 0), 0);
        const countedLabor = (row.report.laborEntries || []).reduce((total, labor) => {
          const excluded = (row.report.laborExclusions || []).find(candidate => Number(candidate.memberId) === Number(labor.memberId));
          return total + Math.max(0, Number(labor.hours || 0) - (excluded ? Number(excluded.hours) || Number(labor.hours) || 0 : 0));
        }, 0);
        const ratio = rawLabor > 0 ? countedLabor / rawLabor : 1;
        if (Number(row.entry.laborHours) > 0) return sum + Number(row.entry.laborHours) * ratio;
        const reportTotal = countedLabor;
        return sum + ((row.report.productionEntries || []).length === 1 ? reportTotal : 0);
      }, 0);
      return {
        estimateItemId: item.id,
        name: item.name,
        unit: item.unit,
        plannedQuantity: Number(item.plannedQuantity) || 0,
        budgetHours: item.budgetHours == null ? null : Number(item.budgetHours) || 0,
        actualQuantity,
        actualLaborHours,
        quantityPercent: item.plannedQuantity ? actualQuantity / Number(item.plannedQuantity) * 100 : 0,
        laborPercent: item.budgetHours == null ? null : item.budgetHours ? actualLaborHours / Number(item.budgetHours) * 100 : 0
      };
    })
  }));
}

function estimateView(db, projectId) {
  const projectIndex = (db.projects || []).findIndex(project => Number(project.id) === Number(projectId));
  const project = projectIndex >= 0 ? db.projects[projectIndex] : null;
  if (!project) return null;
  const rolled = estimateActuals(db).find(row => Number(row.projectId) === Number(project.id));
  return {
    projectId: project.id,
    projectName: project.name,
    lines: (rolled?.items || []).map(item => ({
      estimateItemId: item.estimateItemId,
      name: item.name,
      unit: item.unit || '',
      plannedQuantity: item.plannedQuantity,
      done: round(item.actualQuantity),
      remaining: round(Math.max(0, item.plannedQuantity - item.actualQuantity)),
      budgetHours: item.budgetHours,
      usedHours: round(item.actualLaborHours)
    }))
  };
}

function round(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

module.exports = { estimateActuals, estimateView };
