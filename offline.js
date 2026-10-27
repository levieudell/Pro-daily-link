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
  const MAX_QUEUED_PER_USER = 50;
  const MAX_QUEUED_TOTAL = 250;

  // Mutations that are safe to queue: each is idempotent server-side (natural
  // conflict checks or clientTag dedupe) and each caller already surfaces the
  // thrown message through notify().
  const ELIGIBLE = [
    ['POST', /^\/api\/workdays\/start$/],
    ['POST', /^\/api\/workdays\/\d+\/end$/],
    ['POST', /^\/api\/reports$/],
    ['POST', /^\/api\/assignments\/\d+\/acknowledge$/],
    ['POST', /^\/api\/time-off-requests$/],
    ['POST', /^\/api\/projects\/\d+\/site-visits$/],
    ['POST', /^\/api\/projects\/\d+\/site-visits\/[0-9a-f-]{36}\/entries$/i]
  ];

  let draining = false;
  let photoCachePromise = null;

  function activeScope() {
    const companyId = String(typeof signedInCompanyId === 'function' ? signedInCompanyId() : localStorage.getItem('pdl-company-id') || '');
    // Never replay work from a remembered browser identity before the live
    // session has been authenticated. boot() explicitly drains after it sets
    // currentUser, so an account switch cannot send the prior user's queue.
    const liveUserId = typeof currentUser !== 'undefined' && currentUser ? currentUser.id : '';
    const userId = String(liveUserId || '');
    return { companyId, userId, key: `${encodeURIComponent(companyId)}:${encodeURIComponent(userId)}` };
  }
  function belongsToScope(entry, scope = activeScope()) {
    return Boolean(scope.companyId && scope.userId && String(entry?.companyId || '') === scope.companyId && String(entry?.userId || '') === scope.userId);
  }
  function cachedReadScope() {
    const live=activeScope();if(live.companyId&&live.userId)return live;
    const remembered=typeof window!=='undefined'&&window.pdlOfflineBoot?window.pdlOfflineScope:null,companyId=String(remembered?.companyId||''),userId=String(remembered?.userId||'');
    return {companyId,userId,key:`${encodeURIComponent(companyId)}:${encodeURIComponent(userId)}`};
  }

  function readQueue() {
    try { return JSON.parse(localStorage.getItem(QUEUE_KEY)) || []; } catch (_) { return []; }
  }
  function writeQueue(list) {
    if (!Array.isArray(list)) throw new Error('Offline storage could not be read safely. Reconnect before adding more work.');
    const prior = readQueue(), scope = activeScope();
    const scopeCounts = new Map();
    for (const entry of list) {
      const key = `${String(entry?.companyId || '')}:${String(entry?.userId || '')}`;
      scopeCounts.set(key, (scopeCounts.get(key) || 0) + 1);
    }
    const activeKey = `${scope.companyId}:${scope.userId}`, priorActiveCount = prior.filter(entry => belongsToScope(entry, scope)).length, nextActiveCount = scopeCounts.get(activeKey) || 0;
    if ((list.length > MAX_QUEUED_TOTAL && list.length > prior.length) || (nextActiveCount > MAX_QUEUED_PER_USER && nextActiveCount > priorActiveCount)) {
      throw new Error('Offline storage is full. Reconnect before adding more work.');
    }
    localStorage.setItem(QUEUE_KEY, JSON.stringify(list));
  }
  function resolvedKey(scope = activeScope()) {
    return `${RESOLVED_KEY}:${scope.key}`;
  }
  function readResolved(scope = activeScope()) {
    if (!scope.companyId || !scope.userId) return {};
    try { return JSON.parse(localStorage.getItem(resolvedKey(scope))) || {}; } catch (_) { return {}; }
  }
  function writeResolved(map, scope = activeScope()) {
    if (!scope.companyId || !scope.userId) return;
    localStorage.setItem(resolvedKey(scope), JSON.stringify(map));
  }
  function eligible(method, path) {
    return ELIGIBLE.some(([m, re]) => m === method && re.test(path));
  }
  function makeTag(signature) {
    let hash = 0;
    for (let i = 0; i < signature.length; i++) hash = (hash * 31 + signature.charCodeAt(i)) >>> 0;
    return 'pdlq-' + hash.toString(36) + '-' + Date.now().toString(36);
  }
  function compactHash(value) {
    const text = String(value || ''); let first = 2166136261, second = 0x9e3779b9;
    for (let i = 0; i < text.length; i++) { const code = text.charCodeAt(i); first = Math.imul(first ^ code, 16777619) >>> 0; second = Math.imul(second ^ (code + i), 2246822519) >>> 0; }
    return `${text.length.toString(36)}-${first.toString(36)}-${second.toString(36)}`;
  }
  // Queue (or refresh) an entry. Identical content replaces the earlier entry
  // so the replay stays idempotent and the user can retry freely.
  function enqueue(method, path, body) {
    const list = readQueue();
    const scope = activeScope();
    if (!scope.companyId || !scope.userId) throw new Error('Sign in again before saving offline work.');
    const signature = scope.key + '|' + method + '|' + path + '|' + (body || '');
    const existing = list.find(entry => entry.signature === signature);
    let parsedBody={};try{parsedBody=JSON.parse(body||'{}')}catch(_){/* body remains opaque */}
    const visitFromPath=path.match(/\/site-visits\/([0-9a-f-]{36})/i)?.[1]||null;
    const entry = {
      method, path, body: body || '', signature,
      companyId: scope.companyId, userId: scope.userId,
      visitId:visitFromPath||parsedBody.siteVisitId||parsedBody.visitId||null,
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
    const scope = activeScope();
    if (!scope.companyId || !scope.userId) throw new Error('Sign in again before saving offline photos.');
    const signature = scope.key + '|photos|' + payload.project + '|' + (payload.projectId || '') + '|' + (payload.siteVisitId || '') + '|' + (payload.caption || '') + '|' +
      files.map(file => `${file.name}:${file.type}:${file.lastModified}:${compactHash(file.data)}`).join('|');
    const list = readQueue();
    const existing = list.find(entry => entry.signature === signature);
    const tag = existing ? existing.tag : makeTag(signature);
    const cacheKey = 'https://pdl-offline.local/photo/' + tag;
    const store = await photoCache();
    if (!store) throw new Error('photo cache unavailable');
    const priorCached = existing ? await store.match(cacheKey) : null, priorText = priorCached ? await priorCached.text() : null;
    await store.put(cacheKey, new Response(JSON.stringify({ ...payload, clientTag: tag })));
    const entry = {
      kind: 'photos', method: 'POST', path: '/api/photos', cacheKey, signature,
      companyId: scope.companyId, userId: scope.userId,
      visitId:payload.siteVisitId||null,
      tag, at: existing ? existing.at : Date.now()
    };
    if (existing) Object.assign(existing, entry); else list.push(entry);
    try{writeQueue(list)}catch(error){try{if(priorText!=null)await store.put(cacheKey,new Response(priorText));else await store.delete(cacheKey)}catch(_){/* best effort */}throw error}
    return entry;
  }
  function photoCache() {
    if (typeof caches === 'undefined' || typeof caches.open !== 'function') return Promise.resolve(null);
    if (!photoCachePromise) photoCachePromise = caches.open(PHOTO_CACHE_NAME).catch(() => null);
    return photoCachePromise;
  }
  function queuedCount(visitId = null) { const scope = activeScope(); return readQueue().filter(entry => belongsToScope(entry, scope)&&(!visitId||String(entry.visitId||'')===String(visitId))).length; }
  function issueCount() { const scope=activeScope();return readQueue().filter(entry=>belongsToScope(entry,scope)&&entry.needsAttention).length; }
  function issuesForVisit(visitId){const scope=activeScope();return readQueue().filter(entry=>belongsToScope(entry,scope)&&String(entry.visitId||'')===String(visitId)&&entry.needsAttention).map(entry=>({path:entry.path,error:entry.lastError||'This saved item needs attention.'}));}

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
  function rememberResolved(tag, data, scope = activeScope()) {
    if (!tag || !data || typeof data !== 'object') return;
    const id = data.report && data.report.id != null ? data.report.id : data.id;
    if (id == null) return;
    const map = readResolved(scope);
    map[tag] = { id, workdayId: data.workday && data.workday.id != null ? data.workday.id : null, at: Date.now() };
    writeResolved(map, scope);
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

  // Replay the signed-in user's queue in order. Rejected entries stay on the
  // device as "Needs attention"; network failures and 5xx keep the entry and
  // stop the drain to preserve ordering. Evidence is never silently dropped.
  async function drain() {
    if (draining || !navigator.onLine) return { sent: 0, remaining: queuedCount() };
    draining = true;
    let sent = 0;
    const clockedOut=[];
    try {
      for (;;) {
        const list = readQueue();
        if (!list.length) break;
        const scope = activeScope();
        const entryIndex = list.findIndex(row => belongsToScope(row, scope));
        if (entryIndex < 0) break;
        const entry = list[entryIndex];
        if(entry.needsAttention)break;
        try {
          const resolvedMap = readResolved(scope);
          let path = entry.path;
          // A finalize PATCH filed as /api/reports/pending:<tag> waits for the
          // queued report to exist; if the parent is gone from the queue and
          // never resolved, the finalize is dropped so it cannot block the rest.
          const pendingPath = path.match(/^\/api\/reports\/pending:([^/]+)$/);
          if (pendingPath) {
            const hit = resolvedMap[pendingPath[1]];
            if (hit) path = '/api/reports/' + hit.id;
            else if (list.some(other => belongsToScope(other, scope) && other.tag === pendingPath[1])) break;
            else { list.splice(entryIndex,1); writeQueue(list); continue; }
          }
          let requestBody;
          if (entry.kind === 'photos') {
            const store = await photoCache();
            const cached = store ? await store.match(entry.cacheKey) : null;
            if (!cached) {
              entry.needsAttention = true;
              entry.lastError = 'This saved photo could not be found on this device. Choose the photo again before finishing.';
              entry.lastAttemptAt = Date.now();
              list[entryIndex] = entry;
              writeQueue(list);
              break;
            }
            const parsed = await cached.json();
            parsed.clientTag = entry.tag;
            for (const field of ['reportId', 'workdayId']) {
              if (typeof parsed[field] === 'string' && parsed[field].startsWith('pending:')) {
                const parentTag = parsed[field].slice('pending:'.length);
                const resolved = field === 'reportId' ? resolvePendingId(parsed[field], resolvedMap) : resolvePendingWorkdayId(parsed[field], resolvedMap);
                if (resolved !== undefined) parsed[field] = resolved;
                else if (list.some(other => belongsToScope(other,scope)&&other.tag === parentTag)) { writeQueue(list); break; }
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
              ...(entry.companyId ? { 'X-PDL-Company': entry.companyId } : {})
            },
            body: entry.method === 'GET' ? undefined : requestBody
          });
          const refused=response.status>=400&&response.status<500;
          if(refused){
            let detail={};try{detail=await response.json()}catch(_){/* keep generic message */}
            entry.needsAttention=true;entry.lastError=String(detail.error||`Saved item was refused (${response.status})`).slice(0,500);entry.lastAttemptAt=Date.now();list[entryIndex]=entry;writeQueue(list);break;
          }
          if (response.ok || refused) {
            if (response.ok) {
              try { const result=await response.json(); rememberResolved(entry.tag,result,scope); if(entry.method==='POST'&&/^\/api\/workdays\/\d+\/end$/.test(entry.path)&&result.workday?.endedAt)clockedOut.push(result.workday.id); } catch (_) { /* non-JSON success: nothing to resolve */ }
              if (entry.kind === 'photos') {
                try { const store = await photoCache(); if (store) await store.delete(entry.cacheKey); } catch (_) { /* orphaned cache entry is harmless */ }
              }
            }
            list.splice(entryIndex,1);
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
    for(const workdayId of clockedOut)window.dispatchEvent(new CustomEvent('pdl-clockout-synced',{detail:{workdayId}}));
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
      const scope=activeScope();if(scope.companyId&&scope.userId)localStorage.setItem(`${STATE_KEY}:${scope.key}`, JSON.stringify(copy));
    } catch (_) { /* quota exceeded: booting offline just will not have a cache */ }
  }
  function loadState() {
    try { const scope=cachedReadScope();return scope.companyId&&scope.userId?JSON.parse(localStorage.getItem(`${STATE_KEY}:${scope.key}`))||null:null; } catch (_) { return null; }
  }
  async function retryVisit(visitId){const scope=activeScope(),list=readQueue();for(const entry of list)if(belongsToScope(entry,scope)&&String(entry.visitId||'')===String(visitId)){delete entry.needsAttention;delete entry.lastError}writeQueue(list);return drain();}

  window.addEventListener('online', () => { drain(); });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => { if (navigator.onLine) drain(); });
  else if (navigator.onLine) drain();

  window.PDLOffline = { eligible, enqueue, enqueuePhotos, drain, queuedCount, issueCount, issuesForVisit, retryVisit, saveState, loadState };
})();
