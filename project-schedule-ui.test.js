'use strict';
// Project schedule tab contracts: script wiring, styles, static serving,
// server routes, and markup-safety conventions for the new module.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const index = fs.readFileSync('index.html', 'utf8');
const ui = fs.readFileSync('project-schedule-ui.js', 'utf8');
const engine = fs.readFileSync('project-schedule.js', 'utf8');
const server = fs.readFileSync('server.js', 'utf8');
const styles = fs.readFileSync('styles.css', 'utf8');
const { isPublicFile } = require('./public-file-policy');

// Script loads after app.js (it patches openProject) and carries a version.
assert.ok(index.indexOf('app.js?') < index.indexOf('project-schedule-ui.js?'), 'module loads after app.js so openProject exists');
assert.match(index, /project-schedule-ui\.js\?v=20261010-project-schedule/);
assert.match(index, /styles\.css\?v=20261010-project-schedule/);

// Static serving + server wiring.
assert.equal(isPublicFile(process.cwd(), path.join(process.cwd(), 'project-schedule-ui.js')), true, 'UI module is publicly served');
assert.equal(isPublicFile(process.cwd(), path.join(process.cwd(), 'project-schedule.js')), false, 'server-only engine is not publicly served');
assert.match(server, /require\('\.\/project-schedule'\)/);
assert.ok(server.includes('projectTasksRoute = url.pathname.match'), 'project tasks collection route');
assert.ok(server.includes('projectTaskRoute = url.pathname.match'), 'single task route');
assert.match(server, /'projectTasks'\]/, 'test-customer purge covers project tasks');

// Module contracts.
assert.match(ui, /openProjectWithSchedule = openProject/);
assert.match(ui, /api\(`\/api\/projects\/\$\{project\.id\}\/tasks`/);
assert.match(ui, /\/api\/project-tasks\/\$\{/);
assert.match(ui, /escapeHtml\(task\.name\)/, 'task names are escaped in row markup');
assert.match(ui, /data-project-detail-tab="schedule"/);
assert.match(ui, /data-project-detail-pane="schedule"/);
assert.match(ui, /sequence !== scheduleTabSequence/, 'late responses cannot paint a stale project pane');
assert.ok((ui.match(/escapeHtml\(/g) || []).length >= 8, 'user-controlled values are escaped throughout');

// Engine safety valves.
assert.match(engine, /link back on themselves/, 'cycles produce a human-readable error');

// Styles exist for the new surfaces.
for (const selector of ['.project-schedule-table', '.project-schedule-track', '.project-schedule-add', '.project-schedule-editor', '.project-schedule-dep'])
  assert.ok(styles.includes(selector), `${selector} styled`);
assert.match(styles, /@media\(max-width:760px\)[^]*project-schedule-editor\{grid-template-columns:1fr\}/);

console.log('project-schedule UI contracts: ok');
