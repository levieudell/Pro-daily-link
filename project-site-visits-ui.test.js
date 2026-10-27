'use strict';

// Static UI release contracts. Runtime lifecycle and authorization are covered
// in project-site-visits.test.js; this file guards the mobile experience.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { isPublicFile } = require('./public-file-policy');

const html = fs.readFileSync('index.html', 'utf8');
const js = fs.readFileSync('project-site-visits-ui.js', 'utf8');
const css = fs.readFileSync('project-site-visits-ui.css', 'utf8');
const offline = fs.readFileSync('offline.js', 'utf8');
const app = fs.readFileSync('app.js', 'utf8');

assert.equal(isPublicFile(process.cwd(), path.join(process.cwd(), 'project-site-visits-ui.js')), true, 'site-visit UI script is publicly served');
assert.equal(isPublicFile(process.cwd(), path.join(process.cwd(), 'project-site-visits-ui.css')), true, 'site-visit UI stylesheet is publicly served');

assert.match(html, /project-site-visits-ui\.css/);
assert.match(html, /project-site-visits-ui\.js/);
assert.ok(html.indexOf('project-site-visits-ui.js') > html.indexOf('app.js'), 'enhancement loads after the core workspace');

for (const phrase of ['Overview', 'Open site notes', 'Quick note', 'Add photo', 'Finish site notes', 'Review the project update', 'Save project update', 'Keep this as a schedule proposal', 'Dismissed — this proposal will not be saved', 'Site visit update']) {
  assert.ok(js.includes(phrase), `site-visit UI includes ${phrase}`);
}
for (const phrase of ['Notas del sitio', 'Nota rápida', 'Agregar foto', 'Terminar notas del sitio', 'Guardar actualización']) {
  assert.ok(js.includes(phrase), `Spanish site-visit UI includes ${phrase}`);
}
assert.match(js, /MediaRecorder/);
assert.match(js, /SpeechRecognition/);
assert.match(js, /accept="image\//);
assert.doesNotMatch(js, /capture="environment"/, 'photo picker must offer the camera and the existing library');
assert.match(js, /PHOTO_MAX_FILES = 8/);
assert.match(js, /PHOTO_BATCH_BYTES = 8_000_000/);
assert.match(js, /function photoBatches/);
assert.match(js, /event\.target\.value = ''/, 'the photo input resets so the same selection can be retried');
assert.match(js, /siteVisitId/);
assert.match(js, /sourceEntryIds/);
assert.match(js, /evidence/);
assert.match(js, /visitHeadline/, 'project Overview surfaces the latest organized site update instead of a generic label');
assert.match(js, /data-site-impact-include/);
assert.match(js, /data-site-impact-task/);
assert.match(js, /data-site-impact-days/);
assert.match(js, /data-site-impact-note/);
assert.match(js, /if \(!card\.querySelector\('\[data-site-impact-include\]'\)\?\.checked\) continue/, 'dismissed schedule proposals are omitted from the saved update');
assert.match(js, /Every kept schedule proposal needs a clear reason/, 'kept schedule proposals are validated before save');
assert.match(js, /Math\.abs\(shiftDays\) > 30/, 'schedule moves are bounded before save');
assert.match(js, /Saved on this device|guardado en este dispositivo/i, 'offline state is honest');
assert.match(js, /still syncing|aún se sincronizan/i, 'Finish blocks until offline evidence is synced');
assert.match(js, /offlineFallback \|\| queuedStart/, 'local visit data is only reused for a real offline or queued start');
assert.match(js, /payload && !payload\.active && cached && !queuedStart\) clearLocal/, 'a successful authoritative empty response clears stale local visits');
assert.match(js, /editDraftKey/);
assert.match(js, /saveEditDraft/);
assert.match(js, /recoverVisitConflict/);
assert.match(js, /error\.visit/);
assert.match(js, /error\.entry/);
assert.match(app, /\['report','visit','entry'\]/, 'the shared API wrapper preserves server conflict records for recovery');
assert.match(js, /rememberRecent/);
assert.match(js, /hydrateOverview/);
assert.match(js, /repaintOverview/);
assert.doesNotMatch(js, /(?:POST|PATCH|DELETE)[^\n]{0,200}api\/project-tasks/, 'site visit UI cannot mutate the project schedule');

assert.match(css, /(?:width:44px;height:44px|min-height:4[6-9]px|min-height:5\dpx)/, 'primary touch targets meet or exceed 44px');
assert.match(css, /font:400\s+16px/);
assert.match(css, /env\(safe-area-inset-bottom/);
assert.match(css, /prefers-reduced-motion/);
assert.match(css, /data-theme="dark"/);
assert.match(css, /@media\(max-width:560px\)/);
assert.match(css, /\.site-visit-dialog\{width:100%;height:100dvh/, 'phone layout is a viewport-sized sheet without side overflow');
assert.match(css, /\.site-impact-fields/);
assert.match(css, /\.site-impact-editor\.is-dismissed/);
assert.match(css, /\.site-impact-include input\{width:22px;height:22px/, 'schedule proposal decisions have a usable checkbox target');

assert.match(offline, /site-visits/);
assert.match(offline, /\/entries/);

console.log('project-site-visits UI contracts passed');

