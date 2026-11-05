const $=selector=>document.querySelector(selector);
const params=new URLSearchParams(location.search),requestedPlan=params.get('plan'),requestedCycle=params.get('cycle')==='monthly'?'monthly':'annual';
const signupAttribution={
  utmSource:String(params.get('utm_source')||'').trim().slice(0,160),
  utmMedium:String(params.get('utm_medium')||'').trim().slice(0,160),
  utmCampaign:String(params.get('utm_campaign')||'').trim().slice(0,160),
  referrer:String(document.referrer||'').slice(0,2048),
  landingPage:`${location.pathname}${location.search}`.slice(0,2048)
};
let createdCompanyId=null,founderOffer=null;
let currentStep=1,planWasRequested=['starter','growth','pro'].includes(requestedPlan);

function showStep(step){
  currentStep=step;
  document.documentElement.classList.add('wizard-enabled');
  document.querySelectorAll('.signup-step').forEach(section=>{const active=Number(section.dataset.step)===step;section.hidden=!active;section.classList.toggle('active',active);});
  document.querySelectorAll('.signup-progress button').forEach(button=>{
    const number=Number(button.dataset.go);
    button.classList.toggle('complete',number<step);
    if(number===step)button.setAttribute('aria-current','step');else button.removeAttribute('aria-current');
  });
  $('#result').textContent='';
  window.scrollTo({top:0,behavior:'smooth'});
}

function validateTrade(){
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
  const fields=['#company','#owner','#email','#password'].map($);
  for(const field of fields)if(!field.reportValidity())return false;
  return true;
}

function recommend(){
  const people=+$('#employees').value;
  const projects=+$('#projects').value;
  if(!people&&!projects){
    $('#recommendation').textContent=planWasRequested?`Selected from pricing: ${requestedPlan[0].toUpperCase()+requestedPlan.slice(1)}.`:'Choose the plan that fits now. You can change it before checkout.';
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

  if(!validateTrade()){
    showStep(2);
    $('#result').textContent='Select your trade.';
    return;
  }
  button.disabled=true;
  $('#result').textContent=createdCompanyId?'Opening secure checkout…':'Creating your account…';
  try{
    if(createdCompanyId){await continueToPayment();return;}
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
        founderCode:$('#founder-code').value.trim(),
        founderTermsAccepted:$('#founder-terms').checked,
        assistedSetup:$('#assisted-setup').checked,
        legalAccepted:$('#legal-acceptance').checked,
        legalVersion:'2026-11-03',
        timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,
        ...signupAttribution
      })
    });
    const data=await response.json();
    if(!response.ok)throw new Error(data.error);
    if(typeof fbq==='function')fbq('track','Signup');
    localStorage.setItem('pdl-company-id',data.company.id);
    createdCompanyId=data.company.id;
    $('#password').value='';
    $('#signup').noValidate=true;
    $('#checkout-resume').href='/app?tenant='+encodeURIComponent(createdCompanyId);
    $('#checkout-resume').hidden=false;
    document.querySelectorAll('.signup-progress button,[data-back],#signup input,#signup select').forEach(control=>control.disabled=true);
    await continueToPayment();
  }catch(error){
    $('#result').textContent=error.message;
    button.disabled=false;
    if(createdCompanyId)button.textContent='Try checkout again';
  }
};

if(planWasRequested)document.querySelector(`[name="plan"][value="${requestedPlan}"]`).checked=true;
document.querySelector(`[name="billingCycle"][value="${requestedCycle}"]`).checked=true;
recommend();
showStep(1);


function updateFounderOffer(){
  const active=Boolean(founderOffer?.enabled && $('#founder-code').value.trim());
  $('#founder-options').hidden=!active;
  $('#founder-terms').required=active;
  $('#assisted-setup').disabled=!active||!founderOffer?.setupAvailable;
  if(!active){$('#assisted-setup').checked=false;$('#founder-terms').checked=false;}
  $('#signup-offer-heading').textContent=active?'Founder membership · payment required · no free trial':'Try Pro Daily Link free for 7 days.';
  $('#plan-offer-help').textContent=active?'Pay monthly or annually. Your selected founder price is protected for 24 months from first payment.':'7-day free trial. Card required. Cancel anytime before day 7 and you won’t be charged.';
  $('#monthly-cycle-label').textContent=active?'Monthly — pay today':'Monthly — after trial';
  $('#annual-cycle-label').textContent=active?'Annual — pay today · two months free':'Annual — after trial · two months free';
  $('#create-company').textContent=active?'Continue to secure payment':'Start your 7-day trial';
  document.querySelectorAll('.trial-disclosure').forEach(el=>el.hidden=active);
  $('#payment-heading').textContent=active?'Review & pay':'Review & start trial';
  $('#checkout-access-help').textContent=active?'Secure checkout with Stripe. Your workspace opens after payment is confirmed.':'Secure checkout with Stripe. Your workspace opens once your card is saved.';
  const standard={starter:[99,990,'10 users · 5 active projects'],growth:[199,1990,'30 users · 25 active projects'],pro:[399,3990,'75 users · unlimited projects']};
  const annual=document.querySelector('[name="billingCycle"]:checked').value==='annual';
  for(const [id,values] of Object.entries(standard)){
    const card=document.querySelector('[name="plan"][value="'+id+'"]').closest('label');
    const monthly=active?founderOffer.prices[id].monthly:values[0],yearly=active?founderOffer.prices[id].annual:values[1];
    card.querySelector('strong').textContent='$'+(annual?yearly:monthly).toLocaleString()+(annual?'/year':'/mo');
    card.querySelector('small').textContent=(annual?'or $':'$')+(annual?monthly:yearly).toLocaleString()+(annual?'/mo billed monthly':'/year')+' · '+values[2];
  }
  const plan=document.querySelector('[name="plan"]:checked').value;
  const amount=annual?(active?founderOffer.prices[plan].annual:standard[plan][1]):(active?founderOffer.prices[plan].monthly:standard[plan][0]);
  $('#payment-summary').textContent=`${plan[0].toUpperCase()+plan.slice(1)} · $${amount.toLocaleString()} per ${annual?'year':'month'}. ${active?'Charged today at checkout':'Automatically billed after your 7-day trial unless canceled'}${active&&$('#assisted-setup').checked?' + $499 one-time setup charged today':''}. Taxes, if applicable, are shown before you pay.`;
  $('#founder-renewal').textContent='Before the 24-month founder period ends, we will contact you to review renewal options. Your price will not automatically jump to the regular rate. Optional setup is charged only once. Taxes, if applicable, are shown at checkout.';
}
$('#assisted-setup').addEventListener('change',updateFounderOffer);
$('#founder-code').addEventListener('input',updateFounderOffer);
document.querySelectorAll('[name="plan"],[name="billingCycle"]').forEach(el=>el.addEventListener('change',updateFounderOffer));
fetch('/api/founder-offer').then(response=>response.json()).then(offer=>{founderOffer=offer;$('#founder-invitation').hidden=!offer.enabled;updateFounderOffer()}).catch(()=>{});

document.querySelectorAll('[data-show-password]').forEach(button=>{
  button.onclick=()=>{
    const field=document.getElementById(button.dataset.showPassword);
    if(!field)return;
    const show=field.type==='password';
    field.type=show?'text':'password';
    button.textContent=show?'Hide':'Show';
    button.setAttribute('aria-label',show?'Hide password':'Show password');
  };
});

async function continueToPayment(){
  const response=await fetch('/api/billing/checkout',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json','x-pdl-company':createdCompanyId},body:JSON.stringify({plan:document.querySelector('[name="plan"]:checked').value,billingCycle:document.querySelector('[name="billingCycle"]:checked').value})});
  const payment=await response.json();if(!response.ok)throw new Error(payment.error||'Checkout could not be opened. Try again.');
  const url=new URL(payment.url);if(url.protocol!=='https:'||url.hostname!=='checkout.stripe.com')throw new Error('Checkout could not be verified. Try again.');
  location.replace(url.href);
}
updateFounderOffer();
