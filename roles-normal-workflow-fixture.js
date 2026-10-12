'use strict';
// Closed repository transport for the actual normal server. There is no
// compatibility installer, HTTP/API stub, external provider, or live tenant.
const assert = require('node:assert/strict'), crypto = require('node:crypto'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { workspaceSnapshot } = require('./compat-workspace-fixture');
const { A, B, initial, credential } = require('./compat-account-fixture');
const nativeFetch = globalThis.fetch;
let origin = null, snapshot, revision = 0, oldWrites = 0, commits = 0, externalCalls = 0;
const seed = workspaceSnapshot(), verified = new Date().toISOString();
seed.team[0].crew = 'Office'; seed.company.autoAdoptActualTimes = false;
seed.crews = [{ id: 1, name: 'Synthetic Crew' }, { id: 2, name: 'Foreign synthetic crew' }];
seed.company.timezone = 'UTC';
seed.projects[0].startDate = '2026-10-12'; seed.projects[0].endDate = '2026-11-30';
// A blank site does not invoke the real weather geocoder when a daily opens.
// Weather/file/provider features are outside this closed normal-form matrix.
seed.projects[0].site = '';
seed.projects.push({ id: 102, name: 'Foreign synthetic project', code: 'FOREIGN', status: 'Active', customer: 0, site: 'Foreign synthetic site', estimateItems: [] });
seed.team.push({ id: 13, name: 'Synthetic PM', crew: 'Office', role: 'Project Manager', userId: 4, email: 'pm@example.invalid' }, { id: 14, name: 'Foreign synthetic employee', crew: 'Foreign synthetic crew', role: 'Laborer' }, { id: 15, name: 'Synthetic Admin', crew: 'Office', role: 'Administrator', userId: 3, email: 'admin@example.invalid' });
seed.users.push({ id: 3, memberId: 15, companyId: A, name: 'Synthetic Admin', email: 'admin@example.invalid', emailVerifiedAt: verified, status: 'Active', role: 'admin', projectIds: [], assignedCrews: [], permissions: { manageTime: true, scheduleCrews: true, viewDailies: true, approveDailies: true }, ...credential(initial) }, { id: 4, memberId: 13, companyId: A, name: 'Synthetic PM', email: 'pm@example.invalid', emailVerifiedAt: verified, status: 'Active', role: 'project_manager', projectIds: [101], assignedCrews: ['Synthetic Crew'], permissions: { manageTime: true, viewTime: true, scheduleCrews: true, viewDailies: true, approveDailies: true }, ...credential(initial) });
seed.reports.push({ ...structuredClone(seed.reports[0]), id: 2, dateIso: '2026-10-02', date: 'Oct 2', status: 'Needs review', notes: 'Synthetic own field review', summary: 'Synthetic own field review', history: [] });
const eventToday = new Date().toISOString().slice(0, 10), eventTomorrow = new Date(Date.parse(eventToday + 'T12:00:00.000Z') + 86400000).toISOString().slice(0, 10);
if (process.env.PDL_NORMAL_EVENTS_BROWSER === '1') {
  seed.assignments[0].date = eventToday;
  seed.assignments.push({ id: 2, projectId: 102, memberIds: [14], crew: 'Foreign synthetic crew', date: eventToday, start: '08:00', end: '16:00', activity: 'Synthetic separate project shift', acknowledgements: {}, notifications: {} });
  seed.projectEvents = [
    { id: 71, projectId: 101, date: eventToday, type: 'delivery', title: 'Synthetic original current delivery', notes: 'Synthetic current-day event details', createdAt: verified, createdBy: 'Synthetic Owner' },
    { id: 72, projectId: 101, date: eventTomorrow, type: 'other', title: 'Synthetic future authorized event', notes: 'Synthetic later-day details', createdAt: verified, createdBy: 'Synthetic Owner' },
    { id: 73, projectId: 102, date: eventToday, type: 'inspection', title: 'Synthetic foreign current inspection', notes: 'Synthetic separate-project details', createdAt: verified, createdBy: 'Synthetic Owner' },
    { id: 74, projectId: 101, date: eventToday, type: 'other', title: 'Synthetic unrelated retained event', notes: '', createdAt: verified, createdBy: 'Synthetic Owner' }
  ];
}
if (process.env.PDL_NORMAL_MESSAGES_BROWSER === '1') {
  seed.team.push(
    { id: 16, name: 'Synthetic Message Foreman', initials: 'MF', crew: 'Synthetic Crew', role: 'Foreman', userId: 5, email: 'foreman@example.invalid' },
    { id: 17, name: 'Synthetic Other Crew Field', initials: 'OC', crew: 'Other message crew', role: 'Laborer', userId: 6, email: 'other-crew@example.invalid' },
    { id: 18, name: 'Synthetic Separate Project Field', initials: 'SP', crew: 'Synthetic Crew', role: 'Laborer' },
    { id: 19, name: 'Synthetic Legacy Named Foreman', initials: 'LF', crew: 'Synthetic Crew', role: 'Foreman' },
    { id: 20, name: 'Synthetic Unlinked Crew Member', initials: 'UM', crew: 'Unsupported message crew', role: 'Crew', email: 'unsupported@example.invalid' }
  );
  for (const [id, memberId, role, email, name] of [[5, 16, 'foreman', 'foreman@example.invalid', 'Synthetic Message Foreman'], [6, 17, 'field', 'other-crew@example.invalid', 'Synthetic Other Crew Field']]) seed.users.push({ id, memberId, companyId: A, role, email, name, emailVerifiedAt: verified, status: 'Active', permissions: {}, projectIds: [], assignedCrews: [], ...credential(initial) });
  seed.assignments[0].date = eventToday;
  for (const [id, projectId, memberIds, crew] of [[2, 101, [16], 'Synthetic Crew'], [3, 101, [17], 'Other message crew'], [4, 102, [18], 'Synthetic Crew'], [5, 101, [20], 'Unsupported message crew']]) seed.assignments.push({ id, projectId, memberIds, crew, date: eventToday, start: '08:00', end: '16:00', activity: 'Synthetic message project evidence', acknowledgements: {}, notifications: {} });
  seed.reports.push({ ...structuredClone(seed.reports[0]), id: 3, foreman: 'Synthetic Legacy Named Foreman', status: 'Draft', notes: 'Synthetic legacy named-foreman project evidence', summary: 'Synthetic legacy message scope', productionEntries: [], laborEntries: [], history: [] });
  const msg = (id, projectId, memberId, sender, senderName, senderId, text, readBy = []) => ({ id, projectId, memberId, sender, senderName, senderId, text, createdAt: new Date(Date.parse(verified) + id).toISOString(), readBy });
  seed.projectMessages = [
    msg(91, 101, null, 'office', 'Synthetic Owner', 1, 'Synthetic project-wide office message', ['m:12', 'm:16', 'm:17']),
    msg(92, 101, 12, 'field', 'Synthetic Field', 12, 'Synthetic own-crew private field reply'),
    msg(93, 101, 17, 'field', 'Synthetic Other Crew Field', 17, 'Synthetic other-crew private field reply'),
    msg(94, 101, 16, 'field', 'Synthetic Message Foreman', 16, 'Synthetic foreman private field reply'),
    msg(95, 102, 18, 'field', 'Synthetic Separate Project Field', 18, 'Synthetic separate-project private reply'),
    msg(96, 101, 17, 'office', 'Synthetic Owner', 1, 'Synthetic other-crew private office message', ['m:17']),
    msg(97, 101, 12, 'office', 'Synthetic Owner', 1, 'Synthetic own private office message'),
    msg(98, 101, 16, 'office', 'Synthetic Owner', 1, 'Synthetic foreman private office message')
  ];
}
snapshot = structuredClone(seed);
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-normal-browser-'));
const file = path.join(directory, 'untouched-legacy.json'); fs.writeFileSync(file, JSON.stringify(seed));
const originalFile = fs.readFileSync(file);
Object.assign(process.env, { NODE_ENV: 'test', PDL_REQUIRE_AUTH: '1', PDL_DB_FILE: file, PDL_PLATFORM_FILE: path.join(directory, 'platform.json'), PDL_ROLES_COMPANIES: A, PDL_ROLE_POLICY_KEY: crypto.randomBytes(32).toString('hex'), PDL_TRANSACTIONAL_DB: 'off' });
for (const name of ['PDL_COMPAT_ACCOUNT_SYNTHETIC', 'PDL_COMPAT_GLOBAL_FENCE_FILE', 'TEST_COMPAT_DATABASE_URL', 'DATABASE_URL']) delete process.env[name];
for (const name of ['OPENAI_API_KEY', 'RESEND_API_KEY', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'SENTRY_DSN', 'SUPABASE_SECRET_KEY', 'PDL_PLATFORM_KEY']) process.env[name] = '';
globalThis.fetch = (input, options) => { const target = String(input?.url || input); if (!origin || new URL(target).origin !== origin) { externalCalls++; throw Error('External network is fenced by the owned normal-browser fixture.'); } return nativeFetch(input, options); };
const supabase = require('./database/supabase'); supabase.loadLocalEnv = () => {};
supabase.configured = () => true;
supabase.loadCompanySnapshot = async id => id === A ? structuredClone(snapshot) : null;
supabase.listCompanySnapshots = async () => [structuredClone(snapshot)];
supabase.health = async () => ({ configured: true, reachable: true });
supabase.saveCompanySnapshot = async () => { oldWrites++; throw Error('Legacy snapshot writes are forbidden.'); };
for (const name of ['upload', 'download', 'remove']) supabase[name] = async () => { externalCalls++; throw Error('No file/provider effects belong to this normal-form matrix.'); };
supabase.request = async (relative, options = {}) => {
  if (relative.startsWith('/rest/v1/companies?')) return new Response(JSON.stringify(relative.includes('id=eq.' + A) ? [{ data: structuredClone(snapshot), roles_revision: revision, roles_managed: true }] : []));
  assert.equal(relative, '/rest/v1/rpc/commit_roles_snapshot'); const input = JSON.parse(options.body); assert.equal(input.p_company_id, A);
  if (input.p_expected_revision !== revision || Date.parse(input.p_deadline) <= Date.now()) throw Error('PDL_REVISION_CONFLICT');
  snapshot = structuredClone(input.p_snapshot); revision++; commits++; return new Response(JSON.stringify([{ revision }]));
};
const platformFixture = require('./roles-production-platform-fixture').wrap(supabase.request); supabase.request = platformFixture.request;
if (process.env.PDL_NORMAL_PLATFORM_BROWSER === '1') platformFixture.alter(platform => {
  platform.users = [{ id: 71, name: 'Synthetic Platform Owner', email: 'platform-owner@example.invalid', role: 'platform_owner', status: 'Active', mustSetPassword: false, ...credential(initial) }];
});
const { server } = require('./server');
module.exports = { server, A, B, initial, directory, platformFixture, eventToday, eventTomorrow, read: () => structuredClone(snapshot), revision: () => revision,
  alter: change => { change(snapshot); revision++; }, reset: () => { snapshot = structuredClone(seed); revision++; },
  setOrigin: value => { origin = value; },
  evidence: () => { assert.deepEqual(fs.readFileSync(file), originalFile, 'Normal managed writes must not modify the legacy JSON.'); return { backend: 'synthetic-memory', normalServer: true, compatibilityInstallerUsed: false, externalServerCalls: externalCalls, legacyWrites: oldWrites, commits, temporaryDirectory: directory }; },
  restore: () => { globalThis.fetch = nativeFetch; }
};
