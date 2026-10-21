'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');

const CONFIRMATION_PHRASE = 'DELETE ONLY SYNTHETIC ACCEPTANCE TENANTS';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const GUARDED_TABLES = Object.freeze([
  'companies',
  'tenant_revisions',
  'tenant_records',
  'audit_events',
  'guest_links',
  'changes',
  'photos',
  'reports',
  'workdays',
  'assignments',
  'projects',
  'customers',
  'team_members',
  'subcontractors',
  'memberships'
]);
const GUARDED_EVENTS = Object.freeze(['INSERT', 'UPDATE', 'DELETE']);
const REQUIRED_MIGRATION_TRIGGER_EVENTS = Object.freeze([
  'private.tenant_active_user_emails:keep_conflicted_tenant_email_quarantined:INSERT',
  'private.tenant_active_user_emails:keep_conflicted_tenant_email_quarantined:UPDATE',
  'private.tenant_active_user_emails:keep_archived_tenant_email_unowned:INSERT',
  'private.tenant_active_user_emails:keep_archived_tenant_email_unowned:UPDATE',
  'public.tenant_revisions:ensure_tenant_company_parent:INSERT',
  'public.tenant_revisions:ensure_tenant_company_parent:UPDATE',
  'public.tenant_records:sync_tenant_public_link_token:INSERT',
  'public.tenant_records:sync_tenant_public_link_token:UPDATE',
  'public.tenant_records:sync_tenant_public_link_token:DELETE',
  'public.tenant_revisions:sync_tenant_public_link_token_revision:UPDATE'
]);
const PRIVATE_ACCEPTANCE_TABLES = Object.freeze([
  'tenant_directory',
  'tenant_active_user_emails',
  'tenant_email_conflicts',
  'tenant_tombstones',
  'tenant_deletion_operations',
  'tenant_deletion_finalizers',
  'tenant_public_link_tokens'
]);
const RECOVERY_LOCK_TABLES = Object.freeze([
  ...GUARDED_TABLES.map(table => `public.${table}`),
  'public.users',
  ...PRIVATE_ACCEPTANCE_TABLES.map(table => `private.${table}`),
  'private.platform_state',
  'private.platform_records',
  'private.platform_revision_log'
]);

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function valueFor(argv, name) {
  const prefix = `--${name}=`;
  const match = argv.find(value => String(value).startsWith(prefix));
  return match ? String(match).slice(prefix.length) : '';
}

function parseArgs(argv = process.argv.slice(2)) {
  const allowedExact = new Set(['--help', '--fingerprint', '--preview', '--apply']);
  const allowedValues = ['--expected-fingerprint=', '--confirm-disposable=', '--evidence=', '--cleanup-evidence=', '--manifest-sha256='];
  const unknown = argv.filter(value => !allowedExact.has(String(value)) && !allowedValues.some(prefix => String(value).startsWith(prefix)));
  if (unknown.length) throw new Error('Unknown option. Only documented flags are accepted; database URLs must remain in the environment.');
  for (const prefix of allowedValues) {
    if (argv.filter(value => String(value).startsWith(prefix)).length > 1) {
      throw new Error(`Option ${prefix.slice(0, -1)} may be provided only once.`);
    }
  }
  if (argv.includes('--help')) {
    if (argv.length !== 1) throw new Error('--help cannot be combined with another option.');
    return { mode: 'help' };
  }
  const modes = ['fingerprint', 'preview', 'apply'].filter(mode => argv.includes(`--${mode}`));
  if (argv.some(value => String(value).startsWith('--cleanup-evidence='))) modes.push('cleanup');
  if (modes.length !== 1) throw new Error('Choose exactly one mode: --fingerprint, --preview, --apply, or --cleanup-evidence.');
  const mode = modes[0];
  const hasValueOption = name => argv.some(value => String(value).startsWith(`--${name}=`));
  const args = {
    mode,
    expectedFingerprint: valueFor(argv, 'expected-fingerprint').toLowerCase(),
    confirmation: valueFor(argv, 'confirm-disposable'),
    evidencePath: valueFor(argv, 'evidence'),
    cleanupEvidencePath: valueFor(argv, 'cleanup-evidence'),
    manifestSha256: valueFor(argv, 'manifest-sha256').toLowerCase()
  };
  if (['fingerprint', 'preview'].includes(mode) &&
      ['expected-fingerprint', 'confirm-disposable', 'evidence', 'cleanup-evidence', 'manifest-sha256'].some(hasValueOption)) {
    throw new Error(`--${mode} does not accept destructive-mode options.`);
  }
  if (mode === 'apply') {
    if (args.confirmation !== CONFIRMATION_PHRASE) {
      throw new Error(`Apply requires --confirm-disposable="${CONFIRMATION_PHRASE}".`);
    }
    if (!/^[a-f0-9]{64}$/.test(args.expectedFingerprint)) {
      throw new Error('Apply requires --expected-fingerprint=<64-character SHA-256 from --fingerprint>.');
    }
    if (!args.evidencePath || !path.isAbsolute(args.evidencePath)) {
      throw new Error('Apply requires --evidence=<absolute path to a new JSON evidence file>.');
    }
    if (hasValueOption('cleanup-evidence') || hasValueOption('manifest-sha256')) {
      throw new Error('--apply cannot be combined with cleanup recovery options.');
    }
  }
  if (mode === 'cleanup') {
    if (args.confirmation !== CONFIRMATION_PHRASE) {
      throw new Error(`Cleanup requires --confirm-disposable="${CONFIRMATION_PHRASE}".`);
    }
    if (!/^[a-f0-9]{64}$/.test(args.expectedFingerprint)) {
      throw new Error('Cleanup requires --expected-fingerprint=<64-character server fingerprint>.');
    }
    if (!args.cleanupEvidencePath || !path.isAbsolute(args.cleanupEvidencePath)) {
      throw new Error('Cleanup requires --cleanup-evidence=<absolute path to an acceptance evidence file>.');
    }
    if (!/^[a-f0-9]{64}$/.test(args.manifestSha256)) {
      throw new Error('Cleanup requires --manifest-sha256=<independently retained SHA-256 printed by the original run>.');
    }
    if (hasValueOption('evidence')) throw new Error('--cleanup-evidence cannot be combined with --evidence.');
  }
  return args;
}

function parseDatabaseUrl(databaseUrl) {
  let parsed;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error('DATABASE_URL must be a valid PostgreSQL connection URL.');
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error('DATABASE_URL must use postgres:// or postgresql://.');
  }
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (!parsed.hostname || !database || !parsed.username) {
    throw new Error('DATABASE_URL must include a host, database, and database user.');
  }
  return parsed;
}

function serverFingerprint({ systemIdentifier, databaseOid, databaseName }) {
  const system = String(systemIdentifier || '').trim();
  const oid = String(databaseOid || '').trim();
  const name = String(databaseName || '').trim();
  if (!/^\d+$/.test(system) || !/^\d+$/.test(oid) || !name) {
    throw new Error('The connected PostgreSQL server did not expose a stable cluster and database identity.');
  }
  return sha256(['postgres-server', system, oid, name].join('|'));
}

function isLoopback(hostname) {
  return ['127.0.0.1', '::1', 'localhost'].includes(String(hostname || '').toLowerCase());
}

function safeError(error) {
  return {
    name: String(error?.name || 'Error').slice(0, 80),
    code: error?.code ? String(error.code).slice(0, 20) : null,
    message: String(error?.message || error || 'Unknown failure').replace(/postgres(?:ql)?:\/\/[^\s]+/gi, '[database-url-redacted]').slice(0, 500)
  };
}

function evidenceText(evidence) {
  return `${JSON.stringify(evidence, null, 2)}\n`;
}

function resultEvidencePath(manifestPath, label = 'result') {
  return `${manifestPath}.${label}.json`;
}

function writeEvidenceFile(filePath, evidence, { create = false } = {}) {
  if (!create) throw new Error('Evidence files are append-only artifacts and may not be overwritten.');
  const text = evidenceText(evidence);
  const descriptor = fs.openSync(filePath, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, text, { encoding: 'utf8' });
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  if (process.platform !== 'win32') {
    const directoryDescriptor = fs.openSync(path.dirname(filePath), fs.constants.O_RDONLY);
    try {
      fs.fsyncSync(directoryDescriptor);
    } finally {
      fs.closeSync(directoryDescriptor);
    }
  }
}

function recoveryTenantDescriptor(tenant) {
  return {
    scenario: tenant.scenario,
    companyId: tenant.companyId,
    deletionRequestId: tenant.deletionRequestId,
    userId: tenant.ids.user
  };
}

function validateRecoveryEvidence(evidence) {
  if (evidence?.kind !== 'pdl-deletion-concurrency-acceptance' || evidence?.schemaVersion !== 2) {
    throw new Error('Cleanup evidence is not a supported PDL deletion acceptance recovery manifest.');
  }
  if (!UUID_PATTERN.test(String(evidence.runId || '')) || !Array.isArray(evidence.syntheticTenants) ||
      evidence.syntheticTenants.length !== 4) {
    throw new Error('Cleanup evidence does not contain a valid synthetic acceptance run.');
  }
  if (!/^[a-f0-9]{64}$/.test(String(evidence.target?.fingerprint || '').toLowerCase())) {
    throw new Error('Cleanup evidence does not contain a valid target server fingerprint.');
  }
  const seen = new Set();
  const seenScenarios = new Set();
  const requiredScenarios = new Set(['future-hold', 'legal-hold', 'wrong-status', 'primary']);
  for (const tenant of evidence.syntheticTenants) {
    for (const field of ['companyId', 'deletionRequestId', 'userId']) {
      if (!UUID_PATTERN.test(String(tenant?.[field] || ''))) {
        throw new Error(`Cleanup evidence contains an invalid synthetic tenant ${field}.`);
      }
    }
    if (!requiredScenarios.has(tenant.scenario) || seenScenarios.has(tenant.scenario)) {
      throw new Error('Cleanup evidence contains an invalid or repeated synthetic scenario.');
    }
    if (seen.has(tenant.companyId)) throw new Error('Cleanup evidence repeats a synthetic tenant ID.');
    seen.add(tenant.companyId);
    seenScenarios.add(tenant.scenario);
  }
  if (seenScenarios.size !== requiredScenarios.size) {
    throw new Error('Cleanup evidence does not contain the complete synthetic scenario set.');
  }
  return evidence;
}

function readRecoveryEvidenceFile(filePath, expectedSha256 = '') {
  const before = fs.lstatSync(filePath, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.size > 1024n * 1024n) {
    throw new Error('Cleanup evidence must be a regular JSON file no larger than 1 MiB.');
  }
  const noFollow = Number.isInteger(fs.constants.O_NOFOLLOW) ? fs.constants.O_NOFOLLOW : 0;
  const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
  let buffer;
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    const after = fs.lstatSync(filePath, { bigint: true });
    if (!opened.isFile() || after.isSymbolicLink() || !after.isFile() || opened.size > 1024n * 1024n ||
        opened.dev !== before.dev || opened.ino !== before.ino ||
        after.dev !== opened.dev || after.ino !== opened.ino) {
      throw new Error('Cleanup evidence changed while it was being opened; no database action was taken.');
    }
    buffer = fs.readFileSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  const actualSha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  if (expectedSha256 && actualSha256 !== String(expectedSha256).toLowerCase()) {
    throw new Error('Refusing recovery cleanup: the manifest does not match the independently retained SHA-256.');
  }
  let evidence;
  try {
    evidence = JSON.parse(buffer.toString('utf8'));
  } catch {
    throw new Error('Cleanup evidence is not valid JSON.');
  }
  return { evidence: validateRecoveryEvidence(evidence), sha256: actualSha256 };
}

function readRecoveryEvidence(filePath) {
  return readRecoveryEvidenceFile(filePath).evidence;
}

function assertManifestHash(filePath, expectedSha256) {
  if (!/^[a-f0-9]{64}$/.test(String(expectedSha256 || '').toLowerCase())) {
    throw new Error('Refusing recovery cleanup: the manifest does not match the independently retained SHA-256.');
  }
  return readRecoveryEvidenceFile(filePath, expectedSha256).sha256;
}

function assertApplySafety({ args, env, databaseUrl, identity, inventory }) {
  if (!['apply', 'cleanup'].includes(args.mode)) return;
  if (env.PDL_DELETION_ACCEPTANCE_DISPOSABLE !== '1') {
    throw new Error('Refusing writes: set PDL_DELETION_ACCEPTANCE_DISPOSABLE=1 only for an isolated disposable database.');
  }
  const actualFingerprint = String(identity.fingerprint || '').toLowerCase();
  if (actualFingerprint !== args.expectedFingerprint) {
    throw new Error('Refusing writes: the connected database does not match --expected-fingerprint.');
  }
  const parsed = parseDatabaseUrl(databaseUrl);
  const productionFingerprint = String(env.PDL_PRODUCTION_DATABASE_FINGERPRINT || '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(productionFingerprint)) {
    throw new Error('Refusing writes: set PDL_PRODUCTION_DATABASE_FINGERPRINT to the server-derived production database fingerprint.');
  }
  if (productionFingerprint === actualFingerprint) {
    throw new Error('Refusing writes: the target fingerprint matches production.');
  }
  if (!isLoopback(parsed.hostname)) {
    const sslMode = String(parsed.searchParams.get('sslmode') || '').toLowerCase();
    if (!['require', 'verify-ca', 'verify-full'].includes(sslMode)) {
      throw new Error('Refusing remote writes: DATABASE_URL must require TLS with sslmode=require, verify-ca, or verify-full.');
    }
  }
  if (inventory.privilegedVisibility !== true) {
    throw new Error('Refusing writes: the database role must be a migration owner with superuser or BYPASSRLS visibility.');
  }
  if (!inventory.schemaReady) {
    throw new Error('Refusing writes: required migrations through 015 are not installed and verified.');
  }
  if (args.mode === 'apply') {
    if (inventory.companyCount !== 0) {
      throw new Error(`Refusing writes: disposable acceptance database must start with zero companies; found ${inventory.companyCount}.`);
    }
    if (inventory.deletionOperationCount !== 0 || inventory.deletionFinalizerCount !== 0 || inventory.tombstoneCount !== 0) {
      throw new Error('Refusing writes: disposable acceptance database already contains deletion operations, finalizer markers, or tombstones.');
    }
    const unrelatedRows = Number(inventory.userCount || 0) + Number(inventory.emailConflictCount || 0) +
      Number(inventory.directoryCount || 0) + Number(inventory.activeEmailCount || 0) +
      Number(inventory.publicLinkTokenCount || 0) +
      Number(inventory.platformStateCount || 0) + Number(inventory.platformRecordCount || 0) +
      Number(inventory.platformRevisionLogCount || 0);
    if (unrelatedRows !== 0) {
      throw new Error('Refusing writes: disposable acceptance database must not contain users, tenant directories, credentials, identity conflicts, or platform repository rows.');
    }
    const parent = path.dirname(args.evidencePath);
    if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) {
      throw new Error('Evidence parent directory must already exist.');
    }
    if (fs.existsSync(args.evidencePath)) {
      throw new Error('Evidence path already exists; choose a new file so prior evidence cannot be overwritten.');
    }
    if (fs.existsSync(resultEvidencePath(args.evidencePath))) {
      throw new Error('Evidence result path already exists; choose a new evidence basename.');
    }
  }
}

function createPool(databaseUrl) {
  return new Pool({
    connectionString: databaseUrl,
    max: 8,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 20_000,
    query_timeout: 25_000,
    application_name: 'pdl-deletion-concurrency-acceptance'
  });
}

async function inspectServerIdentity(pool, databaseUrl) {
  const info = await pool.query(`
    SELECT current_database() AS database_name,
           current_user AS database_role,
           current_setting('server_version_num') AS server_version_num,
           COALESCE((SELECT rolsuper OR rolbypassrls FROM pg_catalog.pg_roles WHERE rolname=current_user),false) AS privileged_visibility,
           control.system_identifier::text AS system_identifier,
           (SELECT oid::text FROM pg_catalog.pg_database WHERE datname=current_database()) AS database_oid
    FROM pg_catalog.pg_control_system() AS control
  `);
  const parsed = parseDatabaseUrl(databaseUrl);
  const row = info.rows[0];
  return {
    host: parsed.hostname,
    port: parsed.port || '5432',
    database: row.database_name,
    databaseRole: row.database_role,
    serverVersionNum: row.server_version_num,
    systemIdentifier: row.system_identifier,
    databaseOid: row.database_oid,
    privilegedVisibility: row.privileged_visibility === true,
    identitySource: 'pg_control_system+pg_database',
    fingerprint: serverFingerprint({
      systemIdentifier: row.system_identifier,
      databaseOid: row.database_oid,
      databaseName: row.database_name
    })
  };
}

async function inspectDatabase(pool, databaseUrl) {
  const serverIdentity = await inspectServerIdentity(pool, databaseUrl);
  const triggerResult = await pool.query(`
    SELECT event.event_object_table,event.event_manipulation,trigger.tgenabled
    FROM information_schema.triggers AS event
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.nspname=event.event_object_schema
    JOIN pg_catalog.pg_class AS relation
      ON relation.relnamespace=namespace.oid AND relation.relname=event.event_object_table
    JOIN pg_catalog.pg_trigger AS trigger
      ON trigger.tgrelid=relation.oid AND trigger.tgname=event.trigger_name AND NOT trigger.tgisinternal
    WHERE event.event_object_schema = 'public'
      AND event.trigger_name = 'guard_tenant_lifecycle_write'
  `);
  const triggerCoverage = new Map(GUARDED_TABLES.map(table => [table, new Set()]));
  for (const row of triggerResult.rows) {
    if (triggerCoverage.has(row.event_object_table)) triggerCoverage.get(row.event_object_table).add(row.event_manipulation);
  }
  const missingTriggers = [];
  for (const table of GUARDED_TABLES) {
    for (const event of GUARDED_EVENTS) {
      if (!triggerCoverage.get(table).has(event)) missingTriggers.push(`${table}:${event}`);
    }
  }
  const disabledTriggers = [...new Set(triggerResult.rows
    .filter(row => !['O', 'A'].includes(row.tgenabled))
    .map(row => `public.${row.event_object_table}:guard_tenant_lifecycle_write:${row.tgenabled}`))];
  const migrationTriggerResult = await pool.query(`
    SELECT event.event_object_schema,event.event_object_table,event.trigger_name,event.event_manipulation,trigger.tgenabled
    FROM information_schema.triggers AS event
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.nspname=event.event_object_schema
    JOIN pg_catalog.pg_class AS relation
      ON relation.relnamespace=namespace.oid AND relation.relname=event.event_object_table
    JOIN pg_catalog.pg_trigger AS trigger
      ON trigger.tgrelid=relation.oid AND trigger.tgname=event.trigger_name AND NOT trigger.tgisinternal
    WHERE event.trigger_name IN (
      'keep_conflicted_tenant_email_quarantined',
      'keep_archived_tenant_email_unowned',
      'ensure_tenant_company_parent',
      'sync_tenant_public_link_token',
      'sync_tenant_public_link_token_revision'
    )
  `);
  const migrationTriggerEvents = new Set(migrationTriggerResult.rows.map(row =>
    `${row.event_object_schema}.${row.event_object_table}:${row.trigger_name}:${row.event_manipulation}`
  ));
  const missingMigrationTriggers = REQUIRED_MIGRATION_TRIGGER_EVENTS.filter(key => !migrationTriggerEvents.has(key));
  const disabledMigrationTriggers = [...new Set(migrationTriggerResult.rows
    .filter(row => !['O', 'A'].includes(row.tgenabled))
    .map(row => `${row.event_object_schema}.${row.event_object_table}:${row.trigger_name}:${row.tgenabled}`))];
  const objects = await pool.query(`
    SELECT
      to_regclass('public.companies') IS NOT NULL AS companies,
      to_regclass('public.users') IS NOT NULL AS users,
      to_regclass('public.tenant_revisions') IS NOT NULL AS tenant_revisions,
      to_regclass('public.tenant_records') IS NOT NULL AS tenant_records,
      to_regclass('private.tenant_directory') IS NOT NULL AS tenant_directory,
      to_regclass('private.tenant_active_user_emails') IS NOT NULL AS tenant_active_user_emails,
      to_regclass('private.tenant_tombstones') IS NOT NULL AS tenant_tombstones,
      to_regclass('private.tenant_deletion_operations') IS NOT NULL AS tenant_deletion_operations,
      to_regclass('private.tenant_deletion_finalizers') IS NOT NULL AS tenant_deletion_finalizers,
      to_regclass('private.tenant_public_link_tokens') IS NOT NULL AS tenant_public_link_tokens,
      to_regclass('private.tenant_email_conflicts') IS NOT NULL AS tenant_email_conflicts,
      to_regclass('private.tenant_active_user_email_owner_unique') IS NOT NULL AS tenant_email_owner_unique,
      to_regclass('private.platform_state') IS NOT NULL AS platform_state,
      to_regclass('private.platform_records') IS NOT NULL AS platform_records,
      to_regclass('private.platform_revision_log') IS NOT NULL AS platform_revision_log,
      to_regprocedure('public.begin_tenant_repository_purge(uuid,bigint,uuid)') IS NOT NULL AS begin_purge,
      to_regprocedure('public.tenant_repository_deletion_status(uuid)') IS NOT NULL AS deletion_status,
      to_regprocedure('public.purge_tenant_repository(uuid,bigint,uuid)') IS NOT NULL AS purge,
      to_regprocedure('public.load_tenant_repository(uuid)') IS NOT NULL AS load_tenant_repository,
      to_regprocedure('public.list_tenant_directory_page(uuid,integer)') IS NOT NULL AS list_tenant_directory,
      to_regprocedure('public.find_tenant_company_by_public_token(text,text)') IS NOT NULL AS find_public_token
  `);
  const objectState = objects.rows[0];
  const requiredObjectsReady = Object.values(objectState).every(Boolean);
  const functionPolicyResult = await pool.query(`
    WITH required(signature,service_execute) AS (VALUES
      ('public.begin_tenant_repository_purge(uuid,bigint,uuid)',true),
      ('public.tenant_repository_deletion_status(uuid)',true),
      ('public.purge_tenant_repository(uuid,bigint,uuid)',true),
      ('private.guard_tenant_lifecycle_write()',false)
    ), roles AS (
      SELECT
        (SELECT oid FROM pg_catalog.pg_roles WHERE rolname='anon') AS anon_oid,
        (SELECT oid FROM pg_catalog.pg_roles WHERE rolname='authenticated') AS authenticated_oid,
        (SELECT oid FROM pg_catalog.pg_roles WHERE rolname='service_role') AS service_oid
    )
    SELECT required.signature,
           proc.prosecdef AS security_definer,
           owner_role.rolname AS owner_name,
           COALESCE(owner_role.rolsuper OR owner_role.rolbypassrls,false) AS owner_trusted,
           COALESCE(owner_role.rolname IN ('anon','authenticated','service_role'),false) AS runtime_owner,
           COALESCE(
             'search_path='=ANY(proc.proconfig) OR 'search_path=""'=ANY(proc.proconfig),
             false
           ) AS empty_search_path,
           EXISTS(
             SELECT 1 FROM pg_catalog.aclexplode(COALESCE(proc.proacl,pg_catalog.acldefault('f',proc.proowner))) acl
             WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE'
           ) AS public_execute,
           COALESCE(pg_catalog.has_function_privilege(roles.anon_oid,proc.oid,'EXECUTE'),false) AS anon_execute,
           COALESCE(pg_catalog.has_function_privilege(roles.authenticated_oid,proc.oid,'EXECUTE'),false) AS authenticated_execute,
           COALESCE(pg_catalog.has_function_privilege(roles.service_oid,proc.oid,'EXECUTE'),false) AS service_execute,
           EXISTS(
             SELECT 1
             FROM pg_catalog.aclexplode(COALESCE(proc.proacl,pg_catalog.acldefault('f',proc.proowner))) acl
             WHERE acl.grantee=roles.service_oid
               AND acl.privilege_type='EXECUTE'
           ) AS service_direct_execute,
           EXISTS(
             SELECT 1
             FROM pg_catalog.aclexplode(COALESCE(proc.proacl,pg_catalog.acldefault('f',proc.proowner))) acl
             WHERE acl.grantee=roles.service_oid
               AND acl.privilege_type='EXECUTE'
               AND acl.is_grantable
           ) AS service_grantable_execute,
           EXISTS(
             SELECT 1
             FROM pg_catalog.aclexplode(COALESCE(proc.proacl,pg_catalog.acldefault('f',proc.proowner))) acl
             WHERE acl.privilege_type='EXECUTE'
               AND acl.grantee<>proc.proowner
               AND acl.grantee<>0
               AND NOT (required.service_execute AND acl.grantee=roles.service_oid)
           ) AS unexpected_explicit_execute,
           EXISTS(
             SELECT 1
             FROM pg_catalog.pg_roles AS candidate
             WHERE candidate.oid<>proc.proowner
               AND NOT (required.service_execute AND candidate.oid=roles.service_oid)
               AND (
                 candidate.rolname IN ('anon','authenticated','service_role') OR
                 NOT (candidate.rolsuper OR candidate.rolbypassrls)
               )
               AND pg_catalog.has_function_privilege(candidate.oid,proc.oid,'EXECUTE')
           ) AS unexpected_effective_execute,
           COALESCE(pg_catalog.has_schema_privilege(roles.service_oid,'public','USAGE'),false) AS service_public_schema_usage,
           required.service_execute AS expected_service_execute
    FROM required
    CROSS JOIN roles
    LEFT JOIN pg_catalog.pg_proc AS proc ON proc.oid=pg_catalog.to_regprocedure(required.signature)
    LEFT JOIN pg_catalog.pg_roles AS owner_role ON owner_role.oid=proc.proowner
  `);
  const functionPolicyViolations = functionPolicyResult.rows.filter(row =>
    row.security_definer !== true || row.empty_search_path !== true || row.public_execute === true ||
    row.anon_execute === true || row.authenticated_execute === true ||
    row.service_execute !== row.expected_service_execute ||
    row.service_direct_execute !== row.expected_service_execute ||
    row.service_grantable_execute === true || row.unexpected_explicit_execute === true ||
    row.unexpected_effective_execute === true || row.owner_trusted !== true || row.runtime_owner === true
  ).map(row => row.signature);
  const servicePublicSchemaUsage = functionPolicyResult.rows.every(row => row.service_public_schema_usage === true);
  const serviceRoleExecutionResult = await pool.query(`
    WITH service AS (
      SELECT oid FROM pg_catalog.pg_roles WHERE rolname='service_role'
    ), caller AS (
      SELECT oid,rolsuper FROM pg_catalog.pg_roles WHERE rolname=current_user
    )
    SELECT COALESCE((SELECT rolsuper FROM caller),false) OR
           COALESCE(pg_catalog.pg_has_role((SELECT oid FROM caller),(SELECT oid FROM service),'MEMBER'),false) AS allowed
  `);
  const canSetServiceRole = serviceRoleExecutionResult.rows[0]?.allowed === true;
  const finalizerOwnerAccessResult = await pool.query(`
    WITH required(signature,needs_select,needs_finalize) AS (VALUES
      ('private.guard_tenant_lifecycle_write()',true,false),
      ('public.purge_tenant_repository(uuid,bigint,uuid)',true,true)
    )
    SELECT required.signature,
           COALESCE(pg_catalog.has_schema_privilege(proc.proowner,'private','USAGE'),false) AS private_schema_usage,
           CASE WHEN required.needs_select THEN COALESCE(pg_catalog.has_table_privilege(
             proc.proowner,
             pg_catalog.to_regclass('private.tenant_deletion_finalizers'),
             'SELECT'
           ),false) ELSE true END AS select_allowed,
           CASE WHEN required.signature='private.guard_tenant_lifecycle_write()' THEN COALESCE(pg_catalog.has_table_privilege(
             proc.proowner,
             pg_catalog.to_regclass('private.tenant_tombstones'),
             'SELECT'
           ),false) ELSE true END AS tombstone_select_allowed,
           CASE WHEN required.signature='private.guard_tenant_lifecycle_write()' THEN COALESCE(pg_catalog.has_table_privilege(
             proc.proowner,
             pg_catalog.to_regclass('private.tenant_deletion_operations'),
             'SELECT'
           ),false) ELSE true END AS operation_select_allowed,
           CASE WHEN required.needs_finalize THEN COALESCE(pg_catalog.has_table_privilege(
             proc.proowner,
             pg_catalog.to_regclass('private.tenant_deletion_finalizers'),
             'INSERT'
           ),false) ELSE true END AS insert_allowed,
           CASE WHEN required.needs_finalize THEN COALESCE(pg_catalog.has_table_privilege(
             proc.proowner,
             pg_catalog.to_regclass('private.tenant_deletion_finalizers'),
             'DELETE'
           ),false) ELSE true END AS delete_allowed
    FROM required
    LEFT JOIN pg_catalog.pg_proc AS proc ON proc.oid=pg_catalog.to_regprocedure(required.signature)
  `);
  const finalizerOwnerAccessViolations = finalizerOwnerAccessResult.rows.filter(row =>
    row.private_schema_usage !== true || row.select_allowed !== true ||
    row.tombstone_select_allowed !== true || row.operation_select_allowed !== true ||
    row.insert_allowed !== true || row.delete_allowed !== true
  ).map(row => row.signature);
  const currentFinalizerAccessResult = await pool.query(`
    SELECT COALESCE(pg_catalog.has_schema_privilege(current_user,'private','USAGE'),false) AND
    COALESCE(pg_catalog.has_table_privilege(
      current_user,
      pg_catalog.to_regclass('private.tenant_deletion_finalizers'),
      'SELECT'
    ),false) AND COALESCE(pg_catalog.has_table_privilege(
      current_user,
      pg_catalog.to_regclass('private.tenant_deletion_finalizers'),
      'INSERT'
    ),false) AND COALESCE(pg_catalog.has_table_privilege(
      current_user,
      pg_catalog.to_regclass('private.tenant_deletion_finalizers'),
      'DELETE'
    ),false) AS allowed
  `);
  const currentFinalizerAccess = currentFinalizerAccessResult.rows[0]?.allowed === true;
  const runtimeFinalizerGrantResult = await pool.query(`
    WITH runtime_roles AS (
      SELECT oid,rolname FROM pg_catalog.pg_roles
      WHERE rolname IN ('anon','authenticated','service_role')
    )
    SELECT runtime_roles.rolname
    FROM runtime_roles
    CROSS JOIN pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid=relation.relnamespace
    WHERE namespace.nspname='private'
      AND relation.relname='tenant_deletion_finalizers'
      AND (
        pg_catalog.has_table_privilege(runtime_roles.oid,relation.oid,'SELECT') OR
        pg_catalog.has_table_privilege(runtime_roles.oid,relation.oid,'INSERT') OR
        pg_catalog.has_table_privilege(runtime_roles.oid,relation.oid,'UPDATE') OR
        pg_catalog.has_table_privilege(runtime_roles.oid,relation.oid,'DELETE')
      )
  `);
  const runtimeFinalizerGrants = runtimeFinalizerGrantResult.rows.map(row => row.rolname);
  const finalizerAclAuditResult = await pool.query(`
    WITH finalizer AS (
      SELECT relation.oid,relation.relowner,relation.relacl
      FROM pg_catalog.pg_class AS relation
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid=relation.relnamespace
      WHERE namespace.nspname='private'
        AND relation.relname='tenant_deletion_finalizers'
    ), allowed(role_oid) AS (
      SELECT relowner FROM finalizer
      UNION
      SELECT proc.proowner
      FROM pg_catalog.pg_proc AS proc
      WHERE proc.oid IN (
        pg_catalog.to_regprocedure('private.guard_tenant_lifecycle_write()'),
        pg_catalog.to_regprocedure('public.purge_tenant_repository(uuid,bigint,uuid)')
      )
    ), owner_violation AS (
      SELECT owner_role.rolname AS role_name,'untrusted_table_owner' AS violation
      FROM finalizer
      JOIN pg_catalog.pg_roles AS owner_role ON owner_role.oid=finalizer.relowner
      WHERE NOT (owner_role.rolsuper OR owner_role.rolbypassrls)
         OR owner_role.rolname IN ('anon','authenticated','service_role')
    ), explicit_violation AS (
      SELECT
        COALESCE(grantee_role.rolname,'PUBLIC') AS role_name,
        'explicit_' || lower(acl.privilege_type) AS violation
      FROM finalizer
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(finalizer.relacl,pg_catalog.acldefault('r',finalizer.relowner))
      ) AS acl
      LEFT JOIN pg_catalog.pg_roles AS grantee_role ON grantee_role.oid=acl.grantee
      WHERE acl.privilege_type IN ('SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER')
        AND (acl.grantee=0 OR acl.grantee NOT IN (SELECT role_oid FROM allowed))
    ), effective_violation AS (
      SELECT candidate.rolname AS role_name,'effective_table_access' AS violation
      FROM pg_catalog.pg_roles AS candidate
      CROSS JOIN finalizer
      WHERE candidate.oid NOT IN (SELECT role_oid FROM allowed)
        -- Ignore only the direct PostgreSQL predefined NOLOGIN principals.
        -- Any login/custom role inheriting them remains a separate candidate.
        AND NOT (
          candidate.rolname IN ('pg_read_all_data','pg_write_all_data')
          AND NOT candidate.rolcanlogin
          AND candidate.oid < 16384::oid
        )
        AND (
          candidate.rolname IN ('anon','authenticated','service_role') OR
          NOT (candidate.rolsuper OR candidate.rolbypassrls)
        )
        AND (
          pg_catalog.has_table_privilege(candidate.oid,finalizer.oid,'SELECT') OR
          pg_catalog.has_table_privilege(candidate.oid,finalizer.oid,'INSERT') OR
          pg_catalog.has_table_privilege(candidate.oid,finalizer.oid,'UPDATE') OR
          pg_catalog.has_table_privilege(candidate.oid,finalizer.oid,'DELETE') OR
          pg_catalog.has_table_privilege(candidate.oid,finalizer.oid,'TRUNCATE') OR
          pg_catalog.has_table_privilege(candidate.oid,finalizer.oid,'REFERENCES') OR
          pg_catalog.has_table_privilege(candidate.oid,finalizer.oid,'TRIGGER')
        )
    )
    SELECT role_name,violation FROM owner_violation
    UNION
    SELECT role_name,violation FROM explicit_violation
    UNION
    SELECT role_name,violation FROM effective_violation
    ORDER BY role_name,violation
  `);
  const finalizerAclViolations = finalizerAclAuditResult.rows.map(row => ({
    role: row.role_name,
    violation: row.violation
  }));
  let companyCount = null;
  let userCount = null;
  let deletionOperationCount = null;
  let deletionFinalizerCount = null;
  let tombstoneCount = null;
  let directoryCount = null;
  let activeEmailCount = null;
  let publicLinkTokenCount = null;
  let emailConflictCount = null;
  let platformStateCount = null;
  let platformRecordCount = null;
  let platformRevisionLogCount = null;
  if (objectState.companies) companyCount = Number((await pool.query('SELECT count(*)::int AS count FROM public.companies')).rows[0].count);
  if (objectState.users) userCount = Number((await pool.query('SELECT count(*)::int AS count FROM public.users')).rows[0].count);
  if (objectState.tenant_directory) directoryCount = Number((await pool.query('SELECT count(*)::int AS count FROM private.tenant_directory')).rows[0].count);
  if (objectState.tenant_active_user_emails) activeEmailCount = Number((await pool.query('SELECT count(*)::int AS count FROM private.tenant_active_user_emails')).rows[0].count);
  if (objectState.tenant_deletion_operations) deletionOperationCount = Number((await pool.query('SELECT count(*)::int AS count FROM private.tenant_deletion_operations')).rows[0].count);
  if (objectState.tenant_deletion_finalizers) deletionFinalizerCount = Number((await pool.query('SELECT count(*)::int AS count FROM private.tenant_deletion_finalizers')).rows[0].count);
  if (objectState.tenant_tombstones) tombstoneCount = Number((await pool.query('SELECT count(*)::int AS count FROM private.tenant_tombstones')).rows[0].count);
  if (objectState.tenant_public_link_tokens) publicLinkTokenCount = Number((await pool.query('SELECT count(*)::int AS count FROM private.tenant_public_link_tokens')).rows[0].count);
  if (objectState.tenant_email_conflicts) emailConflictCount = Number((await pool.query('SELECT count(*)::int AS count FROM private.tenant_email_conflicts')).rows[0].count);
  if (objectState.platform_state) platformStateCount = Number((await pool.query('SELECT count(*)::int AS count FROM private.platform_state')).rows[0].count);
  if (objectState.platform_records) platformRecordCount = Number((await pool.query('SELECT count(*)::int AS count FROM private.platform_records')).rows[0].count);
  if (objectState.platform_revision_log) platformRevisionLogCount = Number((await pool.query('SELECT count(*)::int AS count FROM private.platform_revision_log')).rows[0].count);
  return {
    identity: {
      host: serverIdentity.host,
      port: serverIdentity.port,
      database: serverIdentity.database,
      databaseRole: serverIdentity.databaseRole,
      serverVersionNum: serverIdentity.serverVersionNum,
      identitySource: serverIdentity.identitySource,
      fingerprint: serverIdentity.fingerprint
    },
    inventory: {
      privilegedVisibility: serverIdentity.privilegedVisibility,
      schemaReady: requiredObjectsReady && missingTriggers.length === 0 && disabledTriggers.length === 0 &&
        missingMigrationTriggers.length === 0 && disabledMigrationTriggers.length === 0 &&
        functionPolicyViolations.length === 0 && finalizerOwnerAccessViolations.length === 0 &&
        runtimeFinalizerGrants.length === 0 && finalizerAclViolations.length === 0 && currentFinalizerAccess &&
        servicePublicSchemaUsage && canSetServiceRole,
      requiredObjects: objectState,
      triggerRows: triggerResult.rowCount,
      missingTriggers,
      disabledTriggers,
      migrationTriggerRows: migrationTriggerResult.rowCount,
      missingMigrationTriggers,
      disabledMigrationTriggers,
      functionPolicyViolations,
      servicePublicSchemaUsage,
      canSetServiceRole,
      finalizerOwnerAccessViolations,
      currentFinalizerAccess,
      runtimeFinalizerGrants,
      finalizerAclViolations,
      companyCount,
      userCount,
      deletionOperationCount,
      deletionFinalizerCount,
      tombstoneCount,
      directoryCount,
      activeEmailCount,
      publicLinkTokenCount,
      emailConflictCount,
      platformStateCount,
      platformRecordCount,
      platformRevisionLogCount
    }
  };
}

function syntheticTenant(runId, scenario, { holdEndsAt, legalHold = false, status = 'Recovery hold', full = false } = {}) {
  const companyId = crypto.randomUUID();
  const deletionRequestId = crypto.randomUUID();
  const marker = `${runId}:${scenario}`;
  return {
    scenario,
    full,
    companyId,
    deletionRequestId,
    marker,
    ids: {
      user: crypto.randomUUID(),
      membership: crypto.randomUUID(),
      customer: crypto.randomUUID(),
      project: crypto.randomUUID(),
      teamMember: crypto.randomUUID(),
      subcontractor: crypto.randomUUID(),
      report: crypto.randomUUID(),
      photo: crypto.randomUUID(),
      assignment: crypto.randomUUID(),
      workday: crypto.randomUUID(),
      change: crypto.randomUUID(),
      guestLink: crypto.randomUUID(),
      audit: crypto.randomUUID()
    },
    holdEndsAt: holdEndsAt || new Date(Date.now() - 60_000).toISOString(),
    legalHold,
    status,
    revision: null
  };
}

function repositoryPayload(tenant) {
  const scalarData = {
    company: {
      id: tenant.companyId,
      name: `PDL DELETE ACCEPTANCE ${tenant.scenario}`,
      deletionRequest: {
        id: tenant.deletionRequestId,
        status: tenant.status,
        holdEndsAt: tenant.holdEndsAt,
        legalHold: tenant.legalHold
      }
    }
  };
  const records = [{
    collection: 'acceptance',
    record_key: `run:${tenant.marker}`,
    position: 0,
    data: { id: tenant.marker, synthetic: true }
  }];
  if (tenant.full) {
    records.push(
      {
        collection: 'users',
        record_key: tenant.ids.user,
        position: 0,
        data: {
          id: tenant.ids.user,
          email: `pdl-delete-${tenant.companyId}@example.invalid`,
          status: 'active',
          synthetic: true
        }
      },
      {
        collection: 'subcontractorLinks',
        record_key: tenant.ids.guestLink,
        position: 0,
        data: { id: tenant.ids.guestLink, tokenHash: sha256(`${tenant.marker}:repository-guest`), synthetic: true }
      },
      {
        collection: 'changes',
        record_key: tenant.ids.change,
        position: 0,
        data: { id: tenant.ids.change, customerTokenHash: sha256(`${tenant.marker}:repository-change`), synthetic: true }
      }
    );
  }
  return { scalarData, records, contentHash: sha256(JSON.stringify({ scalarData, records })) };
}

async function seedRepository(pool, tenant) {
  const payload = repositoryPayload(tenant);
  const result = await pool.query(`
    SELECT revision, record_count
    FROM public.replace_tenant_records($1::uuid, 0, $2::jsonb, $3::text, $4::jsonb)
  `, [tenant.companyId, JSON.stringify(payload.scalarData), payload.contentHash, JSON.stringify(payload.records)]);
  tenant.revision = Number(result.rows[0].revision);
  assert.equal(tenant.revision, 1, 'synthetic tenant must begin at revision 1');
}

async function withTenantTransaction(pool, companyId, task) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1,$2,true)', ['app.company_id', companyId]);
    const result = await task(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function seedNormalizedRows(pool, tenant) {
  const i = tenant.ids;
  const email = `pdl-delete-${tenant.companyId}@example.invalid`;
  await withTenantTransaction(pool, tenant.companyId, async client => {
    await client.query('INSERT INTO public.users(id,email,name,status) VALUES($1,$2,$3,$4)', [i.user, email, 'Synthetic Acceptance User', 'active']);
    await client.query("INSERT INTO public.memberships(id,company_id,user_id,role,project_ids) VALUES($1,$2,$3,'owner','{}')", [i.membership, tenant.companyId, i.user]);
    await client.query("INSERT INTO public.customers(id,company_id,name,contact) VALUES($1,$2,$3,'{}')", [i.customer, tenant.companyId, 'Synthetic Acceptance Customer']);
    await client.query("INSERT INTO public.projects(id,company_id,customer_id,name,contract_type,data) VALUES($1,$2,$3,$4,'estimated','{}')", [i.project, tenant.companyId, i.customer, 'Synthetic Acceptance Project']);
    await client.query("INSERT INTO public.team_members(id,company_id,name,data) VALUES($1,$2,$3,'{}')", [i.teamMember, tenant.companyId, 'Synthetic Acceptance Team Member']);
    await client.query("INSERT INTO public.subcontractors(id,company_id,name,data) VALUES($1,$2,$3,'{}')", [i.subcontractor, tenant.companyId, 'Synthetic Acceptance Subcontractor']);
    await client.query("INSERT INTO public.reports(id,company_id,project_id,submitted_by,subcontractor_id,status,data) VALUES($1,$2,$3,$4,$5,'draft','{}')", [i.report, tenant.companyId, i.project, i.user, i.subcontractor]);
    await client.query("INSERT INTO public.photos(id,company_id,project_id,report_id,storage_key,data) VALUES($1,$2,$3,$4,$5,'{}')", [i.photo, tenant.companyId, i.project, i.report, `${tenant.companyId}/acceptance/photo.jpg`]);
    await client.query("INSERT INTO public.assignments(id,company_id,project_id,data) VALUES($1,$2,$3,'{}')", [i.assignment, tenant.companyId, i.project]);
    await client.query("INSERT INTO public.workdays(id,company_id,project_id,data) VALUES($1,$2,$3,'{}')", [i.workday, tenant.companyId, i.project]);
    await client.query("INSERT INTO public.changes(id,company_id,project_id,report_id,data) VALUES($1,$2,$3,$4,'{}')", [i.change, tenant.companyId, i.project, i.report]);
    await client.query("INSERT INTO public.guest_links(id,company_id,project_id,subcontractor_id,token_hash,expires_at,data) VALUES($1,$2,$3,$4,$5,now()+interval '1 hour','{}')", [i.guestLink, tenant.companyId, i.project, i.subcontractor, sha256(`${tenant.marker}:guest`)]);
    await client.query("INSERT INTO public.audit_events(id,company_id,actor_user_id,action,resource_type,resource_id,data) VALUES($1,$2,$3,'acceptance','tenant',$4,'{}')", [i.audit, tenant.companyId, i.user, tenant.companyId]);
  });
}

async function seedTenant(pool, tenant) {
  await seedRepository(pool, tenant);
  if (tenant.full) await seedNormalizedRows(pool, tenant);
}

async function verifyGuardedSeedRows(pool, tenant) {
  const counts = {};
  for (const table of GUARDED_TABLES) {
    const column = table === 'companies' ? 'id' : 'company_id';
    const count = Number((await pool.query(
      `SELECT count(*)::int AS count FROM public.${table} WHERE ${column}=$1`,
      [tenant.companyId]
    )).rows[0].count);
    assert(count > 0, `${table} must contain a synthetic pre-lock insert`);
    counts[table] = count;
  }
  return counts;
}

async function seedAndVerifyPrivateProjectionEvidence(pool, primary, conflictPeer) {
  const normalizedEmail = `pdl-delete-conflict-${primary.companyId}@example.invalid`;
  await pool.query(`
    INSERT INTO private.tenant_email_conflicts(
      normalized_email,retained_company_id,conflicted_company_id,authorized_company_id
    ) VALUES($1,$2::uuid,$3::uuid,$2::uuid)
  `, [normalizedEmail, primary.companyId, conflictPeer.companyId]);
  const result = await pool.query(`
    SELECT
      (SELECT count(*)::int FROM private.tenant_directory WHERE company_id=$1) AS directory_count,
      (SELECT count(*)::int FROM private.tenant_active_user_emails WHERE company_id=$1) AS active_email_count,
      (SELECT count(*)::int FROM private.tenant_public_link_tokens WHERE company_id=$1) AS public_token_count,
      (SELECT count(*)::int FROM private.tenant_email_conflicts
        WHERE retained_company_id=$1 OR conflicted_company_id=$1 OR authorized_company_id=$1) AS conflict_count
  `, [primary.companyId]);
  const counts = Object.fromEntries(Object.entries(result.rows[0]).map(([key, value]) => [key, Number(value)]));
  assert.equal(counts.directory_count, 1, 'the primary synthetic tenant must create a directory projection');
  assert.equal(counts.active_email_count, 1, 'the primary synthetic tenant must create an active-email projection');
  assert.equal(counts.public_token_count, 2, 'the primary synthetic tenant must create guest and change-order token projections');
  assert.equal(counts.conflict_count, 1, 'the primary synthetic tenant must own one conflict record before purge');
  return counts;
}

function normalizeJson(value) {
  return typeof value === 'string' ? JSON.parse(value) : value;
}

async function queryAsServiceRole(pool, text, params) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE service_role');
    const result = await client.query(text, params);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function beginDeletion(pool, tenant, { revision = tenant.revision, requestId = tenant.deletionRequestId } = {}) {
  const result = await queryAsServiceRole(
    pool,
    'SELECT public.begin_tenant_repository_purge($1::uuid,$2::bigint,$3::uuid) AS result',
    [tenant.companyId, revision, requestId]
  );
  return normalizeJson(result.rows[0].result);
}

async function deletionStatus(pool, tenant) {
  const result = await queryAsServiceRole(
    pool,
    'SELECT public.tenant_repository_deletion_status($1::uuid) AS result',
    [tenant.companyId]
  );
  return normalizeJson(result.rows[0].result);
}

async function finalizeDeletion(pool, tenant, { revision = tenant.revision, requestId = tenant.deletionRequestId } = {}) {
  const result = await queryAsServiceRole(
    pool,
    'SELECT public.purge_tenant_repository($1::uuid,$2::bigint,$3::uuid) AS result',
    [tenant.companyId, revision, requestId]
  );
  return normalizeJson(result.rows[0].result);
}

async function expectDatabaseError(task, { code, pattern, label }) {
  try {
    await task();
  } catch (error) {
    if (code) assert.equal(String(error.code), String(code), `${label} returned the wrong SQLSTATE: ${error.message}`);
    if (pattern) assert.match(String(error.message), pattern, `${label} returned an unexpected error`);
    return safeError(error);
  }
  throw new Error(`${label} unexpectedly succeeded.`);
}

async function assertWrongStatusGuard(pool, tenant) {
  const client = await pool.connect();
  let rejection = null;
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1,$2,true)', ['app.company_id', tenant.companyId]);
    await client.query(`
      UPDATE public.tenant_revisions
      SET scalar_data=jsonb_set(
        scalar_data,
        '{company,deletionRequest,status}',
        to_jsonb($2::text),
        false
      )
      WHERE company_id=$1
    `, [tenant.companyId, 'Requested']);
    await client.query('SET LOCAL ROLE service_role');
    try {
      await client.query(
        'SELECT public.begin_tenant_repository_purge($1::uuid,$2::bigint,$3::uuid)',
        [tenant.companyId, tenant.revision, tenant.deletionRequestId]
      );
    } catch (error) {
      assert.equal(String(error.code), '55000', 'non-recovery status returned the wrong SQLSTATE');
      assert.match(String(error.message), /durable recovery hold/i, 'non-recovery status returned an unexpected error');
      rejection = safeError(error);
    }
    await client.query('ROLLBACK');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  if (!rejection) throw new Error('non-recovery status unexpectedly began deletion.');
  return rejection;
}

function guardedWriteCases(tenant) {
  const i = tenant.ids;
  const companyId = tenant.companyId;
  const fresh = () => crypto.randomUUID();
  const specs = [];
  const add = (table, insert, update, remove) => {
    specs.push({ table, operation: 'INSERT', ...insert });
    specs.push({ table, operation: 'UPDATE', ...update });
    specs.push({ table, operation: 'DELETE', ...remove });
  };
  add('companies',
    { sql: 'INSERT INTO public.companies(id,slug,name) VALUES($1,$2,$3)', params: [companyId, `duplicate-${companyId}`, 'Blocked duplicate'] },
    { sql: 'UPDATE public.companies SET name=name WHERE id=$1', params: [companyId] },
    { sql: 'DELETE FROM public.companies WHERE id=$1', params: [companyId] });
  add('tenant_revisions',
    { sql: "INSERT INTO public.tenant_revisions(company_id,revision,scalar_data,content_hash) VALUES($1,0,'{}','')", params: [companyId] },
    { sql: 'UPDATE public.tenant_revisions SET updated_at=updated_at WHERE company_id=$1', params: [companyId] },
    { sql: 'DELETE FROM public.tenant_revisions WHERE company_id=$1', params: [companyId] });
  add('tenant_records',
    { sql: "INSERT INTO public.tenant_records(company_id,collection,record_key,position,data) VALUES($1,'acceptance',$2,99,'{}')", params: [companyId, `blocked:${fresh()}`] },
    { sql: "UPDATE public.tenant_records SET data=data WHERE company_id=$1 AND collection='acceptance'", params: [companyId] },
    { sql: "DELETE FROM public.tenant_records WHERE company_id=$1 AND collection='acceptance'", params: [companyId] });
  add('audit_events',
    { sql: "INSERT INTO public.audit_events(id,company_id,actor_user_id,action,resource_type,data) VALUES($1,$2,$3,'blocked','tenant','{}')", params: [fresh(), companyId, i.user] },
    { sql: 'UPDATE public.audit_events SET data=data WHERE id=$1', params: [i.audit] },
    { sql: 'DELETE FROM public.audit_events WHERE id=$1', params: [i.audit] });
  add('guest_links',
    { sql: "INSERT INTO public.guest_links(id,company_id,project_id,subcontractor_id,token_hash,expires_at,data) VALUES($1,$2,$3,$4,$5,now()+interval '1 hour','{}')", params: [fresh(), companyId, i.project, i.subcontractor, sha256(`${fresh()}:guest`)] },
    { sql: 'UPDATE public.guest_links SET data=data WHERE id=$1', params: [i.guestLink] },
    { sql: 'DELETE FROM public.guest_links WHERE id=$1', params: [i.guestLink] });
  add('changes',
    { sql: "INSERT INTO public.changes(id,company_id,project_id,report_id,data) VALUES($1,$2,$3,$4,'{}')", params: [fresh(), companyId, i.project, i.report] },
    { sql: 'UPDATE public.changes SET data=data WHERE id=$1', params: [i.change] },
    { sql: 'DELETE FROM public.changes WHERE id=$1', params: [i.change] });
  add('photos',
    { sql: "INSERT INTO public.photos(id,company_id,project_id,report_id,storage_key,data) VALUES($1,$2,$3,$4,$5,'{}')", params: [fresh(), companyId, i.project, i.report, `${companyId}/blocked/${fresh()}.jpg`] },
    { sql: 'UPDATE public.photos SET data=data WHERE id=$1', params: [i.photo] },
    { sql: 'DELETE FROM public.photos WHERE id=$1', params: [i.photo] });
  add('reports',
    { sql: "INSERT INTO public.reports(id,company_id,project_id,submitted_by,subcontractor_id,status,data) VALUES($1,$2,$3,$4,$5,'draft','{}')", params: [fresh(), companyId, i.project, i.user, i.subcontractor] },
    { sql: 'UPDATE public.reports SET data=data WHERE id=$1', params: [i.report] },
    { sql: 'DELETE FROM public.reports WHERE id=$1', params: [i.report] });
  add('workdays',
    { sql: "INSERT INTO public.workdays(id,company_id,project_id,data) VALUES($1,$2,$3,'{}')", params: [fresh(), companyId, i.project] },
    { sql: 'UPDATE public.workdays SET data=data WHERE id=$1', params: [i.workday] },
    { sql: 'DELETE FROM public.workdays WHERE id=$1', params: [i.workday] });
  add('assignments',
    { sql: "INSERT INTO public.assignments(id,company_id,project_id,data) VALUES($1,$2,$3,'{}')", params: [fresh(), companyId, i.project] },
    { sql: 'UPDATE public.assignments SET data=data WHERE id=$1', params: [i.assignment] },
    { sql: 'DELETE FROM public.assignments WHERE id=$1', params: [i.assignment] });
  add('projects',
    { sql: "INSERT INTO public.projects(id,company_id,customer_id,name,contract_type,data) VALUES($1,$2,$3,'Blocked project','estimated','{}')", params: [fresh(), companyId, i.customer] },
    { sql: 'UPDATE public.projects SET data=data WHERE id=$1', params: [i.project] },
    { sql: 'DELETE FROM public.projects WHERE id=$1', params: [i.project] });
  add('customers',
    { sql: "INSERT INTO public.customers(id,company_id,name,contact) VALUES($1,$2,'Blocked customer','{}')", params: [fresh(), companyId] },
    { sql: 'UPDATE public.customers SET contact=contact WHERE id=$1', params: [i.customer] },
    { sql: 'DELETE FROM public.customers WHERE id=$1', params: [i.customer] });
  add('team_members',
    { sql: "INSERT INTO public.team_members(id,company_id,name,data) VALUES($1,$2,'Blocked team member','{}')", params: [fresh(), companyId] },
    { sql: 'UPDATE public.team_members SET data=data WHERE id=$1', params: [i.teamMember] },
    { sql: 'DELETE FROM public.team_members WHERE id=$1', params: [i.teamMember] });
  add('subcontractors',
    { sql: "INSERT INTO public.subcontractors(id,company_id,name,data) VALUES($1,$2,'Blocked subcontractor','{}')", params: [fresh(), companyId] },
    { sql: 'UPDATE public.subcontractors SET data=data WHERE id=$1', params: [i.subcontractor] },
    { sql: 'DELETE FROM public.subcontractors WHERE id=$1', params: [i.subcontractor] });
  add('memberships',
    { sql: "INSERT INTO public.memberships(id,company_id,user_id,role,project_ids) VALUES($1,$2,$3,'owner','{}')", params: [fresh(), companyId, i.user] },
    { sql: 'UPDATE public.memberships SET project_ids=project_ids WHERE id=$1', params: [i.membership] },
    { sql: 'DELETE FROM public.memberships WHERE id=$1', params: [i.membership] });
  return specs;
}

function tenantMoveCases(tenant, receiverCompanyId) {
  const i = tenant.ids;
  const move = (table, predicate, params = []) => ({
    table,
    operation: 'TENANT_MOVE',
    sql: `UPDATE public.${table} SET company_id=$1 WHERE ${predicate}`,
    params: [receiverCompanyId, ...params]
  });
  return [
    {
      table: 'companies',
      operation: 'TENANT_MOVE',
      sql: 'UPDATE public.companies SET id=$1 WHERE id=$2',
      params: [receiverCompanyId, tenant.companyId]
    },
    move('tenant_revisions', 'company_id=$2', [tenant.companyId]),
    move('tenant_records', "company_id=$2 AND collection='acceptance'", [tenant.companyId]),
    move('audit_events', 'id=$2', [i.audit]),
    move('guest_links', 'id=$2', [i.guestLink]),
    move('changes', 'id=$2', [i.change]),
    move('photos', 'id=$2', [i.photo]),
    move('reports', 'id=$2', [i.report]),
    move('workdays', 'id=$2', [i.workday]),
    move('assignments', 'id=$2', [i.assignment]),
    move('projects', 'id=$2', [i.project]),
    move('customers', 'id=$2', [i.customer]),
    move('team_members', 'id=$2', [i.teamMember]),
    move('subcontractors', 'id=$2', [i.subcontractor]),
    move('memberships', 'id=$2', [i.membership])
  ];
}

async function assertBlockedWrite(pool, tenant, spec) {
  const client = await pool.connect();
  let unexpectedSuccess = false;
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1,$2,true)', ['app.company_id', tenant.companyId]);
    try {
      await client.query(spec.sql, spec.params);
      unexpectedSuccess = true;
    } catch (error) {
      assert.equal(String(error.code), '55000', `${spec.table} ${spec.operation} returned the wrong SQLSTATE`);
      assert.match(String(error.message), /PDL_TENANT_DELETION_LOCKED/, `${spec.table} ${spec.operation} was not rejected by the deletion lock`);
    }
    await client.query('ROLLBACK');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  if (unexpectedSuccess) throw new Error(`${spec.table} ${spec.operation} escaped the deletion lock.`);
}

async function assertTenantMoveBlocked(pool, tenant, spec) {
  const client = await pool.connect();
  let rejected = false;
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1,$2,true)', ['app.company_id', tenant.companyId]);
    try {
      await client.query(spec.sql, spec.params);
    } catch (error) {
      assert.equal(String(error.code), '55000', `${spec.table} tenant move returned the wrong SQLSTATE`);
      assert.match(String(error.message), /PDL_TENANT_ID_IMMUTABLE/, `${spec.table} tenant move was not rejected as immutable`);
      rejected = true;
    }
    await client.query('ROLLBACK');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  if (!rejected) throw new Error(`${spec.table} escaped the lifecycle lock by moving to another tenant.`);
}

async function assertCallerSetFinalizerRejected(pool, tenant) {
  const client = await pool.connect();
  let rejected = false;
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1,$2,true)', ['app.company_id', tenant.companyId]);
    await client.query("SELECT set_config('pdl.tenant_deletion_finalize',$1,true)", [tenant.companyId]);
    try {
      await client.query('UPDATE public.team_members SET data=data WHERE id=$1', [tenant.ids.teamMember]);
    } catch (error) {
      assert.equal(String(error.code), '55000', 'a caller-set finalizer marker returned the wrong SQLSTATE');
      assert.match(String(error.message), /PDL_TENANT_DELETION_LOCKED/, 'a caller-set GUC bypassed the transaction capability');
      rejected = true;
    }
    await client.query('ROLLBACK');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  if (!rejected) throw new Error('A caller-set finalizer GUC escaped the durable deletion lock.');
  return { rejected: true, mechanism: 'private_transaction_capability' };
}

async function assertServiceRoleCannotMintFinalizer(pool, tenant) {
  const client = await pool.connect();
  let rejected = false;
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE service_role');
    try {
      await client.query(`
        INSERT INTO private.tenant_deletion_finalizers(backend_pid,transaction_id,company_id)
        VALUES(pg_backend_pid(),pg_current_xact_id()::text,$1)
      `, [tenant.companyId]);
    } catch (error) {
      assert.equal(String(error.code), '42501', 'service_role finalizer mint returned the wrong SQLSTATE');
      rejected = true;
    }
    await client.query('ROLLBACK');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  if (!rejected) throw new Error('service_role directly minted a deletion finalizer capability.');
  const leaked = Number((await pool.query(
    'SELECT count(*)::int AS count FROM private.tenant_deletion_finalizers WHERE company_id=$1',
    [tenant.companyId]
  )).rows[0].count);
  assert.equal(leaked, 0, 'a rejected service_role capability attempt must not persist a row');
  return { rejected: true, sqlstate: '42501', leakedRows: 0 };
}

function preLockLifecycleCases(tenant) {
  const i = tenant.ids;
  const companyId = tenant.companyId;
  const fresh = () => crypto.randomUUID();
  const cases = [];
  const add = (table, insert, update, remove, setup = []) => cases.push({ table, insert, update, remove, setup });
  const temporaryCompanyId = fresh();
  const temporaryUserId = fresh();
  const recordKey = `prelock:${fresh()}`;
  const auditId = fresh();
  const guestLinkId = fresh();
  const changeId = fresh();
  const photoId = fresh();
  const reportId = fresh();
  const workdayId = fresh();
  const assignmentId = fresh();
  const projectId = fresh();
  const customerId = fresh();
  const teamMemberId = fresh();
  const subcontractorId = fresh();
  const membershipId = fresh();
  add('companies',
    { sql: 'INSERT INTO public.companies(id,slug,name) VALUES($1,$2,$3)', params: [temporaryCompanyId, `prelock-${temporaryCompanyId}`, 'Pre-lock lifecycle'] },
    { sql: 'UPDATE public.companies SET name=name WHERE id=$1', params: [temporaryCompanyId] },
    { sql: 'DELETE FROM public.companies WHERE id=$1', params: [temporaryCompanyId] });
  add('tenant_revisions',
    { sql: "INSERT INTO public.tenant_revisions(company_id,revision,scalar_data,content_hash) VALUES($1,0,'{}','')", params: [temporaryCompanyId] },
    { sql: 'UPDATE public.tenant_revisions SET updated_at=updated_at WHERE company_id=$1', params: [temporaryCompanyId] },
    { sql: 'DELETE FROM public.tenant_revisions WHERE company_id=$1', params: [temporaryCompanyId] },
    [{ sql: 'INSERT INTO public.companies(id,slug,name) VALUES($1,$2,$3)', params: [temporaryCompanyId, `prelock-revision-${temporaryCompanyId}`, 'Pre-lock revision parent'] }]);
  add('tenant_records',
    { sql: "INSERT INTO public.tenant_records(company_id,collection,record_key,position,data) VALUES($1,'acceptance',$2,98,'{}')", params: [companyId, recordKey] },
    { sql: "UPDATE public.tenant_records SET data=data WHERE company_id=$1 AND collection='acceptance' AND record_key=$2", params: [companyId, recordKey] },
    { sql: "DELETE FROM public.tenant_records WHERE company_id=$1 AND collection='acceptance' AND record_key=$2", params: [companyId, recordKey] });
  add('audit_events',
    { sql: "INSERT INTO public.audit_events(id,company_id,actor_user_id,action,resource_type,data) VALUES($1,$2,$3,'prelock','tenant','{}')", params: [auditId, companyId, i.user] },
    { sql: 'UPDATE public.audit_events SET data=data WHERE id=$1', params: [auditId] },
    { sql: 'DELETE FROM public.audit_events WHERE id=$1', params: [auditId] });
  add('guest_links',
    { sql: "INSERT INTO public.guest_links(id,company_id,project_id,subcontractor_id,token_hash,expires_at,data) VALUES($1,$2,$3,$4,$5,now()+interval '1 hour','{}')", params: [guestLinkId, companyId, i.project, i.subcontractor, sha256(`${guestLinkId}:prelock`)] },
    { sql: 'UPDATE public.guest_links SET data=data WHERE id=$1', params: [guestLinkId] },
    { sql: 'DELETE FROM public.guest_links WHERE id=$1', params: [guestLinkId] });
  add('changes',
    { sql: "INSERT INTO public.changes(id,company_id,project_id,report_id,data) VALUES($1,$2,$3,$4,'{}')", params: [changeId, companyId, i.project, i.report] },
    { sql: 'UPDATE public.changes SET data=data WHERE id=$1', params: [changeId] },
    { sql: 'DELETE FROM public.changes WHERE id=$1', params: [changeId] });
  add('photos',
    { sql: "INSERT INTO public.photos(id,company_id,project_id,report_id,storage_key,data) VALUES($1,$2,$3,$4,$5,'{}')", params: [photoId, companyId, i.project, i.report, `${companyId}/prelock/${photoId}.jpg`] },
    { sql: 'UPDATE public.photos SET data=data WHERE id=$1', params: [photoId] },
    { sql: 'DELETE FROM public.photos WHERE id=$1', params: [photoId] });
  add('reports',
    { sql: "INSERT INTO public.reports(id,company_id,project_id,submitted_by,subcontractor_id,status,data) VALUES($1,$2,$3,$4,$5,'draft','{}')", params: [reportId, companyId, i.project, i.user, i.subcontractor] },
    { sql: 'UPDATE public.reports SET data=data WHERE id=$1', params: [reportId] },
    { sql: 'DELETE FROM public.reports WHERE id=$1', params: [reportId] });
  add('workdays',
    { sql: "INSERT INTO public.workdays(id,company_id,project_id,data) VALUES($1,$2,$3,'{}')", params: [workdayId, companyId, i.project] },
    { sql: 'UPDATE public.workdays SET data=data WHERE id=$1', params: [workdayId] },
    { sql: 'DELETE FROM public.workdays WHERE id=$1', params: [workdayId] });
  add('assignments',
    { sql: "INSERT INTO public.assignments(id,company_id,project_id,data) VALUES($1,$2,$3,'{}')", params: [assignmentId, companyId, i.project] },
    { sql: 'UPDATE public.assignments SET data=data WHERE id=$1', params: [assignmentId] },
    { sql: 'DELETE FROM public.assignments WHERE id=$1', params: [assignmentId] });
  add('projects',
    { sql: "INSERT INTO public.projects(id,company_id,customer_id,name,contract_type,data) VALUES($1,$2,$3,'Pre-lock project','estimated','{}')", params: [projectId, companyId, i.customer] },
    { sql: 'UPDATE public.projects SET data=data WHERE id=$1', params: [projectId] },
    { sql: 'DELETE FROM public.projects WHERE id=$1', params: [projectId] });
  add('customers',
    { sql: "INSERT INTO public.customers(id,company_id,name,contact) VALUES($1,$2,'Pre-lock customer','{}')", params: [customerId, companyId] },
    { sql: 'UPDATE public.customers SET contact=contact WHERE id=$1', params: [customerId] },
    { sql: 'DELETE FROM public.customers WHERE id=$1', params: [customerId] });
  add('team_members',
    { sql: "INSERT INTO public.team_members(id,company_id,name,data) VALUES($1,$2,'Pre-lock team member','{}')", params: [teamMemberId, companyId] },
    { sql: 'UPDATE public.team_members SET data=data WHERE id=$1', params: [teamMemberId] },
    { sql: 'DELETE FROM public.team_members WHERE id=$1', params: [teamMemberId] });
  add('subcontractors',
    { sql: "INSERT INTO public.subcontractors(id,company_id,name,data) VALUES($1,$2,'Pre-lock subcontractor','{}')", params: [subcontractorId, companyId] },
    { sql: 'UPDATE public.subcontractors SET data=data WHERE id=$1', params: [subcontractorId] },
    { sql: 'DELETE FROM public.subcontractors WHERE id=$1', params: [subcontractorId] });
  add('memberships',
    { sql: "INSERT INTO public.memberships(id,company_id,user_id,role,project_ids) VALUES($1,$2,$3,'field','{}')", params: [membershipId, companyId, temporaryUserId] },
    { sql: 'UPDATE public.memberships SET project_ids=project_ids WHERE id=$1', params: [membershipId] },
    { sql: 'DELETE FROM public.memberships WHERE id=$1', params: [membershipId] },
    [{ sql: 'INSERT INTO public.users(id,email,name,status) VALUES($1,$2,$3,$4)', params: [temporaryUserId, `prelock-${temporaryUserId}@example.invalid`, 'Pre-lock User', 'active'] }]);
  return cases;
}

async function assertWritesAllowedBeforeLock(pool, tenant) {
  const cases = preLockLifecycleCases(tenant);
  assert.equal(cases.length, GUARDED_TABLES.length);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (let index = 0; index < cases.length; index += 1) {
      const spec = cases[index];
      const savepoint = `prelock_${index}`;
      await client.query(`SAVEPOINT ${savepoint}`);
      try {
        const scopedCompanyId = spec.table === 'tenant_revisions' ? spec.insert.params[0] : tenant.companyId;
        await client.query('SELECT set_config($1,$2,true)', ['app.company_id', scopedCompanyId]);
        for (const setup of spec.setup) await client.query(setup.sql, setup.params);
        for (const [operation, statement] of [['INSERT', spec.insert], ['UPDATE', spec.update], ['DELETE', spec.remove]]) {
          const result = await client.query(statement.sql, statement.params);
          assert.equal(result.rowCount, 1, `${spec.table} must accept its synthetic ${operation} before deletion is locked`);
        }
      } finally {
        await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        await client.query(`RELEASE SAVEPOINT ${savepoint}`);
      }
    }
    await client.query('ROLLBACK');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  return { allowed: cases.length * GUARDED_EVENTS.length, tables: [...GUARDED_TABLES], events: [...GUARDED_EVENTS] };
}

async function waitForAdvisoryBlock(pool, backendPid, isSettled, timeoutMs = 5_000, operationLabel = 'concurrent operation') {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (isSettled()) throw new Error(`${operationLabel} completed before its competing transaction released the advisory lock.`);
    const result = await pool.query(`
      SELECT state,wait_event_type,wait_event
      FROM pg_catalog.pg_stat_activity
      WHERE pid=$1
    `, [backendPid]);
    const activity = result.rows[0];
    if (activity?.state === 'active' && activity.wait_event_type === 'Lock' && activity.wait_event === 'advisory') {
      return { waitEventType: activity.wait_event_type, waitEvent: activity.wait_event };
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`${operationLabel} was not observed waiting on the advisory lock.`);
}

async function lockBehindInFlightWrite(pool, tenant) {
  let writer = null;
  let deleter = null;
  let writerOpen = false;
  let deleterOpen = false;
  let outcomePromise = null;
  try {
    writer = await pool.connect();
    deleter = await pool.connect();
    await writer.query('BEGIN');
    writerOpen = true;
    await writer.query('SELECT set_config($1,$2,true)', ['app.company_id', tenant.companyId]);
    await writer.query("UPDATE public.team_members SET data=data||'{\"preLockWrite\":true}'::jsonb WHERE id=$1", [tenant.ids.teamMember]);

    await deleter.query('BEGIN');
    deleterOpen = true;
    await deleter.query('SET LOCAL ROLE service_role');
    const backendPid = Number((await deleter.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
    let settled = false;
    outcomePromise = deleter.query(
      'SELECT public.begin_tenant_repository_purge($1::uuid,$2::bigint,$3::uuid) AS result',
      [tenant.companyId, tenant.revision, tenant.deletionRequestId]
    ).then(
      value => { settled = true; return { status: 'fulfilled', value }; },
      error => { settled = true; return { status: 'rejected', error }; }
    );
    const observedWait = await waitForAdvisoryBlock(pool, backendPid, () => settled, 5_000, 'BEGIN purge');
    await writer.query('COMMIT');
    writerOpen = false;
    const outcome = await outcomePromise;
    if (outcome.status === 'rejected') throw outcome.error;
    await deleter.query('COMMIT');
    deleterOpen = false;
    const persisted = await pool.query("SELECT data->>'preLockWrite' AS value FROM public.team_members WHERE id=$1", [tenant.ids.teamMember]);
    assert.equal(persisted.rows[0]?.value, 'true', 'the write that owned the advisory lock must commit before deletion locks');
    return { result: normalizeJson(outcome.value.rows[0].result), observedWait };
  } finally {
    if (writerOpen) await writer.query('ROLLBACK').catch(() => {});
    if (outcomePromise) await outcomePromise.catch(() => {});
    if (deleterOpen) await deleter.query('ROLLBACK').catch(() => {});
    if (writer) writer.release();
    if (deleter) deleter.release();
  }
}

async function writeBehindUncommittedDeletion(pool, tenant) {
  let deleter = null;
  let writer = null;
  let deleterOpen = false;
  let writerOpen = false;
  let writeOutcomePromise = null;
  try {
    deleter = await pool.connect();
    writer = await pool.connect();

    await deleter.query('BEGIN');
    deleterOpen = true;
    await deleter.query('SET LOCAL ROLE service_role');
    const lockResult = await deleter.query(
      'SELECT public.begin_tenant_repository_purge($1::uuid,$2::bigint,$3::uuid) AS result',
      [tenant.companyId, tenant.revision, tenant.deletionRequestId]
    );
    const lock = normalizeJson(lockResult.rows[0].result);
    assert.equal(lock.locked, true, 'the inverse race must create the deletion lock before starting the writer');
    assert.equal(lock.resumed, false, 'the inverse race must start from a fresh deletion lock');

    await writer.query('BEGIN');
    writerOpen = true;
    await writer.query('SELECT set_config($1,$2,true)', ['app.company_id', tenant.companyId]);
    const backendPid = Number((await writer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
    let settled = false;
    writeOutcomePromise = writer.query(
      "UPDATE public.team_members SET data=data||'{\"inverseBlockedWrite\":true}'::jsonb WHERE id=$1",
      [tenant.ids.teamMember]
    ).then(
      value => { settled = true; return { status: 'fulfilled', value }; },
      error => { settled = true; return { status: 'rejected', error }; }
    );

    const observedWait = await waitForAdvisoryBlock(pool, backendPid, () => settled, 5_000, 'guarded writer');
    await deleter.query('COMMIT');
    deleterOpen = false;
    const outcome = await writeOutcomePromise;
    if (outcome.status !== 'rejected') {
      throw new Error('A guarded write committed after an uncommitted deletion lock was published.');
    }
    assert.equal(String(outcome.error.code), '55000', 'inverse-race writer returned the wrong SQLSTATE');
    assert.match(String(outcome.error.message), /PDL_TENANT_DELETION_LOCKED/, 'inverse-race writer escaped the deletion lock');
    await writer.query('ROLLBACK');
    writerOpen = false;

    const persisted = await pool.query(
      "SELECT data->>'inverseBlockedWrite' AS value FROM public.team_members WHERE id=$1",
      [tenant.ids.teamMember]
    );
    assert.equal(persisted.rows[0]?.value ?? null, null, 'the inverse-race write must not persist');
    return {
      result: lock,
      observedWait,
      writerRejected: true,
      sqlstate: String(outcome.error.code),
      persistedRows: 0
    };
  } finally {
    if (deleterOpen && deleter) await deleter.query('ROLLBACK').catch(() => {});
    if (writeOutcomePromise) await writeOutcomePromise.catch(() => {});
    if (writerOpen && writer) await writer.query('ROLLBACK').catch(() => {});
    if (writer) writer.release();
    if (deleter) deleter.release();
  }
}

async function verifyContentFreeReceipt(pool, tenant) {
  const company = await pool.query('SELECT slug,name,data FROM public.companies WHERE id=$1', [tenant.companyId]);
  assert.equal(company.rowCount, 1);
  assert.equal(company.rows[0].slug, `deleted-${tenant.companyId}`);
  assert.equal(company.rows[0].name, 'Deleted tenant');
  const companyData = normalizeJson(company.rows[0].data);
  assert.deepEqual(Object.keys(companyData).sort(), ['company']);
  assert.deepEqual(Object.keys(companyData.company).sort(), ['deletedAt', 'deletionRequestId', 'id']);
  assert.equal(companyData.company.id, tenant.companyId);
  assert.equal(companyData.company.deletionRequestId, tenant.deletionRequestId);
  const encodedCompany = JSON.stringify(companyData);
  assert.doesNotMatch(encodedCompany, /PDL DELETE ACCEPTANCE|example\.invalid|Synthetic Acceptance/i);
  for (const table of GUARDED_TABLES.filter(table => !['companies', 'memberships'].includes(table))) {
    const count = Number((await pool.query(`SELECT count(*)::int AS count FROM public.${table} WHERE company_id=$1`, [tenant.companyId])).rows[0].count);
    assert.equal(count, 0, `${table} must be empty after finalization`);
  }
  assert.equal(Number((await pool.query('SELECT count(*)::int AS count FROM public.memberships WHERE company_id=$1', [tenant.companyId])).rows[0].count), 0);
  assert.equal(Number((await pool.query('SELECT count(*)::int AS count FROM public.users WHERE id=$1', [tenant.ids.user])).rows[0].count), 0);
  for (const table of ['tenant_directory', 'tenant_active_user_emails', 'tenant_public_link_tokens', 'tenant_deletion_operations', 'tenant_deletion_finalizers']) {
    const count = Number((await pool.query(`SELECT count(*)::int AS count FROM private.${table} WHERE company_id=$1`, [tenant.companyId])).rows[0].count);
    assert.equal(count, 0, `private.${table} must be empty after finalization`);
  }
  const conflicts = Number((await pool.query(`
    SELECT count(*)::int AS count FROM private.tenant_email_conflicts
    WHERE retained_company_id=$1 OR conflicted_company_id=$1 OR authorized_company_id=$1
  `, [tenant.companyId])).rows[0].count);
  assert.equal(conflicts, 0, 'tenant email conflict evidence must be purged');
  const tombstone = await pool.query(`
    SELECT tombstone_version,terminal_revision,deletion_request_id,deleted_at
    FROM private.tenant_tombstones WHERE company_id=$1
  `, [tenant.companyId]);
  assert.equal(tombstone.rowCount, 1);
  assert.equal(Number(tombstone.rows[0].tombstone_version), 1);
  assert.equal(Number(tombstone.rows[0].terminal_revision), tenant.revision);
  assert.equal(String(tombstone.rows[0].deletion_request_id), tenant.deletionRequestId);
  return { tombstoneVersion: 1, terminalRevision: tenant.revision, contentRows: 0 };
}

async function cleanupSyntheticTenantInTransaction(client, tenant) {
  await client.query(`
      INSERT INTO private.tenant_deletion_finalizers(backend_pid,transaction_id,company_id)
      VALUES(pg_backend_pid(),pg_current_xact_id()::text,$1)
      ON CONFLICT DO NOTHING
    `, [tenant.companyId]);
  await client.query("SELECT set_config('pdl.tenant_deletion_finalize',$1,true)", [tenant.companyId]);
  await client.query('DELETE FROM private.tenant_active_user_emails WHERE company_id=$1', [tenant.companyId]);
  await client.query('DELETE FROM private.tenant_email_conflicts WHERE retained_company_id=$1 OR conflicted_company_id=$1 OR authorized_company_id=$1', [tenant.companyId]);
  await client.query('DELETE FROM private.tenant_public_link_tokens WHERE company_id=$1', [tenant.companyId]);
  await client.query('DELETE FROM private.tenant_directory WHERE company_id=$1', [tenant.companyId]);
  await client.query('DELETE FROM private.tenant_deletion_operations WHERE company_id=$1', [tenant.companyId]);
  for (const table of ['audit_events', 'guest_links', 'changes', 'photos', 'reports', 'workdays', 'assignments', 'projects', 'customers', 'team_members', 'subcontractors', 'memberships', 'tenant_records', 'tenant_revisions']) {
    await client.query(`DELETE FROM public.${table} WHERE company_id=$1`, [tenant.companyId]);
  }
  const userDelete = await client.query(`
    DELETE FROM public.users
    WHERE id=$1
      AND email=$2
      AND name='Synthetic Acceptance User'
      AND status='active'
      AND NOT EXISTS(SELECT 1 FROM public.memberships WHERE user_id=$1)
    RETURNING id
  `, [tenant.ids.user, `pdl-delete-${tenant.companyId}@example.invalid`]);
  assert(userDelete.rowCount <= 1, 'synthetic cleanup may delete at most one exact user identity');
  await client.query('DELETE FROM public.companies WHERE id=$1', [tenant.companyId]);
  await client.query('DELETE FROM private.tenant_tombstones WHERE company_id=$1', [tenant.companyId]);
  await client.query(`
      DELETE FROM private.tenant_deletion_finalizers
      WHERE backend_pid=pg_backend_pid()
        AND transaction_id=pg_current_xact_id()::text
        AND company_id=$1
    `, [tenant.companyId]);
}

async function cleanupRecordedSyntheticTenants(pool, recoveryManifest, tenants) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Block every application/private writer before provenance is checked.
    // The validation, exact-identity deletion, and zero-row assertion then
    // share one transaction with no check/use window.
    await client.query(`LOCK TABLE ${RECOVERY_LOCK_TABLES.join(', ')} IN ACCESS EXCLUSIVE MODE`);
    const provenance = await assertSyntheticProvenance(client, recoveryManifest, tenants);
    const scope = await assertRecoveryScope(client, tenants);
    for (const tenant of [...tenants].reverse()) {
      await cleanupSyntheticTenantInTransaction(client, tenant);
    }
    const cleanup = await verifyCleanup(client, tenants);
    await client.query('COMMIT');
    return { provenance, scope, cleanup };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function verifyCleanup(pool, tenants) {
  if (!tenants.length) return { verified: true, remainingRows: 0 };
  const result = await pool.query(`
    SELECT
      (SELECT count(*) FROM public.companies) +
      (SELECT count(*) FROM public.users) +
      (SELECT count(*) FROM public.tenant_revisions) +
      (SELECT count(*) FROM public.tenant_records) +
      (SELECT count(*) FROM public.audit_events) +
      (SELECT count(*) FROM public.guest_links) +
      (SELECT count(*) FROM public.changes) +
      (SELECT count(*) FROM public.photos) +
      (SELECT count(*) FROM public.reports) +
      (SELECT count(*) FROM public.workdays) +
      (SELECT count(*) FROM public.assignments) +
      (SELECT count(*) FROM public.projects) +
      (SELECT count(*) FROM public.customers) +
      (SELECT count(*) FROM public.team_members) +
      (SELECT count(*) FROM public.subcontractors) +
      (SELECT count(*) FROM public.memberships) +
      (SELECT count(*) FROM private.tenant_directory) +
      (SELECT count(*) FROM private.tenant_active_user_emails) +
      (SELECT count(*) FROM private.tenant_email_conflicts) +
      (SELECT count(*) FROM private.tenant_deletion_operations) +
      (SELECT count(*) FROM private.tenant_deletion_finalizers) +
      (SELECT count(*) FROM private.tenant_public_link_tokens) +
      (SELECT count(*) FROM private.tenant_tombstones) +
      (SELECT count(*) FROM private.platform_state) +
      (SELECT count(*) FROM private.platform_records) +
      (SELECT count(*) FROM private.platform_revision_log) AS remaining
  `);
  const remainingRows = Number(result.rows[0].remaining);
  if (remainingRows !== 0) throw new Error(`Synthetic acceptance cleanup left ${remainingRows} authoritative rows.`);
  return { verified: true, remainingRows };
}

async function assertRecoveryScope(pool, tenants) {
  const companyIds = tenants.map(tenant => tenant.companyId);
  const userIds = tenants.map(tenant => tenant.ids.user);
  const checks = [
    ['public.companies', 'id'],
    ...GUARDED_TABLES.filter(table => !['companies'].includes(table)).map(table => [`public.${table}`, 'company_id']),
    ['private.tenant_directory', 'company_id'],
    ['private.tenant_active_user_emails', 'company_id'],
    ['private.tenant_deletion_operations', 'company_id'],
    ['private.tenant_deletion_finalizers', 'company_id'],
    ['private.tenant_public_link_tokens', 'company_id'],
    ['private.tenant_tombstones', 'company_id']
  ];
  const unrelated = [];
  for (const [table, column] of checks) {
    const count = Number((await pool.query(
      `SELECT count(*)::int AS count FROM ${table} WHERE NOT (${column}=ANY($1::uuid[]))`,
      [companyIds]
    )).rows[0].count);
    if (count) unrelated.push({ table, count });
  }
  const unrelatedUsers = Number((await pool.query(
    'SELECT count(*)::int AS count FROM public.users WHERE NOT (id=ANY($1::uuid[]))',
    [userIds]
  )).rows[0].count);
  if (unrelatedUsers) unrelated.push({ table: 'public.users', count: unrelatedUsers });
  const unrelatedConflicts = Number((await pool.query(`
    SELECT count(*)::int AS count FROM private.tenant_email_conflicts
    WHERE NOT (retained_company_id=ANY($1::uuid[]))
       OR NOT (conflicted_company_id=ANY($1::uuid[]))
       OR NOT (authorized_company_id=ANY($1::uuid[]))
  `, [companyIds])).rows[0].count);
  if (unrelatedConflicts) unrelated.push({ table: 'private.tenant_email_conflicts', count: unrelatedConflicts });
  for (const table of ['platform_state', 'platform_records', 'platform_revision_log']) {
    const count = Number((await pool.query(`SELECT count(*)::int AS count FROM private.${table}`)).rows[0].count);
    if (count) unrelated.push({ table: `private.${table}`, count });
  }
  if (unrelated.length) {
    const error = new Error('Refusing recovery cleanup: the disposable database contains rows outside the recorded synthetic acceptance tenants.');
    error.details = unrelated;
    throw error;
  }
  return { verified: true, allowedCompanyIds: companyIds.length, allowedUserIds: userIds.length };
}

function validateSyntheticProvenanceRows(recoveryManifest, tenant, { company, revision, marker, tombstone, user, scopedRows }) {
  const expectedMarker = `${recoveryManifest.runId}:${tenant.scenario}`;
  const fullScenario = tenant.scenario === 'primary' || tenant.scenario === 'wrong-status';
  if (!Array.isArray(user) || !Number.isInteger(scopedRows) || scopedRows < 0) {
    throw new Error(`Refusing recovery cleanup: synthetic tenant ${tenant.scenario} is missing complete provenance evidence.`);
  }
  if (user.length > 1) {
    throw new Error(`Refusing recovery cleanup: synthetic tenant ${tenant.scenario} has ambiguous user provenance.`);
  }
  if (!fullScenario && user.length !== 0) {
    throw new Error(`Refusing recovery cleanup: non-full scenario ${tenant.scenario} unexpectedly owns a user row.`);
  }
  if (user.length === 1 && (
    user[0].email !== `pdl-delete-${tenant.companyId}@example.invalid` ||
    user[0].name !== 'Synthetic Acceptance User' ||
    user[0].status !== 'active'
  )) {
    throw new Error(`Refusing recovery cleanup: synthetic tenant ${tenant.scenario} does not own the exact acceptance user identity.`);
  }
  if (company.length === 0) {
    if (revision.length || marker.length || tombstone.length || user.length || scopedRows !== 0) {
      throw new Error(`Refusing recovery cleanup: synthetic tenant ${tenant.scenario} has orphaned provenance rows.`);
    }
    return { scenario: tenant.scenario, state: 'not_seeded' };
  }
  if (company.length !== 1 || revision.length > 1 || marker.length > 1 || tombstone.length > 1) {
    throw new Error(`Refusing recovery cleanup: synthetic tenant ${tenant.scenario} has ambiguous provenance rows.`);
  }

  if (tombstone.length === 1) {
    const companyData = normalizeJson(company[0].data);
    if (company[0].slug !== `deleted-${tenant.companyId}` || company[0].name !== 'Deleted tenant' ||
        revision.length !== 0 || marker.length !== 0 ||
        String(tombstone[0].deletion_request_id) !== tenant.deletionRequestId ||
        Number(tombstone[0].terminal_revision) !== 1 ||
        Number(tombstone[0].tombstone_version) !== 1 ||
        companyData?.company?.id !== tenant.companyId ||
        companyData?.company?.deletionRequestId !== tenant.deletionRequestId ||
        user.length !== 0 || scopedRows !== 0) {
      throw new Error(`Refusing recovery cleanup: finalized tenant ${tenant.scenario} does not match the synthetic receipt.`);
    }
    return { scenario: tenant.scenario, state: 'finalized_synthetic' };
  }

  const scalarData = revision.length === 1 ? normalizeJson(revision[0].scalar_data) : null;
  const markerData = marker.length === 1 ? normalizeJson(marker[0].data) : null;
  if (revision.length !== 1 || marker.length !== 1 ||
      company[0].name !== `PDL DELETE ACCEPTANCE ${tenant.scenario}` ||
      Number(revision[0].revision) !== 1 ||
      scalarData?.company?.id !== tenant.companyId ||
      scalarData?.company?.name !== `PDL DELETE ACCEPTANCE ${tenant.scenario}` ||
      scalarData?.company?.deletionRequest?.id !== tenant.deletionRequestId ||
      markerData?.id !== expectedMarker || markerData?.synthetic !== true) {
    throw new Error(`Refusing recovery cleanup: tenant ${tenant.scenario} is not proven synthetic by the database marker.`);
  }
  return { scenario: tenant.scenario, state: 'active_synthetic' };
}

async function assertSyntheticProvenance(pool, recoveryManifest, tenants) {
  const results = [];
  for (const tenant of tenants) {
    const expectedMarker = `${recoveryManifest.runId}:${tenant.scenario}`;
    const companyResult = await pool.query(
      'SELECT slug,name,data FROM public.companies WHERE id=$1',
      [tenant.companyId]
    );
    const revisionResult = await pool.query(
      'SELECT revision,scalar_data FROM public.tenant_revisions WHERE company_id=$1',
      [tenant.companyId]
    );
    const markerResult = await pool.query(`
      SELECT data
      FROM public.tenant_records
      WHERE company_id=$1 AND collection='acceptance' AND record_key=$2
    `, [tenant.companyId, `run:${expectedMarker}`]);
    const tombstoneResult = await pool.query(`
      SELECT deletion_request_id,terminal_revision,tombstone_version
      FROM private.tenant_tombstones
      WHERE company_id=$1
    `, [tenant.companyId]);
    const userResult = await pool.query(
      'SELECT email,name,status FROM public.users WHERE id=$1',
      [tenant.ids.user]
    );
    const scopedResult = await pool.query(`
      SELECT (
        (SELECT count(*) FROM public.tenant_records WHERE company_id=$1) +
        (SELECT count(*) FROM public.audit_events WHERE company_id=$1) +
        (SELECT count(*) FROM public.guest_links WHERE company_id=$1) +
        (SELECT count(*) FROM public.changes WHERE company_id=$1) +
        (SELECT count(*) FROM public.photos WHERE company_id=$1) +
        (SELECT count(*) FROM public.reports WHERE company_id=$1) +
        (SELECT count(*) FROM public.workdays WHERE company_id=$1) +
        (SELECT count(*) FROM public.assignments WHERE company_id=$1) +
        (SELECT count(*) FROM public.projects WHERE company_id=$1) +
        (SELECT count(*) FROM public.customers WHERE company_id=$1) +
        (SELECT count(*) FROM public.team_members WHERE company_id=$1) +
        (SELECT count(*) FROM public.subcontractors WHERE company_id=$1) +
        (SELECT count(*) FROM public.memberships WHERE company_id=$1) +
        (SELECT count(*) FROM private.tenant_directory WHERE company_id=$1) +
        (SELECT count(*) FROM private.tenant_active_user_emails WHERE company_id=$1) +
        (SELECT count(*) FROM private.tenant_deletion_operations WHERE company_id=$1) +
        (SELECT count(*) FROM private.tenant_deletion_finalizers WHERE company_id=$1) +
        (SELECT count(*) FROM private.tenant_public_link_tokens WHERE company_id=$1) +
        (SELECT count(*) FROM private.tenant_email_conflicts
          WHERE retained_company_id=$1 OR conflicted_company_id=$1 OR authorized_company_id=$1)
      )::int AS scoped_rows
    `, [tenant.companyId]);
    results.push(validateSyntheticProvenanceRows(recoveryManifest, tenant, {
      company: companyResult.rows,
      revision: revisionResult.rows,
      marker: markerResult.rows,
      tombstone: tombstoneResult.rows,
      user: userResult.rows,
      scopedRows: Number(scopedResult.rows[0].scoped_rows)
    }));
  }
  return { verified: true, tenants: results };
}

async function runRecoveryCleanup({ databaseUrl, args, env = process.env }) {
  const manifestRead = readRecoveryEvidenceFile(args.cleanupEvidencePath, args.manifestSha256);
  const actualManifestSha256 = manifestRead.sha256;
  const recoveryManifest = manifestRead.evidence;
  const evidence = JSON.parse(JSON.stringify(recoveryManifest));
  const cleanupLabel = `cleanup-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID().slice(0, 8)}`;
  const cleanupResultPath = resultEvidencePath(args.cleanupEvidencePath, cleanupLabel);
  const pool = createPool(databaseUrl);
  let recoveryError = null;
  let interruptedSignal = '';
  let signalHandlersInstalled = false;
  const onSigint = () => { interruptedSignal ||= 'SIGINT'; };
  const onSigterm = () => { interruptedSignal ||= 'SIGTERM'; };
  try {
    const inspected = await inspectDatabase(pool, databaseUrl);
    assertApplySafety({ args, env, databaseUrl, identity: inspected.identity, inventory: inspected.inventory });
    if (recoveryManifest.target?.fingerprint !== inspected.identity.fingerprint ||
        args.expectedFingerprint !== inspected.identity.fingerprint) {
      throw new Error('Refusing recovery cleanup: evidence, expected fingerprint, and connected database do not identify the same database.');
    }
    const tenants = recoveryManifest.syntheticTenants.map(item => ({
      scenario: item.scenario,
      companyId: item.companyId,
      deletionRequestId: item.deletionRequestId,
      ids: { user: item.userId }
    }));
    process.on('SIGINT', onSigint);
    process.on('SIGTERM', onSigterm);
    signalHandlersInstalled = true;
    const { provenance, scope, cleanup } = await cleanupRecordedSyntheticTenants(pool, recoveryManifest, tenants);
    evidence.cleanup = cleanup;
    evidence.state = evidence.passed ? 'passed_clean' : 'failed_clean';
    evidence.recoveryCleanup = {
      completedAt: new Date().toISOString(),
      targetFingerprint: inspected.identity.fingerprint,
      manifestSha256: actualManifestSha256,
      provenance,
      scope,
      verified: true
    };
    evidence.manifestPath = args.cleanupEvidencePath;
    evidence.resultPath = cleanupResultPath;
  } catch (error) {
    recoveryError = error;
    evidence.state = 'recovery_cleanup_failed';
    evidence.recoveryCleanup = {
      completedAt: new Date().toISOString(),
      verified: false,
      error: safeError(error)
    };
    evidence.manifestPath = args.cleanupEvidencePath;
    evidence.resultPath = cleanupResultPath;
  } finally {
    await pool.end().catch(() => {});
    if (interruptedSignal && !recoveryError) {
      recoveryError = Object.assign(
        new Error(`Recovery cleanup was interrupted by ${interruptedSignal}; cleanup was allowed to finish safely.`),
        { code: interruptedSignal }
      );
      evidence.state = evidence.cleanup?.verified ? 'recovery_cleanup_interrupted_clean' : 'recovery_cleanup_interrupted';
      evidence.recoveryCleanup = {
        ...(evidence.recoveryCleanup || {}),
        interruptedSignal,
        error: safeError(recoveryError)
      };
    }
    if (signalHandlersInstalled) {
      process.removeListener('SIGINT', onSigint);
      process.removeListener('SIGTERM', onSigterm);
      signalHandlersInstalled = false;
    }
    writeEvidenceFile(cleanupResultPath, evidence, { create: true });
  }
  if (recoveryError) throw recoveryError;
  return evidence;
}

async function runAcceptance({ databaseUrl, args, env = process.env }) {
  let pool = createPool(databaseUrl);
  const startedAt = new Date().toISOString();
  const runId = crypto.randomUUID();
  const tenants = [];
  const evidence = {
    schemaVersion: 2,
    kind: 'pdl-deletion-concurrency-acceptance',
    runId,
    startedAt,
    state: 'preflight',
    passed: false,
    target: null,
    syntheticTenants: [],
    checks: {},
    cleanup: { verified: false, remainingRows: null }
  };
  let acceptanceError = null;
  let manifestCreated = false;
  let signalHandlersInstalled = false;
  let interruptedSignal = '';
  const onInterrupt = signal => { interruptedSignal ||= signal; };
  const onSigint = () => onInterrupt('SIGINT');
  const onSigterm = () => onInterrupt('SIGTERM');
  const throwIfInterrupted = () => {
    if (interruptedSignal) {
      const error = new Error(`Acceptance interrupted by ${interruptedSignal}; cleanup is required.`);
      error.code = interruptedSignal;
      throw error;
    }
  };
  try {
    const inspected = await inspectDatabase(pool, databaseUrl);
    evidence.target = {
      host: inspected.identity.host,
      port: inspected.identity.port,
      database: inspected.identity.database,
      serverVersionNum: inspected.identity.serverVersionNum,
      identitySource: inspected.identity.identitySource,
      fingerprint: inspected.identity.fingerprint
    };
    evidence.preflight = inspected.inventory;
    assertApplySafety({ args, env, databaseUrl, identity: inspected.identity, inventory: inspected.inventory });

    const futureHold = syntheticTenant(runId, 'future-hold', { holdEndsAt: new Date(Date.now() + 60 * 60 * 1000).toISOString() });
    const legalHold = syntheticTenant(runId, 'legal-hold', { legalHold: true });
    const wrongStatus = syntheticTenant(runId, 'wrong-status', { full: true });
    const primary = syntheticTenant(runId, 'primary', { full: true });
    tenants.push(futureHold, legalHold, wrongStatus, primary);
    evidence.syntheticTenants = tenants.map(recoveryTenantDescriptor);
    evidence.state = 'prepared';
    writeEvidenceFile(args.evidencePath, evidence, { create: true });
    manifestCreated = true;
    evidence.manifestSha256 = readRecoveryEvidenceFile(args.evidencePath).sha256;
    process.on('SIGINT', onSigint);
    process.on('SIGTERM', onSigterm);
    signalHandlersInstalled = true;
    console.log(JSON.stringify({
      kind: 'pdl-deletion-concurrency-recovery-manifest',
      runId,
      manifest: args.evidencePath,
      manifestSha256: evidence.manifestSha256
    }));
    for (const tenant of tenants) {
      throwIfInterrupted();
      await seedTenant(pool, tenant);
    }
    throwIfInterrupted();
    evidence.state = 'running';
    evidence.checks.privateProjectionRowsBeforePurge = await seedAndVerifyPrivateProjectionEvidence(pool, primary, wrongStatus);
    evidence.checks.beforeLockInsertedRows = await verifyGuardedSeedRows(pool, primary);
    evidence.checks.writeBeforeLockAcrossGuardedTables = await assertWritesAllowedBeforeLock(pool, primary);
    evidence.checks.serviceRoleCannotMintFinalizer = await assertServiceRoleCannotMintFinalizer(pool, primary);
    throwIfInterrupted();

    await expectDatabaseError(() => beginDeletion(pool, futureHold), { code: '55000', pattern: /hold has not elapsed/i, label: 'future hold' });
    await expectDatabaseError(() => beginDeletion(pool, legalHold), { code: '55000', pattern: /legal hold/i, label: 'legal hold' });
    await assertWrongStatusGuard(pool, wrongStatus);
    for (const tenant of [futureHold, legalHold, wrongStatus]) assert.equal((await deletionStatus(pool, tenant)).status, 'not_started');
    evidence.checks.holdGuards = ['future_hold', 'legal_hold', 'wrong_status'];

    // Reuse the exact wrong-status scenario for the inverse race after its
    // rejection has been proven inside a rolled-back transaction. It has its
    // own complete synthetic row graph and remains in Recovery hold, so the
    // test does not create a fifth recovery identity or mutate revision data
    // outside the repository protocol.
    const inverseConcurrency = await writeBehindUncommittedDeletion(pool, wrongStatus);
    assert.equal(inverseConcurrency.result.deletionRequestId, wrongStatus.deletionRequestId);
    assert.equal((await deletionStatus(pool, wrongStatus)).status, 'locked');
    evidence.checks.writeAfterUncommittedLockSerialized = {
      observedWait: inverseConcurrency.observedWait,
      writerRejected: inverseConcurrency.writerRejected,
      sqlstate: inverseConcurrency.sqlstate,
      persistedRows: inverseConcurrency.persistedRows
    };

    assert.equal((await deletionStatus(pool, primary)).status, 'not_started');
    await expectDatabaseError(() => beginDeletion(pool, primary, { revision: primary.revision + 1 }), { code: '40001', pattern: /PDL_REVISION_CONFLICT/, label: 'revision mismatch' });
    await expectDatabaseError(() => beginDeletion(pool, primary, { requestId: crypto.randomUUID() }), { code: '42501', pattern: /identity mismatch/i, label: 'request mismatch' });
    assert.equal((await deletionStatus(pool, primary)).status, 'not_started');

    throwIfInterrupted();
    const concurrency = await lockBehindInFlightWrite(pool, primary);
    const lock = concurrency.result;
    assert.equal(lock.locked, true);
    assert.equal(lock.resumed, false);
    assert.equal(Number(lock.lockedRevision), primary.revision);
    assert.equal(lock.deletionRequestId, primary.deletionRequestId);
    const resumedLock = await beginDeletion(pool, primary);
    assert.equal(resumedLock.resumed, true);
    await expectDatabaseError(() => beginDeletion(pool, primary, { requestId: crypto.randomUUID() }), { code: '55000', pattern: /different permanent deletion/i, label: 'locked request mismatch' });
    await expectDatabaseError(() => beginDeletion(pool, primary, { revision: primary.revision + 1 }), { code: '55000', pattern: /different permanent deletion/i, label: 'locked revision mismatch' });
    evidence.checks.writeBeforeLockSerialized = concurrency.observedWait;

    const lockedStatus = await deletionStatus(pool, primary);
    assert.equal(lockedStatus.status, 'locked');
    assert.equal(lockedStatus.deletionRequestId, primary.deletionRequestId);
    assert.equal(Number(lockedStatus.lockedRevision), primary.revision);
    await expectDatabaseError(() => finalizeDeletion(pool, primary, { requestId: crypto.randomUUID() }), { code: '55000', pattern: /lock does not match/i, label: 'finalize request mismatch' });
    await expectDatabaseError(() => finalizeDeletion(pool, primary, { revision: primary.revision + 1 }), { code: '55000', pattern: /lock does not match/i, label: 'finalize revision mismatch' });
    assert.equal((await deletionStatus(pool, primary)).status, 'locked');

    const cases = guardedWriteCases(primary);
    assert.equal(cases.length, GUARDED_TABLES.length * GUARDED_EVENTS.length);
    for (const spec of cases) {
      throwIfInterrupted();
      await assertBlockedWrite(pool, primary, spec);
    }
    evidence.checks.writeAfterLock = {
      rejected: cases.length,
      tables: [...GUARDED_TABLES],
      events: [...GUARDED_EVENTS]
    };
    evidence.checks.callerSetFinalizerRejected = await assertCallerSetFinalizerRejected(pool, primary);
    const moveCases = tenantMoveCases(primary, wrongStatus.companyId);
    assert.equal(moveCases.length, GUARDED_TABLES.length);
    for (const spec of moveCases) {
      throwIfInterrupted();
      await assertTenantMoveBlocked(pool, primary, spec);
    }
    evidence.checks.crossTenantMoveAfterLock = {
      rejected: moveCases.length,
      tables: [...GUARDED_TABLES]
    };

    throwIfInterrupted();
    try {
      await pool.end();
    } finally {
      // Always leave cleanup with a fresh pool, even if closing the first pool
      // reports an error after the underlying connections were terminated.
      pool = createPool(databaseUrl);
    }
    const afterRestart = await deletionStatus(pool, primary);
    assert.equal(afterRestart.status, 'locked');
    assert.equal(afterRestart.deletionRequestId, primary.deletionRequestId);
    evidence.checks.restartRecoveredLock = true;

    throwIfInterrupted();
    const receipt = await finalizeDeletion(pool, primary);
    assert.equal(receipt.deleted, true);
    assert.equal(receipt.deletionRequestId, primary.deletionRequestId);
    assert.equal(Number(receipt.terminalRevision), primary.revision);
    assert.equal(Number(receipt.tombstoneVersion), 1);
    const deletedStatus = await deletionStatus(pool, primary);
    assert.equal(deletedStatus.status, 'deleted');
    assert.equal(deletedStatus.deletionRequestId, primary.deletionRequestId);
    throwIfInterrupted();
    try {
      await pool.end();
    } finally {
      pool = createPool(databaseUrl);
    }
    const deletedAfterRestart = await deletionStatus(pool, primary);
    assert.equal(deletedAfterRestart.status, 'deleted');
    assert.equal(deletedAfterRestart.deletionRequestId, primary.deletionRequestId);
    assert.equal(Number(deletedAfterRestart.terminalRevision), primary.revision);
    evidence.checks.terminalReceiptSurvivedRestart = true;
    throwIfInterrupted();
    const replay = await finalizeDeletion(pool, primary);
    assert.equal(replay.deleted, true);
    assert.equal(replay.resumed, true);
    await expectDatabaseError(() => finalizeDeletion(pool, primary, { requestId: crypto.randomUUID() }), { code: '55000', pattern: /receipt does not match/i, label: 'terminal replay mismatch' });
    await expectDatabaseError(() => finalizeDeletion(pool, primary, { revision: primary.revision + 1 }), { code: '55000', pattern: /receipt does not match/i, label: 'terminal revision replay mismatch' });
    assert.equal((await deletionStatus(pool, primary)).status, 'deleted');
    evidence.checks.finalReceipt = await verifyContentFreeReceipt(pool, primary);
    await expectDatabaseError(
      () => withTenantTransaction(pool, primary.companyId, client => client.query("INSERT INTO public.tenant_revisions(company_id,revision,scalar_data,content_hash) VALUES($1,0,'{}','')", [primary.companyId])),
      { code: '55000', pattern: /PDL_TENANT_DELETED/, label: 'tombstone recreation guard' }
    );
    await expectDatabaseError(
      () => pool.query('UPDATE public.companies SET name=name WHERE id=$1', [primary.companyId]),
      { code: '55000', pattern: /PDL_TENANT_DELETED/, label: 'legacy tombstone guard' }
    );
    evidence.checks.tombstoneBlocksRecreation = ['companies', 'tenant_revisions'];
    throwIfInterrupted();
    evidence.passed = true;
    evidence.state = 'acceptance_passed_cleanup_pending';
  } catch (error) {
    acceptanceError = error;
    evidence.error = safeError(error);
    evidence.state = 'acceptance_failed_cleanup_pending';
  } finally {
    const cleanupErrors = [];
    if (manifestCreated) {
      try {
        const atomicCleanup = await cleanupRecordedSyntheticTenants(pool, evidence, tenants);
        evidence.cleanup = atomicCleanup.cleanup;
        evidence.checks.cleanupProvenance = atomicCleanup.provenance;
        evidence.checks.cleanupScope = atomicCleanup.scope;
      } catch (error) {
        cleanupErrors.push({ companyId: null, error: safeError(error) });
      }
    } else {
      try {
        evidence.cleanup = await verifyCleanup(pool, tenants);
      } catch (error) {
        cleanupErrors.push({ companyId: null, error: safeError(error) });
      }
    }
    await pool.end().catch(() => {});
    if (interruptedSignal && !acceptanceError) {
      const interruptError = new Error(`Acceptance interrupted by ${interruptedSignal}; cleanup completed before exit.`);
      interruptError.code = interruptedSignal;
      acceptanceError = interruptError;
      evidence.error = safeError(interruptError);
      evidence.passed = false;
    }
    evidence.completedAt = new Date().toISOString();
    if (cleanupErrors.length) {
      evidence.passed = false;
      evidence.cleanup = { verified: false, remainingRows: null, errors: cleanupErrors };
      const cleanupFailure = new Error('Synthetic acceptance cleanup failed; destroy the disposable database and retain this evidence.');
      cleanupFailure.details = cleanupErrors;
      acceptanceError = acceptanceError ? new AggregateError([acceptanceError, cleanupFailure], 'Acceptance and cleanup both failed.') : cleanupFailure;
    }
    evidence.state = evidence.cleanup.verified ? (evidence.passed ? 'passed_clean' : 'failed_clean') : 'cleanup_failed';
    if (signalHandlersInstalled) {
      process.removeListener('SIGINT', onSigint);
      process.removeListener('SIGTERM', onSigterm);
      signalHandlersInstalled = false;
    }
    try {
      if (!manifestCreated) {
        writeEvidenceFile(args.evidencePath, evidence, { create: true });
        manifestCreated = true;
        evidence.resultPath = args.evidencePath;
      } else {
        evidence.manifestPath = args.evidencePath;
        evidence.resultPath = resultEvidencePath(args.evidencePath);
        writeEvidenceFile(evidence.resultPath, evidence, { create: true });
      }
    } catch (error) {
      const evidenceFailure = new Error(`Acceptance evidence could not be written: ${error.message}`);
      acceptanceError = acceptanceError ? new AggregateError([acceptanceError, evidenceFailure], 'Acceptance failed and evidence could not be written.') : evidenceFailure;
    }
  }
  if (acceptanceError) throw acceptanceError;
  return evidence;
}

function usage() {
  return `PDL deletion/concurrency database acceptance\n\n` +
    `Read-only server fingerprint:\n  npm run test:deletion-db -- --fingerprint\n\n` +
    `Read-only preflight:\n  npm run test:deletion-db -- --preview\n\n` +
    `Disposable database acceptance:\n  npm run test:deletion-db -- --apply --expected-fingerprint=<sha256> ` +
    `--confirm-disposable="${CONFIRMATION_PHRASE}" --evidence=<absolute-new-json-path>\n\n` +
    `Interrupted-run cleanup:\n  npm run test:deletion-db -- --cleanup-evidence=<absolute-existing-json-path> ` +
    `--manifest-sha256=<independently-retained-sha256> --expected-fingerprint=<sha256> ` +
    `--confirm-disposable="${CONFIRMATION_PHRASE}"\n\n` +
    `Apply and cleanup require PDL_DELETION_ACCEPTANCE_DISPOSABLE=1 plus a nonmatching ` +
    `PDL_PRODUCTION_DATABASE_FINGERPRINT, even through a loopback tunnel. Remote targets also require TLS. ` +
    `DATABASE_URL is read only from the environment.`;
}

async function main(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);
  if (args.mode === 'help') {
    console.log(usage());
    return;
  }
  const databaseUrl = String(env.DATABASE_URL || '').trim();
  if (!databaseUrl) throw new Error('DATABASE_URL is required. It is never accepted on the command line or printed.');
  if (args.mode === 'fingerprint') {
    const pool = createPool(databaseUrl);
    try {
      const identity = await inspectServerIdentity(pool, databaseUrl);
      console.log(JSON.stringify({
        fingerprint: identity.fingerprint,
        identitySource: identity.identitySource,
        database: identity.database,
        serverVersionNum: identity.serverVersionNum
      }, null, 2));
    } finally {
      await pool.end().catch(() => {});
    }
    return;
  }
  if (args.mode === 'preview') {
    const pool = createPool(databaseUrl);
    try {
      const inspected = await inspectDatabase(pool, databaseUrl);
      console.log(JSON.stringify({ mode: 'preview', ...inspected }, null, 2));
    } finally {
      await pool.end().catch(() => {});
    }
    return;
  }
  if (args.mode === 'cleanup') {
    const evidence = await runRecoveryCleanup({ databaseUrl, args, env });
    console.log(JSON.stringify({
      cleanupVerified: evidence.cleanup.verified,
      runId: evidence.runId,
      serverFingerprint: evidence.target.fingerprint,
      manifest: args.cleanupEvidencePath,
      evidence: evidence.resultPath
    }, null, 2));
    return;
  }
  const evidence = await runAcceptance({ databaseUrl, args, env });
  console.log(JSON.stringify({
    passed: evidence.passed,
    runId: evidence.runId,
    serverFingerprint: evidence.target.fingerprint,
    manifest: args.evidencePath,
    manifestSha256: evidence.manifestSha256,
    evidence: evidence.resultPath || args.evidencePath,
    cleanupVerified: evidence.cleanup.verified
  }, null, 2));
}

if (require.main === module) {
  main().catch(error => {
    console.error(safeError(error));
    process.exitCode = 1;
  });
}

module.exports = {
  CONFIRMATION_PHRASE,
  GUARDED_EVENTS,
  GUARDED_TABLES,
  PRIVATE_ACCEPTANCE_TABLES,
  assertManifestHash,
  assertApplySafety,
  assertSyntheticProvenance,
  createPool,
  guardedWriteCases,
  lockBehindInFlightWrite,
  preLockLifecycleCases,
  writeBehindUncommittedDeletion,
  readRecoveryEvidence,
  parseArgs,
  parseDatabaseUrl,
  safeError,
  serverFingerprint,
  syntheticTenant,
  tenantMoveCases,
  usage,
  validateSyntheticProvenanceRows
};
