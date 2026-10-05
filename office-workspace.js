'use strict';
// Navigation only. Existing page guards and scoped endpoints remain authoritative.
function officeWorkspaceTools({mode,canViewTime,timeCards,settingsTabs=[]}) {
  if(mode!=='office')return [];
  const tools=[{id:'schedule',label:'Crew schedule',detail:'Plan work and check availability',icon:'▣'}];
  if(timeCards&&canViewTime){
    tools.push({id:'timecards',label:'Time review',detail:'Review hours by person',icon:'◷'});
    tools.push({id:'payreports',label:'Pay-period reports',detail:'Approved hours and fixed exports',icon:'⇩'});
  }
  if(settingsTabs.length)tools.push({id:'settings',label:'Company settings',detail:settingsTabs.includes('company')?'Profile and company preferences':'Forms and safety templates',icon:'⚙'});
  return tools;
}
if(typeof module!=='undefined'&&module.exports)module.exports={officeWorkspaceTools};
else {
  function availableOfficeTools(){return officeWorkspaceTools({mode:currentRole,canViewTime:canViewTime(),timeCards:timeCardsOn(),settingsTabs:availableCompanyTabs(currentUser,company?.features,currentRole)})}
  function renderOfficeWorkspace(){
    const host=$('#office-workspace-tools');if(!host)return;
    const tools=availableOfficeTools();host.hidden=!tools.length;
    host.innerHTML=tools.map(tool=>`<button type="button" class="office-tool" data-office-tool="${tool.id}"><span class="office-tool-icon" aria-hidden="true">${tool.icon}</span><span><strong>${tool.label}</strong><small>${tool.detail}</small></span><span class="office-tool-arrow" aria-hidden="true">→</span></button>`).join('');
    $$('[data-office-payreports]').forEach(button=>button.hidden=!tools.some(tool=>tool.id==='payreports'));
  }
  const previousOfficeRender=renderEverything;
  renderEverything=function(){const result=previousOfficeRender();renderOfficeWorkspace();return result};
  document.addEventListener('click',event=>{
    const button=event.target.closest('[data-office-tool], [data-office-payreports]');if(!button)return;
    const id=button.dataset.officeTool||'payreports';
    if(!availableOfficeTools().some(tool=>tool.id===id))return;
    showPage(id==='payreports'?'timecards':id);
    if(id==='payreports'){
      $('#pay-period-panel')?.scrollIntoView({block:'start'});
      $('#pay-period-panel')?.focus({preventScroll:true});
    }
  });
  renderOfficeWorkspace();
}
