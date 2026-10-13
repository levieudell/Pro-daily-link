'use strict';
(function(){
 const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 async function open({platform=false}={}){
  const path=platform?'/api/platform/provider-operations':'/api/company/provider-operations';
  const call=platform?(route,options)=>api(route,options):(route,options)=>workspaceApi(route,options);
  const identity=async()=>{const value=platform?await call('/api/platform/auth/me'):await window.pdlProductionRoles.identity();if(value.role!==(platform?'platform_owner':'owner'))throw Error('Current Owner access required.');return JSON.stringify(platform?[value.id,value.role,value.email]:[value.companyId,value.actorId,value.role,value.sessionBinding]);};
  const original=await identity();let sequence=0,proof=null,pending=null,confirming=false;
  const dialog=document.createElement('dialog');dialog.dataset.workspaceDialog='credential-recovery';dialog.innerHTML='<div class="modal-header"><h2>Review uncertain account links</h2><button type="button" data-close>Close</button></div><p>An uncertain delivery stays unknown. You can review and invalidate its exact account link.</p><div data-links></div><p data-message role="status"></p><div data-preview></div>';
  document.body.append(dialog);dialog.showModal();
  const live=async mark=>{if(!dialog.isConnected||!dialog.open||mark!==sequence)throw Error('Current Owner account changed. Close and reopen this review.');const current=await identity();if(!dialog.isConnected||!dialog.open||mark!==sequence||current!==original)throw Error('Current Owner account changed. Close and reopen this review.');};
  const message=value=>{dialog.querySelector('[data-message]').textContent=value;};
  const audit=receipt=>{dialog.querySelector('[data-preview]').innerHTML=`<p>Link invalidated ${esc(receipt.invalidatedAt)}. Delivery remains unknown.</p><p>Reason: ${esc(receipt.reason||'See the original review')}</p><p>Original review ${esc(receipt.requestId)} · Actor ${esc(receipt.actorId??'current Owner')}</p>`;};
  async function load(){const mark=++sequence,rows=await call(path);await live(mark);proof=null;dialog.querySelector('[data-preview]').replaceChildren();dialog.querySelector('[data-links]').innerHTML=rows.filter(row=>row.kind==='email'&&row.status==='unknown'&&row.purpose).map(row=>`<section class="panel"><p>${esc(row.purpose==='password-reset'?'Password reset':'Email verification')} · Account ${esc(row.accountId)}</p><p>Original operation ${esc(row.operationId)}</p><button type="button" data-attempt="${esc(row.id)}" ${row.invalidated?'disabled':''}>${row.invalidated?'Link invalidated':'Review exact link'}</button></section>`).join('')||'<p>No uncertain account-link deliveries need review.</p>';}
  dialog.querySelector('[data-close]').onclick=()=>dialog.close();dialog.addEventListener('close',()=>{sequence++;dialog.remove();});
  dialog.addEventListener('click',async event=>{const button=event.target.closest('button');if(!button)return;
   try{
    if(confirming&&(button.dataset.attempt||button.dataset.action==='preview'))throw Error('Finish the current link confirmation before selecting another review.');
    if(button.dataset.attempt){if(pending)throw Error('Read the original confirmation before starting another review.');const mark=++sequence;await live(mark);proof={attemptId:button.dataset.attempt};dialog.querySelector('[data-preview]').innerHTML='<label>Reason for invalidation<textarea data-reason maxlength="500"></textarea></label><button type="button" data-action="preview">Preview link invalidation</button>';message('');}
    if(button.dataset.action==='preview'){const mark=++sequence,attemptId=proof.attemptId,reason=dialog.querySelector('[data-reason]').value;button.disabled=true;const value=await call(path+'/'+attemptId+'/invalidation/preview',{method:'POST',body:JSON.stringify({reason})});await live(mark);proof={...value,attemptId,reason};dialog.querySelector('[data-preview]').innerHTML=`<p>${esc(value.consequence)}</p><p>Account ${esc(value.accountId)} · Current revision ${esc(value.expectedRevision)}</p><p>Reason: ${esc(reason)}</p><label><input type="checkbox" data-confirm> I reviewed this exact link and want to invalidate it.</label><button type="button" data-action="confirm" disabled>Invalidate reviewed link</button>`;}
    if(button.dataset.action==='confirm'){if(!proof||pending||confirming||!dialog.querySelector('[data-confirm]')?.checked)return;const reviewed=proof,mark=++sequence;confirming=true;button.disabled=true;try{await live(mark);if(proof!==reviewed||!dialog.querySelector('[data-confirm]')?.checked)throw Error('Review and confirm this exact link again.');pending={attemptId:reviewed.attemptId,requestId:crypto.randomUUID()};try{await call(path+'/'+pending.attemptId+'/invalidation/confirm',{method:'POST',body:JSON.stringify({proof:reviewed.proof,requestId:pending.requestId,confirmed:true})});}catch{}await recover(mark);}finally{confirming=false;}}
    if(button.dataset.action==='lookup'){const mark=++sequence;await recover(mark);}
   }catch(error){message(error.message);if(pending)dialog.querySelector('[data-preview]').innerHTML='<p>The original confirmation needs review. It will not be submitted again.</p><button type="button" data-action="lookup">Read original result</button>';}
  });
  dialog.addEventListener('change',event=>{if(event.target.matches('[data-confirm]'))dialog.querySelector('[data-action="confirm"]').disabled=!event.target.checked;});
  async function recover(mark){const receipt=await call(path+'/'+pending.attemptId+'/invalidation');await live(mark);if(!receipt.found||receipt.requestId!==pending.requestId)throw Error('The original confirmation is still unconfirmed. Review its original result before another action.');audit(receipt);message('Saved. This original email delivery remains unknown.');pending=null;proof=null;}
  try{await load();}catch(error){message(error.message);}
 }
 if(typeof module!=='undefined'&&module.exports){module.exports={esc};return;}
 document.addEventListener('click',event=>{const button=event.target.closest('[data-credential-recovery]');if(button)open({platform:button.dataset.credentialRecovery==='platform'}).catch(error=>{if(typeof toast==='function')toast(error.message);});});
 window.PDLCredentialRecovery={open};
})();
