'use strict';
// Uses the existing platform session; never creates a login or support grant.
(() => {
  let busy = false;
  document.addEventListener('click', async event => {
    const button=event.target.closest('[data-prepare-sales-demo]');
    if(!button||busy)return;
    const companyId=button.dataset.prepareSalesDemo,originView=currentView,originVersion=viewVersion;
    const current=()=>currentView===originView&&viewVersion===originVersion;
    if(platformUser?.role!=='platform_owner'||!data.companies.some(c=>c.id===companyId&&c.name==='DEMO | Alder Ridge Builders'))return;
    busy=true;button.disabled=true;
    try {
      const preview=await api(`/api/platform/companies/${encodeURIComponent(companyId)}/sales-demo`);
      if(!button.isConnected||!current())return;
      const prompt=preview.alreadyPrepared
        ?`Verify that ${preview.companyName} is saved? Existing demo changes will be preserved.`
        :`Prepare ${preview.companyName} with 4 weeks of fictional history: 3 projects, 8 people, 60 reports and 160 time cards? This company must be empty. Existing owner login stays unchanged. No payments, invitations or messages will be sent.`;
      if(!confirm(prompt))return;
      const result=await api(`/api/platform/companies/${encodeURIComponent(companyId)}/sales-demo`,{method:'POST',body:JSON.stringify({expectedRevision:preview.expectedRevision,confirmCompanyName:preview.companyName,asOf:preview.asOf})});
      await reload();
      if(!current())return;
      const host=document.querySelector(`[data-prepare-sales-demo="${companyId}"]`)?.parentElement;
      if(host){
        host.querySelector('[data-sales-demo-ready]')?.remove();
        const note=document.createElement('span');note.dataset.salesDemoReady='true';
        note.textContent=`Saved: ${result.counts.projects} projects · ${result.counts.reports} reports · ${result.counts.timeCards} time cards. `;
        const link=document.createElement('a');link.href=`/app?tenant=${encodeURIComponent(companyId)}`;link.target='_blank';link.rel='noopener';link.className='small secondary';link.textContent='Open demo company';link.title='Use the demo company’s existing owner login';note.append(link);host.append(note);
      }
    }catch(error){if(current())alert(error.message||'Demo preparation could not be confirmed. Refresh and retry this same company.');}
    finally{busy=false;if(button.isConnected)button.disabled=false;}
  });
})();
