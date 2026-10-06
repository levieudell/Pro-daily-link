'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const supabase = require('./supabase');
const { canonicalHash, databaseCompanyId } = require('./transactional-repository');

const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function parseArgs(argv = process.argv.slice(2)) {
  const companyIndex = argv.indexOf('--company-id');
  const outputIndex = argv.indexOf('--output');
  const companyId = companyIndex >= 0 ? String(argv[companyIndex + 1] || '').trim() : '';
  const output = outputIndex >= 0 ? String(argv[outputIndex + 1] || '').trim() : '';
  if (!companyId) throw new Error('A single synthetic or approved tenant is required: --company-id <uuid>.');
  if (!output) throw new Error('An independent destination is required: --output <directory>.');
  return { companyId, output };
}

function collectStorageReferences(snapshot) {
  const companyId = databaseCompanyId(snapshot?.company?.id);
  const references = [];
  const add = (bucket, objectKey, source, url) => {
    if (!bucket || !objectKey) {
      if (url || bucket || objectKey) throw new Error(`Incomplete recovery set: ${source} has no complete private-storage reference. Preserve its original file and migrate it before creating a portable backup.`);
      return;
    }
    const key = String(objectKey).replaceAll('\\', '/').replace(/^\/+/, '');
    if (key.includes('../') || !key.startsWith(`${companyId}/`)) throw new Error(`Unsafe or cross-tenant storage key in ${source}: ${key}`);
    references.push({ bucket: String(bucket), objectKey: key, source });
  };
  add(snapshot.company?.logo?.bucket, snapshot.company?.logo?.objectKey, 'company.logo', snapshot.company?.logo?.url);
  for (const row of snapshot.photos || []) add(row.storageBucket, row.storageKey, `photos:${row.id}`, row.url);
  for (const row of snapshot.projectPlans || []) add(row.storageBucket, row.storageKey, `projectPlans:${row.id}`, row.url);
  for (const row of snapshot.projectTickets || []) add(row.bucket, row.objectKey, `projectTickets:${row.id}`, row.url);
  for (const row of snapshot.estimateImports || []) add(row.storageBucket, row.storageKey, `estimateImports:${row.id}`, row.url);
  for (const project of snapshot.projects || []) for (const row of project.estimateProposals || []) {
    const file = row.sourceFile;
    if (file) add(file.bucket || file.storageBucket, file.objectKey || file.storageKey, `estimateProposals:${project.id}:${row.id}`, file.url);
  }
  const unique = new Map(references.map(reference => [`${reference.bucket}/${reference.objectKey}`, reference]));
  return [...unique.values()].sort((a, b) => `${a.bucket}/${a.objectKey}`.localeCompare(`${b.bucket}/${b.objectKey}`));
}

async function createPortableBackup({ snapshot, destination, download = supabase.download, now = new Date() }) {
  const companyId = databaseCompanyId(snapshot?.company?.id);
  // Refuse an incomplete set before writing a snapshot or a success manifest.
  const references = collectStorageReferences(snapshot);
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const directory = path.resolve(destination, `${companyId}-${stamp}`);
  fs.mkdirSync(path.join(directory, 'objects'), { recursive: true });
  const snapshotBytes = Buffer.from(JSON.stringify(snapshot));
  fs.writeFileSync(path.join(directory, 'snapshot.json'), snapshotBytes, { flag: 'wx' });
  const objects = [];
  for (const [index, reference] of references.entries()) {
    const response = await download(reference.bucket, reference.objectKey);
    const bytes = Buffer.from(await response.arrayBuffer());
    const hash = digest(bytes);
    const filename = `${String(index + 1).padStart(5, '0')}-${hash.slice(0, 16)}.bin`;
    fs.writeFileSync(path.join(directory, 'objects', filename), bytes, { flag: 'wx' });
    objects.push({ ...reference, filename: `objects/${filename}`, bytes: bytes.length, sha256: hash, contentType: response.headers?.get?.('content-type') || null });
  }
  const manifest = {
    format: 'pdl-portable-backup-v1',
    createdAt: now.toISOString(),
    companyId,
    companyName: snapshot.company?.name || '',
    revision: Number(snapshot.company?.persistence?.revision || 0),
    snapshot: { filename: 'snapshot.json', bytes: snapshotBytes.length, sha256: digest(snapshotBytes), canonicalSha256: canonicalHash(snapshot) },
    objects
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(directory, 'manifest.json'), manifestBytes, { flag: 'wx' });
  return { directory, manifest, manifestSha256: digest(manifestBytes) };
}

async function main() {
  const root = path.resolve(__dirname, '..');
  supabase.loadLocalEnv(root);
  if (!supabase.configured()) throw new Error('Supabase configuration is missing.');
  const { companyId, output } = parseArgs();
  const snapshot = await supabase.loadCompanySnapshot(companyId);
  if (!snapshot?.company?.id) throw new Error(`Company snapshot not found: ${companyId}`);
  const result = await createPortableBackup({ snapshot, destination: output });
  console.log(JSON.stringify({ directory: result.directory, companyId: result.manifest.companyId, objects: result.manifest.objects.length, snapshotSha256: result.manifest.snapshot.sha256, manifestSha256: result.manifestSha256 }, null, 2));
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });

module.exports = { parseArgs, collectStorageReferences, createPortableBackup, digest };
