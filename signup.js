const $=selector=>document.querySelector(selector);
const params=new URLSearchParams(location.search),requestedPlan=params.get('plan');
let founderOffer=null,annualOffer=null;
let currentStep=1,planWasRequested=['starter','growth','pro'].includes(requestedPlan);

function showStep(step){
  currentStep=step;
  document.documentElement.classList.add('wizard-enabled');
  document.querySelectorAll('.signup-step').forEach(section=>section.classList.toggle('active',Number(section.dataset.step)===step));
  document.querySelectorAll('.signup-progress button').forEach(button=>{
    const number=Number(button.dataset.go);
    button.classList.toggle('complete',number<step);
    if(number===step)button.setAttribute('aria-current','step');else button.removeAttribute('aria-current');
  });
  $('#result').textContent='';
  window.scrollTo({top:0,behavior:'smooth'});
}

function emailsMatch(){
  const email=$('#email'),confirm=$('#confirm-email');
  if(email.value.trim().toLowerCase()!==confirm.value.trim().toLowerCase()){
    confirm.setCustomValidity('Check the email spelling. The two addresses do not match.');
    return false;
  }
  confirm.setCustomValidity('');
  return true;
}

function validateTrade(){
  if($('#annual-upfront').checked&&!$('#annual-upfront-terms').checked){showStep(2);$('#annual-upfront-terms').reportValidity();return false;}
  const trade=$('#trade');
  if(!String(trade.value||'').trim()){
    trade.setCustomValidity('Select your trade.');
    trade.reportValidity();
    return false;
  }
  trade.setCustomValidity('');
  return true;
}

function validateStepOne(){
  const fields=['#company','#owner','#email','#confirm-email','#password','#confirm-password'].map($);
  for(const field of fields)if(!field.reportValidity())return false;
  if(!emailsMatch()){$('#confirm-email').reportValidity();return false}
  if($('#password').value!==$('#confirm-password').value){
    $('#confirm-password').setCustomValidity('Passwords do not match.');
    $('#confirm-password').reportValidity();
    return false;
  }
  $('#confirm-password').setCustomValidity('');
  return true;
}

function recommend(){
  const people=+$('#employees').value;
  const projects=+$('#projects').value;
  if(!people&&!projects){
    $('#recommendation').textContent=planWasRequested?`Selected from pricing: ${requestedPlan[0].toUpperCase()+requestedPlan.slice(1)}.`:'Choose the plan that fits now. You can change it before the trial ends.';
    return;
  }
  const plan=people<=10&&projects<=5?'starter':people<=30&&projects<=25?'growth':'pro';
  $('#recommendation').textContent=`Recommended: ${plan[0].toUpperCase()+plan.slice(1)} based on your team and active projects.`;
  document.querySelector(`[value="${plan}"]`).checked=true;
  planWasRequested=false;
  updateFounderOffer();
}

$('#trade').onchange=()=>$('#trade').setCustomValidity('');
$('#employees').oninput=recommend;
$('#projects').oninput=recommend;
$('#confirm-password').oninput=()=>$('#confirm-password').setCustomValidity('');
$('#email').oninput=$('#confirm-email').oninput=()=>$('#confirm-email').setCustomValidity('');
document.querySelectorAll('[data-next]').forEach(button=>button.onclick=()=>{
  if(currentStep===1&&!validateStepOne())return;
  if(currentStep===2&&!validateTrade())return;
  showStep(Number(button.dataset.next));
});
document.querySelectorAll('[data-back]').forEach(button=>button.onclick=()=>showStep(Number(button.dataset.back)));
document.querySelectorAll('.signup-progress button').forEach(button=>button.onclick=()=>{
  const destination=Number(button.dataset.go);
  if(destination>currentStep&&currentStep===1&&!validateStepOne())return;
  if(destination>2&&currentStep<=2&&!validateTrade())return;
  if(destination<=currentStep||destination===currentStep+1)showStep(destination);
});
$('#signup').onsubmit=async event=>{
  event.preventDefault();
  const button=$('#create-company');
  const password=$('#password').value;
  if(!emailsMatch()){$('#confirm-email').reportValidity();return}
  if(password!==$('#confirm-password').value){
    $('#result').textContent='Passwords do not match.';
    return;
  }
  if(!validateTrade()){
    showStep(2);
    $('#result').textContent='Select your trade.';
    return;
  }
  button.disabled=true;
  $('#result').textContent='Creating your secure workspace…';
  try{
    const response=await fetch('/api/signup',{
      method:'POST',
      credentials:'include',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({
        companyName:$('#company').value,
        trade:$('#trade').value,
        ownerName:$('#owner').value,
        email:$('#email').value,
        password,
        employeeCount:+$('#employees').value,
        projectCount:+$('#projects').value,
        plan:document.querySelector('[name="plan"]:checked').value,
        billingCycle:document.querySelector('[name="billingCycle"]:checked').value,
        onboardingPreference:document.querySelector('[name="onboarding"]:checked').value,
        annualUpfront:$('#annual-upfront').checked,
        annualUpfrontTermsAccepted:$('#annual-upfront-terms').checked,
        founderCode:$('#founder-code').value.trim(),
        founderTermsAccepted:$('#founder-terms').checked,
        assistedSetup:$('#assisted-setup').checked,
        legalAccepted:$('#legal-acceptance').checked,
        legalVersion:'2026-09-17',
        timezone:Intl.DateTimeFormat().resolvedOptions().timeZone
      })
    });
    const data=await response.json();
    if(!response.ok)throw new Error(data.error);
    localStorage.setItem('pdl-company-id',data.company.id);
    if(data.company.founder||data.company.annualUpfront){
      try{
        const checkout=await fetch('/api/billing/checkout',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json','x-pdl-company':data.company.id},body:JSON.stringify({plan:document.querySelector('[name="plan"]:checked').value,billingCycle:document.querySelector('[name="billingCycle"]:checked').value})});
        const payment=await checkout.json();if(!checkout.ok)throw new Error(payment.error);
        location.replace(payment.url);return;
      }catch{location.replace('/app?tenant='+encodeURIComponent(data.company.id));return;}
    }
    location.replace(`${data.next||`/app?tenant=${encodeURIComponent(data.company.id)}`}#dashboard`);
  }catch(error){
    $('#result').textContent=error.message;
    button.disabled=false;
  }
};

if(planWasRequested)document.querySelector(`[name="plan"][value="${requestedPlan}"]`).checked=true;
recommend();
showStep(1);


function updateFounderOffer(){
  const active=Boolean(founderOffer?.enabled && $('#founder-code').value.trim());
  const yearly=document.querySelector('[name="billingCycle"]:checked').value==='annual';
  $('#annual-upfront-choice').hidden=!annualOffer?.enabled||active||!yearly;
  if(active||!yearly||!annualOffer?.enabled){$('#annual-upfront').checked=false;$('#annual-upfront-terms').checked=false;}
  if(!$('#annual-upfront').checked)$('#annual-upfront-terms').checked=false;
  const upfront=$('#annual-upfront').checked,selected=document.querySelector('[name="plan"]:checked').value,a=annualOffer?.amounts[selected];
  $('#annual-upfront-consent').hidden=!upfront;$('#annual-upfront-terms').required=upfront;
  $('#annual-upfront-summary').textContent=a?`Pay $${a.first.toLocaleString()} today for year one. No free trial. Renews at $${a.renewal.toLocaleString()} per year until cancelled. Taxes, if applicable, are additional.`:'';
  $('#founder-options').hidden=!active;
  $('#founder-terms').required=active;
  $('#assisted-setup').disabled=!active||!founderOffer?.setupAvailable;
  if(!active){$('#assisted-setup').checked=false;$('#founder-terms').checked=false;}
  $('#signup-offer-heading').textContent=active?'Founder membership · payment required · no free trial':'Start your 14-day trial · no credit card';
  $('#plan-offer-help').textContent=active?'Pay monthly or annually. Your selected founder price is protected for 24 months from first payment.':'Nothing is charged today. Choose monthly, or pay annually and receive two months free.';
  $('#monthly-cycle-label').textContent=active?'Monthly — pay today':'Monthly after trial';
  $('#annual-cycle-label').textContent=active?'Annual — pay today · two months free':'Annual after trial · two months free';
  $('#create-company').textContent=active?'Create company & continue to payment':'Create company';
  const standard={starter:[99,990,'10 users · 5 active projects'],growth:[199,1990,'30 users · 25 active projects'],pro:[399,3990,'75 users · unlimited projects']};
  for(const [id,values] of Object.entries(standard)){
    const card=document.querySelector('[name="plan"][value="'+id+'"]').closest('label');
    card.querySelector('strong').textContent='$'+(active?founderOffer.prices[id].monthly:values[0])+'/mo';
    card.querySelector('small').textContent='$'+(active?founderOffer.prices[id].annual:values[1]).toLocaleString()+'/year · '+values[2];
  }
  if(upfront){$('#signup-offer-heading').textContent='Annual upfront — pay today, no free trial';$('#plan-offer-help').textContent=$('#annual-upfront-summary').textContent;$('#annual-cycle-label').textContent='Annual — pay today';$('#create-company').textContent='Create company & continue to payment';}
  const plan=document.querySelector('[name="plan"]:checked').value,annual=document.querySelector('[name="billingCycle"]:checked').value==='annual';
  $('#founder-renewal').textContent='Before the 24-month founder period ends, we will contact you to review renewal options. Your price will not automatically jump to the regular rate. Optional setup is charged only once. Taxes, if applicable, are shown at checkout.';
}
$('#founder-code').addEventListener('input',updateFounderOffer);
$('#annual-upfront').addEventListener('change',updateFounderOffer);
fetch('/api/annual-upfront-offer').then(r=>r.json()).then(offer=>{annualOffer=offer;updateFounderOffer()}).catch(()=>{});
document.querySelectorAll('[name="plan"],[name="billingCycle"]').forEach(el=>el.addEventListener('change',updateFounderOffer));
fetch('/api/founder-offer').then(response=>response.json()).then(offer=>{founderOffer=offer;$('#founder-invitation').hidden=!offer.enabled;updateFounderOffer()}).catch(()=>{});
