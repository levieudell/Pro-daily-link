'use strict';

const assert = require('node:assert/strict');
const supabase = require('./database/supabase');
const originalFetch = global.fetch, originalTimeout = AbortSignal.timeout;
const previous = { PDL_SUPABASE_ENABLED: process.env.PDL_SUPABASE_ENABLED, SUPABASE_URL: process.env.SUPABASE_URL, SUPABASE_SECRET_KEY: process.env.SUPABASE_SECRET_KEY };
Object.assign(process.env, { PDL_SUPABASE_ENABLED: '1', SUPABASE_URL: 'https://timeout.invalid', SUPABASE_SECRET_KEY: 'synthetic-secret' });

(async () => {
  try {
    const deadlines = [];
    AbortSignal.timeout = ms => { deadlines.push(ms); return originalTimeout(10); };
    let receivedSignal;
    global.fetch = async (_url, options) => { receivedSignal = options.signal; return new Response('{}'); };
    await supabase.request('/rest/v1/companies');
    assert.deepEqual(deadlines, [15000], 'requests get a 15 second default');
    assert(receivedSignal instanceof AbortSignal);
    const custom = new AbortController();
    await supabase.request('/rest/v1/companies', { signal: custom.signal });
    assert.equal(receivedSignal, custom.signal, 'caller signal keeps precedence');
    assert.deepEqual(deadlines, [15000], 'no replacement deadline is created for a caller signal');
    global.fetch = (_url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    const keepAlive = setTimeout(() => {}, 1000);
    try { await assert.rejects(supabase.request('/rest/v1/companies'), error => error.name === 'TimeoutError'); }
    finally { clearTimeout(keepAlive); }
    console.log('Supabase request deadlines passed: 15 second default, caller signal precedence, and aborted pending fetch.');
  } finally {
    global.fetch = originalFetch; AbortSignal.timeout = originalTimeout;
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
