'use strict';
(function(){
  const key='pdl-resource-original-save-v1',known=new Set();let custody=null,busy=false;
  function routes(method,path,details){
    if(method==='POST'){
      const exact={'/api/customers':'customerCreate','/api/projects':'projectCreate','/api/team':'teamCreate','/api/crews':'crewCreate','/api/company-activities':'activityCreate','/api/daily-templates':'templateCreate','/api/daily-templates/default':'templateDefault','/api/catalog':'catalogCreate','/api/subcontractors':'subcontractorCreate'};
      if(exact[path])return exact[path];
      if(/^\/api\/catalog\/[1-9]\d*\/apply$/.test(path))return 'catalogApply';
      if(/^\/api\/projects\/[1-9]\d*\/tasks$/.test(path))return 'projectTaskCreate';
      if(/^\/api\/project-tasks\/[1-9]\d*\/assign$/.test(path))return 'projectTaskAssign';
    }
    if(method==='PATCH'&&path==='/api/company')return 'companySettings';
    if(method==='PATCH'&&path==='/api/company/contract-value-tracking')return 'contractTracking';
    if(method==='PATCH'&&/^\/api\/projects\/[1-9]\d*\/archive$/.test(path))return 'projectArchive';
    if(method==='PATCH'&&/^\/api\/projects\/[1-9]\d*\/template$/.test(path))return 'projectTemplates';
    if(['PATCH','PUT'].includes(method)&&/^\/api\/projects\/[1-9]\d*$/.test(path)){
      if(details===undefined)return 'projectChange'; // Retained technical markers contain no submitted values.
      const keys=details&&typeof details==='object'&&!Array.isArray(details)?Object.keys(details):[];
      if(keys.length===1&&keys[0]==='contractValue')return 'projectContract';
      if(method==='PATCH'&&keys.length&&keys.every(key=>['startDate','endDate'].includes(key)))return 'projectDates';
      return 'mixedProjectChange';
    }
    if(['PATCH','DELETE'].includes(method)&&/^\/api\/crews\/[1-9]\d*$/.test(path))return method==='PATCH'?'crewEdit':'crewRemove';
    if(['PATCH','DELETE'].includes(method)&&/^\/api\/daily-templates\/(?:standard|[1-9]\d*)$/.test(path))return method==='PATCH'?'templateEdit':'templateRemove';
    if(['PATCH','DELETE'].includes(method)&&/^\/api\/project-tasks\/[1-9]\d*$/.test(path))return method==='PATCH'?'projectTaskEdit':'projectTaskRemove';
    if(method==='PATCH'&&/^\/api\/subcontractors\/[1-9]\d*(?:\/(?:profile|archive))?$/.test(path))return path.endsWith('/profile')?'subcontractorProfile':path.endsWith('/archive')?'subcontractorArchive':'subcontractorCompliance';
    return null;
  }
  const fail=message=>Object.assign(Error(message),{status:409});
  function unresolved(){try{const raw=sessionStorage.getItem(key);if(raw===null)return false;const row=JSON.parse(raw);return !row||!known.has(row.requestId);}catch{return true;}}
  function read(){try{const row=JSON.parse(sessionStorage.getItem(key));return row&&!known.has(row.requestId)&&Object.keys(row).sort().join(',')==='actorId,authority,companyId,method,path,requestId,role,sessionBinding,token,version'&&routes(row.method,row.path)&&/^[a-f0-9]{64}$/.test(row.authority)&&/^[a-f0-9]{64}$/.test(row.sessionBinding)&&/^[a-f0-9]{64}$/.test(row.version)&&/^[a-f0-9-]{36}$/.test(row.token)&&/^[a-zA-Z0-9_-]{8,128}$/.test(row.requestId)?row:null;}catch{return null;}}
  function remember(identity,method,path,proof){
    const row={companyId:identity.companyId,actorId:identity.actorId,role:identity.role,sessionBinding:identity.sessionBinding,authority:identity.authority,method,path,token:proof.token,version:proof.version,requestId:proof.requestId};
    sessionStorage.setItem(key,JSON.stringify(row));if(read()?.requestId!==row.requestId)throw fail('The original resource identity could not be retained.');draw();return row;
  }
  function finish(requestId){known.add(requestId);try{if(JSON.parse(sessionStorage.getItem(key))?.requestId===requestId)sessionStorage.removeItem(key);}catch{if(typeof notify==='function')notify('Saved. The original result marker could not be removed.');}draw();}
  async function refresh(){
    const root=document.getElementById('main-content')||document.querySelector('main');if(root)root.style.visibility='hidden';
    try{window.pdlWorkspaceActions.resourceChanged();if(typeof retireResourceViews==='function')retireResourceViews();if(typeof loadRole!=='function')throw fail('Current workspace readback is unavailable.');await loadRole(currentRole);await window.pdlWorkspaceActions.identity();}
    catch(error){window.pdlWorkspaceActions.clear();throw error;}
    finally{if(root)root.style.visibility='';}
  }
  function display(value){
    const labels={customerId:'Customer record',customer:'Customer',name:'Name',contact:'Contact',email:'Email',phone:'Phone',role:'Job role',crew:'Crew',initials:'Initials',contractType:'Contract type',budget:'Budget',site:'Site',startDate:'Start date',endDate:'End date',supervisor:'Supervisor',siteContact:'Site contact',archived:'Archived',enabled:'Enabled',trade:'Trade',timezone:'Time zone',timezoneSelected:'Time zone confirmed',weekStart:'Week starts',overtimeRule:'Overtime rule',scheduleGraceMinutes:'Schedule grace minutes',autoAdoptActualTimes:'Adopt actual times',contractValueTracking:'Contract value tracking',contractValue:'Contract value',fields:'Questions',label:'Question',type:'Answer type',required:'Required',help:'Guidance',options:'Choices',showWhen:'Show when',fieldId:'Question ID',value:'Answer',requirements:'Completion requirements',photo:'Photo',signature:'Signature',acknowledgement:'Worker acknowledgement',assignment:'Template assignment',crewNames:'Crews',workTypes:'Work types',reviewNotice:'Review notice',templateId:'Template',templateIds:'Templates',category:'Category',description:'Purpose',unit:'Unit',targetHoursPerUnit:'Target hours per unit',projectId:'Project record',plannedQuantity:'Planned quantity',durationDays:'Working days',predecessorIds:'Waits for tasks',memberIds:'Employees',memberId:'Employee record',fromDate:'Starting date',insuranceExpiration:'Insurance expiration',workersCompExpiration:'Workers’ compensation expiration',licenseNumber:'License number',licenseExpiration:'License expiration',w9Received:'W-9 received',agreementSigned:'Agreement signed',autoComplianceReminders:'Automatic compliance reminders',notes:'Notes',status:'Status',reason:'Archive reason',taskChanges:'Affected project tasks',subcontractorEffects:'Subcontractor consequences',revokedLinkCount:'Project links to revoke',cancelledReminderCount:'Queued reminders to cancel',before:'Before',after:'After',removed:'Removed',created:'Created',taskAssignment:'Task daily assignments',createdCount:'New assignments',mergedCount:'Existing shifts to join',skippedCount:'Days to skip'};
    const scalar=value=>value===null?'Not set':typeof value==='boolean'?(value?'Yes':'No'):String(value);
    const recordLabel=(key,id)=>{
      if(['memberIds','memberId'].includes(key)){const row=typeof team!=='undefined'?team.find(row=>Number(row.id)===Number(id)):null;return row?row.name+' (employee '+id+')':'Employee '+id;}
      if(key==='predecessorIds'){const row=typeof projectTasks!=='undefined'?projectTasks.find(row=>Number(row.id)===Number(id)):null;return row?row.name+' (task '+id+')':'Task '+id;}
      if(['templateIds','templateId'].includes(key)){const row=typeof dailyTemplates!=='undefined'?dailyTemplates.find(row=>String(row.id)===String(id)):null;return row?row.name+' (template '+id+')':'Template '+id;}
      return scalar(id);
    };
    function lines(key,value,depth){
      const prefix='  '.repeat(depth),label=labels[key]||key;
      if(Array.isArray(value)){
        if(!value.length)return [prefix+label+': None'];
        if(value.every(item=>item===null||typeof item!=='object'))return [prefix+label+': '+value.map(item=>recordLabel(key,item)).join(', ')];
        return [prefix+label+':',...value.flatMap((item,index)=>[prefix+'  '+(key==='fields'?'Question ':'Item ')+(index+1)+':',...Object.entries(item).flatMap(([name,entry])=>lines(name,entry,depth+2))])];
      }
      if(value&&typeof value==='object')return [prefix+label+':',...Object.entries(value).flatMap(([name,entry])=>lines(name,entry,depth+1))];
      return [prefix+label+': '+(['memberId','templateId'].includes(key)?recordLabel(key,value):scalar(value))];
    }
    return Object.entries(value).flatMap(([key,entry])=>lines(key,entry,0)).join('\n');
  }
  async function review(operation,opening,send){return new Promise((resolve,reject)=>{
    const dialog=document.createElement('dialog');dialog.id='resource-action-review';dialog.dataset.workspaceDialog='resource';
    dialog.innerHTML='<h2>Review resource change</h2><pre style="white-space:pre-wrap;max-height:35vh;overflow:auto"></pre><label>Reason for this change <textarea maxlength="500" required></textarea></label><p role="status"></p><label><input type="checkbox" disabled> I reviewed the server preview and confirm this change.</label><div class="modal-actions"><button type="button" class="secondary">Cancel</button><button type="button" class="primary">Preview change</button></div>';
    dialog.querySelector('pre').textContent=display(operation.details);let preview=null,working=false,settled=false;
    const finish=value=>{if(settled)return;settled=true;observer.disconnect();window.removeEventListener('blur',cancel);document.removeEventListener('visibilitychange',hidden);window.removeEventListener('hashchange',cancel);dialog.close();dialog.remove();resolve(value);};
    const cancel=()=>finish(null),hidden=()=>{if(document.hidden)cancel();};
    const observer=new MutationObserver(()=>{if(!dialog.isConnected&&!settled){settled=true;observer.disconnect();window.removeEventListener('blur',cancel);document.removeEventListener('visibilitychange',hidden);window.removeEventListener('hashchange',cancel);reject(fail('Workspace changed. Review again.'));}});observer.observe(document.body,{childList:true});
    dialog.querySelector('.secondary').onclick=cancel;dialog.addEventListener('cancel',event=>{event.preventDefault();cancel();});
    window.addEventListener('blur',cancel);document.addEventListener('visibilitychange',hidden);window.addEventListener('hashchange',cancel);
    dialog.querySelector('.primary').onclick=async()=>{
      if(working)return;
      const status=dialog.querySelector('[role=status]');
      if(!preview){const reason=dialog.querySelector('textarea').value.trim();if(!reason){status.textContent='Enter a reason before previewing.';return;}working=true;
        try{const current=await window.pdlWorkspaceActions.identity();if(current.authority!==opening.authority||current.sessionBinding!==opening.sessionBinding)throw fail('Workspace access changed. Review again.');preview=await send('/api/resources/preview',{method:'POST',body:JSON.stringify({operation,expectedRevision:current.revision,reason})});if(settled)return;
          dialog.querySelector('pre').textContent=display(preview.impact.details)+(Object.hasOwn(preview.impact,'affectedMemberCount')?'\n\nAffected existing employees: '+preview.impact.affectedMemberCount+'\nAffected accounts: '+preview.impact.affectedAccountCount:'')+(preview.impact.taskChanges?'\n\n'+display({taskChanges:preview.impact.taskChanges}):'')+(preview.impact.taskAssignment?'\n\n'+display({taskAssignment:preview.impact.taskAssignment}):'')+(preview.impact.subcontractorEffects?'\n\n'+display({subcontractorEffects:preview.impact.subcontractorEffects}):'')+'\nReason: '+preview.reason;
          for(const account of preview.impact.accountChanges||[]){for(const change of account.changes)dialog.querySelector('pre').textContent+='\nAccount '+account.id+' ('+account.role+'): '+change.collection+' '+change.removed+' removed, '+change.added+' added';if(Object.hasOwn(account,'pricingBefore'))dialog.querySelector('pre').textContent+='\nAccount '+account.id+': pricing access '+(account.pricingBefore?'enabled':'disabled')+' to '+(account.pricingAfter?'enabled':'disabled');}
          dialog.querySelector('textarea').disabled=true;dialog.querySelector('input').disabled=false;dialog.querySelector('input').checked=false;dialog.querySelector('.primary').textContent='Confirm and save';status.textContent='Server preview ready. Review it before confirming.';
        }catch(error){status.textContent=error.message;}finally{working=false;}return;
      }
      if(!dialog.querySelector('input').checked){status.textContent='Check the confirmation box after reviewing the server preview.';return;}finish(preview);
    };
    document.body.append(dialog);dialog.showModal();
  });}
  async function request(path,options,send){
    if(!window.pdlWorkspaceActions?.enabled())return send(path,options);
    const method=String(options.method||'GET').toUpperCase();if(!routes(method,path))return send(path,options);
    const details=options.body?JSON.parse(options.body):{},kind=routes(method,path,details);
    if(kind==='mixedProjectChange')throw fail('Review project dates and contract value as separate changes.');
    if(busy||unresolved()||window.pdlWorkspaceSave?.read()){draw();throw fail('Check the previous save result before making another change.');}busy=true;
    try{
      const opening=await window.pdlWorkspaceActions.identity(),operation={kind,method,path,details},preview=await review(operation,opening,send);
      if(!preview)throw Object.assign(Error('Change cancelled.'),{status:400});
      const current=await window.pdlWorkspaceActions.identity();if(current.authority!==opening.authority||current.sessionBinding!==opening.sessionBinding||preview.authorityBefore!==opening.authority||Date.parse(preview.expiresAt)<=Date.now())throw fail('Company changed. Review a new preview.');
      const proof={token:preview.token,version:preview.version,confirmed:true,requestId:crypto.randomUUID()};custody=remember(current,method,path,proof);
      const result=await send(path,{...options,body:JSON.stringify(proof),onAcknowledged:()=>{}});finish(proof.requestId);custody=null;
      try{await refresh();}catch(error){error.saved=true;error.message='Saved. Refresh the workspace before continuing.';throw error;}return result;
    }finally{custody=null;busy=false;}
  }
  function draw(){
    if(!window.pdlWorkspaceActions?.enabled())return;document.getElementById('resource-original-save')?.remove();const row=read();if(!row&&!unresolved())return;
    const box=document.createElement('section');box.id='resource-original-save';box.className='email-verification-banner';box.innerHTML='<div><strong>A resource save has an unknown result.</strong><p>Check its original receipt before making another change.</p><p role="status"></p></div><button type="button" class="secondary">Check original result</button>';
    if(!row){box.querySelector('strong').textContent='The resource result marker needs review.';box.querySelector('p').textContent='Its original outcome remains unknown. Refresh and review current records before retiring this browser marker.';box.querySelector('button').remove();reconcile(box,null);(document.getElementById('app-main')||document.body).prepend(box);return;}
    box.querySelector('button').onclick=async()=>{if(busy)return;busy=true;box.querySelector('button').disabled=true;
      try{const current=await window.pdlWorkspaceActions.identity();if(['companyId','actorId','role','sessionBinding'].some(key=>row[key]!==current[key]))throw fail('The originating account or session changed. Review current records; the original outcome remains unknown.');
        custody=row;const result=await workspaceApi('/api/resources/original-result',{method:'POST',redirectOnUnauthorized:false,body:JSON.stringify({token:row.token,version:row.version,requestId:row.requestId,method:row.method,path:row.path}),onAcknowledged:()=>{}});if(result.originalSaveResult!==true)throw fail('The original resource receipt could not be verified.');finish(row.requestId);custody=null;await refresh();if(typeof notify==='function')notify('The original resource save was confirmed.');
      }catch(error){box.querySelector('[role=status]').textContent=error.message;if([401,403,409].includes(error.status))reconcile(box,row);}finally{custody=null;busy=false;box.querySelector('button').disabled=false;}
    };
    (document.getElementById('app-main')||document.body).prepend(box);
  }
  window.addEventListener('focus',draw);window.addEventListener('hashchange',draw);document.addEventListener('DOMContentLoaded',draw);
  function reconcile(box,row){
    if(box.querySelector('[data-resource-reconcile]'))return;const section=document.createElement('div');section.dataset.resourceReconcile='true';let reviewed=null,generation=0;
    section.innerHTML='<p>The original outcome remains unknown. Review current records before making another change.</p><label><input type="checkbox"> I reviewed current records and understand the original outcome remains unknown.</label><button type="button" class="secondary">Retire this browser result marker</button>';
    section.querySelector('input').onchange=async()=>{const opening=++generation;reviewed=null;if(!section.querySelector('input').checked)return;try{const current=await window.pdlWorkspaceActions.identity();if(row&&(current.companyId!==row.companyId||current.actorId!==row.actorId))throw fail('Return to the originating company and account before retiring this result marker.');if(current.revision!==window.pdlWorkspaceActions.displayedRevision())throw fail('Refresh and review current records first.');if(opening===generation&&section.querySelector('input').checked)reviewed={...current};}catch(error){if(opening===generation){section.querySelector('input').checked=false;box.querySelector('[role=status]').textContent=error.message;}}};
    section.querySelector('button').onclick=async()=>{try{if(!section.querySelector('input').checked||reviewed===null)throw fail('Review current records and acknowledge the unknown outcome first.');const current=await window.pdlWorkspaceActions.identity();if(['companyId','actorId','role','sessionBinding','authority','revision'].some(key=>current[key]!==reviewed[key])||window.pdlWorkspaceActions.displayedRevision()!==reviewed.revision||row&&(current.companyId!==row.companyId||current.actorId!==row.actorId))throw fail('Workspace changed. Refresh and review current records again.');
      const historyKey=key+'-retired',history=JSON.parse(sessionStorage.getItem(historyKey)||'[]');if(!Array.isArray(history)||history.length>=100||JSON.stringify(history).length>50000)throw fail('Browser result history needs review.');let entry;if(row)entry={companyId:row.companyId,actorId:row.actorId,requestId:row.requestId,method:row.method,path:row.path};else{const raw=sessionStorage.getItem(key);if(raw===null)throw fail('The result marker changed. Review again.');const markerHash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(raw)))].map(value=>value.toString(16).padStart(2,'0')).join('');if(raw!==sessionStorage.getItem(key))throw fail('The result marker changed. Review again.');entry={companyId:current.companyId,actorId:current.actorId,markerHash};}sessionStorage.setItem(historyKey,JSON.stringify([...history,{...entry,result:'unknown',retiredAt:new Date().toISOString()}]));if(row)finish(row.requestId);else{sessionStorage.removeItem(key);if(sessionStorage.getItem(key)!==null)throw fail('The result marker could not be retired.');draw();}
    }catch(error){box.querySelector('[role=status]').textContent=error.message;}};box.append(section);
  }
  window.pdlResourceActions={request,read,draw,unresolved,pending:()=>custody?{...custody}:null};
})();
