'use strict';
function availableCompanyTabs(user,features,role){
  if(role!=='office')return [];
  const office=['owner','admin'].includes(user?.role),manager=user?.role==='project_manager',tabs=[];
  if(office)tabs.push('company');
  if(features?.timeCards===true&&(user?.role==='owner'||user?.role==='admin'&&user?.permissions?.manageTime===true))tabs.push('periods');
  if(features?.templates===true&&(office||manager))tabs.push('forms');
  if(office)tabs.push('activity');
  return tabs;
}
if(typeof module!=='undefined'&&module.exports)module.exports={availableCompanyTabs};
else {
  let settingsTab='company',settingsIdentity='';
  const settingsPanels={company:'company-settings-profile',periods:'company-pay-periods',forms:'daily-templates-panel',activity:'company-settings-activity'};
  function applyCompanyTabs(){
    const identity=JSON.stringify([signedInCompanyId(),currentUser?.id,currentUser?.role,currentRole,currentUser?.permissions,company?.features]);
    if(identity!==settingsIdentity){settingsIdentity=identity;settingsTab='company'}
    const allowed=availableCompanyTabs(currentUser,company?.features,currentRole);if(!allowed.includes(settingsTab))settingsTab=allowed[0]||'';
    $('#company-settings-tabs').hidden=!allowed.length;
    $$('[data-settings-tab]').forEach(button=>{const selected=button.dataset.settingsTab===settingsTab;button.hidden=!allowed.includes(button.dataset.settingsTab);button.setAttribute('aria-selected',String(selected));button.tabIndex=selected?0:-1;button.classList.toggle('active',selected)});
    for(const [key,id] of Object.entries(settingsPanels))$('#'+id).hidden=key!==settingsTab||!allowed.includes(key);
    const nav=$('[data-page="settings"]');if(nav)nav.hidden=!allowed.length;
    if(!allowed.includes('periods'))$('#company-pay-period-list').innerHTML='';
  }
  function selectCompanyTab(key,{focus=false}={}){applyCompanyTabs();if(!availableCompanyTabs(currentUser,company?.features,currentRole).includes(key))return;settingsTab=key;applyCompanyTabs();if(focus)$('#settings-tab-'+key).focus();if(key==='periods')window.PDLPayPeriods?.refresh()}
  window.PDLCompanySettings={openPayPeriods(){if(!availableCompanyTabs(currentUser,company?.features,currentRole).includes('periods'))return;showPage('settings');selectCompanyTab('periods',{focus:true})}};
  const priorSettingsRender=renderEverything;renderEverything=function(){const result=priorSettingsRender();applyCompanyTabs();return result};
  const priorSettingsPage=showPage;showPage=function(page,options){const result=priorSettingsPage(page,options);applyCompanyTabs();if(page==='settings'&&settingsTab==='periods')window.PDLPayPeriods?.refresh();return result};
  document.addEventListener('click',event=>{const tab=event.target.closest('[data-settings-tab]');if(tab)selectCompanyTab(tab.dataset.settingsTab);if(event.target.closest('[data-pay-settings]'))window.PDLCompanySettings.openPayPeriods()});
  $('#company-settings-tabs').addEventListener('keydown',event=>{
    const tab=event.target.closest('[data-settings-tab]');if(!tab||!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
    const allowed=availableCompanyTabs(currentUser,company?.features,currentRole),index=allowed.indexOf(tab.dataset.settingsTab);if(index<0)return;
    const next=event.key==='Home'?0:event.key==='End'?allowed.length-1:(index+(event.key==='ArrowRight'?1:-1)+allowed.length)%allowed.length;event.preventDefault();selectCompanyTab(allowed[next],{focus:true});
  });
  applyCompanyTabs();
}
