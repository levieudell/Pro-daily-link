(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PDLAssistantConversation = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';
  const clean = value => String(value || '').trim().replace(/[.!?]+$/, '').toLowerCase();
  const slots = {
    schedule: ['memberId', 'date', 'start', 'end', 'activity', 'instructions'],
    schedule_batch: ['memberIds', 'startDate', 'endDate', 'weekdays', 'start', 'end', 'activity', 'instructions'],
    note: ['text'], todo: ['text', 'deadline', 'dueDate']
  };
  const labels = {memberId:'person', memberIds:'people', date:'date', startDate:'start date', endDate:'end date', weekdays:'weekdays', start:'start time', end:'end time', activity:'task', instructions:'daily instructions', text:'text', deadline:'deadline', dueDate:'due date'};
  function missingSlot(draft) {
    return (slots[draft.action] || []).find(key => {
      if (key === 'dueDate' && draft.deadline !== 'date') return false;
      const value = draft[key];
      return Array.isArray(value) ? !value.length : value == null || value === '';
    }) || null;
  }
  function exactDate(text) {
    const value = clean(text), months = ['january','february','march','april','may','june','july','august','september','october','november','december'];
    let date = /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
    const match = value.match(/^(january|february|march|april|may|june|july|august|september|october|november|december) (\d{1,2})(?:st|nd|rd|th)?,? (\d{4})$/);
    if (match) date = `${match[3]}-${String(months.indexOf(match[1])+1).padStart(2,'0')}-${match[2].padStart(2,'0')}`;
    if (!date) return null;
    const parsed = new Date(date + 'T12:00:00Z');
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0,10) === date ? date : null;
  }
  function exactTime(text) {
    const value = clean(text).replace(/a\.?m\.?$/,'am').replace(/p\.?m\.?$/,'pm');
    const full = value.match(/^(\d{2}):(\d{2})$/);
    if (full && Number(full[1]) < 24 && Number(full[2]) < 60) return value;
    const match = value.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/);
    if (!match || Number(match[1]) < 1 || Number(match[1]) > 12 || Number(match[2] || 0) >= 60) return null;
    const hour = Number(match[1]) % 12 + (match[3] === 'pm' ? 12 : 0);
    return `${String(hour).padStart(2,'0')}:${match[2] || '00'}`;
  }
  function people(text, members, multiple) {
    const parts = clean(text).split(/\s*(?:,|\band\b)\s*/);
    if (!parts.length || !multiple && parts.length !== 1 || parts.length > 10) return null;
    const ids = [];
    for (const part of parts) {
      const id = part.match(/^id (\d+)$/);
      const matches = members.filter(row => id ? Number(row.id) === Number(id[1]) : clean(row.name) === part);
      if (matches.length !== 1 || ids.includes(Number(matches[0].id))) return null;
      ids.push(Number(matches[0].id));
    }
    return multiple ? ids : ids[0];
  }
  function parseAnswer(key, text, context) {
    const value = clean(text);
    if (!value || /^(?:yes|yeah|okay|ok|no|save|confirm|do it|save it|confirm and save|preview these changes)$/.test(value)) return null;
    if (key === 'memberId' || key === 'memberIds') return people(text, context.members || [], key === 'memberIds');
    if (['date','startDate','endDate','dueDate'].includes(key)) return exactDate(text);
    if (key === 'start' || key === 'end') return exactTime(text);
    if (key === 'weekdays') {
      const days = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'], parts = value.split(/\s*(?:,|\band\b)\s*/);
      if (!parts.length || parts.some(day => !days.includes(day)) || new Set(parts).size !== parts.length) return null;
      return parts.map(day => days.indexOf(day)).sort((a,b)=>a-b);
    }
    if (key === 'deadline') return ({'no deadline':'none','today':'today','exact date':'date'})[value] || null;
    const limit = key === 'activity' ? 120 : key === 'instructions' ? 2000 : 5000;
    const original = String(text).trim();
    return original.length <= limit && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(original) ? original : null;
  }
  function question(key, context) {
    if (key === 'memberId' || key === 'memberIds') return `Which ${labels[key]}? Say an exact full name${key === 'memberIds' ? ', separating people with and' : ''}, or say ID and its number. Duplicate names require IDs; authorized choices are displayed.`;
    if (['date','startDate','endDate','dueDate'].includes(key)) return `What exact ${labels[key]}? Include the year, for example October 12, 2026, or 2026-10-12. Relative dates need an exact date.`;
    if (key === 'start' || key === 'end') return `What ${labels[key]} in ${context.timezone}? Say hours with AM or PM, or an exact 24-hour time, for example 08:00.`;
    if (key === 'weekdays') return 'Which weekdays? Name every intended day, separated with and. Include Saturday or Sunday explicitly when needed.';
    if (key === 'deadline') return 'What to-do deadline? Say no deadline, today, or exact date.';
    if (key === 'activity') return 'What is the task?';
    if (key === 'instructions') return 'What daily instructions should the assigned people receive?';
    return 'What exact text should this project note or to-do contain?';
  }
  // Local guided draft collection only. This module has no chat/provider or save
  // callback. The sole request seam is the existing read-only server preview.
  function createConversation({document, window, SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition,
    canContinue, getContext, getDraft, setDraft, preview, onCancelPreview, onInterrupted = () => {}, onStatus, onTurn = () => {},
    nextSlot, nextQuestion, answerTurn, canClarifyYes = () => false, onPrompt = () => {}, onCancelSession = () => {},
    maxMs = 300000, maxTurns = 20, setTimer = setTimeout, clearTimer = clearTimeout}) {
    let active = false, generation = 0, recognition = null, totalTimer = null, listenTimer = null, turns = 0, characters = 0, asked = null, reading = false, awaitingPreview = false, exactReading = false,answering=false;
    const allowed = () => active && !document.hidden && (document.hasFocus?.() ?? true) && canContinue();
    const status = text => onStatus(text, active);
    function stop(reason = 'Conversation stopped. Nothing is saved by voice. Start again or use the fields.') {
      const wasActive=active;
      if (awaitingPreview || exactReading || answering) onInterrupted();
      awaitingPreview = exactReading = answering = false;
      active = false; reading = false; generation++; asked = null;
      const old = recognition; recognition = null;
      if (totalTimer != null) clearTimer(totalTimer); if (listenTimer != null) clearTimer(listenTimer);
      totalTimer = listenTimer = null;
      try { old?.abort(); } catch {} try { window.speechSynthesis?.cancel(); } catch {}
      if(wasActive)status(reason);
    }
    function speak(text, listenAfter) {
      if (!allowed()) { stop('Conversation stopped because this page or project context changed.'); return; }
      if (text.length > 20000) { stop('The exact preview is too long for speech. Request a fresh preview with the form and review it on screen.'); return; }
      const version = generation; reading = true; status(text);if(listenAfter)onPrompt(text);
      let utterance;
      try { utterance = new window.SpeechSynthesisUtterance(text); utterance.lang = 'en-US';
        utterance.onend = () => { if (version !== generation) return; reading = false; if (!allowed()) { stop(); return; } if (listenAfter) listen(version); else {exactReading=false;stop('Complete readback finished. Nothing saved by voice. Review the displayed preview and conflicts; use on-screen Confirm only if available and correct.');} };
        utterance.onerror = () => { if (version === generation) stop('Spoken readback was interrupted. Request a fresh preview before confirming; start again or use the fields.'); };
        window.speechSynthesis.speak(utterance);
      } catch { stop('Spoken prompts are unavailable. Use the fields and exact preview.'); }
    }
    function ask(prefix = '', override = '') {
      if (!allowed()) { stop(); return; }
      const draft = getDraft(), context = getContext();
      if (!slots[draft.action]&&!nextQuestion) { stop('Choose a supported action before starting conversation.'); return; }
      if (['schedule','schedule_batch'].includes(draft.action) && context.capabilities?.schedule === false) { stop('Scheduling permission is unavailable. Choose a project note or to-do.'); return; }
      if ((['schedule','schedule_batch'].includes(draft.action) || draft.action === 'todo' && draft.deadline && draft.deadline !== 'none') && !context.timezone) { stop('Company timezone is missing. Ask the owner to confirm it in Company settings, then return.'); return; }
      asked = nextSlot ? nextSlot() : missingSlot(draft);
      speak(override || prefix + (nextQuestion ? nextQuestion() : asked ? question(asked, context) : 'The draft fields are complete. Say preview these changes for the exact server preview, change and a field name to correct it, or cancel conversation. Voice never saves.'), true);
    }
    async function receive(text, confidence) {
      if (!allowed()) { stop(); return; }
      if (++turns > maxTurns || (characters += text.length) > 6000) { stop('Conversation limit reached. Review the draft fields; start again or type.'); return; }
      onTurn('You', text);
      const value = clean(text);
      if (['cancel conversation','stop conversation'].includes(value)) { onCancelPreview();onCancelSession(value); stop('Conversation and preview cancelled. Nothing saved.'); return; }
      if (Number.isFinite(confidence) && confidence < 0.75) { ask('Recognition was uncertain. Please repeat one exact answer. Nothing changed. '); return; }
      if (['yes','yeah','okay','ok','save','confirm','do it','save it','confirm and save'].includes(value) && !(['yes','yeah'].includes(value)&&canClarifyYes())) { ask('Voice cannot confirm or save. Use the on-screen Confirm button only after reviewing an exact preview. '); return; }
      if (answerTurn && value !== 'preview these changes') {
        const version=generation;answering=true;
        try {const result=await answerTurn(text,()=>version===generation&&allowed());if(version!==generation)return;answering=false;if(!allowed()){stop();return;}ask('',result?.message||'');}
        catch {if(version===generation)stop('That request could not finish. Start again or type. Nothing saved.');}return;
      }
      if (value.startsWith('change ')) {
        const key = (slots[getDraft().action] || []).find(key => labels[key] === value.slice(7));
        if (!key) { ask('That change is ambiguous. Use a displayed field name or cancel and edit the fields. '); return; }
        const patch = { [key]: ['memberIds','weekdays'].includes(key) ? [] : '' };
        if (key === 'deadline') patch.dueDate = '';
        setDraft(patch); onCancelPreview(); asked = key; speak(question(key, getContext()), true); return;
      }
      if (value === 'preview these changes') {
        if (nextSlot ? nextSlot() : missingSlot(getDraft())) { ask('More details are required before preview. '); return; }
        const version = generation;awaitingPreview=true; status('Checking the exact server preview. Microphone is off.');
        try { const result = await preview(); if (version !== generation) return; if (!allowed()) { stop(); return; }
          if (!result?.text) { stop('Preview could not be completed. Review the displayed message and fields.'); return; }
          awaitingPreview=false;exactReading=true;onTurn('Assistant', result.text);
          speak(result.text + (result.confirmable ? ' Nothing has been saved. Review this displayed preview and use the on-screen Confirm and save button.' : ' Nothing has been saved. Resolve the displayed conflicts and request a fresh preview.'), false);
        } catch { if (version === generation) stop('Preview failed. Review the fields and request a fresh preview. Nothing saved.'); }
        return;
      }
      if (!asked) { ask('Say preview these changes, change and a field name, or cancel conversation. '); return; }
      const answer = parseAnswer(asked, text, getContext());
      if (answer == null) { ask('That answer is ambiguous or unsupported. Nothing changed. '); return; }
      const label = labels[asked]; setDraft({ [asked]: answer }); onCancelPreview();
      ask(`Draft ${label} updated. `);
    }
    function listen(version) {
      if (version !== generation || !allowed()) { if (version === generation) stop(); return; }
      let session;
      try { session = new SpeechRecognition(); } catch { stop('Recognition is unavailable. Use the fields.'); return; }
      recognition = session; session.lang = 'en-US'; session.continuous = false; session.interimResults = false; session.maxAlternatives = 1;
      const current = () => recognition === session && version === generation && allowed();
      session.onresult = event => {
        if (!current()) { if (recognition === session) stop(); return; }
        const finals = Array.from(event.results).slice(event.resultIndex || 0).filter(row => row.isFinal);
        if (!finals.length) return;
        recognition = null; if (listenTimer != null) clearTimer(listenTimer); listenTimer = null;
        try { session.abort(); } catch {}
        if (finals.length !== 1 || !String(finals[0][0]?.transcript || '').trim()) { ask('Please answer one question at a time. Nothing changed. '); return; }
        void receive(String(finals[0][0].transcript).trim(), Number(finals[0][0].confidence));
      };
      session.onerror = () => { if (recognition === session) stop('Recognition stopped or permission was denied. Start explicitly again or type.'); };
      session.onend = () => { if (recognition === session) stop('The browser ended listening. Start explicitly again or type.'); };
      try { session.start(); if (!current()) return; listenTimer = setTimer(() => { if (recognition === session) stop('No answer received within 30 seconds. Start again or type.'); }, 30000); status('Listening for one answer. Say cancel conversation to stop. Voice never saves.'); }
      catch { stop('Recognition could not start. Use the fields.'); }
    }
    function start() {
      if (active) { stop(); return false; }
      if (!SpeechRecognition || !window.speechSynthesis || !window.SpeechSynthesisUtterance || document.hidden || !(document.hasFocus?.() ?? true) || !canContinue()) { status('Conversation speech is unavailable here. Use typing and the exact preview.'); return false; }
      active = true; generation++; turns = characters = 0; onCancelPreview();
      totalTimer = setTimer(() => stop('Five-minute conversation limit reached. Start again or type.'), maxMs);
      const context = getContext(); ask(nextQuestion?'':`Project ${context.project?.name || ''}. ${context.timezone ? `Company timezone ${context.timezone}. ` : ''}I will collect draft details one answer at a time. Nothing is saved by voice. `);
      return active;
    }
    document.addEventListener?.('visibilitychange', () => { if (document.hidden) stop('Conversation stopped because the page is hidden.'); });
    window.addEventListener('blur', () => stop('Conversation stopped because the page lost focus.'));
    window.addEventListener('pagehide', () => stop('Conversation stopped because the page closed.'));
    return { start, stop, get active() { return active; }, get reading() { return reading; }, get supported() { return Boolean(SpeechRecognition && window.speechSynthesis && window.SpeechSynthesisUtterance); } };
  }
  return { exactDate, exactTime, people, parseAnswer, missingSlot, createConversation };
});
