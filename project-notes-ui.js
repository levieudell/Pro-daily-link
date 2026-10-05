'use strict';
// Project notes are plain text. Persisted records and edit history come only from the scoped API.
function projectNoteEscape(value){return String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]))}
function projectNoteTime(value){const date=new Date(value);return Number.isFinite(date.valueOf())?date.toLocaleString():'Unknown time'}
function projectNoteCard(item){
  const esc=projectNoteEscape,todo=item.kind==='todo',history=Array.isArray(item.history)?item.history:[];
  const entries=history.slice().reverse().map(entry=>`<li><strong>${esc(entry.action)}</strong><small>${esc(entry.by)} · ${esc(projectNoteTime(entry.at))}</small>${entry.before&&entry.before.text!==entry.after?.text?`<div class="project-note-before">Previous text<p>${esc(entry.before.text)}</p></div>`:''}${entry.after?`<p>${esc(entry.after.text)}</p>${todo?`<small>${entry.after.completed?'Completed':'Open'}</small>`:''}`:''}</li>`).join('');
  return `<article class="project-note-card${todo&&item.completed?' is-complete':''}" data-note-card="${esc(item.id)}"><div class="project-note-body"><p>${esc(item.text)}</p><small>Added by ${esc(item.createdBy)} · ${esc(projectNoteTime(item.createdAt))}${item.revision>1?`<br>Updated by ${esc(item.updatedBy)} · ${esc(projectNoteTime(item.updatedAt))}`:''}</small></div><div class="project-note-actions">${todo?`<button type="button" class="secondary" data-note-toggle="${esc(item.id)}">${item.completed?'Reopen':'Mark complete'}</button>`:''}<button type="button" class="secondary" data-note-edit="${esc(item.id)}" aria-label="Edit ${todo?'to-do':'note'}">Edit</button></div><details class="project-note-history"><summary>History (${history.length})</summary><ol>${entries}</ol></details></article>`;
}
function projectNotesList(items){
  const open=items.filter(item=>item.kind==='todo'&&!item.completed),done=items.filter(item=>item.kind==='todo'&&item.completed),notes=items.filter(item=>item.kind==='note');
  return `<section aria-labelledby="project-open-todos"><h4 id="project-open-todos">Open to-dos <span>${open.length}</span></h4>${open.map(projectNoteCard).join('')||'<p class="project-note-empty">No open to-dos. Add one when something needs a follow-up.</p>'}</section><details class="project-completed-todos"><summary>Completed to-dos (${done.length})</summary>${done.map(projectNoteCard).join('')||'<p class="project-note-empty">Completed to-dos will stay here. You can reopen them anytime.</p>'}</details><section aria-labelledby="project-saved-notes"><h4 id="project-saved-notes">Notes <span>${notes.length}</span></h4>${notes.map(projectNoteCard).join('')||'<p class="project-note-empty">No notes yet. Keep project updates and useful details here.</p>'}</section>`;
}
if(typeof module!=='undefined'&&module.exports)module.exports={projectNoteEscape,projectNoteTime,projectNoteCard,projectNotesList};
else {
  let sequence=0,active=null,identity='';
  function context(){return JSON.stringify([signedInCompanyId(),company?.id,currentUser?.id,currentUser?.role,currentUser?.memberId,currentUser?.projectIds,currentUser?.permissions,currentRole])}
  function permitted(){return Boolean(currentUser?.id&&['owner','admin','project_manager','foreman','field'].includes(currentUser.role))}
  function clear(){sequence++;if(active){active.controller?.abort();active.pane?.remove();active.tab?.remove();active.items=[];active.editor=null}active=null}
  function leaveProject(){clear();const dialog=$('#project-detail-modal');if(dialog?.open)dialog.close()}
  function current(state){return Boolean(active===state&&state.sequence===sequence&&state.identity===context()&&permitted()&&$('#project-detail-modal')?.open&&state.pane?.isConnected)}
  function message(state,text,error=false){if(!current(state))return;const node=state.pane.querySelector('[data-notes-message]');node.textContent=text;node.setAttribute('role',error?'alert':'status');node.hidden=!text}
  function busy(state,value){state.busy=value;state.pane.querySelectorAll('button').forEach(button=>button.disabled=value||(!state.loaded&&!button.hasAttribute('data-notes-refresh'))||(button.hasAttribute('data-notes-save')&&Boolean(state.editor?.latest)));state.pane.querySelector('[data-notes-text]').disabled=value}
  function paint(state){if(!current(state))return;state.pane.querySelector('[data-notes-list]').innerHTML=projectNotesList(state.items);const count=state.items.filter(item=>item.kind==='todo'&&!item.completed).length;state.tab.textContent=`Notes & To-dos${count?` (${count})`:''}`;busy(state,false)}
  function reviewLatest(state){
    const host=state.pane.querySelector('[data-notes-conflict]'),editor=state.editor,latest=editor?.id&&state.items.find(item=>item.id===editor.id);host.hidden=true;host.innerHTML='';
    if(!latest||latest.revision===editor.revision)return;editor.latest=latest;host.hidden=false;host.innerHTML=`<strong>This item changed. Latest saved version:</strong><p>${projectNoteEscape(latest.text)}</p><small>${latest.kind==='todo'?(latest.completed?'Completed':'Open')+' · ':''}${projectNoteEscape(latest.updatedBy)} · ${projectNoteEscape(projectNoteTime(latest.updatedAt))}</small><button type="button" class="secondary" data-notes-rebase>Use my draft with this version</button>`;
  }
  function cancelEditor(state){state.editor=null;const editor=state.pane.querySelector('[data-notes-editor]');editor.hidden=true;state.pane.querySelector('[data-notes-text]').value='';state.pane.querySelector('[data-note-new="note"]').focus({preventScroll:true})}
  async function refresh(state){
    if(!current(state)||state.busy)return;const request=++state.load;busy(state,true);message(state,'Loading notes & to-dos…');
    try{const result=await api(`/api/projects/${state.projectId}/notes-todos`,{signal:state.controller.signal,redirectOnUnauthorized:false});if(!current(state)||request!==state.load)return;state.items=result.items;state.loaded=true;paint(state);reviewLatest(state);message(state,'')}
    catch(error){if(!current(state)||request!==state.load)return;message(state,error.message==='Authentication required'?'Sign in to use Notes & To-dos.':`${error.message} Use Reload to try again.`,true)}
    finally{if(current(state)&&request===state.load)busy(state,false)}
  }
  function edit(state,item,kind){
    if(!current(state)||state.busy||!state.loaded)return;if(state.editor){message(state,'Save or Cancel your current draft before opening another.',true);return}state.editor=item?{id:item.id,kind:item.kind,revision:item.revision}:{kind,requestId:crypto.randomUUID()};
    state.pane.querySelector('[data-notes-editor]').hidden=false;state.pane.querySelector('[data-notes-editor-title]').textContent=`${item?'Edit':'Add'} ${state.editor.kind==='todo'?'to-do':'note'}`;
    const textarea=state.pane.querySelector('[data-notes-text]');textarea.value=item?.text||'';textarea.focus({preventScroll:true});reviewLatest(state);message(state,'');
  }
  async function save(state,item,completed,resolveCreate=false){
    if(!current(state)||state.busy||!state.loaded)return;const editor=state.editor,editing=!item;if(editing&&!editor)return;if(editing&&editor.latest){message(state,'Review the latest saved version before saving your draft.',true);return}
    const text=editing?state.pane.querySelector('[data-notes-text]').value.trim():null;
    if(editing&&!text){message(state,'Write a note or to-do before saving.',true);return}
    const recovering=editing&&!editor.id&&editor.attempt&&editor.attempt.text!==text;
    if(recovering&&!resolveCreate){const host=state.pane.querySelector('[data-notes-conflict]');host.hidden=false;host.innerHTML=`<strong>Check your earlier save first</strong><p>${projectNoteEscape(editor.attempt.text)}</p><button type="button" class="secondary" data-notes-resolve-create>Check original save</button>`;message(state,'The earlier save was not confirmed. Check it before saving changed text. Your newer draft will stay here.',true);return}
    const id=item?.id||editor?.id,payload=item?{revision:item.revision,completed}:editor.id?{revision:editor.revision,text}:editor.attempt||{kind:editor.kind,text,requestId:editor.requestId};if(editing&&!id)editor.attempt=payload;
    busy(state,true);message(state,'Saving…');
    try{const saved=await api(`/api/projects/${state.projectId}/notes-todos${id?'/'+encodeURIComponent(id):''}`,{method:id?'PATCH':'POST',body:JSON.stringify(payload),signal:state.controller.signal,redirectOnUnauthorized:false});if(!current(state))return;const index=state.items.findIndex(row=>row.id===saved.id);if(index<0)state.items.unshift(saved);else state.items[index]=saved;if(recovering){state.editor={id:saved.id,kind:saved.kind,revision:0};paint(state);reviewLatest(state);message(state,'Original save confirmed. Review its saved version before saving your newer draft.');state.pane.querySelector('[data-notes-text]').focus({preventScroll:true});return}if(editing)cancelEditor(state);paint(state);if(editing)state.pane.querySelector(`[data-note-new="${saved.kind}"]`).focus({preventScroll:true});message(state,item?(completed?'To-do completed.':'To-do reopened.'):'Saved.');if(item){const button=[...state.pane.querySelectorAll('[data-note-toggle]')].find(button=>button.dataset.noteToggle===saved.id);if(button){const group=button.closest('.project-completed-todos');if(group)group.open=true;button.focus({preventScroll:true})}}}
    catch(error){if(current(state)){if(editing&&!id){if(error.status===400&&!editor.ambiguous)delete editor.attempt;if(error.status==null||error.status>=500)editor.ambiguous=true;}const detail=/Nothing was saved|server could not be reached/i.test(error.message)?'The save could not be confirmed. Reload to check, or retry the same save.':/Someone changed this item/.test(error.message)?error.message+' Choose Reload to review the latest saved text.':error.message;message(state,`${detail}${editing?' Your draft is still here.':''}`,true)}}
    finally{if(current(state))busy(state,false)}
  }
  function wireTabs(){
    const tabs=$('#project-detail-content .project-detail-tabs');if(!tabs)return;tabs.setAttribute('role','tablist');tabs.setAttribute('aria-label','Project details');
    const buttons=[...tabs.querySelectorAll('[data-project-detail-tab]')],panes=[...$('#project-detail-content').querySelectorAll('[data-project-detail-pane]')];
    function sync(){for(const button of buttons){const key=button.dataset.projectDetailTab,selected=button.classList.contains('active');button.id='project-tab-'+key;button.setAttribute('role','tab');button.setAttribute('aria-controls','project-pane-'+key);button.setAttribute('aria-selected',String(selected));button.tabIndex=selected?0:-1}for(const pane of panes){pane.id='project-pane-'+pane.dataset.projectDetailPane;pane.setAttribute('role','tabpanel');pane.setAttribute('aria-labelledby','project-tab-'+pane.dataset.projectDetailPane);pane.tabIndex=0}}
    buttons.forEach(button=>button.addEventListener('click',()=>{buttons.forEach(tab=>tab.classList.toggle('active',tab===button));panes.forEach(pane=>pane.classList.toggle('active',pane.dataset.projectDetailPane===button.dataset.projectDetailTab));sync()}));
    tabs.onkeydown=event=>{const button=event.target.closest('[data-project-detail-tab]');if(!button||!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();let index=buttons.indexOf(button);index=event.key==='Home'?0:event.key==='End'?buttons.length-1:(index+(event.key==='ArrowRight'?1:-1)+buttons.length)%buttons.length;buttons[index].click();buttons[index].focus({preventScroll:true})};sync();
  }
  function mount(state){
    if(!permitted())return;const content=$('#project-detail-content'),tabs=content?.querySelector('.project-detail-tabs');if(!tabs)return;
    const tab=document.createElement('button');tab.type='button';tab.dataset.projectDetailTab='notes';tab.textContent='Notes & To-dos';tabs.append(tab);
    const pane=document.createElement('section');pane.className='project-detail-pane project-notes-pane';pane.dataset.projectDetailPane='notes';
    pane.innerHTML='<div class="project-notes-head"><div><h3>Notes & To-dos</h3><p>Shared with your team on this project. Changes stay in the history.</p></div><div class="project-notes-tools"><button type="button" class="secondary" data-note-new="note">＋ Note</button><button type="button" class="primary" data-note-new="todo">＋ To-do</button><button type="button" class="secondary" data-notes-refresh>Reload</button></div></div><div data-notes-editor class="project-notes-editor" hidden><label><span data-notes-editor-title>Add note</span><textarea data-notes-text maxlength="5000" rows="3" aria-describedby="project-notes-help"></textarea></label><div data-notes-conflict class="project-notes-conflict" hidden></div><small id="project-notes-help">Plain text · up to 5,000 characters · Ctrl/⌘ + Enter to save</small><div><button type="button" class="secondary" data-notes-cancel>Cancel</button><button type="button" class="primary" data-notes-save>Save</button></div></div><p data-notes-message role="status" aria-live="polite" hidden></p><div data-notes-list></div>';
    content.append(pane);state.pane=pane;state.tab=tab;
    pane.addEventListener('click',event=>{const button=event.target.closest('button');if(!button||button.disabled||!current(state))return;if(button.hasAttribute('data-notes-refresh'))return refresh(state);if(button.hasAttribute('data-note-new'))return edit(state,null,button.dataset.noteNew);if(button.hasAttribute('data-notes-cancel'))return cancelEditor(state);if(button.hasAttribute('data-notes-save'))return save(state);if(button.hasAttribute('data-notes-resolve-create'))return save(state,null,undefined,true);if(button.hasAttribute('data-notes-rebase')&&state.editor?.latest){state.editor.revision=state.editor.latest.revision;delete state.editor.latest;reviewLatest(state);busy(state,false);message(state,'Latest version reviewed. Save to apply your draft.');state.pane.querySelector('[data-notes-text]').focus({preventScroll:true});return}const item=state.items.find(row=>row.id===(button.dataset.noteEdit||button.dataset.noteToggle));if(!item)return;if(button.hasAttribute('data-note-edit'))return edit(state,item);if(button.hasAttribute('data-note-toggle'))return save(state,item,!item.completed)});
    pane.addEventListener('keydown',event=>{if(event.target.matches('[data-notes-text]')&&event.key==='Enter'&&(event.ctrlKey||event.metaKey)){event.preventDefault();void save(state)}});
    wireTabs();void refresh(state);
  }
  const previousOpenProject=openProject;
  openProject=async function(id){
    clear();identity=context();const state={sequence,identity,projectId:Number(id),items:[],editor:null,load:0,loaded:false,busy:false,controller:new AbortController()};active=state;
    const view={current:()=>active===state&&state.sequence===sequence&&state.identity===context()};
    const result=await previousOpenProject(id,view);if(!view.current()||!$('#project-detail-modal')?.open)return result;mount(state);return result;
  };
  const previousRenderEverything=renderEverything;
  renderEverything=function(){if(identity!==context()){leaveProject();identity=context()}return previousRenderEverything()};
  const previousLoadRole=loadRole;
  loadRole=async function(...args){leaveProject();return previousLoadRole(...args)};
  const previousShowPage=showPage;
  showPage=function(...args){if(active)leaveProject();return previousShowPage(...args)};
  $('#project-detail-modal')?.addEventListener('close',clear);
  $('#project-detail-modal')?.addEventListener('cancel',clear);
  document.addEventListener('click',event=>{if(event.target.closest('#logout-button,#profile-logout-button,#subscription-lock-logout'))leaveProject()},{capture:true});
  window.addEventListener('pagehide',clear);
  window.addEventListener('popstate',leaveProject);
  window.addEventListener('hashchange',leaveProject);
  window.addEventListener('storage',event=>{if(['pdl-company-id','pdl-role'].includes(event.key))leaveProject()});
}
