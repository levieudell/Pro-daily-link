'use strict';
// Remy's staging review of the field daily: the Send/clock-out toast, hours
// that follow punches, clock-out attaching to the same-day daily, and short
// punch labels. Flag retap and the badge/hours padding are source checks.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const scope = require('./field-daily-scope');

const clinic = [{ id: 3, code: 'D-CGC', name: 'DEMO Cedar Grove Clinic' }];
assert.equal(scope.clientProjectIndex(clinic, { project: 2, projectId: 3 }), 0);
assert.equal(scope.clientProjectIndex(clinic, { project: 2 }), -1);
assert.equal(scope.clientProjectIndex([{ id: 3 }, { id: 4 }], { project: 5, projectId: 99 }), -1);

const crew = [
  { id: 1, name: 'DEMO Jordan Reed' },
  { id: 2, name: 'Casey Nguyen' },
  { id: 3, name: 'Alex Mora' }
];
const named = scope.namedCrewGaps('Casey and Alex stayed to patch the gate.', crew, [1]);
assert.deepEqual(named.map(person => person.id), [2, 3]);
assert.equal(scope.crewGapReason(named), 'Casey and Alex have no clock-in. Enter their hours.');
assert.equal(scope.crewGapReason([{ name: 'Casey Nguyen' }]), 'Casey has no clock-in. Enter their hours.');
assert.deepEqual(scope.namedCrewGaps('3 guys on the curb.', crew, [1]).map(person => person.id), [2, 3]);
assert.deepEqual(scope.namedCrewGaps('3 guys on the curb.', crew, new Set([1])).map(person => person.id), [2, 3]);
assert.deepEqual(scope.namedCrewGaps('3 guys on the curb.', crew, [1, 2, 3]), []);
assert.equal(scope.noPunchLabel(), 'No punch, enter hours');
assert.deepEqual(scope.namedCrewGaps('Casey and Alex stayed to patch the gate.', crew, [1, 2, 3]), []);

const punchStart = '2026-10-16T15:00:00.000Z';
assert.equal(scope.punchLengthLabel({ inAt: punchStart, outAt: '2026-10-16T15:03:00.000Z', hours: 0 }), '3 min');
assert.equal(scope.punchLengthLabel({ inAt: punchStart, outAt: '2026-10-16T16:30:00.000Z', hours: 1.5 }), '1.50 h');
assert.equal(scope.punchLengthLabel({ inAt: punchStart, outAt: '2026-10-16T16:30:00.000Z', hours: 0 }), '1.50 h');
assert.equal(scope.punchLengthLabel({ inAt: punchStart, hours: 8 }), '');
assert.equal(/^0 h/.test(scope.punchLengthLabel({ inAt: punchStart, outAt: '2026-10-16T15:03:00.000Z', hours: 0 })), false);
assert.equal(scope.formatHours(0.05), '3 min');
assert.equal(scope.formatHours(1.5), '1.50 h');
assert.equal(scope.hoursFromMinutes(3), 0.05);
assert.equal(scope.hoursFromMinutes(7), 0.12);
assert.equal(scope.hoursFromMinutes(8.14), 0.14);
assert.equal(scope.elapsedMinutes('2026-10-16T15:00:00.000Z', '2026-10-16T15:04:40.000Z'), 4);
assert.equal(scope.elapsedMinutes('2026-10-16T15:00:00.000Z', '2026-10-16T15:04:59.000Z'), 4);
assert.equal(scope.elapsedMinutes('2026-10-16T06:56:00.000Z', '2026-10-16T07:03:00.000Z'), 7);
assert.equal(scope.formatWorkTime(8), '8 min · 0.13 h');
assert.equal(scope.formatWorkTime(5), '5 min · 0.08 h');
assert.equal(scope.formatWorkTime(3), '3 min · 0.05 h');
assert.equal(scope.formatWorkTime(90), '1.50 h');
assert.equal(scope.formatClock(1), '1 min');
assert.equal(scope.formatClock(135), '2 h 15 min');
assert.equal(scope.formatClock(61), '1 h 1 min');
assert.equal(scope.formatClock(473), '7 h 53 min');
assert.equal(scope.formatPunchTotal(2), '2 min · 0.03 h');
assert.equal(scope.formatPunchTotal(61), '1 h 1 min · 1.02 h');
assert.equal(scope.formatPunchTotal(473), '7 h 53 min · 7.88 h');
const blankGaps = scope.normalizeLaborGaps([{ memberId: 2, name: 'Casey Nguyen' }, { memberId: 3, name: 'Alex Mora', hours: 0 }]);
assert.equal(blankGaps.length, 2);
assert.equal(blankGaps[0].hours, null);
assert.equal(blankGaps[0].hoursStatus, 'hours not entered');
assert.equal(blankGaps[1].hours, null);
assert.equal(blankGaps.some(row => row.hours === 0), false);
assert.equal(scope.formatHours(0.12), '7 min');
assert.equal(scope.formatHours(scope.hoursFromMinutes(7)), '7 min');
assert.equal(scope.formatHours(scope.hoursFromMinutes(8.14)), '8 min');
const clinicItems = [
  { id: 1, name: 'Curb', unit: 'LF', plannedQuantity: 800, budgetHours: 80 },
  { id: 5, name: 'Gutter', unit: 'LF', plannedQuantity: 600, budgetHours: 60 }
];
const multi = scope.reviewNotes({ notes: 'Poured 40 LF of curb on north side, set 20 LF of gutter', estimateItems: clinicItems });
assert.deepEqual(multi.lines.map(line => [line.description, line.quantity, line.estimateItemId]), [['Curb', 40, 1], ['Gutter', 20, 5]]);
const oneClause = scope.reviewNotes({ notes: 'poured 40 LF of curb and set 20 LF of gutter', estimateItems: clinicItems });
assert.deepEqual(oneClause.lines.map(line => line.estimateItemId), [1, 5]);
const concreteNote = 'Poured 40 LF of curb on north side, set 20 LF of gutter, 3 guys, extra work: owner asked us to patch 2 potholes by the gate, used 6 yards of concrete. Tomorrow we form the east side, need pump truck Monday.';
const concrete = scope.reviewNotes({ notes: concreteNote, estimateItems: clinicItems });
assert.equal(concrete.materials, '6 yards of concrete');
assert.equal(concrete.lines.some(line => /concrete|footing/i.test(line.description)), false);
assert.equal(concrete.flags.some(flag => /concrete|yards/i.test(flag.description || '')), false);
assert.equal(scope.uniqueMaterials(['6 yards of concrete', '6 yards of concrete.']), '6 yards of concrete');
const withFootings = [...clinicItems, { id: 3, name: 'Footings', unit: 'CY', plannedQuantity: 240, budgetHours: 240 }];
const bareConcrete = scope.reviewNotes({ notes: '6 yards of concrete', estimateItems: withFootings });
assert.equal(bareConcrete.materials, '6 yards of concrete');
assert.equal(bareConcrete.lines.length, 0);
assert.equal(bareConcrete.flags.some(flag => flag.reason === 'no_match'), false);
const weUsed = scope.reviewNotes({ notes: 'Poured 40 LF of curb and we used 6 yards of concrete', estimateItems: withFootings });
assert.equal(weUsed.materials, '6 yards of concrete');
assert.deepEqual(weUsed.lines.map(line => [line.description, line.quantity]), [['Curb', 40]]);
assert.equal(weUsed.flags.some(flag => /concrete|yards/i.test(flag.description || '')), false);
const bags = scope.reviewNotes({ notes: 'Set 20 LF of gutter, 12 bags of sakrete', estimateItems: withFootings });
assert.equal(bags.materials, '12 bags of sakrete');
assert.deepEqual(bags.lines.map(line => line.estimateItemId), [5]);
assert.equal(bags.flags.some(flag => /bag|sakrete/i.test(flag.description || '')), false);
const tons = scope.reviewNotes({ notes: '3 tons of gravel', estimateItems: withFootings });
assert.equal(tons.materials, '3 tons of gravel');
assert.equal(tons.lines.length, 0);
assert.equal(tons.flags.length, 0);
assert.equal(scope.isMaterialPhrase('6 yards of concrete'), true);
assert.equal(scope.isMaterialPhrase('Poured 12 yards of foundation concrete'), false);
assert.equal(concrete.next, 'Tomorrow we form the east side, need pump truck Monday.');
assert.equal(scope.tidyNext('Next step: Tomorrow we form the east side, need pump truck Monday.'), 'Tomorrow we form the east side, need pump truck Monday.');
assert.equal(scope.tidyNext('Next: pump truck Monday'), 'pump truck Monday');
const emptyKept = scope.keepProductionLines([
  { description: 'Clock out text', quantity: 0, laborHours: 0.12 },
  { description: 'Curb', estimateItemId: 1, quantity: 40, laborHours: 0.12 }
], 'A different daily note');
assert.equal(emptyKept.length, 1);
assert.equal(emptyKept[0].estimateItemId, 1);
const firstPass = scope.mergeScopeFlags([], [{ reason: 'stated_extra', description: 'patch the gate', who_asked: 'owner' }]);
const answered = firstPass.map(flag => ({ ...flag, decision: 'extra', who_asked: 'site owner', extra_work: true }));
const secondPass = scope.mergeScopeFlags(answered, [{ reason: 'stated_extra', description: 'owner asked us to patch the gate', who_asked: 'owner' }]);
const thirdPass = scope.mergeScopeFlags(secondPass, [{ reason: 'stated_extra', description: 'owner asked us to patch the gate', who_asked: 'owner' }]);
assert.equal(thirdPass[0].id, secondPass[0].id);
assert.equal(thirdPass[0].decision, 'extra');
assert.equal(thirdPass[0].who_asked, 'site owner');
const doubled = scope.laborTotal({ punches: [{ memberId: 1, minutes: 3 }], entered: [{ memberId: 1, hours: 0.05 }, { memberId: 2, hours: 8 }] });
assert.equal(doubled.total, 8.05);
assert.deepEqual(doubled.entries.map(row => row.memberId), [1, 2]);

const rawNotes = 'Poured 40 LF of curb on north side, 3 guys, extra work: owner asked us to patch 2 potholes by the gate.';
const keptLines = scope.keepProductionLines([
  { description: rawNotes, quantity: 0, laborHours: 0.05 },
  { description: 'Clocked out after the north curb pour was finished', quantity: 0, laborHours: 0.05 },
  { description: 'Curb', quantity: 10, unit: 'LF', estimateItemId: 7, laborHours: 1 },
  { description: 'Curb', quantity: 40, unit: 'LF', estimateItemId: 7, laborHours: 2 }
], rawNotes + ' Clocked out after the north curb pour was finished');
assert.equal(keptLines.length, 1);
assert.equal(keptLines[0].quantity, 40);
assert.equal(scope.rawNoteLine({ description: rawNotes, quantity: 0 }, rawNotes), true);

const merged = scope.mergeScopeFlags(
  [{ reason: 'stated_extra', description: 'patch 2 potholes', decision: 'extra', who_asked: 'owner', createsChange: false }],
  [{ reason: 'stated_extra', description: 'owner asked us to patch 2 potholes', who_asked: 'someone' }]
);
assert.equal(merged[0].decision, 'extra');
assert.equal(merged[0].who_asked, 'owner');
assert.equal(merged[0].createsChange, false);
assert.equal(merged[0].extra_work, true);

const even = scope.allocateLaborHours({ total: 1, lines: [{ manual: false }, { manual: false }, { manual: false }] });
assert.deepEqual(even.lines.map(line => line.minutes), [20, 20, 20]);
assert.deepEqual(even.lines.map(line => line.hours), [0.34, 0.33, 0.33]);
assert.equal(Math.round(even.lines.reduce((sum, line) => sum + line.hours, 0) * 100), 100);
assert.equal(even.allocatedMinutes, 60);
assert.equal(even.total, 1);
const pennies = scope.allocateLaborHours({ totalMinutes: 2, lines: [{ quantity: 1, unitRate: 1 }, { quantity: 1, unitRate: 1 }] });
assert.deepEqual(pennies.lines.map(line => line.minutes), [1, 1]);
assert.deepEqual(pennies.lines.map(line => line.hours), [0.02, 0.01]);
assert.equal(pennies.lines.reduce((sum, line) => sum + Math.round(line.hours * 100), 0), Math.round(scope.hoursFromMinutes(2) * 100));
assert.equal(scope.formatPunchTotal(pennies.totalMinutes), '2 min · 0.03 h');
function assertApportionedPunch(label, totalMinutes, lineCount) {
  const result = scope.allocateLaborHours({ totalMinutes, lines: Array.from({ length: lineCount }, () => ({ manual: false })) });
  const minutes = result.lines.reduce((sum, line) => sum + line.minutes, 0);
  const hundredths = result.lines.reduce((sum, line) => sum + Math.round(line.hours * 100), 0);
  assert.equal(minutes, totalMinutes, `${label} minutes`);
  assert.equal(hundredths, Math.round(result.total * 100), `${label} hundredths`);
  assert.equal(hundredths, Math.round(scope.hoursFromMinutes(totalMinutes) * 100), `${label} displayed total`);
}
assertApportionedPunch('1 min', 1, 2);
assertApportionedPunch('2 min', 2, 2);
assertApportionedPunch('5 min', 5, 2);
assertApportionedPunch('7 min', 7, 2);
assertApportionedPunch('61 min', 61, 2);
assertApportionedPunch('7 h 53 min', 7 * 60 + 53, 3);
const fiveMinutes = scope.allocateLaborHours({ totalMinutes: 5, lines: [{ quantity: 40, unitRate: 0.1 }, { quantity: 20, unitRate: 0.1 }] });
assert.deepEqual(fiveMinutes.lines.map(line => line.minutes), [3, 2]);
assert.deepEqual(fiveMinutes.lines.map(line => line.hours), [0.05, 0.03]);
assert.equal(fiveMinutes.lines.reduce((sum, line) => sum + line.minutes, 0), 5);
assert.equal(Math.round(fiveMinutes.lines.reduce((sum, line) => sum + line.hours, 0) * 100), Math.round(scope.hoursFromMinutes(5) * 100));
const eightMinutes = scope.allocateLaborHours({ totalMinutes: 8, lines: [{ quantity: 40, unitRate: 0.1 }, { quantity: 20, unitRate: 0.1 }] });
assert.deepEqual(eightMinutes.lines.map(line => line.minutes), [5, 3]);
assert.equal(eightMinutes.lines.reduce((sum, line) => sum + line.minutes, 0), 8);
assert.equal(scope.formatHours(eightMinutes.lines[0].hours), '5 min');
assert.equal(scope.formatHours(eightMinutes.lines[1].hours), '3 min');
const locked = scope.allocateLaborHours({ totalMinutes: 8, lines: [{ manual: true, minutes: 3, quantity: 40, unitRate: 0.1 }, { quantity: 20, unitRate: 0.1 }] });
assert.deepEqual(locked.lines.map(line => line.minutes), [3, 5]);
const proportional = scope.allocateLaborHours({ total: 10, lines: [{ quantity: 2, unitRate: 1 }, { quantity: 1, unitRate: 1 }] });
assert.deepEqual(proportional.lines.map(line => line.hours), [6.67, 3.33]);
const manual = scope.allocateLaborHours({ total: 10, lines: [{ manual: true, hours: 4 }, { manual: false, quantity: 1, unitRate: 1 }] });
assert.deepEqual(manual.lines.map(line => line.hours), [4, 6]);
assert.equal(manual.warning, '');
const over = scope.allocateLaborHours({ total: 10, lines: [{ manual: true, hours: 12, quantity: 1 }, { manual: false, quantity: 4, unitRate: 2 }] });
assert.equal(over.lines[1].hours, 0);
assert.equal(over.lines[0].hours, 12);
assert.equal(over.warning, 'Manual hours are over the labor total. Auto lines stay at 0.');

const sameDay = [
  { id: 1, project: 2, dateIso: '2026-10-16', status: 'Draft', foreman: 'Field team', laborEntries: [{ memberId: 1, hours: 8 }] },
  { id: 4, project: 2, dateIso: '2026-10-16', status: 'Needs review', foreman: 'DEMO Jordan Reed', laborEntries: [{ memberId: 1, hours: 0.05 }] },
  { id: 9, project: 2, dateIso: '2026-10-15', status: 'Needs review', foreman: 'DEMO Jordan Reed', laborEntries: [{ memberId: 1, hours: 8 }] }
];
assert.equal(scope.sameDayDaily(sameDay, { projectIndex: 2, dateIso: '2026-10-16', memberIds: [1], foreman: 'DEMO Jordan Reed' }).id, 4);
assert.equal(scope.sameDayDaily(sameDay, { projectIndex: 2, dateIso: '2026-10-15', memberIds: [1], foreman: 'Someone else' }).id, 9);
assert.equal(scope.sameDayDaily(sameDay, { projectIndex: 1, dateIso: '2026-10-16', memberIds: [1], foreman: 'DEMO Jordan Reed' }), null);
assert.equal(scope.sameDayDaily(sameDay, { projectIndex: 2, dateIso: '2026-10-16', memberIds: [9], foreman: 'Other crew' }), null);

const serverSource = fs.readFileSync(__dirname + '/server.js', 'utf8');
const endHandler = serverSource.slice(serverSource.indexOf('const endWorkday'), serverSource.indexOf('const changeOrderDecision'));
assert.match(endHandler, /let report=/);
assert.match(endHandler, /dateIso:companyDateIso\(db\.company,new Date\(workday\.startedAt\)\)/);
assert.match(serverSource, /card\.date=companyDateIso\(db\.company,new Date\(card\.inAt\|\|workday\.startedAt\)\)/);
assert.match(endHandler, /sameDayDaily\(/);
assert.match(endHandler, /attached:Boolean\(existingDaily\)/);
assert.match(serverSource.slice(serverSource.indexOf('function presentReport'), serverSource.indexOf('function fieldProjectIds')), /presented\.projectId=project\.id/);

const app = fs.readFileSync(__dirname + '/app.js', 'utf8');
const renderReports = app.slice(app.indexOf('function renderReports'), app.indexOf('function renderReportJobContext'));
assert.match(renderReports, /fieldProjectForReport\(r\):projects\[r\.project\]\)\?\.code/);
assert.equal(/projects\[r\.project\]\.code/.test(renderReports), false);
const saveAt = app.indexOf('async function saveDailyReport');
const saveDaily = app.slice(saveAt, saveAt + 12000);
assert.ok(saveDaily.indexOf('adoptReport(saved)') < saveDaily.indexOf('renderReports(saved.id)'));
assert.ok(saveDaily.indexOf('presentReportSent(') > saveDaily.indexOf('renderReports(saved.id)'));
const endDay = app.slice(app.indexOf("$('#confirm-end-day').onclick"), app.indexOf('function reportApprovalBlockers'));
assert.ok(endDay.indexOf('renderFieldClock()') < endDay.indexOf('renderReports('));
assert.match(endDay, /Clocked out\. The punch is on today\\'s daily\./);
assert.match(app.slice(app.indexOf('function renderFieldClockHours'), app.indexOf('function renderFieldClock(')), /punchLengthLabel\(card\)/);

const instant = fs.readFileSync(__dirname + '/field-instant-daily.js', 'utf8');
const scopeSource = fs.readFileSync(__dirname + '/field-daily-scope.js', 'utf8');
assert.match(instant, /decision:null,createsChange:false/);
assert.match(instant, /Yes, extra/);
assert.match(instant, /No, normal scope/);
assert.match(instant, /aria-pressed="\$\{flag\.decision==='extra'\?'true':'false'\}"/);
assert.match(instant, /aria-pressed="\$\{flag\.decision==='not'\?'true':'false'\}"/);
assert.match(instant, /function clearStaleClockOutPrompt/);
assert.match(instant, /Who asked\?/);
assert.doesNotMatch(instant, />Bill it</);
assert.match(app, /id="office-decision"/);
assert.match(app, /fieldClockTick=setInterval/);
assert.match(app, /30000/);
assert.match(app, /laborManual/);
assert.match(serverSource, /\/extra-work\$/);
assert.match(serverSource, /Choose billable or not billable/);
assert.match(instant, /<textarea id="field-review-next"/);
assert.match(serverSource, /fieldScope\.uniqueMaterials/);
assert.match(instant, /noPunchLabel\(\)/);
assert.match(instant, /No punch, enter hours/);
assert.match(instant, /every\(row=>Number\(row\.value\)>0\)/);
assert.match(instant, /hoursFromMinutes/);
assert.match(instant, /allocateLaborHours/);
assert.match(instant, /data-review-labor/);
assert.match(instant, /totalMinutes/);
assert.doesNotMatch(instant, /end\.value=notes/);
assert.match(instant, /laborManual/);
assert.match(instant, /mergeScopeFlags/);
assert.match(instant, /window\.renderFieldReview=renderFieldReview/);
assert.match(instant, /byId\.set\(id,row\)/);
assert.match(instant, /stampOpenReportLocks/);
assert.match(instant, /applyLockedLabor/);
assert.match(app, /laborManual:true,laborMinutes/);
assert.match(instant, /Kept at /);
assert.match(instant, /Send to office/);
assert.match(instant, /formatWorkTime/);
assert.match(instant, /formatClock/);
assert.match(instant, /formatPunchTotal/);
assert.match(instant, /clockLabel\(shownMinutes\)/);
assert.doesNotMatch(instant, /min · \$\{lineHours/);
const indexHtml = fs.readFileSync(__dirname + '/index.html', 'utf8');
assert.equal(indexHtml.includes('Choose a plan to continue'), false);
assert.equal(indexHtml.includes('Your free trial has ended.'), false);
assert.match(app, /access\.locked!==true/);
assert.match(app, /function formatRowHours/);
assert.match(instant, /sameDayDaily/);
assert.match(instant, /beginFieldLaborTick/);
assert.match(scopeSource, /Math\.floor\(ms\/60000\)/);
assert.match(app, /armRestoreBanner/);
assert.match(app, /clearRestoreBanner/);
assert.match(app, /hours not entered/);
assert.match(app, /Send to office/);
assert.match(app, /fieldLaborNow/);
assert.doesNotMatch(app.slice(app.indexOf('function durationText'), app.indexOf('function formatDurationHours')), /Math\.round/);
const styles = fs.readFileSync(__dirname + '/styles.css', 'utf8');
assert.match(styles, /#field-clock-out\{[^}]*position:static/);
assert.match(styles, /\.report-job-heading \.project-badge\{[^}]*white-space:nowrap/);
assert.match(styles, /#field-clock-hours\{padding:0 22px 16px\}/);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-remy-'));
const companyId = '7176abe8-07e4-4336-a372-1163d2f21ff9';
const token = 'synthetic-remy-review-session';
const db = {
  company: { id: companyId, name: 'Synthetic remy review', demo: true, timezone: 'UTC', features: { timeCards: true } },
  projects: [
    { id: 101, name: 'Synthetic flooring job', code: 'SYN', estimateItems: [{ id: 1, name: 'Flooring', plannedQuantity: 100, unit: 'SF', budgetHours: null }] },
    { id: 102, name: 'Synthetic second job', code: 'SYN-2', estimateItems: [{ id: 1, name: 'Curb', plannedQuantity: 100, unit: 'LF', budgetHours: null }] }
  ],
  team: [{ id: 11, name: 'Synthetic worker', crew: 'A' }, { id: 12, name: 'Second worker', crew: 'B' }],
  assignments: [], reports: [], photos: [], workdays: [], timeCards: [],
  users: [{ id: 1, name: 'Synthetic owner', role: 'owner', status: 'Active', companyId }],
  sessions: [{ companyId, userId: 1, tokenHash: crypto.createHash('sha256').update(token).digest('hex'), expiresAt: '2099-01-01' }],
  customers: [], changes: [], catalog: []
};
const file = path.join(root, 'db.json');
fs.writeFileSync(file, JSON.stringify(db));
fs.writeFileSync(path.join(root, 'platform.json'), JSON.stringify({ users: [], sessions: [] }));
Object.assign(process.env, { PDL_DB_FILE: file, PDL_PLATFORM_FILE: path.join(root, 'platform.json'), PDL_REQUIRE_AUTH: '1', PDL_SUPABASE_ENABLED: '0', PDL_TRANSACTIONAL_DB: 'off', PDL_EMAIL_DEV_MODE: '1' });
for (const name of ['OPENAI_API_KEY', 'SENTRY_DSN', 'RESEND_API_KEY', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'PDL_STAGING']) delete process.env[name];
require('./database/supabase').loadLocalEnv = () => {};
const { server } = require('./server');

function todayIso() {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const value = type => parts.find(part => part.type === type).value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const call = async (method, route, input) => {
    const response = await fetch(base + route, { method, signal: AbortSignal.timeout(10000), headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', 'x-pdl-company': companyId }, ...(input ? { body: JSON.stringify(input) } : {}) });
    return { status: response.status, data: await response.json() };
  };
  try {
    const freshStart = await call('POST', '/api/workdays/start', { projectId: 102, memberIds: [12] });
    assert.equal(freshStart.status, 201);
    const freshEnd = await call('POST', '/api/workdays/' + freshStart.data.id + '/end', { notes: 'Set forms on the second job.' });
    assert.equal(freshEnd.status, 200);
    assert.equal(freshEnd.data.attached, false);
    assert.equal(freshEnd.data.report.projectId, 102);
    assert.equal(freshEnd.data.report.foreman, 'Field team');
    assert.equal(freshEnd.data.workday.status, 'complete');
    assert.ok(freshEnd.data.timeCards[0].outAt);
    const night = await call('POST', '/api/workdays/start', { projectId: 102, memberIds: [12] });
    assert.equal(night.status, 201);
    const nightDb = JSON.parse(fs.readFileSync(file, 'utf8'));
    const startedAt = '2026-10-15T23:56:00.000Z';
    for (const day of nightDb.workdays) if (day.id === night.data.id) day.startedAt = startedAt;
    for (const card of nightDb.timeCards) if (card.workdayId === night.data.id) card.inAt = startedAt;
    fs.writeFileSync(file, JSON.stringify(nightDb));
    const nightEnd = await call('POST', '/api/workdays/' + night.data.id + '/end', { notes: 'Crossed midnight on the curb.' });
    assert.equal(nightEnd.status, 200, JSON.stringify(nightEnd.data));
    assert.equal(nightEnd.data.timeCards[0].date, '2026-10-15');
    assert.equal(nightEnd.data.report.dateIso, '2026-10-15');
    assert.equal(nightEnd.data.report.productionEntries.length, 0);
    const before = await call('GET', '/api/state');
    const start = await call('POST', '/api/workdays/start', { projectId: 101, memberIds: [11] });
    assert.equal(start.status, 201);
    const daily = await call('POST', '/api/reports', {
      projectId: 101,
      dateIso: todayIso(),
      status: 'Needs review',
      notes: 'Poured the curb.',
      foreman: 'Synthetic owner',
      laborEntries: [{ memberId: 11, hours: 1 }],
      productionEntries: [{ estimateItemId: 1, description: 'Flooring', quantity: 10, unit: 'SF', laborHours: 1 }]
    });
    assert.equal(daily.status, 201, JSON.stringify(daily.data));
    assert.equal(daily.data.projectId, 101);
    assert.equal(daily.data.status, 'Needs review');
    const ended = await call('POST', '/api/workdays/' + start.data.id + '/end', { notes: 'Poured the curb and clocked out.' });
    assert.equal(ended.status, 200, JSON.stringify(ended.data));
    assert.equal(ended.data.attached, true);
    assert.equal(ended.data.report.id, daily.data.id);
    assert.equal(ended.data.report.projectId, 101);
    assert.equal(ended.data.report.status, 'Needs review');
    assert.notEqual(ended.data.report.foreman, 'Field team');
    assert.equal(ended.data.workday.reportId, daily.data.id);
    assert.equal(ended.data.timeCards[0].reportId, daily.data.id);
    assert.ok(ended.data.timeCards[0].outAt);
    const after = await call('GET', '/api/state');
    const flooring = after.data.reports.filter(report => Number(report.project) === before.data.projects.findIndex(project => project.id === 101) || report.projectId === 101);
    const drafts = after.data.reports.filter(report => report.foreman === 'Field team' && Number(after.data.projects[report.project]?.id) === 101);
    assert.equal(drafts.length, 0, 'clock-out must not add a Field team draft on the job that already has a daily');
    assert.equal(after.data.reports.length, before.data.reports.length + 1, 'only the Needs review daily is added after the fresh clock-out draft');
    assert.equal(flooring.length, 1);
    const draft = await call('POST', '/api/reports', {
      projectId: 101,
      dateIso: todayIso(),
      status: 'Draft',
      notes: 'Extra work: owner asked us to patch 2 potholes.',
      foreman: 'Synthetic owner',
      laborEntries: [],
      productionEntries: [],
      confirmedExtras: [{ kind: 'extra', reason: 'stated_extra', decision: 'extra', description: 'owner asked us to patch 2 potholes', who_asked: 'owner', createsChange: false }]
    });
    assert.equal(draft.status, 201, JSON.stringify(draft.data));
    assert.equal(draft.data.extraWork[0].extra_work, true);
    assert.equal(draft.data.extraWork[0].who_asked, 'owner');
    assert.equal(Object.hasOwn(draft.data.extraWork[0], 'billable'), false);
    const review = await call('POST', '/api/reports', {
      projectId: 102,
      dateIso: todayIso(),
      status: 'Needs review',
      notes: 'Extra work: owner asked us to patch the gate.',
      foreman: 'Synthetic owner',
      laborEntries: [{ memberId: 12, hours: 1 }],
      productionEntries: [{ estimateItemId: 1, description: 'Curb', quantity: 2, unit: 'LF', laborHours: 1 }],
      confirmedExtras: [{ kind: 'extra', reason: 'stated_extra', decision: 'extra', description: 'patch the gate', who_asked: 'owner', createsChange: true, billable: true }]
    });
    assert.equal(review.status, 201, JSON.stringify(review.data));
    assert.equal(review.data.status, 'Needs review');
    assert.equal(Object.hasOwn(review.data.extraWork[0], 'billable'), false, 'a field billable value is not stored');
    const billed = await call('PATCH', '/api/reports/' + review.data.id + '/extra-work', { index: 0, billable: true });
    assert.equal(billed.status, 200, JSON.stringify(billed.data));
    assert.equal(billed.data.report.extraWork[0].billable, true);
    const notBilled = await call('PATCH', '/api/reports/' + review.data.id + '/extra-work', { index: 0, billable: false });
    assert.equal(notBilled.data.report.extraWork[0].billable, false);
    const midnightDb = JSON.parse(fs.readFileSync(file, 'utf8'));
    midnightDb.company.timezone = 'America/Los_Angeles';
    fs.writeFileSync(file, JSON.stringify(midnightDb));
    const RealDate = Date;
    const frozen = new RealDate('2026-10-16T07:03:00.000Z');
    function FakeDate(...args) {
      if (!new.target) return args.length ? RealDate(...args) : new RealDate(frozen);
      return args.length ? new RealDate(...args) : new RealDate(frozen);
    }
    FakeDate.now = () => frozen.getTime();
    FakeDate.parse = RealDate.parse;
    FakeDate.UTC = RealDate.UTC;
    FakeDate.prototype = RealDate.prototype;
    global.Date = FakeDate;
    try {
      const late = await call('POST', '/api/workdays/start', { projectId: 102, memberIds: [12] });
      assert.equal(late.status, 201, JSON.stringify(late.data));
      const lateDb = JSON.parse(fs.readFileSync(file, 'utf8'));
      const clockIn = '2026-10-16T06:56:00.000Z';
      for (const day of lateDb.workdays) if (day.id === late.data.id) day.startedAt = clockIn;
      for (const card of lateDb.timeCards) if (card.workdayId === late.data.id) card.inAt = clockIn;
      fs.writeFileSync(file, JSON.stringify(lateDb));
      const crossed = await call('POST', '/api/workdays/' + late.data.id + '/end', { notes: 'Crossed local midnight on the curb.' });
      assert.equal(crossed.status, 200, JSON.stringify(crossed.data));
      assert.equal(crossed.data.timeCards[0].date, '2026-10-15', '11:56 PM punch stays on the clock-in date');
      assert.equal(crossed.data.report.dateIso, '2026-10-15');
      assert.equal(crossed.data.timeCards[0].hours, scope.hoursFromMinutes(7));
      assert.equal((crossed.data.report.history || []).some(row => /Labor corrected/i.test(String(row.action || ''))), false);
      assert.equal(crossed.data.report.next || '', '');
      assert.equal(crossed.data.report.productionEntries.length, 0);
    } finally {
      global.Date = RealDate;
    }
    console.log('Remy review checks passed.');
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
