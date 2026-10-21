'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { PLATFORM_NAMESPACE_ID, canonicalHash, requireRevision } = require('./platform-repository');

const FORMAT = 'pdl-platform-portable-backup-v1';
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function isMissingStorageObjectError(error) {
  return /(?:\b404\b|not[ -]?found|NoSuchKey|NoSuchObject)/i.test(String(error?.message || error || ''));
}

function safeObjectKey(value) {
  const key = String(value || '').replaceAll('\\', '/').replace(/^\/+/, '');
  if (!key || key.includes('../') || key.split('/').includes('..')) throw new Error(`Unsafe platform storage object key: ${key || '(blank)'}`);
  return key;
}

function collectPlatformStorageReferences(snapshot, namespaceId = PLATFORM_NAMESPACE_ID) {
  const references = new Map();
  const visit = (value, location = '$') => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${location}[${index}]`));
      return;
    }
    const bucket = value.storageBucket ?? value.bucket;
    const objectKey = value.storageKey ?? value.objectKey;
    if (bucket && objectKey) {
      const key = safeObjectKey(objectKey);
      const namespacePrefix = `${namespaceId}/`;
      if (!key.startsWith(namespacePrefix) && !key.startsWith('platform/')) {
        throw new Error(`Cross-namespace platform storage reference at ${location}: ${key}`);
      }
      const reference = { bucket: String(bucket), objectKey: key, source: location };
      references.set(`${reference.bucket}/${reference.objectKey}`, reference);
    }
    for (const [key, item] of Object.entries(value)) visit(item, `${location}.${key}`);
  };
  visit(snapshot);
  return [...references.values()].sort((a, b) => `${a.bucket}/${a.objectKey}`.localeCompare(`${b.bucket}/${b.objectKey}`));
}

function safeBackupFile(directory, relativePath) {
  const root = path.resolve(directory);
  const target = path.resolve(root, String(relativePath || ''));
  if (target !== root && !target.startsWith(root + path.sep)) throw new Error(`Backup path escapes its directory: ${relativePath}`);
  return target;
}

function writeExclusive(file, bytes) {
  fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 });
}

function readBackupFile(directory, relativePath) {
  const file = safeBackupFile(directory, relativePath);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Backup entry is not a regular file: ${relativePath}`);
  const realRoot = fs.realpathSync(path.resolve(directory));
  const realFile = fs.realpathSync(file);
  if (realFile !== realRoot && !realFile.startsWith(realRoot + path.sep)) {
    throw new Error(`Backup entry resolves outside its directory: ${relativePath}`);
  }
  return fs.readFileSync(file);
}

async function createPlatformPortableBackup({
  snapshot,
  revision,
  destination,
  namespaceId = PLATFORM_NAMESPACE_ID,
  download = null,
  allowMissingObjects = false,
  now = new Date()
}) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) throw new TypeError('Platform backup requires a JSON object snapshot.');
  const sourceRevision = requireRevision(revision, 'source revision');
  if (!destination) throw new Error('Platform backup requires an independent destination directory.');
  const references = collectPlatformStorageReferences(snapshot, namespaceId);
  if (references.length && typeof download !== 'function') {
    throw new Error('Platform snapshot references private storage, but no server-side downloader was provided.');
  }
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const prefix = `platform-${stamp}-r${sourceRevision}`;
  let directory=null,createdDirectory=false;
  fs.mkdirSync(path.resolve(destination), { recursive: true, mode: 0o700 });
  for(let attempt=0;attempt<10&&!createdDirectory;attempt++){
    const suffix=crypto.randomBytes(6).toString('hex');
    const candidate=path.resolve(destination,`${prefix}-${suffix}`);
    try{
      fs.mkdirSync(candidate,{recursive:false,mode:0o700});
      directory=candidate;createdDirectory=true;
    }catch(error){if(error.code!=='EEXIST')throw error}
  }
  if(!createdDirectory)throw new Error('Could not allocate a unique platform backup directory.');
  try {
    // The checksum sidecar is written last and acts as the completeness marker.
    // A failed export removes only the directory allocated by this invocation.
    fs.mkdirSync(path.join(directory, 'objects'), { recursive: false, mode: 0o700 });
    const snapshotBytes = Buffer.from(JSON.stringify(snapshot, null, 2));
    writeExclusive(path.join(directory, 'platform.json'), snapshotBytes);

    const objects = [];
    for (const [index, reference] of references.entries()) {
      let response;
      try {
        response = await download(reference.bucket, reference.objectKey);
      } catch (error) {
        if (!allowMissingObjects || !isMissingStorageObjectError(error)) throw error;
        objects.push({ ...reference, missing: true });
        continue;
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      const sha256 = digest(bytes);
      const filename = `objects/${String(index + 1).padStart(5, '0')}-${sha256.slice(0, 16)}.bin`;
      writeExclusive(safeBackupFile(directory, filename), bytes);
      objects.push({
        ...reference,
        filename,
        bytes: bytes.length,
        sha256,
        contentType: response.headers?.get?.('content-type') || 'application/octet-stream'
      });
    }

    const manifest = {
      format: FORMAT,
      createdAt: now.toISOString(),
      namespaceId,
      sourceRevision,
      platform: {
        filename: 'platform.json',
        bytes: snapshotBytes.length,
        sha256: digest(snapshotBytes),
        canonicalSha256: canonicalHash(snapshot)
      },
      objects
    };
    const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2));
    writeExclusive(path.join(directory, 'manifest.json'), manifestBytes);
    const manifestSha256 = digest(manifestBytes);
    writeExclusive(path.join(directory, 'manifest.sha256'), Buffer.from(`${manifestSha256}  manifest.json\n`));
    const verified = verifyPlatformPortableBackup(directory, { namespaceId });
    return { directory, manifest, manifestSha256, verifiedAt: now.toISOString(), verification: verified };
  } catch (error) {
    if(createdDirectory)fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

function verifyHashEntry(bytes, expectedHash, expectedBytes, label) {
  if (!/^[a-f0-9]{64}$/.test(String(expectedHash || ''))) throw new Error(`${label} has an invalid SHA-256 digest.`);
  if (!Number.isSafeInteger(Number(expectedBytes)) || Number(expectedBytes) < 0) throw new Error(`${label} has an invalid byte count.`);
  if (bytes.length !== Number(expectedBytes)) throw new Error(`${label} byte count does not match its manifest.`);
  const actual = digest(bytes);
  if (actual !== expectedHash) throw new Error(`${label} SHA-256 does not match its manifest.`);
  return actual;
}

function verifyPlatformPortableBackup(directory, { namespaceId = PLATFORM_NAMESPACE_ID } = {}) {
  const root = path.resolve(directory);
  const manifestBytes = readBackupFile(root, 'manifest.json');
  const checksum = readBackupFile(root, 'manifest.sha256').toString('utf8').trim();
  const checksumMatch = /^([a-f0-9]{64})\s{2}manifest\.json$/.exec(checksum);
  if (!checksumMatch || checksumMatch[1] !== digest(manifestBytes)) throw new Error('Platform backup manifest SHA-256 verification failed.');
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  if (manifest.format !== FORMAT) throw new Error(`Unsupported platform backup format: ${manifest.format || '(missing)'}`);
  if (manifest.namespaceId !== namespaceId) throw new Error('Platform backup namespace does not match this installation.');
  requireRevision(manifest.sourceRevision, 'backup source revision');

  const platformBytes = readBackupFile(root, manifest.platform?.filename);
  verifyHashEntry(platformBytes, manifest.platform?.sha256, manifest.platform?.bytes, 'Platform snapshot');
  const snapshot = JSON.parse(platformBytes.toString('utf8'));
  if (canonicalHash(snapshot) !== manifest.platform?.canonicalSha256) throw new Error('Platform snapshot canonical SHA-256 verification failed.');

  const seenObjects = new Set();
  const seenFiles = new Set();
  const objectEntries = [];
  for (const object of manifest.objects || []) {
    const bucket = String(object.bucket || '');
    if (!bucket || /[\\/\u0000-\u001f\u007f]/.test(bucket)) throw new Error(`Invalid platform backup bucket: ${bucket || '(blank)'}`);
    const objectKey = safeObjectKey(object.objectKey);
    const key = `${bucket}/${objectKey}`;
    if (seenObjects.has(key)) throw new Error(`Duplicate platform backup object: ${key}`);
    seenObjects.add(key);
    if (object.missing === true) {
      if (object.filename != null || object.sha256 != null || object.bytes != null) {
        throw new Error(`Missing platform object contains payload metadata: ${key}`);
      }
      objectEntries.push({ bucket, objectKey, source: String(object.source || ''), missing: true });
      continue;
    }
    const filename = String(object.filename || '');
    if (!filename.startsWith('objects/') || seenFiles.has(filename)) throw new Error(`Invalid or duplicate platform backup filename: ${filename || '(blank)'}`);
    seenFiles.add(filename);
    const bytes = readBackupFile(root, filename);
    verifyHashEntry(bytes, object.sha256, object.bytes, `Platform object ${key}`);
    const contentType = String(object.contentType || 'application/octet-stream');
    if (contentType.length > 200 || /[\r\n\u0000]/.test(contentType) || !contentType.includes('/')) {
      throw new Error(`Invalid platform object content type: ${key}`);
    }
    objectEntries.push({
      bucket,
      objectKey,
      source: String(object.source || ''),
      filename,
      bytes: Number(object.bytes),
      sha256: object.sha256,
      contentType,
      missing: false
    });
  }
  const expectedReferences = collectPlatformStorageReferences(snapshot, namespaceId).map(row => `${row.bucket}/${row.objectKey}`);
  if (expectedReferences.length !== seenObjects.size || expectedReferences.some(key => !seenObjects.has(key))) {
    throw new Error('Platform backup object inventory does not match the snapshot references.');
  }

  return {
    ok: true,
    namespaceId,
    sourceRevision: Number(manifest.sourceRevision),
    contentHash: manifest.platform.canonicalSha256,
    manifestSha256: checksumMatch[1],
    snapshot,
    objects: objectEntries.length,
    missingObjects: objectEntries.filter(object => object.missing).length,
    objectEntries
  };
}

function readVerifiedPlatformObjects(directory, verification = null, { allowMissing = false } = {}) {
  const verified = verification || verifyPlatformPortableBackup(directory);
  const missing = verified.objectEntries.filter(object => object.missing);
  if (missing.length && !allowMissing) {
    throw new Error(`Platform backup is incomplete: ${missing.length} referenced storage object${missing.length === 1 ? ' is' : 's are'} recorded as missing.`);
  }
  return verified.objectEntries.map(object => {
    if (object.missing) return { ...object, data: null };
    const data = readBackupFile(path.resolve(directory), object.filename);
    // Recheck at point of use instead of relying on an earlier verification;
    // this closes a local time-of-check/time-of-use window during recovery.
    verifyHashEntry(data, object.sha256, object.bytes, `Platform object ${object.bucket}/${object.objectKey}`);
    return { ...object, data };
  });
}

module.exports = {
  FORMAT,
  digest,
  isMissingStorageObjectError,
  safeObjectKey,
  collectPlatformStorageReferences,
  createPlatformPortableBackup,
  verifyPlatformPortableBackup,
  readVerifiedPlatformObjects
};
