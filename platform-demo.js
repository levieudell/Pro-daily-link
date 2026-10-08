const demoRequestContainer=document.createElement('article');
demoRequestContainer.className='demo-request-queue';
demoRequestContainer.innerHTML='<div class="article-heading"><div><h2>Demo requests</h2><p>Confirm times with the requester; status changes do not reserve a meeting or send an invite.</p></div><span class="badge" id="demo-request-count">—</span></div><p id="demo-queue-status" role="status" aria-live="polite"></p><button type="button" id="demo-queue-retry" hidden>Refresh demo requests</button><div id="demo-requests"><p class="empty">Loading demo requests.</p></div>';
document.querySelector('#onboarding-view')?.prepend(demoRequestContainer);
const demoSafe=value=>String(value||'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
function demoPreferredTime(item){
  if(!item.preferredTime)return 'Time not specified';
  if(item.preferredTimeUtc&&item.preferredTimeZone){
    try{return `Preferred: ${new Date(item.preferredTimeUtc).toLocaleString(undefined,{timeZone:item.preferredTimeZone,timeZoneName:'short'})} (${item.preferredTimeZone})`;}catch{}
  }
  return `Preferred: ${item.preferredTime.replace('T',' ')} (time zone not provided; confirm with requester)`;
}
function demoQueueMessage(message){
  document.querySelector('#demo-queue-status').textContent=message;
  document.querySelector('#demo-queue-retry').hidden=!message;
}
async function loadDemoRequests(){
  try{
    const response=await fetch('/api/platform/demo-requests',{credentials:'include',cache:'no-store'});
    if(!response.ok)throw new Error('Could not load demo requests. Check your platform sign-in and refresh.');
    const requests=await response.json();
    if(!Array.isArray(requests))throw new Error('Could not load demo requests. Refresh and try again.');
    document.querySelector('#demo-request-count').textContent=`${requests.filter(item=>item.status==='New').length} new`;
    document.querySelector('#demo-requests').innerHTML=requests.length?requests.map(item=>`<div class="work-card demo-request"><div><strong>${demoSafe(item.company)}</strong><small>${demoSafe(item.name)} · <a href="mailto:${encodeURIComponent(item.email)}">${demoSafe(item.email)}</a>${item.phone?` · <a href="tel:${demoSafe(item.phone)}">${demoSafe(item.phone)}</a>`:''}</small><p>${demoSafe(item.companySize||'Company size not provided')} · ${demoSafe(demoPreferredTime(item))}</p>${item.notes?`<p>${demoSafe(item.notes)}</p>`:''}</div><select data-demo-request="${demoSafe(item.id)}">${['New','Contacted','Scheduled','Completed','Closed'].map(status=>`<option ${status===item.status?'selected':''}>${status}</option>`).join('')}</select></div>`).join(''):'<p class="empty">No demo requests yet.</p>';
    demoQueueMessage('');
  }catch(error){
    document.querySelector('#demo-request-count').textContent='Unavailable';
    const list=document.querySelector('#demo-requests');
    if(list.innerHTML.includes('Loading demo requests.'))list.innerHTML='';
    demoQueueMessage(error.message||'Could not load demo requests. Refresh and try again.');
  }
}
document.querySelector('#demo-queue-retry').addEventListener('click',loadDemoRequests);
document.addEventListener('change',async event=>{
  const select=event.target;
  if(!select.dataset.demoRequest||select.disabled)return;
  select.disabled=true;
  try{
    const response=await fetch(`/api/platform/demo-requests/${encodeURIComponent(select.dataset.demoRequest)}`,{method:'PATCH',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({status:select.value})});
    if(!response.ok)throw new Error('Could not confirm the status was saved. Refresh demo requests before trying again.');
    await loadDemoRequests();
  }catch(error){demoQueueMessage(error.message||'Could not confirm the status was saved. Refresh and try again.');}
  finally{select.disabled=false;}
});
loadDemoRequests();
