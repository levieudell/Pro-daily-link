'use strict';
// Deployment boundary, never an editable role flag or request-selected cohort.
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const blockers = Object.freeze(['G1 normal entry and account lifecycle', 'G2 normal app entry and finite projections', 'G3 protected resource/settings lifecycle', 'G4 complete daily/report workflow', 'G5 commercial and sharing workflow', 'G6 attachment compatibility and authoritative recovery', 'G7 global/platform/billing/provider routing', 'G8 paused live Assistant typed integration', 'G9 durable history and remaining recovery', 'G10 integrated production fence/restore/migration/rollback/release packet']);
const fail = message => { throw Object.assign(Error(message), { code: 'PDL_ACTIVATION_NOT_READY', statusCode: 503 }); };
function configuration(env = process.env) {
  if (env.PDL_TENANT_ATOMIC !== '1') return { enabled: false, companyId: null, synthetic: false };
  // The frozen source is not a production release. An environment override
  // cannot declare unfinished writer/recovery coverage complete.
  if (env.NODE_ENV === 'production') fail('Roles activation is unavailable until operational coverage and recovery release gates are reviewed.');
  const companyId = env.PDL_TENANT_ATOMIC_COMPANY;
  if (companyId != null && companyId !== '' && !uuid(companyId)) fail('Use one canonical server-configured tenant UUID.');
  let url; try { url = new URL(env.SUPABASE_URL); } catch { fail('Atomic synthetic tests require an explicit localhost bridge.'); }
  if (env.PDL_TENANT_ATOMIC_SYNTHETIC !== '1' || url.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)) fail('Atomic mode requires a dedicated tenant binding; unbound mode is reserved for explicit localhost synthetic fixtures.');
  if (companyId) return { enabled: true, companyId, synthetic: false };
  return { enabled: true, companyId: null, synthetic: true };
}
function accepts(companyId, config) { return config.enabled && (config.companyId ? companyId === config.companyId : config.synthetic); }
function describe(config) { return { mode: config.enabled ? config.synthetic ? 'synthetic' : 'dedicated-tenant-draft' : 'legacy', productionReady: false, remaining: [...blockers] }; }
module.exports = { configuration, accepts, describe, blockers };
