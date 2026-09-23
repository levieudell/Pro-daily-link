const $=selector=>document.querySelector(selector);
let currentStep=1;

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

function validateStepOne(){
  const fields=['#company','#owner','#email','#password','#confirm-password'].map($);
  for(const field of fields)if(!field.reportValidity())return false;
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
  const plan=people<=10&&projects<=5?'starter':people<=30&&projects<=25?'growth':'pro';
  $('#recommendation').textContent=`Recommended: ${plan[0].toUpperCase()+plan.slice(1)} based on your team and active projects.`;
  document.querySelector(`[value="${plan}"]`).checked=true;
}

$('#employees').oninput=recommend;
$('#projects').oninput=recommend;
$('#confirm-password').oninput=()=>$('#confirm-password').setCustomValidity('');
document.querySelectorAll('[data-next]').forEach(button=>button.onclick=()=>{
  if(currentStep===1&&!validateStepOne())return;
  showStep(Number(button.dataset.next));
});
document.querySelectorAll('[data-back]').forEach(button=>button.onclick=()=>showStep(Number(button.dataset.back)));
document.querySelectorAll('.signup-progress button').forEach(button=>button.onclick=()=>{
  const destination=Number(button.dataset.go);
  if(destination>currentStep&&currentStep===1&&!validateStepOne())return;
  if(destination<=currentStep||destination===currentStep+1)showStep(destination);
});
$('#signup').onsubmit=async event=>{
  event.preventDefault();
  const button=$('#create-company');
  const password=$('#password').value;
  if(password!==$('#confirm-password').value){
    $('#result').textContent='Passwords do not match.';
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
        legalAccepted:$('#legal-acceptance').checked,
        legalVersion:'2026-09-17'
      })
    });
    const data=await response.json();
    if(!response.ok)throw new Error(data.error);
    localStorage.setItem('pdl-company-id',data.company.id);
    location.href=data.next||`/app?tenant=${encodeURIComponent(data.company.id)}`;
  }catch(error){
    $('#result').textContent=error.message;
    button.disabled=false;
  }
};

recommend();
showStep(1);
