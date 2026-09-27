function estimateNumber(value){
  const match=String(value||'').replaceAll(',','').match(/-?\d+(?:\.\d+)?/);
  return match?Number(match[0]):0;
}

function decorateEstimateRows(){
  document.querySelectorAll('#project-detail-content .estimate-row:not(.header)').forEach(row=>{
    if(row.querySelector('.estimate-mobile-summary'))return;
    const cells=[...row.children],plannedText=cells[1]?.textContent||'',actualText=cells[2]?.textContent||'',laborText=cells[3]?.textContent||'',progressText=cells[4]?.textContent||'0%';
    const hasData=row.dataset.planned!=null;
    if(!hasData&&cells.length<5)return;
    const planned=hasData?Number(row.dataset.planned):estimateNumber(plannedText),actual=hasData?Number(row.dataset.actual):estimateNumber(actualText),laborValues=laborText.replaceAll(',','').match(/\d+(?:\.\d+)?/g)||[],budgetHours=hasData?Number(row.dataset.budgetHours):Number(laborValues[0]||0),actualHours=hasData?Number(row.dataset.actualHours):Number(laborValues[1]||0),percent=hasData?Number(row.dataset.quantityPercent):Math.max(0,estimateNumber(progressText)),remaining=Math.max(0,planned-actual),unit=row.dataset.unit||(plannedText.match(/[A-Za-z]+(?:\s*[A-Za-z]+)?$/)||[''])[0].trim(),laborPercent=row.dataset.laborPercent!==undefined&&row.dataset.laborPercent!==''?Number(row.dataset.laborPercent):(budgetHours?actualHours/budgetHours*100:null),laborAhead=typeof laborRunsAhead==='function'?laborRunsAhead(laborPercent,percent):Number.isFinite(laborPercent)&&laborPercent>percent+0.05;
    const summary=document.createElement('div');
    summary.className='estimate-mobile-summary';
    summary.innerHTML=`<div class="estimate-mobile-values"><span><small>COMPLETED</small><strong>${actual.toLocaleString()} ${unit}</strong></span><span><small>REMAINING</small><strong>${remaining.toLocaleString()} ${unit}</strong></span></div><div class="estimate-mobile-progress" role="progressbar" aria-label="${percent.toFixed(1)} percent complete" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.min(100,percent).toFixed(1)}"><i style="width:${Math.min(100,percent)}%"></i></div><div class="estimate-mobile-foot"><span>${percent.toFixed(1)}% complete</span><span class="${laborAhead?'metric-risk':'metric-good'}">${actualHours.toLocaleString()} of ${budgetHours.toLocaleString()} labor hrs${laborPercent==null?'':` · ${laborPercent.toFixed(1)}%`}</span></div>`;
    row.appendChild(summary);
  });
}

const projectDetailContent=document.querySelector('#project-detail-content');
if(projectDetailContent)new MutationObserver(decorateEstimateRows).observe(projectDetailContent,{childList:true,subtree:true});
