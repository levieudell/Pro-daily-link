'use strict';

window.pdlWorkspaceGate = (async () => {
  try {
    const config = await fetch('/api/config', { credentials: 'include', cache: 'no-store' }).then(response => response.json());
    if (config.staging) {
      window.pdlStaging = true;
      const paintStagingBanner = () => {
        if (document.querySelector('.staging-banner')) return;
        const bar = document.createElement('div');
        bar.className = 'staging-banner';
        bar.setAttribute('role', 'status');
        bar.textContent = 'STAGING';
        (document.body || document.documentElement).prepend(bar);
      };
      if (document.body) paintStagingBanner();
      else document.addEventListener('DOMContentLoaded', paintStagingBanner);
    }
    if (config.authRequired) {
      const response = await fetch('/api/auth/me', { credentials: 'include', cache: 'no-store' });
      if (!response.ok) {
        location.replace('/');
        return false;
      }
      window.pdlAuthenticatedUser = await response.json();
    }
    document.documentElement.classList.add('workspace-authenticated');
    return true;
  } catch {
    // No connection at all: if this device has a cached workspace, open it
    // offline instead of bouncing to the sign-in page.
    const companyId=localStorage.getItem('pdl-company-id')||'',userId=localStorage.getItem('pdl-user-id')||'',scope=`${encodeURIComponent(companyId)}:${encodeURIComponent(userId)}`;
    if (companyId && userId && localStorage.getItem(`pdl-last-state:${scope}`)) {
      document.documentElement.classList.add('workspace-authenticated');
      window.pdlOfflineBoot = true;
      window.pdlOfflineScope = { companyId, userId };
      return true;
    }
    location.replace('/');
    return false;
  }
})();
