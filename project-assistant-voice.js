(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.PDLAssistantVoice=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const commands = new Map([['assistant suggest fields','suggest'],['assistant preview changes','preview'],['assistant read preview','read'],['assistant cancel preview','cancel'],['assistant stop listening','stop']]);
  const commandFor = text => commands.get(String(text).trim().toLowerCase().replace(/[.!?]+$/,'')) || null;
  // A foreground prototype only. No wake word service, hidden capture, auto-restart,
  // language-pack installation, recording/upload storage, or mutation callback.
  function createVoiceSession({document,window,SpeechRecognition=window.SpeechRecognition||window.webkitSpeechRecognition,canContinue,onTranscript,onCommand,onStatus,maxMs=300000,setTimer=setTimeout,clearTimer=clearTimeout}) {
    let session=null,timer=null,generation=0;
    const allowed=()=>!document.hidden&&(document.hasFocus?.()??true)&&canContinue();
    function stop(reason='Voice prototype stopped. Start it again when ready.') {generation++;const previous=session;session=null;if(timer!=null)clearTimer(timer);timer=null;try{previous?.abort();}catch{}try{window.speechSynthesis?.cancel();}catch{}onStatus(reason,false);}
    function start(){
      if(session){stop();return false;}
      if(!SpeechRecognition||!allowed()){onStatus('Voice recognition is unavailable here. Type or use your keyboard microphone.',false);return false;}
      const version=++generation,seen=new Set();let recognition;
      try{recognition=new SpeechRecognition();}catch{stop('Voice could not start. Type or use your keyboard microphone.');return false;}
      session=recognition;recognition.lang='en-US';recognition.continuous=true;recognition.interimResults=false;
      const current=()=>session===recognition&&generation===version&&allowed();
      recognition.onresult=event=>{if(!current()){if(session===recognition)stop('Voice stopped because this page or project context changed.');return;}for(let index=event.resultIndex||0;index<event.results.length;index++){const result=event.results[index];if(!result.isFinal||seen.has(index))continue;seen.add(index);const text=String(result[0]?.transcript||'').trim();if(!text)continue;const command=commandFor(text);if(command==='stop'){stop();return;}if(command){stop('Listening paused for the requested action.');onCommand(command);return;}onTranscript(text);if(!current())return;}};
      recognition.onerror=()=>{if(session===recognition)stop('Voice recognition stopped or permission was denied. Type, or explicitly start it again.');};
      recognition.onend=()=>{if(session===recognition)stop('The browser ended listening. Start voice again to continue, or type.');};
      try{recognition.start();if(!current())return false;timer=setTimer(()=>{if(session===recognition)stop('Five-minute voice limit reached. Start again when ready.');},maxMs);onStatus('Listening while this page is visible. Nothing is saved by voice. Say "assistant stop listening" to stop.',true);return true;}catch{stop('Voice could not start. Type or use your keyboard microphone.');return false;}
    }
    function read(text){
      if(!allowed()||typeof text!=='string'||!text.trim())return false;
      stop('Listening is off during readback. Review the displayed preview; saving uses the Confirm button.');
      if(!window.speechSynthesis||!window.SpeechSynthesisUtterance){onStatus('Spoken readback is unavailable. Read the displayed preview.',false);return false;}
      // Never truncate an exact preview or listen to its synthesized labels.
      if(text.length>20000){onStatus('This preview is too long for prototype readback. Read the complete displayed preview.',false);return false;}
      try{const version=generation,utterance=new window.SpeechSynthesisUtterance(text);utterance.lang='en-US';utterance.onend=()=>{if(version===generation)onStatus('Readback finished. Review and use the Confirm button when the exact preview is correct.',false);};utterance.onerror=()=>{if(version===generation)onStatus('Readback stopped. Read the displayed preview.',false);};window.speechSynthesis.speak(utterance);return true;}catch{onStatus('Readback unavailable. Read the displayed preview.',false);return false;}
    }
    document.addEventListener?.('visibilitychange',()=>{if(document.hidden)stop('Voice stopped because the page is hidden.');});
    window.addEventListener('blur',()=>stop('Voice stopped because the page lost focus.'));window.addEventListener('pagehide',()=>stop('Voice stopped because the page closed.'));
    // Capture after the controller starts its read-only request. Any later stop,
    // focus/visibility change, or new voice session invalidates its readback.
    function checkpoint(){const version=generation;return()=>version===generation&&allowed();}
    return {start,stop,read,checkpoint,get listening(){return Boolean(session);},get supported(){return Boolean(SpeechRecognition);}};
  }
  return {commandFor,createVoiceSession};
});
