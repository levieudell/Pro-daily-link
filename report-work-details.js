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
  // Project health includes sent work awaiting approval, without changing approved metrics.
  function projectOverruns(project, reports, projectIndex) {
    const sent = reports.filter(report => !report.deletedAt && ['Approved','Submitted','Needs review','Missing data','Updated'].includes(report.status) &&
      (report.projectId != null ? String(report.projectId) === String(project.id) : report.project === projectIndex));
    const combined = {productionEntries: sent.flatMap(report => report.productionEntries || [])};
    const seen = new Set();
    return rows(combined, project).filter(row => {
      if (!row.over || seen.has(String(row.estimateItemId))) return false;
      seen.add(String(row.estimateItemId)); return true;
    });
  }
  function scheduleWarning(project, reports, projectIndex, assignments, tasks, today, metrics = []) {
    const valid = value => /^\d{4}-\d{2}-\d{2}$/.test(value || '') && Number.isFinite(Date.parse(value + 'T12:00:00Z')) && new Date(value + 'T12:00:00Z').toISOString().slice(0,10)===value;
    const active = row => row && !row.deletedAt && !['cancelled','canceled'].includes(String(row.status || '').toLowerCase()) && String(row.projectId) === String(project.id);
    const shifts = assignments.filter(row => active(row) && valid(row.date));
    const scheduled = tasks.filter(row => active(row) && valid(row.startDate) && valid(row.endDate) && row.startDate <= row.endDate);
    const dates = new Set(shifts.filter(row => row.date > today).map(row => row.date));
    for (const task of scheduled.filter(row => row.status !== 'done')) {
      const end = Date.parse(task.endDate + 'T12:00:00Z');
      for (let day = Math.max(Date.parse(task.startDate + 'T12:00:00Z'), Date.parse(today + 'T12:00:00Z')); day <= end; day += 86400000) {
        const date = new Date(day), iso = date.toISOString().slice(0,10);
        if (iso > today && date.getUTCDay() !== 0 && date.getUTCDay() !== 6) dates.add(iso);
      }
    }
    const remaining = dates.size, hasSchedule = shifts.length > 0 || scheduled.length > 0;
    const items = project.estimateItems || [];
    const hasBudget = items.length > 0 && items.every(item => item.budgetHours != null && item.budgetHours !== '' && Number.isFinite(Number(item.budgetHours))) && items.reduce((sum,item)=>sum+Number(item.budgetHours),0)>0;
    const budget = hasBudget ? items.reduce((sum,item)=>sum+Number(item.budgetHours),0) : null;
    const approvedHours = metrics.reduce((sum,item)=>sum+Math.max(0,Number(item.actualLaborHours)||0),0);
    const sent = reports.filter(row => !row.deletedAt && ['Submitted','Needs review','Missing data','Updated'].includes(row.status) && (row.projectId != null ? String(row.projectId)===String(project.id) : row.project===projectIndex));
    const pendingHours = sent.flatMap(row=>row.productionEntries||[]).reduce((sum,line)=>sum+Math.max(0,Number(line.laborHours)||0),0);
    const laborPercent = hasBudget ? approvedHours / budget * 100 : null;
    const reportedPercent = hasBudget ? (approvedHours + pendingHours) / budget * 100 : null;
    const laborCopy = pendingHours > 0 ? `${Math.floor(laborPercent)}% of labor hours approved; ${Math.floor(reportedPercent)}% including sent dailies` : `${Math.floor(laborPercent)}% of labor hours used (approved)`;
    const warnings = [];
    if (reportedPercent > 100) warnings.push('Labor over estimate: '+laborCopy+'.');
    else if (remaining >= 2 && reportedPercent >= 80) warnings.push('Budget nearly used: '+laborCopy+'.');
    const quantityItems = items.filter(item=>Number(item.plannedQuantity)>0 && item.unit);
    if (remaining >= 2) for (const item of quantityItems) {
      const approved = Math.max(0,Number(metrics.find(row=>String(row.estimateItemId)===String(item.id))?.actualQuantity)||0);
      const pending = sent.flatMap(row=>row.productionEntries||[]).filter(line=>String(line.estimateItemId)===String(item.id)&&unit(line.unit)===unit(item.unit)).reduce((sum,line)=>sum+Math.max(0,Number(line.quantity)||0),0);
      const pct = (approved+pending)/Number(item.plannedQuantity)*100;
      if(pct>=90)warnings.push(`${item.name}: ${Math.floor(pct)}% of quantity ${pending>0?'reported ('+Math.floor(approved/Number(item.plannedQuantity)*100)+'% approved)':'complete (approved)'}.`);
    }
    if(warnings.length)return{status:'At risk',reason:warnings.join(' ')+(hasSchedule?` ${remaining} scheduled workday${remaining===1?'':'s'} left after today.`:' Schedule not entered.'),remaining};
    const missing=[];
    if(!items.length||quantityItems.length!==items.length)missing.push('estimated quantities');
    if(!hasBudget)missing.push('budget labor hours');
    if(!hasSchedule)missing.push('scheduled workdays');
    if(missing.length)return{status:'Not enough information',reason:'Add '+missing.join(', ')+' to check project health.',remaining};
    return null;
  }
  return { rows, projectOverruns, scheduleWarning };
});
