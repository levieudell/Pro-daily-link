'use strict';
// Project events: deliveries, inspections, other trades on site.
// Office adds them to a project + day; everyone assigned to that project that
// day sees them (schedule chips for the office, My Day card for the field).
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-events-')), companyId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', ownerToken = 'synthetic-events-owner', fieldToken = 'synthetic-events-field';
const hash = token => crypto.createHash('sha256').update(token).digest('hex');
const db = {
  company: { id: companyId, name: 'Synthetic events', demo: true, timezone: 'UTC' },
  projects: [{ id: 101, name: 'Sunrise Slab', customer: 'Cust', site: 'Site A', status: 'Active' }, { id: 102, name: 'Other Job', customer: 'Cust', site: 'Site B', status: 'Active' }],
  team: [{ id: 7, name: 'Chloe', crew: 'A' }, { id: 8, name: 'Andi', crew: 'A' }],
  assignments: [{ id: 1, projectId: 101, memberIds: [7], crew: 'A', date: '2026-10-13', start: '07:00', end: '15:30', activity: 'Pour slab' }],
  workdays: [], timeCards: [], timeOffRequests: [], reports: [], photos: [], auditLog: [], projectTasks: [], projectEvents: [], customers: [], changes: [], catalog: [],
  users: [
    { id: 1, name: 'Synthetic owner', role: 'owner', status: 'Active', companyId },
    { id: 2, name: 'Field Chloe', role: 'field', status: 'Active', companyId, memberId: 7 }
  ],
  sessions: [
    { companyId, userId: 1, tokenHash: hash(ownerToken), expiresAt: '2099-01-01' },
    { companyId, userId: 2, tokenHash: hash(fieldToken), expiresAt: '2099-01-01' }
  ]
};
const file = path.join(root, 'db.json'); fs.writeFileSync(file, JSON.stringify(db)); fs.writeFileSync(path.join(root, 'platform.json'), JSON.stringify({ users: [], sessions: [] }));
Object.assign(process.env, { PDL_DB_FILE: file, PDL_PLATFORM_FILE: path.join(root, 'platform.json'), PDL_REQUIRE_AUTH: '1', PDL_SUPABASE_ENABLED: '0', PDL_TRANSACTIONAL_DB: 'off', PDL_EMAIL_DEV_MODE: '1' });
for (const name of ['OPENAI_API_KEY', 'SENTRY_DSN', 'RESEND_API_KEY', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET']) delete process.env[name];
require('./database/supabase').loadLocalEnv = () => {};
const { server } = require('./server');
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const call = (method, route, input, token = ownerToken) => fetch(base + route, { method, signal: AbortSignal.timeout(10000), headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', 'x-pdl-company': companyId }, ...(input !== undefined ? { body: JSON.stringify(input) } : {}) }).then(async response => ({ status: response.status, data: await response.json() }));
  const reload = () => JSON.parse(fs.readFileSync(file));
  try {
    // Create: office only, validated, persisted.
    const created = await call('POST', '/api/projects/101/events', { date: '2026-10-13', type: 'delivery', title: 'Rebar delivery 7 AM', notes: 'Stage by the east gate' });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    assert.equal(created.data.projectId, 101);
    assert.equal(created.data.type, 'delivery');
    assert.ok(reload().projectEvents.some(event => event.title === 'Rebar delivery 7 AM'));

    assert.equal((await call('POST', '/api/projects/101/events', { date: '2026-10-13', type: 'delivery', title: 'x' }, fieldToken)).status, 403, 'field cannot add events');
    assert.equal((await call('POST', '/api/projects/101/events', { date: 'nope', type: 'delivery', title: 'x' })).status, 400, 'date validated');
    assert.equal((await call('POST', '/api/projects/101/events', { date: '2026-10-13', type: 'spaceship', title: 'x' })).status, 400, 'type validated');
    assert.equal((await call('POST', '/api/projects/101/events', { date: '2026-10-13', type: 'delivery', title: '  ' })).status, 400, 'title required');
    assert.equal((await call('POST', '/api/projects/999/events', { date: '2026-10-13', type: 'delivery', title: 'x' })).status, 404, 'project must exist');

    // Second event on the other project for scoping checks.
    await call('POST', '/api/projects/102/events', { date: '2026-10-13', type: 'inspection', title: 'City inspection' });

    // Office state carries events.
    const officeState = await call('GET', '/api/state');
    assert.equal(officeState.status, 200);
    assert.equal((officeState.data.projectEvents || []).length, 2, 'office state includes events');

    // Field workspace: only events for projects the field member can see.
    const fieldState = await call('GET', '/api/state', undefined, fieldToken);
    assert.equal(fieldState.status, 200);
    const fieldEvents = fieldState.data.projectEvents || [];
    assert.equal(fieldEvents.length, 1, 'field sees only their project');
    assert.equal(fieldEvents[0].title, 'Rebar delivery 7 AM');

    // Delete: office only.
    assert.equal((await call('DELETE', `/api/project-events/${created.data.id}`, undefined, fieldToken)).status, 403, 'field cannot delete events');
    const removed = await call('DELETE', `/api/project-events/${created.data.id}`);
    assert.equal(removed.status, 200);
    assert.ok(!reload().projectEvents.some(event => event.id === created.data.id), 'delete persisted');
    assert.equal((await call('DELETE', '/api/project-events/12345')).status, 404);

    // Client contracts.
    const appJs = fs.readFileSync('app.js', 'utf8'), index = fs.readFileSync('index.html', 'utf8'), styles = fs.readFileSync('styles.css', 'utf8');
    for (const selector of ['id="event-modal"', 'id="event-project"', 'id="event-date"', 'id="event-type"', 'id="event-title"', 'id="event-notes"', 'id="save-event"', 'id="event-warning"']) assert.ok(index.includes(selector), 'event modal markup: ' + selector);
    assert.ok(index.includes('id="assignment-add-event"'), 'assignment composer offers Add event in the selected person/day context');
    assert.ok(index.includes('id="field-today-events"'), 'My Day has an events container');
    assert.ok(appJs.includes("$('#assignment-add-event').onclick"), 'assignment composer wires the event button');
    assert.ok(appJs.includes('leaveAssignmentForDayTool(openEventModal)'), 'switching to an event protects typed assignment details');
    assert.ok(appJs.includes('function scheduleEventChips'), 'board chip renderer exists');
    assert.ok(appJs.includes('${scheduleEventChips(member,day.date)}'), 'week/day cells render event chips');
    assert.ok(appJs.includes('field-today-events'), 'renderMyDay fills the My Day events container');
    assert.ok(appJs.includes('projectEvents=state.projectEvents||[]'), 'state loads events');
    assert.ok(appJs.includes('deleteProjectEvent'), 'chip click can remove an event');
    assert.ok(styles.includes('.schedule-event'), 'chips are styled');
    assert.ok(styles.includes('.field-events'), 'My Day events card is styled');

    console.log('project-events API + workspace scoping + client contracts: ok');
  } catch (error) { console.error('project-events FAILED:', error.message); process.exitCode = 1; }
  finally { server.close(); }
})();
