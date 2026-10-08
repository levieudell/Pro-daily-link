(function(){
  'use strict';
  const sessions=new Map();
  window.renderHelpConversation=function(host,enabled){
    if(!enabled)return;
    const identity=JSON.stringify([company.id,currentUser?.id,currentUser?.role]);
    let session=sessions.get(identity);if(!session){session={state:null,turnId:null,text:null,busy:false,messages:[]};sessions.clear();sessions.set(identity,session)}
    const section=document.createElement('section'),heading=document.createElement('h3');section.id='help-conversation-panel';heading.textContent='Ask PDL Help (evaluation)';
    const disclosure=document.createElement('p');disclosure.textContent='General product questions only. AI sends your question, recent conversation, role and verified product help to OpenAI. Do not enter private job details, contact information or credentials. It cannot access or change your account.';
    const log=document.createElement('div');log.setAttribute('role','log');log.setAttribute('aria-label','Help conversation');
    function render(){log.replaceChildren();for(const message of session.messages){const p=document.createElement('p');p.textContent=message;log.append(p)}}render();
    const label=document.createElement('label'),question=document.createElement('textarea');label.textContent='Your product question';question.maxLength=2000;question.rows=3;question.value=session.text||'';label.append(question);
    const consentLabel=document.createElement('label'),consent=document.createElement('input');consent.type='checkbox';consentLabel.className='check-row';consentLabel.append(consent,document.createTextNode('I agree to send this general question and conversation to OpenAI.'));
    const send=document.createElement('button'),reset=document.createElement('button'),status=document.createElement('p');status.setAttribute('role','status');send.type=reset.type='button';send.textContent='Ask Help';reset.textContent='Start new conversation';send.className=reset.className='secondary';send.disabled=reset.disabled=session.busy;
    reset.onclick=()=>{session.state=null;session.turnId=null;session.text=null;session.messages=[];question.value='';status.textContent='New conversation started.';render()};
    send.onclick=async()=>{
      if(session.busy)return;if(!question.value.trim()||!consent.checked){status.textContent='Enter a general question and agree to the data disclosure.';return}
      const text=question.value.trim();if(session.text!==text){session.turnId=crypto.randomUUID();session.text=text}session.busy=true;send.disabled=reset.disabled=true;status.textContent='Checking verified product help…';
      try{
        const result=await api('/api/help/conversation',{method:'POST',body:JSON.stringify({text,state:session.state,turnId:session.turnId,consent:true})});
        if(identity!==JSON.stringify([company.id,currentUser?.id,currentUser?.role]))return;
        const topics={'project-setup':'Project setup','crew-access':'Crew and login access','daily-review':'Daily reports','field-scope':'Assigned work','help-preferences':'Help preferences'};
        session.messages.push('You: '+text,'PDL Help: '+result.answer+(result.clarification?'\n'+result.clarification:'')+(result.sourceIds.length?'\nVerified topics: '+result.sourceIds.map(id=>topics[id]||'Product help').join(', '):'')+(result.escalate?'\nContact Support or your Account Owner for the next step.':''));session.state=result.state;session.turnId=null;session.text=null;question.value='';status.textContent='Answer ready. Review it before taking any action.';render();
      }catch(error){status.textContent=error.message}finally{session.busy=false;send.disabled=reset.disabled=false}
    };
    section.append(heading,disclosure,log,label,consentLabel,send,reset,status);host.append(section);
  };
})();
