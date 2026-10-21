'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { PLATFORM_NAMESPACE_ID, canonicalHash, requireRevision } = require('./platform-repository');
const { PLATFORM_ROLES } = require('../platform-capabilities');

const FORMAT = 'pdl-platform-portable-backup-v1';
const SNAPSHOT_SCHEMA = 'pdl-platform-snapshot-v1';
const SNAPSHOT_FILE = 'platform.json';
const MANIFEST_FILE = 'manifest.json';
const CHECKSUM_FILE = 'manifest.sha256';
const OBJECTS_DIRECTORY = 'objects';
const OBJECT_FILE_PATTERN = /^objects\/[0-9]{5}-[a-f0-9]{16}\.bin$/;
const NAMESPACE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BUCKET_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PLATFORM_USER_STATUSES = new Set(['Active', 'Inactive']);
const IDENTITY_ATTRIBUTE_MAX_LENGTH = 80;
const PLATFORM_COLLECTIONS = new Set([
  'users', 'notes', 'sessions', 'demoRequests', 'followUps',
  'growthOpportunities', 'helpItems', 'onboardingOrders', 'auditEvents',
  'supportGrants', 'supportTickets', 'tenantDeletionCleanupJobs', 'blogPosts'
]);
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function isMissingStorageObjectError(error) {
  const status = Number(error?.statusCode ?? error?.status);
  if (Number.isFinite(status)) return status === 404;
  return /(?:\b404\b|not[ -]?found|NoSuchKey|NoSuchObject)/i.test(String(error?.message || error || ''));
}

function requireNamespaceId(value) {
  const namespaceId = String(value || '').toLowerCase();
  if (!NAMESPACE_PATTERN.test(namespaceId)) throw new Error('Platform backup namespace must be a UUID.');
  return namespaceId;
}

function safeBucket(value) {
  const bucket = String(value || '');
  if (!BUCKET_PATTERN.test(bucket)) throw new Error('Platform storage bucket is invalid.');
  return bucket;
}

function safeObjectKey(value) {
  const key = String(value || '').replaceAll('\\', '/').replace(/^\/+/, '');
  if (!key || key.endsWith('/') || key.includes('../') || key.split('/').includes('..') || /[\u0000-\u001f\u007f]/.test(key)) {
    throw new Error('Platform storage object key is invalid.');
  }
  return key;
}

function collectPlatformStorageReferences(snapshot, namespaceId = PLATFORM_NAMESPACE_ID) {
  const expectedNamespace = requireNamespaceId(namespaceId);
  const references = new Map();
  const visit = (value, location = '$') => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${location}[${index}]`));
      return;
    }
    const bucketValue = value.storageBucket ?? value.bucket;
    const objectKeyValue = value.storageKey ?? value.objectKey;
    // `bucket` is also a legitimate analytics/domain field. Treat the legacy
    // pair as an asset only when objectKey is present; the storage-prefixed
    // fields are unambiguous and therefore fail even when only one is present.
    const storagePointerCandidate = Object.hasOwn(value, 'storageBucket') ||
      Object.hasOwn(value, 'storageKey') || Object.hasOwn(value, 'objectKey');
    const hasBucket = bucketValue !== undefined && bucketValue !== null && String(bucketValue) !== '';
    const hasObjectKey = objectKeyValue !== undefined && objectKeyValue !== null && String(objectKeyValue) !== '';
    if (storagePointerCandidate && (!hasBucket || !hasObjectKey)) throw new Error(`Incomplete platform storage reference at ${location}.`);
    if (storagePointerCandidate) {
      const bucket = safeBucket(bucketValue);
      const key = safeObjectKey(objectKeyValue);
      const namespacePrefix = `${expectedNamespace}/`;
      if (!key.startsWith(namespacePrefix) && !key.startsWith('platform/')) {
        throw new Error(`Cross-namespace platform storage reference at ${location}.`);
      }
      const reference = {
        bucket,
        objectKey: key,
        // Keep user-defined object/property names out of backup metadata. The
        // digest is only a stable troubleshooting reference; it is not used
        // as recovery authority.
        sourceRef: digest(Buffer.from(location)).slice(0, 24)
      };
      references.set(`${reference.bucket}/${reference.objectKey}`, reference);
    } else {
      const localReference = [value.url, value.dataUrl, value.downloadUrl]
        .map(item => String(item || '').replaceAll('\\', '/'))
        .find(item => /^(?:\/\/|\/?uploads\/|\/?api\/(?:files|local-files)\/|file:\/\/|[a-z]:\/)/i.test(item));
      if (localReference) {
        throw new Error(`Non-portable local platform storage reference at ${location}. Migrate it to private Storage before exporting.`);
      }
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

function requireBackupDirectory(directory) {
  const root = path.resolve(directory);
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Platform backup root must be a regular directory.');
  return root;
}

function writeExclusive(file, bytes) {
  fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 });
}

function readBackupFile(directory, relativePath) {
  const root = requireBackupDirectory(directory);
  const file = safeBackupFile(root, relativePath);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Backup entry is not a regular file: ${relativePath}`);
  const realRoot = fs.realpathSync(root);
  const realFile = fs.realpathSync(file);
  if (realFile !== realRoot && !realFile.startsWith(realRoot + path.sep)) {
    throw new Error(`Backup entry resolves outside its directory: ${relativePath}`);
  }
  return fs.readFileSync(file);
}

function jsonSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw new TypeError('Platform backup requires a JSON object snapshot.');
  }
  let encoded;
  try {
    encoded = JSON.stringify(snapshot);
  } catch {
    throw new TypeError('Platform backup snapshot must be JSON serializable.');
  }
  if (encoded === undefined) throw new TypeError('Platform backup snapshot must be JSON serializable.');
  const clean = JSON.parse(encoded);
  if (!clean || typeof clean !== 'object' || Array.isArray(clean)) {
    throw new TypeError('Platform backup requires a JSON object snapshot.');
  }
  return clean;
}

function recordIdentity(value, label) {
  if ((typeof value !== 'string' && typeof value !== 'number') || !String(value).trim()) {
    throw new Error(`${label} must have a non-empty scalar id.`);
  }
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new Error(`${label} has an invalid id.`);
  return String(value).trim();
}

function identityAttribute(value, label) {
  if (typeof value !== 'string') throw new Error(`${label} must be a string.`);
  const normalized = value.trim();
  if (!normalized || normalized.length > IDENTITY_ATTRIBUTE_MAX_LENGTH || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`${label} is invalid.`);
  }
  return normalized;
}

function validatePlatformSnapshot(snapshot, { activationSafe = false } = {}) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw new Error('Platform snapshot must be a JSON object.');
  }
  for (const [name, value] of Object.entries(snapshot)) {
    if (Array.isArray(value) && !PLATFORM_COLLECTIONS.has(name)) {
      throw new Error(`Platform snapshot contains an unsupported collection: ${name}.`);
    }
  }
  for (const name of PLATFORM_COLLECTIONS) {
    if (Object.hasOwn(snapshot, name) && !Array.isArray(snapshot[name])) {
      throw new Error(`Platform snapshot collection ${name} must be an array.`);
    }
    if (!Array.isArray(snapshot[name])) continue;
    const ids = new Set();
    snapshot[name].forEach((row, index) => {
      if (!row || typeof row !== 'object' || Array.isArray(row)) {
        throw new Error(`Platform snapshot collection ${name} contains an invalid record at index ${index}.`);
      }
      if (row.id == null) return;
      const id = recordIdentity(row.id, `Platform ${name} record ${index}`);
      if (ids.has(id)) throw new Error(`Platform snapshot collection ${name} contains duplicate id ${id}.`);
      ids.add(id);
    });
  }
  if (!Array.isArray(snapshot.users) || snapshot.users.length === 0) {
    throw new Error('Platform snapshot must contain at least one user.');
  }
  const emails = new Set();
  for (const [index, user] of snapshot.users.entries()) {
    recordIdentity(user.id, `Platform user ${index}`);
    const email = String(user.email || '').trim().toLowerCase();
    if (!EMAIL_PATTERN.test(email)) throw new Error(`Platform user ${index} has an invalid email.`);
    if (emails.has(email)) throw new Error(`Platform snapshot contains duplicate user email ${email}.`);
    emails.add(email);
    const role = identityAttribute(user.role, `Platform user ${index} role`);
    const status = identityAttribute(user.status, `Platform user ${index} status`);
    if (activationSafe && !PLATFORM_USER_STATUSES.has(status)) {
      throw new Error(`Platform user ${index} has an unsupported status for restore.`);
    }
    if (activationSafe && status === 'Active' && !PLATFORM_ROLES.includes(role)) {
      throw new Error(`Platform user ${index} has an unsupported role for an active restored identity.`);
    }
  }
  if (!snapshot.users.some(user => user.role === 'platform_owner' && user.status === 'Active')) {
    throw new Error('Platform snapshot must retain at least one active platform_owner.');
  }
  return snapshot;
}

function validatePlatformRestoreSnapshot(snapshot) {
  return validatePlatformSnapshot(snapshot, { activationSafe: true });
}

async function createPlatformPortableBackup({
  snapshot,
  revision,
  destination,
  namespaceId = PLATFORM_NAMESPACE_ID,
  download = null,
  allowMissingObjects = false,
  beforeComplete = null,
  now = new Date()
}) {
  const cleanSnapshot = validatePlatformSnapshot(jsonSnapshot(snapshot));
  const sourceRevision = requireRevision(revision, 'source revision');
  if (!destination) throw new Error('Platform backup requires an independent destination directory.');
  const normalizedNamespace = requireNamespaceId(namespaceId);
  const references = collectPlatformStorageReferences(cleanSnapshot, normalizedNamespace);
  if (references.length && typeof download !== 'function') {
    throw new Error('Platform snapshot references private storage, but no server-side downloader was provided.');
  }
  if (beforeComplete !== null && typeof beforeComplete !== 'function') {
    throw new TypeError('Platform backup beforeComplete hook must be a function.');
  }
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const prefix = `platform-${stamp}-r${sourceRevision}`;
  let directory = null;
  let createdDirectory = false;
  fs.mkdirSync(path.resolve(destination), { recursive: true, mode: 0o700 });
  const destinationRoot = requireBackupDirectory(path.resolve(destination));
  for (let attempt = 0; attempt < 10 && !createdDirectory; attempt += 1) {
    const suffix = crypto.randomBytes(6).toString('hex');
    const candidate = path.resolve(destinationRoot, `${prefix}-${suffix}`);
    try {
      fs.mkdirSync(candidate, { recursive: false, mode: 0o700 });
      directory = candidate;
      createdDirectory = true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  if (!createdDirectory) throw new Error('Could not allocate a unique platform backup directory.');
  try {
    // The checksum sidecar is written last and acts as the completeness marker.
    // A failed export removes only the directory allocated by this invocation.
    fs.mkdirSync(path.join(directory, OBJECTS_DIRECTORY), { recursive: false, mode: 0o700 });
    const snapshotBytes = Buffer.from(JSON.stringify(cleanSnapshot, null, 2));
    writeExclusive(path.join(directory, SNAPSHOT_FILE), snapshotBytes);

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
      if (!response || typeof response.arrayBuffer !== 'function') {
        throw new Error(`Private platform object ${index + 1} returned an invalid download response.`);
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
      namespaceId: normalizedNamespace,
      sourceRevision,
      platform: {
        schema: SNAPSHOT_SCHEMA,
        filename: SNAPSHOT_FILE,
        bytes: snapshotBytes.length,
        sha256: digest(snapshotBytes),
        canonicalSha256: canonicalHash(cleanSnapshot)
      },
      objects
    };
    const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2));
    writeExclusive(path.join(directory, MANIFEST_FILE), manifestBytes);
    const manifestSha256 = digest(manifestBytes);
    // The checksum sidecar is the sole completeness marker. Authoritative
    // callers can prove the captured source stayed stable while this set is
    // still intentionally unverifiable. A failed proof removes the directory
    // in the catch below; only a successful proof permits finalization.
    if (beforeComplete) {
      await beforeComplete({
        directory,
        manifest: structuredClone(manifest),
        manifestSha256
      });
    }
    writeExclusive(path.join(directory, CHECKSUM_FILE), Buffer.from(`${manifestSha256}  ${MANIFEST_FILE}\n`));
    const verified = verifyPlatformPortableBackup(directory, { namespaceId: normalizedNamespace });
    return { directory, manifest, manifestSha256, verifiedAt: now.toISOString(), verification: verified };
  } catch (error) {
    if (createdDirectory) fs.rmSync(directory, { recursive: true, force: true });
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
  const root = requireBackupDirectory(directory);
  const expectedNamespace = requireNamespaceId(namespaceId);
  const manifestBytes = readBackupFile(root, MANIFEST_FILE);
  const checksum = readBackupFile(root, CHECKSUM_FILE).toString('utf8');
  const checksumMatch = /^([a-f0-9]{64}) {2}manifest\.json\n$/.exec(checksum);
  if (!checksumMatch || checksumMatch[1] !== digest(manifestBytes)) throw new Error('Platform backup manifest SHA-256 verification failed.');
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  if (manifest.format !== FORMAT) throw new Error(`Unsupported platform backup format: ${manifest.format || '(missing)'}`);
  if (!Number.isFinite(Date.parse(String(manifest.createdAt || ''))) || new Date(manifest.createdAt).toISOString() !== manifest.createdAt) {
    throw new Error('Platform backup creation time is missing or invalid.');
  }
  if (requireNamespaceId(manifest.namespaceId) !== expectedNamespace) throw new Error('Platform backup namespace does not match this installation.');
  requireRevision(manifest.sourceRevision, 'backup source revision');
  if (manifest.platform?.schema !== SNAPSHOT_SCHEMA) throw new Error(`Unsupported platform snapshot schema: ${manifest.platform?.schema || '(missing)'}`);
  if (manifest.platform?.filename !== SNAPSHOT_FILE) throw new Error('Platform backup snapshot filename is invalid.');
  if (!Array.isArray(manifest.objects)) throw new Error('Platform backup object inventory is invalid.');

  const platformBytes = readBackupFile(root, manifest.platform?.filename);
  verifyHashEntry(platformBytes, manifest.platform?.sha256, manifest.platform?.bytes, 'Platform snapshot');
  const snapshot = JSON.parse(platformBytes.toString('utf8'));
  if (canonicalHash(snapshot) !== manifest.platform?.canonicalSha256) throw new Error('Platform snapshot canonical SHA-256 verification failed.');
  validatePlatformSnapshot(snapshot);

  const seenObjects = new Set();
  const seenFiles = new Set();
  const objectEntries = [];
  for (const object of manifest.objects || []) {
    const bucket = safeBucket(object.bucket);
    const objectKey = safeObjectKey(object.objectKey);
    if (!objectKey.startsWith(`${expectedNamespace}/`) && !objectKey.startsWith('platform/')) {
      throw new Error('Platform backup contains a cross-namespace object.');
    }
    const key = `${bucket}/${objectKey}`;
    if (seenObjects.has(key)) throw new Error(`Duplicate platform backup object: ${key}`);
    seenObjects.add(key);
    if (object.missing === true) {
      if (object.filename != null || object.sha256 != null || object.bytes != null) {
        throw new Error(`Missing platform object contains payload metadata: ${key}`);
      }
      const sourceRef = String(object.sourceRef || '');
      if (sourceRef && !/^[a-f0-9]{24}$/.test(sourceRef)) throw new Error(`Invalid platform object source reference: ${key}`);
      objectEntries.push({ bucket, objectKey, sourceRef, missing: true });
      continue;
    }
    const filename = String(object.filename || '');
    if (!OBJECT_FILE_PATTERN.test(filename) || seenFiles.has(filename)) throw new Error(`Invalid or duplicate platform backup filename: ${filename || '(blank)'}`);
    seenFiles.add(filename);
    const bytes = readBackupFile(root, filename);
    verifyHashEntry(bytes, object.sha256, object.bytes, `Platform object ${key}`);
    if (!filename.endsWith(`-${object.sha256.slice(0, 16)}.bin`)) throw new Error(`Platform object filename digest does not match: ${key}`);
    const contentType = String(object.contentType || 'application/octet-stream');
    if (contentType.length > 200 || /[\r\n\u0000]/.test(contentType) || !contentType.includes('/')) {
      throw new Error(`Invalid platform object content type: ${key}`);
    }
    const sourceRef = String(object.sourceRef || '');
    if (sourceRef && !/^[a-f0-9]{24}$/.test(sourceRef)) throw new Error(`Invalid platform object source reference: ${key}`);
    objectEntries.push({
      bucket,
      objectKey,
      sourceRef,
      filename,
      bytes: Number(object.bytes),
      sha256: object.sha256,
      contentType,
      missing: false
    });
  }
  const expectedReferences = collectPlatformStorageReferences(snapshot, expectedNamespace).map(row => `${row.bucket}/${row.objectKey}`);
  if (expectedReferences.length !== seenObjects.size || expectedReferences.some(key => !seenObjects.has(key))) {
    throw new Error('Platform backup object inventory does not match the snapshot references.');
  }

  const objectDirectory = safeBackupFile(root, OBJECTS_DIRECTORY);
  const objectDirectoryStat = fs.lstatSync(objectDirectory);
  if (!objectDirectoryStat.isDirectory() || objectDirectoryStat.isSymbolicLink()) {
    throw new Error('Platform backup objects entry must be a regular directory.');
  }
  const actualObjectFiles = fs.readdirSync(objectDirectory, { withFileTypes: true });
  if (actualObjectFiles.some(entry => !entry.isFile() || entry.isSymbolicLink())) {
    throw new Error('Platform backup objects directory contains an invalid entry.');
  }
  const actualObjectNames = new Set(actualObjectFiles.map(entry => `${OBJECTS_DIRECTORY}/${entry.name}`));
  if (actualObjectNames.size !== seenFiles.size || [...actualObjectNames].some(filename => !seenFiles.has(filename))) {
    throw new Error('Platform backup objects directory does not exactly match its manifest.');
  }

  return {
    ok: true,
    namespaceId: expectedNamespace,
    createdAt: manifest.createdAt,
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
  const verified = verifyPlatformPortableBackup(directory, {
    namespaceId: verification?.namespaceId || PLATFORM_NAMESPACE_ID
  });
  if (verification && verified.manifestSha256 !== verification.manifestSha256) {
    throw new Error('Platform backup changed after its initial verification.');
  }
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
  SNAPSHOT_SCHEMA,
  SNAPSHOT_FILE,
  MANIFEST_FILE,
  CHECKSUM_FILE,
  digest,
  isMissingStorageObjectError,
  requireNamespaceId,
  safeBucket,
  safeObjectKey,
  validatePlatformSnapshot,
  validatePlatformRestoreSnapshot,
  collectPlatformStorageReferences,
  createPlatformPortableBackup,
  verifyPlatformPortableBackup,
  readVerifiedPlatformObjects
};
