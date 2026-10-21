'use strict';
/* AI usage metering for the founder console.
 *
 * The project assistant already keeps an authoritative per-company budget
 * ledger in the private cloud namespace (project-assistant-budget.js). The
 * other AI call sites in the app — daily extraction, estimate import, ticket
 * scan, template drafting, and the assistant's batch proposal — had no
 * metering at all. This module records their token usage into a small
 * per-day rollup file next to platform.json so the founder console can show
 * spend by feature, by day, and by account.
 *
 * Cost uses the same approved gpt-5.4-mini pricing as the assistant gate
 * (project-assistant-intent.js). An unpriced model still counts tokens but
 * reports cost as unknown instead of guessing.
 */
const fs = require('node:fs');
const path = require('node:path');

const PRICE = Object.freeze({ model: 'gpt-5.4-mini', input: 0.75, output: 4.5, source: 'https://developers.openai.com/api/docs/models/gpt-5.4-mini' });
const FEATURES = Object.freeze(['daily-extract', 'estimate-import', 'ticket-scan', 'template-draft', 'assistant-proposal', 'daily-transcribe']);
const RETENTION_DAYS = 120;

const defaultModel = () => process.env.OPENAI_MODEL || PRICE.model;
// Integer microdollars, exactly the tokenCost formula in project-assistant-intent.js.
function estimateMicrodollars(model, inputTokens, outputTokens) {
  const integer = value => Number.isSafeInteger(value) && value >= 0;
  if (model !== PRICE.model || !integer(inputTokens) || !integer(outputTokens)) return null;
  return Math.ceil(inputTokens * PRICE.input + outputTokens * PRICE.output);
}
const costDollars = micro => micro == null ? null : Math.round(micro) / 1e6;

function emptyDay() { return { calls: 0, input: 0, output: 0, cost: 0, unknownCost: false, features: {}, companies: {} }; }
function emptyBucket() { return { calls: 0, input: 0, output: 0, cost: 0, unknownCost: false }; }

function createUsageStore(file) {
  function read() {
    try {
      const value = JSON.parse(fs.readFileSync(file, 'utf8'));
      return value && value.format === 'pdl-ai-usage-v1' && value.days && typeof value.days === 'object' ? value : { format: 'pdl-ai-usage-v1', days: {} };
    } catch (_) { return { format: 'pdl-ai-usage-v1', days: {} }; }
  }
  function write(value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(value));
    try { fs.renameSync(tmp, file); }
    catch (error) {
      // Windows does not consistently replace an existing destination with
      // renameSync. Preserve the already-written temp file as the source and
      // use copyFileSync's replace semantics as the platform-safe fallback.
      if (!['EEXIST', 'EPERM', 'EACCES'].includes(error.code)) throw error;
      fs.copyFileSync(tmp, file);
      fs.unlinkSync(tmp);
    }
  }
  return {
    // record is fire-and-forget safe: callers wrap it in try/catch and it
    // never throws on malformed input — metering must never block a feature.
    record({ feature, model, inputTokens, outputTokens, companyId, at = Date.now() }) {
      try {
        if (!FEATURES.includes(feature)) return false;
        const input = Number.isSafeInteger(inputTokens) && inputTokens >= 0 ? inputTokens : null;
        const output = Number.isSafeInteger(outputTokens) && outputTokens >= 0 ? outputTokens : null;
        if (input == null || output == null) return false;
        const cost = estimateMicrodollars(model, input, output);
        const day = new Date(at).toISOString().slice(0, 10);
        const value = read();
        const row = value.days[day] || emptyDay();
        row.calls++; row.input += input; row.output += output;
        if (cost == null) row.unknownCost = true; else row.cost += cost;
        const featureRow = row.features[feature] || emptyBucket();
        featureRow.calls++; featureRow.input += input; featureRow.output += output;
        if (cost == null) featureRow.unknownCost = true; else featureRow.cost += cost;
        row.features[feature] = featureRow;
        const key = String(companyId || 'unknown');
        const companyRow = row.companies[key] || emptyBucket();
        companyRow.calls++; companyRow.input += input; companyRow.output += output;
        if (cost == null) companyRow.unknownCost = true; else companyRow.cost += cost;
        row.companies[key] = companyRow;
        value.days[day] = row;
        for (const key of Object.keys(value.days)) if (key < new Date(at - RETENTION_DAYS * 86400000).toISOString().slice(0, 10)) delete value.days[key];
        write(value);
        return true;
      } catch (_) { return false; }
    },
    summarize(now = Date.now()) {
      const value = read();
      const days = Object.keys(value.days).sort();
      const totals = emptyBucket();
      const byFeature = {}, byCompany = {};
      const series = [];
      const floor30 = new Date(now - 30 * 86400000).toISOString().slice(0, 10);
      for (const day of days) {
        const row = value.days[day];
        totals.calls += row.calls; totals.input += row.input; totals.output += row.output;
        // Always sum the known-cost floor; the flag only marks that some call
        // on this day used an unpriced model, so the true total is higher.
        totals.cost += row.cost;
        if (row.unknownCost) totals.unknownCost = true;
        for (const [name, bucket] of Object.entries(row.features)) {
          const target = byFeature[name] || emptyBucket(); byFeature[name] = target;
          target.calls += bucket.calls; target.input += bucket.input; target.output += bucket.output;
          target.cost += bucket.cost;
          if (bucket.unknownCost) target.unknownCost = true;
        }
        for (const [id, bucket] of Object.entries(row.companies)) {
          const target = byCompany[id] || emptyBucket(); byCompany[id] = target;
          target.calls += bucket.calls; target.input += bucket.input; target.output += bucket.output;
          target.cost += bucket.cost;
          if (bucket.unknownCost) target.unknownCost = true;
        }
        if (day >= floor30) series.push({ day, calls: row.calls, input: row.input, output: row.output, cost: row.cost, unknownCost: row.unknownCost });
      }
      return { totals, byFeature, byCompany, series };
    }
  };
}

// Roll the assistant's authoritative budget ledger up for the same console.
function summarizeAssistantLedger(ledger, companyName = () => 'Unknown account') {
  if (!ledger || !ledger.days) return null;
  const days = Object.keys(ledger.days).sort().reverse().map(day => {
    const row = ledger.days[day];
    const companies = Object.entries(row.companies || {}).map(([id, bucket]) => ({
      id, name: companyName(id), calls: bucket.calls, cost: bucket.total
    })).sort((a, b) => b.cost - a.cost);
    return { day, calls: companies.reduce((sum, company) => sum + company.calls, 0), cost: row.total, companies };
  });
  return { days, retentionDays: 4 };
}

module.exports = { PRICE, FEATURES, defaultModel, estimateMicrodollars, costDollars, createUsageStore, summarizeAssistantLedger };
