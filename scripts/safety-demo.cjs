'use strict';

// A disposable local product demo. Never reads a production database or .env.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-safety-demo-'));
const password = crypto.randomBytes(12).toString('base64url');
for (const key of ['OPENAI_API_KEY', 'SENTRY_DSN', 'RESEND_API_KEY', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'DATABASE_URL', 'INDEXNOW_KEY']) delete process.env[key];
Object.assign(process.env, {
  PDL_DB_FILE: path.join(directory, 'db.json'), PDL_PLATFORM_FILE: path.join(directory, 'platform.json'),
  PDL_STAGING: '1', PDL_STAGING_OWNER_PASSWORD: password, PDL_STAGING_FIELD_PASSWORD: password,
  PDL_SUPABASE_ENABLED: '0', PDL_TRANSACTIONAL_DB: 'off', PDL_PLATFORM_TRANSACTIONAL_DB: 'off',
  PDL_EMAIL_DEV_MODE: '1', PDL_REQUIRE_AUTH: '1', NODE_ENV: 'test'
});
const { server } = require('../server');
const db = JSON.parse(fs.readFileSync(process.env.PDL_DB_FILE, 'utf8'));
db.company.name = 'DEMO | PDL Safety Lab';
db.company.features ||= {};
db.company.features.templates = true;
db.dailyTemplates = [{
  id: 'synthetic-inspection', name: 'Synthetic pre-start inspection', category: 'inspection',
  description: 'A short project-assigned inspection used only by the disposable Safety demo.', locked: false,
  requirements: { photo: false, signature: false, acknowledgement: false }, assignment: { crewNames: [], workTypes: [] },
  versions: [{ version: 1, name: 'Synthetic pre-start inspection', createdAt: new Date().toISOString(), createdBy: 'Synthetic fixture', fields: [
    { id: 'access-condition', label: 'Is site access acceptable?', type: 'yesno', required: true, help: '', options: [] },
    { id: 'inspection-notes', label: 'Inspection notes', type: 'longtext', required: false, help: '', options: [] }
  ] }]
}];
const owner = db.users.find(user => user.role === 'owner');
owner.email = 'pm@example.invalid'; owner.name = 'Demo project manager';
owner.emailVerifiedAt = new Date().toISOString();
const trades = [['roofing'], ['excavation'], ['framing', 'demolition']];
for (const [index, project] of db.projects.entries()) {
  project.safetyProfile = { revision: 1, enabled: true, state: 'OR', employer: 'Demo responsible employer', activities: trades[index % trades.length] };
  project.templateIds = ['standard', 'synthetic-inspection'];
}
fs.writeFileSync(process.env.PDL_DB_FILE, JSON.stringify(db, null, 2));
fs.writeFileSync(process.env.PDL_PLATFORM_FILE, JSON.stringify({ users: [], sessions: [], notes: [] }));
const requestedPort = process.argv.find(value => value.startsWith('--port='))?.split('=')[1] || '4326';
if (!/^\d+$/.test(requestedPort) || Number(requestedPort) > 65535) throw new Error('Use a valid local port');
server.listen(Number(requestedPort), '127.0.0.1', () => {
  console.log(`Safety demo: http://127.0.0.1:${server.address().port}/login.html?tenant=${db.company.id}`);
  console.log(`Demo-only login: ${owner.email}`);
  console.log(`Temporary demo password: ${password}`);
  console.log('Open Safety today after signing in. Stop with Ctrl+C; every run starts with fresh synthetic data.');
});
process.on('SIGINT', () => server.close(() => process.exit(0)));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
