/* Personal clock presentation; saves use the existing workday and daily flows. */
(() => {
  const start = document.getElementById('start-day-modal');
  const photos = document.getElementById('start-day-photos');
  const note = document.getElementById('start-day-note');
  const photoLabel = photos.closest('label'), noteLabel = note.closest('label');
  const optional = document.createElement('div'); optional.className = 'personal-clock-options';
  const addNote = document.createElement('button'); addNote.type = 'button'; addNote.textContent = 'Add note';
  const addPhoto = document.createElement('button'); addPhoto.type = 'button'; addPhoto.textContent = 'Add photo';
  const photoCount = document.createElement('span'); photoCount.setAttribute('aria-live','polite');
  optional.append(addNote,addPhoto,photoCount); noteLabel.before(optional);
  const toggleNote = () => { noteLabel.hidden = !noteLabel.hidden; addNote.setAttribute('aria-expanded',String(!noteLabel.hidden)); if(!noteLabel.hidden)note.focus(); };
  addNote.onclick = toggleNote; addPhoto.onclick = () => photos.click();
  photos.addEventListener('change',()=>{photoCount.textContent=photos.files.length ? `${photos.files.length} photo${photos.files.length===1?'':'s'} added` : '';});
  const originalOpen = openStartDay;
  openStartDay = function(options={}) {
    originalOpen(options);
    const personal = options.selfOnly===true;
    noteLabel.hidden=personal; photoLabel.hidden=personal; optional.hidden=!personal;
    addNote.setAttribute('aria-expanded','false'); photoCount.textContent='';
    if(personal)document.getElementById('start-day-project').focus();
  };
  optional.hidden=true;
  const dialog=document.createElement('dialog');dialog.id='personal-clock-modal';dialog.setAttribute('aria-labelledby','personal-clock-title');
  dialog.innerHTML=`<div class="personal-clock-header"><h2 id="personal-clock-title">TIME CLOCK</h2><button type="button" data-clock-close aria-label="Close time clock">×</button></div><div class="personal-clock-body"><div class="personal-clock-timer"><p data-clock-job></p><small>ON THE CLOCK</small><strong data-clock-elapsed role="timer" aria-label="Elapsed work time">00:00:00</strong></div><div class="personal-clock-options"><button type="button" data-clock-note>Add daily note</button><button type="button" data-clock-photo>Add photo</button></div></div><div class="personal-clock-footer"><button type="button" data-clock-out>Clock out</button></div>`;
  document.body.append(dialog);
  let interval;
  const current = () => {
    const id=Number(currentUser?.memberId);
    const day=(workdays||[]).find(row=>row.status==='active'&&(row.memberIds||[]).map(Number).includes(id));
    const card=(timeCards||[]).find(row=>Number(row.memberId)===id&&!row.outAt);
    return day?{day,projectId:day.projectId,startedAt:day.startedAt}:card?{card,projectId:card.projectId,startedAt:card.inAt}:null;
  };
  const close=()=>{clearInterval(interval);dialog.close();};
  const update=()=>{
    const active=current();if(!active){close();return;}
    const project=projects.find(row=>Number(row.id)===Number(active.projectId));
    dialog.querySelector('[data-clock-job]').textContent=project?.name||active.card?.activityName||'Company time';
    const seconds=Math.max(0,Math.floor((Date.now()-Date.parse(active.startedAt))/1000));
    dialog.querySelector('[data-clock-elapsed]').textContent=[Math.floor(seconds/3600),Math.floor(seconds/60)%60,seconds%60].map(value=>String(value).padStart(2,'0')).join(':');
    for(const name of ['note','photo'])dialog.querySelector(`[data-clock-${name}]`).hidden=!project;
  };
  const open=()=>{
    if(!current())return openStartDay({selfOnly:true});
    update();if(!dialog.open)dialog.showModal();clearInterval(interval);interval=setInterval(update,1000);
  };
  dialog.querySelector('[data-clock-close]').onclick=close;
  dialog.addEventListener('close',()=>clearInterval(interval));
  dialog.querySelector('[data-clock-out]').onclick=()=>{close();renderFieldClock();document.getElementById('start-day-button').click();};
  dialog.querySelector('[data-clock-photo]').onclick=()=>{const active=current();if(!active)return close();const index=projects.findIndex(p=>Number(p.id)===Number(active.projectId));if(index<0)return;close();openProjectPhoto(index,{workdayId:active.day?.id||null});};
  dialog.querySelector('[data-clock-note]').onclick=()=>{const active=current();if(!active)return close();const index=projects.findIndex(p=>Number(p.id)===Number(active.projectId));if(index<0)return;close();const report=reports.find(row=>Number(row.workdayId)===Number(active.day?.id));openReport(report||null,{projectIndex:index});};
  window.PDLPersonalClock={open};
})();
