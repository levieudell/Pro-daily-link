const headerActions=document.querySelector('.header-actions');
const trialButton=headerActions?.querySelector('a[href="/signup.html"]');
if(headerActions&&trialButton){
  const demoButton=document.createElement('a');
  demoButton.className='button ghost small header-demo';
  demoButton.href='#book-demo';
  demoButton.textContent='Book a demo';
  headerActions.insertBefore(demoButton,trialButton);
}

const heroActions=document.querySelector('.hero-actions');
if(heroActions){
  const workflowButton=heroActions.querySelector('a[href="#demo"]');
  if(workflowButton){
    workflowButton.className='workflow-link';
    workflowButton.textContent='See the workflow →';
  }
  const demoButton=document.createElement('a');
  demoButton.className='button ghost';
  demoButton.href='#book-demo';
  demoButton.textContent='Book a demo';
  heroActions.insertBefore(demoButton,workflowButton);
}

const faq=document.querySelector('#faq');
if(faq){
  const section=document.createElement('section');
  section.id='book-demo';
  section.className='section book-demo';
  section.innerHTML=`<div class="demo-intro"><p class="eyebrow">SEE IT WITH YOUR WORKFLOW</p><h2>Book a personal demo.</h2><p>Tell us a little about your company and when you would like to meet. We’ll confirm a time and walk through field dailies, production tracking, scheduling, and office review using the parts that matter to your team.</p><ul><li>30-minute guided walkthrough</li><li>Questions specific to your crews and projects</li><li>No sales pressure and no credit card</li></ul></div><form id="demo-request-form" class="demo-form"><div class="form-two"><label>Your name<input name="name" autocomplete="name" maxlength="120" required></label><label>Work email<input name="email" type="email" autocomplete="email" maxlength="180" required></label></div><div class="form-two"><label>Company<input name="company" autocomplete="organization" maxlength="160" required></label><label>Phone <span>(optional)</span><input name="phone" type="tel" autocomplete="tel" maxlength="40"></label></div><div class="form-two"><label>Company size<select name="companySize"><option value="">Choose one</option><option>1–10 employees</option><option>11–30 employees</option><option>31–75 employees</option><option>76+ employees</option></select></label><label>Preferred meeting time<input name="preferredTime" type="datetime-local"></label></div><label>What would you most like to see?<textarea name="notes" rows="4" maxlength="1500" placeholder="For example: daily reports, production by crew, scheduling, or change work"></textarea></label><label class="website-field" aria-hidden="true">Website<input name="website" tabindex="-1" autocomplete="off"></label><button class="button" type="submit">Request my demo</button><p id="demo-form-status" class="form-status" role="status" aria-live="polite">We’ll contact you to confirm the meeting time.</p></form>`;
  faq.before(section);
}

const finalCta=document.querySelector('.cta>div');
if(finalCta){
  const demoButton=document.createElement('a');
  demoButton.className='button cta-demo';
  demoButton.href='#book-demo';
  demoButton.textContent='Book a demo';
  finalCta.insertBefore(demoButton,finalCta.querySelector('.login'));
}

const demoForm=document.querySelector('#demo-request-form');
const demoStatus=document.querySelector('#demo-form-status');
const workflowButton=document.querySelector('#workflow-example-next');
const workflowFields=document.querySelector('#workflow-example-fields');
const workflowTitle=document.querySelector('#workflow-example-title');
const workflowNote=document.querySelector('#workflow-example-note');
const workflowResult=document.querySelector('#workflow-example-result');
const workflowSteps=[...document.querySelectorAll('.demo-steps b')];
let workflowStage=0;
function renderWorkflowExample(){
  workflowSteps.forEach((step,index)=>step.classList.toggle('active',index===workflowStage));
  if(workflowStage===0){
    workflowTitle.textContent='Field note';workflowNote.hidden=false;workflowFields.hidden=true;
    workflowResult.textContent='Start with the note exactly as the field might send it.';
    workflowButton.textContent='Organize this sample →';
  }else if(workflowStage===1){
    workflowTitle.textContent='Organized report';workflowNote.hidden=true;workflowFields.hidden=false;
    workflowResult.textContent='The note is structured for verification. Labor is captured; quantity stays pending until it is measured.';
    workflowButton.textContent='Show office review →';
  }else{
    workflowTitle.textContent='Office review';workflowNote.hidden=true;workflowFields.hidden=false;
    workflowResult.innerHTML='<strong>Ready for review.</strong> The office can correct hours, add the measured quantity, resolve extra work, and approve the daily before project production changes.';
    workflowButton.textContent='Restart sample';
  }
}
workflowButton?.addEventListener('click',()=>{workflowStage=(workflowStage+1)%3;renderWorkflowExample()});

document.querySelectorAll('[data-implementation]').forEach(link=>link.addEventListener('click',()=>{
  const name=link.dataset.implementation;
  requestAnimationFrame(()=>{
    const notes=demoForm?.elements.namedItem('notes');
    if(notes&&!notes.value)notes.value=`I would like to discuss ${name} for our team.`;
    if(demoStatus)demoStatus.textContent=`Tell us about your team. We’ll confirm the ${name} scope and price before anything is scheduled or billed.`;
  });
}));
demoForm?.addEventListener('submit',async event=>{
  event.preventDefault();
  const button=demoForm.querySelector('button[type="submit"]');
  const payload=Object.fromEntries(new FormData(demoForm).entries());
  button.disabled=true;button.textContent='Sending…';demoStatus.className='form-status';demoStatus.textContent='Sending your request…';
  try{
    const response=await fetch('/api/demo-requests',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
    const result=await response.json();
    if(!response.ok)throw new Error(result.error||'We could not send your request.');
    demoForm.reset();demoStatus.className='form-status success';demoStatus.textContent='Your demo request is in. We’ll contact you shortly to confirm the time.';
  }catch(error){demoStatus.className='form-status error';demoStatus.textContent=error.message||'We could not send your request. Please try again.'}
  finally{button.disabled=false;button.textContent='Request my demo'}
});
