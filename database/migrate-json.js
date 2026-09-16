const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function loadEnv(filePath) {
  if (!fs.existsSync(filePath)) return {};
  return Object.fromEntries(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)
    .filter(line => line && !line.startsWith('#')).map(line => {
      const index = line.indexOf('=');
      return [line.slice(0, index), line.slice(index + 1)];
    }));
}

function stableUuid(scope, value) {
  const bytes = crypto.createHash('sha256').update(`pro-daily-link:${scope}:${value}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function roleFor(value) {
  const role = String(value || '').toLowerCase().replaceAll(' ', '_');
  if (role === 'account_owner' || role === 'owner') return 'owner';
  if (role === 'project_manager') return 'project_manager';
  if (role === 'field' || role === 'field_user') return 'field';
  return 'admin';
}

function buildTenantSnapshot(source) {
  const companyId = stableUuid('company', source.company.id);
  const idFor = (table, id) => stableUuid(`${source.company.id}:${table}`, id);
  const projectId = id => idFor('projects', id);
  const customerId = id => id == null ? null : idFor('customers', id);
  const userId = id => idFor('users', id);
  const projectsByName = new Map((source.projects || []).map(item => [item.name, item.id]));
  const sourceYear = (source.reports || []).map(item => String(item.dateIso || '').match(/^(\d{4})-/)?.[1]).find(Boolean) || '2026';
  const reportTimestamp = item => {
    if (/^\d{4}-\d{2}-\d{2}$/.test(item.dateIso || '')) return `${item.dateIso}T12:00:00.000Z`;
    const parsed = new Date(`${item.date || 'Jan 1'}, ${sourceYear} 12:00:00 UTC`);
    return Number.isNaN(parsed.valueOf()) ? `${sourceYear}-01-01T12:00:00.000Z` : parsed.toISOString();
  };
  const resolveProject = value => {
    const legacyId = typeof value === 'object' && value ? value.id : value;
    const matched = (source.projects || []).find(item => String(item.id) === String(legacyId));
    if (matched) return projectId(matched.id);
    const namedId = projectsByName.get(typeof value === 'string' ? value : value?.name);
    return namedId == null ? null : projectId(namedId);
  };
  const resolveLegacyProjectIndex = value => {
    if (Number.isInteger(value) && source.projects?.[value]) return projectId(source.projects[value].id);
    return resolveProject(value);
  };
  return {
    version: 2,
    company: { id: companyId, slug: source.company.id, name: source.company.name },
    users: (source.users || []).map(item => ({ id: userId(item.id), email: String(item.email).toLowerCase(), name: item.name, status: item.status || 'active', password_hash: null })),
    memberships: (source.users || []).map(item => ({ id: idFor('memberships', item.id), company_id: companyId, user_id: userId(item.id), role: roleFor(item.role), project_ids: (item.projectIds || []).map(projectId) })),
    customers: (source.customers || []).map(item => ({ id: customerId(item.id), company_id: companyId, name: item.name, contact: { name: item.contact || '', email: item.email || '', phone: item.phone || '' } })),
    projects: (source.projects || []).map(item => ({ id: projectId(item.id), company_id: companyId, customer_id: customerId(item.customerId), name: item.name, contract_type: item.contractType || 'estimated', data: { ...item, legacyId: item.id } })),
    team_members: (source.team || []).map(item => ({ id: idFor('team_members', item.id), company_id: companyId, name: item.name, data: { ...item, legacyId: item.id } })),
    subcontractors: (source.subcontractors || []).map(item => ({ id: idFor('subcontractors', item.id), company_id: companyId, name: item.name, data: { ...item, legacyId: item.id } })),
    reports: (source.reports || []).map(item => ({ id: idFor('reports', item.id), company_id: companyId, project_id: item.projectId == null ? resolveLegacyProjectIndex(item.project) : resolveProject(item.projectId), submitted_by: null, subcontractor_id: item.subcontractorId == null ? null : idFor('subcontractors', item.subcontractorId), status: item.status || 'draft', data: { ...item, legacyId: item.id }, created_at: reportTimestamp(item) })),
    assignments: (source.assignments || []).map(item => ({ id: idFor('assignments', item.id), company_id: companyId, project_id: resolveProject(item.projectId), data: { ...item, legacyId: item.id } })),
    photos: (source.photos || []).map(item => ({ id: idFor('photos', item.id), company_id: companyId, project_id: resolveProject(item.projectId), report_id: item.reportId == null ? null : idFor('reports', item.reportId), storage_key: item.storageKey || item.path || `${companyId}/legacy/${item.id}`, data: { ...item, legacyId: item.id } })),
    workdays: (source.workdays || []).map(item => ({ id: idFor('workdays', item.id), company_id: companyId, project_id: resolveProject(item.projectId), data: { ...item, legacyId: item.id } })),
    changes: (source.changes || []).map(item => ({ id: idFor('changes', item.id), company_id: companyId, project_id: resolveProject(item.projectId), report_id: item.reportId == null ? null : idFor('reports', item.reportId), data: { ...item, legacyId: item.id } }))
  };
}

function validateSnapshot(snapshot) {
  const failures = [];
  const projectIds = new Set(snapshot.projects.map(row => row.id));
  for (const table of ['reports', 'assignments', 'photos', 'workdays', 'changes']) {
    for (const row of snapshot[table]) if (!row.project_id || !projectIds.has(row.project_id)) failures.push(`${table}:${row.id} has an invalid project mapping`);
  }
  if (failures.length) throw new Error(`Migration validation failed:\n${failures.join('\n')}`);
}

async function upsert(baseUrl, secretKey, table, rows) {
  if (!rows.length) return;
  const response = await fetch(`${baseUrl}/rest/v1/${table}?on_conflict=id`, {
    method: 'POST',
    headers: { apikey: secretKey, Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(rows)
  });
  if (!response.ok) throw new Error(`${table} import failed (${response.status}): ${(await response.text()).slice(0, 500)}`);
}

async function countRows(baseUrl, secretKey, table, companyId) {
  const response = await fetch(`${baseUrl}/rest/v1/${table}?select=id&company_id=eq.${companyId}`, { headers: { apikey: secretKey, Authorization: `Bearer ${secretKey}`, Prefer: 'count=exact', Range: '0-0' } });
  if (!response.ok) throw new Error(`${table} reconciliation failed (${response.status})`);
  return Number((response.headers.get('content-range') || '0-0/0').split('/')[1] || 0);
}

async function applySnapshot(snapshot, env) {
  const order = ['company', 'users', 'memberships', 'customers', 'projects', 'team_members', 'subcontractors', 'reports', 'assignments', 'photos', 'workdays', 'changes'];
  for (const key of order) await upsert(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, key === 'company' ? 'companies' : key, key === 'company' ? [snapshot.company] : snapshot[key]);
  const reconciliation = {};
  for (const table of order.filter(key => !['company', 'users'].includes(key))) reconciliation[table] = await countRows(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, table, snapshot.company.id);
  return reconciliation;
}

function summary(snapshot) {
  return { companyId: snapshot.company.id, company: snapshot.company.name, counts: Object.fromEntries(Object.entries(snapshot).filter(([, value]) => Array.isArray(value)).map(([key, value]) => [key, value.length])) };
}

async function main() {
  const sourcePath = process.argv.find(arg => arg.endsWith('.json')) || path.join(__dirname, '..', 'data', 'db.json');
  const source = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
  const snapshot = buildTenantSnapshot(source);
  validateSnapshot(snapshot);
  if (!process.argv.includes('--apply')) return console.log(JSON.stringify({ mode: 'dry-run', ...summary(snapshot) }, null, 2));
  const env = { ...process.env, ...loadEnv(path.join(__dirname, '..', '.env.local')) };
  if (!env.SUPABASE_URL || !env.SUPABASE_SECRET_KEY) throw new Error('Supabase configuration is missing.');
  const reconciliation = await applySnapshot(snapshot, env);
  console.log(JSON.stringify({ mode: 'applied', ...summary(snapshot), reconciliation }, null, 2));
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { buildTenantSnapshot, validateSnapshot, stableUuid };
