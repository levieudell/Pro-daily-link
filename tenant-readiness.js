'use strict';
const { canonicalHash } = require('./database/transactional-repository');
async function verify(config, { load, protocol }) {
  if (!config.enabled || config.synthetic) return;
  const unavailable = () => Object.assign(Error('Dedicated workspace readiness failed; no listener or legacy fallback is allowed.'), { code: 'PDL_ACTIVATION_NOT_READY', statusCode: 503 });
  const evidence = await protocol(config.companyId);
  if (!evidence || evidence.protocol_version !== 1 || !['initialized', 'mandatory_revision', 'guarded_policy', 'service_only', 'forced_rls'].every(key => evidence[key] === true)) throw unavailable();
  const current = await load(config.companyId);
  if (!current || !Number.isSafeInteger(current.revision) || current.revision < 1 || current.snapshot?.company?.id !== config.companyId || canonicalHash(current.snapshot) !== current.contentHash) throw unavailable();
}
module.exports = { verify };
