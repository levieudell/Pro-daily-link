'use strict';
// Local-only workspace with synthetic data. It never loads a .env or a cloud store.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const directory = path.join(root, 'qa-tmp', `office-${Date.now()}`);
fs.mkdirSync(directory, { recursive: true });
const password = crypto.randomBytes(12).toString('base64url');
for (const key of ['OPENAI_API_KEY','SENTRY_DSN','RESEND_API_KEY','STRIPE_SECRET_KEY','STRIPE_WEBHOOK_SECRET','DATABASE_URL','INDEXNOW_KEY']) delete process.env[key];
Object.assign(process.env, {
  PDL_DB_FILE:path.join(directory,'db.json'), PDL_PLATFORM_FILE:path.join(directory,'platform.json'),
  PDL_STAGING:'0', PDL_STAGING_OWNER_PASSWORD:password, PDL_STAGING_FIELD_PASSWORD:password,
  PDL_SUPABASE_ENABLED:'0', PDL_TRANSACTIONAL_DB:'off', PDL_PLATFORM_TRANSACTIONAL_DB:'off',
  PDL_EMAIL_DEV_MODE:'1', PDL_REQUIRE_AUTH:'1', NODE_ENV:'test'
});
require('../database/supabase').loadLocalEnv = () => {};
const { buildStagingDb, stagingToday } = require('../staging-seed');
const { buildSalesDemo } = require('../sales-demo-data');
const auth = buildStagingDb(process.env);
const db = buildSalesDemo({ asOf:stagingToday(), companyId:auth.company.id });
db.users = auth.users;
db.sessions = [];
const owner = db.users.find(user => user.role === 'owner');
owner.email = 'office@example.invalid'; owner.name = 'Demo Morgan';
owner.emailVerifiedAt = new Date().toISOString();
owner.preferences = { theme:'light' };
// A submitted daily and a missing-quantity daily keep the overview review path testable.
const latest = db.reports.at(-1);
if (latest) { latest.status = 'Needs review'; latest.dateIso = stagingToday(); }
if (process.argv.includes('--empty')) {
  for (const key of ['projects','reports','assignments','timeCards','workdays','changes','subcontractors','projectNotesTodos','projectMessages','photos','team']) db[key] = [];
}
fs.writeFileSync(process.env.PDL_DB_FILE, JSON.stringify(db));
fs.writeFileSync(process.env.PDL_PLATFORM_FILE, JSON.stringify({ users:[],sessions:[],notes:[] }));
const { server } = require('../server');
const port = Number(process.argv.find(value => value.startsWith('--port='))?.split('=')[1] || 4331);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Choose a local port from 1024 to 65535.');
server.listen(port,'127.0.0.1', () => {
  console.log(`Office preview: http://127.0.0.1:${port}/login.html?tenant=${db.company.id}`);
  console.log(`Sample login: ${owner.email}`);
  console.log(`Temporary password: ${password}`);
  console.log('Synthetic sample company only. Stop with Ctrl+C. Each run starts fresh.');
});
process.on('SIGINT', () => server.close(() => process.exit(0)));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
