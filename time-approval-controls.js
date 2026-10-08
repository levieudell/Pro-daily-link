'use strict';
// Office time is grouped by person. Existing row actions and server authorization remain authoritative.
function timePeople(cards,members,approved,search=''){
  const people=new Map();
  for(const card of cards){
    if(card.deletedAt)continue;
    const id=String(card.memberId),name=String(members.find(m=>String(m.id)===id)?.name||'Crew member');
    if(!name.toLowerCase().includes(search.trim().toLowerCase()))continue;
    const person=people.get(id)||{id,name,hours:0,submitted:0,draft:0,approved:0,running:0,incomplete:0,cards:[]};
    person.cards.push(card);const hours=Number(card.hours);if(Number.isFinite(hours)&&hours>=0)person.hours+=hours;
    if(approved(card))person.approved++;else if(!card.outAt)person.running++;else if(String(card.status).toLowerCase()==='submitted'){if(timeCardComplete(card))person.submitted++;else person.incomplete++}else person.draft++;
    people.set(id,person);
  }
  return [...people.values()].sort((a,b)=>a.name.localeCompare(b.name));
}
function timeCardComplete(card){return Boolean(timePeriodDate({inAt:card.inAt},'UTC')&&timePeriodDate({inAt:card.outAt},'UTC')&&Number.isFinite(Date.parse(card.inAt))&&Date.parse(card.outAt)>Date.parse(card.inAt)&&card.hours!=null&&typeof card.hours!=='boolean'&&String(card.hours).trim()!==''&&Number.isFinite(Number(card.hours))&&Number(card.hours)>=0)}
function timePeriodDate(card,zone){if(typeof card.inAt!=='string'||!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(card.inAt)||!Number.isFinite(Date.parse(card.inAt)))return '';const parts=new Intl.DateTimeFormat('en-US',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(card.inAt));return ['year','month','day'].map(type=>parts.find(p=>p.type===type).value).join('-')}
// Date-only arithmetic uses UTC as a calendar, never the browser's timezone or elapsed local hours.
function payCalendarDate(value){return typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value}
function payPresetRange(preset,{start='',month='',cutoff=15,half='first'}={}){
  if(preset==='weekly'||preset==='biweekly'){
    if(!payCalendarDate(start))return null;
    const end=new Date(start);end.setUTCDate(end.getUTCDate()+(preset==='weekly'?6:13));const to=end.toISOString().slice(0,10);
    return payCalendarDate(to)?{from:start,to}:null;
  }
  if(!['monthly','semimonthly'].includes(preset)||!/^\d{4}-\d{2}$/.test(month)||!payCalendarDate(month+'-01'))return null;
  const last=new Date(month+'-01');last.setUTCMonth(last.getUTCMonth()+1);last.setUTCDate(0);const to=last.toISOString().slice(0,10);
  if(preset==='monthly')return{from:month+'-01',to};
  const day=Number(cutoff);if(!Number.isInteger(day)||day<1||day>27||!['first','second'].includes(half))return null;
  const date=d=>month+'-'+String(d).padStart(2,'0');return half==='first'?{from:date(1),to:date(day)}:{from:date(day+1),to};
}
function payRangePreview(from,to,timeZone){
  if(!payCalendarDate(from)||!payCalendarDate(to))return 'Choose valid start and end dates to preview this period.';
  if(from>to)return 'End date must be on or after start date.';
  const days=Math.round((Date.parse(to)-Date.parse(from))/86400000)+1;
  return `${from} through ${to} (${days} ${days===1?'day':'days'}, inclusive) · ${timeZone}`;
}
function payPeriodReviewMarkup(summary,canConfigure,busy=false){
  if(!summary)return '';
  const e=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const labels={draft:'draft',submitted:'submitted',running:'running',invalid:'invalid',undated:'undated entries',missingScheduledEntries:'missing scheduled entries'};
  const review=Object.entries(summary.review||{}).filter(([,count])=>Number(count)>0).map(([key,count])=>`<span>${e(count)} ${e(labels[key]||key)}</span>`).join('');
  return `<section class="pay-review-card" aria-label="Pay-period review"><div class="pay-review-heading"><div><small>APPROVED HOURS</small><strong>${e(summary.approvedHours)} <span>${canConfigure?'company':'assigned'} total</span></strong></div><b class="pay-review-status ${summary.ready?'ready':'needs-review'}">${summary.ready?(canConfigure?'Ready to export':'Assigned checks clear'):'Needs review'}</b></div><p class="input-help">${e(summary.period.from)} through ${e(summary.period.to)} · ${e(summary.period.timeZone)}</p><div class="pay-review-counts">${review||'<span>All period checks are clear.</span>'}</div><details class="pay-period-summary"><summary>Review breakdown</summary><p class="input-help">${e(summary.datePolicy)}</p>${summary.missingEntries?.length?'<p><strong>Missing scheduled time</strong></p>'+summary.missingEntries.map(m=>`<p>${e(m.person)} · ${e(m.date)} · ${e(m.project)}</p>`).join(''):''}${summary.people.map(p=>`<p>${e(p.name)} <strong>${e(p.hours)} approved hours</strong></p>`).join('')}</details>${canConfigure?`<div class="pay-period-tools pay-export-actions"><button type="button" class="primary" data-pay-capture ${!summary.ready||busy?'disabled':''}>${summary.latestExport?'Create corrected export':'End period & export'}</button>${summary.latestExport?`<button type="button" class="secondary" data-pay-download="${e(summary.latestExport.id)}">Download fixed v${e(summary.latestExport.version)}</button><button type="button" class="secondary" data-pay-history>Previous exports</button>`:''}</div><p class="input-help">${!summary.ready?'Resolve the review items above before creating a fixed export. ':''}${summary.latestExport?(summary.latestExport.changed?'Time changed since the latest fixed export.':'The latest fixed export matches current approved time.'):'Exports contain approved hours for payroll handoff; they do not calculate pay.'}</p>`:'<p class="input-help">Assigned time only. A company administrator creates fixed exports.</p>'}<div id="pay-period-history"></div></section>`;
}
if(typeof module!=='undefined'&&module.exports)module.exports={timePeople,timeCardComplete,timePeriodDate,payPeriodReviewMarkup,payCalendarDate,payPresetRange,payRangePreview};
else {
  let timePerson=null,timeIdentity='',timeFilterKey='',payIdentity='',paySequence=0,paySelected='',payList=[],paySummary=null,payConfigure=false,payEditing=null,payBusy=false,payFormZone='';
  function timeContext(){return JSON.stringify([signedInCompanyId(),currentUser?.id,currentUser?.role,currentRole,currentUser?.permissions,company?.features])}
  function clearTimeSelection(){const all=$('#timecard-check-all');if(all){all.checked=false;all.indeterminate=false}$$('[data-timecard-pick]').forEach(box=>box.checked=false);updateTimeCardSelection()}
  function resetPayContext(){paySequence++;paySelected='';payList=[];paySummary=null;payConfigure=false;payEditing=null;payBusy=false;payFormZone='';const dialog=$('#pay-period-dialog');if(dialog?.open)dialog.close();for(const id of ['pay-period-label','pay-period-from','pay-period-to','pay-period-reason'])$('#'+id).value='';resetPayPreset();$('#pay-period-save').disabled=false;$('#company-pay-period-list').innerHTML='';$('#pay-period-zone').textContent='';$('#pay-period-form-error').textContent='';$('#pay-period-panel').innerHTML='';$('#pay-period-panel').hidden=true}
  const originalTimeFilter=filteredTimeCards;
  filteredTimeCards=function(){
    const period=payList.find(p=>p.id===paySelected);if(!period||!timeCardOffice())return originalTimeFilter();
    const filters=timeCardFilters();return timeCards.filter(card=>!card.deletedAt).map(card=>({...card,date:timePeriodDate(card,period.timeZone)})).filter(card=>card.date&&(!filters.from||card.date>=filters.from)&&(!filters.to||card.date<=filters.to)&&(filters.projectId==='all'||String(card.projectId)===filters.projectId)&&(filters.memberId==='all'||String(card.memberId)===filters.memberId)&&(filters.status==='all'||(filters.status==='approved'?timeCardApproved(card):String(card.status).toLowerCase()===filters.status)));
  };
  const priorTimeRender=renderTimeCards;
  renderTimeCards=function(){
    const identity=timeContext();
    if(identity!==timeIdentity){timePerson=null;timeIdentity=identity;$('#time-person-search').value='';$('#time-more-filters').open=false;$('#time-person-list').innerHTML='';$('#time-person-name').textContent='';for(const id of ['timecard-from','timecard-to'])$('#'+id).value='';for(const id of ['timecard-job','timecard-person','timecard-status'])$('#'+id).value='all';resetPayContext()}
    const filterKey=JSON.stringify(timeCardFilters())+'|'+($('#time-person-search')?.value||'');
    if(filterKey!==timeFilterKey){timePerson=null;timeFilterKey=filterKey}
    priorTimeRender();
    const office=timeCardOffice()&&timeCardsOn(),list=$('#time-person-list'),heading=$('#time-person-heading'),panel=$('#timecard-entry-panel');
    list.hidden=!office;heading.hidden=true;panel.hidden=false;
    if(office){
      const people=timePeople(filteredTimeCards(),team,timeCardApproved,$('#time-person-search').value),person=people.find(p=>p.id===timePerson);
      if(!person)timePerson=null;
      list.hidden=Boolean(person);heading.hidden=!person;panel.hidden=!person;
      $('#timecard-office-actions').hidden=!person||!canManageTime();$('#timecard-filter-total').hidden=!person;
      if(person){
        const total=$('#timecard-filter-total'),filters=timeCardFilters();
        total.querySelector('strong').textContent=person.hours.toFixed(2).replace(/\.00$/,'')+' hours';
        total.querySelector('small').textContent=person.name+' · '+(filters.from||'All dates')+(filters.to?' through '+filters.to:'')+' · '+person.cards.length+' time card'+(person.cards.length===1?'':'s');
        $('#time-person-name').textContent=person.name+' · '+person.hours.toFixed(2).replace(/\.00$/,'')+' hours';$('#timecard-rows').innerHTML=person.cards.map(card=>timeCardRowMarkup(card,true,canManageTime())).join('');$$('[data-timecard-pick], [data-timecard-approve]').forEach(box=>{const card=person.cards.find(c=>String(c.id)===(box.dataset.timecardPick||box.dataset.timecardApprove));if(!card||!timeCardComplete(card))box.disabled=true});
      }
      else {$('#timecard-rows').innerHTML='';list.innerHTML=people.length?people.map(p=>`<button type="button" class="time-person-summary" data-time-person="${escapeHtml(p.id)}"><strong>${escapeHtml(p.name)}</strong><span>${p.hours.toFixed(2).replace(/\.00$/,'')} hours</span><small>${p.submitted} need approval · ${p.draft} draft · ${p.approved} approved${p.running?' · '+p.running+' running':''}${p.incomplete?' · '+p.incomplete+' incomplete':''}</small><span aria-hidden="true">›</span></button>`).join(''):'<p class="input-help">No people with time for these filters.</p>'}
    }else if(currentRole!=='field'){$('#timecard-rows').innerHTML='';list.innerHTML='';panel.hidden=true;$('#timecard-office-actions').hidden=true;$('#timecard-filter-total').hidden=true}
    clearTimeSelection();
    if(timeContext()!==payIdentity){payIdentity=timeContext();resetPayContext()}
    $('#pay-period-panel').hidden=!office;
    if(office)void refreshPayPeriods();
  };
  function drawPayPanel(){
    const selected=payList.find(p=>p.id===paySelected),s=paySummary,host=$('#pay-period-panel'),e=escapeHtml;
    host.innerHTML=`<div class="pay-period-tools"><label>Company pay period<select id="pay-period-select"><option value="">Choose custom dates</option>${payList.map(p=>`<option value="${e(p.id)}" ${p.id===paySelected?'selected':''}>${e(p.label)} · ${e(p.from)} – ${e(p.to)}</option>`).join('')}</select></label>${payConfigure?'<button type="button" class="secondary" data-pay-settings>Manage pay periods</button>':''}${payConfigure&&selected&&!selected.exportCount?'<button type="button" class="secondary" data-pay-edit>Edit dates</button>':''}</div>${s?payPeriodReviewMarkup(s,payConfigure,payBusy):'<p class="input-help">Choose a company pay period to review approved hours and prepare a fixed export. Custom dates below filter the time-card list.</p>'}<p id="pay-period-message" class="form-message" role="alert" hidden></p>`;
  }
  function drawPaySettings(){
    const host=$('#company-pay-period-list'),allowed=timeCardOffice()&&timeCardsOn()&&(currentUser?.role==='owner'||currentUser?.role==='admin'&&currentUser?.permissions?.manageTime===true);if(!allowed||!payConfigure){host.innerHTML='';return}
    host.innerHTML=`<button type="button" class="primary" data-pay-new>New pay period</button><p class="input-help">Company timezone: ${escapeHtml(company?.timezone||'America/Los_Angeles')}. Each period keeps the timezone it was created with.</p>${payList.length?payList.map(p=>`<article class="company-period-row"><div><strong>${escapeHtml(p.label)}</strong><small>${escapeHtml(p.from)} through ${escapeHtml(p.to)} · ${escapeHtml(p.timeZone)}${p.exportCount?' · Fixed exports: '+p.exportCount:''}</small></div><button type="button" class="secondary" data-pay-use="${escapeHtml(p.id)}">Review time</button>${!p.exportCount?`<button type="button" class="secondary" data-pay-setting-edit="${escapeHtml(p.id)}">Edit dates</button>`:''}</article>`).join(''):'<p>No pay periods yet. Create your company’s first date range.</p>'}`;
  }
  window.PDLPayPeriods={refresh:refreshPayPeriods};
  function choosePayPeriod(id){paySelected=id;const p=payList.find(p=>p.id===id);$('#timecard-from').value=p?.from||'';$('#timecard-to').value=p?.to||'';for(const id of ['timecard-job','timecard-person','timecard-status'])$('#'+id).value='all';$('#time-person-search').value='';renderTimeCards()}
  async function refreshPayPeriods(){
    const context=timeContext(),sequence=++paySequence,selection=paySelected;
    paySummary=null;drawPayPanel();
    try{
      const result=await api('/api/pay-periods');if(context!==timeContext()||sequence!==paySequence)return;
      payList=result.periods;payConfigure=result.canConfigure;paySummary=null;
      if(selection&&payList.some(p=>p.id===selection)){const summary=await api('/api/pay-periods/'+selection+'/summary');if(context!==timeContext()||sequence!==paySequence)return;paySummary=summary}else paySelected='';
      drawPayPanel();drawPaySettings();
    }catch(error){if(context===timeContext()&&sequence===paySequence){drawPayPanel();payMessage(error.message)}}
  }
  function payMessage(message){const host=$('#pay-period-message');if(host){host.textContent=message;host.hidden=false}}
  function resetPayPreset(){
    $('#pay-period-preset').value='custom';$('#pay-period-month').value='';$('#pay-period-cutoff').value='15';$('#pay-period-half').value='first';drawPayPreset();
  }
  function drawPayPreset(){
    const preset=$('#pay-period-preset').value,calendar=['monthly','semimonthly'].includes(preset),split=preset==='semimonthly';
    $('#pay-period-calendar').hidden=!calendar;$('#pay-period-split').hidden=!split;
    $('#pay-period-month').required=calendar;$('#pay-period-month').disabled=!calendar;$('#pay-period-cutoff').required=split;$('#pay-period-cutoff').disabled=!split;$('#pay-period-half').disabled=!split;
    const help={custom:'Enter custom dates. Save creates one period.',weekly:'Enter the start date to fill 7 inclusive days. Edit the end date or choose Custom to adjust the range.',biweekly:'Enter the start date to fill 14 inclusive days. Edit the end date or choose Custom to adjust the range.',monthly:'Choose a calendar month: day 1 through month end. Edit either date to use Custom.',semimonthly:'Choose the month, cutoff (1–27), and half. First: day 1 through cutoff. Second: day after cutoff through month end. Edit either date to use Custom.'};
    $('#pay-period-preset-help').textContent=help[preset];
    $('#pay-period-preview').textContent=payRangePreview($('#pay-period-from').value,$('#pay-period-to').value,payFormZone);
  }
  function applyPayPreset(){
    const preset=$('#pay-period-preset').value;
    if(preset!=='custom'){
      const range=payPresetRange(preset,{start:$('#pay-period-from').value,month:$('#pay-period-month').value,cutoff:$('#pay-period-cutoff').value,half:$('#pay-period-half').value});
      if(['monthly','semimonthly'].includes(preset))$('#pay-period-from').value=range?.from||'';
      $('#pay-period-to').value=range?.to||'';
    }
    $('#pay-period-form-error').hidden=true;drawPayPreset();
  }
  function openPayForm(edit){
    if(!payConfigure||payBusy)return;const p=edit?payList.find(p=>p.id===paySelected):null;if(edit&&(!p||p.exportCount))return;
    payFormZone=p?.timeZone||company?.timezone||'America/Los_Angeles';$('#pay-period-title').textContent=p?'Edit pay period':'New pay period';payEditing=p?.id||null;$('#pay-period-label').value=p?.label||'';$('#pay-period-from').value=p?.from||'';$('#pay-period-to').value=p?.to||'';$('#pay-period-reason').value='';$('#pay-period-reason-label').hidden=!p;$('#pay-period-reason').required=Boolean(p);$('#pay-period-form-error').hidden=true;$('#pay-period-zone').textContent=(p?.timeZone||company?.timezone||'America/Los_Angeles')+' · Dates include both boundaries. Overnight time belongs to its clock-in day.';resetPayPreset();$('#pay-period-dialog').showModal();$('#pay-period-label').focus({preventScroll:true});
  }
  async function downloadPayExport(id){
    const context=timeContext(),period=paySelected,tenant=signedInCompanyId();
    const response=await fetch('/api/pay-periods/'+encodeURIComponent(period)+'/exports/'+encodeURIComponent(id)+'.csv',{credentials:'same-origin',headers:{'X-PDL-Company':tenant},cache:'no-store'});
    if(!response.ok)throw Error('Export could not be downloaded');const blob=await response.blob();if(context!==timeContext()||period!==paySelected)return;
    const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download='pay-period-'+period+'-'+id+'.csv';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  $('#pay-period-form').onsubmit=async event=>{
    event.preventDefault();if(payBusy||!payConfigure)return;
    if(!payCalendarDate($('#pay-period-from').value)||!payCalendarDate($('#pay-period-to').value)){$('#pay-period-form-error').textContent='Choose valid start and end dates.';$('#pay-period-form-error').hidden=false;return}
    const from=$('#pay-period-from').value,to=$('#pay-period-to').value,error=$('#pay-period-form-error');if(from>to){error.textContent='End date must be on or after start date.';error.hidden=false;return}
    const context=timeContext(),editing=payEditing;payBusy=true;$('#pay-period-save').disabled=true;
    try{const p=await api('/api/pay-periods'+(editing?'/'+editing:''),{method:editing?'PATCH':'POST',body:JSON.stringify({label:$('#pay-period-label').value,from,to,...(editing?{reason:$('#pay-period-reason').value}:{})})});if(context!==timeContext())return;payList=[...payList.filter(row=>row.id!==p.id),p];$('#pay-period-dialog').close();choosePayPeriod(p.id)}
    catch(err){if(context===timeContext()){error.textContent=err.message;error.hidden=false}}
    finally{if(context===timeContext()){payBusy=false;$('#pay-period-save').disabled=false}}
  };
  $('#pay-period-close').onclick=()=>$('#pay-period-dialog').close();
  function payDateInput(id){
    if(!['pay-period-from','pay-period-to'].includes(id))return;
    const preset=$('#pay-period-preset').value;
    if(id==='pay-period-from'&&['weekly','biweekly'].includes(preset))applyPayPreset();
    else {$('#pay-period-preset').value='custom';$('#pay-period-form-error').hidden=true;drawPayPreset()}
  }
  document.addEventListener('input',event=>{
    const id=event.target.id;
    if(['pay-period-month','pay-period-cutoff'].includes(id))applyPayPreset();else payDateInput(id);
  });
  $('#time-person-back').onclick=()=>{timePerson=null;renderTimeCards()};
  $('#time-person-search').oninput=()=>renderTimeCards();
  $('#time-filter-reset').onclick=()=>{for(const id of ['timecard-job','timecard-person','timecard-status'])$('#'+id).value='all';for(const id of ['timecard-from','timecard-to','time-person-search'])$('#'+id).value='';paySelected='';$('#time-more-filters').open=false;renderTimeCards()};
  document.addEventListener('change',event=>{
    if(['pay-period-preset','pay-period-month','pay-period-cutoff','pay-period-half'].includes(event.target.id)){applyPayPreset();return}
    if(['pay-period-from','pay-period-to'].includes(event.target.id)){payDateInput(event.target.id);return}
    if(event.target.id==='pay-period-select'){choosePayPeriod(event.target.value)}
    else if(['timecard-from','timecard-to'].includes(event.target.id)){const p=payList.find(p=>p.id===paySelected);if(p&&(p.from!==$('#timecard-from').value||p.to!==$('#timecard-to').value)){paySelected='';void refreshPayPeriods()}}
  });
  document.addEventListener('click',async event=>{
    const actionContext=timeContext();
    const person=event.target.closest('[data-time-person]');if(person){timePerson=person.dataset.timePerson;renderTimeCards();$('#time-person-back').focus();return}
    const use=event.target.closest('[data-pay-use]'),editSetting=event.target.closest('[data-pay-setting-edit]');if(use){showPage('timecards');choosePayPeriod(use.dataset.payUse);return}if(editSetting){paySelected=editSetting.dataset.paySettingEdit;openPayForm(true);return}
    if(event.target.closest('[data-pay-new]')){openPayForm(false);return}if(event.target.closest('[data-pay-edit]')){openPayForm(true);return}
    const download=event.target.closest('[data-pay-download]');
    try{
      if(download){await downloadPayExport(download.dataset.payDownload);return}
      if(event.target.closest('[data-pay-history]')){const context=timeContext(),period=paySelected,rows=await api('/api/pay-periods/'+period+'/exports');if(context!==timeContext()||period!==paySelected)return;$('#pay-period-history').innerHTML=rows.map(r=>`<p><button type="button" class="secondary" data-pay-download="${escapeHtml(r.id)}">Download v${r.version}</button> ${escapeHtml(r.createdAt)} ${escapeHtml(r.reason)}</p>`).join('');return}
      if(event.target.closest('[data-pay-capture]')){
        if(payBusy||!payConfigure||!paySummary?.ready||paySummary.period.id!==paySelected)return;const context=timeContext(),period=paySelected,latest=paySummary.latestExport;let reason='';if(latest){reason=prompt('Why is a corrected fixed export needed?')?.trim();if(!reason)return}
        payBusy=true;drawPayPanel();
        try{const record=await api('/api/pay-periods/'+period+'/exports',{method:'POST',body:JSON.stringify(latest?{supersedesId:latest.id,reason}:{})});if(context!==timeContext()||period!==paySelected)return;await downloadPayExport(record.id)}finally{if(context===timeContext()){payBusy=false;await refreshPayPeriods()}}
      }
    }catch(error){if(actionContext===timeContext())payMessage(error.message)}
  });
}
