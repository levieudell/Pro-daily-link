const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const repoDb = path.join(__dirname, 'data', 'db.json');
const fixturePath = path.join(__dirname, 'fixtures', 'hours-safety-snapshot.json');
const fixtureBefore = fs.readFileSync(fixturePath);
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-templates-'));
const dbFile = path.join(tempDir, 'db.json');
fs.writeFileSync(dbFile, fs.readFileSync(repoDb));
fs.copyFileSync(path.join(__dirname, 'data', 'platform.json'), path.join(tempDir, 'platform.json'));
process.env.PDL_DB_FILE = dbFile;
process.env.PDL_PLATFORM_FILE = path.join(tempDir, 'platform.json');
process.env.PDL_SUPABASE_ENABLED = '0';
process.env.PDL_EMAIL_DEV_MODE = '1';
process.env.PDL_REQUIRE_AUTH = '0';
process.env.PDL_PLATFORM_KEY = 'test-platform-key-32-characters-minimum';

const {server} = require('./server');
const base = 'http://127.0.0.1:4203';
const platformKey = process.env.PDL_PLATFORM_KEY;

async function request(route, options = {}) {
  const headers = {'Content-Type': 'application/json', ...(options.headers || {})};
  const response = await fetch(base + route, {...options, headers});
  const type = response.headers.get('content-type') || '';
  if (!type.includes('application/json')) return {response, data: null, text: await response.text()};
  return {response, data: await response.json(), text: ''};
}

server.listen(4203, async () => {
  try {
    const appJs = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
    const platformJs = fs.readFileSync(path.join(__dirname, 'platform.js'), 'utf8');
    assert.match(platformJs, /Templates on/);
    assert.match(platformJs, /Time cards on/);
    assert.match(appJs, /function readOfflineDraft/);
    assert.match(appJs, /function writeOfflineDraft/);
    assert.match(appJs, /templates:me\.templates===true/);
    assert.match(appJs, /cache:'no-store'/);
    assert.doesNotMatch(appJs, /pdl-templates/);
    const draftFns = new Function('localStorage', `
      let templatesOnFlag = false;
      function templatesOn(){return templatesOnFlag}
      function collectCustomFields(){return globalThis.__customFields || {}}
      const $ = () => globalThis.__customHost;
      ${appJs.slice(appJs.indexOf('function readOfflineDraft'), appJs.indexOf('function collectCustomFields'))}
      return {readOfflineDraft, writeOfflineDraft, setTemplatesOn(value){templatesOnFlag = value}};
    `);
    const memory = {};
    const localStorage = {getItem: key => memory[key] ?? null, setItem: (key, value) => {memory[key] = String(value)}};
    const drafts = draftFns(localStorage);
    memory['pdl-draft-0'] = 'Plain note only';
    assert.deepEqual(drafts.readOfflineDraft(0), {notes: 'Plain note only'});
    memory['pdl-draft-1'] = JSON.stringify({notes: 'Pinned note', templateId: 4, templateVersion: 1, customFields: {pour: 'east'}});
    const pinnedDraft = drafts.readOfflineDraft(1);
    assert.equal(pinnedDraft.notes, 'Pinned note');
    assert.equal(pinnedDraft.templateId, 4);
    assert.equal(pinnedDraft.templateVersion, 1);
    drafts.setTemplatesOn(false);
    drafts.writeOfflineDraft(2, 'Still a string');
    assert.equal(JSON.parse(memory['pdl-draft-2']).notes, 'Still a string');
    assert.equal(drafts.readOfflineDraft(2).notes, 'Still a string');
    drafts.setTemplatesOn(true);
    globalThis.__customHost = {dataset: {templateId: '9', templateVersion: '1'}};
    globalThis.__customFields = {pour: 'west'};
    drafts.writeOfflineDraft(3, 'Started offline');
    const stored = JSON.parse(memory['pdl-draft-3']);
    assert.equal(stored.notes, 'Started offline');
    assert.equal(stored.templateId, '9');
    assert.equal(stored.templateVersion, '1');
    assert.deepEqual(stored.customFields, {pour: 'west'});

    const db = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
    assert.equal(db.company.features, undefined);
    const legacyReport = db.reports.find(report => !report.templateId);
    const legacyLabor = JSON.parse(JSON.stringify(legacyReport.laborEntries || []));
    const owner = db.users.find(user => user.role === 'owner');
    const salt = crypto.randomBytes(16).toString('hex');
    owner.passwordSalt = salt;
    owner.passwordHash = crypto.scryptSync('OwnerPassword!42', salt, 64).toString('hex');
    owner.email = 'owner@example.test';
    fs.writeFileSync(dbFile, JSON.stringify(db));
    process.env.PDL_REQUIRE_AUTH = '1';

    const login = await request('/api/auth/login', {method: 'POST', body: JSON.stringify({email: 'owner@example.test', password: 'OwnerPassword!42'})});
    assert.equal(login.response.status, 200);
    const auth = {Authorization: `Bearer ${login.data.token}`};
    const platform = {'x-pdl-platform-key': platformKey};
    const meOff = await request('/api/auth/me', {headers: auth});
    assert.equal(meOff.response.headers.get('cache-control'), 'no-store');
    assert.equal(meOff.data.templates, false);
    for (const route of ['/api/daily-templates', '/api/daily-templates/default']) {
      const hidden = await request(route, {headers: auth, method: route.endsWith('default') ? 'POST' : 'GET', body: route.endsWith('default') ? JSON.stringify({templateId: 'standard'}) : undefined});
      assert.equal(hidden.response.status, 404, route);
    }
    const stateOff = await request('/api/state', {headers: auth});
    assert.equal(Object.hasOwn(stateOff.data, 'dailyTemplates'), false);
    const denied = await request('/api/platform/companies/northstar/features', {method: 'PATCH', headers: auth, body: JSON.stringify({templates: true})});
    assert.equal(denied.response.status, 401);
    const companyPatch = await request('/api/company', {method: 'PATCH', headers: auth, body: JSON.stringify({name: 'Northstar Construction', features: {templates: true}})});
    assert.equal(companyPatch.response.status, 200);
    assert.notEqual(companyPatch.data.features?.templates, true);
    const plainReport = await request('/api/reports', {method: 'POST', headers: auth, body: JSON.stringify({projectId: 1, notes: 'Templates are still off for this daily.', status: 'Draft', foreman: 'Levi Foreman', dateIso: '2026-09-18', productionEntries: [], laborEntries: [], templateId: 'standard', customFields: {note: 'ignored'}})});
    assert.equal(plainReport.response.status, 201);
    assert.equal(Object.hasOwn(plainReport.data, 'templateId'), false);
    assert.equal(Object.hasOwn(plainReport.data, 'templateVersion'), false);
    assert.equal(Object.hasOwn(plainReport.data, 'customFields'), false);
    const legacyDraft = await request('/api/reports', {method: 'POST', headers: auth, body: JSON.stringify({projectId: 1, notes: 'Legacy draft must stay unpinned.', status: 'Draft', foreman: 'Levi Foreman', dateIso: '2026-09-19', productionEntries: [], laborEntries: []})});
    assert.equal(legacyDraft.response.status, 201);
    assert.equal(Object.hasOwn(legacyDraft.data, 'templateId'), false);

    const enabled = await request('/api/platform/companies/northstar/features', {method: 'PATCH', headers: platform, body: JSON.stringify({templates: true})});
    assert.equal(enabled.response.status, 200);
    assert.equal(enabled.data.templates, true);
    const meOn = await request('/api/auth/me', {headers: auth});
    assert.equal(meOn.data.templates, true);
    assert.equal(meOn.response.headers.get('cache-control'), 'no-store');
    const library = await request('/api/daily-templates', {headers: auth});
    assert.equal(library.response.status, 200);
    const standard = library.data.templates.find(template => template.id === 'standard');
    assert.equal(standard.name, 'Standard');
    assert.equal(standard.locked, true);
    assert.equal(standard.versions.length, 1);
    assert.deepEqual(standard.versions[0].fields, []);
    assert.equal(library.data.defaultTemplateId, 'standard');
    const stateOn = await request('/api/state', {headers: auth});
    assert.ok(stateOn.data.dailyTemplates.some(template => template.id === 'standard' && template.locked));
    assert.equal((await request('/api/daily-templates/standard', {method: 'PATCH', headers: auth, body: JSON.stringify({name: 'Changed', fields: []})})).response.status, 409);
    assert.equal((await request('/api/daily-templates/standard', {method: 'DELETE', headers: auth})).response.status, 409);
    for (const fields of [[{label: 'Labor entries', type: 'text'}], [{id: 'job', label: 'Site note', type: 'text'}], [{label: 'Production entries', type: 'text'}]]) {
      const blocked = await request('/api/daily-templates', {method: 'POST', headers: auth, body: JSON.stringify({name: 'Core override', fields})});
      assert.equal(blocked.response.status, 400, JSON.stringify(fields));
      assert.match(blocked.data.error, /fixed daily fields/);
    }

    const versionOneFields = [
      {label: 'Pour location', type: 'text', required: true},
      {label: 'Inspector notes', type: 'longtext'},
      {label: 'Slump', type: 'number'},
      {label: 'Pump on site', type: 'yesno', required: true},
      {label: 'Placement', type: 'dropdown', options: ['East', 'West']},
      {label: 'Inspection date', type: 'date'}
    ];
    const created = await request('/api/daily-templates', {method: 'POST', headers: auth, body: JSON.stringify({name: 'Concrete pour', fields: versionOneFields})});
    assert.equal(created.response.status, 201);
    assert.equal(created.data.versions.length, 1);
    assert.equal(created.data.versions[0].version, 1);
    assert.equal(created.data.versions[0].fields[0].required, true);
    const originalFields = JSON.parse(JSON.stringify(created.data.versions[0].fields));
    const versionTwo = await request(`/api/daily-templates/${created.data.id}`, {method: 'PATCH', headers: auth, body: JSON.stringify({name: 'Concrete pour', fields: [...versionOneFields, {label: 'Cylinder count', type: 'number', required: true}]})});
    assert.equal(versionTwo.response.status, 200);
    assert.equal(versionTwo.data.versions.length, 2);
    assert.equal(versionTwo.data.versions[1].version, 2);
    assert.deepEqual(versionTwo.data.versions[0].fields, originalFields);
    assert.equal(versionTwo.data.versions[1].fields.at(-1).label, 'Cylinder count');
    const madeDefault = await request('/api/daily-templates/default', {method: 'POST', headers: auth, body: JSON.stringify({templateId: created.data.id})});
    assert.equal(madeDefault.response.status, 200);
    assert.equal(madeDefault.data.defaultTemplateId, created.data.id);

    const defaultProject = await request('/api/projects', {method: 'POST', headers: auth, body: JSON.stringify({customerId: 1, customer: 'Hawthorne Health', name: 'Default template job', contractType: 'estimated', code: 'DTJ', budget: '$1', site: '1 Main', estimateItems: []})});
    assert.equal(defaultProject.response.status, 201);
    assert.equal(defaultProject.data.templateId, created.data.id);
    assert.equal(defaultProject.data.templateVersion, 2);
    assert.equal(typeof defaultProject.data.id, 'number');
    const pinnedProject = await request('/api/projects', {method: 'POST', headers: auth, body: JSON.stringify({customerId: 1, customer: 'Hawthorne Health', name: 'Pinned template job', contractType: 'estimated', code: 'PTJ', budget: '$1', site: '2 Main', estimateItems: [], templateId: created.data.id, templateVersion: 1})});
    assert.equal(pinnedProject.response.status, 201);
    assert.equal(pinnedProject.data.templateId, created.data.id);
    assert.equal(pinnedProject.data.templateVersion, 1);

    const beforeHours = await request('/api/production', {headers: auth});
    const sentLabor = [{memberId: 1, hours: 2}];
    const daily = await request('/api/reports', {method: 'POST', headers: auth, body: JSON.stringify({projectId: pinnedProject.data.id, notes: 'Pinned daily with custom fields.', status: 'Needs review', foreman: 'Levi Foreman', dateIso: '2026-09-21', productionEntries: [{description: 'East wall pour', quantity: 1, unit: 'CY', laborHours: 2}], laborEntries: sentLabor, customFields: {laborEntries: [{memberId: 9, hours: 99}], 'pour-location': 'East wall', 'pump-on-site': false, slump: 0, placement: 'East', 'inspection-date': '2026-09-21'}})});
    assert.equal(daily.response.status, 201, daily.data?.error);
    assert.equal(daily.data.templateId, created.data.id);
    assert.equal(daily.data.templateVersion, 1);
    assert.equal(daily.data.customFields['pour-location'], 'East wall');
    assert.equal(daily.data.customFields['pump-on-site'], false);
    assert.equal(daily.data.customFields.slump, 0);
    assert.equal(Object.hasOwn(daily.data.customFields, 'laborEntries'), false);
    assert.deepEqual(daily.data.laborEntries.map(row => ({memberId: row.memberId, hours: row.hours})), sentLabor);
    const afterHours = await request('/api/production', {headers: auth});
    assert.deepEqual(afterHours.data, beforeHours.data);

    const moved = await request(`/api/daily-templates/${created.data.id}`, {method: 'PATCH', headers: auth, body: JSON.stringify({name: 'Concrete pour', fields: versionTwo.data.versions[1].fields})});
    assert.equal(moved.data.versions.at(-1).version, 3);
    const stillOld = await request('/api/state', {headers: auth});
    const storedDaily = stillOld.data.reports.find(report => report.id === daily.data.id);
    assert.equal(storedDaily.templateVersion, 1);
    const projectStill = stillOld.data.projects.find(project => project.id === pinnedProject.data.id);
    assert.equal(projectStill.templateVersion, 1);
    const nextOnOldPin = await request('/api/reports', {method: 'POST', headers: auth, body: JSON.stringify({projectId: pinnedProject.data.id, notes: 'New daily still uses the project pin.', status: 'Draft', foreman: 'Levi Foreman', dateIso: '2026-09-22', productionEntries: [], laborEntries: []})});
    assert.equal(nextOnOldPin.data.templateVersion, 1);
    const repinned = await request(`/api/projects/${pinnedProject.data.id}/template`, {method: 'PATCH', headers: auth, body: JSON.stringify({templateId: created.data.id})});
    assert.equal(repinned.data.templateVersion, 3);
    const offlinePin = await request('/api/reports', {method: 'POST', headers: auth, body: JSON.stringify({projectId: pinnedProject.data.id, notes: 'Offline draft started on version 1.', status: 'Draft', foreman: 'Levi Foreman', dateIso: '2026-09-23', productionEntries: [], laborEntries: [], templateId: created.data.id, templateVersion: 1, customFields: {'pour-location': 'Kept'}})});
    assert.equal(offlinePin.response.status, 201);
    assert.equal(offlinePin.data.templateVersion, 1);
    assert.equal(offlinePin.data.customFields['pour-location'], 'Kept');
    const latestDaily = await request('/api/reports', {method: 'POST', headers: auth, body: JSON.stringify({projectId: pinnedProject.data.id, notes: 'New daily after the project pin moved.', status: 'Draft', foreman: 'Levi Foreman', dateIso: '2026-09-24', productionEntries: [], laborEntries: []})});
    assert.equal(latestDaily.data.templateVersion, 3);
    const lockedPin = await request(`/api/reports/${daily.data.id}`, {method: 'PATCH', headers: auth, body: JSON.stringify({notes: 'Pinned daily with custom fields.', templateId: 'standard', templateVersion: 3, customFields: {'pour-location': 'East wall', 'pump-on-site': false}})});
    assert.equal(lockedPin.response.status, 200, lockedPin.data?.error);
    assert.equal(lockedPin.data.templateId, created.data.id);
    assert.equal(lockedPin.data.templateVersion, 1);

    const missing = await request('/api/reports', {method: 'POST', headers: auth, body: JSON.stringify({projectId: pinnedProject.data.id, notes: 'Missing a required custom field.', status: 'Needs review', foreman: 'Levi Foreman', dateIso: '2026-09-25', productionEntries: [], laborEntries: [], customFields: {'pour-location': 'East wall'}})});
    assert.equal(missing.response.status, 400);
    assert.match(missing.data.error, /Cylinder count is required|Pump on site is required/);
    const draftMissing = await request('/api/reports', {method: 'POST', headers: auth, body: JSON.stringify({projectId: pinnedProject.data.id, notes: 'Draft can wait for the required field.', status: 'Draft', foreman: 'Levi Foreman', dateIso: '2026-09-26', productionEntries: [], laborEntries: []})});
    assert.equal(draftMissing.response.status, 201);
    assert.equal(draftMissing.data.customFields['cylinder-count'], '');
    const oldVersionSubmit = await request(`/api/reports/${daily.data.id}`, {method: 'PATCH', headers: auth, body: JSON.stringify({status: 'Needs review', customFields: {'pour-location': 'East wall', 'pump-on-site': false}})});
    assert.equal(oldVersionSubmit.response.status, 200, oldVersionSubmit.data?.error);
    assert.equal(oldVersionSubmit.data.templateVersion, 1);

    const legacyPatched = await request(`/api/reports/${legacyReport.id}`, {method: 'PATCH', headers: auth, body: JSON.stringify({notes: legacyReport.notes, templateId: created.data.id, templateVersion: 3, customFields: {'pour-location': 'Should not stick'}})});
    assert.equal(legacyPatched.response.status, 200);
    assert.equal(Object.hasOwn(legacyPatched.data, 'templateId'), false);
    assert.equal(Object.hasOwn(legacyPatched.data, 'customFields'), false);
    assert.deepEqual(legacyPatched.data.laborEntries, legacyLabor);
    const merged = await request('/api/reports', {method: 'POST', headers: auth, body: JSON.stringify({projectId: 1, notes: 'Legacy draft must stay unpinned.', status: 'Draft', foreman: 'Levi Foreman', dateIso: '2026-09-19', productionEntries: [], laborEntries: [], templateId: created.data.id, templateVersion: 3, customFields: {'pour-location': 'Nope'}})});
    assert.equal(merged.response.status, 200);
    assert.equal(merged.data.id, legacyDraft.data.id);
    assert.equal(Object.hasOwn(merged.data, 'templateId'), false);
    assert.equal(Object.hasOwn(merged.data, 'customFields'), false);

    const fieldUser = (await request('/api/users', {method: 'POST', headers: auth, body: JSON.stringify({name: 'Field Template', email: 'field-templates@example.test', role: 'field', memberId: 1})})).data;
    assert.equal((await request('/api/auth/claim', {method: 'POST', body: JSON.stringify({email: fieldUser.email, temporaryPassword: fieldUser.temporaryPassword, password: 'FieldPassword!42'})})).response.status, 200);
    const fieldLogin = await request('/api/auth/login', {method: 'POST', body: JSON.stringify({email: 'field-templates@example.test', password: 'FieldPassword!42'})});
    const fieldAuth = {Authorization: `Bearer ${fieldLogin.data.token}`};
    assert.equal((await request('/api/daily-templates', {headers: fieldAuth})).response.status, 200);
    assert.equal((await request('/api/daily-templates', {method: 'POST', headers: fieldAuth, body: JSON.stringify({name: 'Field built', fields: [{label: 'Note', type: 'text'}]})})).response.status, 403);

    const disabled = await request('/api/platform/companies/northstar/features', {method: 'PATCH', headers: platform, body: JSON.stringify({templates: false})});
    assert.equal(disabled.data.templates, false);
    assert.equal((await request('/api/daily-templates', {headers: auth})).response.status, 404);
    const meOffAgain = await request('/api/auth/me', {headers: auth});
    assert.equal(meOffAgain.data.templates, false);
    const stateHidden = await request('/api/state', {headers: auth});
    assert.equal(Object.hasOwn(stateHidden.data, 'dailyTemplates'), false);
    const unchangedDaily = await request('/api/reports', {method: 'POST', headers: auth, body: JSON.stringify({projectId: 1, notes: 'Switch off leaves a new daily unchanged.', status: 'Draft', foreman: 'Levi Foreman', dateIso: '2026-09-27', productionEntries: [], laborEntries: [], templateId: created.data.id, customFields: {'pour-location': 'Hidden'}})});
    assert.equal(unchangedDaily.response.status, 201);
    assert.equal(Object.hasOwn(unchangedDaily.data, 'templateId'), false);
    assert.equal(Object.hasOwn(unchangedDaily.data, 'customFields'), false);
    const kept = await request(`/api/reports/${daily.data.id}`, {method: 'PATCH', headers: auth, body: JSON.stringify({notes: 'Pinned daily with custom fields.'})});
    assert.equal(kept.response.status, 200);
    assert.equal(kept.data.templateId, created.data.id);
    assert.equal(kept.data.templateVersion, 1);
    assert.equal(kept.data.customFields['pour-location'], 'East wall');
    const hiddenProject = await request('/api/projects', {method: 'POST', headers: auth, body: JSON.stringify({customerId: 1, customer: 'Hawthorne Health', name: 'No template while off', contractType: 'estimated', code: 'OFF', budget: '$1', site: '3 Main', estimateItems: [], templateId: created.data.id, templateVersion: 1})});
    assert.equal(hiddenProject.response.status, 201);
    assert.equal(Object.hasOwn(hiddenProject.data, 'templateId'), false);
    assert.equal(fs.readFileSync(fixturePath).equals(fixtureBefore), true);
    console.log('templates tests passed');
    server.close();
    process.exit(0);
  } catch (error) {
    console.error(error);
    server.close();
    process.exit(1);
  }
});
