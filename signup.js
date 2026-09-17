const $=selector=>document.querySelector(selector);

function recommend(){
  const people=+$('#employees').value;
  const projects=+$('#projects').value;
  const plan=people<=10&&projects<=5?'starter':people<=30&&projects<=25?'growth':'pro';
  $('#recommendation').textContent=`Recommended: ${plan[0].toUpperCase()+plan.slice(1)} based on your team and active projects.`;
  document.querySelector(`[value="${plan}"]`).checked=true;
}

$('#employees').oninput=recommend;
$('#projects').oninput=recommend;
$('#signup').onsubmit=async event=>{
  event.preventDefault();
  const button=$('#signup>button');
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
        plan:document.querySelector('[name="plan"]:checked').value
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

