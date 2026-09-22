const demoRequestContainer=document.createElement('article');
demoRequestContainer.className='demo-request-queue';
demoRequestContainer.innerHTML='<div class="article-heading"><div><h2>Demo requests</h2><p>Requests submitted from the public website.</p></div><span class="badge" id="demo-request-count">0 new</span></div><div id="demo-requests"><p class="empty">Loading demo requests…</p></div>';
document.querySelector('#onboarding-view')?.prepend(demoRequestContainer);

const demoSafe=value=>String(value||'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
async function loadDemoRequests(){
  const response=await fetch('/api/platform/demo-requests',{credentials:'include'});
  if(!response.ok)return;
  const requests=await response.json(),newCount=requests.filter(item=>item.status==='New').length;
  document.querySelector('#demo-request-count').textContent=`${newCount} new`;
  document.querySelector('#demo-requests').innerHTML=requests.length?requests.map(item=>`<div class="work-card demo-request"><div><strong>${demoSafe(item.company)}</strong><small>${demoSafe(item.name)} · <a href="mailto:${encodeURIComponent(item.email)}">${demoSafe(item.email)}</a>${item.phone?` · <a href="tel:${demoSafe(item.phone)}">${demoSafe(item.phone)}</a>`:''}</small><p>${demoSafe(item.companySize||'Company size not provided')}${item.preferredTime?` · Preferred: ${demoSafe(new Date(item.preferredTime).toLocaleString())}`:' · Time not specified'}</p>${item.notes?`<p>${demoSafe(item.notes)}</p>`:''}</div><select data-demo-request="${item.id}">${['New','Contacted','Scheduled','Completed','Closed'].map(status=>`<option ${status===item.status?'selected':''}>${status}</option>`).join('')}</select></div>`).join(''):'<p class="empty">No demo requests yet.</p>';
}
document.addEventListener('change',async event=>{
  if(!event.target.dataset.demoRequest)return;
  const response=await fetch(`/api/platform/demo-requests/${event.target.dataset.demoRequest}`,{method:'PATCH',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({status:event.target.value})});
  if(response.ok)loadDemoRequests();
});
loadDemoRequests();
