/* Conversation-first views over the existing authorized project messages. */
(()=>{
  'use strict';
  const page=document.querySelector('#messages-page');
  if(!page)return;
  const compose=page.querySelector('.msg-new-panel');
  compose.hidden=true;
  const heading=page.querySelector('.page-heading');
  heading.querySelector('h1').textContent='MESSAGES';
  heading.querySelector('div>p:last-child').textContent='Keep the job conversation together.';
  const newButton=document.createElement('button');
  newButton.type='button';newButton.className='primary';newButton.textContent='New message';newButton.setAttribute('aria-expanded','false');
  heading.append(newButton);
  const cancel=document.createElement('button');cancel.type='button';cancel.className='secondary';cancel.textContent='Cancel';compose.querySelector('.modal-actions').prepend(cancel);
  function toggleCompose(open){compose.hidden=!open;newButton.setAttribute('aria-expanded',String(open));if(open)document.querySelector('#msg-project').focus();else newButton.focus();}
  newButton.onclick=()=>toggleCompose(compose.hidden);cancel.onclick=()=>toggleCompose(false);
  const search=document.createElement('input');search.type='search';search.placeholder='Search jobs or messages';search.setAttribute('aria-label','Search conversations');
  page.querySelector('.msg-list-panel .panel-header').after(search);
  const unread=document.createElement('button');unread.type='button';unread.className='secondary';unread.textContent='Unread';unread.setAttribute('aria-pressed','false');search.after(unread);
  function filter(){const q=search.value.trim().toLowerCase();page.querySelectorAll('[data-msg-project]').forEach(el=>{const rows=messagesForProject(Number(el.dataset.msgProject));el.hidden=!(el.textContent+' '+rows.map(m=>m.text).join(' ')).toLowerCase().includes(q)||(unread.getAttribute('aria-pressed')==='true'&&!el.querySelector('.msg-unread'));});}
  search.oninput=filter;unread.onclick=()=>{unread.setAttribute('aria-pressed',String(unread.getAttribute('aria-pressed')!=='true'));filter();};
  const back=document.createElement('button');back.type='button';back.className='secondary msg-back';back.textContent='← Conversations';page.querySelector('.msg-convo-panel .panel-header').prepend(back);back.onclick=()=>{page.classList.remove('thread-open');page.querySelector('[data-msg-project].active')?.focus();};
  const originalRender=renderMessages;
  renderMessages=function(){originalRender();filter();};
  const originalOpen=openMessageThread;
  openMessageThread=async function(id){page.classList.add('thread-open');await originalOpen(id);document.querySelector('#msg-reply-text').focus({preventScroll:true});};
  page.querySelector('.msg-convo-panel .panel-header p').textContent='Replies go to the whole crew on this job.';
  const originalThread=renderMessageThread;
  renderMessageThread=function(){originalThread();const rows=messagesForProject(activeMessageProject);page.querySelectorAll('.msg-bubble small').forEach((el,i)=>{const m=rows[i];if(!m)return;const to=m.sender==='office'?(m.memberId==null?'Whole crew':team.find(t=>Number(t.id)===Number(m.memberId))?.name||'One person'):'Office';el.textContent=`${m.senderName} → ${to} · ${msgTime(m.createdAt)}`;});};
  const originalSend=document.querySelector('#msg-send-new').onclick;
  document.querySelector('#msg-send-new').onclick=async function(){await originalSend.call(this);if(!document.querySelector('#msg-new-text').value&&activeMessageProject){compose.hidden=true;newButton.setAttribute('aria-expanded','false');page.classList.add('thread-open');}};

  // Replace the single latest-project reply box with explicit job selection.
  let fieldProject=null;
  const originalMyDay=renderMyDay;
  renderMyDay=function(){originalMyDay();renderFieldInbox();};
  function renderFieldInbox(){
    const host=document.querySelector('#field-messages');if(!host)return;
    const member=Number(currentUser?.memberId),tag='m:'+member;
    const rows=(projectMessages||[]).filter(m=>m.memberId==null||Number(m.memberId)===member);
    host.hidden=!rows.length;if(!rows.length)return;
    const ids=[...new Set(rows.slice().sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt))).map(m=>Number(m.projectId)))];
    if(!ids.includes(fieldProject))fieldProject=null;
    const es=preferredLanguage==='es';
    host.innerHTML=`<div class="field-inbox"><h2>${es?'MENSAJES':'MESSAGES'}</h2>${fieldProject==null?ids.map(id=>{const list=rows.filter(m=>Number(m.projectId)===id),last=list.at(-1),count=list.filter(m=>m.sender==='office'&&!(m.readBy||[]).includes(tag)).length;return `<button type="button" class="msg-thread-item" data-field-thread="${id}"><span><strong>${escapeHtml(messageProjectName(id))}</strong><small>${escapeHtml(last.text)}</small></span>${count?`<em class="msg-unread">${count}</em>`:''}</button>`;}).join(''):`<button type="button" class="secondary" data-field-back>${es?'← Conversaciones':'← Conversations'}</button><h3>${escapeHtml(messageProjectName(fieldProject))}</h3><div class="msg-thread-body">${rows.filter(m=>Number(m.projectId)===fieldProject).map(m=>`<div class="msg-bubble-row ${m.sender==='field'?'from-office':'from-field'}"><div class="msg-bubble"><small>${escapeHtml(m.senderName)} · ${msgTime(m.createdAt)}</small><p>${escapeHtml(m.text)}</p></div></div>`).join('')}</div><form class="msg-reply-row"><label>${es?'Responder':'Reply'}<textarea rows="2" maxlength="1000" required></textarea></label><button class="primary" type="submit">${es?'Enviar':'Send'}</button></form><p role="alert" class="field-message-error"></p>`}</div>`;
    host.querySelectorAll('[data-field-thread]').forEach(button=>button.onclick=async()=>{fieldProject=Number(button.dataset.fieldThread);const openedProject=fieldProject;renderFieldInbox();try{await api(`/api/projects/${openedProject}/messages/read`,{method:'POST',body:'{}'});rows.filter(m=>Number(m.projectId)===openedProject&&m.sender==='office').forEach(m=>{m.readBy ||= [];if(!m.readBy.includes(tag))m.readBy.push(tag);});}catch{/* Sending remains available when read marking fails. */}});
    const back=host.querySelector('[data-field-back]');if(back)back.onclick=()=>{fieldProject=null;renderFieldInbox();};
    const form=host.querySelector('form');if(form)form.onsubmit=async event=>{event.preventDefault();const input=form.querySelector('textarea'),text=input.value.trim(),id=fieldProject,button=form.querySelector('button');if(!text)return;button.disabled=true;try{await sendProjectMessage(id,member,text);renderFieldInbox();}catch(error){host.querySelector('[role=alert]').textContent=error.message;button.disabled=false;}};
  }
})();
