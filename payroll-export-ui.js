'use strict';
// Both office entry points use this component; exports still use the existing route.
(() => {
  const calendar = window.PDLPayrollRanges, dialog = document.querySelector('#payroll-export-dialog');
  const landing = document.querySelector('#payroll-landing');
  const context = () => JSON.stringify([signedInCompanyId(), currentUser?.id, currentUser?.role, currentUser?.permissions, currentRole]);
  const allowed = () => currentRole === 'office' && company?.features?.timeCards === true && (currentUser?.role === 'owner' || currentUser?.role === 'admin' && currentUser?.permissions?.manageTime === true);
  const today = () => calendar.today(company?.timezone || 'America/Los_Angeles');
  const start = () => company?.weekStart || 'monday';
  const presets = [['week','This week'],['last','Last week'],['last2','Last 2 weeks'],['period','Last pay period'],['month','This month'],['custom','Custom']];
  const components = [];
  function makeComponent(root, isLanding) {
    const paint = () => { root.innerHTML = `${isLanding?'<h2>PAYROLL</h2>':''}<div class="payroll-export-body"><p class="payroll-intro">Only approved punches count. Extra-work flags don't change pay.</p><div class="payroll-export-chips" role="group" aria-label="Payroll date range">${presets.map(([key,label])=>`<button type="button" data-payroll-range="${key}" aria-pressed="false">${label}</button>`).join('')}</div><div class="payroll-calendar" hidden><div class="payroll-calendar-nav"><button type="button" data-month="-1" aria-label="Previous month">‹</button><strong data-month-label></strong><button type="button" data-month="1" aria-label="Next month">›</button></div><p data-calendar-help role="status"></p><div data-calendar-grid></div><button type="button" data-calendar-close>Back to ranges</button></div><p data-payroll-range-label></p><p data-payroll-empty role="status" hidden>No approved hours in this range.</p><p data-payroll-error role="alert"></p></div><footer><button type="button" data-payroll-bar-review hidden><span data-payroll-bar-count></span><span data-payroll-bar-sep> · </span><span>Review</span></button><button type="button" data-payroll-download="csv">Download CSV</button><button type="button" data-payroll-download="pdf">PDF summary</button></footer>`; };
    const find = selector => root.querySelector(selector);
    let identity = '', range = null, preset = 'week', month = '', cursor = '', first = null, pending = false, picked = false, controller = null, busy = false;
    function error(text) { find('[data-payroll-error]').textContent = text; }
    function setCalendar(open) { root.classList.toggle('calendar-open', open); find('.payroll-calendar').hidden = !open; if (open && isLanding) root.scrollIntoView({block:'start'}); }
    function update() {
      const authorized = allowed();
      if (!authorized) { controller?.abort(); identity = ''; if (isLanding) { root.replaceChildren(); root.remove(); } else { root.replaceChildren(); if (dialog.open) dialog.close(); dialog.remove(); } return; }
      if (isLanding) { if (!root.isConnected) document.querySelector('#office-priorities').before(root); if (!root.querySelector('[data-payroll-download]')) paint(); root.hidden = false; }
      else if (!root.querySelector('[data-payroll-download]')) { if (!dialog.isConnected) document.body.append(dialog); paint(); }
      if (identity !== context()) { controller?.abort(); identity = context(); choose('week'); return; }
      const period = lastPeriod(); find('[data-payroll-range="period"]').disabled = !period;
      find('[data-payroll-range="period"]').title = period ? '' : 'No previous saved pay period.';
      const cards = range ? timeCards.filter(card => { const date = timePeriodDate(card, company?.timezone || 'America/Los_Angeles'); return !card.deletedAt && date && date >= range.from && date <= range.to; }) : [];
      const unapproved = cards.filter(card => !timeCardApproved(card)).length;
      const hasHours = cards.some(card => timeCardApproved(card) && Number(card.hours) > 0);
      find('[data-payroll-range-label]').textContent = range ? calendar.label(range.from, range.to, today().slice(0,4)) : '';
      find('[data-payroll-empty]').hidden = hasHours || pending;
      const barCount = unapproved === 1 ? '1 punch not approved' : `${unapproved} punches not approved`;
      find('[data-payroll-bar-count]').textContent = barCount;
      find('[data-payroll-bar-review]').hidden = pending || !unapproved;
      root.querySelectorAll('[data-payroll-download]').forEach(button => button.disabled = !hasHours || pending || busy);
    }
    function lastPeriod() {
      const scheduled = window.PDLPaySchedule?.lastEndedBefore?.(company?.payroll?.pay_schedule, today());
      if (company?.payroll?.pay_schedule?.frequency) return scheduled ? { from: scheduled.start, to: scheduled.end } : null;
      return (window.PDLPayPeriods?.list() || []).filter(p => p.to < today()).sort((a,b)=>b.to.localeCompare(a.to))[0] || null;
    }
    function choose(key) {
      preset = key; first = null; pending = false; picked = false; error('');
      root.querySelectorAll('[data-payroll-range]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.payrollRange === key)));
      range = key === 'period' ? lastPeriod() : calendar.range(key === 'custom' ? 'week' : key, today(), start());
      setCalendar(key === 'custom');
      if (key === 'custom') { month = today().slice(0,7) + '-01'; cursor = today(); drawCalendar(); }
      update();
      if (isLanding && key !== 'custom' && window.innerHeight <= 560 && !find('[data-payroll-bar-review]').hidden) {
        root.scrollIntoView({block:'start'});
        window.scrollBy(0, -8);
      }
    }
    function drawCalendar() {
      const days = calendar.monthDays(month,start()), weekdays = start() === 'sunday' ? ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'] : ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
      const monthLabel = new Intl.DateTimeFormat('en-US',{month:'long',year:'numeric',timeZone:'UTC'}).format(new Date(month+'T12:00:00Z'));
      find('[data-month-label]').textContent = monthLabel;
      find('[data-calendar-help]').textContent = pending ? 'Choose the last day.' : picked ? 'Range selected. Choose a day to start again.' : 'Choose the first day, then the last day.';
      const rows = []; for(let i=0;i<days.length;i+=7) rows.push(days.slice(i,i+7));
      if (!days.includes(cursor)) cursor = month;
      find('[data-calendar-grid]').innerHTML = `<table role="grid" aria-label="${monthLabel}"><thead><tr>${weekdays.map(day=>`<th scope="col">${day}</th>`).join('')}</tr></thead><tbody>${rows.map(row=>`<tr>${row.map(day=>{const selected=range&&day>=range.from&&day<=range.to;const label=new Intl.DateTimeFormat('en-US',{dateStyle:'full',timeZone:'UTC'}).format(new Date(day+'T12:00:00Z'));return `<td aria-selected="${Boolean(selected)}"><button type="button" data-payroll-day="${day}" tabindex="${day===cursor?0:-1}" aria-label="${label}" aria-pressed="${Boolean(selected)}" ${day===today()?'aria-current="date"':''} class="${selected?'in-range ':''}${day.slice(0,7)!==month.slice(0,7)?'adjacent-month':''}">${Number(day.slice(-2))}</button></td>`}).join('')}</tr>`).join('')}</tbody></table>`;
    }
    root.addEventListener('click', event => {
      const chip = event.target.closest('[data-payroll-range]'); if(chip) { choose(chip.dataset.payrollRange); return; }
      const arrow = event.target.closest('[data-month]'); if(arrow) { month=calendar.shiftMonth(month,Number(arrow.dataset.month)); drawCalendar(); return; }
      if(event.target.closest('[data-calendar-close]')) { setCalendar(false); return; }
      const day = event.target.closest('[data-payroll-day]'); if(day) {
        const value=day.dataset.payrollDay; cursor=value;
        if(!pending) { first=value; range={from:value,to:value}; pending=true; picked=false; }
        else { range={from:first<value?first:value,to:first>value?first:value}; first=null; pending=false; picked=true; }
        error(''); drawCalendar(); update(); find(`[data-payroll-day="${cursor}"]`)?.focus({preventScroll:true}); return;
      }
      if(event.target.closest('[data-payroll-bar-review]') && range) { if(dialog.open)dialog.close(); showPage('timecards'); window.PDLPayPeriods.reviewRange(range.from,range.to); return; }
      const download=event.target.closest('[data-payroll-download]'); if(download) void save(download.dataset.payrollDownload);
    });
    root.addEventListener('keydown', event => {
      const day=event.target.closest('[data-payroll-day]'); if(!day)return;
      const key=event.key, shifts={ArrowLeft:-1,ArrowRight:1,ArrowUp:-7,ArrowDown:7}; let next;
      if(key in shifts)next=calendar.addDays(day.dataset.payrollDay,shifts[key]);
      else if(key==='Home')next=calendar.weekStart(day.dataset.payrollDay,start());
      else if(key==='End')next=calendar.addDays(calendar.weekStart(day.dataset.payrollDay,start()),6);
      else if(key==='PageUp'||key==='PageDown')next=calendar.shiftMonth(day.dataset.payrollDay,key==='PageUp'?-1:1);
      else return;
      event.preventDefault(); cursor=next; month=next.slice(0,7)+'-01'; drawCalendar(); find(`[data-payroll-day="${next}"]`).focus();
    });
    async function save(format) {
      if(!allowed()||identity!==context()||pending||busy||!range)return;
      const requestContext=identity, selected={from:range.from,to:range.to}, request=new AbortController(); controller=request; busy=true;error('');update();
      try {
        const response=await fetch('/api/payroll/export?'+new URLSearchParams({...selected,format}),{credentials:'same-origin',headers:{'X-PDL-Company':signedInCompanyId()},signal:request.signal});
        if(!response.ok)throw new Error((await response.json()).error||'Payroll download failed. Try again.');
        const blob=await response.blob(); if(identity!==requestContext||context()!==requestContext||request.signal.aborted||(!isLanding&&!dialog.open))return;
        const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=`pdl-payroll-${selected.from}-to-${selected.to}.${format}`;link.hidden=true;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
      } catch(failure) { if(!request.signal.aborted&&identity===requestContext&&context()===requestContext)error(failure.message); }
      finally { if(controller===request){controller=null;busy=false;update();} }
    }
    const component={update,reset(){identity=context();busy=false;choose('week');},close(){controller?.abort();controller=null;busy=false;},root};components.push(component);return component;
  }
  const card=makeComponent(landing,true), modal=makeComponent(document.querySelector('#payroll-dialog-content'),false);
  document.addEventListener('click',event=>{if(event.target.closest('[data-payroll-export-open]')&&allowed()){modal.reset();dialog.showModal();}});
  dialog.querySelector('[data-payroll-close]').addEventListener('click',()=>dialog.close());
  dialog.addEventListener('close',()=>modal.close());
  const previousRender=renderTimeCards;
  renderTimeCards=function(){const result=previousRender.apply(this,arguments);components.forEach(component=>component.update());return result;};
  const previousPage=showPage;
  showPage=function(page,...args){const result=previousPage.call(this,page,...args);if(page==='dashboard'){if(allowed())card.reset();else card.update();}return result;};
  window.PDLPayrollExport={refresh(){components.forEach(component=>component.update());}};
})();
