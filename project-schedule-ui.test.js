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
assert.match(index, /project-schedule-ui\.js\?v=20261014-forms/);
assert.match(index, /styles\.css\?v=20261014-forms/);

// Static serving + server wiring.
assert.equal(isPublicFile(process.cwd(), path.join(process.cwd(), 'project-schedule-ui.js')), true, 'UI module is publicly served');
assert.equal(isPublicFile(process.cwd(), path.join(process.cwd(), 'project-schedule.js')), false, 'server-only engine is not publicly served');
assert.match(server, /require\('\.\/project-schedule'\)/);
assert.ok(server.includes('projectTasksRoute = url.pathname.match'), 'project tasks collection route');
assert.ok(server.includes('projectTaskRoute = url.pathname.match'), 'single task route');
assert.match(server, /'projectTasks','projectEvents','projectMessages'\]/, 'test-customer purge covers project tasks, events, and messages');
assert.match(server, /'projectEvents','projectMessages'\]/, 'test-customer purge covers project events and messages');
assert.ok(server.includes('projectEventsRoute = url.pathname.match'), 'project events collection route');
assert.ok(server.includes('projectEventRoute = url.pathname.match'), 'single event route');
assert.ok(server.includes("filter(event=>scope.allowedIds.has(event.projectId))"), 'field workspace scopes events');
assert.ok(server.includes("filter(event=>scope.projectIds.has(Number(event.projectId)))"), 'manager workspace scopes events');

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
assert.match(ui, /window\.PDLProjectScheduleUI = \{ assignTaskTo, paintUnassignedLane, estimateProgress, get draggingTaskId\(\)\{ return draggedTaskId; \} \}/, 'lane module exposes its drag state and the progress rollup');
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

// 2026 schedule enhancements: timeline view, forecast banner, assignee pickers.
assert.match(ui, /data-schedule-view="table"/, 'table/timeline view toggle renders');
assert.match(ui, /function ganttChart\(project, sorted\)/, 'gantt builder exists');
assert.match(ui, /class="gantt-bar\$\{statusClass\}"/, 'gantt bars carry status color classes');
assert.match(ui, /gantt-weekend/, 'weekend columns shaded');
assert.match(ui, /gantt-today/, 'today marker on the timeline');
assert.match(ui, /function forecastBanner\(project, sorted\)/, 'forecast banner builder exists');
assert.match(ui, /data-schedule-forecast/, 'forecast banner rendered');
assert.match(ui, /is-ahead/, 'ahead-of-target state');
assert.match(ui, /is-behind/, 'past-target state');
assert.match(ui, /data-new-task-members/, 'add form assigns people');
assert.match(ui, /data-new-task-crew/, 'add form assigns a crew');
assert.match(ui, /data-edit-task-members/, 'edit form assigns people');
assert.match(ui, /data-edit-task-crew/, 'edit form assigns a crew');
assert.match(ui, /memberIds, crew \}\)/, 'payloads send assignees to the server');
assert.match(ui, /project-schedule-track\$\{statusClass\}/, 'table mini-bars carry status tints');
for (const selector of ['.project-schedule-gantt', '.gantt-head', '.gantt-row', '.gantt-bar', '.gantt-day', '.gantt-month', '.project-schedule-forecast', '.project-schedule-view-toggle'])
  assert.ok(styles.includes(selector), `${selector} styled`);

// 2026 add/edit form: chip pickers hide the native multi-select but keep it in
// the DOM so selectedValues() still reads selections, and both forms use the
// labeled grid fields.
assert.match(ui, /function chipPick\(field, options, selected\)/, 'chip picker builder exists');
assert.match(ui, /data-chip-value="\$\{Number\(o\.value\)\}"/, 'chips toggle option selection');
assert.match(ui, /schedule-chip-select/, 'native multi-select stays in the DOM for wiring');
assert.match(ui, /option\.selected = on/, 'chip clicks write back to the select');
assert.match(ui, /class="schedule-add-grid"/, 'add form uses the labeled grid');
assert.match(ui, /schedule-span-2/, 'form fields span grid columns');
assert.match(ui, /data-new-task-name placeholder="e\.g\. Form footings/, 'name field carries a real example placeholder');
// Crew drag-and-drop: dropping a task on a crew group header books every
// active field member of that crew and claims the task for the crew.
assert.match(ui, /target\.crew \? \{ crew: target\.crew, fromDate \} : \{ memberId: target\.memberId, fromDate \}/, 'crew drops send the crew name to the assign endpoint');
assert.match(ui, /closest\('\[data-schedule-crew-drop\]'\)/, 'the lane drop listener accepts crew group headers');
assert.match(ui, /Crew \$\{payload\.crew\}/, 'crew bookings name the crew in the confirmation');
assert.match(server, /input\.crew != null && String\(input\.crew\)\.trim\(\) !== ''/, 'assign endpoint accepts a whole crew');
assert.match(server, /task\.memberIds = bookedIds;\s*\n?\s*task\.assignedAt = now;\s*\n?\s*task\.assignedBy = req\.auth\?\.user\.name/, 'crew booking snapshots the booked members onto the task');
assert.match(server, /officeLike/, 'office-role members are excluded from crew bookings');
assert.match(server, /That crew has no active field members/, 'a crewless crew is rejected with a plain message');
const app = fs.readFileSync('app.js', 'utf8');
assert.ok(app.includes('data-schedule-crew-drop'), 'team schedule board renders crew group header rows');
assert.ok(app.includes('boardTeam'), 'the board groups members by crew when the All crews filter is on');
assert.ok(app.includes('drop a task here to book the whole crew'), 'crew headers tell the office what dropping does');
for (const selector of ['.schedule-crew-row', '.schedule-crew-row.drag-over', '.schedule-crew-row.is-muted'])
  assert.ok(styles.includes(selector), `${selector} styled`);
assert.match(ui, /sorted\.filter\(t => Number\(t\.id\) !== Number\(task\.id\)\)/, 'edit form cannot link a task to itself');
for (const selector of ['.schedule-add-grid', '.schedule-field', '.schedule-chip', '.schedule-chip-row', '.schedule-add-actions'])
  assert.ok(styles.includes(selector), `${selector} styled`);

// Planned-vs-done progress on estimate-linked tasks: planned quantity from the
// estimate line, done from approved daily-report production entries. Office
// workspace only (the field report subset has no production entries).
assert.match(ui, /function estimateProgress\(project, estimateItemId\)/, 'progress rollup helper exists');
assert.match(ui, /row\.status === 'Approved' && !row\.deletedAt/, 'only approved, live reports count');
assert.match(ui, /currentRole === 'field'\) return null/, 'field workspace skips progress instead of reading zero');
assert.match(ui, /class="project-schedule-progress"/, 'table rows render the progress chip');
assert.match(ui, /Approved daily-report quantities/, 'progress chip explains its source');
assert.match(ui, /progressText\(progress\) \? ` · \$\{escapeHtml\(progressText\(progress\)\)\}`/, 'gantt labels carry progress');
for (const selector of ['.project-schedule-progress', '.project-schedule-progress i', '.project-schedule-progress u'])
  assert.ok(styles.includes(selector), `${selector} styled`);

console.log('project-schedule UI contracts: ok');
