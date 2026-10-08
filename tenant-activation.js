'use strict';
// Deployment boundary, never an editable role flag or request-selected cohort.
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const blockers = Object.freeze(['operational acceptance of unsupported company/project/customer/team/forms/catalog/financial and attachment workflows', 'separate Office and optional custom-role semantics', 'authoritative tenant backup, isolated restore and reviewed migration/rollback packet', 'selected-tenant credential/private-read/write/provider fence across legacy hosts, scripts and service-role credentials']);
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
