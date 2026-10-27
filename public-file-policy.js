'use strict';
const path=require('node:path');
const PUBLIC_FILES=new Set([
  'safety-pm-ui.js','safety-pm-ui.css','safety-workspace-ui.js','safety-workspace-ui.css',
  'company-timezone.js',
  'schedule-approved-labor.js',
  'project-assistant-access.js',
  'project-assistant-ui.js','project-assistant-ui.css','project-assistant-voice.js','project-assistant-conversation.js','project-assistant-chat.js','project-assistant-names.js',
  'index.html','landing.html','about.html','blog.html','login.html','signup.html','forgot-password.html','reset-password.html','verify-email.html','guest.html','platform.html','platform-login.html','platform-forgot-password.html','platform-reset-password.html','support.html','privacy.html','terms.html',
  'robots.txt','sitemap.xml','llms.txt','MCP.md','vs/raken.html','vs/procore.html','vs/paper-daily-logs.html','change-order.html','change-order.js',
  'platform-revenue.css','project-notes-ui.css','project-site-visits-ui.css','design-system.css','styles.css','landing.css','landing-demo.css','enterprise-pricing.css','public-content.css','login.css','signup.css','guest.css','platform.css','platform-mobile.css','legal.css','estimate-mobile.css',
  'office-workspace.js','platform-revenue.js','platform-ai.js','platform-access-ui.js','platform-growth-ui.js','platform-growth-integration.js','project-notes-ui.js','project-site-visits-ui.js','schedule-availability.js','schedule-touch-drag.js','project-schedule-ui.js','daily-work-extraction.js','field-daily-scope.js','field-instant-daily.js','report-labor-review.js','app.js','offline.js','sw.js','workspace-gate.js','register-service-worker.js','staging-banner.js','i18n.js','labor-hours-hint.js','estimate-mobile.js','landing-demo.js','landing-content.js','public-header.js','analytics.js','blog.js','login.js','signup.js','forgot-password.js','reset-password.js','verify-email.js','guest.js','platform.js','platform-demo.js','platform-sales-demo.js','csv-cell.js','reporting-controls.js','time-approval-controls.js','company-settings-tabs.js','manifest.webmanifest',
  'assets/pro-daily-link-logo.png','assets/pro-daily-link-branding-kit.png','assets/og-image.png','assets/brand-fonts.css','assets/pdl-monogram.svg','assets/fonts/anton-400.woff2','assets/fonts/inter-400.woff2','assets/fonts/inter-500.woff2','assets/fonts/inter-600.woff2','assets/fonts/inter-700.woff2','assets/fonts/inter-800.woff2'
]);
function isPublicFile(root,file){const relative=path.relative(root,file).split(path.sep).join('/');return PUBLIC_FILES.has(relative)}
module.exports={isPublicFile,PUBLIC_FILES};
