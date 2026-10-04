const assert=require('node:assert/strict');
const fs=require('node:fs');

const support=fs.readFileSync('support.html','utf8');
assert(!/support-banner['"]\)\.innerHTML/.test(support),'Support banner must not render API data with innerHTML');
assert(!/support-summary['"]\)\.innerHTML/.test(support),'Support summary must not render API data with innerHTML');
assert(support.includes("encodeURIComponent(token||'')"),'Support tokens must be URL encoded');

const app=fs.readFileSync('app.js','utf8');
for(const field of [
  "escapeHtml(entry.projectName||entry.detail||'Company record')",
  "escapeHtml(entry.reason||'Not provided')",
  "escapeHtml(entry.actor||'Office user')"
])assert(app.includes(field),`Audit rendering must escape: ${field}`);

const server=fs.readFileSync('server.js','utf8');
for(const header of ['X-Content-Type-Options','X-Frame-Options','Referrer-Policy','Permissions-Policy','Strict-Transport-Security'])
  assert(server.includes(header),`Missing security header: ${header}`);

console.log('Security rendering and header regression tests passed');

