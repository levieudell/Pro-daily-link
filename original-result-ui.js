'use strict';
(function(){
 let epoch=0,panel=null,busy=false;
 const platformId='5a7f362f-e399-56e3-9458-e34b794a389d';
 const element=(name,text)=>{const node=document.createElement(name);if(text!==undefined)node.textContent=text;return node;};
 function retire(){epoch++;busy=false;if(panel){panel.replaceChildren();panel.hidden=true;}document.querySelectorAll('#staff-code,#work-fields .code').forEach(node=>node.replaceChildren());}
 window.pdlRetireManualCredentials=retire;
 function mode(){return window.PDLManualCredentialRecovery?'manual':window.pdlProductionRoles?.enabled()&&window.PDLOriginalReportRecovery?'report':null;}
 function client(group){return group==='manual'?window.PDLManualCredentialRecovery:window.PDLOriginalReportRecovery;}
 async function identity(group){
  if(group==='report'){const value=await window.pdlProductionRoles.identity();return {companyId:value.companyId,actorId:value.actorId,role:value.role,sessionBinding:value.sessionBinding};}
  const value=await api('/api/platform/auth/me');if(value?.manualCredentialCustody!==true||value.role!=='platform_owner')return null;
  return {companyId:platformId,actorId:value.id,role:value.role,sessionBinding:value.accountSessionBinding,email:value.email};
 }
 function host(){if(!panel){panel=element('section');panel.id='original-result-recovery';panel.className='panel';panel.hidden=true;document.querySelector('main')?.prepend(panel);}return panel;}
 async function refresh(){
  const group=mode(),selected=group&&client(group);if(!selected||busy)return;const opening=++epoch;
  try{
   const all=selected.originalOperations();if(!all.length){if(panel){panel.replaceChildren();panel.hidden=true;}return;}
   if(panel){panel.replaceChildren();panel.hidden=true;}
   const journal=window.OriginalOperationRecovery.create(()=>localStorage),current=await identity(group);if(opening!==epoch)return;if(!current)return retire();
   const scope=await journal.identityDigest({companyId:current.companyId,actorId:current.actorId,role:current.role,sessionBinding:current.sessionBinding}),digest=group==='manual'?await journal.intentDigest(JSON.stringify([scope,current.email])):scope,rows=all.filter(row=>row.identityDigest===digest);if(opening!==epoch)return;
   const root=host();if(!root)return;root.replaceChildren();root.hidden=!rows.length;if(!rows.length)return;
   root.append(element('h2','Review a previous save'),element('p','Read the original result before making another save. This will not upload files or issue a replacement code.'));
   for(const row of rows){
    const item=element('div');item.dataset.originalOperation=row.operationId;
    item.append(element('strong',group==='report'?'Daily report save':'Account setup save'),element('small',new Date(row.createdAt).toLocaleString()));
    const read=element('button','Review original result');read.type='button';read.dataset.originalRead=row.operationId;item.append(read);root.append(item);
    read.onclick=async()=>{
     if(busy||opening!==epoch)return;busy=true;read.disabled=true;const ticket=epoch,accept=()=>ticket===epoch&&root.isConnected&&!root.hidden;
     try{
      const value=await selected.recoverOriginal(row.operationId,{accept,isCurrent:accept});if(!accept())return;
      const view=element('div');view.dataset.originalResult=row.operationId;item.append(view);
      if(group==='manual'){view.append(element('p',value.email),element('b',value.setupCode),element('small','Expires '+new Date(value.expiresAt||value.setupExpiresAt).toLocaleString()));}
      else{view.append(element('p',value.complete?'Saved daily #'+value.reportId+'. '+(value.report?.status||''):'Original daily #'+value.reportId+' requires further review. Its saved draft and original files remain unchanged.'));}
      if(group==='report'&&!value.complete)return;
      const label=element('label'),checked=element('input');checked.type='checkbox';checked.dataset.originalReviewed=row.operationId;label.append(checked,document.createTextNode(' I have reviewed this original result.'));view.append(label);
      const finish=element('button','Finish review');finish.type='button';finish.disabled=true;finish.dataset.originalFinish=row.operationId;view.append(finish);checked.onchange=()=>{finish.disabled=!checked.checked;};
      finish.onclick=async()=>{
       if(!checked.checked||busy||!accept())return;busy=true;finish.disabled=true;
       try{const result=await selected.reviewOriginal(row.operationId,{confirmed:true,isCurrent:accept,accept:()=>accept()&&checked.checked});if(!accept())return;if(result.originalHandleRetained){view.append(element('p','The result is known. The original save reference remains until storage can be reviewed.'));}else{busy=false;await refresh();}}
       catch(error){if(accept()){view.replaceChildren(element('p',error.message));}else if(ticket===epoch)retire();}finally{if(ticket===epoch)busy=false;}
      };
     }catch(error){if(accept()){item.append(element('p',error.message));}else if(ticket===epoch)retire();}finally{if(ticket===epoch)busy=false;if(read.isConnected)read.disabled=false;}
    };
   }
  }catch{if(opening===epoch)retire();}
 }
 window.PDLOriginalResultUI={refresh,retire};
 function managed(){return window.pdlProductionRoles?.enabled()===true||typeof platformUser!=='undefined'&&platformUser?.manualCredentialCustody===true;}
 window.addEventListener('focus',()=>refresh());window.addEventListener('blur',()=>{if(managed())retire();});
 document.addEventListener('visibilitychange',()=>document.hidden?(managed()&&retire()):refresh());
 window.addEventListener('storage',event=>{if(event.key===null||event.key.startsWith('pdl-original-operation-')){if(managed())retire();refresh();}});
 document.addEventListener('click',event=>{if(!busy&&!panel?.contains(event.target))setTimeout(refresh,0);});setTimeout(refresh,0);setTimeout(refresh,500);
})();
