'use strict';
// Merge local and cloud tenant snapshots for the founder console.
//
// The console must never show a stale copy of an account just because of merge
// order. For years the merge was "cloud always wins" ([...local, ...remote]
// into a Map), so a lagging cloud snapshot overwrote fresh local data and the
// console reported ghosts like "No project created · No daily reports
// submitted" for healthy accounts. Every tenant write bumps
// company.persistence.revision (the same signal freshestTenantSnapshot uses),
// so the highest revision wins; ties keep the first (local) copy.
function persistenceRevision(snapshot) { return Number(snapshot?.company?.persistence?.revision || 0); }

function mergeTenantSnapshots(local, remote, platformCloudId) {
  const byId = new Map();
  for (const tenant of [...(local || []), ...(remote || [])]) {
    if (!tenant?.company?.id || tenant.company.id === platformCloudId || tenant.company.mcpConnector === true || tenant.mcpOauth) continue;
    const id = String(tenant.company.id), existing = byId.get(id);
    if (!existing || persistenceRevision(tenant) > persistenceRevision(existing)) byId.set(id, tenant);
  }
  return [...byId.values()];
}

module.exports = { mergeTenantSnapshots, persistenceRevision };
