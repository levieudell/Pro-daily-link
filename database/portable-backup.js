'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const supabase = require('./supabase');
const { canonicalHash, databaseCompanyId } = require('./transactional-repository');

const FORMAT = 'pdl-portable-backup-v1';
const SNAPSHOT_SCHEMA = 'pdl-tenant-snapshot-v1';
const SNAPSHOT_FILE = 'snapshot.json';
const MANIFEST_FILE = 'manifest.json';
const CHECKSUM_FILE = 'manifest.sha256';
const OBJECTS_DIRECTORY = 'objects';
const OBJECT_FILE_PATTERN = /^objects\/[0-9]{5}-[a-f0-9]{16}\.bin$/;
const BUCKET_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TENANT_USER_ROLES = new Set(['owner', 'admin', 'project_manager', 'foreman', 'field', 'office']);
const TENANT_USER_STATUSES = new Set(['Active', 'Deactivated', 'Inactive']);
const TENANT_SCOPED_ROLES = new Set(['project_manager', 'foreman', 'field']);
const TENANT_SCOPE_FIELDS = Object.freeze([
  'memberId', 'projectIds', 'assignedCrews', 'permissions', 'crew', 'crewId',
  'crewIds', 'assignedCrewIds', 'allowedProjectIds'
]);
const IDENTITY_ATTRIBUTE_MAX_LENGTH = 80;
const TENANT_COLLECTIONS = new Set([
  'users', 'sessions', 'customers', 'projects', 'team', 'crews', 'catalog',
  'subcontractors', 'subcontractorLinks', 'reports', 'assignments', 'photos',
  'workdays', 'timeCards', 'timeOffRequests', 'changes', 'dailyTemplates',
  'estimateImports', 'projectPlans', 'projectTickets', 'projectEvents',
  'projectMessages', 'projectTasks', 'reportingExports', 'auditLog',
  'payPeriods', 'payPeriodExports', 'projectNotesTodos', 'assistantConfirmations',
  'companyActivityCodes'
]);
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function transactionalMode() {
  const mode = String(process.env.PDL_TRANSACTIONAL_DB || 'off').toLowerCase();
  return ['shadow', 'primary'].includes(mode) ? mode : 'off';
}

function isMissingStorageObjectError(error) {
  const status = Number(error?.statusCode ?? error?.status);
  if (Number.isFinite(status)) return status === 404;
  return /(?:\b404\b|not[ -]?found|NoSuchKey|NoSuchObject)/i.test(String(error?.message || error || ''));
}

function safeBucket(value) {
  const bucket = String(value || '');
  if (!BUCKET_PATTERN.test(bucket)) throw new Error('Tenant storage bucket is invalid.');
  return bucket;
}

function safeObjectKey(value, companyId) {
  const key = String(value || '');
  const segments = key.split('/');
  if (!key || key.startsWith('/') || key.endsWith('/') || key.includes('\\') || key.includes('//') || segments.includes('.') || segments.includes('..') || /[\u0000-\u001f\u007f]/.test(key) || !key.startsWith(`${companyId}/`)) {
    throw new Error('Tenant storage object key is invalid or cross-tenant.');
  }
  return key;
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
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Tenant backup root must be a regular directory.');
  return root;
}

function readBackupFile(directory, relativePath) {
  const root = requireBackupDirectory(directory);
  const file = safeBackupFile(root, relativePath);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Backup entry is not a regular file: ${relativePath}`);
  const realRoot = fs.realpathSync(root);
  const realFile = fs.realpathSync(file);
  if (realFile !== realRoot && !realFile.startsWith(realRoot + path.sep)) throw new Error(`Backup entry resolves outside its directory: ${relativePath}`);
  return fs.readFileSync(file);
}

function writeExclusive(file, bytes) {
  fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 });
}

function jsonSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw new TypeError('Tenant backup requires a JSON object snapshot.');
  }
  let encoded;
  try {
    encoded = JSON.stringify(snapshot);
  } catch {
    throw new TypeError('Tenant backup snapshot must be JSON serializable.');
  }
  if (encoded === undefined) throw new TypeError('Tenant backup snapshot must be JSON serializable.');
  return JSON.parse(encoded);
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

function validateTenantSnapshot(snapshot, { activationSafe = false } = {}) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw new Error('Tenant snapshot must be a JSON object.');
  }
  if (!snapshot.company || typeof snapshot.company !== 'object' || Array.isArray(snapshot.company)) {
    throw new Error('Tenant snapshot must contain a company object.');
  }
  recordIdentity(snapshot.company.id, 'Tenant company');
  if (!String(snapshot.company.name || '').trim()) throw new Error('Tenant company must have a name.');
  for (const [name, value] of Object.entries(snapshot)) {
    if (Array.isArray(value) && !TENANT_COLLECTIONS.has(name)) {
      throw new Error(`Tenant snapshot contains an unsupported collection: ${name}.`);
    }
  }
  for (const name of TENANT_COLLECTIONS) {
    if (Object.hasOwn(snapshot, name) && !Array.isArray(snapshot[name])) {
      throw new Error(`Tenant snapshot collection ${name} must be an array.`);
    }
    if (!Array.isArray(snapshot[name])) continue;
    const ids = new Set();
    snapshot[name].forEach((row, index) => {
      if (!row || typeof row !== 'object' || Array.isArray(row)) {
        throw new Error(`Tenant snapshot collection ${name} contains an invalid record at index ${index}.`);
      }
      if (row.id == null) return;
      const id = recordIdentity(row.id, `Tenant ${name} record ${index}`);
      if (ids.has(id)) throw new Error(`Tenant snapshot collection ${name} contains duplicate id ${id}.`);
      ids.add(id);
    });
  }
  if (!Array.isArray(snapshot.users) || snapshot.users.length === 0) {
    throw new Error('Tenant snapshot must contain at least one user.');
  }
  const emails = new Set();
  for (const [index, user] of snapshot.users.entries()) {
    recordIdentity(user.id, `Tenant user ${index}`);
    const email = String(user.email || '').trim().toLowerCase();
    if (!EMAIL_PATTERN.test(email)) throw new Error(`Tenant user ${index} has an invalid email.`);
    if (emails.has(email)) throw new Error(`Tenant snapshot contains duplicate user email ${email}.`);
    emails.add(email);
    const role = identityAttribute(user.role, `Tenant user ${index} role`);
    const status = identityAttribute(user.status, `Tenant user ${index} status`);
    // Portable backups are evidence, not an authorization decision. Preserve
    // bounded historical role/status values so a quarantined legacy row cannot
    // make its tenant impossible to back up. Restore validation is deliberately
    // stricter: only known statuses survive the merge, and an Active identity
    // must have a role the application actually authorizes.
    if (activationSafe && !TENANT_USER_STATUSES.has(status)) {
      throw new Error(`Tenant user ${index} has an unsupported status for restore.`);
    }
    if (activationSafe && status === 'Active' && !TENANT_USER_ROLES.has(role)) {
      throw new Error(`Tenant user ${index} has an unsupported role for an active restored identity.`);
    }
  }
  if (!snapshot.users.some(user => user.role === 'owner' && user.status === 'Active')) {
    throw new Error('Tenant snapshot must retain at least one active owner.');
  }
  return snapshot;
}

function validateTenantRestoreSnapshot(snapshot) {
  return validateTenantSnapshot(snapshot, { activationSafe: true });
}

function scopeValuePresent(value) {
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === 'object') return Object.keys(value).length > 0;
  return value !== undefined && value !== null && value !== '';
}

function validateTenantFinalRestoreSnapshot(snapshot) {
  validateTenantRestoreSnapshot(snapshot);
  for (const [index, user] of snapshot.users.entries()) {
    if (!TENANT_SCOPED_ROLES.has(user.role)) continue;
    // Project/team/crew identifiers in a recovery source are historical
    // record keys, not durable authorization identities. Until a future
    // reconciliation protocol proves stable target identities, no scoped
    // account may leave restore active or retain scope that could be revived.
    if (user.status === 'Active') {
      throw new Error(`Tenant user ${index} has active scoped access without recovery identity reconciliation.`);
    }
    const retained = TENANT_SCOPE_FIELDS.filter(field => scopeValuePresent(user[field]));
    if (retained.length) {
      throw new Error(`Tenant user ${index} retains unreconciled historical authorization scope.`);
    }
  }
  return snapshot;
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

function assertLegacyDirectExportAuthority(authority) {
  if (authority?.mode === 'transactional-primary') {
    throw new Error('Transactional-primary exports require the target-bound tenant-recovery export command and a verified maintenance fence.');
  }
  return authority;
}

function assertLegacyDirectExportMode(mode = transactionalMode()) {
  if (String(mode || '').toLowerCase() === 'primary') {
    const error = new Error('Transactional-primary exports require the target-bound tenant-recovery export command and a verified maintenance fence.');
    error.code = 'PDL_TENANT_BACKUP_PRIMARY_REQUIRES_RECOVERY';
    throw error;
  }
  return mode;
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

function privateStorageReferenceFromRoute(value, companyId, source) {
  const route = String(value || '');
  if (!route.startsWith('/api/files')) return null;
  const match = /^\/api\/files\/([^/]+)\/(.+)$/.exec(route);
  if (!match || route !== route.trim() || /[?#]/.test(route)) {
    throw new Error(`Private storage route in ${source} is invalid.`);
  }
  let objectKey;
  try {
    objectKey = match[2].split('/').map(decodeURIComponent).join('/');
  } catch {
    throw new Error(`Private storage route in ${source} has invalid encoding.`);
  }
  return {
    // The live route matches the bucket segment before decoding it. Preserve
    // that behavior so encoded bucket aliases cannot become backup authority.
    bucket: safeBucket(match[1]),
    objectKey: safeObjectKey(objectKey, companyId),
    source
  };
}

function storageReferenceKind(value) {
  const raw = String(value || '');
  if (!raw) return null;
  const trimmed = raw.trim();
  const normalized = trimmed.replaceAll('\\', '/');
  if (/^(?:\/\/|\/?uploads(?:\/|$)|\/?api\/(?:files|local-files)(?:\/|$)|file:\/\/|[a-z]:\/)/i.test(normalized)) return 'local';
  if (/^data:/i.test(normalized)) {
    return raw === trimmed && /^data:[^,\r\n]*,/i.test(trimmed) ? null : 'external';
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(normalized)) return 'external';
  return null;
}

function collectStorageReferences(snapshot) {
  const companyId = databaseCompanyId(snapshot?.company?.id);
  const references = new Map();
  const add = (asset, source) => {
    if (!asset || typeof asset !== 'object') return;
    const bucket = asset.storageBucket ?? asset.bucket;
    const objectKey = asset.storageKey ?? asset.objectKey;
    const urlValues = [asset.url, asset.dataUrl, asset.downloadUrl].filter(value => value != null && String(value) !== '');
    const routes = [];
    for (const value of urlValues) {
      const reference = privateStorageReferenceFromRoute(value, companyId, source);
      if (reference) routes.push(reference);
      else {
        const kind = storageReferenceKind(value);
        if (kind) throw new Error(`Non-portable ${kind} storage reference in ${source}. Migrate this object to private Storage before exporting.`);
      }
    }
    if (!bucket && !objectKey) {
      if (!routes.length) return;
      const [reference] = routes;
      if (routes.some(candidate => candidate.bucket !== reference.bucket || candidate.objectKey !== reference.objectKey)) {
        throw new Error(`Conflicting private storage routes in ${source}.`);
      }
      references.set(`${reference.bucket}/${reference.objectKey}`, reference);
      return;
    }
    if (!bucket || !objectKey) throw new Error(`Incomplete private storage reference in ${source}.`);
    const key = safeObjectKey(objectKey, companyId);
    const reference = { bucket: safeBucket(bucket), objectKey: key, source };
    if (routes.some(candidate => candidate.bucket !== reference.bucket || candidate.objectKey !== reference.objectKey)) {
      throw new Error(`Conflicting private storage routes in ${source}.`);
    }
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
  allowMissingObjects = false,
  beforeComplete = null
}) {
  const cleanSnapshot = validateTenantSnapshot(jsonSnapshot(snapshot));
  const companyId = databaseCompanyId(cleanSnapshot.company.id);
  if (!destination) throw new Error('Tenant backup requires an independent destination directory.');
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const snapshotCanonicalHash = canonicalHash(cleanSnapshot);
  if (authority?.contentHash && authority.contentHash !== snapshotCanonicalHash) throw new Error('Backup authority hash does not match the tenant snapshot.');
  fs.mkdirSync(path.resolve(destination), { recursive: true, mode: 0o700 });
  const destinationRoot = requireBackupDirectory(path.resolve(destination));
  let directory = null, createdDirectory = false;
  for (let attempt = 0; attempt < 10 && !createdDirectory; attempt += 1) {
    const candidate = path.resolve(destinationRoot, `${companyId}-${stamp}-${crypto.randomBytes(6).toString('hex')}`);
    try { fs.mkdirSync(candidate, { recursive: false, mode: 0o700 }); directory = candidate; createdDirectory = true; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  if (!createdDirectory) throw new Error('Could not allocate a unique tenant backup directory.');
  try {
    fs.mkdirSync(path.join(directory, OBJECTS_DIRECTORY), { recursive: false, mode: 0o700 });
    const snapshotBytes = Buffer.from(JSON.stringify(cleanSnapshot, null, 2));
    writeExclusive(path.join(directory, SNAPSHOT_FILE), snapshotBytes);
    const objects = [];
    for (const [index, reference] of collectStorageReferences(cleanSnapshot).entries()) {
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
      const filename = `${OBJECTS_DIRECTORY}/${String(index + 1).padStart(5, '0')}-${hash.slice(0, 16)}.bin`;
      writeExclusive(safeBackupFile(directory, filename), bytes);
      objects.push({ ...reference, filename, bytes: bytes.length, sha256: hash, contentType: response.headers?.get?.('content-type') || 'application/octet-stream' });
    }
    const manifest = {
      format: FORMAT,
      createdAt: now.toISOString(),
      companyId,
      companyName: cleanSnapshot.company.name,
      revision: Number(cleanSnapshot.company?.persistence?.revision || 0),
      authority: authority || { mode: 'provided-snapshot', repositoryRevision: null, contentHash: snapshotCanonicalHash },
      snapshot: { schema: SNAPSHOT_SCHEMA, filename: SNAPSHOT_FILE, bytes: snapshotBytes.length, sha256: digest(snapshotBytes), canonicalSha256: snapshotCanonicalHash },
      objects
    };
    const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2));
    writeExclusive(path.join(directory, MANIFEST_FILE), manifestBytes);
    const manifestSha256 = digest(manifestBytes);
    // The checksum sidecar is the recovery set's completeness marker. A
    // caller that must prove a stable live source (for example a production
    // export under a maintenance fence) performs that final proof before the
    // marker can exist. Interruption or rejection leaves no accepted set.
    if (beforeComplete != null) {
      if (typeof beforeComplete !== 'function') throw new TypeError('Tenant backup beforeComplete hook must be a function.');
      await beforeComplete({ directory, manifest: structuredClone(manifest), manifestSha256 });
    }
    writeExclusive(path.join(directory, CHECKSUM_FILE), Buffer.from(`${manifestSha256}  ${MANIFEST_FILE}\n`));
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
  const root = requireBackupDirectory(directory);
  const manifestBytes = readBackupFile(root, MANIFEST_FILE);
  const checksum = readBackupFile(root, CHECKSUM_FILE).toString('utf8');
  const checksumMatch = /^([a-f0-9]{64}) {2}manifest\.json\n$/.exec(checksum);
  if (!checksumMatch || checksumMatch[1] !== digest(manifestBytes)) throw new Error('Tenant backup manifest SHA-256 verification failed.');
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  if (manifest.format !== FORMAT) throw new Error('Unsupported tenant backup format.');
  if (!Number.isFinite(Date.parse(String(manifest.createdAt || ''))) || new Date(manifest.createdAt).toISOString() !== manifest.createdAt) throw new Error('Tenant backup creation time is missing or invalid.');
  const companyId = databaseCompanyId(manifest.companyId);
  if (expectedCompanyId && companyId !== databaseCompanyId(expectedCompanyId)) throw new Error('Tenant backup company does not match the requested company.');
  if (manifest.snapshot?.schema !== SNAPSHOT_SCHEMA) throw new Error(`Unsupported tenant snapshot schema: ${manifest.snapshot?.schema || '(missing)'}`);
  if (manifest.snapshot?.filename !== SNAPSHOT_FILE) throw new Error('Tenant backup snapshot filename is invalid.');
  if (!Array.isArray(manifest.objects)) throw new Error('Tenant backup object inventory is invalid.');
  const snapshotBytes = readBackupFile(root, manifest.snapshot?.filename);
  verifyHashEntry(snapshotBytes, manifest.snapshot?.sha256, manifest.snapshot?.bytes, 'Tenant snapshot');
  const snapshot = JSON.parse(snapshotBytes.toString('utf8'));
  validateTenantSnapshot(snapshot);
  const contentHash = canonicalHash(snapshot);
  if (databaseCompanyId(snapshot.company?.id) !== companyId || contentHash !== manifest.snapshot?.canonicalSha256) throw new Error('Tenant snapshot identity or canonical SHA-256 verification failed.');
  const authorityMode = String(manifest.authority?.mode || '');
  if (!['transactional-primary', 'legacy-snapshot', 'provided-snapshot', 'pre-restore-uninitialized'].includes(authorityMode)) throw new Error('Tenant backup authority is missing or unsupported.');
  if (manifest.authority?.contentHash !== contentHash) throw new Error('Tenant backup authority hash verification failed.');
  if (authorityMode === 'transactional-primary' && !Number.isSafeInteger(Number(manifest.authority?.repositoryRevision))) throw new Error('Tenant backup transactional authority revision is invalid.');
  const seenObjects = new Set(), seenFiles = new Set(), objectEntries = [];
  for (const object of manifest.objects || []) {
    const bucket = safeBucket(object.bucket);
    const objectKey = safeObjectKey(object.objectKey, companyId);
    const key = `${bucket}/${objectKey}`;
    if (seenObjects.has(key)) throw new Error(`Duplicate tenant backup object: ${key}`);
    seenObjects.add(key);
    if (object.missing === true) {
      if (object.filename != null || object.sha256 != null || object.bytes != null) throw new Error(`Missing tenant object contains payload metadata: ${key}`);
      objectEntries.push({ bucket, objectKey, source: String(object.source || ''), missing: true });
      continue;
    }
    const filename = String(object.filename || '');
    if (!OBJECT_FILE_PATTERN.test(filename) || seenFiles.has(filename)) throw new Error('Tenant backup contains an invalid or duplicate object filename.');
    seenFiles.add(filename);
    const bytes = readBackupFile(root, filename);
    verifyHashEntry(bytes, object.sha256, object.bytes, `Tenant object ${key}`);
    if (!filename.endsWith(`-${object.sha256.slice(0, 16)}.bin`)) throw new Error(`Tenant object filename digest does not match: ${key}`);
    const contentType = String(object.contentType || 'application/octet-stream');
    if (contentType.length > 200 || /[\r\n\u0000]/.test(contentType) || !contentType.includes('/')) throw new Error(`Invalid tenant object content type: ${key}`);
    objectEntries.push({ bucket, objectKey, source: String(object.source || ''), filename, bytes: Number(object.bytes), sha256: object.sha256, contentType, missing: false });
  }
  const expected = collectStorageReferences(snapshot).map(row => `${row.bucket}/${row.objectKey}`);
  if (expected.length !== seenObjects.size || expected.some(key => !seenObjects.has(key))) throw new Error('Tenant backup object inventory does not match the snapshot references.');
  const objectDirectory = safeBackupFile(root, OBJECTS_DIRECTORY);
  const objectDirectoryStat = fs.lstatSync(objectDirectory);
  if (!objectDirectoryStat.isDirectory() || objectDirectoryStat.isSymbolicLink()) throw new Error('Tenant backup objects entry must be a regular directory.');
  const actualObjectFiles = fs.readdirSync(objectDirectory, { withFileTypes: true });
  if (actualObjectFiles.some(entry => !entry.isFile() || entry.isSymbolicLink())) throw new Error('Tenant backup objects directory contains an invalid entry.');
  const actualObjectNames = new Set(actualObjectFiles.map(entry => `${OBJECTS_DIRECTORY}/${entry.name}`));
  if (actualObjectNames.size !== seenFiles.size || [...actualObjectNames].some(filename => !seenFiles.has(filename))) throw new Error('Tenant backup objects directory does not exactly match its manifest.');
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
  const verified = verifyPortableBackup(directory, { expectedCompanyId: verification?.companyId || null });
  if (verification && verified.manifestSha256 !== verification.manifestSha256) throw new Error('Tenant backup changed after its initial verification.');
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
  const { companyId, output } = parseArgs();
  // This command exists only for the legacy/shadow pre-cutover capture. Fail
  // before provider or destination I/O in primary mode; the recovery command
  // is the only supported path because it binds the target and proves the
  // maintenance fence and live source immediately before finalization.
  assertLegacyDirectExportMode();
  if (!supabase.configured()) throw new Error('Supabase configuration is missing.');
  const { snapshot, authority } = await loadAuthoritativeTenantSnapshot(companyId);
  assertLegacyDirectExportAuthority(authority);
  const result = await createPortableBackup({ snapshot, authority, destination: output });
  console.log(JSON.stringify(sanitizedCliResult(result), null, 2));
}

function sanitizedCliResult(result) {
  return {
    ok: true,
    backupSet: path.basename(result.directory),
    companyId: result.manifest.companyId,
    authority: result.manifest.authority.mode,
    repositoryRevision: result.manifest.authority.repositoryRevision,
    contentHash: result.manifest.authority.contentHash,
    objects: result.manifest.objects.length,
    snapshotSha256: result.manifest.snapshot.sha256,
    manifestSha256: result.manifestSha256,
    verified: result.verification.ok === true
  };
}

function sanitizedCliFailure(error) {
  const message = String(error?.message || error || '');
  let code = 'PDL_TENANT_BACKUP_FAILED';
  if (error?.code === 'PDL_TENANT_BACKUP_PRIMARY_REQUIRES_RECOVERY' || /Transactional-primary exports require/i.test(message)) {
    code = 'PDL_TENANT_BACKUP_PRIMARY_REQUIRES_RECOVERY';
  }
  else if (/single synthetic|requires|destination|argument/i.test(message)) code = 'PDL_TENANT_BACKUP_USAGE';
  else if (/manifest|SHA-256|canonical|inventory|byte count|snapshot|invalid|unsafe|cross-tenant|non-portable|regular directory|changed after/i.test(message)) code = 'PDL_TENANT_BACKUP_INTEGRITY';
  else if (/Supabase configuration|not found|transactional/i.test(message)) code = 'PDL_TENANT_BACKUP_CONFIGURATION';
  return {
    ok: false,
    code,
    message: code === 'PDL_TENANT_BACKUP_PRIMARY_REQUIRES_RECOVERY'
      ? 'Primary tenant exports must use the target-bound, maintenance-fenced tenant recovery command.'
      : code === 'PDL_TENANT_BACKUP_USAGE'
      ? 'The tenant backup command arguments are invalid. Review the documented command and retry.'
      : 'Tenant backup did not complete. No tenant data, object keys, provider details, or filesystem paths were printed.'
  };
}

if (require.main === module) main().catch(error => { console.error(JSON.stringify(sanitizedCliFailure(error))); process.exitCode = 1; });

module.exports = {
  FORMAT,
  SNAPSHOT_SCHEMA,
  SNAPSHOT_FILE,
  MANIFEST_FILE,
  CHECKSUM_FILE,
  parseArgs,
  assertLegacyDirectExportAuthority,
  assertLegacyDirectExportMode,
  validateTenantSnapshot,
  validateTenantRestoreSnapshot,
  validateTenantFinalRestoreSnapshot,
  collectStorageReferences,
  createPortableBackup,
  verifyPortableBackup,
  readVerifiedTenantObjects,
  loadAuthoritativeTenantSnapshot,
  isMissingStorageObjectError,
  digest,
  sanitizedCliResult,
  sanitizedCliFailure
};
