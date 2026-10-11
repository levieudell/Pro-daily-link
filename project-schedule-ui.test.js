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
assert.match(index, /project-schedule-ui\.js\?v=20261011-project-dates/);
assert.match(index, /styles\.css\?v=20261011-co-document/);

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

// Task assignment from the team schedule.
assert.ok(server.includes('projectTaskAssignRoute = url.pathname.match'), 'assign endpoint route exists');
assert.match(ui, /renderScheduleWithLane = renderSchedule/, 'team schedule render is wrapped');
assert.match(ui, /class="schedule-unassigned"/);
assert.match(ui, /data-schedule-task="\$\{Number\(task\.id\)\}"/);
assert.match(ui, /blockSelector: '\[data-schedule-task\]'/, 'chips get their own touch-drag attach');
assert.match(ui, /api\(`\/api\/project-tasks\/\$\{taskId\}\/assign`/);
assert.match(ui, /window\.PDLProjectScheduleUI = \{ assignTaskTo, paintUnassignedLane \}/);
// The project detail content is itself a <form>, so pane markup must never
// emit a nested <form> — the parser drops the tag and the handler never binds.
assert.equal((ui.match(/<form[\s>]/g) || []).length, 0, 'no nested form tags in schedule pane markup');
assert.match(ui, /<div class="project-schedule-add" data-schedule-add-form>/);
assert.match(ui, /data-add-task/);
assert.match(ui, /paintProjectScheduleTab\(projectId\)/, 'clicking the Schedule tab repaints it with fresh data');

// Project start/end dates: editable from the Schedule pane, saved through a
// dedicated PATCH that runs before the contract-pricing guard.
assert.ok(server.includes('projectDatesRoute=url.pathname.match'), 'project dates PATCH route exists');
assert.ok(server.indexOf('projectDatesRoute') < server.indexOf('Turn on contract value tracking in Company settings before adding project pricing'), 'dates route runs before the pricing guard');
assert.match(server, /rescheduledTasks\(db, project\.id\)/, 'saving dates re-anchors linked tasks');
assert.match(ui, /data-project-dates-form/);
assert.match(ui, /data-save-project-dates/);
assert.match(ui, /data-project-start-date/);
assert.match(ui, /data-schedule-needs-start/, 'a no-start-date project gets a set-one prompt');
assert.match(ui, /api\(`\/api\/projects\/\$\{project\.id\}`/, 'dates save through the project PATCH');
for (const selector of ['.schedule-unassigned', '.schedule-task-chip', '.schedule-task-assign'])
  assert.ok(styles.includes(selector), `${selector} styled`);

console.log('project-schedule UI contracts: ok');
