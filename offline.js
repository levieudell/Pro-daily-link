/* Pro Daily Link offline support: a write queue for the field's critical
 * actions plus a last-known copy of the workspace state.
 *
 * When a connection drops, eligible changes (start day, end day, daily
 * report, assignment acknowledge, time-off request) are saved in a device
 * queue instead of failing. Each entry carries a content-derived client tag;
 * the server accepts the tag and collapses accidental duplicate replays, so
 * "tap twice in a dead zone" can never file two dailies. The queue replays in
 * order when the connection returns, then the workspace refreshes itself.
 */
(function () {
  'use strict';
  const QUEUE_KEY = 'pdl-offline-queue';
  const STATE_KEY = 'pdl-last-state';
  const MAX_QUEUED = 50;

  // Mutations that are safe to queue: each is idempotent server-side (natural
  // conflict checks or clientTag dedupe) and each caller already surfaces the
  // thrown message through notify().
  const ELIGIBLE = [
    ['POST', /^\/api\/workdays\/start$/],
    ['POST', /^\/api\/workdays\/\d+\/end$/],
    ['POST', /^\/api\/reports$/],
    ['POST', /^\/api\/assignments\/\d+\/acknowledge$/],
    ['POST', /^\/api\/time-off-requests$/]
  ];

  let draining = false;

  function readQueue() {
    try { return JSON.parse(localStorage.getItem(QUEUE_KEY)) || []; } catch (_) { return []; }
  }
  function writeQueue(list) {
    try { localStorage.setItem(QUEUE_KEY, JSON.stringify(list.slice(-MAX_QUEUED))); } catch (_) { /* storage full: keep the queue in memory for this session */ }
  }
  function eligible(method, path) {
    return ELIGIBLE.some(([m, re]) => m === method && re.test(path));
  }
  function makeTag(signature) {
    let hash = 0;
    for (let i = 0; i < signature.length; i++) hash = (hash * 31 + signature.charCodeAt(i)) >>> 0;
    return 'pdlq-' + hash.toString(36) + '-' + Date.now().toString(36);
  }
  // Queue (or refresh) an entry. Identical content replaces the earlier entry
  // so the replay stays idempotent and the user can retry freely.
  function enqueue(method, path, body) {
    const list = readQueue();
    const signature = method + '|' + path + '|' + (body || '');
    const existing = list.find(entry => entry.signature === signature);
    const entry = {
      method, path, body: body || '', signature,
      tag: existing ? existing.tag : makeTag(signature),
      at: existing ? existing.at : Date.now()
    };
    if (existing) Object.assign(existing, entry); else list.push(entry);
    writeQueue(list);
    return entry;
  }
  function queuedCount() { return readQueue().length; }

  // The client tag rides inside the JSON body so the server's existing body
  // parsing picks it up without any route changes.
  function bodyWithTag(entry) {
    try {
      const parsed = JSON.parse(entry.body || '{}');
      if (!parsed.clientTag) parsed.clientTag = entry.tag;
      return JSON.stringify(parsed);
    } catch (_) {
      return JSON.stringify({ clientTag: entry.tag });
    }
  }

  // Replay the queue in order. 4xx responses consume the entry (the server
  // processed and refused it — retrying later will not change that); network
  // failures and 5xx keep the entry and stop the drain to preserve ordering.
  async function drain() {
    if (draining || !navigator.onLine) return { sent: 0, remaining: queuedCount() };
    draining = true;
    let sent = 0;
    try {
      for (;;) {
        const list = readQueue();
        if (!list.length) break;
        const entry = list[0];
        try {
          const response = await fetch(entry.path, {
            method: entry.method,
            credentials: 'include',
            cache: 'no-store',
            headers: {
              'Content-Type': 'application/json',
              ...(localStorage.getItem('pdl-company-id') ? { 'X-PDL-Company': localStorage.getItem('pdl-company-id') } : {})
            },
            body: entry.method === 'GET' ? undefined : bodyWithTag(entry)
          });
          if (response.ok || (response.status >= 400 && response.status < 500)) {
            list.shift();
            writeQueue(list);
            sent++;
          } else break;
        } catch (_) { break; }
      }
    } finally {
      draining = false;
    }
    const remaining = queuedCount();
    if (sent > 0 && typeof notify === 'function') {
      notify(remaining
        ? `Back online — ${sent} saved change${sent === 1 ? ' was' : 's were'} sent. ${remaining} still waiting for a steady connection.`
        : `Back online — your ${sent === 1 ? 'saved change was' : `${sent} saved changes were`} sent.`);
    }
    if (sent > 0 && typeof loadRole === 'function' && typeof currentRole !== 'undefined') {
      try { await loadRole(currentRole); } catch (_) { /* a later action will refresh */ }
    }
    if (typeof updateConnectivity === 'function') updateConnectivity(Boolean(sent));
    return { sent, remaining };
  }

  // Last-known workspace state: lets the app boot and show real data with no
  // connection. Photos are stripped (they can be large and cannot upload
  // offline anyway).
  function saveState(state) {
    try {
      const copy = { ...(state || {}) };
      delete copy.photos;
      localStorage.setItem(STATE_KEY, JSON.stringify(copy));
    } catch (_) { /* quota exceeded: booting offline just will not have a cache */ }
  }
  function loadState() {
    try { return JSON.parse(localStorage.getItem(STATE_KEY)) || null; } catch (_) { return null; }
  }

  window.addEventListener('online', () => { drain(); });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => { if (navigator.onLine) drain(); });
  else if (navigator.onLine) drain();

  window.PDLOffline = { eligible, enqueue, drain, queuedCount, saveState, loadState };
})();
