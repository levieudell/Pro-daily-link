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
assert.match(index, /app\.js\?v=20261031-team-members/);
assert.match(index, /styles\.css\?v=20261014-review3-20261017-fieldreview1/);

// --- Behavioral harness -----------------------------------------------------
const aStart = app.indexOf('let endDayVoice=null');
const aEnd = app.indexOf("$('#end-day-voice').onclick=startEndDayVoice;") + "$('#end-day-voice').onclick=startEndDayVoice;".length;
const bStart = app.indexOf('let voiceRecordingGeneration=0,');
const bEnd = app.indexOf("$('#voice-notes').onclick=startVoiceNotes;") + "$('#voice-notes').onclick=startVoiceNotes;".length;
assert.ok(aStart >= 0 && aEnd > aStart && bStart > aEnd && bEnd > bStart, 'voice blocks located in app.js');
const block = app.slice(aStart, aEnd) + '\n;\n' + app.slice(bStart, bEnd);

function makeElement(id) {
  const classes = new Set();
  return {
    id, value: '', textContent: '', hidden: false,
    classList: { add: c => classes.add(c), remove: c => classes.delete(c), toggle: (c, on) => on ? classes.add(c) : classes.delete(c), contains: c => classes.has(c) },
    attributes: {}, addEventListener(name,handler) { this.listeners=this.listeners||{};this.listeners[name]=handler; }, setAttribute(name,value) { this.attributes[name]=value; }, getAttribute(name) { return this.attributes[name]; }, append() {}, focus() {}, onclick: null,
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
    setTimeout: () => 0,
    clearTimeout: () => {},
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
// Server-side recording harness: mic access and MediaRecorder exist, so the
// button must record, upload on stop, and put the returned transcript in the
// notes — falling back to browser dictation when transcription is empty.
function recordingHarness(language, config={}) {
  const elements = {};
  for (const id of ['voice-notes', 'voice-status', 'field-notes', 'report-language']) elements[id] = makeElement(id);
  elements['report-language'].value = language;
  const notifications = [], apiCalls = [],timers=[];
  let apiBarrier=null,micBarrier=null;
  let apiResult = { text: '', source: 'unavailable' };
  let streamStopped = false;
  const stream = { getTracks: () => [{ stop() { streamStopped = true; } }] };
  class FakeBlob { constructor(parts, options) { this.parts = parts; this.size=parts.reduce((n,p)=>n+(p.size||0),0); this.type = (options && options.type) || ''; } }
  class FakeFileReader { readAsDataURL(blob) { this.result = 'data:' + (blob.type || 'audio/webm') + ';base64,c3ludGhldGlj'; queueMicrotask(() => this.onload && this.onload()); } }
  const recorders = [];
  class FakeMediaRecorder {
    constructor(strm, options) { this.stream = strm; this.mimeType = (options && options.mimeType) || 'audio/mp4';this.state='inactive';this.stopCalls=0;recorders.push(this); }
    static isTypeSupported() { return true; }
    start() { this.started = true;this.state='recording'; }
    stop() {this.stopCalls++;if(this.state==='inactive')throw Error('InvalidStateError');this.state='inactive';this.stopped=true;this.deliverStop=()=>{if(!config.empty)this.ondataavailable?.({data:{size:9,type:this.mimeType}});this.onstop?.()};if(!config.delayStop)queueMicrotask(this.deliverStop); }
  }
  const context = {
    window: { SpeechRecognition: class { start() { this.started = true; } stop() {} abort() {} }, MediaRecorder: FakeMediaRecorder },
    navigator: { onLine: true, mediaDevices: { getUserMedia: async () => {if(micBarrier)await micBarrier;if(config.permissionError)throw Error('NotAllowedError');return stream} } },
    Blob: FakeBlob, FileReader: FakeFileReader,
    setTimeout:(fn,ms)=>{const timer={fn,ms};timers.push(timer);return timer},clearTimeout:timer=>{if(timer)timer.cleared=true},
    Event: class { constructor(type) { this.type = type; } },
    notify: message => notifications.push(message),
    applyReportLanguage() { elements['voice-notes'].textContent = '🎙 Speak notes'; },
    api: async (path, options) => { apiCalls.push({ path, body: JSON.parse(options.body) }); if(apiBarrier)await apiBarrier;if(config.apiError)throw config.apiError;return apiResult; },
    $: selector => { const id = selector.replace(/^#/, ''); return elements[id] || (elements[id] = makeElement(id)); },
  };
  vm.createContext(context);
  vm.runInContext(block, context);
  return { elements, notifications, apiCalls, recorders, fireTimer:ms=>{const timer=timers.find(t=>t.ms===ms&&!t.cleared);assert.ok(timer);timer.fn()}, cancel:()=>elements['report-modal'].listeners.close(), holdMic() {let release;micBarrier=new Promise(resolve=>{release=resolve});return release;}, get streamStopped() { return streamStopped; }, setResult(value) { apiResult = value; }, holdResponse() { let release;apiBarrier=new Promise(resolve=>{release=resolve});return release; } };
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

// Server-side recording: tap records with immediate feedback, second tap
// stops and uploads, and the transcript lands in the notes exactly once.
(async () => {
  const h = recordingHarness('en-US');
  h.setResult({ text: 'Poured the east wall with three crew.', source: 'openai' });
  const button = h.elements['voice-notes'], notes = h.elements['field-notes'];
  button.onclick();
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(h.recorders.length, 1, 'a MediaRecorder session starts');
  assert.equal(h.recorders[0].started, true);
  assert.equal(button.textContent, '■ Stop & transcribe', 'recording label replaces the listening label');
  assert.match(h.elements['voice-status'].textContent, /Listening. speak now/);
  assert.equal(h.recorders[0].mimeType, 'audio/mp4', 'MP4 is preferred when the browser supports it');
  button.onclick();
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(h.recorders[0].stopped, true);
  assert.equal(h.streamStopped, true, 'the mic track is released after upload');
  assert.equal(h.apiCalls.length, 1, 'exactly one transcription request is sent');
  assert.equal(h.apiCalls[0].path, '/api/ai/transcribe');
  assert.match(h.apiCalls[0].body.audio, /^data:audio\//, 'the recorded clip uploads as an audio data-URL');
  assert.equal(h.apiCalls[0].body.language, 'en-US');
  assert.equal(notes.value, 'Poured the east wall with three crew.', 'the transcript is appended to the notes');
  assert.ok(notes.dispatched.length, 'the input event fires so autosave and analysis see the text');
  assert.equal(button.textContent, '🎙 Speak notes', 'the label restores after transcription');
  assert.equal(button.disabled, false);
  assert.equal(h.elements['voice-status'].textContent, '✓ Notes added');
})().catch(error => { console.error(error); process.exitCode = 1; });

// Spanish recording preserves existing notes and appends the transcript once.
// This is a mocked UI contract, not a live microphone/provider round trip.
(async () => {
  const h = recordingHarness('es-MX');
  const transcript = 'Colamos cuarenta pies de bordillo con tres trabajadores.';
  const button = h.elements['voice-notes'], notes = h.elements['field-notes'];
  notes.value = 'Notas existentes: preparar el lado este.';
  h.setResult({ text: transcript, source: 'openai' });
  button.onclick();
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(h.recorders.length, 1);
  assert.equal(h.recorders[0].started, true);
  assert.equal(button.textContent, '■ Detener y transcribir');
  assert.match(h.elements['voice-status'].textContent, /Escuchando. hable ahora/);
  button.onclick();
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(h.recorders[0].stopped, true);
  assert.equal(h.streamStopped, true);
  assert.equal(h.apiCalls.length, 1);
  assert.equal(h.apiCalls[0].path, '/api/ai/transcribe');
  assert.equal(h.apiCalls[0].body.language, 'es-MX');
  assert.match(h.apiCalls[0].body.audio, /^data:audio\//);
  assert.equal(notes.value, 'Notas existentes: preparar el lado este. ' + transcript);
  assert.equal(notes.dispatched.filter(event => event.type === 'input').length, 1);
  assert.equal(button.disabled, false);
  assert.equal(button.classList.contains('voice-listening'), false);
  assert.equal(h.elements['voice-status'].textContent, '✓ Notas agregadas');
})().catch(error => { console.error(error); process.exitCode = 1; });

// Unavailable transcription leaves persistent, explicit retry feedback.
(async () => {
  const h = recordingHarness('en-US');
  h.setResult({ text: '', source: 'unavailable', warning: 'synthetic' });
  const button = h.elements['voice-notes'];
  button.onclick();
  await new Promise(resolve => setTimeout(resolve, 5));
  button.onclick();
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(h.apiCalls.length, 1);
  assert.ok(h.notifications.some(message => /Could not transcribe/.test(message)), 'failure is reported');assert.equal(h.elements['voice-status'].hidden,false);assert.match(h.elements['voice-status'].textContent,/notes are unchanged/);assert.equal(h.streamStopped,true);assert.equal(h.elements['field-notes'].value,'');
  assert.equal(button.disabled,false);assert.match(h.elements['voice-status'].textContent,/try again/);
})().catch(error => { console.error(error); process.exitCode = 1; });

console.log('voice feedback contracts: ok');

// A pending upload keeps progress visible, releases the mic, and ignores duplicate stop/read events.
(async()=>{
 const h=recordingHarness('en-US'),status=h.elements['voice-status'],notes=h.elements['field-notes'],button=h.elements['voice-notes'];
 notes.value='Existing notes.';h.setResult({text:'New words.',source:'openai'});const release=h.holdResponse();
 button.onclick();assert.equal(button.disabled,true,'permission pending prevents duplicate requests');
 await new Promise(resolve=>setTimeout(resolve,5));assert.equal(status.classList.contains('voice-listening'),true);
 button.onclick();await new Promise(resolve=>setTimeout(resolve,5));
 assert.equal(h.streamStopped,true);assert.equal(button.disabled,true);assert.equal(status.hidden,false);assert.equal(status.classList.contains('voice-transcribing'),true);assert.equal(status.attributes['aria-busy'],'true');assert.equal(notes.value,'Existing notes.');
 h.recorders[0].onstop();assert.equal(h.apiCalls.length,1);
 release();await new Promise(resolve=>setTimeout(resolve,5));
 assert.equal(notes.value,'Existing notes. New words.');assert.equal(notes.dispatched.length,1);assert.equal(status.classList.contains('voice-transcribing'),false);assert.equal(status.attributes['aria-busy'],'false');
})().catch(error=>{console.error(error);process.exitCode=1});

// Closing the report invalidates late permission and transcript callbacks.
(async()=>{
 for(const phase of ['permission','recording','transcribing']){
  const h=recordingHarness('en-US'),notes=h.elements['field-notes'];notes.value='Original report.';
  const releaseMic=phase==='permission'?h.holdMic():null,releaseApi=h.holdResponse();h.setResult({text:'Old report audio.'});
  h.elements['voice-notes'].onclick();await new Promise(r=>setTimeout(r,5));
  if(phase==='transcribing'){h.elements['voice-notes'].onclick();await new Promise(r=>setTimeout(r,5))}
  h.cancel();notes.value='New report.';releaseMic?.();releaseApi();await new Promise(r=>setTimeout(r,5));
  assert.equal(h.streamStopped,true,phase+' releases microphone');assert.equal(notes.value,'New report.',phase+' cannot append into next report');assert.equal(h.elements['voice-status'].classList.contains('voice-transcribing'),false);
  if(phase!=='transcribing')assert.equal(h.apiCalls.length,0,phase+' canceled recording is not uploaded');
 }
})().catch(error=>{console.error(error);process.exitCode=1});

// Browser dictation must ignore final results delivered after report close.
{
 const h=harness('en-US');h.elements['voice-notes'].onclick();const old=h.recognition;
 h.elements['report-modal'].listeners.close();h.elements['field-notes'].value='Next report.';
 old.onresult({resultIndex:0,results:[{isFinal:true,0:{transcript:'Old recording'}}]});old.onerror({error:'not-allowed'});
 assert.equal(h.elements['field-notes'].value,'Next report.');assert.equal(h.elements['voice-status'].hidden,true);
}

// Safari-style asynchronous stop: immediate processing UI, one stop, then final data before upload.
(async()=>{
 const h=recordingHarness('en-US',{delayStop:true}),notes=h.elements['field-notes'];notes.value='Keep these notes.';h.setResult({text:'Appended safely.'});
 h.elements['voice-notes'].onclick();await new Promise(r=>setTimeout(r,5));
 assert.equal(notes.hidden,true);assert.equal(h.elements['field-notes-label'].hidden,true);assert.equal(h.elements['field-note-tools'].hidden,true);assert.equal(h.elements['voice-capture-panel'].hidden,false);assert.equal(h.elements['voice-capture-stop'].hidden,false);
 h.elements['voice-capture-stop'].onclick();h.elements['voice-capture-stop'].onclick();
 assert.equal(h.recorders[0].stopCalls,1);assert.equal(h.elements['voice-capture-panel'].classList.contains('voice-capture-processing'),true);assert.match(h.elements['voice-status'].textContent,/Transcribing/);assert.equal(h.apiCalls.length,0);assert.equal(notes.value,'Keep these notes.');
 h.recorders[0].deliverStop();await new Promise(r=>setTimeout(r,5));
 assert.equal(h.apiCalls.length,1);assert.equal(notes.value,'Keep these notes. Appended safely.');assert.equal(notes.hidden,false);assert.equal(h.elements['field-note-tools'].hidden,false);assert.equal(h.elements['voice-capture-panel'].hidden,true);
})().catch(e=>{console.error(e);process.exitCode=1});
(async()=>{
 for(const options of [{empty:true},{permissionError:true},{apiError:Object.assign(new Error('Rejected'),{status:400})}]){
  const h=recordingHarness('en-US',options);h.elements['field-notes'].value='Keep on failure.';h.elements['voice-notes'].onclick();await new Promise(r=>setTimeout(r,5));
  if(h.recorders.length)h.elements['voice-capture-stop'].onclick();await new Promise(r=>setTimeout(r,5));
  assert.equal(h.elements['field-notes'].value,'Keep on failure.');assert.equal(h.elements['field-notes'].hidden,false);assert.equal(h.elements['voice-capture-panel'].hidden,true);assert.match(h.elements['voice-status'].textContent,/notes are unchanged/);
  if(options.empty||options.permissionError)assert.equal(h.apiCalls.length,0);
 }
})().catch(e=>{console.error(e);process.exitCode=1});

// Stop or network timeouts restore existing notes and invalidate late completion.
(async()=>{
 const h=recordingHarness('en-US');h.elements['field-notes'].value='Saved before closing.';h.elements['report-modal'].open=true;h.setResult({text:'Late transcript.'});const release=h.holdResponse();
 h.elements['voice-notes'].onclick();await new Promise(r=>setTimeout(r,5));h.elements['voice-capture-stop'].onclick();await new Promise(r=>setTimeout(r,5));
 h.elements['report-modal'].open=false;release();await new Promise(r=>setTimeout(r,5));
 assert.equal(h.elements['field-notes'].value,'Saved before closing.','closed dialog rejects transcription before its close event dispatches');
 h.cancel();
})().catch(e=>{console.error(e);process.exitCode=1});

(async()=>{
 for(const mode of ['stop','network']){
  const h=recordingHarness('en-US',{delayStop:mode==='stop'});h.elements['field-notes'].value='Saved notes.';h.setResult({text:'Late words.'});const release=h.holdResponse();
  h.elements['voice-notes'].onclick();await new Promise(r=>setTimeout(r,5));h.elements['voice-capture-stop'].onclick();await new Promise(r=>setTimeout(r,5));h.fireTimer(mode==='stop'?10000:60000);
  release();if(mode==='stop')h.recorders[0].deliverStop();await new Promise(r=>setTimeout(r,5));assert.equal(h.elements['field-notes'].value,'Saved notes.');assert.equal(h.elements['field-notes'].hidden,false);assert.equal(h.streamStopped,true);assert.match(h.elements['voice-status'].textContent,/notes are unchanged/);
 }
})().catch(e=>{console.error(e);process.exitCode=1});
