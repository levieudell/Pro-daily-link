(function(){
  'use strict';
  let sequence=0;
  window.loadHelpGuidance=async function(){
    const request=++sequence,host=document.querySelector('#help-guidance');
    host.replaceChildren();
    try{
      const value=await api('/api/help-guidance',{redirectOnUnauthorized:false});
      if(request!==sequence)return;
      const heading=document.createElement('h3');heading.textContent='A little help getting started';host.append(heading);
      const welcome=document.createElement('p');welcome.textContent=value.welcome;host.append(welcome);
      const source=document.createElement('small');source.textContent=value.source;host.append(source);
      if(value.tip){
        const card=document.createElement('article'),title=document.createElement('strong'),copy=document.createElement('p'),dismiss=document.createElement('button');
        title.textContent=value.tip.title;copy.textContent=value.tip.text;dismiss.type='button';dismiss.className='secondary';dismiss.textContent='Dismiss this tip';
        dismiss.onclick=async()=>{dismiss.disabled=true;try{await api('/api/help-guidance',{method:'PATCH',body:JSON.stringify({dismiss:value.tip.id})});await window.loadHelpGuidance()}catch(error){dismiss.disabled=false;notify(error.message)}};
        card.append(title,copy,dismiss);host.append(card);
        await api('/api/help-guidance',{method:'PATCH',body:JSON.stringify({seen:value.tip.id})});
        if(request!==sequence)return;
      }
      const preferences=document.createElement('fieldset'),legend=document.createElement('legend');legend.textContent='Help preferences';preferences.append(legend);
      const controls={};
      for(const [key,label] of [['inApp','Show in-app tips'],...(value.emailAudience?[['emailTips','Email setup tips (draft; delivery disabled)']]:[])]){
        const row=document.createElement('label'),input=document.createElement('input');row.className='check-row';input.type='checkbox';input.checked=value.preferences[key];controls[key]=input;row.append(input,document.createTextNode(label));preferences.append(row);
      }
      const save=document.createElement('button');save.type='button';save.className='secondary';save.textContent='Save help preferences';
      save.onclick=async()=>{save.disabled=true;try{await api('/api/help-guidance',{method:'PATCH',body:JSON.stringify(Object.fromEntries(Object.entries(controls).map(([key,input])=>[key,input.checked])))});notify('Help preferences saved. Email delivery remains disabled.');await window.loadHelpGuidance()}catch(error){notify(error.message);save.disabled=false}};
      preferences.append(save);host.append(preferences);
      if(value.emailPreview){const preview=document.createElement('details'),summary=document.createElement('summary'),subject=document.createElement('strong'),body=document.createElement('p');summary.textContent='Review draft email copy';subject.textContent=value.emailPreview.subject;body.textContent=value.emailPreview.body;preview.append(summary,subject,body);host.append(preview)}
    }catch(error){if(request===sequence&&![401,404].includes(error.status))notify('Setup tips could not load. Published help topics are still available.')}
  };
})();
