var fieldScopeFlags=[];
(function(){
  if(typeof document==='undefined'||typeof $!=='function')return;
  const textFields=[['#report-summary','Summary'],['#report-materials','Materials'],['#report-equipment','Equipment'],['#report-delays','Delays'],['#report-safety','Safety']];
  function fieldCompact(){return typeof currentRole!=='undefined'&&currentRole==='field'&&$('#report-type')?.value!=='superintendent'}
  function escapeText(value){return typeof escapeHtml==='function'?escapeHtml(value):String(value??'')}
  function polishFieldDaily(){
    const compact=fieldCompact(),next=$('#report-next-step'),send=$('#save-report'),modal=$('#report-modal');
    if(next&&compact)next.textContent=preferredLanguage==='es'?'Listo':'Done';
    if(send&&compact){const approved=Boolean(editingReportId)&&(typeof reports==='undefined'?[]:reports).some(row=>Number(row.id)===Number(editingReportId)&&row.status==='Approved');send.textContent=approved?(preferredLanguage==='es'?'Guardar corrección para revisión':'Save correction for office review'):(preferredLanguage==='es'?'Enviar a la oficina':'Send to office')}
    ensureFieldClockOut();
    modal?.classList.toggle('field-manual-entry',compact&&!fieldScopeFlags.length&&![...$$('.production-entry')].some(row=>row.dataset.aiFilled==='true'));
    if(!compact){const flags=$('#field-scope-flags'),cards=$('#field-review-cards');if(flags)flags.hidden=true;if(cards)cards.hidden=true}
  }
  function groundedText(value){const text=String(value||'').trim();return text&&!/^needs confirmation[.!\s]*$/i.test(text)?text:''}
  function nextStepText(value){const text=groundedText(value);if(!text)return '';if(typeof FieldDailyScope!=='undefined'&&FieldDailyScope.tidyNext)return FieldDailyScope.tidyNext(text);return text.replace(/^(?:next\s*step|next)\s*:\s*/i,'').trim()}
  function lineEstimateId(row){return String((typeof rowEstimateItemId==='function'?rowEstimateItemId(row):'')||row?.dataset?.estimateItemId||row?.querySelector?.('.production-item')?.value||'')}
  function lockedLaborMap(){
    const map=new Map();
    const remember=(id,minutes,hours)=>{const key=String(id||'');if(!key)return;map.set(key,{minutes:Math.max(0,Math.round(Number(minutes)||0)),hours:Number(hours)||0})};
    for(const row of $$('.production-entry')){if(row.dataset.laborManual!=='true')continue;remember(lineEstimateId(row),row.dataset.laborMinutes,row.querySelector('.production-hours')?.value)}
    const report=(typeof reports==='undefined'?[]:reports).find(row=>Number(row.id)===Number(typeof editingReportId==='undefined'?0:editingReportId));
    for(const entry of report?.productionEntries||[]){if(entry?.laborManual!==true||map.has(String(entry.estimateItemId??'')))continue;remember(entry.estimateItemId,entry.laborMinutes,entry.laborHours)}
    return map;
  }
  function applyLockedLabor(map){
    if(!map?.size)return;
    for(const row of $$('.production-entry')){
      const lock=map.get(lineEstimateId(row));
      if(!lock)continue;
      row.dataset.laborManual='true';
      row.dataset.laborMinutes=String(lock.minutes);
      const hours=row.querySelector('.production-hours');
      if(hours)hours.value=typeof FieldDailyScope!=='undefined'&&FieldDailyScope.hoursFromMinutes?FieldDailyScope.hoursFromMinutes(lock.minutes):lock.hours;
    }
  }
  function paintManualBadge(row){
    const index=[...$$('.production-entry')].indexOf(row);
    const small=index>=0?document.querySelector(`[data-edit-line="${index}"] small`):null;
    if(!small)return;
    const base=String(small.textContent||'').replace(/\s*·\s*manual/ig,'').trim();
    small.textContent=row?.dataset?.laborManual==='true'?`${base} · manual`:base;
  }
  function stampOpenReportLocks(){
    const report=(typeof reports==='undefined'?[]:reports).find(row=>Number(row.id)===Number(typeof editingReportId==='undefined'?0:editingReportId));
    if(!report||!Array.isArray(report.productionEntries))return;
    const locks=lockedLaborMap();
    if(!locks.size)return;
    report.productionEntries=report.productionEntries.map(entry=>{
      const lock=locks.get(String(entry?.estimateItemId??''));
      if(!lock)return entry;
      return {...entry,laborManual:true,laborMinutes:lock.minutes,laborHours:typeof FieldDailyScope!=='undefined'&&FieldDailyScope.hoursFromMinutes?FieldDailyScope.hoursFromMinutes(lock.minutes):lock.hours};
    });
  }
  let laborLockSaveTimer=0;
  function scheduleLaborLockSave(){
    stampOpenReportLocks();
    if(typeof rememberActiveReport==='function')rememberActiveReport();
    clearTimeout(laborLockSaveTimer);
    laborLockSaveTimer=setTimeout(()=>{persistLaborLockDraft().catch(()=>{})},250);
  }
  async function persistLaborLockDraft(){
    if(!$('#report-modal')?.open||typeof saveDailyReport!=='function'||!(typeof editingReportId!=='undefined'&&editingReportId))return;
    const current=(typeof reports==='undefined'?[]:reports).find(row=>Number(row.id)===Number(editingReportId));
    const status=current?.status&&current.status!=='Draft'?current.status:'Draft';
    stampOpenReportLocks();
    await saveDailyReport(status,{keepOpen:true});
  }
  function applyScopeLines(review){
    const locks=lockedLaborMap();
    const lines=review?.lines||[];
    const byId=new Map();
    for(const row of [...$$('.production-entry')]){
      const id=lineEstimateId(row);
      if(!id)continue;
      if(byId.has(id)){row.remove();continue}
      byId.set(id,row);
    }
    const seen=new Set();
    for(const line of lines){
      const id=String(line.estimateItemId||'');
      if(id&&seen.has(id))continue;
      if(id)seen.add(id);
      const lock=id&&locks.get(id);
      const existing=id&&byId.get(id);
      if(existing){
        const quantity=existing.querySelector('.production-quantity');
        if(quantity&&line.quantity!=null)quantity.value=line.quantity;
        const unit=existing.querySelector('.production-unit');
        const safeUnit=line.unit&&String(line.unit).toLowerCase()!=='x'?line.unit:'';
        if(unit&&safeUnit)unit.value=safeUnit;
        existing.dataset.aiFilled='true';
        existing.classList.add('ai-filled-line');
        if(lock){existing.dataset.laborManual='true';existing.dataset.laborMinutes=String(lock.minutes)}
        continue;
      }
      const row=addProductionRow({description:line.description,estimateItemId:line.estimateItemId,quantity:line.quantity,unit:line.unit,laborHours:lock?lock.hours:(line.laborHours||''),laborManual:Boolean(lock),laborMinutes:lock?lock.minutes:undefined,needsScopeConfirmation:false});
      if(!row)continue;
      row.dataset.aiFilled='true';
      row.classList.add('ai-filled-line');
      const quantity=row.querySelector('.production-quantity');
      if(quantity&&line.quantity!=null)quantity.value=line.quantity;
      const unit=row.querySelector('.production-unit');
      const safeUnit=line.unit&&String(line.unit).toLowerCase()!=='x'?line.unit:'';
      if(unit&&safeUnit)unit.value=safeUnit;
    }
    applyLockedLabor(locks);
  }
  function applyNarrative(draft){
    const notes=$('#field-notes')?.value||'';
    const values={
      '#report-summary':groundedText(draft.summary),
      '#report-materials':groundedText(draft.materials),
      '#report-equipment':groundedText(draft.equipment),
      '#report-delays':groundedText(draft.delays||draft.issue),
      '#report-safety':groundedText(draft.safety)||(draft.noSafetyObservations&&/no safety|no incidents/i.test(notes)?'No safety incidents.':''),
      '#report-next':nextStepText(draft.next)
    };
    for(const [id,value] of Object.entries(values)){
      const field=$(id);if(!field||!value)continue;
      field.value=value;field.dataset.aiAccepted='true';field.classList.add('ai-filled-input');
    }
  }
  var fieldHoursReview=null;
  function clockHoursPresent(){return [...$$('[data-labor-member]')].some(input=>input.dataset.timecardDerived==='true'&&Number(input.value)>0)}
  function enteredLaborHours(){return [...$$('[data-labor-member]')].reduce((sum,input)=>sum+(Number(input.value)||0),0)}
  function crewStillClockedIn(){const projectId=projects?.[+$('#report-project')?.value]?.id,date=$('#report-date')?.value,cards=typeof timeCards==='undefined'?[]:timeCards,days=typeof workdays==='undefined'?[]:workdays;return cards.some(card=>card&&!card.deletedAt&&Number(card.projectId)===Number(projectId)&&String(card.date||'')===String(date||'')&&card.inAt&&!card.outAt)||days.some(day=>day&&Number(day.projectId)===Number(projectId)&&day.status==='active'&&!day.endedAt)}
  function applyAskedHours(value,headcount){const each=Number(value),inputs=[...$$('[data-labor-member]')];if(!(each>0)){inputs.forEach(input=>{if(input.dataset.noteDerived==='true')input.value=''});return}const count=Math.max(1,Math.min(inputs.length,Math.floor(Number(headcount)||1)));inputs.forEach(input=>{if(input.dataset.noteDerived==='true')input.value=''});inputs.slice(0,count).forEach(input=>{input.value=Math.min(24,each);input.dataset.noteDerived='true'})}
  function stampFlags(flags){return (Array.isArray(flags)?flags:[]).filter(Boolean).map(flag=>({...flag,id:flag.id||(typeof FieldDailyScope!=='undefined'&&FieldDailyScope.flagIdentity?FieldDailyScope.flagIdentity(flag):`${flag.reason||'note'}:${String(flag.description||'').toLowerCase()}`)}))}
  function flagById(id){return fieldScopeFlags.find(flag=>String(flag?.id)===String(id))}
  function findUnmatchedRow(flag){
    const rows=[...$$('.production-entry')];
    const id=String(flag?.id||'');
    const tagged=rows.find(row=>id&&row.dataset.unmatchedFlag===id);
    if(tagged)return tagged;
    const desc=String(flag?.description||'').trim().toLowerCase();
    return rows.find(row=>{
      if(lineEstimateId(row))return false;
      const text=(row.querySelector('.custom-description')?.value||row.dataset.suggestedDescription||'').trim().toLowerCase();
      return Boolean(text&&desc&&(text===desc||text.includes(desc)||desc.includes(text)));
    })||null;
  }
  function absorbMaterialFlags(){
    if(typeof FieldDailyScope==='undefined'||!FieldDailyScope.isMaterialPhrase)return;
    const phrases=[];
    fieldScopeFlags=fieldScopeFlags.filter(flag=>{
      if(!FieldDailyScope.isMaterialPhrase(flag?.description))return true;
      phrases.push(flag.description);
      return false;
    });
    if(!phrases.length)return;
    const materials=$('#report-materials');
    if(!materials)return;
    materials.value=FieldDailyScope.uniqueMaterials([materials.value,...phrases]);
    if(materials.value)materials.dataset.aiAccepted='true';
  }
  function placeUnmatchedLines(){
    absorbMaterialFlags();
    if(typeof addProductionRow!=='function')return;
    for(const flag of fieldScopeFlags){
      if(flag?.kind!=='pick'||flag.reason!=='no_match'||flag.decision)continue;
      const existing=findUnmatchedRow(flag);
      if(existing){existing.dataset.unmatchedFlag=String(flag.id||'');continue}
      const row=addProductionRow({custom:true,description:String(flag.description||'Unmatched work'),quantity:flag.quantity,unit:flag.unit||'',needsScopeConfirmation:false});
      if(!row)continue;
      row.dataset.unmatchedFlag=String(flag.id||'');
      row.dataset.aiFilled='true';
      const qty=row.querySelector('.production-quantity');
      if(qty&&flag.quantity!=null&&flag.quantity!=='')qty.value=String(flag.quantity);
      const unit=row.querySelector('.production-unit');
      if(unit&&flag.unit)unit.value=String(flag.unit).toUpperCase();
    }
  }
  function bindPickedLine(flag,item){
    const materials=$('#report-materials');
    const kept=materials?.value||'';
    const restore=()=>{if(materials&&String(kept).trim()&&!String(materials.value||'').trim())materials.value=kept};
    try{return bindPickedLineNow(flag,item)}finally{restore()}
  }
  function bindPickedLineNow(flag,item){
    placeUnmatchedLines();
    const source=findUnmatchedRow(flag);
    const add=source?Number(source.querySelector('.production-quantity')?.value)||Number(flag.quantity)||0:Number(flag.quantity)||0;
    const existing=[...$$('.production-entry')].find(row=>row!==source&&String(lineEstimateId(row))===String(item.id));
    if(existing){
      const input=existing.querySelector('.production-quantity');
      if(input)input.value=String((Number(input.value)||0)+add);
      const unit=existing.querySelector('.production-unit');
      if(unit&&item.unit)unit.value=item.unit;
      existing.dataset.aiFilled='true';
      if(source)source.remove();
      return existing;
    }
    if(!source)return null;
    const hours=source.querySelector('.production-hours')?.value||'';
    const manual=source.dataset.laborManual==='true';
    const minutes=source.dataset.laborMinutes;
    const created=addProductionRow({description:item.name,estimateItemId:item.id,quantity:add,unit:item.unit,laborHours:hours,laborManual:manual,laborMinutes:minutes==null||minutes===''?undefined:Number(minutes),needsScopeConfirmation:false});
    if(!created)return source;
    created.dataset.aiFilled='true';
    delete created.dataset.unmatchedFlag;
    source.replaceWith(created);
    return created;
  }
  function markLineExtra(flag){
    placeUnmatchedLines();
    let source=findUnmatchedRow(flag);
    if(!source&&typeof addProductionRow==='function')source=addProductionRow({custom:true,description:String(flag.description||'Extra work'),quantity:flag.quantity,unit:flag.unit||'',needsScopeConfirmation:false});
    if(!source)return null;
    if(source.querySelector('.production-item')&&typeof convertProductionRow==='function'){
      const converted=convertProductionRow(source,true);
      if(converted)source=converted;
    }
    source.dataset.extraWork='true';
    source.dataset.aiFilled='true';
    delete source.dataset.unmatchedFlag;
    delete source.dataset.estimateItemId;
    const desc=source.querySelector('.custom-description');
    if(desc&&!desc.value.trim())desc.value=String(flag.description||'Extra work');
    const qty=source.querySelector('.production-quantity');
    if(qty&&!(Number(qty.value)>0)&&flag.quantity!=null)qty.value=String(flag.quantity);
    const unit=source.querySelector('.production-unit');
    if(unit&&flag.unit&&!unit.value)unit.value=String(flag.unit).toUpperCase();
    return source;
  }
  function harvestFlagAnswers(){const host=$('#field-scope-flags');if(!host)return;host.querySelectorAll('[data-flag-asker]').forEach(input=>{const flag=flagById(input.dataset.flagAsker);if(flag)flag.who_asked=input.value})}
  const flagChoiceStamp=new Map();
  const flagChoiceHeld=new Map();
  function holdFlagChoice(flag){
    if(!flag?.id)return;
    if(!flag.decision){flagChoiceHeld.delete(String(flag.id));return}
    flagChoiceHeld.set(String(flag.id),{decision:flag.decision,extra_work:flag.extra_work===true,who_asked:String(flag.who_asked||''),at:Date.now()});
  }
  function restoreHeldChoices(){
    const now=Date.now();
    fieldScopeFlags=fieldScopeFlags.map(flag=>{
      const held=flagChoiceHeld.get(String(flag?.id||''));
      if(!held||now-held.at>=400||flag.decision)return flag;
      return {...flag,decision:held.decision,extra_work:held.decision==='extra',createsChange:false,who_asked:flag.who_asked||held.who_asked};
    });
  }
  function extraChoiceOpen(){return fieldScopeFlags.some(flag=>flag&&flag.reason==='stated_extra'&&!flag.decision)}
  function syncExtraSendGate(){
    const send=$('#save-report');
    if(!send||!fieldCompact())return;
    if(extraChoiceOpen()){send.disabled=true;send.dataset.extraGate='1';return}
    if(send.dataset.extraGate==='1'){send.disabled=false;delete send.dataset.extraGate}
  }
  function renderFlags(){
    absorbMaterialFlags();
    restoreHeldChoices();
    const host=$('#field-scope-flags');if(!host)return;
    fieldScopeFlags=stampFlags(fieldScopeFlags);
    const openFlags=fieldScopeFlags.filter(flag=>!(flag.kind==='pick'&&flag.decision));
    if(!fieldCompact()||!openFlags.length){host.hidden=true;host.innerHTML='';syncExtraSendGate();return}
    host.hidden=false;
    host.innerHTML=fieldScopeFlags.map((flag,index)=>{
      if(flag.kind==='pick'&&flag.decision)return '';
      const answered=Boolean(flag.decision);
      const label=flag.kind==='productivity'?'Productivity':flag.kind==='pick'?'Needs your pick':'Possible extra work';
      const items=projects?.[+$('#report-project')?.value]?.estimateItems||[];
      const picker=flag.kind==='pick'?`<label class="field-pick">Pick an estimate line<select data-flag-id="${escapeText(flag.id)}" data-flag-index="${index}" data-pick-line><option value="">Choose a line</option>${items.map(item=>`<option value="${escapeText(item.id)}">${escapeText(item.name)} · ${escapeText(item.unit||'')}</option>`).join('')}</select></label><button type="button" data-flag-id="${escapeText(flag.id)}" data-flag-index="${index}" data-flag-choice="extra">Extra work</button>`:'';
      const who=String(flag.who_asked||'');
      const actions=flag.kind==='productivity'
        ?`<button type="button" data-flag-id="${escapeText(flag.id)}" data-flag-index="${index}" data-flag-choice="noted">Noted</button>`
        :flag.kind==='pick'?picker
        :flag.reason==='stated_extra'
          ?`<div class="field-extra-ask"><span>Extra work?</span><button type="button" class="${flag.decision==='extra'?'is-selected':''}" data-flag-id="${escapeText(flag.id)}" data-flag-index="${index}" data-flag-choice="yes">Yes, extra</button><button type="button" class="${flag.decision==='not'?'is-selected':''}" data-flag-id="${escapeText(flag.id)}" data-flag-index="${index}" data-flag-choice="no">No, normal scope</button></div>${flag.decision?'':`<p class="field-flag-prompt" data-extra-prompt>Choose Yes or No before sending.</p>`}<label class="field-who-asked">Who asked?<input data-flag-asker="${escapeText(flag.id)}" maxlength="80" value="${escapeText(who)}" aria-label="Who asked?"></label>`
          :`<button type="button" class="${flag.decision==='extra'?'is-selected':''}" data-flag-id="${escapeText(flag.id)}" data-flag-index="${index}" data-flag-choice="extra">Extra work</button><button type="button" class="${flag.decision==='estimate'?'is-selected':''}" data-flag-id="${escapeText(flag.id)}" data-flag-index="${index}" data-flag-choice="estimate">Part of estimate</button>`;
      return `<article class="field-flag ${answered?'is-answered':''}" data-flag-kind="${escapeText(flag.kind)}"><small>${escapeText(label)}</small><strong>${escapeText(flag.description||'Field note')}</strong><p>${escapeText(flag.message||'')}</p>${actions}</article>`;
    }).join('');
    host.querySelectorAll('[data-flag-choice]').forEach(button=>button.onclick=()=>{
      const at=fieldScopeFlags.findIndex(row=>String(row.id)===String(button.dataset.flagId));
      const flag=at>=0?fieldScopeFlags[at]:fieldScopeFlags[Number(button.dataset.flagIndex)];
      if(!flag||typeof FieldDailyScope==='undefined')return;
      const stampKey=String(flag.id||button.dataset.flagIndex||'');
      const now=Date.now();
      if(now-(flagChoiceStamp.get(stampKey)||0)<400)return;
      flagChoiceStamp.set(stampKey,now);
      const choice=button.dataset.flagChoice;
      if(flag.kind==='pick'&&choice==='extra'){
        const next=FieldDailyScope.decideFlag(flag,'extra');
        fieldScopeFlags[at>=0?at:Number(button.dataset.flagIndex)]={...next,id:flag.id};
        holdFlagChoice(fieldScopeFlags[at>=0?at:Number(button.dataset.flagIndex)]);
        markLineExtra(flag);
        const send=$('#save-report');if(send)send.disabled=false;
        renderFlags();
        renderFieldReview();
        return;
      }
      const mapped=choice==='yes'||choice==='extra'||choice==='bill'?'extra':choice==='no'||choice==='not'?'not':choice;
      const asker=host.querySelector(`[data-flag-asker="${CSS.escape(String(flag.id))}"]`);
      const whoAsked=asker?asker.value:String(flag.who_asked||'');
      const same=flag.decision===mapped;
      const next=same?{...flag,decision:null,createsChange:false,extra_work:false,who_asked:whoAsked}:FieldDailyScope.decideFlag({...flag,who_asked:whoAsked},choice);
      fieldScopeFlags[at>=0?at:Number(button.dataset.flagIndex)]={...next,id:flag.id};
      holdFlagChoice(fieldScopeFlags[at>=0?at:Number(button.dataset.flagIndex)]);
      const send=$('#save-report');if(send&&next.decision)send.disabled=false;
      renderFlags();
      renderFieldReview();
    });
    host.querySelectorAll('[data-flag-asker]').forEach(input=>input.oninput=()=>{const at=fieldScopeFlags.findIndex(row=>String(row.id)===String(input.dataset.flagAsker));if(at>=0)fieldScopeFlags[at]={...fieldScopeFlags[at],who_asked:input.value}});
    syncExtraSendGate();
    host.querySelectorAll('[data-pick-line]').forEach(select=>select.onchange=()=>{
      const at=fieldScopeFlags.findIndex(row=>String(row.id)===String(select.dataset.flagId));
      const flag=at>=0?fieldScopeFlags[at]:fieldScopeFlags[Number(select.dataset.flagIndex)];
      const item=(projects?.[+$('#report-project')?.value]?.estimateItems||[]).find(entry=>String(entry.id)===String(select.value));
      if(!flag||!item||typeof FieldDailyScope==='undefined')return;
      const chosen=FieldDailyScope.decideFlag({...flag,estimateItemId:item.id},'estimate');
      chosen.estimateItemId=item.id;
      chosen.id=flag.id;
      fieldScopeFlags[at>=0?at:Number(select.dataset.flagIndex)]=chosen;
      bindPickedLine(flag,item);
      renderFlags();
      renderFieldReview();
    });
  }
  function renderFieldReview(){
    const host=$('#field-review-cards');if(!host||!fieldCompact()){if(host)host.hidden=true;return}
    syncEstimateBindings();
    dropEmptyLines();
    dropRawProductionRows();
    placeUnmatchedLines();
    applyPunchHours();
    applyLaborAllocation();
    const cards=[];
    const notesForLines=$('#field-notes')?.value||'';
    $$('.production-entry').forEach((row,index)=>{
      const select=row.querySelector('.production-item'),custom=row.querySelector('.custom-description');
      const name=(select?.selectedOptions?.[0]?.textContent||custom?.value||'').trim();
      const description=custom?.value||row.dataset.suggestedDescription||name;
      if(row.dataset.unmatchedFlag&&row.dataset.extraWork!=='true')return;
      if(row.dataset.extraWork!=='true'&&typeof FieldDailyScope!=='undefined'&&FieldDailyScope.rawNoteLine&&FieldDailyScope.rawNoteLine({description,quantity:row.querySelector('.production-quantity')?.value,estimateItemId:select?.value||null,extra_work:row.dataset.extraWork==='true'},notesForLines))return;
      if(!name||name==='Select estimate line')return;
      const qty=row.querySelector('.production-quantity')?.value,rawUnit=row.querySelector('.production-unit')?.value||'',unit=String(rawUnit).toLowerCase()==='x'?'':rawUnit;
      const ai=row.dataset.aiFilled==='true';
      if(!qty&&!ai)return;
      const lineMinutes=Number(row.dataset.laborMinutes);
      const lineHours=Number(row.querySelector('.production-hours')?.value)||0;
      const totalMinutes=Number(fieldLaborContext().total?.totalMinutes)||0;
      const showMinutes=Number.isFinite(lineMinutes)&&totalMinutes>0&&totalMinutes<60;
      const laborValue=showMinutes?String(lineMinutes):String(lineHours||'');
      const laborUnit=showMinutes?'min':'h';
      const lineId=row.dataset.estimateItemId||select?.value||'';
      const pairText=showMinutes?`${Number.isFinite(lineMinutes)?lineMinutes:0} min · ${lineHours.toFixed(2)} h`:`${lineHours.toFixed(2)} h`;
      cards.push(`<article class="field-review-card" data-edit-line="${index}"><small>${ai?'AI filled':'Tap to edit'}${row.dataset.laborManual==='true'?' · manual':''}</small><strong>${escapeText(name)}</strong><em>${escapeText(qty?`${qty} ${unit}`.trim():'Quantity needed')}</em><label class="field-line-labor">${showMinutes?'Minutes':'Hours'}<input data-review-labor="${index}" data-line-id="${escapeText(lineId)}" data-unit="${laborUnit}" inputmode="decimal" value="${escapeText(laborValue)}" aria-label="${showMinutes?'Minutes':'Hours'} for ${escapeText(name)}"><span class="field-time-pair">${escapeText(pairText)}</span></label></article>`);
    });
    $$('[data-labor-member]').forEach(input=>{
      if(!(Number(input.value)>0))return;
      const name=input.closest('.labor-line')?.querySelector('strong')?.textContent||'Crew';
      const source=input.dataset.timecardDerived==='true'?'From clock':input.dataset.noteDerived==='true'?'AI filled':'Entered';
      const crewMinutes=typeof FieldDailyScope!=='undefined'&&FieldDailyScope.minutesFromHours?FieldDailyScope.minutesFromHours(Number(input.value)||0):Math.round((Number(input.value)||0)*60);
      const shown=workTimeLabel(crewMinutes);
      cards.push(`<button type="button" class="field-review-card" data-edit-labor="${input.dataset.laborMember}"><small>${escapeText(source)}</small><strong>${escapeText(name)}</strong><em>${escapeText(shown)}</em></button>`);
    });
    for(const [id,label] of textFields){
      const field=$(id);if(!field?.value?.trim())continue;
      cards.push(`<button type="button" class="field-review-card" data-edit-field="${id.slice(1)}"><small>${field.dataset.aiAccepted==='true'?'AI filled':'Tap to edit'}</small><strong>${escapeText(label)}</strong><em>${escapeText(field.value.trim())}</em></button>`);
    }
    const nextValue=$('#report-next')?.value?.trim()||'';
    cards.push(`<label class="field-next-line"><small>Next</small><textarea id="field-review-next" maxlength="500" rows="2" aria-label="Next step" placeholder="What should happen next?">${escapeText(nextValue)}</textarea></label>`);
    const notes=$('#field-notes')?.value||'';
    const crewName=$('#report-crew')?.value;
    const crew=(typeof team==='undefined'?[]:team).filter(member=>!crewName||member.crew===crewName);
    const punched=punchMemberIds();
    const gaps=(typeof FieldDailyScope!=='undefined'&&FieldDailyScope.namedCrewGaps?FieldDailyScope.namedCrewGaps(notes,crew,punched):[]).filter(person=>!(Number($(`[data-labor-member="${person.id}"]`)?.value)>0));
    const hours=fieldHoursReview;
    const clocked=clockHoursPresent()||punched.length>0;
    if(gaps.length){
      const label=FieldDailyScope.noPunchLabel?FieldDailyScope.noPunchLabel():'No punch, enter hours';
      const fields=gaps.map(person=>{const current=$(`[data-labor-member="${person.id}"]`)?.value||'';const short=String(person.name||'').replace(/^DEMO\s+/i,'').trim().split(/\s+/)[0]||person.name||'Crew';return `<label>${escapeText(short)}<span>${escapeText(label)}</span><input data-gap-member="${person.id}" type="number" min="0" max="24" step="0.01" inputmode="decimal" value="${escapeText(current)}" placeholder="" aria-label="${escapeText(label)} for ${escapeText(person.name)}"></label>`}).join('');
      cards.unshift(`<article class="field-hours-card"><small>Hours</small><strong>${escapeText(label)}</strong>${fields}</article>`);
    }else if(hours?.ask&&!clocked){
      const kept=$('#field-hours-each')?.value||'';
      const who=hours.headcount?`${hours.headcount} people are in the notes. Enter the hours.`:'Enter the crew hours. Scheduled time is not used.';
      cards.unshift(`<article class="field-hours-card"><small>Hours</small><strong>Hours needed</strong><p>${escapeText(who)}</p><label>Hours each<input id="field-hours-each" type="number" min="0" max="24" step="0.5" inputmode="decimal" value="${escapeText(kept)}"></label></article>`);
    }
    const reviewTotal=Number(fieldLaborContext().total?.totalMinutes)||0;
    if(reviewTotal>0)cards.push(`<p class="field-labor-total">Total ${escapeText(workTimeLabel(reviewTotal))}</p>`);
    if(crewStillClockedIn())cards.unshift('<p class="field-clock-warning">The crew is still clocked in. Clock out before you send so the hours match the punch.</p>');
    host.hidden=false;
    host.innerHTML=cards.length?cards.join(''):'<p class="field-review-empty">AI did not fill any lines. Add the work on the cards below.</p>';
    const hourInput=$('#field-hours-each');
    if(hourInput)hourInput.oninput=()=>{applyAskedHours(hourInput.value,hours?.headcount);if(Number(hourInput.value)>0)renderFieldReview()};
    host.querySelectorAll('[data-gap-member]').forEach(input=>input.oninput=()=>{
      const labor=$(`[data-labor-member="${input.dataset.gapMember}"]`);
      if(labor){labor.value=input.value;labor.dataset.noteDerived='true';labor.dataset.manualHours='true'}
      applyLaborAllocation();
      if(Number(input.value)>0&&[...host.querySelectorAll('[data-gap-member]')].every(row=>Number(row.value)>0))renderFieldReview();
    });
    const nextInput=$('#field-review-next');
    const growNext=()=>{if(!nextInput)return;nextInput.style.height='auto';const border=Math.max(0,nextInput.offsetHeight-nextInput.clientHeight);nextInput.style.height=`${Math.max(48,nextInput.scrollHeight+border)}px`};
    if(nextInput)nextInput.oninput=()=>{const field=$('#report-next');if(field){field.value=nextInput.value;if(nextInput.value.trim())field.dataset.aiAccepted='true'}growNext()};
    growNext();
    requestAnimationFrame(growNext);
    const modal=$('#report-modal');
    modal?.classList.toggle('field-manual-entry',!fieldScopeFlags.length&&![...$$('.production-entry')].some(row=>row.dataset.aiFilled==='true'));
    host.querySelectorAll('[data-review-labor]').forEach(input=>input.oninput=()=>{
      const row=$$('.production-entry')[Number(input.dataset.reviewLabor)];
      if(!row)return;
      const raw=Number(input.value);
      const requested=input.dataset.unit==='min'?Math.max(0,Math.round(Number.isFinite(raw)?raw:0)):(typeof FieldDailyScope!=='undefined'&&FieldDailyScope.minutesFromHours?FieldDailyScope.minutesFromHours(raw):Math.max(0,Math.round((Number.isFinite(raw)?raw:0)*60)));
      const total=Math.max(0,Math.round(Number(fieldLaborContext().total?.totalMinutes)||0));
      let otherLocked=0;
      $$('.production-entry').forEach(otherRow=>{if(otherRow===row||otherRow.dataset.laborManual!=='true')return;otherLocked+=Math.max(0,Math.round(Number(otherRow.dataset.laborMinutes)||0))});
      const cap=Math.max(0,total-otherLocked);
      const minutes=Math.min(cap,requested);
      row.dataset.laborManual='true';
      row.dataset.laborMinutes=String(minutes);
      paintManualBadge(row);
      const hours=row.querySelector('.production-hours');
      if(hours)hours.value=typeof FieldDailyScope!=='undefined'&&FieldDailyScope.hoursFromMinutes?FieldDailyScope.hoursFromMinutes(minutes):minutes/60;
      const shown=input.dataset.unit==='min'?String(minutes):String(hours?.value||'');
      if(String(input.value)!==shown)input.value=shown;
      let note=input.parentElement?.querySelector('.field-clamp-note');
      if(minutes!==requested){if(!note&&input.parentElement){note=document.createElement('small');note.className='field-clamp-note';input.parentElement.append(note)}if(note)note.textContent=`Kept at ${minutes} min so the lines still equal the punch.`}
      else note?.remove();
      applyLaborAllocation();
      const pairLabel=(row,minutes)=>{
        const hours=Number(row?.querySelector('.production-hours')?.value)||0;
        const total=Number(fieldLaborContext().total?.totalMinutes)||0;
        return total>0&&total<60?`${minutes} min · ${hours.toFixed(2)} h`:`${hours.toFixed(2)} h`;
      };
      const pair=input.parentElement?.querySelector('.field-time-pair');
      if(pair)pair.textContent=pairLabel(row,minutes);
      host.querySelectorAll('[data-review-labor]').forEach(other=>{
        if(other===document.activeElement)return;
        const otherRow=$$('.production-entry')[Number(other.dataset.reviewLabor)];
        if(!otherRow)return;
        const otherMinutes=Number(otherRow.dataset.laborMinutes)||0;
        const otherTotal=Number(fieldLaborContext().total?.totalMinutes)||0;
        const otherMinutesMode=otherTotal>0&&otherTotal<60;
        other.dataset.unit=otherMinutesMode?'min':'h';
        other.value=otherMinutesMode?String(otherMinutes):String(otherRow.querySelector('.production-hours')?.value||'');
        const otherPair=other.parentElement?.querySelector('.field-time-pair');
        if(otherPair)otherPair.textContent=pairLabel(otherRow,otherMinutes);
      });
      const totalLine=host.querySelector('.field-labor-total');
      if(totalLine)totalLine.textContent=`Total ${workTimeLabel(Number(fieldLaborContext().total?.totalMinutes)||0)}`;
      scheduleLaborLockSave();
    });
    host.querySelectorAll('[data-edit-line]').forEach(card=>card.onclick=event=>{
      if(event.target.closest('input,label'))return;
      $$('.production-entry').forEach(row=>row.classList.remove('is-editing'));
      const row=$$('.production-entry')[Number(card.dataset.editLine)];
      if(!row)return;row.classList.add('is-editing');row.querySelector('input,select')?.focus();
    });
    host.querySelectorAll('[data-edit-labor]').forEach(button=>button.onclick=()=>{
      const input=$(`[data-labor-member="${button.dataset.editLabor}"]`);
      $('#report-modal')?.classList.add('field-manual-entry');
      input?.focus();
    });
    host.querySelectorAll('[data-edit-field]').forEach(button=>button.onclick=()=>{
      const field=$('#'+button.dataset.editField);if(!field)return;
      const more=$('#report-more');if(more&&field.closest('#report-more'))more.open=true;
      $('#report-modal')?.classList.add('field-manual-entry');
      field.focus();
    });
    bindLaborAllocation();
  }
  async function fillFieldReportFromNotes(){
    const keptLocks=lockedLaborMap();
    const button=$('#report-next-step'),note=$('#field-notes')?.value.trim()||'',language=$('#report-language')?.value||'en-US';
    if(button){button.disabled=true;button.textContent=language.startsWith('es')?'Leyendo notas…':'Reading notes…'}
    let failed=false;
    try{
      if(typeof refreshReportLaborFromTimeCards==='function'){try{await refreshReportLaborFromTimeCards()}catch{}}
      if(!note){failed=true;if(typeof notify==='function')notify(language.startsWith('es')?'Escriba las notas o complete las tarjetas.':'Add notes, or fill the cards yourself.');}
      else{
        const project=projects?.[+$('#report-project')?.value];
        const draft=await api('/api/ai/extract',{method:'POST',body:JSON.stringify({notes:note,language,projectId:project?.id})});
        applyScopeLines(draft?.scopeReview||{lines:[]});
        applyNarrative(draft||{});
        const scopeFacts=draft?.scopeReview;
        if(scopeFacts&&Object.hasOwn(scopeFacts,'next')){const next=$('#report-next');if(next){next.value=nextStepText(scopeFacts.next);if(next.value)next.dataset.aiAccepted='true';else delete next.dataset.aiAccepted}}
        if(scopeFacts&&Object.hasOwn(scopeFacts,'delays')){const delays=$('#report-delays');if(delays){const stated=String(scopeFacts.delays||'').trim();if(stated)delays.value=stated;else if(/^needs confirmation/i.test(delays.value||''))delays.value=''}}
        if(scopeFacts?.materials){const materials=$('#report-materials');if(materials&&typeof FieldDailyScope!=='undefined'&&FieldDailyScope.uniqueMaterials)materials.value=FieldDailyScope.uniqueMaterials([materials.value,scopeFacts.materials])}
        fieldHoursReview=draft?.scopeReview?.hours||null;
        applyPunchHours();
        if(!clockHoursPresent()&&fieldHoursReview?.total>0&&typeof applyNoteLaborEvidence==='function')applyNoteLaborEvidence(draft.laborEvidence?.total>0?draft.laborEvidence:{total:fieldHoursReview.total,headcount:fieldHoursReview.headcount,perPerson:fieldHoursReview.perPerson});
        else if(!clockHoursPresent()&&draft?.laborEvidence&&typeof applyNoteLaborEvidence==='function'&&!fieldHoursReview?.ask)applyNoteLaborEvidence(draft.laborEvidence);
        harvestFlagAnswers();
        fieldScopeFlags=stampFlags(typeof FieldDailyScope!=='undefined'&&FieldDailyScope.mergeScopeFlags?FieldDailyScope.mergeScopeFlags(fieldScopeFlags,draft?.scopeReview?.flags||[]):(draft?.scopeReview?.flags||[]).map(flag=>({...flag,decision:null,createsChange:false,who_asked:String(flag.who_asked||'')})));
        restoreHeldChoices();
        if(draft?.changesCreated)fieldScopeFlags=[];
      }
    }catch{
      failed=true;
      if(typeof notify==='function')notify(language.startsWith('es')?'La IA no pudo leer las notas. Complete las tarjetas.':'AI could not read the notes. Fill the cards yourself.');
    }finally{
      if(button){button.disabled=false;button.textContent=language.startsWith('es')?'Listo':'Done'}
      if(typeof showReportStep==='function')showReportStep(2);
      if(failed&&!$$('.production-entry').length&&typeof addProductionRow==='function')addProductionRow();
      dropRawProductionRows();
      applyLockedLabor(keptLocks);
      applyPunchHours();
      applyLaborAllocation();
      bindLaborAllocation();
      $('#report-modal')?.classList.toggle('field-manual-entry',failed&&!fieldScopeFlags.length&&![...$$('.production-entry')].some(row=>row.dataset.aiFilled==='true'));
      renderFlags();
      renderFieldReview();
      polishFieldDaily();
    }
  }
  const nextButton=$('#report-next-step');
  if(nextButton){
    const officeNext=nextButton.onclick;
    nextButton.onclick=()=>{if(!fieldCompact())return officeNext?.();return fillFieldReportFromNotes()};
  }
  const sendButton=$('#save-report');
  if(sendButton){
    const officeSend=sendButton.onclick;
    sendButton.onclick=event=>{
      if(fieldCompact()){
        restoreHeldChoices();
        applyPunchHours();
        applyLaborAllocation();
        const lines=[...$$('.production-entry')].filter(row=>row.dataset.aiFilled==='true').map(row=>({quantity:row.querySelector('.production-quantity')?.value,needsQuantity:!(Number(row.querySelector('.production-quantity')?.value)>0)}));
        const gate=typeof FieldDailyScope!=='undefined'&&FieldDailyScope.sendGate?FieldDailyScope.sendGate({flags:fieldScopeFlags,laborHours:enteredLaborHours(),openClock:crewStillClockedIn(),lines}):{block:fieldScopeFlags.some(flag=>!flag.decision)?['Answer each flag before sending this daily to the office.']:[],warn:[]};
        const message=[...gate.block,...(gate.block.length?[]:gate.warn)].join(' ');
        const extraOpen=fieldScopeFlags.some(flag=>flag&&flag.reason==='stated_extra'&&!flag.decision);
        if(extraOpen){event?.preventDefault();syncExtraSendGate();document.querySelector('[data-extra-prompt]')?.scrollIntoView({block:'center'});const status=$('#report-submit-status');if(status&&/Answer each flag before sending/i.test(status.textContent||'')){status.textContent='';status.className='report-submit-status'}return}
        if(gate.block.length){event?.preventDefault();if(typeof showReportMessage==='function')showReportMessage(message);($('#field-hours-each')||$('#field-scope-flags'))?.scrollIntoView({block:'center'});return}
        if(gate.warn.length&&typeof showReportMessage==='function')showReportMessage(gate.warn.join(' '),'warning');
      }
      return officeSend?.call(sendButton,event);
    };
  }
  if(typeof openReport==='function'){
    const openBefore=openReport;
    openReport=function(report=null,context={}){fieldScopeFlags=[];fieldHoursReview=null;const result=openBefore(report,context);if(fieldCompact()){const saved=(report?.productionEntries||[]).some(row=>row&&((row.estimateItemId!=null&&String(row.estimateItemId)!=='')||Number(row.quantity)>0));if(report?.workSuggestions?.length&&!saved&&$('#production-rows'))$('#production-rows').innerHTML='';const draft=typeof readOfflineDraft==='function'&&typeof offlineReportDraftKey==='function'?readOfflineDraft(offlineReportDraftKey()):null;if(Array.isArray(report?.scopeFlags)&&report.scopeFlags.length)fieldScopeFlags=stampFlags(report.scopeFlags);else if(Array.isArray(draft?.scopeFlags)&&String(draft.notes||'').trim()&&String(draft.notes||'').trim()===String($('#field-notes')?.value||'').trim())fieldScopeFlags=stampFlags(draft.scopeFlags)}dropEmptyLines();dropRawProductionRows();bindLaborAllocation();polishFieldDaily();renderFlags();if(report?.id&&!(typeof restoringActiveReport!=='undefined'&&restoringActiveReport)&&typeof clearRestoreBanner==='function')clearRestoreBanner();if(fieldCompact()&&$('#report-form')?.getAttribute('data-current-step')==='2')renderFieldReview();return result};
  }
  if(typeof showReportStep==='function'){
    const stepBefore=showReportStep;
    showReportStep=function(step){const result=stepBefore(step);if(Number(step)===2&&fieldCompact()){renderFlags();renderFieldReview()}polishFieldDaily();return result};
  }
  let laborTickAt=0;
  function beginFieldLaborTick(){if(!(laborTickAt&&Date.now()-laborTickAt<250))laborTickAt=Date.now();return laborTickAt}
  function laborNow(){return laborTickAt&&Date.now()-laborTickAt<1000?laborTickAt:Date.now()}
  window.beginFieldLaborTick=beginFieldLaborTick;
  window.fieldLaborNow=laborNow;
  function workTimeLabel(minutes){if(typeof FieldDailyScope!=='undefined'&&FieldDailyScope.formatWorkTime)return FieldDailyScope.formatWorkTime(minutes);const whole=Math.max(0,Math.round(Number(minutes)||0));const hours=(Math.round(whole/60*100)/100).toFixed(2);return whole<60?`${whole} min · ${hours} h`:`${hours} h`}
  function punchRows(){
    const projectId=projects?.[+$('#report-project')?.value]?.id,date=$('#report-date')?.value;
    const cards=(typeof timeCards==='undefined'?[]:timeCards).filter(card=>card&&!card.deletedAt&&card.inAt&&Number(card.projectId)===Number(projectId)&&String(card.date||'')===String(date||''));
    const totals=new Map();
    const now=laborNow();
    for(const card of cards){
      const end=card.outAt?new Date(card.outAt):new Date(now);
      const minutes=typeof FieldDailyScope!=='undefined'&&FieldDailyScope.elapsedMinutes?FieldDailyScope.elapsedMinutes(card.inAt,end):Math.max(0,Math.floor((end-new Date(card.inAt))/60000));
      totals.set(Number(card.memberId),(totals.get(Number(card.memberId))||0)+minutes);
    }
    return [...totals].filter(([,minutes])=>minutes>0).map(([memberId,minutes])=>({memberId,minutes}));
  }
  function punchMemberIds(){return punchRows().map(row=>row.memberId)}
  function fieldLaborContext(){
    const punches=punchRows(),punched=new Set(punches.map(row=>Number(row.memberId)));
    const entered=[...$$('[data-labor-member]')].filter(input=>!punched.has(Number(input.dataset.laborMember))&&Number(input.value)>0).map(input=>({memberId:Number(input.dataset.laborMember),hours:Number(input.value)||0}));
    const notes=$('#field-notes')?.value||'',crewName=$('#report-crew')?.value,crew=(typeof team==='undefined'?[]:team).filter(member=>!crewName||member.crew===crewName);
    const gaps=(typeof FieldDailyScope!=='undefined'&&FieldDailyScope.namedCrewGaps?FieldDailyScope.namedCrewGaps(notes,crew,punched):[]).filter(person=>!(Number($(`[data-labor-member="${person.id}"]`)?.value)>0)).map(person=>({memberId:Number(person.id),name:person.name||''}));
    const total=typeof FieldDailyScope!=='undefined'&&FieldDailyScope.laborTotal?FieldDailyScope.laborTotal({punches,entered}):{entries:[],total:enteredLaborHours()};
    return {punches,entered,gaps,total};
  }
  function syncEstimateBindings(){
    $$('.production-entry').forEach(row=>{
      if(typeof rowEstimateItemId==='function'){rowEstimateItemId(row);return}
      const select=row.querySelector('.production-item');
      if(!select)return;
      let id=String(row.dataset.estimateItemId||select.value||'');
      if(!id||id.startsWith('custom:')){
        const label=String(select.selectedOptions?.[0]?.textContent||'').trim().toLowerCase();
        const named=label&&label!=='select estimate line'?(projects?.[+$('#report-project')?.value]?.estimateItems||[]).find(item=>String(item.name||'').trim().toLowerCase()===label):null;
        id=named?String(named.id):'';
      }
      if(id&&[...select.options].some(option=>String(option.value)===id))select.value=id;
      row.dataset.estimateItemId=id.startsWith('custom:')?'':id;
    });
  }
  function dropEmptyLines(){
    if(typeof dropEmptyProductionRows==='function'){dropEmptyProductionRows();return}
    $$('.production-entry').forEach(row=>{
      const id=row.dataset.estimateItemId||row.querySelector('.production-item')?.value||'';
      const custom=row.querySelector('.custom-description')?.value.trim();
      const qty=Number(row.querySelector('.production-quantity')?.value)>0;
      if(!id&&!custom&&!qty)row.remove();
    });
  }
  function ensureFieldClockOut(){
    if(!fieldCompact())return;
    const modal=$('#report-modal');if(!modal)return;
    let button=$('#field-clock-out');
    if(!button){button=document.createElement('button');button.type='button';button.id='field-clock-out';button.className='secondary';modal.append(button)}
    else if(button.parentElement!==modal)modal.append(button);
    const memberId=Number(currentUser?.memberId);
    const active=(typeof workdays==='undefined'?[]:workdays).find(row=>row&&row.status==='active'&&(row.memberIds||[]).map(Number).includes(memberId));
    button.hidden=!active;
    button.textContent=preferredLanguage==='es'?'Registrar salida':'Clock out';
    button.onclick=async()=>{
      if(!active||typeof openEndDay!=='function')return;
      harvestFlagAnswers();
      if(typeof rememberActiveReport==='function')rememberActiveReport();
      if($('#report-modal')?.open&&$('#field-notes')?.value.trim()&&typeof saveDailyReport==='function'){
        const current=(typeof reports!=='undefined'?reports:[]).find(row=>Number(row.id)===Number(typeof editingReportId!=='undefined'?editingReportId:0));
        const status=current?.status&&current.status!=='Draft'?current.status:'Draft';
        try{const saved=await saveDailyReport(status,{keepOpen:true});if(!saved?.id)return}catch(error){if(typeof notify==='function')notify(error.message||'The daily could not be saved.');return}
      }
      openEndDay(active.id);
    };
  }
  function dropRawProductionRows(){
    if(typeof FieldDailyScope==='undefined'||!FieldDailyScope.rawNoteLine)return;
    const notes=$('#field-notes')?.value||'';
    $$('.production-entry').forEach(row=>{
      const select=row.querySelector('.production-item'),custom=row.querySelector('.custom-description');
      const description=custom?.value||row.dataset.suggestedDescription||'';
      const id=(typeof rowEstimateItemId==='function'?rowEstimateItemId(row):'')||row.dataset.estimateItemId||select?.value||'';
      if(row.dataset.unmatchedFlag||row.dataset.extraWork==='true')return;
      if(FieldDailyScope.rawNoteLine({description,quantity:row.querySelector('.production-quantity')?.value,estimateItemId:id||null,extra_work:row.dataset.extraWork==='true'},notes))row.remove();
    });
  }
  function applyLaborAllocation(){
    if(typeof FieldDailyScope==='undefined'||!FieldDailyScope.allocateLaborHours)return null;
    syncEstimateBindings();
    dropEmptyLines();
    const total=fieldLaborContext().total.total;
    const items=projects?.[+$('#report-project')?.value]?.estimateItems||[];
    const lines=[...$$('.production-entry')].map(row=>{
      const id=(typeof rowEstimateItemId==='function'?rowEstimateItemId(row):'')||row.dataset.estimateItemId||row.querySelector('.production-item')?.value,item=items.find(entry=>String(entry.id)===String(id));
      const planned=Number(item?.plannedQuantity)||0,budget=Number(item?.budgetHours)||0;
      return {row,quantity:Number(row.querySelector('.production-quantity')?.value)||0,unitRate:planned>0&&budget>0?budget/planned:0,manual:row.dataset.laborManual==='true',hours:Number(row.querySelector('.production-hours')?.value)||0,minutes:row.dataset.laborMinutes==null||row.dataset.laborMinutes===''?undefined:Number(row.dataset.laborMinutes)};
    });
    const result=FieldDailyScope.allocateLaborHours({total,totalMinutes:fieldLaborContext().total?.totalMinutes,lines});
    for(const line of result.lines){const input=line.row.querySelector('.production-hours');if(input)input.value=line.hours;line.row.dataset.laborMinutes=String(line.minutes)}
    let warn=$('#labor-allocation-warning');
    if(!warn){warn=document.createElement('p');warn.id='labor-allocation-warning';warn.className='field-allocation-warning';warn.hidden=true;$('#field-review-cards')?.before(warn)}
    warn.hidden=!result.warning;warn.textContent=result.warning||'';
    return result;
  }
  function bindLaborAllocation(){
    $$('.production-hours').forEach(input=>{
      if(input.dataset.allocationBound==='true')return;
      input.dataset.allocationBound='true';
      input.addEventListener('input',()=>{const row=input.closest('.production-entry');if(row){row.dataset.laborManual='true';paintManualBadge(row)}applyLaborAllocation();scheduleLaborLockSave();if(fieldCompact())renderFieldReview()});
    });
    $$('.production-quantity').forEach(input=>{
      if(input.dataset.allocationBound==='true')return;
      input.dataset.allocationBound='true';
      input.addEventListener('input',()=>{applyLaborAllocation();if(fieldCompact())renderFieldReview()});
    });
    $$('[data-labor-member]').forEach(input=>{
      if(input.dataset.totalBound==='true')return;
      input.dataset.totalBound='true';
      input.addEventListener('input',()=>applyLaborAllocation());
    });
  }
  let liveLaborDepth=0;
  function applyLiveLabor(){
    if(liveLaborDepth)return null;
    const activeEl=document.activeElement;
    if(activeEl&&$('#report-modal')?.contains(activeEl)&&activeEl.matches?.('input,textarea,select'))return null;
    beginFieldLaborTick();
    if(typeof renderFieldClock==='function')renderFieldClock();
    liveLaborDepth++;
    try{
      syncEstimateBindings();
      dropEmptyLines();
      applyPunchHours();
      const result=applyLaborAllocation();
      if($('#report-modal')?.open&&fieldCompact())renderFieldReview();
      if($('#report-modal')?.open&&typeof rememberActiveReport==='function')rememberActiveReport();
      ensureFieldClockOut();
      return result;
    }finally{liveLaborDepth--}
  }
  window.applyLiveLabor=applyLiveLabor;
  window.fieldLaborContext=fieldLaborContext;
  function applyPunchHours(){
    const totals=new Map(punchRows().map(row=>[row.memberId,row.minutes]));
    for(const [memberId,minutes] of totals){if(!(minutes>0))continue;const input=$(`[data-labor-member="${memberId}"]`);if(!input||input.dataset.manualHours==='true')continue;input.value=typeof FieldDailyScope!=='undefined'&&FieldDailyScope.hoursFromMinutes?FieldDailyScope.hoursFromMinutes(minutes):Math.round(minutes/60*100)/100;input.dataset.timecardDerived='true'}
  }
  function presentReportSent({totalHours,unplanned,productionEntries}={}){
    const flags=typeof fieldScopeFlags==='undefined'?[]:fieldScopeFlags;
    const hours=Number(totalHours)||0,produced=(productionEntries||[]).some(row=>Number(row.quantity)>0),confirmed=flags.filter(flag=>flag&&flag.decision==='extra'&&flag.createsChange).length,extras=flags.filter(flag=>flag&&flag.decision==='extra'&&flag.extra_work&&!flag.createsChange).length,changes=(Number(unplanned)||0)+confirmed,missing=[];
    if(!produced)missing.push('production quantities');
    if(!(hours>0))missing.push('labor hours');
    const title=$('#report-sent-modal h2'),summary=$('#report-sent-summary');
    const parts=[];
    if(changes)parts.push(`${changes} potential change${changes===1?'':'s'} flagged`);
    if(extras)parts.push(`${extras} extra work item${extras===1?'':'s'} flagged for the office`);
    const changeText=parts.length?parts.join(' · '):'No potential changes were confirmed';
    if(missing.length){if(title)title.textContent='Sent to the office with gaps';if(summary)summary.textContent=`Missing: ${missing.join(' and ')}. ${changeText}.`}
    else{const hourLabel=typeof FieldDailyScope!=='undefined'&&FieldDailyScope.formatHours?FieldDailyScope.formatHours(hours):`${hours.toFixed(2)} h`;if(title)title.textContent='The office has it.';if(summary)summary.textContent=`${hourLabel} logged · ${changeText}.`}
  }
  window.presentReportSent=presentReportSent;
  window.renderFieldReview=renderFieldReview;
  if(typeof suggestReportHourSplit==='function'){const officeSplit=suggestReportHourSplit;suggestReportHourSplit=function(options){if(fieldCompact()){applyLiveLabor();if(typeof updateReportGaps==='function')updateReportGaps();return true}return officeSplit(options)}}
  if(typeof saveDailyReport==='function'){const saveBefore=saveDailyReport;saveDailyReport=async function(status,saveOptions){harvestFlagAnswers();syncEstimateBindings();dropEmptyLines();if(fieldCompact())applyLaborAllocation();return saveBefore(status,saveOptions)}}
  if(typeof confirmReportDiscard==='function'){const officeConfirm=confirmReportDiscard;confirmReportDiscard=function(){if(typeof currentRole!=='undefined'&&currentRole==='field')return true;return officeConfirm()}}
  function fieldSameDayReport(projectId,dateIso){
    if(typeof currentRole==='undefined'||currentRole!=='field'||typeof FieldDailyScope==='undefined'||!FieldDailyScope.sameDayDaily)return null;
    const projectIndex=(typeof projects==='undefined'?[]:projects).findIndex(project=>Number(project.id)===Number(projectId));
    if(projectIndex<0)return null;
    const memberId=Number(currentUser?.memberId);
    return FieldDailyScope.sameDayDaily(typeof reports==='undefined'?[]:reports,{projectIndex,dateIso:dateIso||(typeof companyTodayIso==='function'?companyTodayIso():''),memberIds:[memberId],foreman:currentUser?.name||''});
  }
  $$('[data-open-report]').forEach(button=>{
    const previous=button.onclick;
    button.onclick=event=>{
      if(typeof currentRole!=='undefined'&&currentRole==='field'){
        const memberId=Number(currentUser?.memberId),today=typeof companyTodayIso==='function'?companyTodayIso():'';
        const active=(typeof workdays==='undefined'?[]:workdays).find(row=>row&&row.status==='active'&&(row.memberIds||[]).map(Number).includes(memberId));
        const assignment=(typeof assignments==='undefined'?[]:assignments).find(row=>row&&row.date===today&&(row.memberIds||[]).map(Number).includes(memberId));
        const existing=fieldSameDayReport(active?.projectId||assignment?.projectId,today);
        if(existing){event?.preventDefault();event?.stopPropagation();openReport(existing);return}
      }
      return previous?.call(button,event);
    };
  });
  if(typeof openDailyForAssignment==='function'){
    const previousOpenDaily=openDailyForAssignment;
    openDailyForAssignment=function(assignment){
      if(!$('#report-modal')?.open){const existing=fieldSameDayReport(assignment?.projectId,assignment?.date);if(existing){openReport(existing);return}}
      return previousOpenDaily(assignment);
    };
  }
  polishFieldDaily();
})();
