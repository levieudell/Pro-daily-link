'use strict';
(function(){
  let ready=false,binding=null,actor=null,epoch=0,sequence=0,loading=0,loadRevision=null,retire=null,tail=Promise.resolve();
  const fail=message=>Object.assign(Error(message),{status:409,code:'PDL_WORKSPACE_STALE'});
  function clear(){epoch++;sequence++;actor=null;window.PDLCompanyRoles?.retire();retire?.();document.querySelectorAll('[data-workspace-dialog]').forEach(node=>node.remove());}
  function configure(config,me,onRetire){if(ready)clear();epoch++;ready=config?.rolesEditor===true&&me?.rolesEditor===true;retire=onRetire;binding=ready?{companyId:me.companyId,actorId:me.id,role:me.accessRole||me.role,sessionBinding:me.accountSessionBinding}:null;actor=null;}
  async function identity({transitionFrom=null,billing=false}={}){
    if(!ready||!binding)throw fail('Current permissions are unavailable. Sign in again.');
    const mark=epoch,opening=binding,company=localStorage.getItem('pdl-company-id');
    const response=await fetch('/api/workspace-identity',{credentials:'include',cache:'no-store',headers:{'X-PDL-Company':opening.companyId}});
    if(mark!==epoch||binding!==opening)throw fail('This response belongs to an earlier account.');
    if(!response.ok){clear();throw Object.assign(Error('Current company access could not be verified.'),{status:response.status});}
    const value=await response.json();
    if(mark!==epoch||binding!==opening)throw fail('This response belongs to an earlier account.');
    if(company!==localStorage.getItem('pdl-company-id')||!value||Object.entries(opening).some(([key,expected])=>value[key]!==expected)||!Number.isSafeInteger(value.revision)||!/^[a-f0-9]{64}$/.test(value.authority)||!Number.isFinite(Date.parse(value.expiresAt))||Date.parse(value.expiresAt)<=Date.now()){clear();throw fail('Your current account changed. Sign in again.');}
    if(actor&&(actor.authority!==value.authority&&transitionFrom!==actor.authority||actor.locked!==value.locked&&!billing)){clear();throw fail('Your permissions changed. Refresh current records.');}
    actor=value;return value;
  }
  const capture=()=>ready?{epoch,generation:loading}:null;
  function live(mark){if(mark&&(mark.epoch!==epoch||mark.generation&&(mark.generation!==loading||mark.generation!==sequence)))throw fail('This response belongs to an earlier company view. Refresh current records.');}
  async function verifyResponse(response,path,mark){
    const route=path.split('?')[0],revision=response.headers.get('X-PDL-Workspace-Revision');
    if(!ready){if(revision!==null&&!['/api/config','/api/auth/me','/api/auth/login','/api/auth/logout','/api/auth/reset','/api/auth/claim','/api/auth/forgot'].includes(route))throw fail('Sign in before loading managed company records.');return;}
    live(mark);
    if(!response.ok){if([401,402,403,409].includes(response.status))clear();return;}
    if(['/api/config','/api/auth/company','/api/auth/logout','/api/auth/forgot','/api/auth/reset','/api/auth/claim','/api/auth/login','/api/workspace-identity'].includes(route))return;
    const current=await identity({transitionFrom:route==='/api/company/role-policy/confirm'&&actor?.role==='owner'?response.headers.get('X-PDL-Workspace-Policy-From'):null,billing:['/api/billing','/api/billing/recover','/api/auth/me','/api/account-access'].includes(route)});live(mark);
    if(revision===null||Number(revision)!==current.revision||response.headers.get('X-PDL-Workspace-Authority')!==current.authority||current.locked&&!['/api/auth/me','/api/account-access','/api/billing','/api/billing/recover'].includes(route)){clear();throw fail('Company access changed during delivery. Refresh current records.');}
    if(loading&&route==='/api/state')loadRevision=current.revision;
    else if(loading&&loadRevision!==null&&loadRevision!==current.revision){clear();throw fail('Company records changed during loading. Refresh current records.');}
  }
  function load(run){
    if(!ready)return run();const generation=++sequence,mark=epoch;
    const result=tail.catch(()=>{}).then(async()=>{
      if(mark!==epoch||generation!==sequence)throw fail('Company changed before loading.');
      const root=document.getElementById('main-content')||document.querySelector('main');if(root)root.style.visibility='hidden';loading=generation;loadRevision=null;
      try{await identity();if(mark!==epoch||generation!==sequence)throw fail('Company changed before loading.');const value=await run(),last=await identity();if(mark!==epoch||generation!==sequence||loadRevision!==null&&loadRevision!==last.revision)throw fail('Company changed during loading. Refresh current records.');return value;}
      catch(error){if(mark===epoch&&generation===sequence)clear();throw error;}
      finally{if(loading===generation){loading=0;loadRevision=null;if(root&&(generation===sequence||mark!==epoch))root.style.visibility='';}}
    });tail=result;return result;
  }
  window.addEventListener('focus',()=>{if(ready)identity().catch(()=>{});});
  window.pdlProductionRoles={configure,identity,capture,verifyResponse,load,clear,enabled:()=>ready,rolePolicies:()=>ready&&actor?.policyActive===true};
})();
