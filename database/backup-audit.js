'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const supabase = require('./supabase');
const { databaseCompanyId } = require('./transactional-repository');

supabase.loadLocalEnv(path.resolve(__dirname, '..'));

async function list(prefix) {
  const response = await supabase.request('/storage/v1/object/list/tenant-backups', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prefix, limit: 100, offset: 0, sortBy: { column: 'created_at', order: 'desc' } }) });
  return response.json();
}

(async () => {
  if (!supabase.configured()) throw new Error('Supabase configuration is missing.');
  const snapshots = (await supabase.listCompanySnapshots()).filter(snapshot => snapshot?.company?.id && !snapshot.platform && !snapshot.company.archivedDuplicate);
  const results = [];
  for (const snapshot of snapshots) {
    const prefix = databaseCompanyId(snapshot.company.id);
    const objects = await list(prefix);
    const newest = objects.find(item => item.name?.endsWith('.json'));
    if (!newest) { results.push({ company: snapshot.company.name, ok: false, reason: 'no backup found' }); continue; }
    const objectKey = `${prefix}/${newest.name}`;
    const bytes = Buffer.from(await (await supabase.download('tenant-backups', objectKey)).arrayBuffer());
    const hash = crypto.createHash('sha256').update(bytes).digest('hex');
    const embedded = /-([a-f0-9]{12})\.json$/.exec(newest.name)?.[1];
    let parsed;
    try { parsed = JSON.parse(bytes); } catch { parsed = null; }
    const ageHours = (Date.now() - new Date(newest.created_at || newest.updated_at).valueOf()) / 3600000;
    results.push({ company: snapshot.company.name, ok: Boolean(parsed?.company?.id === snapshot.company.id && embedded === hash.slice(0, 12) && ageHours <= 36), objectKey, bytes: bytes.length, hash, ageHours: Math.round(ageHours * 10) / 10 });
  }
  console.log(JSON.stringify({ auditedAt: new Date().toISOString(), companies: results }, null, 2));
  if (results.some(result => !result.ok)) process.exitCode = 1;
})().catch(error => { console.error(error.message); process.exitCode = 1; });


