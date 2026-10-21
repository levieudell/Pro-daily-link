'use strict';
// Founder console AI usage: (1) the ai-usage store rolls up per-day token and
// cost data with exact microdollar math, unknown-model handling, and retention
// pruning; (2) /api/platform/ai-usage is capability-gated and returns company names
// plus a null assistant ledger when the cloud store is unconfigured; (3) the
// server instruments every production AI call site through the never-throwing
// meterAI wrapper.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const aiUsage = require('./ai-usage');

// --- Unit: store rollups, cost math, unknown models, retention --------------
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-ai-usage-unit-'));
  const store = aiUsage.createUsageStore(path.join(dir, 'ai-usage.json'));
  const now = Date.now();
  const day = offset => new Date(now + offset * 86400000).toISOString().slice(0, 10);

  // Exact cost: 1000 in / 500 out at $0.75/$4.50 per 1M → ceil(750+2250)=3000 micro.
  assert.equal(aiUsage.estimateMicrodollars('gpt-5.4-mini', 1000, 500), 3000);
  assert.equal(aiUsage.estimateMicrodollars('gpt-5.4-mini', 1, 0), 1, 'sub-micro calls round up to 1 microdollar');
  assert.equal(aiUsage.estimateMicrodollars('some-other-model', 1000, 500), null, 'unpriced model reports unknown cost');
  assert.equal(aiUsage.costDollars(3000), 0.003);
  assert.equal(aiUsage.costDollars(null), null);

  assert.equal(store.record({ feature: 'not-a-feature', model: 'gpt-5.4-mini', inputTokens: 1, outputTokens: 1 }), false, 'unknown features are refused');
  assert.equal(store.record({ feature: 'daily-extract', model: 'gpt-5.4-mini', inputTokens: 1000, outputTokens: 500, companyId: 'acme', at: now }), true);
  assert.equal(store.record({ feature: 'daily-extract', model: 'gpt-5.4-mini', inputTokens: 500, outputTokens: 250, companyId: 'acme', at: now }), true);
  assert.equal(store.record({ feature: 'estimate-import', model: 'gpt-5.4-mini', inputTokens: 2000, outputTokens: 1000, companyId: 'ghost', at: now }), true);
  assert.equal(store.record({ feature: 'ticket-scan', model: 'future-model', inputTokens: 10, outputTokens: 5, companyId: null, at: now }), true);

  const summary = store.summarize(now);
  assert.equal(summary.totals.calls, 4);
  assert.equal(summary.totals.input, 3510);
  assert.equal(summary.totals.output, 1755);
  assert.equal(summary.totals.unknownCost, true, 'one unpriced call marks totals as unknown cost');
  assert.equal(summary.totals.cost, 3000 + 1500 + 6000, 'known-cost floor sums exactly');
  assert.equal(summary.byFeature['daily-extract'].calls, 2);
  assert.equal(summary.byFeature['estimate-import'].cost, 6000);
  assert.equal(summary.byCompany.acme.calls, 2);
  assert.equal(summary.byCompany.unknown.calls, 1, 'null company lands in the unknown bucket');
  assert.ok(summary.series.some(row => row.day === day(0)), 'today is in the 30-day series');

  // Retention: a day older than 120 days is pruned by the next fresh record.
  const old = now - 121 * 86400000;
  assert.equal(store.record({ feature: 'daily-extract', model: 'gpt-5.4-mini', inputTokens: 1, outputTokens: 1, at: old }), true);
  const oldDay = new Date(old).toISOString().slice(0, 10);
  assert.equal(store.record({ feature: 'daily-extract', model: 'gpt-5.4-mini', inputTokens: 1, outputTokens: 1, at: now }), true, 'fresh record triggers the prune sweep');
  const pruned = store.summarize(now);
  assert.ok(!pruned.series.some(row => row.day === oldDay), 'stale day pruned from the 30-day series');
  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'ai-usage.json'), 'utf8'));
  assert.ok(!raw.days[oldDay], 'stale day removed from the store file');

  // Fire-and-forget: a corrupt file never throws.
  fs.writeFileSync(path.join(dir, 'ai-usage.json'), 'not json');
  assert.equal(store.record({ feature: 'daily-extract', model: 'gpt-5.4-mini', inputTokens: 1, outputTokens: 1 }), true, 'record recovers from a corrupt store file');
}

// --- Static contracts: every production AI call site is metered -------------
{
  const serverSrc = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  assert.match(serverSrc, /const meterAI=\(feature,req,meta\)=>\{try\{aiUsageStore\.record/);
  assert.match(serverSrc, /catch\(_\)\{\}\}/, 'meterAI swallows errors so metering never blocks a feature');
  for (const site of [
    "meterAI('estimate-import',req,meta)",
    "meterAI('ticket-scan',req,meta)",
    "meterAI('daily-extract',req,meta)",
    "meterAI('template-draft',req,meta)"
  ]) assert.ok(serverSrc.includes(site), `${site} is wired`);
  assert.ok(serverSrc.includes("url.pathname==='/api/platform/ai-usage'"), 'owner endpoint exists');
  assert.match(serverSrc, /AI_USAGE_READ/, 'endpoint is protected by the AI-usage capability');

  const html = fs.readFileSync(path.join(__dirname, 'platform.html'), 'utf8');
  assert.match(html, /data-view="ai"/, 'nav exposes the AI usage view');
  assert.match(html, /id="ai-view"/);
  assert.match(html, /id="ai-content"/);
  assert.ok(html.indexOf('platform.js?') < html.indexOf('platform-ai.js?'), 'platform-ai.js loads after platform.js');
  const platformJs = fs.readFileSync(path.join(__dirname, 'platform.js'), 'utf8');
  assert.match(platformJs, /ai:\['AI usage','Watch model spend across every account\.'\]/);
  assert.match(platformJs, /name==='ai'&&can\(PLATFORM_CAP\.AI_USAGE_READ\)&&typeof loadAIUsageView==='function'/);
  const viewJs = fs.readFileSync(path.join(__dirname, 'platform-ai.js'), 'utf8');
  assert.match(viewJs, /\/api\/platform\/ai-usage/);
  assert.match(viewJs, /class="metrics ai-metrics"/, 'AI KPIs use the responsive class instead of a fixed inline grid');
  assert.doesNotMatch(viewJs, /class="metrics" style="grid-template-columns:repeat\(4/, 'AI KPIs do not force four mobile columns');
  const platformCss = fs.readFileSync(path.join(__dirname, 'platform.css'), 'utf8');
  const mobileCss = fs.readFileSync(path.join(__dirname, 'platform-mobile.css'), 'utf8');
  assert.match(platformCss, /\.ai-metrics\{grid-template-columns:repeat\(4,minmax\(0,1fr\)\)\}/, 'AI KPIs render four across when space allows');
  assert.match(mobileCss, /@media\(max-width:560px\)[\s\S]*\.metrics,\.ai-metrics\{grid-template-columns:1fr 1fr\}/, 'AI KPIs use an explicit two-column phone layout');
  const { isPublicFile } = require('./public-file-policy');
  assert.equal(isPublicFile(__dirname, path.join(__dirname, 'platform-ai.js')), true, 'the server must actually serve the view script (public-file-policy allowlist)');
}

// --- API: owner-gated, company names resolved, assistant null offline -------
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-ai-usage-api-'));
const dbFile = path.join(tempDir, 'db.json');
fs.writeFileSync(dbFile, fs.readFileSync(path.join(__dirname, 'data', 'db.json')));
const platformFile = path.join(tempDir, 'platform.json');
fs.copyFileSync(path.join(__dirname, 'data', 'platform.json'), platformFile);
process.env.PDL_DB_FILE = dbFile;
process.env.PDL_PLATFORM_FILE = platformFile;
process.env.PDL_SUPABASE_ENABLED = '0';
process.env.PDL_EMAIL_DEV_MODE = '1';
process.env.PDL_REQUIRE_AUTH = '1';
process.env.PDL_PLATFORM_KEY = 'test-platform-key-32-characters-minimum';

const { server } = require('./server');
const ownerToken = 'ai-usage-owner-token';
const platform = JSON.parse(fs.readFileSync(platformFile, 'utf8'));
platform.sessions = [{ userId: platform.users[0].id, tokenHash: crypto.createHash('sha256').update(ownerToken).digest('hex'), expiresAt: new Date(Date.now() + 86400000).toISOString() }];
fs.writeFileSync(platformFile, JSON.stringify(platform));

const db = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
db.company.id = 'acme-builders';
db.company.name = 'Acme Builders';
fs.writeFileSync(dbFile, JSON.stringify(db));

// Pre-seed the usage file the server will read (same directory as platform.json).
const seed = aiUsage.createUsageStore(path.join(path.dirname(platformFile), 'ai-usage.json'));
seed.record({ feature: 'daily-extract', model: 'gpt-5.4-mini', inputTokens: 1000, outputTokens: 500, companyId: 'acme-builders' });
seed.record({ feature: 'estimate-import', model: 'gpt-5.4-mini', inputTokens: 2000, outputTokens: 1000, companyId: 'ghost-account' });

server.listen(0, async () => {
  try {
    const port = server.address().port;
    const base = `http://127.0.0.1:${port}`;
    const get = async (route, headers = {}) => {
      const response = await fetch(base + route, { headers: { 'Content-Type': 'application/json', 'x-pdl-platform-key': process.env.PDL_PLATFORM_KEY, ...headers } });
      return { response, data: await response.json() };
    };

    // No session → 401.
    let result = await get('/api/platform/ai-usage');
    assert.equal(result.response.status, 401, `unauthenticated call rejected: ${JSON.stringify(result.data)}`);

    // Owner session → full payload with resolved names; assistant null because Supabase is off.
    result = await get('/api/platform/ai-usage', { Authorization: `Bearer ${ownerToken}` });
    assert.equal(result.response.status, 200, JSON.stringify(result.data));
    assert.equal(result.data.model, 'gpt-5.4-mini');
    assert.match(result.data.price.source, /openai\.com/);
    assert.equal(result.data.features.totals.calls, 2);
    assert.equal(result.data.features.totals.cost, 3000 + 6000);
    assert.equal(result.data.features.byFeature['daily-extract'].calls, 1);
    assert.equal(result.data.features.byCompany['acme-builders'].name, 'Acme Builders', 'known tenant gets its name');
    assert.equal(result.data.features.byCompany['ghost-account'].name, 'Deleted account', 'missing tenant flagged honestly');
    assert.equal(result.data.assistant, null, 'cloud assistant ledger is null when Supabase is unconfigured');

    console.log('platform-ai-usage tests passed');
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    server.close();
  }
});
