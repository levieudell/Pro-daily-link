'use strict';
function crewFieldRestricted(){return currentUser?.role==='field'&&currentUser.fieldAccessMode==='time_schedule_photos'}
function crewUiScope(){return `${signedInCompanyId()||company?.id||''}:${currentUser?.id||''}:${currentUser?.memberId||''}:${currentUser?.fieldAccessMode||''}`}
let crewClockBusy=false,crewPhotoBusy=false,crewPhotoProject=null,crewPhotoSequence=0;
const crewUploadIds=new WeakMap();
function crewSafePhotoUrl(value){try{const url=new URL(String(value||''),location.origin);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)return '';if(url.origin===location.origin&&url.pathname.startsWith('/uploads/'))return '/api/local-files/'+url.pathname.slice('/uploads/'.length);return url.href}catch{return ''}}
function crewPhotoList(rows){const list=$('#crew-photo-list');list.replaceChildren();if(!rows.length){const text=document.createElement('p');text.textContent='No photos on this job yet.';list.append(text)}for(const row of rows){const url=crewSafePhotoUrl(row.url);if(!url)continue;const figure=document.createElement('figure'),image=document.createElement('img'),caption=document.createElement('figcaption');image.src=url;image.alt='Assigned job photo';image.loading='lazy';image.style.maxWidth='100%';caption.textContent=`${row.uploader||'Team member'}${row.createdAt?' · '+new Date(row.createdAt).toLocaleDateString():''}`;figure.append(image,caption);list.append(figure)}}
async function openCrewPhotos(projectId){
  if(crewPhotoBusy)return;
  if(!crewFieldRestricted()||!projects.some(project=>Number(project.id)===Number(projectId)))return;
  const dialog=$('#crew-photo-modal'),sequence=++crewPhotoSequence,scope=crewUiScope();crewPhotoProject=projectId;$('#crew-photo-title').textContent='Job photos — '+projects.find(row=>Number(row.id)===Number(projectId)).name;$('#crew-photo-files').value='';$('#crew-photo-message').textContent='Loading photos.';$('#crew-photo-list').replaceChildren();if(!dialog.open)dialog.showModal();
  try{const rows=await api('/api/crew/photos?projectId='+encodeURIComponent(projectId));if(sequence!==crewPhotoSequence||scope!==crewUiScope()||!dialog.open)return;crewPhotoList(rows);$('#crew-photo-message').textContent='View or upload photos for this assigned job.'}catch(error){if(sequence===crewPhotoSequence&&scope===crewUiScope()&&dialog.open)$('#crew-photo-message').textContent=error.message}
}
$('#crew-photo-modal').addEventListener('close',()=>{crewPhotoSequence++;crewPhotoProject=null;$('#crew-photo-files').value='';$('#crew-photo-list').replaceChildren()});
$('#crew-photo-modal').addEventListener('cancel',event=>{if(crewPhotoBusy)event.preventDefault()});
$('#crew-photo-upload').onclick=async function(){
  if(crewPhotoBusy||!crewFieldRestricted()||!crewPhotoProject)return;
  const input=$('#crew-photo-files'),files=Array.from(input.files),button=$('#crew-photo-upload'),scope=crewUiScope(),sequence=crewPhotoSequence,projectId=crewPhotoProject,message=$('#crew-photo-message');
  if(!files.length||files.length>8||files.some(file=>!['image/jpeg','image/png','image/webp'].includes(file.type)||file.size>6000000)){message.textContent='Choose up to 8 JPG, PNG, or WebP photos, each 6 MB or smaller.';return}
  crewPhotoBusy=true;button.disabled=true;input.disabled=true;message.textContent='Uploading photos.';
  try{const payload=await Promise.all(files.map(async file=>{let uploadId=crewUploadIds.get(file);if(!uploadId){uploadId=crypto.randomUUID();crewUploadIds.set(file,uploadId)}return{type:file.type,uploadId,data:await fileAsData(file)}}));
    if(scope!==crewUiScope()||sequence!==crewPhotoSequence||!$('#crew-photo-modal').open)return;
    await api('/api/crew/photos',{method:'POST',body:JSON.stringify({projectId,files:payload})});
    if(scope!==crewUiScope()||sequence!==crewPhotoSequence||!$('#crew-photo-modal').open)return;
    input.value='';const rows=await api('/api/crew/photos?projectId='+encodeURIComponent(projectId));if(scope!==crewUiScope()||sequence!==crewPhotoSequence||!$('#crew-photo-modal').open)return;crewPhotoList(rows);message.textContent='Photos uploaded.';
  }catch(error){if(scope===crewUiScope()&&sequence===crewPhotoSequence&&$('#crew-photo-modal').open)message.textContent=error.message+' Your selected files are retained for retry.'}finally{crewPhotoBusy=false;button.disabled=false;input.disabled=false}
};
async function crewClock(action,card){
  if(crewClockBusy||!crewFieldRestricted())return;const scope=crewUiScope(),projectId=Number($('#crew-clock-project')?.value);
  if(action==='in'&&!projectId)return notify('Choose an assigned job.');crewClockBusy=true;renderMyDay();
  try{await api(action==='in'?'/api/crew/clock-in':`/api/time-cards/${card.id}/clock-out`,{method:'POST',body:JSON.stringify(action==='in'?{projectId}:{revision:card.fieldAccess?.revision})});if(scope!==crewUiScope())return;await refreshTimeCards();if(scope===crewUiScope())notify(action==='in'?'Your time clock started.':'Your time clock stopped. Review and submit your time card.')}catch(error){if(scope===crewUiScope())notify(error.message)}finally{crewClockBusy=false;if(scope===crewUiScope())renderMyDay()}
}
const renderMyDayBeforeCrew=renderMyDay;
renderMyDay=function(){
  if(!crewFieldRestricted())return renderMyDayBeforeCrew();
  const mine=assignments.filter(row=>(row.memberIds||[]).map(Number).includes(Number(currentUser.memberId))),today=companyTodayIso(),active=timeCards.find(card=>Number(card.memberId)===Number(currentUser.memberId)&&!card.outAt),hero=$('#field-start-card');
  hero.querySelector('small').textContent=active?'CLOCK RUNNING':'YOUR TIME';hero.querySelector('h2').textContent=active?'Clock out':'Clock in';$('#field-start-detail').textContent=active?'Your clock is running. Review your time card after clocking out.':'Choose an assigned job to record your own time.';hero.querySelector('[data-add-workday-photos]')?.remove();
  let select=$('#crew-clock-project');if(!select){select=document.createElement('select');select.id='crew-clock-project';select.setAttribute('aria-label','Assigned job for your time clock');hero.querySelector('div').append(select)}const selected=select.value;select.replaceChildren();const placeholder=document.createElement('option');placeholder.value='';placeholder.textContent='Choose assigned job';select.append(placeholder);for(const project of projects){const option=document.createElement('option');option.value=project.id;option.textContent=project.name;select.append(option)}select.value=selected;select.hidden=Boolean(active);select.disabled=crewClockBusy||!timeCardsOn();
  const button=$('[data-start-day]');button.textContent=active?'CLOCK OUT':'CLOCK IN';button.disabled=crewClockBusy||!timeCardsOn();button.onclick=()=>crewClock(active?'out':'in',active);
  const draw=(selector,rows,empty)=>{const list=$(selector);list.replaceChildren();if(!rows.length){const text=document.createElement('p');text.textContent=empty;list.append(text)}for(const assignment of rows){const project=projects.find(row=>Number(row.id)===Number(assignment.projectId)),card=document.createElement('article');card.className='field-assignment';const title=document.createElement('strong'),detail=document.createElement('p');title.textContent=project?.name||'Assigned job';detail.textContent=`${assignment.date||''} · ${assignment.start||''}–${assignment.end||''} · ${assignment.activity||''}`;card.append(title,detail);list.append(card)}};
  draw('#field-today',mine.filter(row=>row.date===today),'No assignment today. Contact your supervisor if this is unexpected.');draw('#field-upcoming',mine.filter(row=>row.date>today).sort((a,b)=>String(a.date).localeCompare(String(b.date))),'No upcoming assignments.');
  $('#field-reports').replaceChildren();let panel=$('#crew-jobs-panel');if(!panel){panel=document.createElement('article');panel.id='crew-jobs-panel';panel.className='panel';$('#myday-page').append(panel)}panel.replaceChildren();const heading=document.createElement('h2');heading.textContent='Assigned job photos';panel.append(heading);for(const project of projects){const open=document.createElement('button');open.type='button';open.className='secondary';open.textContent='View / upload photos — '+project.name;open.onclick=()=>openCrewPhotos(project.id);panel.append(open)}if(!projects.length){const text=document.createElement('p');text.textContent='Ask your supervisor to assign a job before viewing or uploading photos.';panel.append(text)}
};
function applyCrewUi(){const restricted=crewFieldRestricted();document.body.classList.toggle('crew-restricted',restricted);$('#crew-jobs-panel')?.toggleAttribute('hidden',!restricted);for(const element of $$('[data-crew-hidden]')){element.style.removeProperty('display');delete element.dataset.crewHidden}if(!restricted){$('#crew-clock-project')?.remove();return}
  for(const element of $$('[data-page],[data-page-link],.field-reports-panel,#field-first-tip,#company-clock,#company-clock-status,#timeoff-page')){const page=element.dataset.page||element.dataset.pageLink;if(page&&['myday','timecards'].includes(page))continue;element.dataset.crewHidden='';element.style.setProperty('display','none','important')}
  $('#profile-role').textContent='Crew member — time, schedule & photos';for(const selector of ['#report-modal','#end-day-modal','#photo-modal']){const dialog=$(selector);if(dialog?.open)dialog.close()}
}
const showPageBeforeCrew=showPage;showPage=function(page,options){return showPageBeforeCrew(crewFieldRestricted()&&!['myday','timecards'].includes(page)?'myday':page,options)};
const loadRoleBeforeCrew=loadRole;loadRole=async function(role){if(crewFieldRestricted())timeCards=[];const result=await loadRoleBeforeCrew(role);applyCrewUi();if(crewFieldRestricted())renderMyDay();return result};
const refreshTimeCardsBeforeCrew=refreshTimeCards;refreshTimeCards=async function(){const result=await refreshTimeCardsBeforeCrew();if(crewFieldRestricted())renderMyDay();return result};
const openReportBeforeCrew=openReport;openReport=function(...args){if(crewFieldRestricted())return notify('Daily reports are unavailable for your crew access.');return openReportBeforeCrew(...args)};
const openProjectBeforeCrew=openProject;openProject=function(...args){if(crewFieldRestricted())return notify('Use Assigned job photos to view or upload job photos.');return openProjectBeforeCrew(...args)};
