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
  const jobLabel=document.getElementById('start-day-project').closest('label');
  const modes=document.createElement('div');modes.className='personal-clock-options clock-time-modes';modes.setAttribute('aria-label','Time type');
  modes.innerHTML='<button type="button" data-clock-mode="job" aria-pressed="true">Job time</button><button type="button" data-clock-mode="company" aria-pressed="false">Company time</button>';
  jobLabel.before(modes);
  const activityLabel=document.createElement('label');activityLabel.textContent='Activity';
  const activitySelect=document.createElement('select');activitySelect.id='personal-company-activity';activityLabel.append(activitySelect);jobLabel.after(activityLabel);activityLabel.hidden=true;
  const crew=start.querySelector('.labor-fieldset'),crewDetails=document.createElement('details'),crewSummary=document.createElement('summary');crewDetails.className='clock-crew-details';crewSummary.textContent='Crew';crew.before(crewDetails);crewDetails.append(crewSummary,crew);
  let mode='job',savingCompany=false;
  const chooseMode=async value=>{
    mode=value;start.dataset.clockMode=value;jobLabel.hidden=value!=='job';activityLabel.hidden=value!=='company';
    crewDetails.hidden=value==='company'||start.dataset.selfOnly==='true';optional.hidden=value==='company';noteLabel.hidden=true;
    for(const button of modes.querySelectorAll('button'))button.setAttribute('aria-pressed',String(button.dataset.clockMode===value));
    startDayMessage();
    if(value==='company'){
      activitySelect.innerHTML='<option value="">Choose an activity</option>';
      try{const activities=await api('/api/company-activities');for(const row of activities){const option=document.createElement('option');option.value=row.id;option.textContent=row.name;activitySelect.append(option);}}
      catch(error){startDayMessage(error.message||'Activities could not be loaded. Try again.');}
    }
  };
  modes.addEventListener('click',event=>{const button=event.target.closest('[data-clock-mode]');if(button)void chooseMode(button.dataset.clockMode);});
  const originalConfirm=document.getElementById('confirm-start-day').onclick;
  document.getElementById('confirm-start-day').onclick=async function(event){
    if(mode==='job')return originalConfirm.call(this,event);
    if(savingCompany)return;
    if(!activitySelect.value)return startDayMessage('Choose a company activity.');
    savingCompany=true;this.disabled=true;
    try{const row=await api('/api/time-cards/company-clock',{method:'POST',body:JSON.stringify({activityCodeId:activitySelect.value})});timeCards.unshift(row);start.close();renderTimeCards();renderCompanyClockStatus();window.PDLPersonalClock.open();}
    catch(error){startDayMessage(error.message||'Company time could not be started. Try again.');}
    finally{savingCompany=false;this.disabled=false;}
  };
  const originalOpen = openStartDay;
  openStartDay = function(options={}) {
    originalOpen(options);
    const personal = options.selfOnly===true;
    noteLabel.hidden=true; photoLabel.hidden=true; optional.hidden=false;crewDetails.hidden=personal;crewDetails.open=false;crewSummary.textContent=`Crew · ${document.querySelectorAll('#start-day-members input:checked').length} selected`;void chooseMode(options.companyTime?'company':'job');
    addNote.setAttribute('aria-expanded','false'); photoCount.textContent='';
    if(personal)document.getElementById('start-day-project').focus();
  };
  optional.hidden=true;
  document.getElementById('company-clock').addEventListener('click',event=>{event.stopImmediatePropagation();openStartDay({selfOnly:true,companyTime:true});},true);
  const dialog=document.createElement('dialog');dialog.id='personal-clock-modal';dialog.setAttribute('aria-labelledby','personal-clock-title');
  dialog.innerHTML=`<div class="personal-clock-header"><h2 id="personal-clock-title">TIME CLOCK</h2><button type="button" data-clock-close aria-label="Close time clock">×</button></div><div class="personal-clock-body"><div class="personal-clock-timer"><p data-clock-job></p><small>ON THE CLOCK</small><strong data-clock-elapsed role="timer" aria-label="Elapsed work time">00:00:00</strong></div><div class="personal-clock-options"><button type="button" data-clock-note>Add daily note</button><button type="button" data-clock-photo>Add photo</button></div></div><div class="personal-clock-footer"><button type="button" data-clock-out>Clock out</button></div>`;
  document.body.append(dialog);
  let interval;
  const current = () => {
    const id=Number(currentUser?.memberId);if(!id)return null;
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
  const identity=()=>`${signedInCompanyId()||company?.id||''}:${currentUser?.id||''}:${currentUser?.memberId||''}`;
  const ownOpenCards=()=>JSON.stringify((timeCards||[]).filter(row=>row.activityCodeId&&!row.outAt&&Number(row.memberId)===Number(currentUser?.memberId)));
  let refreshing;
  const refreshCompanyClock=()=>{
    if(!currentUser?.id||!Number(currentUser.memberId))return Promise.resolve();
    const key=identity();if(refreshing?.key===key)return refreshing.promise;
    const before=ownOpenCards();
    const promise=(async()=>{
      try{const card=await api('/api/time-cards/company-clock');
        if(identity()!==key||ownOpenCards()!==before)return;
        if(card){const index=timeCards.findIndex(row=>Number(row.id)===Number(card.id));if(index<0)timeCards.push(card);else timeCards[index]=card;}
        else timeCards=timeCards.filter(row=>!(row.activityCodeId&&!row.outAt&&Number(row.memberId)===Number(currentUser?.memberId)));
      }catch{}finally{if(refreshing?.key===key)refreshing=null;syncLauncher();}
    })();refreshing={key,promise};return promise;
  };
  const open=async()=>{
    const key=identity();await refreshCompanyClock();if(identity()!==key||!currentUser?.id)return;
    if(!current())return openStartDay({selfOnly:true});
    update();if(!dialog.open)dialog.showModal();clearInterval(interval);interval=setInterval(update,1000);
  };
  dialog.querySelector('[data-clock-close]').onclick=close;
  dialog.addEventListener('close',()=>clearInterval(interval));
  dialog.querySelector('[data-clock-out]').onclick=()=>{close();renderFieldClock();document.getElementById('start-day-button').click();};
  dialog.querySelector('[data-clock-photo]').onclick=()=>{const active=current();if(!active)return close();const index=projects.findIndex(p=>Number(p.id)===Number(active.projectId));if(index<0)return;close();openProjectPhoto(index,{workdayId:active.day?.id||null});};
  dialog.querySelector('[data-clock-note]').onclick=()=>{const active=current();if(!active)return close();const index=projects.findIndex(p=>Number(p.id)===Number(active.projectId));if(index<0)return;close();const report=reports.find(row=>Number(row.workdayId)===Number(active.day?.id));openReport(report||null,{projectIndex:index});};
  const launcher=document.getElementById('project-assistant-launcher');
  const plusMarkup=launcher.innerHTML,openActions=launcher.onclick;
  const clockMarkup='<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 12h5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path class="clock-launcher-hand" d="M12 12V6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
  let lastRunning;
  const syncLauncher=()=>{
    const running=Boolean(currentUser?.id&&current());
    if(running!==lastRunning){launcher.innerHTML=running?clockMarkup:plusMarkup;launcher.classList.toggle('clock-running',running);launcher.setAttribute('aria-label',running?'View running clock':'Open quick actions');launcher.title=running?'Clock running — view timer':'Quick actions';lastRunning=running;}
  };
  launcher.onclick=event=>{syncLauncher();if(currentUser?.id&&current())void open();else openActions.call(launcher,event);};
  const originalRender=renderEverything;
  renderEverything=function(...args){const result=originalRender.apply(this,args);syncLauncher();void refreshCompanyClock();return result;};
  let lastIdentity=identity();
  const launcherInterval=setInterval(()=>{syncLauncher();const next=identity();if(next!==lastIdentity){lastIdentity=next;void refreshCompanyClock();}},1000);
  window.addEventListener('focus',()=>{syncLauncher();void refreshCompanyClock();});
  window.addEventListener('pagehide',()=>clearInterval(interval));
  window.addEventListener('pageshow',()=>{syncLauncher();void refreshCompanyClock();if(dialog.open){update();clearInterval(interval);interval=setInterval(update,1000);}});
  syncLauncher();void refreshCompanyClock();
  window.PDLPersonalClock={open};
})();
