'use strict';
// Offline photo queue contracts: photos taken in a dead zone are stashed in
// the Cache API with a queue entry that carries only a cache key; the drain
// uploads them in order and links them to a queued daily via the pending:<tag>
// placeholder, which resolves once the parent entry's real id comes back.
const assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');

const app = fs.readFileSync('app.js', 'utf8');
const offline = fs.readFileSync('offline.js', 'utf8');

// ---------- Static contracts ----------
assert.match(app, /PDLOffline\.enqueuePhotos\(\{files:encoded/, 'uploadPhotos stashes offline photos through the queue');
assert.match(app, /queuedPhotoError\.queued=true/, 'a queued photo throw is marked so callers special-case it');
assert.match(app, /queuedError\.queued=true;queuedError\.clientTag=queuedEntry&&queuedEntry\.tag/, 'api() exposes the queue tag on queued throws');
assert.match(app, /pending:\$\{error\.clientTag\}/, 'photos filed behind a queued daily use the pending placeholder');
assert.match(app, /enqueue\('PATCH',`\/api\/reports\/\$\{targetReportId\}`/, 'a queued daily gets a status finalize entry');
assert.match(offline, /kind:\s*'photos'/, 'photo entries are marked in the queue');
assert.match(offline, /caches\.open\(PHOTO_CACHE_NAME\)/, 'photo payloads live in the Cache API');
assert.match(offline, /RESOLVED_KEY/, 'resolved pending ids persist across sessions');

// ---------- Queue + Cache API semantics (synthetic VM) ----------
function makeStorage(){ const map = new Map(); return { getItem:k=>map.has(k)?map.get(k):null, setItem:(k,v)=>map.set(k,String(v)), removeItem:k=>map.delete(k), _map:map }; }
function makeCacheHarness(){
  // Snapshot the body text at put time and hand out a fresh Response per
  // match, like a real cache does across sessions (a consumed Response
  // cannot be re-read).
  const blobs = new Map();
  const store = {
    put: async (key, response) => { blobs.set(key, await response.text()); },
    match: async key => blobs.has(key) ? new Response(blobs.get(key)) : null,
    delete: async key => blobs.delete(key),
    _blobs: blobs
  };
  return { caches: { open: async () => store }, store };
}
function loadQueue(online, fetchImpl, storage, cachesImpl){
  const handlers = {};
  const sandbox = {
    // readyState 'loading' keeps the module's boot-time auto-drain from
    // racing the explicit drain() calls in these tests.
    window: null, document: { readyState: 'loading', addEventListener(){} },
    navigator: { onLine: online }, localStorage: storage, fetch: fetchImpl,
    Response, setTimeout, console,
    ...(cachesImpl ? { caches: cachesImpl } : {})
  };
  sandbox.window = { addEventListener: (name, fn) => { handlers[name] = fn; } };
  vm.createContext(sandbox);
  vm.runInContext(offline, sandbox);
  return { PDLOffline: sandbox.window.PDLOffline, handlers };
}
const photoPayload = (tag, linkTag) => ({ files: [{ name: 'a.jpg', type: 'image/jpeg', lastModified: 1, data: 'data:image/jpeg;base64,' + tag }], project: 0, projectId: 1, source: 'field', caption: 'Daily report field photos', tags: ['site'], reportId: 'pending:' + linkTag });

(async () => {
  // 1) enqueuePhotos stores the payload in the cache and a slim entry in the queue
  {
    const storage = makeStorage(), harness = makeCacheHarness();
    const { PDLOffline } = loadQueue(false, async () => { throw new Error('offline'); }, storage, harness.caches);
    const entry = await PDLOffline.enqueuePhotos(photoPayload('one','REPORT-TAG'));
    assert.equal(entry.kind, 'photos');
    assert.equal(PDLOffline.queuedCount(), 1);
    const queued = JSON.parse(storage.getItem('pdl-offline-queue'));
    assert.equal(queued[0].body, undefined, 'photo entries keep no body in localStorage');
    assert.ok(queued[0].cacheKey.includes(entry.tag), 'the queue entry carries the cache key');
    assert.ok(harness.store._blobs.has(queued[0].cacheKey), 'the encoded photos are in the Cache API');
    const roundTrip = JSON.parse(await harness.store._blobs.get(queued[0].cacheKey));
    assert.equal(roundTrip.reportId, 'pending:REPORT-TAG');
  }

  // 2) the drain links queued photos to the daily once its real id comes back
  {
    const storage = makeStorage(), harness = makeCacheHarness(), calls = [];
    const { PDLOffline } = loadQueue(true, async (url, options) => {
      calls.push({ url, body: options.body });
      if (calls.length === 1) return { ok: true, status: 201, json: async () => ({ id: 42 }) };
      return { ok: true, status: 201, json: async () => [{ id: 9 }] };
    }, storage, harness.caches);
    const report = PDLOffline.enqueue('POST', '/api/reports', '{"notes":"dead zone daily"}');
    await PDLOffline.enqueuePhotos(photoPayload('two', report.tag));
    const result = await PDLOffline.drain();
    assert.equal(result.remaining, 0, 'the whole queue drains');
    assert.equal(calls.length, 2);
    assert.equal(calls[0].url, '/api/reports', 'the parent daily replays first');
    assert.equal(calls[1].url, '/api/photos');
    const photoBody = JSON.parse(calls[1].body);
    assert.equal(photoBody.reportId, 42, 'the pending placeholder resolves to the real report id');
    assert.match(photoBody.clientTag, /^pdlq-/, 'the photo upload carries its own dedupe tag');
    const queued = JSON.parse(storage.getItem('pdl-offline-queue'));
    assert.equal(queued.length, 0);
    assert.equal(harness.store._blobs.size, 0, 'the drained photo payload leaves the cache');
  }

  // 3) resolution persists across sessions: daily drains in one session, photos in the next
  {
    const storage = makeStorage(), harness = makeCacheHarness();
    const sessionA = loadQueue(true, async url => {
      if (url === '/api/reports') return { ok: true, status: 201, json: async () => ({ id: 42 }) };
      throw new Error('flaky');
    }, storage, harness.caches);
    const report = sessionA.PDLOffline.enqueue('POST', '/api/reports', '{"notes":"dead zone daily"}');
    await sessionA.PDLOffline.enqueuePhotos(photoPayload('three', report.tag));
    const partial = await sessionA.PDLOffline.drain();
    assert.equal(partial.sent, 1, 'the daily replays before the connection drops again');
    assert.equal(partial.remaining, 1, 'the photos wait behind the flaky connection');
    const sessionB = loadQueue(true, async (url, options) => {
      const body = JSON.parse(options.body);
      assert.equal(body.reportId, 42, 'a later session resolves the pending link from the persisted map');
      return { ok: true, status: 201, json: async () => [{ id: 9 }] };
    }, storage, harness.caches);
    const done = await sessionB.PDLOffline.drain();
    assert.equal(done.remaining, 0);
  }

  // 4) an orphaned pending link degrades to an unlinked project photo instead of blocking the queue
  {
    const storage = makeStorage(), harness = makeCacheHarness(), calls = [];
    const { PDLOffline } = loadQueue(true, async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return { ok: true, status: 201, json: async () => [{ id: 9 }] };
    }, storage, harness.caches);
    await PDLOffline.enqueuePhotos(photoPayload('four','gone-tag'));
    const result = await PDLOffline.drain();
    assert.equal(result.remaining, 0, 'the orphan does not stall the queue');
    assert.equal(calls[0].body.reportId, null, 'the photo unlinks rather than waiting forever');
  }

  // 5) a finalize PATCH filed against a pending report resolves its path
  {
    const storage = makeStorage(), harness = makeCacheHarness(), calls = [];
    const { PDLOffline } = loadQueue(true, async (url, options) => {
      calls.push({ url, body: options.body });
      if (url === '/api/reports') return { ok: true, status: 201, json: async () => ({ id: 7 }) };
      return { ok: true, status: 200, json: async () => ({ id: 7 }) };
    }, storage, harness.caches);
    const report = PDLOffline.enqueue('POST', '/api/reports', '{"notes":"queued daily"}');
    PDLOffline.enqueue('PATCH', `/api/reports/pending:${report.tag}`, '{"status":"Needs review"}');
    await PDLOffline.drain();
    assert.equal(calls[1].url, '/api/reports/7', 'the finalize PATCH targets the real report id');
    assert.equal(JSON.parse(calls[1].body).status, 'Needs review');
    assert.match(JSON.parse(calls[1].body).clientTag, /^pdlq-/, 'the finalize carries a dedupe tag too');
  }

  // 6) photos wait in order when the parent daily is still stuck behind a dead connection
  {
    const storage = makeStorage(), harness = makeCacheHarness(), calls = [];
    const { PDLOffline } = loadQueue(true, async url => { calls.push(url); throw new Error('still offline'); }, storage, harness.caches);
    const report = PDLOffline.enqueue('POST', '/api/reports', '{"notes":"queued daily"}');
    await PDLOffline.enqueuePhotos(photoPayload('six', report.tag));
    const result = await PDLOffline.drain();
    assert.equal(result.sent, 0);
    assert.equal(calls.length, 1, 'the photo upload is not attempted before its parent daily exists');
    assert.equal(PDLOffline.queuedCount(), 2, 'both entries stay queued in order');
  }

  console.log('offline photos: ok');
})().catch(error => { console.error(error); process.exit(1); });
