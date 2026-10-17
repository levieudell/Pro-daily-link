'use strict';
// Notes now belong to the daily form. These regression tests explicitly enter
// and review notes there after the punch has already been recorded.
exports.completeClockOutDaily=async function(page,notes,next=''){
  await page.waitForSelector('#report-modal[open] #field-notes',{timeout:20000});
  await page.waitForFunction(()=>typeof endingWorkdays==='undefined'||endingWorkdays.size===0);
  await page.evaluate(async({notes,next})=>{
    const field=document.querySelector('#field-notes');
    field.value=[field.value.trim(),notes].filter(Boolean).join('\n');
    field.dispatchEvent(new Event('input',{bubbles:true}));
    if(next)document.querySelector('#report-next').value=next;
    await document.querySelector('#report-next-step').onclick();
    if(next){document.querySelector('#report-next').value=next;const review=document.querySelector('#field-review-next');if(review)review.value=next}
    const saved=await saveDailyReport('Draft',{keepOpen:true});
    if(!saved)throw new Error(document.querySelector('#report-submit-status')?.textContent||'Daily draft did not save');
    renderMyDay();renderFieldClock();
  },{notes,next});
};
