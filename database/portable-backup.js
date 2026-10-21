'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const supabase = require('./supabase');
const { canonicalHash, databaseCompanyId } = require('./transactional-repository');

const FORMAT = 'pdl-portable-backup-v1';
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function transactionalMode() {
  const mode = String(process.env.PDL_TRANSACTIONAL_DB || 'off').toLowerCase();
  return ['shadow', 'primary'].includes(mode) ? mode : 'off';
}

function isMissingStorageObjectError(error) {
  return /(?:\b404\b|not[ -]?found|NoSuchKey|NoSuchObject)/i.test(String(error?.message || error || ''));
}

function safeBackupFile(directory, relativePath) {
  const root = path.resolve(directory);
  const target = path.resolve(root, String(relativePath || ''));
  if (target !== root && !target.startsWith(root + path.sep)) throw new Error(`Backup path escapes its directory: ${relativePath}`);
  return target;
}

function readBackupFile(directory, relativePath) {
  const file = safeBackupFile(directory, relativePath);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Backup entry is not a regular file: ${relativePath}`);
  const realRoot = fs.realpathSync(path.resolve(directory));
  const realFile = fs.realpathSync(file);
  if (realFile !== realRoot && !realFile.startsWith(realRoot + path.sep)) throw new Error(`Backup entry resolves outside its directory: ${relativePath}`);
  return fs.readFileSync(file);
}

function writeExclusive(file, bytes) {
  fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 });
}

async function loadAuthoritativeTenantSnapshot(companyId) {
  const requestedId = databaseCompanyId(companyId);
  if (transactionalMode() === 'primary') {
    const state = await supabase.loadTransactionalSnapshot(requestedId);
    if (!state?.snapshot?.company?.id || databaseCompanyId(state.snapshot.company.id) !== requestedId) {
      throw new Error(`Authoritative transactional company snapshot not found: ${companyId}`);
    }
    const contentHash = canonicalHash(state.snapshot);
    if (state.contentHash && state.contentHash !== contentHash) throw new Error('Authoritative tenant content hash does not match the exported snapshot.');
    return { snapshot: state.snapshot, authority: { mode: 'transactional-primary', repositoryRevision: Number(state.revision), contentHash } };
  }
  const snapshot = await supabase.loadCompanySnapshot(companyId);
  if (!snapshot?.company?.id || databaseCompanyId(snapshot.company.id) !== requestedId) throw new Error(`Company snapshot not found: ${companyId}`);
  return { snapshot, authority: { mode: 'legacy-snapshot', repositoryRevision: null, contentHash: canonicalHash(snapshot) } };
}

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
  const references = new Map();
  const add = (asset, source) => {
    if (!asset || typeof asset !== 'object') return;
    const bucket = asset.storageBucket ?? asset.bucket;
    const objectKey = asset.storageKey ?? asset.objectKey;
    if (!bucket && !objectKey) {
      const localUrl = String(asset.url || asset.dataUrl || asset.downloadUrl || '');
      if (/^\/?uploads\//i.test(localUrl)) {
        throw new Error(`Non-portable local storage reference in ${source}: ${localUrl}. Migrate this object to private Storage before exporting.`);
      }
      return;
    }
    if (!bucket || !objectKey) throw new Error(`Incomplete private storage reference in ${source}.`);
    const key = String(objectKey).replaceAll('\\', '/').replace(/^\/+/, '');
    if (!key || key.includes('../') || key.split('/').includes('..') || !key.startsWith(`${companyId}/`)) {
      throw new Error(`Unsafe or cross-tenant storage key in ${source}: ${key || '(blank)'}`);
    }
    const reference = { bucket: String(bucket), objectKey: key, source };
    references.set(`${reference.bucket}/${reference.objectKey}`, reference);
  };
  add(snapshot.company?.logo, 'company.logo');
  for (const row of snapshot.photos || []) add(row, `photos:${row.id}`);
  for (const row of snapshot.projectPlans || []) add(row, `projectPlans:${row.id}`);
  for (const row of snapshot.projectTickets || []) add(row, `projectTickets:${row.id}`);
  for (const row of snapshot.estimateImports || []) add(row, `estimateImports:${row.id}`);
  for (const project of snapshot.projects || []) {
    for (const proposal of project.estimateProposals || []) add(proposal.sourceFile, `projects:${project.id}:estimateProposals:${proposal.id}`);
  }
  return [...references.values()].sort((a, b) => `${a.bucket}/${a.objectKey}`.localeCompare(`${b.bucket}/${b.objectKey}`));
}

async function createPortableBackup({
  snapshot,
  destination,
  download = supabase.download,
  now = new Date(),
  authority = null,
  allowMissingObjects = false
}) {
  const companyId = databaseCompanyId(snapshot?.company?.id);
  if (!snapshot?.company?.id) throw new Error('Tenant backup requires a company snapshot.');
  if (!destination) throw new Error('Tenant backup requires an independent destination directory.');
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const snapshotCanonicalHash = canonicalHash(snapshot);
  if (authority?.contentHash && authority.contentHash !== snapshotCanonicalHash) throw new Error('Backup authority hash does not match the tenant snapshot.');
  fs.mkdirSync(path.resolve(destination), { recursive: true, mode: 0o700 });
  let directory = null, createdDirectory = false;
  for (let attempt = 0; attempt < 10 && !createdDirectory; attempt += 1) {
    const candidate = path.resolve(destination, `${companyId}-${stamp}-${crypto.randomBytes(6).toString('hex')}`);
    try { fs.mkdirSync(candidate, { recursive: false, mode: 0o700 }); directory = candidate; createdDirectory = true; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  if (!createdDirectory) throw new Error('Could not allocate a unique tenant backup directory.');
  try {
    fs.mkdirSync(path.join(directory, 'objects'), { recursive: false, mode: 0o700 });
    const snapshotBytes = Buffer.from(JSON.stringify(snapshot, null, 2));
    writeExclusive(path.join(directory, 'snapshot.json'), snapshotBytes);
    const objects = [];
    for (const [index, reference] of collectStorageReferences(snapshot).entries()) {
      let response;
      try {
        response = await download(reference.bucket, reference.objectKey);
      } catch (error) {
        if (!allowMissingObjects || !isMissingStorageObjectError(error)) throw error;
        objects.push({ ...reference, missing: true });
        continue;
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      const hash = digest(bytes);
      const filename = `objects/${String(index + 1).padStart(5, '0')}-${hash.slice(0, 16)}.bin`;
      writeExclusive(safeBackupFile(directory, filename), bytes);
      objects.push({ ...reference, filename, bytes: bytes.length, sha256: hash, contentType: response.headers?.get?.('content-type') || 'application/octet-stream' });
    }
    const manifest = {
      format: FORMAT,
      createdAt: now.toISOString(),
      companyId,
      companyName: snapshot.company?.name || '',
      revision: Number(snapshot.company?.persistence?.revision || 0),
      authority: authority || { mode: 'provided-snapshot', repositoryRevision: null, contentHash: snapshotCanonicalHash },
      snapshot: { filename: 'snapshot.json', bytes: snapshotBytes.length, sha256: digest(snapshotBytes), canonicalSha256: snapshotCanonicalHash },
      objects
    };
    const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2));
    writeExclusive(path.join(directory, 'manifest.json'), manifestBytes);
    const manifestSha256 = digest(manifestBytes);
    writeExclusive(path.join(directory, 'manifest.sha256'), Buffer.from(`${manifestSha256}  manifest.json\n`));
    const verification = verifyPortableBackup(directory, { expectedCompanyId: companyId });
    return { directory, manifest, manifestSha256, verification };
  } catch (error) {
    if (createdDirectory) fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

function verifyHashEntry(bytes, expectedHash, expectedBytes, label) {
  if (!/^[a-f0-9]{64}$/.test(String(expectedHash || ''))) throw new Error(`${label} has an invalid SHA-256 digest.`);
  if (!Number.isSafeInteger(Number(expectedBytes)) || Number(expectedBytes) < 0) throw new Error(`${label} has an invalid byte count.`);
  if (bytes.length !== Number(expectedBytes)) throw new Error(`${label} byte count does not match its manifest.`);
  if (digest(bytes) !== expectedHash) throw new Error(`${label} SHA-256 does not match its manifest.`);
}

function verifyPortableBackup(directory, { expectedCompanyId = null } = {}) {
  const root = path.resolve(directory);
  const manifestBytes = readBackupFile(root, 'manifest.json');
  const checksum = readBackupFile(root, 'manifest.sha256').toString('utf8').trim();
  const checksumMatch = /^([a-f0-9]{64})\s{2}manifest\.json$/.exec(checksum);
  if (!checksumMatch || checksumMatch[1] !== digest(manifestBytes)) throw new Error('Tenant backup manifest SHA-256 verification failed.');
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  if (manifest.format !== FORMAT) throw new Error('Unsupported tenant backup format.');
  if (!Number.isFinite(Date.parse(String(manifest.createdAt || '')))) throw new Error('Tenant backup creation time is missing or invalid.');
  const companyId = databaseCompanyId(manifest.companyId);
  if (expectedCompanyId && companyId !== databaseCompanyId(expectedCompanyId)) throw new Error('Tenant backup company does not match the requested company.');
  const snapshotBytes = readBackupFile(root, manifest.snapshot?.filename);
  verifyHashEntry(snapshotBytes, manifest.snapshot?.sha256, manifest.snapshot?.bytes, 'Tenant snapshot');
  const snapshot = JSON.parse(snapshotBytes.toString('utf8'));
  const contentHash = canonicalHash(snapshot);
  if (databaseCompanyId(snapshot.company?.id) !== companyId || contentHash !== manifest.snapshot?.canonicalSha256) throw new Error('Tenant snapshot identity or canonical SHA-256 verification failed.');
  const authorityMode = String(manifest.authority?.mode || '');
  if (!['transactional-primary', 'legacy-snapshot', 'provided-snapshot', 'pre-restore-uninitialized'].includes(authorityMode)) throw new Error('Tenant backup authority is missing or unsupported.');
  if (manifest.authority?.contentHash !== contentHash) throw new Error('Tenant backup authority hash verification failed.');
  if (authorityMode === 'transactional-primary' && !Number.isSafeInteger(Number(manifest.authority?.repositoryRevision))) throw new Error('Tenant backup transactional authority revision is invalid.');
  const seenObjects = new Set(), seenFiles = new Set(), objectEntries = [];
  for (const object of manifest.objects || []) {
    const bucket = String(object.bucket || '');
    if (!bucket || /[\\/\u0000-\u001f\u007f]/.test(bucket)) throw new Error(`Invalid tenant backup bucket: ${bucket || '(blank)'}`);
    const objectKey = String(object.objectKey || '').replaceAll('\\', '/').replace(/^\/+/, '');
    if (!objectKey.startsWith(`${companyId}/`) || objectKey.includes('../') || objectKey.split('/').includes('..')) throw new Error(`Unsafe or cross-tenant backup object: ${objectKey || '(blank)'}`);
    const key = `${bucket}/${objectKey}`;
    if (seenObjects.has(key)) throw new Error(`Duplicate tenant backup object: ${key}`);
    seenObjects.add(key);
    if (object.missing === true) {
      if (object.filename != null || object.sha256 != null || object.bytes != null) throw new Error(`Missing tenant object contains payload metadata: ${key}`);
      objectEntries.push({ bucket, objectKey, source: String(object.source || ''), missing: true });
      continue;
    }
    const filename = String(object.filename || '');
    if (!filename.startsWith('objects/') || seenFiles.has(filename)) throw new Error('Tenant backup contains an invalid or duplicate object filename.');
    seenFiles.add(filename);
    const bytes = readBackupFile(root, filename);
    verifyHashEntry(bytes, object.sha256, object.bytes, `Tenant object ${key}`);
    const contentType = String(object.contentType || 'application/octet-stream');
    if (contentType.length > 200 || /[\r\n\u0000]/.test(contentType) || !contentType.includes('/')) throw new Error(`Invalid tenant object content type: ${key}`);
    objectEntries.push({ bucket, objectKey, source: String(object.source || ''), filename, bytes: Number(object.bytes), sha256: object.sha256, contentType, missing: false });
  }
  const expected = collectStorageReferences(snapshot).map(row => `${row.bucket}/${row.objectKey}`);
  if (expected.length !== seenObjects.size || expected.some(key => !seenObjects.has(key))) throw new Error('Tenant backup object inventory does not match the snapshot references.');
  return {
    ok: true,
    companyId,
    snapshot,
    contentHash,
    authority: structuredClone(manifest.authority),
    createdAt: manifest.createdAt,
    objects: objectEntries.length,
    missingObjects: objectEntries.filter(object => object.missing).length,
    objectEntries,
    manifestSha256: checksumMatch[1]
  };
}

function readVerifiedTenantObjects(directory, verification = null, { allowMissing = false } = {}) {
  const verified = verification || verifyPortableBackup(directory);
  const missing = verified.objectEntries.filter(object => object.missing);
  if (missing.length && !allowMissing) throw new Error(`Tenant backup is incomplete: ${missing.length} referenced storage object${missing.length === 1 ? ' is' : 's are'} recorded as missing.`);
  return verified.objectEntries.map(object => {
    if (object.missing) return { ...object, data: null };
    const data = readBackupFile(path.resolve(directory), object.filename);
    verifyHashEntry(data, object.sha256, object.bytes, `Tenant object ${object.bucket}/${object.objectKey}`);
    return { ...object, data };
  });
}

async function main() {
  const root = path.resolve(__dirname, '..');
  supabase.loadLocalEnv(root);
  if (!supabase.configured()) throw new Error('Supabase configuration is missing.');
  const { companyId, output } = parseArgs();
  const { snapshot, authority } = await loadAuthoritativeTenantSnapshot(companyId);
  const result = await createPortableBackup({ snapshot, authority, destination: output });
  console.log(JSON.stringify({ directory: result.directory, companyId: result.manifest.companyId, authority: result.manifest.authority.mode, repositoryRevision: result.manifest.authority.repositoryRevision, objects: result.manifest.objects.length, snapshotSha256: result.manifest.snapshot.sha256, manifestSha256: result.manifestSha256, verified: result.verification.ok }, null, 2));
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });

module.exports = {
  FORMAT,
  parseArgs,
  collectStorageReferences,
  createPortableBackup,
  verifyPortableBackup,
  readVerifiedTenantObjects,
  loadAuthoritativeTenantSnapshot,
  isMissingStorageObjectError,
  digest
};
