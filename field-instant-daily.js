var fieldScopeFlags=[];
(function(){
  if(typeof document==='undefined'||typeof $!=='function')return;
  const textFields=[['#report-summary','Summary'],['#report-materials','Materials'],['#report-equipment','Equipment'],['#report-delays','Delays'],['#report-safety','Safety']];
  function fieldCompact(){return typeof currentRole!=='undefined'&&currentRole==='field'&&$('#report-type')?.value!=='superintendent'}
  function escapeText(value){return typeof escapeHtml==='function'?escapeHtml(value):String(value??'')}
  function polishFieldDaily(){
    const compact=fieldCompact(),next=$('#report-next-step'),send=$('#save-report'),modal=$('#report-modal');
    if(next&&compact)next.textContent=preferredLanguage==='es'?'Listo':'Done';
    if(send&&compact&&!editingReportId)send.textContent=preferredLanguage==='es'?'Enviar a la oficina':'Send to office';
    modal?.classList.toggle('field-manual-entry',compact&&!fieldScopeFlags.length&&![...$$('.production-entry')].some(row=>row.dataset.aiFilled==='true'));
    if(!compact){const flags=$('#field-scope-flags'),cards=$('#field-review-cards');if(flags)flags.hidden=true;if(cards)cards.hidden=true}
  }
  function groundedText(value){const text=String(value||'').trim();return text&&!/^needs confirmation[.!\s]*$/i.test(text)?text:''}
  function clearAiRows(){$$('.production-entry').forEach(row=>{if(row.dataset.aiFilled==='true')row.remove()})}
  function applyScopeLines(review){
    clearAiRows();
    const lines=review?.lines||[];
    for(const line of lines){
      const row=addProductionRow({description:line.description,estimateItemId:line.estimateItemId,quantity:line.quantity,unit:line.unit,laborHours:line.laborHours||'',needsScopeConfirmation:false});
      if(!row)continue;
      row.dataset.aiFilled='true';
      row.classList.add('ai-filled-line');
      const quantity=row.querySelector('.production-quantity');
      if(quantity&&line.quantity!=null)quantity.value=line.quantity;
      const unit=row.querySelector('.production-unit');
      const safeUnit=line.unit&&String(line.unit).toLowerCase()!=='x'?line.unit:'';
      if(unit&&safeUnit)unit.value=safeUnit;
    }
  }
  function applyNarrative(draft){
    const notes=$('#field-notes')?.value||'';
    const values={
      '#report-summary':groundedText(draft.summary),
      '#report-materials':groundedText(draft.materials),
      '#report-equipment':groundedText(draft.equipment),
      '#report-delays':groundedText(draft.delays||draft.issue),
      '#report-safety':groundedText(draft.safety)||(draft.noSafetyObservations&&/no safety|no incidents/i.test(notes)?'No safety incidents.':''),
      '#report-next':groundedText(draft.next)
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
  function renderFlags(){
    const host=$('#field-scope-flags');if(!host)return;
    if(!fieldCompact()||!fieldScopeFlags.length){host.hidden=true;host.innerHTML='';return}
    host.hidden=false;
    host.innerHTML=fieldScopeFlags.map((flag,index)=>{
      const answered=Boolean(flag.decision);
      const label=flag.kind==='productivity'?'Productivity':flag.kind==='pick'?'Needs your pick':'Possible extra work';
      const items=projects?.[+$('#report-project')?.value]?.estimateItems||[];
      const picker=flag.kind==='pick'?`<label class="field-pick">Pick an estimate line<select data-flag-index="${index}" data-pick-line><option value="">Choose a line</option>${items.map(item=>`<option value="${escapeText(item.id)}">${escapeText(item.name)} · ${escapeText(item.unit||'')}</option>`).join('')}</select></label><button type="button" data-flag-index="${index}" data-flag-choice="extra">Extra work</button>`:'';
      const who=String(flag.who_asked||'');
      const actions=flag.kind==='productivity'
        ?`<button type="button" data-flag-index="${index}" data-flag-choice="noted">Noted</button>`
        :flag.kind==='pick'?picker
        :flag.reason==='stated_extra'
          ?`<div class="field-extra-ask"><span>Extra work?</span><button type="button" class="${flag.decision==='extra'?'is-selected':''}" data-flag-index="${index}" data-flag-choice="yes">Yes, extra</button><button type="button" class="${flag.decision==='not'?'is-selected':''}" data-flag-index="${index}" data-flag-choice="no">No, normal scope</button></div><label class="field-who-asked">Who asked?<input data-flag-asker="${index}" maxlength="80" value="${escapeText(who)}" aria-label="Who asked?"></label>`
          :`<button type="button" class="${flag.decision==='extra'?'is-selected':''}" data-flag-index="${index}" data-flag-choice="extra">Extra work</button><button type="button" class="${flag.decision==='estimate'?'is-selected':''}" data-flag-index="${index}" data-flag-choice="estimate">Part of estimate</button>`;
      return `<article class="field-flag ${answered?'is-answered':''}" data-flag-kind="${escapeText(flag.kind)}"><small>${escapeText(label)}</small><strong>${escapeText(flag.description||'Field note')}</strong><p>${escapeText(flag.message||'')}</p>${actions}</article>`;
    }).join('');
    host.querySelectorAll('[data-flag-choice]').forEach(button=>button.onclick=()=>{
      const flag=fieldScopeFlags[Number(button.dataset.flagIndex)];
      if(!flag||typeof FieldDailyScope==='undefined')return;
      const choice=button.dataset.flagChoice;
      const mapped=choice==='yes'||choice==='extra'||choice==='bill'?'extra':choice==='no'||choice==='not'?'not':choice;
      const asker=host.querySelector(`[data-flag-asker="${button.dataset.flagIndex}"]`);
      const whoAsked=asker?asker.value:String(flag.who_asked||'');
      const same=flag.decision===mapped;
      fieldScopeFlags[Number(button.dataset.flagIndex)]=same?{...flag,decision:null,createsChange:false,extra_work:false,who_asked:whoAsked}:FieldDailyScope.decideFlag({...flag,who_asked:whoAsked},choice);
      renderFlags();
      renderFieldReview();
    });
    host.querySelectorAll('[data-flag-asker]').forEach(input=>input.oninput=()=>{const flag=fieldScopeFlags[Number(input.dataset.flagAsker)];if(flag)fieldScopeFlags[Number(input.dataset.flagAsker)]={...flag,who_asked:input.value}});
    host.querySelectorAll('[data-pick-line]').forEach(select=>select.onchange=()=>{
      const flag=fieldScopeFlags[Number(select.dataset.flagIndex)];
      const item=(projects?.[+$('#report-project')?.value]?.estimateItems||[]).find(entry=>String(entry.id)===String(select.value));
      if(!flag||!item||typeof FieldDailyScope==='undefined'||typeof addProductionRow!=='function')return;
      const chosen=FieldDailyScope.decideFlag({...flag,estimateItemId:item.id},'estimate');
      chosen.estimateItemId=item.id;
      fieldScopeFlags[Number(select.dataset.flagIndex)]=chosen;
      const row=addProductionRow({description:item.name,estimateItemId:item.id,quantity:flag.quantity,unit:item.unit,needsScopeConfirmation:false});
      if(row){row.dataset.aiFilled='true';const quantity=row.querySelector('.production-quantity');if(quantity&&flag.quantity!=null)quantity.value=flag.quantity;const unit=row.querySelector('.production-unit');if(unit)unit.value=item.unit||''}
      renderFlags();
      renderFieldReview();
    });
  }
  function renderFieldReview(){
    const host=$('#field-review-cards');if(!host||!fieldCompact()){if(host)host.hidden=true;return}
    dropRawProductionRows();
    applyLaborAllocation();
    const cards=[];
    const notesForLines=$('#field-notes')?.value||'';
    $$('.production-entry').forEach((row,index)=>{
      const select=row.querySelector('.production-item'),custom=row.querySelector('.custom-description');
      const name=(select?.selectedOptions?.[0]?.textContent||custom?.value||'').trim();
      const description=custom?.value||row.dataset.suggestedDescription||name;
      if(typeof FieldDailyScope!=='undefined'&&FieldDailyScope.rawNoteLine&&FieldDailyScope.rawNoteLine({description,quantity:row.querySelector('.production-quantity')?.value,estimateItemId:select?.value||null},notesForLines))return;
      if(!name||name==='Select estimate line')return;
      const qty=row.querySelector('.production-quantity')?.value,rawUnit=row.querySelector('.production-unit')?.value||'',unit=String(rawUnit).toLowerCase()==='x'?'':rawUnit;
      const ai=row.dataset.aiFilled==='true';
      if(!qty&&!ai)return;
      const lineHours=Number(row.querySelector('.production-hours')?.value)||0;
      const hourLabel=lineHours>0&&typeof FieldDailyScope!=='undefined'&&FieldDailyScope.formatHours?` · ${FieldDailyScope.formatHours(lineHours)}`:'';
      cards.push(`<button type="button" class="field-review-card" data-edit-line="${index}"><small>${ai?'AI filled':'Tap to edit'}${row.dataset.laborManual==='true'?' · manual':''}</small><strong>${escapeText(name)}</strong><em>${escapeText(qty?`${qty} ${unit}`.trim():'Quantity needed')}${escapeText(hourLabel)}</em></button>`);
    });
    $$('[data-labor-member]').forEach(input=>{
      if(!(Number(input.value)>0))return;
      const name=input.closest('.labor-line')?.querySelector('strong')?.textContent||'Crew';
      const source=input.dataset.timecardDerived==='true'?'From clock':input.dataset.noteDerived==='true'?'AI filled':'Entered';
      const shown=typeof FieldDailyScope!=='undefined'&&FieldDailyScope.formatHours?FieldDailyScope.formatHours(Number(input.value)||0):`${input.value} hours`;
      cards.push(`<button type="button" class="field-review-card" data-edit-labor="${input.dataset.laborMember}"><small>${escapeText(source)}</small><strong>${escapeText(name)}</strong><em>${escapeText(shown)}</em></button>`);
    });
    for(const [id,label] of textFields){
      const field=$(id);if(!field?.value?.trim())continue;
      cards.push(`<button type="button" class="field-review-card" data-edit-field="${id.slice(1)}"><small>${field.dataset.aiAccepted==='true'?'AI filled':'Tap to edit'}</small><strong>${escapeText(label)}</strong><em>${escapeText(field.value.trim())}</em></button>`);
    }
    const nextValue=$('#report-next')?.value?.trim()||'';
    if(nextValue)cards.push(`<label class="field-next-line"><small>Next</small><input id="field-review-next" maxlength="500" value="${escapeText(nextValue)}" aria-label="Next step"></label>`);
    const notes=$('#field-notes')?.value||'';
    const crewName=$('#report-crew')?.value;
    const crew=(typeof team==='undefined'?[]:team).filter(member=>!crewName||member.crew===crewName);
    const punched=punchMemberIds();
    const gaps=typeof FieldDailyScope!=='undefined'&&FieldDailyScope.namedCrewGaps?FieldDailyScope.namedCrewGaps(notes,crew,punched):[];
    const hours=fieldHoursReview;
    const clocked=clockHoursPresent()||punched.length>0;
    if(gaps.length){
      const label=FieldDailyScope.noPunchLabel?FieldDailyScope.noPunchLabel():'No punch, enter hours';
      const fields=gaps.map(person=>{const current=$(`[data-labor-member="${person.id}"]`)?.value||'';return `<label>${escapeText(String(person.name||'').split(/\s+/)[0])}<span>${escapeText(label)}</span><input data-gap-member="${person.id}" type="number" min="0" max="24" step="0.01" inputmode="decimal" value="${escapeText(current)}" placeholder="" aria-label="${escapeText(label)} for ${escapeText(person.name)}"></label>`}).join('');
      cards.unshift(`<article class="field-hours-card"><small>Hours</small><strong>${escapeText(label)}</strong>${fields}</article>`);
    }else if(hours?.ask&&!clocked){
      const kept=$('#field-hours-each')?.value||'';
      const who=hours.headcount?`${hours.headcount} people are in the notes. Enter the hours.`:'Enter the crew hours. Scheduled time is not used.';
      cards.unshift(`<article class="field-hours-card"><small>Hours</small><strong>Hours needed</strong><p>${escapeText(who)}</p><label>Hours each<input id="field-hours-each" type="number" min="0" max="24" step="0.5" inputmode="decimal" value="${escapeText(kept)}"></label></article>`);
    }
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
    if(nextInput)nextInput.oninput=()=>{const field=$('#report-next');if(field){field.value=nextInput.value;if(nextInput.value.trim())field.dataset.aiAccepted='true'}};
    const modal=$('#report-modal');
    modal?.classList.toggle('field-manual-entry',!fieldScopeFlags.length&&![...$$('.production-entry')].some(row=>row.dataset.aiFilled==='true'));
    host.querySelectorAll('[data-edit-line]').forEach(button=>button.onclick=()=>{
      $$('.production-entry').forEach(row=>row.classList.remove('is-editing'));
      const row=$$('.production-entry')[Number(button.dataset.editLine)];
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
        if(scopeFacts&&Object.hasOwn(scopeFacts,'next')){const next=$('#report-next');if(next){next.value=String(scopeFacts.next||'').trim();if(next.value)next.dataset.aiAccepted='true';else delete next.dataset.aiAccepted}}
        if(scopeFacts&&Object.hasOwn(scopeFacts,'delays')){const delays=$('#report-delays');if(delays){const stated=String(scopeFacts.delays||'').trim();if(stated)delays.value=stated;else if(/^needs confirmation/i.test(delays.value||''))delays.value=''}}
        if(scopeFacts?.materials){const materials=$('#report-materials');if(materials&&!String(materials.value||'').includes(scopeFacts.materials))materials.value=[materials.value,scopeFacts.materials].filter(Boolean).join('\n')}
        fieldHoursReview=draft?.scopeReview?.hours||null;
        applyPunchHours();
        if(!clockHoursPresent()&&fieldHoursReview?.total>0&&typeof applyNoteLaborEvidence==='function')applyNoteLaborEvidence(draft.laborEvidence?.total>0?draft.laborEvidence:{total:fieldHoursReview.total,headcount:fieldHoursReview.headcount,perPerson:fieldHoursReview.perPerson});
        else if(!clockHoursPresent()&&draft?.laborEvidence&&typeof applyNoteLaborEvidence==='function'&&!fieldHoursReview?.ask)applyNoteLaborEvidence(draft.laborEvidence);
        fieldScopeFlags=typeof FieldDailyScope!=='undefined'&&FieldDailyScope.mergeScopeFlags?FieldDailyScope.mergeScopeFlags(fieldScopeFlags,draft?.scopeReview?.flags||[]):(draft?.scopeReview?.flags||[]).map(flag=>({...flag,decision:null,createsChange:false,who_asked:String(flag.who_asked||'')}));
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
        applyPunchHours();
        applyLaborAllocation();
        const lines=[...$$('.production-entry')].filter(row=>row.dataset.aiFilled==='true').map(row=>({quantity:row.querySelector('.production-quantity')?.value,needsQuantity:!(Number(row.querySelector('.production-quantity')?.value)>0)}));
        const gate=typeof FieldDailyScope!=='undefined'&&FieldDailyScope.sendGate?FieldDailyScope.sendGate({flags:fieldScopeFlags,laborHours:enteredLaborHours(),openClock:crewStillClockedIn(),lines}):{block:fieldScopeFlags.some(flag=>!flag.decision)?['Answer each flag before sending this daily to the office.']:[],warn:[]};
        const message=[...gate.block,...(gate.block.length?[]:gate.warn)].join(' ');
        if(gate.block.length){event?.preventDefault();if(typeof showReportMessage==='function')showReportMessage(message);($('#field-hours-each')||$('#field-scope-flags'))?.scrollIntoView({block:'center'});return}
        if(gate.warn.length&&typeof showReportMessage==='function')showReportMessage(gate.warn.join(' '),'warning');
      }
      return officeSend?.call(sendButton,event);
    };
  }
  if(typeof openReport==='function'){
    const openBefore=openReport;
    openReport=function(report=null,context={}){fieldScopeFlags=[];fieldHoursReview=null;const result=openBefore(report,context);dropRawProductionRows();bindLaborAllocation();polishFieldDaily();renderFlags();if(fieldCompact()&&$('#report-form')?.getAttribute('data-current-step')==='2')renderFieldReview();return result};
  }
  if(typeof showReportStep==='function'){
    const stepBefore=showReportStep;
    showReportStep=function(step){const result=stepBefore(step);if(Number(step)===2&&fieldCompact()){renderFlags();renderFieldReview()}polishFieldDaily();return result};
  }
  function punchRows(){
    const projectId=projects?.[+$('#report-project')?.value]?.id,date=$('#report-date')?.value;
    const cards=(typeof timeCards==='undefined'?[]:timeCards).filter(card=>card&&!card.deletedAt&&card.inAt&&Number(card.projectId)===Number(projectId)&&String(card.date||'')===String(date||''));
    const totals=new Map();
    for(const card of cards){
      const end=card.outAt?new Date(card.outAt):new Date();
      const minutes=typeof FieldDailyScope!=='undefined'&&FieldDailyScope.elapsedMinutes?FieldDailyScope.elapsedMinutes(card.inAt,end):Math.max(0,Math.round((end-new Date(card.inAt))/60000));
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
  function dropRawProductionRows(){
    if(typeof FieldDailyScope==='undefined'||!FieldDailyScope.rawNoteLine)return;
    const notes=$('#field-notes')?.value||'';
    $$('.production-entry').forEach(row=>{
      const select=row.querySelector('.production-item'),custom=row.querySelector('.custom-description');
      const description=custom?.value||row.dataset.suggestedDescription||'';
      if(FieldDailyScope.rawNoteLine({description,quantity:row.querySelector('.production-quantity')?.value,estimateItemId:select?.value||null},notes))row.remove();
    });
  }
  function applyLaborAllocation(){
    if(typeof FieldDailyScope==='undefined'||!FieldDailyScope.allocateLaborHours)return null;
    const total=fieldLaborContext().total.total;
    const items=projects?.[+$('#report-project')?.value]?.estimateItems||[];
    const lines=[...$$('.production-entry')].map(row=>{
      const id=row.querySelector('.production-item')?.value,item=items.find(entry=>String(entry.id)===String(id));
      const planned=Number(item?.plannedQuantity)||0,budget=Number(item?.budgetHours)||0;
      return {row,quantity:Number(row.querySelector('.production-quantity')?.value)||0,unitRate:planned>0&&budget>0?budget/planned:0,manual:row.dataset.laborManual==='true',hours:Number(row.querySelector('.production-hours')?.value)||0};
    });
    const result=FieldDailyScope.allocateLaborHours({total,lines});
    for(const line of result.lines){const input=line.row.querySelector('.production-hours');if(input)input.value=line.hours}
    let warn=$('#labor-allocation-warning');
    if(!warn){warn=document.createElement('p');warn.id='labor-allocation-warning';warn.className='field-allocation-warning';warn.hidden=true;$('#field-review-cards')?.before(warn)}
    warn.hidden=!result.warning;warn.textContent=result.warning||'';
    return result;
  }
  function bindLaborAllocation(){
    $$('.production-hours').forEach(input=>{
      if(input.dataset.allocationBound==='true')return;
      input.dataset.allocationBound='true';
      input.addEventListener('input',()=>{const row=input.closest('.production-entry');if(row)row.dataset.laborManual='true';applyLaborAllocation();if(fieldCompact())renderFieldReview()});
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
  window.fieldLaborContext=fieldLaborContext;
  function applyPunchHours(){
    const totals=new Map(punchRows().map(row=>[row.memberId,row.minutes]));
    for(const [memberId,minutes] of totals){if(!(minutes>0))continue;const input=$(`[data-labor-member="${memberId}"]`);if(!input||input.dataset.manualHours==='true')continue;input.value=typeof FieldDailyScope!=='undefined'&&FieldDailyScope.hoursFromMinutes?FieldDailyScope.hoursFromMinutes(minutes):Math.round(minutes/60*100)/100;input.dataset.timecardDerived='true'}
  }
  function presentReportSent({totalHours,unplanned,productionEntries}={}){
    const hours=Number(totalHours)||0,produced=(productionEntries||[]).some(row=>Number(row.quantity)>0),confirmed=(typeof fieldScopeFlags==='undefined'?[]:fieldScopeFlags).filter(flag=>flag&&flag.decision==='extra'&&flag.createsChange).length,changes=(Number(unplanned)||0)+confirmed,missing=[];
    if(!produced)missing.push('production quantities');
    if(!(hours>0))missing.push('labor hours');
    const title=$('#report-sent-modal h2'),summary=$('#report-sent-summary');
    const changeText=changes?`${changes} potential change${changes===1?'':'s'} flagged`:'No potential changes were confirmed';
    if(missing.length){if(title)title.textContent='Sent to the office with gaps';if(summary)summary.textContent=`Missing: ${missing.join(' and ')}. ${changeText}.`}
    else{const hourLabel=typeof FieldDailyScope!=='undefined'&&FieldDailyScope.formatHours?FieldDailyScope.formatHours(hours):`${hours.toFixed(2)} h`;if(title)title.textContent='The office has it.';if(summary)summary.textContent=`${hourLabel} logged · ${changeText}.`}
  }
  window.presentReportSent=presentReportSent;
  window.renderFieldReview=renderFieldReview;
  polishFieldDaily();
})();
