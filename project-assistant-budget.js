'use strict';

const crypto = require('node:crypto');
const { stableUuid } = require('./database/migrate-json');
const { assembleSnapshot, canonicalHash } = require('./database/transactional-repository');
const PLATFORM_ID = stableUuid('platform', 'pro-daily-link-operations');
const LIMITS = Object.freeze({ company: 500000, global: 5000000, userCalls: 10, companyCalls: 50, sessionCalls: 8, sessionMs: 20 * 60000 });
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = (code, message) => Object.assign(new Error(message), { code });
const emptyLedger = () => ({ format: 'pdl-assistant-usage-v1', days: {}, sessions: {}, receipts: {} });
function validLedger(value) {
  const integer = number => Number.isSafeInteger(number) && number >= 0;
  const map = row => row && typeof row === 'object' && !Array.isArray(row) && Object.getPrototypeOf(row) === Object.prototype;
  const dayKey = key => /^\d{4}-\d{2}-\d{2}$/.test(key) && Number.isFinite(+new Date(key + 'T00:00:00Z')) && new Date(key + 'T00:00:00Z').toISOString().slice(0,10) === key;
  const shaped = value?.format === 'pdl-assistant-usage-v1' && value.days && value.sessions && value.receipts &&
    [value.days, value.sessions, value.receipts].every(map) &&
    Object.entries(value.days).every(([key, day]) => dayKey(key) && map(day) && integer(day.total) && day.total <= LIMITS.global && map(day.companies) && Object.values(day.companies).every(company => map(company) && integer(company.total) && company.total <= LIMITS.company && integer(company.calls) && company.calls <= LIMITS.companyCalls) && Object.values(day.companies).reduce((sum, company) => sum + company.total, 0) === day.total) &&
    Object.values(value.sessions).every(session => map(session) && integer(session.started) && integer(session.calls) && session.calls <= LIMITS.sessionCalls) &&
    Object.values(value.receipts).every(receipt => map(receipt) && dayKey(receipt.day) && integer(receipt.at) && integer(receipt.cost) && receipt.cost <= LIMITS.company && integer(receipt.userId) && ['dispatched','complete'].includes(receipt.status) && typeof receipt.companyId === 'string' && typeof receipt.fingerprint === 'string');
  if (!shaped) return false;
  const retained = new Map();
  for (const receipt of Object.values(value.receipts)) {
    const company = value.days[receipt.day]?.companies[receipt.companyId];
    if (!company) return false;
    const key = JSON.stringify([receipt.day, receipt.companyId]), sum = retained.get(key) || {cost:0,calls:0};
    sum.cost += receipt.cost; sum.calls++; retained.set(key, sum);
    if (sum.cost > company.total || sum.calls > company.calls) return false;
  }
  return true;
}

// This adapter uses the existing private administrative namespace and credentials.
// PostgreSQL's conditional UPDATE is the cross-process atomic boundary. No local fallback.
function createSharedStore(supabase) {
  const path = '/rest/v1/companies?id=eq.' + PLATFORM_ID + '&select=id,tenant_revisions(revision,scalar_data,content_hash),tenant_records(collection,position,data)&tenant_records.order=collection.asc,position.asc&limit=1';
  return {
    async load() {
      if (!supabase.configured()) throw fail('ASSISTANT_LEDGER_UNAVAILABLE', 'Shared assistant usage accounting is unavailable. Use manual details.');
      const rows = await (await supabase.request(path, { signal: AbortSignal.timeout(5000) })).json();
      if (rows.length !== 1 || rows[0].id !== PLATFORM_ID) throw fail('ASSISTANT_LEDGER_UNAVAILABLE', 'Existing private operations namespace is unavailable.');
      const revisions = rows[0].tenant_revisions;
      const revision = Array.isArray(revisions) ? revisions[0] : revisions;
      if (!revision || !Number.isSafeInteger(Number(revision.revision))) throw fail('ASSISTANT_LEDGER_UNINITIALIZED', 'Assistant usage accounting needs reviewed initialization.');
      const records = rows[0].tenant_records;
      if (!Array.isArray(records)) throw fail('ASSISTANT_LEDGER_UNAVAILABLE', 'Incomplete private usage snapshot.');
      const snapshot = assembleSnapshot(revision.scalar_data, records);
      if (canonicalHash(snapshot) !== revision.content_hash) throw fail('ASSISTANT_LEDGER_UNAVAILABLE', 'Private usage snapshot integrity check failed.');
      return { revision: Number(revision.revision), scalar: revision.scalar_data, records, ledger: revision.scalar_data.assistantUsage };
    },
    async compareAndSwap(previous, ledger) {
      const scalar = { ...previous.scalar, assistantUsage: ledger };
      const response = await supabase.request('/rest/v1/tenant_revisions?company_id=eq.' + PLATFORM_ID + '&revision=eq.' + previous.revision, {
        method: 'PATCH', signal: AbortSignal.timeout(5000), headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' },
        body: JSON.stringify({ revision: previous.revision + 1, scalar_data: scalar, content_hash: canonicalHash(assembleSnapshot(scalar, previous.records)), updated_at: new Date().toISOString() })
      });
      const rows = await response.json();
      if (!Array.isArray(rows) || rows.length > 1) throw fail('ASSISTANT_LEDGER_UNAVAILABLE', 'Invalid private usage update.');
      return rows.length === 1;
    }
  };
}

function createBudget(store, now = () => new Date()) {
  async function transact(change) {
    for (let retry = 0; retry < 12; retry++) {
      const snapshot = await store.load();
      if (!validLedger(snapshot.ledger)) throw fail('ASSISTANT_LEDGER_UNINITIALIZED', 'Assistant usage accounting needs reviewed initialization.');
      const ledger = structuredClone(snapshot.ledger), result = change(ledger, +now());
      if (result.unchanged) return result.value;
      if (!validLedger(ledger)) throw fail('ASSISTANT_LEDGER_UNAVAILABLE', 'Invalid assistant usage accounting.');
      if (Buffer.byteLength(JSON.stringify(ledger)) > 4000000) throw fail('ASSISTANT_LEDGER_FULL', 'Assistant usage accounting is full. Use manual details.');
      if (await store.compareAndSwap(snapshot, ledger)) return result.value;
    }
    throw fail('ASSISTANT_LEDGER_BUSY', 'Assistant usage accounting is busy. Try later or use manual details.');
  }
  const keyFor = args => digest([args.companyId, args.userId, args.sessionId, args.turnId]);
  return {
    async reserve(args) {
      return transact((ledger, time) => {
        if (ledger.closed) throw fail('ASSISTANT_LEDGER_CLOSED', 'Assistant usage accounting is paused. Use manual details.');
        const key = keyFor(args), previous = ledger.receipts[key];
        if (previous) {
          if (previous.fingerprint !== args.fingerprint) throw fail('ASSISTANT_TURN_CHANGED', 'This turn changed. Submit a new turn.');
          return { unchanged: true, value: { ...previous, key, duplicate: true } };
        }
        if (!Number.isSafeInteger(args.cost) || args.cost <= 0 || args.cost > LIMITS.company) throw fail('ASSISTANT_PRICE_UNKNOWN', 'Approved model pricing is unavailable.');
        const sessionKey = digest([args.companyId, args.userId, args.sessionId]);
        const session = ledger.sessions[sessionKey] || { started: time, calls: 0 };
        if (time < session.started || time - session.started >= LIMITS.sessionMs || session.calls >= LIMITS.sessionCalls) throw fail('ASSISTANT_SESSION_LIMIT', 'This AI session has ended. Use manual details or start a new request.');
        const recent = Object.values(ledger.receipts).filter(row => row.companyId === args.companyId && row.userId === args.userId && time - row.at < 3600000);
        if (recent.some(row => row.status === 'dispatched' && time - row.at < 25000)) throw fail('ASSISTANT_IN_FLIGHT', 'One assistant request is already in progress.');
        if (recent.length >= LIMITS.userCalls) throw fail('ASSISTANT_RATE_LIMIT', 'Your hourly assistant limit has been reached. Use manual details.');
        const day = new Date(time).toISOString().slice(0, 10), bucket = ledger.days[day] || { total: 0, companies: {} };
        const company = bucket.companies[args.companyId] || { total: 0, calls: 0 };
        if (!Number.isSafeInteger(bucket.total) || !Number.isSafeInteger(company.total) || bucket.total < 0 || company.total < 0) throw fail('ASSISTANT_LEDGER_UNAVAILABLE', 'Invalid assistant usage accounting.');
        if (company.calls >= LIMITS.companyCalls || company.total + args.cost > LIMITS.company || bucket.total + args.cost > LIMITS.global) throw fail('ASSISTANT_DAILY_LIMIT', 'The daily assistant usage limit has been reached. Use manual details.');
        company.total += args.cost; company.calls++; bucket.total += args.cost; bucket.companies[args.companyId] = company; ledger.days[day] = bucket;
        session.calls++; ledger.sessions[sessionKey] = session;
        const receipt = { companyId: args.companyId, userId: args.userId, fingerprint: args.fingerprint, day, at: time, cost: args.cost, status: 'dispatched' };
        ledger.receipts[key] = receipt;
        // Paid-turn retries deduplicate for three days; signed conversation states expire after 20 minutes.
        for (const [id, row] of Object.entries(ledger.receipts)) if (time - row.at > 3 * 86400000) delete ledger.receipts[id];
        for (const row of Object.values(ledger.receipts)) if (time - row.at >= LIMITS.sessionMs) delete row.result;
        for (const [id, row] of Object.entries(ledger.sessions)) if (time - row.started > 4 * 86400000) delete ledger.sessions[id];
        for (const id of Object.keys(ledger.days)) if (id < new Date(time - 4 * 86400000).toISOString().slice(0,10)) delete ledger.days[id];
        return { value: { ...receipt, key, duplicate: false } };
      });
    },
    async settle(receipt, actualCost, result) {
      return transact((ledger) => {
        const row = ledger.receipts[receipt.key];
        if (!row || row.fingerprint !== receipt.fingerprint) throw fail('ASSISTANT_LEDGER_UNAVAILABLE', 'Assistant usage receipt unavailable.');
        if (row.status === 'complete') return { unchanged: true, value: row };
        // Missing/invalid provider usage retains the full conservative reservation.
        const cost = Number.isSafeInteger(actualCost) && actualCost >= 0 && actualCost <= row.cost ? actualCost : row.cost;
        if (actualCost != null && (!Number.isSafeInteger(actualCost) || actualCost > row.cost)) ledger.closed = true;
        const bucket = ledger.days[row.day], company = bucket?.companies[row.companyId];
        if (!bucket || !company) throw fail('ASSISTANT_LEDGER_UNAVAILABLE', 'Assistant usage bucket unavailable.');
        bucket.total -= row.cost - cost; company.total -= row.cost - cost;
        Object.assign(row, { cost, status: 'complete', result });
        return { value: row };
      });
    }
  };
}
module.exports = { PLATFORM_ID, LIMITS, digest, emptyLedger, validLedger, createSharedStore, createBudget };
