/* Pro Daily Link offline support: a write queue for the field's critical
 * actions plus a last-known copy of the workspace state.
 *
 * When a connection drops, eligible changes (start day, end day, daily
 * report, assignment acknowledge, time-off request) are saved in a device
 * queue instead of failing. Each entry carries a content-derived client tag;
 * the server accepts the tag and collapses accidental duplicate replays, so
 * "tap twice in a dead zone" can never file two dailies. Photos ride the same
 * queue: their (large) payloads live in the Cache API and the queue entry
 * carries only a cache key, so a dead zone never costs the crew their
 * picture evidence. A photo filed against a queued daily stores
 * reportId:"pending:<tag>"; the drain resolves the placeholder once the
 * parent entry's real id comes back, then uploads the photo linked correctly.
 * The queue replays in order when the connection returns, then the workspace
 * refreshes itself.
 */
(function () {
  'use strict';
  const QUEUE_KEY = 'pdl-offline-queue';
  const STATE_KEY = 'pdl-last-state';
  const RESOLVED_KEY = 'pdl-offline-resolved';
  const PHOTO_CACHE_NAME = 'pdl-offline-photos';
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
  let photoCachePromise = null;

  function readQueue() {
    try { return JSON.parse(localStorage.getItem(QUEUE_KEY)) || []; } catch (_) { return []; }
  }
  function writeQueue(list) {
    try { localStorage.setItem(QUEUE_KEY, JSON.stringify(list.slice(-MAX_QUEUED))); } catch (_) { /* storage full: keep the queue in memory for this session */ }
  }
  function readResolved() {
    try { return JSON.parse(localStorage.getItem(RESOLVED_KEY)) || {}; } catch (_) { return {}; }
  }
  function writeResolved(map) {
    try { localStorage.setItem(RESOLVED_KEY, JSON.stringify(map)); } catch (_) { /* quota full: pending links degrade to unlinked photos */ }
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
  // Queue a photo batch. The encoded files are too large for localStorage, so
  // the POST body lives in the Cache API and only the key rides the queue.
  async function enqueuePhotos(payload) {
    const files = Array.isArray(payload.files) ? payload.files : [];
    const signature = 'photos|' + payload.project + '|' + (payload.projectId || '') + '|' + (payload.caption || '') + '|' +
      files.map(file => `${file.name}:${file.type}:${file.lastModified}:${String(file.data || '').length}`).join('|');
    const list = readQueue();
    const existing = list.find(entry => entry.signature === signature);
    const tag = existing ? existing.tag : makeTag(signature);
    const cacheKey = 'https://pdl-offline.local/photo/' + tag;
    const store = await photoCache();
    if (!store) throw new Error('photo cache unavailable');
    await store.put(cacheKey, new Response(JSON.stringify({ ...payload, clientTag: tag })));
    const entry = {
      kind: 'photos', method: 'POST', path: '/api/photos', cacheKey, signature,
      tag, at: existing ? existing.at : Date.now()
    };
    if (existing) Object.assign(existing, entry); else list.push(entry);
    writeQueue(list);
    return entry;
  }
  function photoCache() {
    if (typeof caches === 'undefined' || typeof caches.open !== 'function') return Promise.resolve(null);
    if (!photoCachePromise) photoCachePromise = caches.open(PHOTO_CACHE_NAME).catch(() => null);
    return photoCachePromise;
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

  // Remember the real id a queued entry produced so photo batches (or a
  // status finalize) filed against it as "pending:<tag>" can link up later.
  // The map persists in localStorage because the drain and the photo upload
  // may happen in different sessions.
  function rememberResolved(tag, data) {
    if (!tag || !data || typeof data !== 'object') return;
    const id = data.report && data.report.id != null ? data.report.id : data.id;
    if (id == null) return;
    const map = readResolved();
    map[tag] = { id, workdayId: data.workday && data.workday.id != null ? data.workday.id : null, at: Date.now() };
    writeResolved(map);
  }
  function resolvePendingId(value, map) {
    if (typeof value !== 'string' || !value.startsWith('pending:')) return value;
    const hit = map[value.slice('pending:'.length)];
    return hit ? hit.id : undefined;
  }
  function resolvePendingWorkdayId(value, map) {
    if (typeof value !== 'string' || !value.startsWith('pending:')) return value;
    const hit = map[value.slice('pending:'.length)];
    return hit ? (hit.workdayId != null ? hit.workdayId : hit.id) : undefined;
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
          const resolvedMap = readResolved();
          let path = entry.path;
          // A finalize PATCH filed as /api/reports/pending:<tag> waits for the
          // queued report to exist; if the parent is gone from the queue and
          // never resolved, the finalize is dropped so it cannot block the rest.
          const pendingPath = path.match(/^\/api\/reports\/pending:([^/]+)$/);
          if (pendingPath) {
            const hit = resolvedMap[pendingPath[1]];
            if (hit) path = '/api/reports/' + hit.id;
            else if (list.some(other => other.tag === pendingPath[1])) break;
            else { list.shift(); writeQueue(list); continue; }
          }
          let requestBody;
          if (entry.kind === 'photos') {
            const store = await photoCache();
            const cached = store ? await store.match(entry.cacheKey) : null;
            if (!cached) { list.shift(); writeQueue(list); continue; }
            const parsed = await cached.json();
            parsed.clientTag = entry.tag;
            for (const field of ['reportId', 'workdayId']) {
              if (typeof parsed[field] === 'string' && parsed[field].startsWith('pending:')) {
                const parentTag = parsed[field].slice('pending:'.length);
                const resolved = field === 'reportId' ? resolvePendingId(parsed[field], resolvedMap) : resolvePendingWorkdayId(parsed[field], resolvedMap);
                if (resolved !== undefined) parsed[field] = resolved;
                else if (list.some(other => other.tag === parentTag)) { writeQueue(list); break; }
                else parsed[field] = null; // parent was refused: keep the photo, unlink it
              }
            }
            if (typeof parsed.reportId === 'string' && parsed.reportId.startsWith('pending:')) break; // still waiting on the parent
            if (typeof parsed.workdayId === 'string' && parsed.workdayId.startsWith('pending:')) break;
            requestBody = JSON.stringify(parsed);
          } else {
            requestBody = bodyWithTag(entry);
          }
          const response = await fetch(path, {
            method: entry.method,
            credentials: 'include',
            cache: 'no-store',
            headers: {
              'Content-Type': 'application/json',
              ...(localStorage.getItem('pdl-company-id') ? { 'X-PDL-Company': localStorage.getItem('pdl-company-id') } : {})
            },
            body: entry.method === 'GET' ? undefined : requestBody
          });
          if (response.ok || (response.status >= 400 && response.status < 500)) {
            if (response.ok) {
              try { rememberResolved(entry.tag, await response.json()); } catch (_) { /* non-JSON success: nothing to resolve */ }
              if (entry.kind === 'photos') {
                try { const store = await photoCache(); if (store) await store.delete(entry.cacheKey); } catch (_) { /* orphaned cache entry is harmless */ }
              }
            } else if (entry.kind === 'photos') {
              try { const store = await photoCache(); if (store) await store.delete(entry.cacheKey); } catch (_) { /* refused photo leaves no retryable payload */ }
            }
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

  window.PDLOffline = { eligible, enqueue, enqueuePhotos, drain, queuedCount, saveState, loadState };
})();
