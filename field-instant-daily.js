var fieldScopeFlags=[];
(function(){
  if(typeof document==='undefined'||typeof $!=='function')return;
  const textFields=[['#report-summary','Summary'],['#report-materials','Materials'],['#report-equipment','Equipment'],['#report-delays','Delays'],['#report-safety','Safety'],['#report-next','Next']];
  function fieldCompact(){return typeof currentRole!=='undefined'&&currentRole==='field'&&$('#report-type')?.value!=='superintendent'}
  function escapeText(value){return typeof escapeHtml==='function'?escapeHtml(value):String(value??'')}
  function polishFieldDaily(){
    const compact=fieldCompact(),next=$('#report-next-step'),send=$('#save-report'),modal=$('#report-modal');
    if(next&&compact)next.textContent=preferredLanguage==='es'?'Listo':'Done';
    if(send&&compact&&!editingReportId)send.textContent=preferredLanguage==='es'?'Enviar a la oficina':'Send to office';
    modal?.classList.toggle('field-manual-entry',compact&&![...$$('.production-entry')].some(row=>row.dataset.aiFilled==='true'));
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
      if(unit&&line.unit)unit.value=line.unit;
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
  function clockHoursPresent(){return [...$$('[data-labor-member]')].some(input=>input.dataset.timecardDerived==='true'&&Number(input.value)>0)}
  function renderFlags(){
    const host=$('#field-scope-flags');if(!host)return;
    if(!fieldCompact()||!fieldScopeFlags.length){host.hidden=true;host.innerHTML='';return}
    host.hidden=false;
    host.innerHTML=fieldScopeFlags.map((flag,index)=>{
      const answered=Boolean(flag.decision);
      const label=flag.kind==='productivity'?'Productivity':'Possible extra work';
      const answer=flag.decision==='extra'?'Extra work':flag.decision==='estimate'?'Part of the estimate':flag.decision==='noted'?'Noted':'';
      const actions=flag.kind==='productivity'
        ?`<button type="button" data-flag-index="${index}" data-flag-choice="noted">Noted</button>`
        :`<button type="button" data-flag-index="${index}" data-flag-choice="extra">Extra work</button><button type="button" data-flag-index="${index}" data-flag-choice="estimate">Part of estimate</button>`;
      return `<article class="field-flag ${answered?'is-answered':''}" data-flag-kind="${escapeText(flag.kind)}"><small>${escapeText(label)}</small><strong>${escapeText(flag.description||'Field note')}</strong><p>${escapeText(flag.message||'')}</p>${answered?`<b>${escapeText(answer)}</b>`:actions}</article>`;
    }).join('');
    host.querySelectorAll('[data-flag-choice]').forEach(button=>button.onclick=()=>{
      const flag=fieldScopeFlags[Number(button.dataset.flagIndex)];
      if(!flag||typeof FieldDailyScope==='undefined')return;
      fieldScopeFlags[Number(button.dataset.flagIndex)]=FieldDailyScope.decideFlag(flag,button.dataset.flagChoice);
      renderFlags();
    });
  }
  function renderFieldReview(){
    const host=$('#field-review-cards');if(!host||!fieldCompact()){if(host)host.hidden=true;return}
    const cards=[];
    $$('.production-entry').forEach((row,index)=>{
      const select=row.querySelector('.production-item'),custom=row.querySelector('.custom-description');
      const name=(select?.selectedOptions?.[0]?.textContent||custom?.value||'Work line').trim();
      if(!name||name==='Select estimate line')return;
      const qty=row.querySelector('.production-quantity')?.value,unit=row.querySelector('.production-unit')?.value||'';
      const ai=row.dataset.aiFilled==='true';
      cards.push(`<button type="button" class="field-review-card" data-edit-line="${index}"><small>${ai?'AI filled':'Tap to edit'}</small><strong>${escapeText(name)}</strong><em>${escapeText(qty?`${qty} ${unit}`.trim():'Quantity')}</em></button>`);
    });
    $$('[data-labor-member]').forEach(input=>{
      if(!(Number(input.value)>0))return;
      const name=input.closest('.labor-line')?.querySelector('strong')?.textContent||'Crew';
      const source=input.dataset.timecardDerived==='true'?'From clock':input.dataset.noteDerived==='true'?'AI filled':'Entered';
      cards.push(`<button type="button" class="field-review-card" data-edit-labor="${input.dataset.laborMember}"><small>${escapeText(source)}</small><strong>${escapeText(name)}</strong><em>${escapeText(input.value)} hours</em></button>`);
    });
    for(const [id,label] of textFields){
      const field=$(id);if(!field?.value?.trim())continue;
      cards.push(`<button type="button" class="field-review-card" data-edit-field="${id.slice(1)}"><small>${field.dataset.aiAccepted==='true'?'AI filled':'Tap to edit'}</small><strong>${escapeText(label)}</strong><em>${escapeText(field.value.trim())}</em></button>`);
    }
    host.hidden=false;
    host.innerHTML=cards.length?cards.join(''):'<p class="field-review-empty">AI did not fill any lines. Add the work on the cards below.</p>';
    const modal=$('#report-modal');
    modal?.classList.toggle('field-manual-entry',![...$$('.production-entry')].some(row=>row.dataset.aiFilled==='true'));
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
        if(!clockHoursPresent()&&draft?.laborEvidence&&typeof applyNoteLaborEvidence==='function')applyNoteLaborEvidence(draft.laborEvidence);
        fieldScopeFlags=(draft?.scopeReview?.flags||[]).map(flag=>({...flag,decision:null,createsChange:false}));
        if(draft?.changesCreated)fieldScopeFlags=[];
      }
    }catch{
      failed=true;
      if(typeof notify==='function')notify(language.startsWith('es')?'La IA no pudo leer las notas. Complete las tarjetas.':'AI could not read the notes. Fill the cards yourself.');
    }finally{
      if(button){button.disabled=false;button.textContent=language.startsWith('es')?'Listo':'Done'}
      if(typeof showReportStep==='function')showReportStep(2);
      if(failed&&!$$('.production-entry').length&&typeof addProductionRow==='function')addProductionRow();
      if(typeof suggestReportHourSplit==='function'&&typeof reportLaborTotals==='function'&&reportLaborTotals().crew>0&&$$('.production-entry').length)suggestReportHourSplit({silent:true,source:clockHoursPresent()?'timecards':'notes'});
      $('#report-modal')?.classList.toggle('field-manual-entry',failed||![...$$('.production-entry')].some(row=>row.dataset.aiFilled==='true'));
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
        const pending=fieldScopeFlags.filter(flag=>!flag.decision);
        if(pending.length){event?.preventDefault();if(typeof showReportMessage==='function')showReportMessage('Answer each flag before sending this daily to the office.');$('#field-scope-flags')?.scrollIntoView({block:'center'});return}
      }
      return officeSend?.call(sendButton,event);
    };
  }
  if(typeof openReport==='function'){
    const openBefore=openReport;
    openReport=function(report=null,context={}){fieldScopeFlags=[];const result=openBefore(report,context);polishFieldDaily();renderFlags();if(fieldCompact()&&$('#report-form')?.getAttribute('data-current-step')==='2')renderFieldReview();return result};
  }
  if(typeof showReportStep==='function'){
    const stepBefore=showReportStep;
    showReportStep=function(step){const result=stepBefore(step);if(Number(step)===2&&fieldCompact()){renderFlags();renderFieldReview()}polishFieldDaily();return result};
  }
  polishFieldDaily();
})();
