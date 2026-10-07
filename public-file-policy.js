'use strict';
const path=require('node:path');
const PUBLIC_FILES=new Set([
  'project-assistant-ui.js','project-assistant-ui.css','project-assistant-voice.js','project-assistant-conversation.js','project-assistant-chat.js',
  'index.html','landing.html','about.html','blog.html','login.html','signup.html','forgot-password.html','reset-password.html','verify-email.html','guest.html','platform.html','platform-login.html','platform-forgot-password.html','platform-reset-password.html','support.html','privacy.html','terms.html',
  'platform-revenue.css','project-notes-ui.css','styles.css','landing.css','landing-demo.css','enterprise-pricing.css','public-content.css','login.css','signup.css','guest.css','platform.css','platform-mobile.css','legal.css','estimate-mobile.css',
  'office-workspace.js','platform-revenue.js','project-notes-ui.js','schedule-availability.js','daily-work-extraction.js','report-labor-review.js','app.js','i18n.js','labor-hours-hint.js','estimate-mobile.js','landing-demo.js','landing-content.js','blog.js','login.js','signup.js','forgot-password.js','reset-password.js','verify-email.js','guest.js','platform.js','platform-demo.js','platform-sales-demo.js','csv-cell.js','reporting-controls.js','time-approval-controls.js','company-settings-tabs.js','manifest.webmanifest',
  'assets/pro-daily-link-logo.png','assets/pro-daily-link-branding-kit.png'
]);
function isPublicFile(root,file){const relative=path.relative(root,file).split(path.sep).join('/');return PUBLIC_FILES.has(relative)}
module.exports={isPublicFile,PUBLIC_FILES};
