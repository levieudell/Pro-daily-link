'use strict';

// Safety command-center release contracts. API authorization, saved evidence,
// revisions and the focused check/hazard workflow are covered by the existing
// safety API and browser suites; this file protects the overview-first shell.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { isPublicFile } = require('./public-file-policy');
const {
  TABS,
  esc,
  reportProjectId,
  projectIndexById,
  submittedSafetyEvidence,
  reportDateValue,
  projectReports,
  assignedFormTemplates,
  uniqueOpenHazards,
  statusModel,
  hazardBucket,
  safetyRecordRows,
  printSafetyRecordHtml
} = require('./safety-workspace-ui');

const html = fs.readFileSync('index.html', 'utf8');
const app = fs.readFileSync('app.js', 'utf8');
const js = fs.readFileSync('safety-workspace-ui.js', 'utf8');
const css = fs.readFileSync('safety-workspace-ui.css', 'utf8');
const focused = fs.readFileSync('safety-pm-ui.js', 'utf8');

// Exercise the same pure selectors and status model used by the browser. These
// assertions intentionally use mixed legacy/current report shapes so a static
// markup check cannot hide a broken overview count or status.
assert.deepEqual(TABS.map(tab => tab.id), ['today', 'followup', 'records']);
assert.equal(esc(`<script data-name="O'Reilly">&</script>`), '&lt;script data-name=&quot;O&#39;Reilly&quot;&gt;&amp;&lt;/script&gt;');
assert.match(js, /\['viewDailies', 'approveDailies', 'manageSafety', 'verifySafety'\]\.some/, 'project managers can enter Safety through either daily or dedicated Safety permissions');
assert.match(js, /window\.open\('', '_blank'\)/, 'print obtains a usable window handle before isolating it');
assert.match(js, /printable\.opener = null/, 'print severs the new window from the workspace before writing scoped data');
assert.doesNotMatch(js, /window\.open\([^\n]+noopener/, 'noopener is not passed in a way that makes browsers return a null print handle');

const projects = [
  { id: 41, name: 'Market Street' },
  { id: 99, name: 'River Road' }
];
const reports = [
  { id: 1, projectId: 41, dateIso: '2026-10-26', status: 'Submitted' },
  { id: 2, project: 0, date: '2026-10-25', status: 'Draft' },
  { id: 3, project: 1, dateIso: '2026-10-26', status: 'Approved' },
  { id: 4, projectId: 41, dateIso: '2026-10-24', deletedAt: '2026-10-25T18:00:00Z' },
  { id: 5, projectId: 99, dateIso: '2026-10-26', status: 'Submitted' }
];
assert.equal(reportProjectId(reports[0], projects), 41, 'current reports use their stable project id');
assert.equal(reportProjectId(reports[1], projects), 41, 'legacy reports resolve their project index');
assert.equal(reportProjectId({ project: 8 }, projects), 0, 'an invalid legacy project index does not leak into another project');
assert.equal(reportDateValue({ dateIso: '2026-10-26', date: '2026-10-01' }), '2026-10-26');
assert.equal(reportDateValue({ date: '2026-10-25' }), '2026-10-25');
assert.equal(reportDateValue({ dateIso: 'October 26, 2026', date: 'not-a-date' }), '', 'only canonical work dates participate in daily status');
assert.deepEqual(projectReports(reports, 41, projects).map(report => report.id), [1, 2], 'project reports include current and legacy rows while excluding deleted and other-project data');
assert.deepEqual(projectReports(null, 41, projects), [], 'missing report collections produce an honest empty state');
assert.equal(submittedSafetyEvidence({ status: 'Draft', safetyInspection: 'Not yet sent' }), false, 'draft form answers are not presented as submitted Safety evidence');
assert.equal(submittedSafetyEvidence({ status: 'Needs review', safetyInspection: 'Sent to office' }), true, 'sent records remain discoverable while awaiting office review');
const scopedProjectsWithArchive = [
  { id: 7, name: 'Old project', archived: true },
  { id: 41, name: 'Market Street' }
];
assert.equal(
  reportProjectId({ project: 1 }, scopedProjectsWithArchive),
  41,
  'legacy report indexes resolve against the complete scoped project list even when an earlier project is archived'
);
assert.equal(
  projectIndexById(41, scopedProjectsWithArchive),
  1,
  'new Safety reports use the selected project’s index in the complete scoped list, not the filtered picker index'
);

const templates = [
  { id: 'daily-1', category: 'daily', name: 'Daily report' },
  { id: 'safety-1', category: 'safety', name: 'Job safety analysis' },
  { id: 22, category: 'inspection', name: 'Excavation inspection' },
  { id: 'incident-1', category: 'incident', name: 'Incident report' },
  { id: 'quality-1', category: 'quality', name: 'Quality walk' },
  { id: 'unassigned', category: 'safety', name: 'Other project form' }
];
assert.deepEqual(
  assignedFormTemplates({ templateIds: ['daily-1', 'safety-1', '22', 'incident-1', 'quality-1'] }, templates).map(template => template.id),
  ['safety-1', 22, 'incident-1'],
  'assigned forms include only assigned safety, inspection and incident templates'
);
assert.deepEqual(
  assignedFormTemplates({ templateId: 22 }, templates).map(template => template.id),
  [22],
  'legacy single-template assignments still appear'
);
assert.deepEqual(assignedFormTemplates({}, templates), [], 'unassigned company forms are not shown as project requirements');

const hazardSource = {
  date: '2026-10-26',
  openHazards: [
    { id: 'haz-1', observation: 'Missing guardrail', status: 'open' },
    { observation: 'Uncovered opening', date: '2026-10-25', status: 'open' }
  ],
  day: {
    hazards: [
      { id: 'haz-1', observation: 'Missing guardrail', status: 'assigned' },
      { id: 'haz-2', observation: 'Corrected access', status: 'verified' },
      { observation: 'Uncovered opening', date: '2026-10-25', status: 'assigned' },
      { observation: 'Uncovered opening', date: '2026-10-26', status: 'assigned' }
    ]
  }
};
const openHazards = uniqueOpenHazards(hazardSource);
assert.equal(openHazards.length, 3, 'open hazards merge carry-forward and current-day rows without double counting');
assert.deepEqual(openHazards.map(hazard => hazard.id || hazard.date), ['haz-1', '2026-10-25', '2026-10-26']);
assert.equal(hazardSource.day.hazards.length, 4, 'hazard aggregation does not mutate API data');
assert.deepEqual(uniqueOpenHazards(null), [], 'missing hazard data produces an honest zero count');

const enabledProfile = { enabled: true };
const statusCases = [
  {
    name: 'no project selected',
    input: null,
    expected: { tone: 'neutral', title: 'Choose a project', action: '' }
  },
  {
    name: 'unsupported jurisdiction blocks the workflow before setup',
    input: { coverage: 'manual-review', profile: { enabled: false }, canManage: true },
    expected: { tone: 'blocked', title: 'Safety review needed', action: 'setup' }
  },
  {
    name: 'unsupported jurisdiction keeps setup with a manager',
    input: { coverage: 'manual-review', profile: enabledProfile, canManage: true },
    expected: { tone: 'blocked', title: 'Safety review needed', action: 'setup' }
  },
  {
    name: 'field user cannot act on an unsupported jurisdiction',
    input: { coverage: 'manual-review', profile: { enabled: false }, canManage: false },
    expected: { tone: 'blocked', title: 'Safety review needed', action: '' }
  },
  {
    name: 'authorized manager receives setup action',
    input: { profile: { enabled: false }, canManage: true },
    expected: { tone: 'setup', title: 'Turn on Safety for this project', action: 'setup' }
  },
  {
    name: 'field user cannot self-enable setup',
    input: { profile: { enabled: false }, canManage: false },
    expected: { tone: 'setup', title: 'Safety setup is not ready', action: '' }
  },
  {
    name: 'enabled project without a day is ready to start',
    input: { profile: enabledProfile },
    expected: { tone: 'attention', title: 'Ready to start', action: 'checks' }
  },
  {
    name: 'stale work scope takes priority',
    input: { profile: enabledProfile, day: { summary: { stale: true, error: 'old error', pending: 2 } } },
    expected: { tone: 'attention', title: 'Today’s work changed', action: 'checks' }
  },
  {
    name: 'server documentation error blocks submission',
    input: { profile: enabledProfile, day: { summary: { error: 'Competent person is required.' } } },
    expected: { tone: 'blocked', title: 'Action needed', action: 'checks', detail: 'Competent person is required.' }
  },
  {
    name: 'pending responses stay ahead of readiness',
    input: { profile: enabledProfile, day: { summary: { pending: 2, canSubmit: true, readyForWork: true } } },
    expected: { tone: 'attention', title: '2 checks left', action: 'checks' }
  },
  {
    name: 'documented unresolved follow-up remains visible',
    input: { profile: enabledProfile, day: { summary: { unresolved: 1, canSubmit: true } } },
    expected: { tone: 'followup', title: '1 follow-up needs attention', action: 'followups' }
  },
  {
    name: 'open hazard blocks an otherwise clean record',
    input: { profile: enabledProfile, openHazards: [{ id: 'haz-9' }], day: { summary: { unresolved: 0, canSubmit: false, readyForWork: true } } },
    expected: { tone: 'blocked', title: '1 follow-up needs attention', action: 'followups' }
  },
  {
    name: 'verified hazards do not override completed starter documentation',
    input: { profile: enabledProfile, day: { hazards: [{ id: 'haz-10', status: 'verified' }], summary: { pending: 0, unresolved: 0, readyForWork: true, canSubmit: true } } },
    expected: { tone: 'complete', title: 'Today’s record is complete', action: 'records' }
  },
  {
    name: 'submission-ready documentation is described without certifying safety',
    input: { profile: enabledProfile, day: { summary: { pending: 0, unresolved: 0, readyForWork: false, canSubmit: true } } },
    expected: { tone: 'complete', title: 'Today’s record is complete', action: 'records' }
  },
  {
    name: 'incomplete unclassified record stays neutral',
    input: { profile: enabledProfile, day: { summary: {} } },
    expected: { tone: 'neutral', title: 'Review today’s record', action: 'checks' }
  }
];

for (const testCase of statusCases) {
  const actual = statusModel(testCase.input);
  for (const [key, expected] of Object.entries(testCase.expected)) {
    assert.equal(actual[key], expected, `${testCase.name}: ${key}`);
  }
}

assert.equal(hazardBucket({ status: 'corrected', dueDate: '2026-10-20' }, '2026-10-26'), 'verification');
assert.equal(hazardBucket({ status: 'open', dueDate: '2026-10-25' }, '2026-10-26'), 'overdue');
assert.equal(hazardBucket({ status: 'open', dueDate: '2026-10-26' }, '2026-10-26'), 'today');
assert.equal(hazardBucket({ status: 'open' }, '2026-10-26'), 'open');

const recordData = {
  date: '2026-10-26',
  profile: { employer: 'Safe & Sons', state: 'OR' },
  day: {
    date: '2026-10-26', revision: 4, ruleVersion: 'or-test',
    checks: [{ id: 'walk', title: 'Walk site', status: 'pass', notes: 'Clear', updatedBy: 'Pat', updatedAt: '2026-10-26T15:00:00Z' }],
    talks: [
      { id: 'talk-1', topic: 'Fall protection and rescue', initial: { topic: 'Fall protection' }, language: 'en', presenter: 'Pat', attendees: [{ memberId: 1, name: 'Alex' }], createdAt: '2026-10-26T15:05:00Z', amendedAt: '2026-10-26T15:06:00Z', amendedBy: 'Pat', corrections: [{ reason: 'Added the rescue steps' }] },
      { id: 'talk-2', topic: 'Duplicate fall talk', language: 'en', presenter: 'Pat', attendees: [{ memberId: 1, name: 'Alex' }], createdAt: '2026-10-26T15:07:00Z', voidedAt: '2026-10-26T15:08:00Z', voidedBy: 'Morgan', voidReason: 'Duplicate record' }
    ],
    hazards: [{ id: 'haz-1', observation: 'Loose cord', status: 'corrected', owner: 'Alex', dueDate: '2026-10-26', createdAt: '2026-10-26T15:10:00Z' }]
  }
};
const recordRows = safetyRecordRows({ data: recordData, reports: [{ id: 8, projectId: 41, dateIso: '2026-10-26', status: 'Submitted', safetyEvidence: {} }], projectId: 41, projects });
assert.deepEqual(new Set(recordRows.map(row => row.type)), new Set(['checks', 'talks', 'hazards', 'dailies']), 'records use canonical type filters');
const correctedRecord = recordRows.find(row => row.id === 'talk:talk-1');
const voidedRecord = recordRows.find(row => row.id === 'talk:talk-2');
assert.match(correctedRecord.detail, /Corrected · original preserved/, 'current records disclose a corrected talk without replacing its audit history');
assert.match(correctedRecord.detail, /Added the rescue steps · Original topic: Fall protection/, 'current records make the correction reason and preserved original visible');
assert.match(voidedRecord.title, /^VOIDED —/, 'a voided talk is unmistakably marked in current records');
assert.match(voidedRecord.detail, /VOIDED — Duplicate record/, 'the reason for excluding a voided talk remains visible');
const printable = printSafetyRecordHtml({ data: recordData, project: { id: 41, name: '<Market>', site: '10 Main & Oak' }, date: '2026-10-26', reports: [], projects });
assert.match(printable, /Safety activity record/);
assert.match(printable, /Safe &amp; Sons/);
assert.match(printable, /&lt;Market&gt;/);
assert.match(printable, /Active toolbox talks \(1\)/, 'voided records are not counted as held toolbox talks');
assert.match(printable, /Voided toolbox talk records — audit only \(1\)/, 'printable evidence retains voided records in a separate audit section');
assert.match(printable, /VOIDED — DOES NOT COUNT AS A HELD TALK/);
assert.match(printable, /Correction:<\/b> Added the rescue steps/);
assert.match(printable, /Original topic:<\/b> Fall protection/);
assert.doesNotMatch(printable, /<Market>/, 'print content escapes tenant data');
const spanishRows = safetyRecordRows({ data: recordData, projectId: 41, projects, language: 'es' });
assert.match(spanishRows.find(row => row.id === 'talk:talk-2').title, /^ANULADO —/, 'Spanish current records mark voided talks in the app language');
const spanishPrintable = printSafetyRecordHtml({ data: recordData, project: { id: 41, name: 'Mercado', site: '10 Main' }, date: '2026-10-26', language: 'es' });
assert.match(spanishPrintable, /Charlas de seguridad vigentes \(1\)/);
assert.match(spanishPrintable, /Registros de charlas anulados — solo auditoría \(1\)/);
assert.match(spanishPrintable, /ANULADO — NO CUENTA COMO CHARLA REALIZADA/);

assert.equal(isPublicFile(process.cwd(), path.join(process.cwd(), 'safety-workspace-ui.js')), true, 'Safety workspace script is publicly served');
assert.equal(isPublicFile(process.cwd(), path.join(process.cwd(), 'safety-workspace-ui.css')), true, 'Safety workspace stylesheet is publicly served');
assert.match(html, /safety-workspace-ui\.css/);
assert.match(html, /safety-workspace-ui\.js/);
assert.ok(html.indexOf('safety-workspace-ui.js') > html.indexOf('app.js'), 'Safety workspace enhancement loads after the core workspace');
assert.match(html, /class="nav-item[^"\n]*"[^>]*data-page="safety"|data-page="safety"[^>]*class="nav-item/, 'Safety is a navigable workspace, not only a modal trigger');
assert.match(html, /<section[^>]+id="safety-page"[^>]+class="[^"]*page|<section[^>]+class="[^"]*page[^>]+id="safety-page"/, 'Safety has a real app page');
assert.doesNotMatch(html, /id="open-safety-pm"[^>]*>[^<]*<span[^>]*>[^<]*<\/span>\s*Safety today/, 'the primary Safety navigation does not reopen the old form wall');

for (const label of ['Today', 'Follow-up', 'Records']) {
  assert.ok(js.includes(label), `Safety workspace includes the ${label} tab`);
}
for (const phrase of ['Start safety check', 'Report hazard', 'Toolbox talk', 'Forms']) {
  assert.ok(js.includes(phrase), `Safety overview includes the ${phrase} action`);
}

const accessibleMarkup = html + '\n' + js;
assert.match(accessibleMarkup, /role=["']tablist["']/);
assert.match(accessibleMarkup, /role=["']tab["']/);
assert.match(accessibleMarkup, /role=["']tabpanel["']/);
assert.match(accessibleMarkup, /aria-controls/);
assert.match(accessibleMarkup, /aria-labelledby/);
assert.match(accessibleMarkup, /aria-selected/);
assert.match(accessibleMarkup, /tabindex/);
for (const key of ['ArrowLeft', 'ArrowRight', 'Home', 'End']) {
  assert.ok(js.includes(key), `Safety tab keyboard handling includes ${key}`);
}

assert.match(js, /PDLSafetyPM\?*\.open|window\.PDLSafetyPM/, 'checks, hazards, follow-up and talks use the focused Safety workflow');
assert.match(focused, /window\.PDLSafety\s*=\s*\{\s*open:/, 'focused Safety workflow remains available to contextual entry points');
assert.match(js, /safetyTalk/);
assert.match(js, /safetyTalkAttendees/);
assert.match(js, /safetyEvidence/);
assert.match(js, /safetyInspection/);
assert.match(js, /safetyIncident/);
assert.match(js, /dailyTemplates/);
assert.match(js, /templateIds/);
assert.match(js, /reports/);
assert.match(js, /projectId/);
assert.match(js, /date/);
assert.doesNotMatch(js, /(?:method\s*:\s*['"](?:POST|PUT|PATCH|DELETE)|api\([^\n]{0,180}(?:POST|PUT|PATCH|DELETE))[^\n]{0,220}\/(?:profile|days|checks|hazards)/i, 'workspace shell does not create a second Safety write path');

assert.match(js, /not (?:a )?(?:safety|compliance) certification|does not certify|documentation/i, 'workspace avoids presenting records as a safety certification');
assert.doesNotMatch(js, />\s*(?:Safe|Compliant)\s*</i, 'workspace never claims a job is safe or compliant');
assert.match(js, /unresolved|follow-up/i, 'workspace status preserves unresolved follow-up separately from documentation readiness');
assert.match(js, /record is complete|build a defensible record/i, 'workspace uses honest documentation language');

assert.match(app, /\['myday','fieldday','reports','timecards','safety'\]|\['myday','fieldday','reports','safety','timecards'\]|\.includes\(requested\)[\s\S]{0,240}safety/, 'field users can open their authorized Safety page without being bounced to My day');

assert.match(css, /grid-template-columns\s*:\s*repeat\(3/, 'three primary Safety destinations fit without horizontal tab scrolling');
assert.match(css, /(?:min-height|height)\s*:\s*(?:44|4[5-9]|5\d)px/, 'Safety workspace controls have usable touch targets');
assert.match(css, /@media\s*\(max-width\s*:\s*(?:560|600|640|680|720|760)px\)/, 'Safety workspace has a phone layout');
assert.match(css, /min-width\s*:\s*0/, 'Safety cards can shrink inside narrow layouts');
assert.match(css, /prefers-reduced-motion/);
assert.match(css, /data-theme=["']dark["']|data-theme\\?=["']dark["']/, 'Safety workspace is themed in dark mode');

console.log('Safety v3 workspace contracts passed: three destinations, focused actions, filtered/printable records, honest states, role access and mobile polish.');
