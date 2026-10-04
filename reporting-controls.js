'use strict';
function pdlRateReviewMarkup(report, project, user) {
  if (!report || !['tm','hybrid'].includes(project?.contractType) || !['owner','admin','project_manager'].includes(user?.role)) return '';
  const captured = report.rateSnapshot?.schemaVersion === 1 && report.rateSnapshot.laborRate != null;
  const prior = report.status === 'Approved' || (report.history || []).some(row => row.action === 'Approved') || report.rateReview;
  if (!captured && !prior) return '<section class="panel"><h3>Billable rate</h3><p>The project rate will be captured at first office approval.</p></section>';
  const editable = ['owner','admin'].includes(user.role), snapshot = report.rateSnapshot;
  return `<section class="panel"><h3>${captured?'Captured billable rate':'Historical rate needs review'}</h3><p>${captured?`$${Number(snapshot.laborRate).toLocaleString()} per labor hour · ${escapeHtml(snapshot.capturedBy?.name||'Office')} · ${escapeHtml(snapshot.capturedAt||'')}`:'This daily has no verified historical rate. Billing totals remain incomplete until reviewed against evidence.'}</p>${editable?`<label>Labor rate<input id="pdl-report-rate" type="number" min="0" step="any" value="${captured?Number(snapshot.laborRate):''}"></label><label>Reason<textarea id="pdl-rate-reason" maxlength="1000" required></textarea></label><label>Evidence reference${captured?' (optional)':' (required)'}<input id="pdl-rate-evidence" maxlength="1000" placeholder="Contract schedule or prior billing reference"></label><button type="button" class="secondary" data-pdl-rate-review="${Number(report.id)}">${captured?'Save audited adjustment':'Record reviewed historical rate'}</button>`:''}${(report.rateHistory||[]).length?`<details><summary>Rate review history</summary>${report.rateHistory.map(row=>`<p>${escapeHtml(row.at)} · ${escapeHtml(row.actor?.name||'Office')} · ${row.previous?.laborRate==null?'Missing':Number(row.previous.laborRate)} → ${Number(row.next.laborRate)}<br>${escapeHtml(row.reason)}${row.evidenceReference?` · ${escapeHtml(row.evidenceReference)}`:''}</p>`).join('')}</details>`:''}</section>`;
}
function pdlExportListMarkup(records) {
  return records.length ? records.slice().reverse().map(record=>`<article class="customer-project"><div><strong>Version ${Number(record.version)||1} · ${escapeHtml(record.filters.from)} to ${escapeHtml(record.filters.to)}</strong><small>${escapeHtml(record.createdBy?.name||'Owner')} · ${escapeHtml(record.createdAt)}${record.reason?` · ${escapeHtml(record.reason)}`:''}</small>${record.supersedesId?'<small>Supersedes an earlier fixed version</small>':''}</div><button type="button" class="secondary" data-pdl-export-json="${escapeHtml(record.id)}">JSON</button><a class="secondary" href="/api/reporting-exports/${encodeURIComponent(record.id)}.csv">CSV</a></article>`).join('') : '<p>No fixed exports captured yet.</p>';
}
if (typeof module !== 'undefined' && module.exports) module.exports = { pdlRateReviewMarkup, pdlExportListMarkup };
else {
  let pdlExportRecords = [], pdlExportTenant = '', pdlExportContext = '';
  const pdlTenant = () => String(signedInCompanyId()||company?.id||'');
  const pdlContext = () => JSON.stringify([pdlTenant(),currentUser?.id,currentUser?.role,currentRole]);
  async function pdlRefreshExports() {
    const panel=document.getElementById('pdl-fixed-exports');if(!panel)return;
    const context=pdlContext(),list=document.getElementById('pdl-export-list');
    if(pdlExportContext!==context){pdlExportRecords=[];pdlExportTenant='';if(list)list.innerHTML='';pdlExportContext=context}
    const allowed=currentRole==='office'&&currentUser?.role==='owner';panel.hidden=!allowed;
    if(!allowed){pdlExportRecords=[];pdlExportTenant='';return}
    const tenant=pdlTenant();if(pdlExportTenant!==tenant)pdlExportRecords=[];
    try{const records=await api('/api/reporting-exports');if(context!==pdlContext())return;pdlExportTenant=tenant;pdlExportRecords=records;document.getElementById('pdl-export-list').innerHTML=pdlExportListMarkup(records)}catch(error){if(context===pdlContext())notify(error.message)}
  }
  const pdlRenderReports=renderReports;
  renderReports=function(selected){pdlRenderReports(selected);const report=reports.find(row=>row.id===selected)||reports[0];if(currentRole==='office'&&canViewCompanyPricing())document.getElementById('report-detail')?.insertAdjacentHTML('beforeend',pdlRateReviewMarkup(report,projects[report?.project],currentUser))};
  const pdlOpenProject=openProject;
  openProject=async function(id){const context=pdlContext();await pdlOpenProject(id);if(context!==pdlContext())return;const project=projects.find(row=>Number(row.id)===Number(id));if(currentRole!=='office'||!['owner','admin'].includes(currentUser?.role)||!['tm','hybrid'].includes(project?.contractType))return;document.getElementById('project-detail-content')?.insertAdjacentHTML('beforeend',`<section class="panel"><h3>Rate for future office approvals</h3><p>Changing this default does not change rates already captured on approved dailies.</p><label>Default labor rate<input id="pdl-default-rate" type="number" min="0" step="any" value="${project.tmSettings?.defaultLaborRate==null?'':Number(project.tmSettings.defaultLaborRate)}"></label><label>Reason<textarea id="pdl-default-rate-reason" maxlength="1000" required></textarea></label><button type="button" class="secondary" data-pdl-default-rate="${Number(id)}">Save future rate</button></section>`)};
  const pdlRenderEverything=renderEverything;
  renderEverything=function(){pdlRenderEverything();void pdlRefreshExports()};
  document.addEventListener('click',async event=>{
    const rate=event.target.closest('[data-pdl-rate-review]'),defaults=event.target.closest('[data-pdl-default-rate]'),download=event.target.closest('[data-pdl-export-json]');
    if(!rate&&!defaults&&!download)return;const button=rate||defaults||download;if(button.disabled)return;button.disabled=true;const context=pdlContext();
    try{
      if(rate){const id=Number(rate.dataset.pdlRateReview),updated=await api(`/api/reports/${id}/rate`,{method:'PATCH',body:JSON.stringify({laborRate:$('#pdl-report-rate').value,reason:$('#pdl-rate-reason').value,evidenceReference:$('#pdl-rate-evidence').value})});if(context!==pdlContext())return;const index=reports.findIndex(row=>row.id===id);if(index>=0)reports[index]=updated;renderReports(id);notify('Rate review saved with its audit history')}
      if(defaults){const id=Number(defaults.dataset.pdlDefaultRate),updated=await api(`/api/projects/${id}/rate-settings`,{method:'PATCH',body:JSON.stringify({defaultLaborRate:$('#pdl-default-rate').value,reason:$('#pdl-default-rate-reason').value})});if(context!==pdlContext())return;const index=projects.findIndex(row=>row.id===id);if(index>=0)projects[index]=updated;await openProject(id);if(context!==pdlContext())return;notify('Future approval rate saved; historical rates retained')}
      if(download){const record=await api(`/api/reporting-exports/${encodeURIComponent(download.dataset.pdlExportJson)}`);if(context!==pdlContext())return;const blob=new Blob([JSON.stringify(record,null,2)],{type:'application/json'}),link=document.createElement('a');link.href=URL.createObjectURL(blob);link.download=`reporting-export-${record.id}-v${record.version||1}.json`;link.click();URL.revokeObjectURL(link.href)}
    }catch(error){if(context===pdlContext())notify(error.message)}finally{button.disabled=false}
  });
  document.getElementById('pdl-capture-export')?.addEventListener('click',async event=>{
    const button=event.currentTarget;if(button.disabled)return;const captureTenant=pdlTenant(),captureUser=currentUser?.id,context=pdlContext();
    const projectId=$('#insight-project').value,from=$('#insight-from').value,to=$('#insight-to').value;
    if(projectId==='all'||!from||!to)return notify('Choose one project and an explicit date range');
    if($('#insight-scope').value!=='all'||$('#insight-crew').value!=='all')return notify('Fixed period exports include all scopes and crews; select All for those filters');
    button.disabled=true;
    try{
      await pdlRefreshExports();if(context!==pdlContext()||pdlExportTenant!==pdlTenant()||captureTenant!==pdlTenant()||captureUser!==currentUser?.id)throw new Error('Account changed; choose the project and dates again before capturing');
      const prior=pdlExportRecords.filter(row=>String(row.filters.projectId)===String(projectId)&&row.filters.from===from&&row.filters.to===to).at(-1);
      const reason=prior?prompt('Reason for the new export version (the earlier version stays unchanged):'):'';if(prior&&reason===null)return;
      await api('/api/reporting-exports',{method:'POST',body:JSON.stringify({projectId,from,to,...(prior?{supersedesId:prior.id,reason}:{})})});if(context!==pdlContext())return;await pdlRefreshExports();if(context!==pdlContext())return;notify('Fixed export version saved')
    }catch(error){if(context===pdlContext())notify(error.message)}finally{button.disabled=false}
  });
  void pdlRefreshExports();
}
