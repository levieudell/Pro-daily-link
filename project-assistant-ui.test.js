'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { permitted, previewMarkup, createAssistant } = require('./project-assistant-ui');
const { isPublicFile } = require('./public-file-policy');
const sample = () => ({ proposal: { projectName: 'Synthetic project', memberName: '<img src=x onerror=alert(1)>', date: '2098-10-12', start: '08:00', end: '16:00', timezone: 'America/Los_Angeles', activity: 'Framing', instructions: '<script>run()</script>', notification: 'In-app only' }, token: 'synthetic-token', version: 'synthetic-version', conflicts: [] });
// Controller regression harness: no browser, network or live data. Real layout,
// native dialog, focus and mobile screenshots are separate synthetic browser QA.
class Node {
  constructor(tag) { this.tag = tag; this.attrs = {}; this.children = []; this.value = ''; this.hidden = false; this.disabled = false; this.open = false; this.events = {}; this.textContent = ''; }
  setAttribute(key, value) { this.attrs[key] = value; }
  hasAttribute(key) { return Object.hasOwn(this.attrs, key); }
  addEventListener(event, callback) { this.events[event] = callback; }
  append(...nodes) { this.children.push(...nodes); }
  set innerHTML(value) { this.html = value; if (this.tag === 'dialog') { this.controls = {}; for (const match of value.matchAll(/<(button|input|textarea|select|form|section|div|p|label)[^>]*\bdata-assistant-([A-Za-z-]+)(?:[\s>])/g)) { const node = new Node(match[1]); node.setAttribute('data-assistant-' + match[2], ''); this.controls[match[2]] = node; } } }
  get innerHTML() { return this.html || ''; }
  querySelector(selector) { return this.controls?.[selector.match(/data-assistant-([^\]]+)/)?.[1]]; }
  querySelectorAll() { return Object.values(this.controls || {}).filter(node => ['button', 'input', 'textarea', 'select'].includes(node.tag)); }
  showModal() { this.open = true; }
  close() { this.open = false; this.events.close?.(); }
  focus() { this.focused = true; }
}
const workspace = () => ({ companyId: 'synthetic-a', currentRole: 'office', user: { id: 1, role: 'project_manager', permissions: { scheduleCrews: true }, projectIds: [1], assignedCrews: ['A'] }, projects: [{ id: 1, name: '<script>project</script>', status: 'Active' }] });
function harness(request, options = {}) { let data = workspace(); const document = { body: new Node('body'), createElement: tag => new Node(tag) }, window = { addEventListener() {} }; const api = createAssistant({ document, window, getWorkspace: () => data, request, ...options }); return { ...api, node: name => api.dialog.querySelector('[data-assistant-' + name + ']'), update: value => { data = value; } }; }
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
async function main() {
  assert.equal(permitted(workspace()), true);
  for (const role of ['field', 'foreman', 'platform_owner', 'guest']) assert.equal(permitted({ ...workspace(), user: { id: 1, role } }), false);
  assert.equal(permitted({ ...workspace(), user: { id: 1, role: 'project_manager', permissions: {} } }), true);
  const markup = previewMarkup(sample()); assert.ok(!markup.includes('<script>')); assert.ok(!markup.includes('<img')); assert.match(markup, /&lt;script&gt;/);
  const calls = [], context = { members: [{ id: 11, name: 'Jordan', crew: 'A' }], timezone: 'America/Los_Angeles', aiAvailable: false };
  let failSave = false, changed = 0;
  const h = harness(async (url, payload) => { calls.push({ url, payload }); if (url.endsWith('context')) return context; if (url.endsWith('chat')) return { draft: { memberId: 11 }, message: 'Please supply the exact date.' }; if (url.endsWith('preview')) return sample(); if (failSave) { failSave = false; throw new Error('Disconnected'); } changed++; return { assignmentId: 42 }; });
  assert.equal(h.dialog.open, false); assert.equal(calls.length, 0, 'no automatic popup or background requests'); h.open(); assert.match(h.node('project').innerHTML, /&lt;script&gt;/); h.node('project').value = '1'; await h.selectProject(); assert.match(h.node('voice').textContent, /unavailable/); assert.equal(h.node('dictate').disabled, true);
  h.node('text').value = 'Schedule Jordan'; await h.chat(); assert.equal(changed, 0); assert.equal(h.node('date').value, ''); h.node('text').value = 'on 2098-10-12'; await h.chat(); assert.equal(calls.at(-1).payload.text, 'Schedule Jordan\nFollow-up: on 2098-10-12');
  for (const [name, value] of Object.entries({ memberId: '11', date: '2098-10-12', start: '08:00', end: '16:00', activity: 'Framing', instructions: 'West wall' })) h.node(name).value = value;
  await h.makePreview(); assert.equal(changed, 0); assert.equal(h.node('confirm-actions').hidden, false);
  h.node('activity').events.input(); assert.equal(h.node('confirm-actions').hidden, true); await h.confirm(); assert.equal(changed, 0, 'edited preview cannot save');
  await h.makePreview(); h.node('edit').onclick(); await h.confirm(); assert.equal(changed, 0, 'cancelled preview cannot save');
  await h.makePreview(); failSave = true; await h.confirm(); assert.equal(h.node('activity').disabled, true); assert.equal(h.node('edit').disabled, true); assert.match(h.node('message').textContent, /outcome is unknown/); const firstConfirm = calls.at(-1).payload;
  h.close(); h.open(); await h.confirm(); assert.deepEqual(calls.at(-1).payload, firstConfirm, 'uncertain retry reuses exact confirmation'); assert.equal(changed, 1); assert.equal(h.node('confirm-actions').hidden, true);
  const delayed = deferred(); const late = harness(async url => url.endsWith('context') ? context : delayed.promise); late.open(); late.node('project').value = '1'; await late.selectProject(); const pending = late.makePreview(); late.close(); delayed.resolve(sample()); await pending; assert.equal(late.dialog.open, false); assert.equal(late.node('confirm-actions').hidden, true); late.open(); assert.equal(late.node('project').disabled, false, 'cancelled in-flight request does not strand controls');
  await h.makePreview(); h.update({ ...workspace(), user: { id: 1, role: 'field' } }); h.sync(); assert.equal(h.launcher.hidden, true); assert.equal(h.dialog.open, false); assert.equal(h.node('confirm-actions').hidden, true);
  const timeout = harness(async url => url.endsWith('context') ? context : url.endsWith('preview') ? sample() : new Promise(() => {}), { timeoutMs: 20 }); timeout.open(); timeout.node('project').value = '1'; await timeout.selectProject(); await timeout.makePreview(); await timeout.confirm(); assert.match(timeout.node('message').textContent, /outcome is unknown/); assert.equal(timeout.node('close').disabled, false); timeout.close(); assert.equal(timeout.dialog.open, false, 'a timed-out confirmation does not trap the modal');
  const refresh = deferred(), refreshed = harness(async url => url.endsWith('context') ? context : url.endsWith('preview') ? sample() : { assignmentId: 42 }, { timeoutMs: 30, onSaved: () => refresh.promise }); refreshed.open(); refreshed.node('project').value = '1'; await refreshed.selectProject(); await refreshed.makePreview(); const refreshing = refreshed.confirm(); await new Promise(resolve => setImmediate(resolve)); assert.equal(refreshed.node('close').disabled, false); refreshed.close(); assert.equal(refreshed.dialog.open, false, 'known successful save releases the panel before state refresh'); await refreshing;
  const firstRefresh = deferred(), secondSave = deferred(); let saves = 0;
  const overlap = harness(async url => url.endsWith('context') ? context : url.endsWith('preview') ? sample() : ++saves === 1 ? { assignmentId: 41 } : secondSave.promise, { onSaved: () => saves === 1 ? firstRefresh.promise : Promise.resolve() }); overlap.open(); overlap.node('project').value = '1'; await overlap.selectProject(); await overlap.makePreview(); const firstOperation = overlap.confirm(); await new Promise(resolve => setImmediate(resolve)); await overlap.makePreview(); const secondOperation = overlap.confirm(); firstRefresh.resolve(); await firstOperation; overlap.close(); assert.equal(overlap.dialog.open, true, 'obsolete refresh cannot release a newer pending save'); assert.equal(overlap.node('close').disabled, true); secondSave.resolve({ assignmentId: 42 }); await secondOperation; overlap.close(); assert.equal(overlap.dialog.open, false);
  let speech;
  const noteFlow = harness(async (url, payload) => { if (url.endsWith('context')) return context; if (url.endsWith('chat')) { assert.equal(payload.action, 'note'); return { draft: { action: 'note', text: "Gate locked midnight–6am; can't arrive earlier.", deadline: 'none' }, message: 'Review the text.' }; } if (url.endsWith('preview')) { assert.equal(payload.action, 'todo'); assert.equal(payload.deadline, 'today'); assert.equal(Object.hasOwn(payload, 'memberId'), false); return { ...sample(), proposal: { action: 'todo', projectName: 'Synthetic project', text: payload.text, deadline: 'today', dueDate: '2026-10-07', timezone: payload.timezone, visibility: 'Existing project team', notification: 'No notifications' } }; } return { kind: 'todo', itemId: 'synthetic-item' }; }); noteFlow.open(); noteFlow.node('project').value = '1'; await noteFlow.selectProject(); noteFlow.node('action').value = 'note'; noteFlow.node('action').onchange(); assert.equal(noteFlow.node('memberId').disabled, true); noteFlow.node('text').value = "Gate locked midnight–6am; can't arrive earlier."; await noteFlow.chat(); assert.equal(noteFlow.node('action').value, 'note'); noteFlow.node('action').value = 'todo'; noteFlow.node('deadline').value = 'today'; noteFlow.node('action').onchange(); await noteFlow.makePreview(); assert.match(noteFlow.node('review').innerHTML, /Due today: 2026-10-07/); assert.match(noteFlow.node('review').innerHTML, /Unassigned/); await noteFlow.confirm(); assert.match(noteFlow.node('message').textContent, /Project to-do saved/);
  class Recognition { constructor() { speech = this; } start() {} abort() { this.aborted = true; } }
  const voiced = harness(async () => context, { SpeechRecognition: Recognition }); voiced.open(); voiced.node('project').value = '1'; await voiced.selectProject(); voiced.node('dictate').onclick(); speech.onresult({ results: [[{ transcript: 'Schedule Jordan' }]] }); assert.equal(voiced.node('text').value, 'Schedule Jordan'); voiced.close(); assert.equal(speech.aborted, true); speech.onresult({ results: [[{ transcript: 'Late result' }]] }); assert.equal(voiced.node('text').value, '');
  for (const name of ['project-assistant-ui.js', 'project-assistant-ui.css']) assert.equal(isPublicFile(__dirname, require('node:path').join(__dirname, name)), true);
  assert.equal(isPublicFile(__dirname, require('node:path').join(__dirname, 'project-assistant.js')), false);
  const app = fs.readFileSync('app.js', 'utf8'), source = fs.readFileSync('project-assistant-ui.js', 'utf8'), css = fs.readFileSync('project-assistant-ui.css', 'utf8');
  assert.match(app, /data-myday-assignment="\$\{assignment.id\}"/); assert.match(source, /querySelectorAll\('\[data-myday-assignment\]'\)/); assert.match(source, /note.textContent = 'Daily instructions: '/);
  assert.match(css, /prefers-reduced-motion/); assert.match(css, /safe-area-inset-bottom/); assert.match(css, /focus-visible/);
  console.log('Project assistant synthetic UI tests passed: PM gate, no automatic requests, escaped preview, conversation follow-ups, edit/cancel, late response, voice fallback, role change and exact uncertain-save retry.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
