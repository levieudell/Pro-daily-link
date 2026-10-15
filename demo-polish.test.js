'use strict';
// Regression guards for the demo-polish batch: seven shared UI bugs (all
// tenants) plus the excavation/concrete demo fixture. Static source checks on
// purpose — the behavioral coverage lives in the suite these files ship with.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const app = fs.readFileSync('app.js', 'utf8');
const styles = fs.readFileSync('styles.css', 'utf8');
const controls = fs.readFileSync('reporting-controls.js', 'utf8');
const index = fs.readFileSync('index.html', 'utf8');

// P1.1 Catalog: no literal "undefined" category badge; adaptive precision so
// per-item actuals no longer collapse to the same rounded number.
assert.match(app, /\$\{item\.category\?`<span class="trade-badge">\$\{escapeHtml\(item\.category\)\}<\/span>`:''\}/);
assert.match(app, /actualHoursPerUnit\.toFixed\(item\.history\.actualHoursPerUnit<0\.1\?3:2\)/);
assert.doesNotMatch(app.slice(app.indexOf('function renderCatalog'), app.indexOf('function renderCatalog') + 1600), /undefined/);

// P1.2 Crews tab: derived fallback from team member crew names when no
// persisted crew rows exist, so both tabs read the same people.
assert.match(app, /function derivedCrews\(\)/);
assert.match(app, /crewList=crews\.length\?crews:derivedCrews\(\)/);

// P1.3 Schedule availability: every refresh races the API against a timeout so
// a stuck call can never leave cells on "Checking availability…".
assert.match(app, /setTimeout\(\(\)=>reject\(new Error\('Availability refresh timed out'\)\),15000\)/);
assert.match(app, /clearTimeout\(timeoutId\)/);

// P1.4 Dashboard chart: approved-report accumulation is shared with insights
// and the chart always renders the selected period (no hidden rolling window).
assert.match(app, /function accumulateApprovedProduction\(/);
assert.match(app, /function dashboardPeriodWindow\(/);
assert.match(app, /class="chart-axis"/);

// P1.5 Fixed reporting exports: de-duplicated rows, project identified per
// row, and export action buttons sized to content.
assert.match(controls, /function pdlExportListMarkup\(records, projectNameFor, timezone\)/);
assert.match(controls, /function pdlExportTimestamp\(value, timezone\)/);
assert.match(controls, /const seen=new Set\(\),unique=\(records\|\|\[\]\)\.filter/);
assert.match(styles, /#pdl-export-list \.customer-project\{[^}]*\}/);
assert.match(styles, /\.secondary\{width:auto;min-width:0;padding:8px 14px;/);

// P1.6 Pay-period ghost header: the sticky topbar is fully opaque, no blur.
assert.match(styles, /\.topbar\{background:var\(--panel,#fff\);backdrop-filter:none;-webkit-backdrop-filter:none\}/);
assert.match(styles, /:root\[data-theme="dark"\] \.topbar\{background:var\(--panel\)\}/);
assert.doesNotMatch(styles.match(/\.topbar\{background:var\(--panel,#fff\);backdrop-filter:none;-webkit-backdrop-filter:none\}/)[0], /blur|rgba/);

// P1.7 Approve gating: the client mirrors the server rule and disables the
// Approve button with a visible explanation while blockers exist.
assert.match(app, /function reportApprovalBlockers\(report\)/);
assert.match(app, /const approvalBlockers=reportApprovalBlockers\(r\)/);
assert.match(app, /aria-disabled="true"/);

// Demo fixture: excavation/concrete sitework story, clearly labeled DEMO,
// zero credentials, and no remote URLs anywhere in the generated data.
const { buildSalesDemo, summarizeSalesDemo } = require('./sales-demo-data');
const demo = buildSalesDemo(), summary = summarizeSalesDemo(demo);
assert.equal(demo.company.name, 'DEMO | Alder Ridge Excavation & Concrete');
assert.match(demo.company.trade, /Excavation, utilities & concrete/);
assert.equal(demo.users.length, 0);
assert.equal(demo.sessions.length, 0);
assert.equal(demo.company.billingExempt, true);
assert.equal(demo.company.planPrice, 0);
assert.deepEqual(demo.projects.map(p => p.name), ['DEMO Riverbend Subdivision Phase 2', 'DEMO Hwy 99 Waterline Replacement', 'DEMO Cedar Grove Commercial Pad']);
assert.ok(demo.projects.every(p => /, OR \d{5}$/.test(p.site)), 'demo sites are real Oregon addresses so weather geocoding works');
assert.deepEqual(demo.crews.map(c => c.name), ['DEMO Dirt Crew', 'DEMO Pipe Crew', 'DEMO Concrete Crew']);
assert.deepEqual(demo.catalog.map(item => [item.name, item.unit, item.targetHoursPerUnit]), [
  ['Mass excavation', 'CY', 0.08],
  ['Trench excavation & backfill', 'LF', 0.2],
  ['8" DI pipe install', 'LF', 0.1],
  ['Structural fill/compaction', 'CY', 0.08],
  ['Footings', 'CY', 1],
  ['Slab on grade', 'SF', 0.04],
]);
assert.deepEqual(demo.changes.map(c => [c.number, c.status]), [['CO-101', 'Potential'], ['CO-102', 'Submitted'], ['CO-103', 'Approved']]);
assert.ok(demo.changes[0].fieldFlag, 'the potential change is field-flagged for the action center');
assert.ok(demo.photos.length >= 3 && demo.photos.every(photo => photo.url.startsWith('data:image/') && /^DEMO /.test(photo.caption)), 'placeholder photos are local data URIs with DEMO captions');
assert.ok(demo.projectMessages.length >= 1, 'office → field messages exist for the Messages screen');
assert.doesNotMatch(JSON.stringify(demo), /https?:\/\//i, 'no remote links in the fixture');
assert.equal(summary.counts.reports, 30);
assert.equal(summary.counts.timeCards, 90);
assert.equal(summary.approvedReports, 28);
assert.equal(summary.reviewReports, 2);
// One orphaned scheduled day (no daily) plus an at-risk project and a
// field-flagged change give the action center a realistic short list.
const orphan = demo.assignments.find(a => a.date < demo.reports.at(-1).dateIso && !demo.workdays.some(w => w.projectId === a.projectId && w.memberIds.join() === a.memberIds.join() && demo.timeCards.some(c => c.workdayId === w.id && c.date === a.date)));
assert.ok(orphan, 'an orphaned assignment exists for the missing-daily flag');
// Both demo company names stay accepted by the installer, the platform gate
// and the idempotent retry check.
const install = fs.readFileSync('sales-demo-install.js', 'utf8');
const route = fs.readFileSync('sales-demo-route.js', 'utf8');
const platformDemo = fs.readFileSync('platform-sales-demo.js', 'utf8');
const platform = fs.readFileSync('platform.js', 'utf8');
for (const source of [install, route, platformDemo, platform]) {
  assert.match(source, /DEMO \| Alder Ridge Excavation & Concrete/);
  assert.match(source, /DEMO \| Alder Ridge Builders/);
}
// Cache pins carry the new release marker.
assert.match(index, /app\.js\?v=20261014-review3/);
assert.match(index, /styles\.css\?v=20261014-review3/);
assert.match(index, /company-timezone\.js\?v=20261014-review3/);

// R2.1 Dashboard metric consistency: people and sites come from the same live
// entries feed as Today's Field Activity, and the production card is labeled
// with the selected period.
assert.match(app, /liveEntries=liveTimeEntries\(\),fieldPeople=new Set\(/);
assert.match(app, /PRODUCTION · \$\{periodSelection\.toUpperCase\(\)\}/);

// R2.3 New daily report: office role reads today's assignments too, and labor
// falls back to scheduled people and shift hours when no approved time cards.
assert.match(app, /function reportAssignmentsOnDate\(/);
assert.match(app, /function scheduledReportLabor\(/);
assert.match(app, /reportAssignmentsForDate\(\):reportAssignmentsOnDate\(/);
assert.match(app, /loaded from today's schedule for \$\{scheduled\.length\} team member/);

// R2.5 Loading states always resolve: a superseded availability refresh
// restores the previous status, and the live time panel stamps its render.
assert.match(app, /scheduleAvailabilityStatus=previousStatus\|\|'ready';renderSchedule\(\)\}return\}/);
assert.match(app, /liveUpdatedStamp\.textContent=`Updated \$\{new Date\(\)\.toLocaleTimeString/);

// R2.6 Past shifts never show the notify status next to "Time pending".
assert.match(app, /\$\{past\?'':`<span class="assignment-ack /);

// R2.7 Drafts: the subtitle says "Draft by", the summary falls back to the
// notes text, and Edit / correct opens the form at step 1.
assert.match(app, /\$\{r\.status==='Draft'\?'Draft by':'Submitted by'\}/);
assert.match(app, /notes\.slice\(0,300\)\+'…'/);
assert.match(app, /renderReportCustomFields\(report\);showReportStep\(1\);offerOfflineReportDraft/);

// R2.10 Timezone settings: when a zone is saved, the select must reflect it
// (append the saved option if the value did not stick), never the placeholder.
const timezoneSource = fs.readFileSync('company-timezone.js', 'utf8');
assert.match(timezoneSource, /if \(saved && select\.value !== stored\)/);

// R2.11 Help opens the modal immediately and shows failures inside it.
assert.match(app, /\$\('#help-modal'\)\.showModal\(\);try\{helpItems=await api\(`\/api\/help/);

// R2.12 Mobile drawer: the nav scrolls instead of cutting off items.
assert.match(styles, /\.sidebar nav\{display:grid;gap:5px;overflow-y:auto;min-height:0\}/);

// R2.14 Reports-submitted card: the denominator always includes today's
// scheduled projects (never 0/0 while crews are assigned), and the remainder
// reads "scheduled today" until a shift has ended or a crew is on the clock.
assert.match(app, /scheduledProjects=new Set\(assignments\.filter\(row=>row\.date===today\)/);
assert.match(app, /expectedProjects=new Set\(\[\.\.\.scheduledProjects,\.\.\.activeProjectIds,\.\.\.submittedProjects\]\)/);
assert.match(app, /'scheduled today'/);

console.log('Demo polish: catalog badge/precision, crews fallback, availability timeout, period-windowed chart with axis, export dedupe + tz timestamps, opaque topbar, approve gating, excavation fixture, demo-name gates, dashboard consistency, report autofill, loading states, draft details, timezone select, help modal, mobile nav and reports-due card all guarded.');
