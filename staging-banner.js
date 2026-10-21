'use strict';

fetch('/api/config', { credentials: 'include', cache: 'no-store' })
  .then(response => response.json())
  .then(config => {
    if (!config.staging || document.querySelector('.staging-banner')) return;
    const bar = document.createElement('div');
    bar.className = 'staging-banner';
    bar.setAttribute('role', 'status');
    bar.textContent = 'STAGING';
    document.body.prepend(bar);
  })
  .catch(() => {});
