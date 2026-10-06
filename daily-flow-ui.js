'use strict';
// Device-only photo recovery is scoped to the signed-in tenant and user. Files
// are uploaded only when the user clicks an existing save/end/submit action.
const dailyPhotoStore=new PDLDailyPhotoStore.PhotoStore(window.indexedDB);
const dailyPhotoIds=new WeakMap(),dailyPhotoMemory=new Map(),dailyPhotoPending=new Map();
let dailyEndBusy=false,dailyReportBusy=false,dailyProgressBusy=false,dailyInstructionSequence=0;
function dailyScope(){return `${signedInCompanyId()||company?.id||''}:${currentUser?.id||''}`}
function dailyPhotoKey(kind,id){return `${dailyScope()}:${kind}:${id}`}
function dailyReportPhotoKey(){return dailyPhotoKey('report',editingReportId?`id-${editingReportId}`:`project-${projects[Number($('#report-project').value)]?.id}`)}
function dailyEndKey(id){return `pdl-end-draft-v1:${dailyScope()}:${id}`}
function dailyEndMarkerKey(){return `pdl-end-active-v1:${dailyScope()}`}
function photoRecoveryWarning(error){notify(`Photo recovery could not be saved on this device. Keep this tab open and retry before refreshing. ${error.message||''}`)}
function photoRows(files){return Array.from(files).map(file=>{let uploadId=dailyPhotoIds.get(file);if(!uploadId){uploadId=crypto.randomUUID();dailyPhotoIds.set(file,uploadId)}return {uploadId,file,name:file.name,type:file.type,lastModified:file.lastModified}})}
function setRecoveredFiles(input,rows){const transfer=new DataTransfer();rows.forEach(row=>{if(!row.file.name)row.file=new File([row.file],row.name,{type:row.type,lastModified:row.lastModified});dailyPhotoIds.set(row.file,row.uploadId);transfer.items.add(row.file)});input.files=transfer.files}
function photoRecoveryList(input,key,rows){
  let list=input.parentElement.querySelector('[data-photo-recovery-list]');
  if(!list){list=document.createElement('div');list.dataset.photoRecoveryList='';input.parentElement.append(list)}
  list.replaceChildren();
  for(const row of rows){const item=document.createElement('div'),label=document.createElement('span'),remove=document.createElement('button');
    label.textContent=row.file.name;remove.type='button';remove.className='secondary small';remove.textContent='Remove';
    remove.onclick=async()=>{if(input.disabled)return;const remaining=(dailyPhotoMemory.get(key)||[]).filter(file=>file.uploadId!==row.uploadId);dailyPhotoMemory.set(key,remaining);setRecoveredFiles(input,remaining);photoRecoveryList(input,key,remaining);try{await dailyPhotoStore.put(key,remaining)}catch(error){photoRecoveryWarning(error)}};
    item.append(label,remove);list.append(item);
  }
}
async function restoreDailyPhotos(input,key){
  input.dataset.recoveryKey=key;const generation=Number(input.dataset.recoveryGeneration||0)+1;input.dataset.recoveryGeneration=String(generation);
  try{const rows=dailyPhotoMemory.get(key)||await dailyPhotoStore.get(key);if(input.dataset.recoveryKey!==key||Number(input.dataset.recoveryGeneration)!==generation)return;dailyPhotoMemory.set(key,rows);setRecoveredFiles(input,rows);photoRecoveryList(input,key,rows)}catch(error){photoRecoveryWarning(error)}
}
function stageDailyPhotos(input,key){
  const selected=photoRows(input.files);input.dataset.recoveryKey=key;input.dataset.recoveryGeneration=String(Number(input.dataset.recoveryGeneration||0)+1);
  const prior=dailyPhotoPending.get(key)||Promise.resolve();
  const task=prior.catch(()=>{}).then(async()=>{
    let previous=dailyPhotoMemory.get(key);if(!previous){try{previous=await dailyPhotoStore.get(key)}catch(error){previous=[];photoRecoveryWarning(error)}}const rows=[...previous];
    for(const row of selected)if(!rows.some(old=>old.file.name===row.file.name&&old.file.size===row.file.size&&old.file.lastModified===row.file.lastModified))rows.push(row);
    dailyPhotoMemory.set(key,rows);
    if(input.dataset.recoveryKey===key){setRecoveredFiles(input,rows);photoRecoveryList(input,key,rows)}
    await dailyPhotoStore.put(key,rows);
  });
  dailyPhotoPending.set(key,task);task.catch(photoRecoveryWarning);return task;
}
async function dailyPhotoReady(input,key){try{await dailyPhotoPending.get(key)}catch(error){photoRecoveryWarning(error)}return dailyPhotoMemory.get(key)||photoRows(input.files)}
async function clearDailyPhotos(input,key){await dailyPhotoStore.remove(key);dailyPhotoMemory.delete(key);dailyPhotoPending.delete(key);if(input.dataset.recoveryKey===key){input.dataset.recoveryGeneration=String(Number(input.dataset.recoveryGeneration||0)+1);input.value='';photoRecoveryList(input,key,[])}}
const encodeFilesBeforeDailyRecovery=encodeFiles;
encodeFiles=async function(files){const encoded=await encodeFilesBeforeDailyRecovery(files);encoded.forEach((row,index)=>{row.uploadId=dailyPhotoIds.get(Array.from(files)[index])||crypto.randomUUID()});return encoded};

function rememberEndDay(){
  const id=Number($('#end-day-id').value);if(!id)return;
  try{localStorage.setItem(dailyEndKey(id),JSON.stringify({notes:$('#end-day-notes').value,next:$('#end-day-next').value,tags:$('#end-day-photo-tags').value,updatedAt:new Date().toISOString()}));localStorage.setItem(dailyEndMarkerKey(),String(id))}catch(error){notify('End Day notes could not be saved on this device. Keep this tab open until clock-out is confirmed.')}
}
function readEndDay(id){try{return JSON.parse(localStorage.getItem(dailyEndKey(id))||'null')}catch{return null}}
const openEndDayBeforeRecovery=openEndDay;
openEndDay=function(id){
  openEndDayBeforeRecovery(id);const saved=readEndDay(id);
  if(saved){$('#end-day-notes').value=saved.notes||'';$('#end-day-next').value=saved.next||'';$('#end-day-photo-tags').value=saved.tags||''}
  rememberEndDay();void restoreDailyPhotos($('#end-day-photos'),dailyPhotoKey('end',id));
};
for(const id of ['end-day-notes','end-day-next','end-day-photo-tags'])$('#'+id).addEventListener('input',rememberEndDay);
$('#end-day-photos').addEventListener('change',()=>{rememberEndDay();stageDailyPhotos($('#end-day-photos'),dailyPhotoKey('end',Number($('#end-day-id').value)))});

async function endDayWithRecovery(){
  if(dailyEndBusy)return;const id=Number($('#end-day-id').value),notes=$('#end-day-notes').value.trim(),next=$('#end-day-next').value.trim(),button=$('#confirm-end-day'),label=button.textContent;
  if(!notes){notify('Add a short note about what was completed');return}
  const scopeAtStart=dailyScope();let clockoutConfirmed=false;dailyEndBusy=true;button.disabled=true;button.textContent='Saving clock-out…';rememberEndDay();
  try{
    // Photo preparation/storage must never delay or roll back clock-out.
    const result=await api(`/api/workdays/${id}/end`,{method:'POST',body:JSON.stringify({notes,next,language:preferredLanguage})});
    if(scopeAtStart!==dailyScope())return;
    clockoutConfirmed=true;
    const index=workdays.findIndex(day=>Number(day.id)===id);if(index>=0)workdays[index]=result.workday;else workdays.push(result.workday);
    const reportIndex=reports.findIndex(report=>Number(report.id)===Number(result.report.id));if(reportIndex>=0)reports[reportIndex]=result.report;else reports.unshift(result.report);
    $('#end-day-modal').close();renderWorkdays();renderMyDay();renderReports(result.report.id);showPage('reports');
    await openEndedDayReview(result);
  }catch(error){
    // A lost response may have committed. Retrying is idempotent, and a refresh
    // reconciles against the server workday. Never advise starting another clock.
    notify(clockoutConfirmed?`Clock-out is saved. Review setup was interrupted; reopen this draft in Daily Reports. Your selected photos are retained for retry. ${error.message||''}`:`Clock-out could not be confirmed. Your notes and photos remain here. Retry End Day; it will not create another report. ${error.message||''}`);
  }finally{dailyEndBusy=false;button.disabled=false;button.textContent=label}
}
async function openEndedDayReview(result){
  const id=Number(result.workday.id),saved=readEndDay(id),key=dailyPhotoKey('end',id),input=$('#end-day-photos');
  const alreadyReviewing=$('#report-modal').open&&Number(editingReportId)===Number(result.report.id);
  if(!alreadyReviewing)openReport(result.report);rememberActiveReport();
  let rows=[];
  try{await dailyPhotoPending.get(key);rows=dailyPhotoMemory.get(key)||await dailyPhotoStore.get(key)}catch(error){rows=dailyPhotoMemory.get(key)||photoRows(input.files);photoRecoveryWarning(error)}
  const reportInput=$('#report-photos'),reportKey=dailyReportPhotoKey();let photosDurable=true;
  if(rows.length){
    const combined=[...(dailyPhotoMemory.get(reportKey)||[])];for(const row of rows)if(!combined.some(old=>old.uploadId===row.uploadId))combined.push(row);rows=combined;
    dailyPhotoMemory.set(reportKey,rows);reportInput.dataset.recoveryGeneration=String(Number(reportInput.dataset.recoveryGeneration||0)+1);setRecoveredFiles(reportInput,rows);reportInput.dataset.recoveryKey=reportKey;photoRecoveryList(reportInput,reportKey,rows);
    try{await dailyPhotoStore.put(reportKey,rows);await clearDailyPhotos(input,key)}catch(error){photosDurable=false;photoRecoveryWarning(error)}
  }
  if(photosDurable){localStorage.removeItem(dailyEndKey(id));localStorage.removeItem(dailyEndMarkerKey())}
  if(result.report.status!=='Draft'){showReportMessage('Clock-out is already saved. Review this existing report.');return}
  if(!result.alreadyEnded&&!alreadyReviewing){
    const modal=$('#report-modal'),fields=$$('#report-modal input, #report-modal textarea, #report-modal select, #report-modal button:not([value="cancel"]):not([aria-label="Close dialog"])').map(field=>({field,disabled:field.disabled}));
    modal.dataset.analyzing='true';fields.forEach(({field})=>field.disabled=true);
    try{showReportMessage('Clock-out is saved. Preparing your report for editable review.','checking');await $('#ai-convert').onclick()}finally{delete modal.dataset.analyzing;fields.forEach(({field,disabled})=>field.disabled=disabled)}
    // The separately entered next step is explicit and takes precedence over AI.
    if(saved?.next?.trim())$('#report-next').value=saved.next.trim();
    rememberActiveReport();
  }
  showReportMessage('Clock-out is saved. Check and edit the proposed work, safety concerns, and next steps before submitting. Photos remain on this device until you save the draft or submit.','checking');
}

const openReportBeforePhotoRecovery=openReport;
openReport=function(report){const result=openReportBeforePhotoRecovery(report);void restoreDailyPhotos($('#report-photos'),dailyReportPhotoKey());return result};
$('#report-photos').addEventListener('change',()=>stageDailyPhotos($('#report-photos'),dailyReportPhotoKey()));
$('#report-project').addEventListener('change',()=>void restoreDailyPhotos($('#report-photos'),dailyReportPhotoKey()));
const saveDailyBeforePhotoRecovery=saveDailyReport;
saveDailyReport=async function(status){
  if(dailyReportBusy)return;dailyReportBusy=true;const input=$('#report-photos'),key=dailyReportPhotoKey();input.disabled=true;
  try{await dailyPhotoReady(input,key);
  await saveDailyBeforePhotoRecovery(status);
  if(!$('#report-modal').open){try{await clearDailyPhotos(input,key)}catch(error){photoRecoveryWarning(error)}}
  else if(editingReportId&&dailyReportPhotoKey()!==key){
    const newKey=dailyReportPhotoKey(),rows=dailyPhotoMemory.get(key)||photoRows(input.files);dailyPhotoMemory.set(newKey,rows);input.dataset.recoveryKey=newKey;
    try{await dailyPhotoStore.put(newKey,rows);await dailyPhotoStore.remove(key);dailyPhotoMemory.delete(key)}catch(error){photoRecoveryWarning(error)}
  }}finally{dailyReportBusy=false;input.disabled=false}
};

const openProjectPhotoBeforeRecovery=openProjectPhoto;
function progressPhotoNotesKey(key){return `pdl-progress-photo-notes-v1:${key}`}
function rememberProgressPhotoNotes(){const key=$('#office-photos').dataset.recoveryKey;if(!key)return;try{localStorage.setItem(progressPhotoNotesKey(key),JSON.stringify({caption:$('#photo-caption').value,tags:$('#photo-tags').value}))}catch(error){notify('The photo note could not be saved on this device. Keep this tab open until upload completes.')}}
openProjectPhoto=function(index,options={}){const result=openProjectPhotoBeforeRecovery(index,options),key=dailyPhotoKey('progress',`${projects[index]?.id}:${options.workdayId||''}`);try{const saved=JSON.parse(localStorage.getItem(progressPhotoNotesKey(key))||'null');if(saved){$('#photo-caption').value=saved.caption||'';$('#photo-tags').value=saved.tags||''}}catch{}void restoreDailyPhotos($('#office-photos'),key);return result};
for(const id of ['photo-caption','photo-tags'])$('#'+id).addEventListener('input',rememberProgressPhotoNotes);
$('#office-photos').addEventListener('change',()=>stageDailyPhotos($('#office-photos'),$('#office-photos').dataset.recoveryKey));
const saveProgressPhotosBeforeRecovery=$('#save-photos').onclick;
$('#save-photos').onclick=async function(){if(dailyProgressBusy)return;dailyProgressBusy=true;const input=$('#office-photos'),key=input.dataset.recoveryKey;input.disabled=true;rememberProgressPhotoNotes();try{await dailyPhotoReady(input,key);await saveProgressPhotosBeforeRecovery();if(!$('#photo-modal').open){await clearDailyPhotos(input,key).catch(photoRecoveryWarning);localStorage.removeItem(progressPhotoNotesKey(key))}}finally{dailyProgressBusy=false;input.disabled=false}};

const openAssignmentBeforeCarryControl=openAssignment;
openAssignment=function(prefill={}){const result=openAssignmentBeforeCarryControl(prefill);if(canManageSchedule())$('#assignment-carry-next').checked=prefill.assignment?.carryPreviousNext!==false;return result};
async function renderDailyInstructions(){
  const sequence=++dailyInstructionSequence;if(currentRole!=='field')return;
  const today=companyTodayIso(),memberId=Number(currentUser?.memberId),mine=assignments.filter(row=>row.date===today&&(row.memberIds||[]).map(Number).includes(memberId));
  await Promise.all(mine.map(async(assignment,index)=>{
    const card=$$('#field-today .field-assignment-card')[index];if(!card)return;
    let section=card.querySelector('[data-day-instructions]');if(!section){section=document.createElement('section');section.dataset.dayInstructions='';card.append(section)}
    section.replaceChildren();if(assignment.carryPreviousNext===false)return;
    try{const result=await api(`/api/projects/${assignment.projectId}/day-instructions?date=${today}`);if(sequence!==dailyInstructionSequence||!result.previousNext)return;
      const heading=document.createElement('strong'),text=document.createElement('p');heading.textContent=`Previous daily next steps · ${result.previousNext.date} · ${result.previousNext.status}`;text.textContent=result.previousNext.text;
      const note=document.createElement('small');note.textContent='Reference from the previous submitted daily. Follow today’s assigned activity; ask your PM if these conflict.';section.append(heading,text,note);
    }catch(error){if(sequence===dailyInstructionSequence){const message=document.createElement('small');message.textContent='Previous daily instructions could not load. Check with your PM.';section.append(message)}}
  }));
}
const renderMyDayBeforeInstructions=renderMyDay;
renderMyDay=function(){const result=renderMyDayBeforeInstructions();void renderDailyInstructions();return result};
const loadRoleBeforeDailyRecovery=loadRole;
loadRole=async function(role){const result=await loadRoleBeforeDailyRecovery(role);const id=Number(localStorage.getItem(dailyEndMarkerKey()));if(id){const workday=workdays.find(day=>Number(day.id)===id);if(workday?.status==='active'&&!$('#report-modal').open)openEndDay(id);else if(workday?.status==='complete'){const report=reports.find(row=>Number(row.id)===Number(workday.reportId));if(report&&(!$('#report-modal').open||Number(editingReportId)===Number(report.id)))await openEndedDayReview({workday,report,alreadyEnded:true})}}return result};
