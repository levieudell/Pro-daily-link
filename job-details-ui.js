'use strict';
// Reorganize existing controls; their handlers and permission checks stay authoritative.
(() => {
  const dialog = document.getElementById('project-detail-modal');
  if (!dialog || typeof openProject !== 'function') return;
  dialog.classList.add('job-details');
  dialog.querySelector('.close-button')?.setAttribute('aria-label', 'Close job details');
  const primary = ['overview', 'dailies', 'estimate'];
  let sequence = 0, observer;
  function arrange() {
    const content = dialog.querySelector('#project-detail-content'), tabs = content?.querySelector('.project-detail-tabs');
    if (!tabs || tabs.querySelector('[data-job-more]')) return;
    const overview = content.querySelector('[data-project-detail-pane="overview"]');
    if (!overview) return; // Preserve the existing restricted field/foreman view.
    const summary = document.createElement('section'); summary.className = 'job-overview-summary';
    for (const selector of ['.project-health-banner', '.detail-meta', '.project-site-quickbar']) {
      const node = content.querySelector(selector); if (node) summary.append(node);
    }
    tabs.insertAdjacentElement('afterend', summary);
    const more = document.createElement('button'); more.type = 'button'; more.dataset.jobMore = '';
    more.textContent = typeof preferredLanguage !== 'undefined' && preferredLanguage === 'es' ? 'Más' : 'More';
    more.setAttribute('aria-expanded', 'false'); more.setAttribute('aria-controls', 'job-more-panel');
    const menu = document.createElement('div'); menu.id = 'job-more-panel'; menu.className = 'job-more-panel'; menu.hidden = true;
    const links = document.createElement('div'); links.className = 'job-more-links'; menu.append(links);
    for (const button of [...tabs.querySelectorAll('[data-project-detail-tab]')]) {
      if (!primary.includes(button.dataset.projectDetailTab)) links.append(button);
    }
    for (const key of primary) {
      const button = tabs.querySelector(`[data-project-detail-tab="${key}"]`);
      if (button) tabs.append(button);
    }
    const spanish = typeof preferredLanguage !== 'undefined' && preferredLanguage === 'es';
    const daily = tabs.querySelector('[data-project-detail-tab="dailies"]');
    if (daily?.firstChild?.nodeType === Node.TEXT_NODE) daily.firstChild.textContent = spanish ? 'Reportes ' : 'Dailies ';
    const estimate = tabs.querySelector('[data-project-detail-tab="estimate"]');
    if (estimate) estimate.textContent = spanish ? 'Estimado' : 'Estimate';
    tabs.append(more, menu);
    const forms = content.querySelector('#project-template-pin');
    if (forms) {
      const disclosure = document.createElement('details'); disclosure.className = 'job-forms';
      const label = document.createElement('summary'); label.textContent = spanish ? 'Formularios y seguridad' : 'Forms & safety setup';
      disclosure.append(label, forms); menu.append(disclosure);
    }
    // Billing belongs to Estimate, not the shared area below every pane.
    const estimatePane = content.querySelector('[data-project-detail-pane="estimate"]');
    if (estimatePane) {
      content.querySelectorAll(':scope > .tm-summary').forEach(node=>estimatePane.append(node));
      const rates = content.querySelector('[data-pdl-default-rate]')?.closest('section');
      if(rates) estimatePane.append(rates);
    }
    let moreOpen = false;
    function sync() {
      const selected = [...tabs.querySelectorAll('[data-project-detail-tab]')].find(button => button.classList.contains('active'));
      const key = selected?.dataset.projectDetailTab;
      summary.hidden = moreOpen || key !== 'overview';
      content.classList.toggle('job-more-open', moreOpen);
      menu.hidden = !moreOpen;
      more.setAttribute('aria-expanded', String(moreOpen));
      more.classList.toggle('active', moreOpen || (Boolean(key) && !primary.includes(key)));
      more.tabIndex = moreOpen || !primary.includes(key) ? 0 : -1;
      links.querySelectorAll('button').forEach(button => {
        button.setAttribute('role', 'button'); button.removeAttribute('aria-selected'); button.tabIndex = moreOpen ? 0 : -1;
      });
    }
    more.onclick = () => { moreOpen = !moreOpen; sync(); };
    tabs.addEventListener('click', event => {
      const button = event.target.closest('[data-project-detail-tab]');
      if (!button) return;
      const fromMenu = links.contains(button); moreOpen = false;
      queueMicrotask(() => { sync(); if (fromMenu) more.focus({preventScroll:true}); });
    });
    tabs.onkeydown = event => {
      if (event.key === 'Escape' && moreOpen) { event.preventDefault(); event.stopPropagation(); moreOpen = false; sync(); more.focus(); return; }
      const target = event.target.closest('button');
      if (!target || !['ArrowLeft','ArrowRight','Home','End'].includes(event.key) || !target.matches('[data-project-detail-tab],[data-job-more]')) return;
      event.preventDefault();
      const buttons = [...tabs.querySelectorAll('[data-project-detail-tab],[data-job-more]')].filter(button=>button.getClientRects().length);
      const index = buttons.indexOf(target), next = event.key==='Home'?0:event.key==='End'?buttons.length-1:(index+(event.key==='ArrowRight'?1:-1)+buttons.length)%buttons.length;
      buttons[next].focus({preventScroll:true});
    };
    // Existing overview shortcuts select panes directly, without a tab click.
    observer = new MutationObserver(sync);
    content.querySelectorAll('[data-project-detail-pane]').forEach(pane=>observer.observe(pane,{attributes:true,attributeFilter:['class']}));
    sync(); content.scrollTop = 0;
  }
  const previous = openProject;
  openProject = async function(...args) {
    const request = ++sequence; observer?.disconnect(); dialog.classList.add('job-details-loading');
    try {
      const result = await previous(...args);
      if (request === sequence && dialog.open && String(dialog.dataset.projectId) === String(args[0])) arrange();
      return result;
    } finally { if (request === sequence) dialog.classList.remove('job-details-loading'); }
  };
  dialog.addEventListener('close',()=>{if(!dialog.open){observer?.disconnect();dialog.classList.remove('job-details-loading');}});
})();
