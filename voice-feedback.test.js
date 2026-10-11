'use strict';
// Voice input feedback: both speak buttons must (a) show a listening state
// immediately on click — before the browser's recognition service even
// starts, (b) stream interim words onto the screen while the user speaks, and
// (c) append final transcripts exactly once. Static contracts pin the markup,
// styles, and cache-buster; a VM harness drives the real app.js functions
// against a synthetic SpeechRecognition.
const assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const app = fs.readFileSync('app.js', 'utf8'), index = fs.readFileSync('index.html', 'utf8'), styles = fs.readFileSync('styles.css', 'utf8');

// --- Static contracts -------------------------------------------------------
assert.match(index, /<p class="voice-status" id="voice-status" role="status" aria-live="polite" hidden><\/p>/, 'field-notes status line exists');
assert.match(index, /<p class="voice-status" id="end-day-voice-status" role="status" aria-live="polite" hidden><\/p>/, 'end-day status line exists');
assert.ok((app.match(/interimResults=true/g) || []).length >= 2, 'both voice inputs request interim results');
assert.ok(app.includes('setVoiceStatus(status'), 'listening state is surfaced through the shared status helper');
assert.ok(app.includes("button.setAttribute('aria-pressed'"), 'listening state is exposed to assistive tech');
assert.ok(app.indexOf("button.textContent=spanish?'■ Dejar de escuchar':'■ Stop listening'") < app.indexOf('recognition.start()'), 'the listening label appears before the browser service starts');
assert.ok(styles.includes('.voice-status') && styles.includes('@keyframes pdl-voice-pulse'), 'status line and pulse animation are styled');
assert.match(index, /app\.js\?v=20261011-my-flags/);
assert.match(index, /styles\.css\?v=20261011-my-flags/);

// --- Behavioral harness -----------------------------------------------------
const aStart = app.indexOf('let endDayVoice=null');
const aEnd = app.indexOf("$('#end-day-voice').onclick=startEndDayVoice;") + "$('#end-day-voice').onclick=startEndDayVoice;".length;
const bStart = app.indexOf('function startVoiceNotes(){');
const bEnd = app.indexOf("$('#voice-notes').onclick=startVoiceNotes;") + "$('#voice-notes').onclick=startVoiceNotes;".length;
assert.ok(aStart >= 0 && aEnd > aStart && bStart > aEnd && bEnd > bStart, 'voice blocks located in app.js');
const block = app.slice(aStart, aEnd) + '\n;\n' + app.slice(bStart, bEnd);

function makeElement(id) {
  const classes = new Set();
  return {
    id, value: '', textContent: '', hidden: false,
    classList: { add: c => classes.add(c), remove: c => classes.delete(c), toggle: (c, on) => on ? classes.add(c) : classes.delete(c), contains: c => classes.has(c) },
    setAttribute() {}, append() {}, focus() {}, onclick: null,
    dispatched: [],
    dispatchEvent(event) { this.dispatched.push(event); },
  };
}
function harness(language) {
  const elements = {};
  const ids = ['voice-notes', 'voice-status', 'field-notes', 'report-language', 'end-day-voice', 'end-day-voice-status', 'end-day-notes'];
  for (const id of ids) elements[id] = makeElement(id);
  elements['report-language'].value = language;
  const notifications = [];
  const recognitions = [];
  class FakeRecognition {
    constructor() { this.interim = null; this.continuous = null; recognitions.push(this); }
    start() { this.started = true; }
    stop() { this.stopped = true; }
    abort() { this.aborted = true; }
  }
  const context = {
    window: { SpeechRecognition: FakeRecognition },
    preferredLanguage: language,
    notify: message => notifications.push(message),
    applyReportLanguage() { elements['voice-notes'].textContent = '🎙 Speak notes'; },
    Event: class { constructor(type) { this.type = type; } },
    $: selector => { const id = selector.replace(/^#/, ''); return elements[id] || (elements[id] = makeElement(id)); },
  };
  vm.createContext(context);
  vm.runInContext(block, context);
  return { elements, notifications, recognitions, get recognition() { return recognitions[recognitions.length - 1]; } };
}

// Field notes: immediate feedback, interim streaming, single append, clean stop.
{
  const h = harness('en-US'), { elements } = h;
  elements['voice-notes'].onclick();
  const recognition = h.recognition;
  assert.equal(elements['voice-notes'].textContent, '■ Stop listening', 'listening label is shown the moment the button is pressed');
  assert.equal(elements['voice-status'].hidden, false, 'status line is visible immediately');
  assert.match(elements['voice-status'].textContent, /Listening… speak now/);
  assert.equal(recognition.interimResults, true, 'interim results requested');
  assert.equal(recognition.continuous, true);
  recognition.onresult({ resultIndex: 0, results: [{ isFinal: false, 0: { transcript: 'poured eighty six' } }] });
  assert.match(elements['voice-status'].textContent, /poured eighty six/, 'interim words appear on screen while speaking');
  assert.equal(elements['field-notes'].value, '', 'interim text never touches the notes field');
  recognition.onresult({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: 'poured eighty six yards' } }] });
  assert.equal(elements['field-notes'].value, 'poured eighty six yards', 'final transcript lands in the notes field');
  assert.ok(elements['field-notes'].dispatched.length, 'the input event fires so autosave and analysis see the text');
  recognition.onresult({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: 'poured eighty six yards' } }] });
  assert.equal(elements['field-notes'].value, 'poured eighty six yards', 'a re-delivered final result does not duplicate text');
  elements['voice-notes'].onclick();
  assert.equal(recognition.stopped, true, 'second press stops the session');
  recognition.onend();
  assert.equal(elements['voice-notes'].textContent, '🎙 Speak notes', 'label restores after the session ends');
  assert.equal(elements['voice-status'].hidden, true, 'status line hides when listening ends');
}

// End-day voice: same contract on the clock-out dialog.
{
  const h = harness('en-US'), { elements } = h;
  elements['end-day-voice'].onclick();
  const recognition = h.recognition;
  assert.equal(elements['end-day-voice'].textContent, '■ Stop listening');
  assert.match(elements['end-day-voice-status'].textContent, /Listening… speak now/);
  recognition.onresult({ resultIndex: 0, results: [{ isFinal: false, 0: { transcript: 'stripped the east' } }] });
  assert.match(elements['end-day-voice-status'].textContent, /stripped the east/);
  recognition.onresult({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: 'stripped the east forms' } }] });
  assert.equal(elements['end-day-notes'].value, 'stripped the east forms');
  recognition.onend();
  assert.equal(elements['end-day-voice'].textContent, '🎙 Speak completed work');
  assert.equal(elements['end-day-voice-status'].hidden, true);
}

// Spanish follows the field language.
{
  const { elements } = harness('es-MX');
  elements['voice-notes'].onclick();
  assert.equal(elements['voice-notes'].textContent, '■ Dejar de escuchar');
  assert.match(elements['voice-status'].textContent, /Escuchando…/);
}

console.log('voice feedback contracts: ok');
