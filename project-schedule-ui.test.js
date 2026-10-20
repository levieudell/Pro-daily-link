'use strict';
// Project schedule tab contracts: script wiring, styles, static serving,
// server routes, and markup-safety conventions for the new module.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const index = fs.readFileSync('index.html', 'utf8');
const ui = fs.readFileSync('project-schedule-ui.js', 'utf8');
const engine = fs.readFileSync('project-schedule.js', 'utf8');
const server = fs.readFileSync('server.js', 'utf8');
const styles = fs.readFileSync('styles.css', 'utf8');
const i18n = fs.readFileSync('i18n.js', 'utf8');
const { isPublicFile } = require('./public-file-policy');

// Script loads after app.js (it patches openProject) and carries a version.
assert.ok(index.indexOf('app.js?') < index.indexOf('project-schedule-ui.js?'), 'module loads after app.js so openProject exists');
assert.match(index, /project-schedule-ui\.js\?v=20261014-uifix/);
assert.match(index, /styles\.css\?v=20261014-review3/);

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
{
  const assignmentFlow = ui.slice(ui.indexOf('async function assignTaskTo'), ui.indexOf("if (typeof openProject === 'function')"));
  assert.ok(assignmentFlow.indexOf('payload.tasks') < assignmentFlow.indexOf("api('/api/state')"), 'a committed task assignment updates the lane before the best-effort state refresh');
  assert.ok(assignmentFlow.indexOf('notify(`${who}') < assignmentFlow.indexOf("api('/api/state')"), 'success is confirmed from the write response and cannot be turned into a false failure by refresh');
}
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
assert.match(ui, /const todayIso = typeof companyTodayIso === 'function' \? companyTodayIso\(\)/, 'Gantt today uses the company calendar date');
assert.match(ui, /project\.startDate \|\| \(typeof companyTodayIso === 'function' \? companyTodayIso\(\)/, 'a blank project defaults its start date in the company timezone');
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
assert.match(ui, /laneVisibleFirstDay\s*=\s*firstDay/, 'every schedule repaint records the currently visible lane date');
assert.match(ui, /crewRow\)[^\n]+currentLaneDropDate\(\)/, 'the one-time crew drop listener reads the current date instead of its first-render closure');
assert.doesNotMatch(ui, /function wireLaneChips\(section,\s*firstDay\)/, 'lane handlers do not close over the first rendered period');
assert.match(ui, /function visibleLaneStart\(days\)[^]*companyTodayIso\(\)/, 'lane defaults use the company-local date');
assert.doesNotMatch(ui.slice(ui.indexOf('function visibleLaneStart'), ui.indexOf('function unassignedLaneTasks')), /localDateIso\(/, 'lane date selection never falls back to the device-local date');
{
  const currentDateHelper = ui.match(/function currentLaneDropDate\(\)\{[^}]+\}/)?.[0];
  assert.ok(currentDateHelper, 'current lane date helper exists');
  const context = {};
  vm.runInNewContext(`let laneVisibleFirstDay='2026-10-05';${currentDateHelper};this.beforeNavigation=currentLaneDropDate();laneVisibleFirstDay='2026-10-12';this.afterNavigation=currentLaneDropDate();`, context);
  assert.equal(context.beforeNavigation, '2026-10-05');
  assert.equal(context.afterNavigation, '2026-10-12', 'the already-wired drop path follows schedule navigation');
}
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

// Non-drag fallback uses the same one-step Crew / Person chooser as Add
// assignment. Its choices are built only from the already-scoped workspace
// team, so a project manager cannot discover an unassigned crew in the UI.
assert.match(ui, /data-task-assign-target=/, 'unassigned task chips render the unified target chooser');
assert.match(ui, /<optgroup label="Crews">/, 'whole crews are available without drag and drop');
assert.match(ui, /<optgroup label="People">/, 'individual people remain available without drag and drop');
assert.match(ui, /Choose a crew or person/, 'the fallback chooser says exactly what can be selected');
assert.match(ui, /Drag a task onto someone’s day — or choose a crew or person here\./, 'lane helper explains both drag and non-drag paths');
assert.doesNotMatch(ui, /pick a person right here/, 'lane helper no longer hides whole-crew assignment');
assert.match(ui, /laneAssignmentTarget\(select && select\.value\)/, 'the Assign button decodes either a crew or a person target');
assert.match(ui, /data-task-assign-date=/, 'quick assignment shows an explicit start-date control');
assert.match(ui, /data-task-assign-date="\$\{button\.dataset\.taskAssignGo\}"/, 'quick assignment reads the visible date for the selected task');
assert.match(ui, /value="\$\{escapeHtml\(assignDate\)\}" min="\$\{escapeHtml\(task\.startDate\)\}" max="\$\{escapeHtml\(task\.endDate\)\}"/, 'quick assignment exposes and constrains the effective task date');
assert.match(ui, /dateInput\.value < dateInput\.min \|\| dateInput\.value > dateInput\.max/, 'quick assignment blocks a date outside the task window before calling the API');
assert.match(ui, /assignTaskTo\(Number\(button\.dataset\.taskAssignGo\), target, dateInput\.value\)/, 'quick assignment sends the date the user can see and edit');
assert.doesNotMatch(ui.slice(ui.indexOf("section.querySelectorAll('[data-task-assign-go]')"), ui.indexOf('function paintUnassignedLane')), /currentLaneDropDate\(\)/, 'quick assignment never relies on a hidden computed date');
{
  const helpers = ui.slice(ui.indexOf('function laneAssignmentTargets'), ui.indexOf('function unassignedLaneTasks'));
  const context = {
    isOfficeMember: member => /office|admin/i.test(String(member.role || '')),
    companyTodayIso: () => '2026-10-07'
  };
  vm.createContext(context);
  vm.runInContext(`${helpers}\nthis.targets = laneAssignmentTargets([\n  { id: 1, name: 'Chloe', crew: 'Concrete', role: 'foreman' },\n  { id: 2, name: 'Andi', crew: 'Concrete', role: 'laborer' },\n  { id: 9, name: 'Office Pam', crew: 'Concrete', role: 'office manager' }\n]);\nthis.crewTarget = laneAssignmentTarget('crew:Concrete');\nthis.personTarget = laneAssignmentTarget('member:2');\nthis.visibleCurrent = visibleLaneStart([{date:'2026-10-05'},{date:'2026-10-06'},{date:'2026-10-07'},{date:'2026-10-08'}]);\nthis.visibleFuture = visibleLaneStart([{date:'2026-10-12'},{date:'2026-10-13'}]);\nthis.beforeTask = laneAssignmentDate({startDate:'2026-10-12',endDate:'2026-10-16'},'2026-10-07');\nthis.insideTask = laneAssignmentDate({startDate:'2026-10-12',endDate:'2026-10-16'},'2026-10-14');\nthis.afterTask = laneAssignmentDate({startDate:'2026-10-12',endDate:'2026-10-16'},'2026-10-20');`, context);
  assert.equal(context.targets.crews.length, 1, 'one scoped crew option is rendered');
  assert.equal(context.targets.crews[0].value, 'crew:Concrete');
  assert.match(context.targets.crews[0].label, /2 people$/, 'office members are not counted in a crew booking');
  assert.deepEqual({ ...context.crewTarget }, { crew: 'Concrete' }, 'whole-crew selection decodes for the API');
  assert.deepEqual({ ...context.personTarget }, { memberId: 2 }, 'person selection decodes for the API');
  assert.equal(context.visibleCurrent, '2026-10-07', 'company today is selected inside the visible period');
  assert.equal(context.visibleFuture, '2026-10-12', 'a future period begins on its first visible day');
  assert.equal(context.beforeTask, '2026-10-12', 'a visible day before the task clamps to the task start');
  assert.equal(context.insideTask, '2026-10-14', 'a visible day inside the task remains unchanged');
  assert.equal(context.afterTask, '2026-10-16', 'a visible day after the task clamps to the task end');
}

for (const [english, spanish] of [
  ['Unassigned project work', 'Trabajo de proyecto sin asignar'],
  ['Drag a task onto someone’s day — or choose a crew or person here.', 'Arrastre una tarea al día de alguien o elija aquí una cuadrilla o persona.'],
  ['Waiting for the office to assign a crew.', 'Esperando que la oficina asigne una cuadrilla.'],
  ['Every scheduled task has someone on it.', 'Todas las tareas programadas tienen personal asignado.'],
  ['Nothing waiting for a crew.', 'No hay trabajo pendiente de asignar.'],
  ['Choose a crew or person first', 'Primero elija una cuadrilla o persona'],
  ['Assign', 'Asignar']
]) assert.ok(i18n.includes(`'${english}':'${spanish}'`), `${english} is localized`);
assert.match(i18n, /replace\(\/\^Assign \(\.\+\) to\$\/i/, 'dynamic Assign aria-label is localized');
assert.match(i18n, /Crew \(\.\+\).*is on/, 'whole-crew success confirmation is localized');
assert.match(i18n, /joined an existing shift/, 'merged-shift result is localized');
assert.match(i18n, /time off or another job/, 'skipped-day result is localized');
{
  const helpers = i18n.slice(i18n.indexOf('function translatedLaneResult'), i18n.indexOf('function translated(value)'));
  const context = { es: {}, esLower: {} };
  vm.createContext(context);
  vm.runInContext(`${helpers}\nthis.aria=translatedScheduleText('Assign Set forms to');this.crewNotice=translatedScheduleText('Crew Concrete (2 people) is on “Set forms” — 3 days scheduled, 1 joined an existing shift, 2 skipped (time off or another job)');this.personNotice=translatedScheduleText('Chloe is on “Set forms” — 1 day scheduled');`, context);
  assert.equal(context.aria, 'Asignar Set forms a una cuadrilla o persona');
  assert.equal(context.crewNotice, 'Cuadrilla Concrete (2 personas) asignada a «Set forms» — 3 días programados, 1 se unió a un turno existente, 2 omitidos (tiempo libre u otro proyecto)');
  assert.equal(context.personNotice, 'Chloe está asignado a «Set forms» — 1 día programado');
}

// The entire project Schedule tab has first-class Spanish copy. Keep this list
// close to the UI so adding a new visible control without a translation fails
// the focused contract instead of escaping into production in English.
for (const [english, spanish] of [
  ['Project schedule', 'Cronograma del proyecto'],
  ['Linked tasks auto-schedule: a task starts the next working day after everything it waits for is done. Change one and the rest follow.', 'Las tareas vinculadas se programan automáticamente: una tarea comienza el siguiente día laborable después de que terminen todas sus dependencias. Cambie una y las demás se ajustarán.'],
  ['Table', 'Tabla'],
  ['Timeline', 'Línea de tiempo'],
  ['Task', 'Tarea'],
  ['From estimate', 'Del estimado'],
  ['Working days', 'Días laborables'],
  ['Waits for', 'Depende de'],
  ['Save task', 'Guardar tarea'],
  ['Not started', 'No iniciado'],
  ['Unassigned', 'Sin asignar'],
  ['None', 'Ninguno'],
  ['Approved daily-report quantities', 'Cantidades aprobadas de reportes diarios'],
  ['Crew (optional)', 'Cuadrilla (opcional)'],
  ['Pick one or more', 'Elija una o más opciones'],
  ['Nothing to pick yet', 'Aún no hay opciones'],
  ['Linked estimate line (optional)', 'Partida del estimado vinculada (opcional)'],
  ['Custom task / milestone', 'Tarea o hito personalizado'],
  ['No start date on this project yet.', 'Este proyecto aún no tiene fecha de inicio.'],
  ['Target end', 'Fecha objetivo de término'],
  ['Save dates', 'Guardar fechas'],
  ['Task name', 'Nombre de la tarea'],
  ['＋ Add task', '＋ Agregar tarea'],
  ['Length', 'Duración'],
  ['Dates', 'Fechas'],
  ['Assigned', 'Asignado'],
  ['Status / actions', 'Estado / acciones'],
  ['No scheduled tasks yet', 'Aún no hay tareas programadas'],
  ['Loading schedule…', 'Cargando cronograma…'],
  ['Schedule could not be loaded', 'No se pudo cargar el cronograma'],
  ['Pick a start date first', 'Primero elija una fecha de inicio'],
  ['Target end must be on or after the start date', 'La fecha objetivo de término debe ser igual o posterior a la fecha de inicio'],
  ['Project dates saved', 'Fechas del proyecto guardadas'],
  ['Give the task a name first', 'Primero escriba el nombre de la tarea'],
  ['Current assignment', 'Asignación actual']
]) assert.ok(i18n.includes(`'${english}':'${spanish}'`), `${english} is localized for the project schedule`);
assert.ok(i18n.includes("'e.g. Form footings, pour slab, rough inspection…':'Ej.: Encofrar zapatas, colar losa, inspeccionar instalaciones…'"), 'task-name placeholder is localized');

// Attribute localization includes native select group labels and restores the
// original English value when the user changes languages.
{
  const makeOptgroup = label => ({
    attrs: { label }, isConnected: true,
    getAttribute(name){ return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null; },
    setAttribute(name, value){ this.attrs[name] = value; }
  });
  const groups = ['Crews', 'People', 'Current assignment'].map(makeOptgroup);
  const title = { nodeType: 3, nodeValue: 'Project schedule', parentElement: { closest(){ return null; } }, isConnected: true };
  const body = {
    nodeType: 1, isConnected: true, classList: { toggle(){} },
    getAttribute(){ return null; }, setAttribute(){},
    querySelectorAll(selector){ return selector.includes('optgroup[label]') ? groups : []; }
  };
  const context = {
    window: {}, NodeFilter: { SHOW_TEXT: 4 },
    document: {
      body, documentElement: {},
      createTreeWalker(){ let used = false; return { currentNode: null, nextNode(){ if (used) return false; used = true; this.currentNode = title; return true; } }; }
    },
    MutationObserver: class { observe(){} }
  };
  vm.createContext(context);
  vm.runInContext(i18n, context);
  context.window.PDLLocale.set('es');
  assert.deepEqual(groups.map(group => group.attrs.label), ['Cuadrillas', 'Personas', 'Asignación actual']);
  assert.equal(title.nodeValue, 'Cronograma del proyecto');
  assert.equal(context.window.PDLLocale.translate('Forecast finish Oct 23'), 'Finalización prevista Oct 23');
  assert.equal(context.window.PDLLocale.translate('2 calendar days ahead of target.'), '2 días naturales antes de la fecha objetivo.');
  assert.equal(context.window.PDLLocale.translate('Status for Pour slab'), 'Estado de Pour slab');
  assert.equal(context.window.PDLLocale.translate('Concrete (crew) · waits for Forms'), 'Concrete (cuadrilla) · depende de Forms');
  assert.equal(context.window.PDLLocale.translate('Delete “Pour slab”? Linked tasks will move up to fill the gap.'), '¿Eliminar «Pour slab»? Las tareas vinculadas se adelantarán para cerrar el espacio.');
  context.window.PDLLocale.set('en');
  assert.deepEqual(groups.map(group => group.attrs.label), ['Crews', 'People', 'Current assignment']);
  assert.equal(title.nodeValue, 'Project schedule');
}

assert.match(i18n, /querySelectorAll\('input,textarea,\[aria-label\],\[title\],optgroup\[label\]'\)/, 'optgroup labels participate in attribute localization');
assert.match(i18n, /\['placeholder','aria-label','title','label'\]/, 'label attributes use the same reversible attribute store');
assert.match(ui, /projectScheduleCopy\(`Delete “\$\{task\.name\}”\?/, 'native delete confirmation is localized before it opens');
assert.doesNotMatch(ui, /toLocaleDateString\('en-US'/, 'timeline month labels follow the selected interface language');
assert.doesNotMatch(ui, /'SMTWTFS'/, 'timeline weekday labels are generated in the selected interface language');
assert.match(ui, /sorted\.filter\(t => Number\(t\.id\) !== Number\(task\.id\)\)/, 'edit form cannot link a task to itself');
for (const selector of ['.schedule-add-grid', '.schedule-field', '.schedule-chip', '.schedule-chip-row', '.schedule-add-actions'])
  assert.ok(styles.includes(selector), `${selector} styled`);

// Table and timeline are real accessible tabs, including keyboard navigation,
// and their dark surfaces use theme tokens instead of remaining light.
assert.match(ui, /role="tab" id="project-schedule-table-tab"/);
assert.match(ui, /role="tab" id="project-schedule-timeline-tab"/);
assert.match(ui, /aria-selected="\$\{scheduleView === 'table'\}"/);
assert.match(ui, /id="project-schedule-view-panel" role="tabpanel"/);
assert.match(ui, /event\.key === 'ArrowRight'/, 'tab switcher handles arrow keys');
assert.match(ui, /event\.key === 'Home'/, 'tab switcher handles Home and End');
assert.match(styles, /:root\[data-theme="dark"\] \.project-schedule-gantt/);
assert.match(styles, /:root\[data-theme="dark"\] \.project-schedule-forecast/);
assert.match(styles, /:root\[data-theme="dark"\] \.project-schedule-needs-start/);
assert.doesNotMatch(ui, /data-schedule-needs-start style=/, 'no-start alert no longer hard-codes a light inline surface');
assert.match(styles, /:root\[data-theme="dark"\] \.schedule-task-chip-main small,:root\[data-theme="dark"\] \.schedule-unassigned-head p\{color:var\(--text-secondary,#bdc5bf\)\}/, 'unassigned-lane secondary copy keeps AA contrast in dark mode');
assert.match(styles, /:root\[data-theme="dark"\] \.schedule-crew-row\.is-muted strong\{color:var\(--text-secondary,#bdc5bf\)\}/, 'muted crew headings keep AA contrast in dark mode');
{
  const luminance = hex => { const values = hex.match(/\w\w/g).map(value => parseInt(value, 16) / 255).map(value => value <= .03928 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4); return .2126 * values[0] + .7152 * values[1] + .0722 * values[2]; };
  const ratio = (foreground, background) => { const a = luminance(foreground), b = luminance(background); return (Math.max(a, b) + .05) / (Math.min(a, b) + .05); };
  for (const surface of ['1d2b25', '17211c', '1a2620']) assert.ok(ratio('bdc5bf', surface) >= 4.5, `dark secondary copy meets WCAG AA on #${surface}`);
}

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
