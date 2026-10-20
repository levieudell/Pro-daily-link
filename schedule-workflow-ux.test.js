'use strict';

// Product contract for the streamlined office scheduling workflow. This test
// intentionally exercises durable behavior/semantics rather than pixel values
// or source formatting so the UI can keep evolving without weakening the UX.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const index = fs.readFileSync('index.html', 'utf8');
const app = fs.readFileSync('app.js', 'utf8');
const i18n = fs.readFileSync('i18n.js', 'utf8');
const styles = fs.readFileSync('styles.css', 'utf8') + '\n' + fs.readFileSync('design-system.css', 'utf8');

const failures = [];
function contract(name, run) {
  try { run(); }
  catch (error) { failures.push(`${name}: ${error.message}`); }
}
function sourceBetween(start, end) {
  const from = app.indexOf(start), to = app.indexOf(end, from + start.length);
  assert.ok(from >= 0, `missing ${start}`);
  assert.ok(to > from, `missing boundary ${end}`);
  return app.slice(from, to);
}
function sourceAfter(start, length = 6000) {
  const from = app.indexOf(start);
  assert.ok(from >= 0, `missing ${start}`);
  return app.slice(from, from + length);
}

contract('one assignee chooser replaces the crew/person two-step', () => {
  assert.doesNotMatch(index, /id="assignment-type"/, 'do not make schedulers choose a type before choosing a crew or person');
  assert.match(index, /id="assignment-target"[^>]*>/, 'one assignee control is present');
  assert.match(app, /(?:optgroup[^>]+Crews|crew:)[\s\S]{0,1400}(?:optgroup[^>]+People|member:)/i,
    'the one chooser clearly contains both crews and individual people');
});

contract('the assignee chooser can be searched without changing its canonical selection', () => {
  assert.match(index, /id="assignment-target-search"[^>]*type="search"[^>]*aria-controls="assignment-target"/,
    'the assignment composer exposes a labeled search control tied to the native picker');
  assert.match(index, /id="assignment-target-search-status"[^>]*role="status"[^>]*aria-live="polite"/,
    'search result and empty-state feedback is announced');
  const search = sourceBetween('let assignmentTargetChoices=[];', 'function assignmentWorkDates(');
  assert.match(search, /normalize\(['"]NFD['"]\)[\s\S]{0,120}\\u0300-\\u036f/,
    'search is case- and accent-insensitive');
  assert.match(search, /toLocaleLowerCase\(\)\.trim\(\)\.replace\(\/\\s\+\/g,['"] ['"]\)/,
    'search tolerates leading and repeated whitespace');
  assert.match(search, /search:`\$\{member\.name\} \$\{member\.crew\|\|''\} \$\{member\.role\|\|''\}`/,
    'teammates can be found by name, crew, or role without indexing private contact fields');
  assert.match(search, /retained[\s\S]{0,300}Current selection/,
    'filtering never silently discards an existing assignee or stored roster');
  assert.match(search, /crewPeople=fieldPeople\.filter\(member=>!isOfficeMember\(member\)\)[\s\S]{0,900}crewPeople\.filter\(member=>member\.crew===crew\)\.length/,
    'crew option counts use the same field-only roster that whole-crew scheduling sends');
  assert.match(search, /function assignmentPeopleCountLabel\(count\)[\s\S]{0,180}personas/,
    'dynamic crew counts use the selected interface language');
  assert.doesNotMatch(search, /api\(/,
    'search filters the already permission-scoped roster instead of querying a broader endpoint');
  const state = sourceBetween('function assignmentFormState(', 'function repeatWeekSourceRows(');
  assert.doesNotMatch(state, /assignment-target-search/,
    'a search query is navigation, not an unsaved schedule change');
  assert.match(styles, /\.assignment-target-search input\{[^}]*min-height:46px[^}]*font-size:16px/,
    'the phone search target is large enough to tap and does not trigger iPhone zoom');
  assert.match(i18n, /'Search crews or teammates':'Buscar cuadrillas o compañeros'/,
    'the searchable assignment UI has Spanish copy');
});

contract('a new assignment never silently chooses the first project', () => {
  const open = sourceBetween('function openAssignment(', "$('#new-assignment').onclick");
  assert.match(open, /<option\s+value=["']{2}[^>]*>[^<]*(?:Choose|Select)[^<]*project/i,
    'project options begin with an explicit Choose project placeholder');
  assert.match(open, /assignment-project[^\n]{0,800}value\s*=\s*["']{2}/,
    'new-assignment state explicitly leaves the project blank');
});

contract('new assignments default to the schedule date being viewed', () => {
  const open = sourceBetween('function openAssignment(', "$('#new-assignment').onclick");
  assert.match(open, /prefill\.date[\s\S]{0,160}scheduleAnchorDate[\s\S]{0,160}companyTodayIso\(\)/,
    'default order is clicked date, viewed schedule anchor, then company today');
});

contract('multiple days are progressive disclosure', () => {
  assert.match(index, /id="assignment-multiple-days"/, 'the compact form has an Add multiple days control');
  assert.match(index, /id="assignment-range-fields"[^>]*hidden/, 'through-date and weekend choices start hidden');
  assert.match(app, /assignment-multiple-days[\s\S]{0,1200}assignment-range-fields[\s\S]{0,400}(?:hidden|toggleAttribute)/,
    'the range controls are revealed from the multiple-days choice');
});

contract('the composer explains the assignment before saving', () => {
  assert.match(index, /id="assignment-preview"[^>]*(?:role="status"|aria-live="polite")/,
    'the composer has a screen-reader-readable live preview');
  assert.match(app, /function\s+(?:render|update)AssignmentPreview\s*\(/,
    'a dedicated preview renderer keeps the summary live');
  assert.match(app, /(?:preflight|preview)[\s\S]{0,1800}(?:conflict|scheduleUnavailable|assignments)/i,
    'preview/preflight identifies conflicts before the final save');
});

contract('an empty schedule slot opens the composer directly', () => {
  const render = sourceBetween('function renderSchedule(', 'async function moveScheduledWork(');
  assert.doesNotMatch(render, /openDayAction\(/, 'do not insert a second decision dialog between an empty slot and assignment');
  assert.match(render, /data-schedule-date[\s\S]{0,5000}openAssignment\(\{[^}]*memberId[^}]*date/s,
    'an empty person/day slot opens the assignment composer with person and date context');
});

contract('validation is visible and announced', () => {
  assert.match(index, /id="assignment-warning"[^>]*role="alert"[^>]*aria-live="assertive"|id="assignment-warning"[^>]*aria-live="assertive"[^>]*role="alert"/,
    'assignment errors use role=alert and assertive live announcement');
  const save = sourceAfter("$('#save-assignment').onclick", 7000);
  assert.match(save, /(?:checkValidity|reportValidity|validateAssignment)/,
    'client validation runs before a network request');
  assert.match(save, /(?:focus|scrollIntoView)/,
    'the first invalid field is brought into view instead of leaving the button apparently dead');
  assert.match(app, /function\s+updateAssignmentPreview\s*\(\)\s*\{\s*resetAssignmentValidation\(\)/,
    'fixing a field immediately clears stale warning and invalid state before refreshing the preview');
});

contract('every schedule dialog has an accessible name', () => {
  for (const id of ['assignment-modal', 'schedule-date-dialog', 'assignment-detail-modal', 'repeat-week-modal', 'repeat-week-result', 'event-modal', 'event-detail-modal', 'mark-off-modal']) {
    const match = index.match(new RegExp(`<dialog[^>]*id=["']${id}["'][^>]*>`));
    assert.ok(match, `${id} exists`);
    assert.match(match[0], /aria-labelledby=|aria-label=/, `${id} exposes an accessible name`);
  }
});

contract('mobile month view is compact and omits empty days', () => {
  assert.match(app, /schedule-mobile-month/, 'month gets a purpose-built compact mobile surface');
  assert.match(app, /scheduleView\s*===\s*['"]month['"][\s\S]{0,1400}filter\([^)]*(?:length|assignment|event|leave|today)/,
    'mobile month output filters the long list down to meaningful days');
  assert.match(styles, /@media\(max-width:760px\)[\s\S]*\.schedule-mobile-month/,
    'the compact month surface has phone-specific layout rules');
});

contract('day and month controls have names and keyboard operation', () => {
  const render = sourceBetween('function renderSchedule(', 'async function moveScheduledWork(');
  assert.match(render, /data-month-date=[^>]+aria-label=/,
    'month day buttons expose a full-date action name');
  assert.match(render, /data-schedule-date=[^>]+(?:role="button"|<button)/,
    'empty day/person slots are real buttons or button-semantic controls');
  assert.match(render, /data-schedule-date[\s\S]{0,8000}onkeydown[\s\S]{0,300}(?:Enter|['"] ['"])/,
    'empty day/person slots support keyboard activation');
});

contract('unassigning work requires confirmation', () => {
  const remove = sourceAfter('async function removeScheduledWork(', 5000);
  assert.match(remove, /(?:confirm\(|showModal\(|requestConfirmation)/,
    'destructive unassign is confirmed before the DELETE request');
  assert.ok(remove.indexOf('confirm(') < 0 || remove.indexOf('confirm(') < remove.indexOf("method:'DELETE'"),
    'confirmation happens before deletion');
});

contract('assignment composer protects every unsaved field on every exit path', () => {
  const state = sourceBetween('function assignmentFormState(', 'function repeatWeekSourceRows(');
  for (const field of ['assignment-target', 'assignment-project', 'assignment-date', 'assignment-start', 'assignment-end', 'assignment-activity', 'assignment-end-date', 'assignment-include-weekends', 'assignment-range-fields']) {
    assert.match(state, new RegExp(field), `${field} participates in the dirty comparison`);
  }
  assert.match(state, /JSON\.stringify/, 'composer state uses one stable comparison snapshot');
  assert.match(app, /assignmentFormBaseline\s*=\s*assignmentFormState\(\)/,
    'opening the composer records its pristine state after defaults and edit values are populated');
  assert.match(app, /dialog\.id===['"]assignment-modal['"]&&!confirmAssignmentDiscard\(\)/,
    'the shared Cancel, close-button, and backdrop path checks the assignment dirty guard');
  assert.match(app, /assignmentModal\.addEventListener\(['"]cancel['"][\s\S]{0,180}confirmAssignmentDiscard/,
    'Escape checks the same assignment dirty guard');
  const dayTools = sourceBetween('function leaveAssignmentForDayTool(', "$('#assignment-add-event').onclick");
  assert.match(dayTools, /assignmentFormDirty\(\)[\s\S]{0,200}confirm\(/,
    'switching to a different day tool warns before discarding changed assignment details');
});

contract('project event chips open readable details and delete only from an explicit gated action', () => {
  assert.match(index, /id="event-detail-modal"[^>]*aria-labelledby="event-detail-title"/,
    'events have an accessible read-only detail dialog');
  assert.match(index, /id="event-detail-content"/, 'the detail dialog has a dedicated readable summary');
  assert.match(index, /id="remove-project-event"/, 'event deletion has an explicit affordance');
  const chips = sourceBetween('function scheduleEventChips(', 'function openEventModal(');
  assert.match(chips, /aria-label="View event details:/,
    'an event chip describes a non-destructive view action');
  assert.match(chips, /function openProjectEvent\(/,
    'the schedule has a dedicated event viewer');
  assert.match(chips, /remove\.hidden\s*=\s*!canManageSchedule\(\)/,
    'viewers can read details while only schedulers see the remove action');
  const render = sourceBetween('function renderSchedule(', 'async function moveScheduledWork(');
  assert.match(render, /schedule-event[^\n]+openProjectEvent/,
    'selecting an event opens details instead of deleting it');
  assert.doesNotMatch(render, /schedule-event[^\n]+deleteProjectEvent/,
    'event chips never call delete directly');
  const remove = sourceBetween('async function deleteProjectEvent(', '// Project messages:');
  assert.match(remove, /if\(!canManageSchedule\(\)\)return/,
    'event deletion is scheduler-gated');
  assert.ok(remove.indexOf('confirm(') < remove.indexOf("method:'DELETE'"),
    'event deletion is confirmed before the request');
});

contract('assignment details show the whole roster and acknowledgement state', () => {
  const detail = sourceBetween('function openScheduledWork(', 'function editScheduledWork(');
  assert.match(detail, /(?:scheduled-roster|assignment-roster)/,
    'detail view has a roster rather than only the clicked person');
  assert.match(detail, /assignment\.memberIds[\s\S]{0,1200}(?:Acknowledged|Awaiting acknowledgement|Not yet acknowledged)/,
    'each scheduled person gets a readable acknowledgement status');
});

contract('a confirmed drag move updates locally before best-effort refresh', () => {
  const move = sourceBetween('async function moveScheduledWork(', 'function renderScheduleFilterState(');
  assert.match(move, /const\s+result\s*=\s*await\s+api\([^;]+method:\s*['"]PATCH['"]/,
    'the PATCH response is captured');
  assert.ok(move.indexOf('result.assignment') < move.indexOf("api('/api/state')"),
    'the confirmed server assignment is applied before a full-state refresh');
});

contract('the complete schedule workflow follows the selected language', () => {
  const body = {
    nodeType: 1, isConnected: true, classList: { toggle(){} },
    getAttribute(){ return null; }, setAttribute(){}, querySelectorAll(){ return []; }
  };
  const context = {
    window: {}, NodeFilter: { SHOW_TEXT: 4 },
    document: { body, documentElement: {}, createTreeWalker(){ return { currentNode: null, nextNode(){ return false; } }; } },
    MutationObserver: class { observe(){} }
  };
  vm.createContext(context);
  vm.runInContext(i18n, context);
  const scheduleCopySource = app.split(/\r?\n/).find(line => line.startsWith('function scheduleCopy('));
  assert.ok(scheduleCopySource, 'schedule copy helper exists');
  vm.runInContext(scheduleCopySource, context);

  const cases = [
    ['All day', 'Todo el día'],
    ['Oct 19 · Today', 'Oct 19 · Hoy'],
    ['JOB · Unknown project', 'JOB · Proyecto desconocido'],
    ['On site', 'En el sitio'],
    ['2 on site', '2 en el sitio'],
    ['On site · 1h 15m', 'En el sitio · 1h 15m'],
    ['2 on site · 8m', '2 en el sitio · 8m'],
    ['✓ Done', '✓ Listo'],
    ['✓ Done · 8.5h', '✓ Listo · 8.5h'],
    ['Not on site · 25m late', 'Fuera del sitio · 25m de retraso'],
    ['Current roster · 3 assigned people', 'Lista actual · 3 personas asignadas'],
    ['Mon, Oct 19 through Fri, Oct 23', 'Mon, Oct 19 al Fri, Oct 23'],
    ['Choose at least one assignment to copy.', 'Elija al menos una asignación para copiar.'],
    ['Weekly copy limit reached', 'Se alcanzó el límite semanal de copias'],
    ['No longer on the schedule', 'Ya no está en el horario'],
    ['No longer available', 'Ya no está disponible'],
    ['Project no longer exists', 'El proyecto ya no existe'],
    ['Already scheduled on that day', 'Ya está programado ese día'],
    ['Outside your assigned projects and crews', 'Fuera de sus proyectos y cuadrillas asignados'],
    ['Does not belong to the source week', 'No pertenece a la semana de origen'],
    ['No team members on the assignment', 'No hay miembros del equipo en la asignación'],
    ['Approved time-off conflict', 'Conflicto con tiempo libre aprobado'],
    ['Chloe unavailable on Oct 20', 'Chloe no está disponible el Oct 20'],
    ['Schedule conflict for Chloe, Andi', 'Conflicto de horario para Chloe, Andi'],
    ['Assignment #42', 'Asignación #42'],
    ["Add event · Chloe's day", 'Agregar evento · día de Chloe'],
    ['Pick the project, day, and a short title.', 'Elija el proyecto, el día y un título breve.'],
    ['Adding…', 'Agregando…'],
    ['Event added — the crew sees it on their day', 'Evento agregado — la cuadrilla lo verá en su día'],
    ['Event removed', 'Evento eliminado'],
    ['PROJECT EVENT', 'EVENTO DEL PROYECTO'],
    ['Deliveries, inspections, other trades on site — everyone assigned to the project that day sees it in their day.', 'Las entregas, inspecciones y otros oficios en el sitio se muestran ese día a todas las personas asignadas al proyecto.'],
    ['Type', 'Tipo'],
    ['🚚 Delivery', '🚚 Entrega'],
    ['🔍 Inspection', '🔍 Inspección'],
    ['🤝 Other trade on site', '🤝 Otro oficio en el sitio'],
    ['🦺 Safety', '🦺 Seguridad'],
    ['📌 Other', '📌 Otro'],
    ['Title', 'Título'],
    ['Notes for the crew (optional)', 'Notas para la cuadrilla (opcional)'],
    ['e.g. Rebar delivery 7 AM', 'Ej.: Entrega de varilla a las 7 a. m.'],
    ['Where to stage it, who to expect, anything they need to know', 'Dónde descargar, a quién esperar y qué necesitan saber'],
    ['Reason', 'Motivo'],
    ['Called in sick', 'Reportó enfermedad'],
    ['Personal day', 'Día personal'],
    ['No work', 'Sin trabajo'],
    ['Other', 'Otro'],
    ['Note', 'Nota'],
    ['Optional detail for the record', 'Detalle opcional para el registro'],
    ['Example: Doctor appointment', 'Ejemplo: Cita médica'],
    ['How is the day counted?', '¿Cómo se contabiliza el día?'],
    ['Paid · sick or PTO', 'Pagado · enfermedad o tiempo libre'],
    ['Unpaid', 'Sin pago'],
    ['Save mark-off', 'Guardar ausencia'],
    ['Close assignment details', 'Cerrar detalles de la asignación'],
    ['Close date picker', 'Cerrar selector de fecha'],
    ['Close repeat week', 'Cerrar repetición semanal'],
    ['Close copy results', 'Cerrar resultados de la copia'],
    ['Close event', 'Cerrar evento'],
    ['Close mark-off', 'Cerrar ausencia'],
    ['Chloe marked off (unpaid) · 2 scheduled shifts will show the leave note', 'Chloe: ausencia registrada (sin pago) · 2 turnos programados mostrarán la nota de ausencia'],
    ['1 assignment added to this week. Every line copied cleanly.', '1 asignación agregada a esta semana. Todas las líneas se copiaron correctamente.'],
    ['2 assignments added to this week. Every line copied cleanly.', '2 asignaciones agregadas a esta semana. Todas las líneas se copiaron correctamente.'],
    ['1 assignment added to this week. 1 skipped — open the day to adjust by hand.', '1 asignación agregada a esta semana. Se omitió 1; abra el día para ajustarla manualmente.'],
    ['Update the scheduled shift from 7:00 AM–3:30 PM to the actual 7:15 AM–4:00 PM? Crew members will be asked to acknowledge the new times.', '¿Actualizar el turno programado de 7:00 AM–3:30 PM al horario real 7:15 AM–4:00 PM? Se pedirá a los miembros de la cuadrilla que confirmen las nuevas horas.'],
    ['Unassign 1 person from Market Street on Oct 19? Their field schedule will update immediately.', '¿Quitar la asignación de 1 persona en Market Street el Oct 19? Su horario de campo se actualizará de inmediato.'],
    ['Unassign 2 people from Market Street on Oct 19? Their field schedule will update immediately.', '¿Quitar la asignación de 2 personas en Market Street el Oct 19? Su horario de campo se actualizará de inmediato.'],
    ['Unassign this person from this project on this date? Their field schedule will update immediately.', '¿Quitar la asignación de esta persona en este proyecto en la fecha indicada? Su horario de campo se actualizará de inmediato.'],
    ['Remove this event? The crew will no longer see it.', '¿Quitar este evento? La cuadrilla dejará de verlo.'],
    ['Discard these assignment details and open the other day tool?', '¿Descartar estos detalles de la asignación y abrir la otra herramienta del día?']
  ];
  context.window.PDLLocale.set('es');
  for (const [english, spanish] of cases) assert.equal(context.scheduleCopy(english), spanish, english);
  context.window.PDLLocale.set('en');
  for (const [english] of cases) assert.equal(context.scheduleCopy(english), english, `${english} restores in English`);

  for (const fragment of [
    'Update the scheduled shift from',
    'Their field schedule will update immediately.',
    'Remove this event? The crew will no longer see it.',
    'Discard these assignment details and open the other day tool?'
  ]) {
    const at = app.indexOf(fragment);
    assert.ok(at >= 0, `${fragment} exists`);
    assert.match(app.slice(Math.max(0, at - 180), at + fragment.length + 180), /confirm\(scheduleCopy\(/,
      `${fragment} is translated before the native confirmation opens`);
  }

  const repeatResult = app.split(/\r?\n/).find(line => line.startsWith('function renderRepeatWeekResult('));
  assert.ok(repeatResult, 'repeat-week result renderer exists');
  assert.match(repeatResult, /row\.date\?new Date/, 'repeat-week skipped rows do not format a blank date as Invalid Date');
  assert.match(repeatResult, /reason=scheduleCopy\(row\.reason\|\|''\)/, 'repeat-week skip reasons are translated before being combined with their date');

  for (const id of ['repeat-week-modal', 'repeat-week-result', 'event-modal', 'event-detail-modal', 'mark-off-modal']) {
    const dialog = index.match(new RegExp(`<dialog[^>]*id=["']${id}["'][\\s\\S]*?</dialog>`))?.[0] || '';
    assert.match(dialog, /class="close-button"[^>]*aria-label=/, `${id} close control has a translatable accessible name`);
  }
});

if (failures.length) {
  console.error(`Schedule workflow UX contract failed (${failures.length}):\n- ${failures.join('\n- ')}`);
  process.exitCode = 1;
} else {
  console.log('Schedule workflow UX contract passed: one chooser, explicit project, viewed-date default, progressive range, preview/preflight, direct composer, announced validation, compact mobile month, accessible date controls, safe unassign, and roster acknowledgement.');
}
