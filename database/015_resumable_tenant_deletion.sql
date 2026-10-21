BEGIN;

-- Forward-only upgrade for installations that already applied migration 012.
-- The operation row contains identifiers and state only; customer content
-- remains in the locked tenant repository until external cleanup is proven.
CREATE TABLE IF NOT EXISTS private.tenant_deletion_operations (
  company_id uuid PRIMARY KEY REFERENCES public.companies(id) ON DELETE CASCADE,
  deletion_request_id uuid NOT NULL,
  locked_revision bigint NOT NULL CHECK (locked_revision >= 0),
  started_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE private.tenant_deletion_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.tenant_deletion_operations FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE private.tenant_deletion_operations FROM PUBLIC, anon, authenticated, service_role;

-- The deletion finalizer uses a transaction-bound capability row rather than
-- trusting a caller-settable GUC. A direct runtime writer cannot create or
-- read this marker, and PostgreSQL rolls it back automatically if finalization
-- fails or the connection disappears.
CREATE TABLE IF NOT EXISTS private.tenant_deletion_finalizers (
  backend_pid integer NOT NULL,
  transaction_id text NOT NULL,
  company_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (backend_pid, transaction_id, company_id)
);
-- This capability table is protected by the private schema plus an explicit
-- ACL, not RLS. CREATE OR REPLACE preserves the owners of migration-012's
-- SECURITY DEFINER functions; those owners can differ from the role applying
-- migration 015. Disabling RLS lets us grant only the two exact function
-- owners the operations they require without silently depending on who ran
-- this migration. Runtime roles remain fully revoked below.
ALTER TABLE private.tenant_deletion_finalizers DISABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE private.tenant_deletion_finalizers FROM PUBLIC, anon, authenticated, service_role;

-- All writes use the same per-company advisory transaction lock as BEGIN and
-- FINALIZE. This closes the visibility race between checking the operation row
-- and committing a direct normalized/legacy/transactional write.
CREATE OR REPLACE FUNCTION private.guard_tenant_lifecycle_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  target_company_id uuid;
BEGIN
  -- A tenant-owned row may never be reassigned to another tenant. Checking
  -- both OLD and NEW here is essential: consulting NEW.company_id alone would
  -- let an UPDATE move a row out of a tenant after that tenant was locked for
  -- deletion. Keep this check ahead of the finalizer bypass as well; deletion
  -- finalization deletes rows but never changes their tenant key.
  IF TG_OP = 'UPDATE' THEN
    IF TG_TABLE_SCHEMA = 'public' AND TG_TABLE_NAME = 'companies' THEN
      IF OLD.id IS DISTINCT FROM NEW.id THEN
        RAISE EXCEPTION 'PDL_TENANT_ID_IMMUTABLE table=%.% old=% new=%',
          TG_TABLE_SCHEMA,TG_TABLE_NAME,OLD.id,NEW.id USING ERRCODE = '55000';
      END IF;
    ELSIF OLD.company_id IS DISTINCT FROM NEW.company_id THEN
      RAISE EXCEPTION 'PDL_TENANT_ID_IMMUTABLE table=%.% old=% new=%',
        TG_TABLE_SCHEMA,TG_TABLE_NAME,OLD.company_id,NEW.company_id USING ERRCODE = '55000';
    END IF;
  END IF;
  -- Keep the companies expression in its own PL/pgSQL branch. A trigger
  -- record only exposes columns from the table that fired it, so putting
  -- OLD.id and OLD.company_id in one SQL CASE still tries to resolve both
  -- fields and crashes for public.companies before the CASE can choose.
  IF TG_TABLE_SCHEMA = 'public' AND TG_TABLE_NAME = 'companies' THEN
    target_company_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END;
  ELSE
    target_company_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.company_id ELSE NEW.company_id END;
  END IF;
  IF EXISTS (
    SELECT 1
    FROM private.tenant_deletion_finalizers AS finalizer
    WHERE finalizer.backend_pid = pg_backend_pid()
      AND finalizer.transaction_id = pg_current_xact_id()::text
      AND finalizer.company_id = target_company_id
  ) THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(target_company_id::text, 0));
  IF EXISTS (SELECT 1 FROM private.tenant_tombstones WHERE company_id = target_company_id) THEN
    RAISE EXCEPTION 'PDL_TENANT_DELETED company=%', target_company_id USING ERRCODE = '55000';
  END IF;
  IF EXISTS (SELECT 1 FROM private.tenant_deletion_operations WHERE company_id = target_company_id) THEN
    RAISE EXCEPTION 'PDL_TENANT_DELETION_LOCKED company=%', target_company_id USING ERRCODE = '55000';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;
REVOKE ALL ON FUNCTION private.guard_tenant_lifecycle_write() FROM PUBLIC, anon, authenticated, service_role;

DO $$
DECLARE
  guarded_table text;
BEGIN
  -- Migration 012 installed narrower tombstone/finalization guards. Migration
  -- 015 replaces them with one advisory-lock-aware guard for every lifecycle
  -- operation. Remove the old triggers during the forward upgrade: leaving
  -- both generations attached duplicates work and the old generic trigger
  -- cannot safely resolve both id and company_id on public.companies.
  DROP TRIGGER IF EXISTS reject_deleted_tenant_company_write ON public.companies;
  DROP TRIGGER IF EXISTS reject_deleted_tenant_revision_write ON public.tenant_revisions;
  DROP TRIGGER IF EXISTS reject_finalizing_tenant_company_write ON public.companies;
  DROP TRIGGER IF EXISTS reject_finalizing_tenant_revision_write ON public.tenant_revisions;
  DROP TRIGGER IF EXISTS reject_finalizing_tenant_record_write ON public.tenant_records;

  FOREACH guarded_table IN ARRAY ARRAY[
    'companies','tenant_revisions','tenant_records','audit_events','guest_links',
    'changes','photos','reports','workdays','assignments','projects','customers',
    'team_members','subcontractors','memberships'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS reject_finalizing_tenant_write ON public.%I', guarded_table);
    EXECUTE format('DROP TRIGGER IF EXISTS guard_tenant_lifecycle_write ON public.%I', guarded_table);
    EXECUTE format(
      'CREATE TRIGGER guard_tenant_lifecycle_write BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION private.guard_tenant_lifecycle_write()',
      guarded_table
    );
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.begin_tenant_repository_purge(
  p_company_id uuid,
  p_expected_revision bigint,
  p_deletion_request_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  state public.tenant_revisions%ROWTYPE;
  operation private.tenant_deletion_operations%ROWTYPE;
  request_data jsonb;
  request_id uuid;
  hold_ends_at timestamptz;
BEGIN
  IF p_company_id IS NULL OR p_deletion_request_id IS NULL OR p_expected_revision IS NULL OR p_expected_revision < 0 THEN
    RAISE EXCEPTION 'Valid tenant, revision, and deletion request are required' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_company_id::text, 0));
  SELECT * INTO state FROM public.tenant_revisions WHERE company_id = p_company_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Tenant repository does not exist' USING ERRCODE = 'P0002'; END IF;

  SELECT * INTO operation FROM private.tenant_deletion_operations WHERE company_id = p_company_id;
  IF FOUND THEN
    IF operation.deletion_request_id <> p_deletion_request_id OR operation.locked_revision <> p_expected_revision THEN
      RAISE EXCEPTION 'A different permanent deletion is already finalizing' USING ERRCODE = '55000';
    END IF;
    RETURN jsonb_build_object('locked',true,'companyId',p_company_id,'deletionRequestId',operation.deletion_request_id,'lockedRevision',operation.locked_revision,'startedAt',operation.started_at,'resumed',true);
  END IF;
  IF state.revision <> p_expected_revision THEN
    RAISE EXCEPTION 'PDL_REVISION_CONFLICT expected=% actual=%',p_expected_revision,state.revision USING ERRCODE = '40001';
  END IF;
  request_data := state.scalar_data->'company'->'deletionRequest';
  IF jsonb_typeof(request_data) <> 'object' OR request_data->>'status' <> 'Recovery hold' THEN
    RAISE EXCEPTION 'Tenant is not in a durable recovery hold' USING ERRCODE = '55000';
  END IF;
  BEGIN
    request_id := (request_data->>'id')::uuid;
    hold_ends_at := (request_data->>'holdEndsAt')::timestamptz;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'Deletion request evidence is invalid' USING ERRCODE = '22023';
  END;
  IF request_id <> p_deletion_request_id THEN RAISE EXCEPTION 'Deletion request identity mismatch' USING ERRCODE = '42501'; END IF;
  IF hold_ends_at IS NULL OR hold_ends_at > now() THEN RAISE EXCEPTION 'The recovery hold has not elapsed' USING ERRCODE = '55000'; END IF;
  IF COALESCE((request_data->>'legalHold')::boolean,false) THEN RAISE EXCEPTION 'Tenant is under legal hold' USING ERRCODE = '55000'; END IF;

  INSERT INTO private.tenant_deletion_operations(company_id,deletion_request_id,locked_revision,started_at)
  VALUES(p_company_id,p_deletion_request_id,state.revision,now());
  SELECT * INTO operation FROM private.tenant_deletion_operations WHERE company_id = p_company_id;
  RETURN jsonb_build_object('locked',true,'companyId',p_company_id,'deletionRequestId',operation.deletion_request_id,'lockedRevision',operation.locked_revision,'startedAt',operation.started_at,'resumed',false);
END;
$$;
REVOKE ALL ON FUNCTION public.begin_tenant_repository_purge(uuid,bigint,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.begin_tenant_repository_purge(uuid,bigint,uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.tenant_repository_deletion_status(p_company_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  receipt private.tenant_tombstones%ROWTYPE;
  operation private.tenant_deletion_operations%ROWTYPE;
BEGIN
  SELECT * INTO receipt FROM private.tenant_tombstones WHERE company_id = p_company_id;
  IF FOUND THEN RETURN jsonb_build_object('status','deleted','companyId',p_company_id,'deletionRequestId',receipt.deletion_request_id,'terminalRevision',receipt.terminal_revision,'tombstoneVersion',receipt.tombstone_version,'deletedAt',receipt.deleted_at); END IF;
  SELECT * INTO operation FROM private.tenant_deletion_operations WHERE company_id = p_company_id;
  IF FOUND THEN RETURN jsonb_build_object('status','locked','companyId',p_company_id,'deletionRequestId',operation.deletion_request_id,'lockedRevision',operation.locked_revision,'startedAt',operation.started_at); END IF;
  RETURN jsonb_build_object('status','not_started','companyId',p_company_id);
END;
$$;
REVOKE ALL ON FUNCTION public.tenant_repository_deletion_status(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tenant_repository_deletion_status(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.purge_tenant_repository(
  p_company_id uuid,
  p_expected_revision bigint,
  p_deletion_request_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  state public.tenant_revisions%ROWTYPE;
  operation private.tenant_deletion_operations%ROWTYPE;
  receipt private.tenant_tombstones%ROWTYPE;
  request_data jsonb;
  request_id uuid;
  hold_ends_at timestamptz;
  deleted_at timestamptz := now();
  tenant_user_ids uuid[];
BEGIN
  IF p_company_id IS NULL OR p_deletion_request_id IS NULL OR p_expected_revision IS NULL OR p_expected_revision < 0 THEN
    RAISE EXCEPTION 'Valid tenant, revision, and deletion request are required' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_company_id::text, 0));
  SELECT * INTO receipt FROM private.tenant_tombstones WHERE company_id = p_company_id;
  IF FOUND THEN
    IF receipt.deletion_request_id <> p_deletion_request_id OR receipt.terminal_revision <> p_expected_revision THEN
      RAISE EXCEPTION 'Permanent deletion receipt does not match this request' USING ERRCODE = '55000';
    END IF;
    RETURN jsonb_build_object('deleted',true,'companyId',p_company_id,'deletionRequestId',receipt.deletion_request_id,'deletedAt',receipt.deleted_at,'tombstoneVersion',receipt.tombstone_version,'terminalRevision',receipt.terminal_revision,'resumed',true);
  END IF;
  SELECT * INTO operation FROM private.tenant_deletion_operations WHERE company_id = p_company_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Permanent deletion must be locked before object cleanup' USING ERRCODE = '55000'; END IF;
  IF operation.deletion_request_id <> p_deletion_request_id OR operation.locked_revision <> p_expected_revision THEN
    RAISE EXCEPTION 'Permanent deletion lock does not match this request' USING ERRCODE = '55000';
  END IF;
  SELECT * INTO state FROM public.tenant_revisions WHERE company_id = p_company_id FOR UPDATE;
  IF NOT FOUND OR state.revision <> operation.locked_revision THEN
    RAISE EXCEPTION 'Locked tenant revision changed unexpectedly' USING ERRCODE = '55000';
  END IF;
  request_data := state.scalar_data->'company'->'deletionRequest';
  IF jsonb_typeof(request_data) <> 'object' OR request_data->>'status' <> 'Recovery hold' THEN RAISE EXCEPTION 'Tenant is not in a recovery hold' USING ERRCODE = '55000'; END IF;
  BEGIN request_id := (request_data->>'id')::uuid; hold_ends_at := (request_data->>'holdEndsAt')::timestamptz;
  EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'Deletion request evidence is invalid' USING ERRCODE = '22023'; END;
  IF request_id <> operation.deletion_request_id THEN RAISE EXCEPTION 'Deletion request identity mismatch' USING ERRCODE = '42501'; END IF;
  IF hold_ends_at IS NULL OR hold_ends_at > deleted_at THEN RAISE EXCEPTION 'The recovery hold has not elapsed' USING ERRCODE = '55000'; END IF;
  IF COALESCE((request_data->>'legalHold')::boolean,false) THEN RAISE EXCEPTION 'Tenant is under legal hold' USING ERRCODE = '55000'; END IF;

  -- The private row is a transaction-bound capability checked by migration
  -- 015's lifecycle trigger. The GUC remains only for the older migration-012
  -- trigger during a rolling forward upgrade; 015 never trusts it by itself.
  INSERT INTO private.tenant_deletion_finalizers(backend_pid,transaction_id,company_id)
  VALUES(pg_backend_pid(),pg_current_xact_id()::text,p_company_id)
  ON CONFLICT DO NOTHING;
  PERFORM set_config('pdl.tenant_deletion_finalize',p_company_id::text,true);
  DELETE FROM private.tenant_active_user_emails WHERE company_id=p_company_id;
  DELETE FROM private.tenant_email_conflicts WHERE retained_company_id=p_company_id OR conflicted_company_id=p_company_id OR authorized_company_id=p_company_id;
  DELETE FROM private.tenant_directory WHERE company_id=p_company_id;
  DELETE FROM private.tenant_public_link_tokens WHERE company_id=p_company_id;
  DELETE FROM public.tenant_records WHERE company_id=p_company_id;
  DELETE FROM public.tenant_revisions WHERE company_id=p_company_id;
  SELECT array_agg(user_id) INTO tenant_user_ids FROM public.memberships WHERE company_id=p_company_id;
  DELETE FROM public.audit_events WHERE company_id=p_company_id;
  DELETE FROM public.guest_links WHERE company_id=p_company_id;
  DELETE FROM public.changes WHERE company_id=p_company_id;
  DELETE FROM public.photos WHERE company_id=p_company_id;
  DELETE FROM public.reports WHERE company_id=p_company_id;
  DELETE FROM public.workdays WHERE company_id=p_company_id;
  DELETE FROM public.assignments WHERE company_id=p_company_id;
  DELETE FROM public.projects WHERE company_id=p_company_id;
  DELETE FROM public.customers WHERE company_id=p_company_id;
  DELETE FROM public.team_members WHERE company_id=p_company_id;
  DELETE FROM public.subcontractors WHERE company_id=p_company_id;
  DELETE FROM public.memberships WHERE company_id=p_company_id;
  DELETE FROM public.users AS app_user WHERE app_user.id=ANY(COALESCE(tenant_user_ids,ARRAY[]::uuid[])) AND NOT EXISTS(SELECT 1 FROM public.memberships AS remaining WHERE remaining.user_id=app_user.id);
  DELETE FROM private.tenant_deletion_operations WHERE company_id=p_company_id;
  UPDATE public.companies SET slug='deleted-'||p_company_id::text,name='Deleted tenant',data=jsonb_build_object('company',jsonb_build_object('id',p_company_id::text,'deletedAt',deleted_at,'deletionRequestId',p_deletion_request_id)) WHERE id=p_company_id;
  INSERT INTO private.tenant_tombstones(company_id,tombstone_version,terminal_revision,deletion_request_id,deleted_at)
  VALUES(p_company_id,1,state.revision,p_deletion_request_id,deleted_at);
  DELETE FROM private.tenant_deletion_finalizers
  WHERE backend_pid=pg_backend_pid()
    AND transaction_id=pg_current_xact_id()::text
    AND company_id=p_company_id;
  RETURN jsonb_build_object('deleted',true,'companyId',p_company_id,'deletionRequestId',p_deletion_request_id,'deletedAt',deleted_at,'tombstoneVersion',1,'terminalRevision',state.revision);
END;
$$;
REVOKE ALL ON FUNCTION public.purge_tenant_repository(uuid,bigint,uuid) FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA public TO service_role;
GRANT EXECUTE ON FUNCTION public.purge_tenant_repository(uuid,bigint,uuid) TO service_role;

-- CREATE OR REPLACE above intentionally preserves existing function owners.
-- Bind the private capability ACL to those exact trusted owners so a later
-- migration role cannot accidentally make deletion fail at runtime. The
-- owners must already be privileged because all other deletion state tables
-- use FORCE ROW LEVEL SECURITY.
DO $$
DECLARE
  finalizer_owner name;
  guard_owner name;
  purge_owner name;
  finalizer_owner_trusted boolean;
  guard_owner_trusted boolean;
  purge_owner_trusted boolean;
  guard_private_usage boolean;
  purge_private_usage boolean;
  unauthorized_role record;
  deletion_function record;
  function_grantee record;
BEGIN
  SELECT role.rolname, role.rolsuper OR role.rolbypassrls
    INTO finalizer_owner, finalizer_owner_trusted
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid=relation.relnamespace
  JOIN pg_catalog.pg_roles AS role ON role.oid=relation.relowner
  WHERE namespace.nspname='private'
    AND relation.relname='tenant_deletion_finalizers';

  SELECT role.rolname, role.rolsuper OR role.rolbypassrls,
         pg_catalog.has_schema_privilege(role.oid,'private','USAGE')
    INTO guard_owner, guard_owner_trusted, guard_private_usage
  FROM pg_catalog.pg_proc AS proc
  JOIN pg_catalog.pg_roles AS role ON role.oid=proc.proowner
  WHERE proc.oid='private.guard_tenant_lifecycle_write()'::regprocedure;

  SELECT role.rolname, role.rolsuper OR role.rolbypassrls,
         pg_catalog.has_schema_privilege(role.oid,'private','USAGE')
    INTO purge_owner, purge_owner_trusted, purge_private_usage
  FROM pg_catalog.pg_proc AS proc
  JOIN pg_catalog.pg_roles AS role ON role.oid=proc.proowner
  WHERE proc.oid='public.purge_tenant_repository(uuid,bigint,uuid)'::regprocedure;

  IF finalizer_owner IS NULL OR guard_owner IS NULL OR purge_owner IS NULL OR
     NOT COALESCE(finalizer_owner_trusted,false) OR
     NOT COALESCE(guard_owner_trusted,false) OR
     NOT COALESCE(purge_owner_trusted,false) OR
     NOT COALESCE(guard_private_usage,false) OR
     NOT COALESCE(purge_private_usage,false) THEN
    RAISE EXCEPTION 'Deletion guard and purge functions must be owned by a superuser or BYPASSRLS migration role with private schema usage';
  END IF;
  IF finalizer_owner IN ('anon','authenticated','service_role') OR
     guard_owner IN ('anon','authenticated','service_role') OR
     purge_owner IN ('anon','authenticated','service_role') THEN
    RAISE EXCEPTION 'Runtime roles may not own the finalizer table or deletion functions';
  END IF;

  -- Upgrade an already-used database safely: remove every explicit table ACL
  -- left by an older migration or operator, except for the exact table and
  -- function owners reviewed above. This closes the less-obvious case where a
  -- custom login can inherit a stale grant through another role.
  FOR unauthorized_role IN
    SELECT DISTINCT grantee_role.rolname
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid=relation.relnamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(relation.relacl,pg_catalog.acldefault('r',relation.relowner))
    ) AS acl
    JOIN pg_catalog.pg_roles AS grantee_role ON grantee_role.oid=acl.grantee
    WHERE namespace.nspname='private'
      AND relation.relname='tenant_deletion_finalizers'
      AND acl.privilege_type IN ('SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER')
      AND grantee_role.rolname NOT IN (finalizer_owner,guard_owner,purge_owner)
  LOOP
    EXECUTE format(
      'REVOKE ALL PRIVILEGES ON TABLE private.tenant_deletion_finalizers FROM %I',
      unauthorized_role.rolname
    );
  END LOOP;
  REVOKE ALL ON TABLE private.tenant_deletion_finalizers FROM PUBLIC;

  EXECUTE format(
    'GRANT SELECT ON TABLE private.tenant_deletion_finalizers TO %I',
    guard_owner
  );
  EXECUTE format(
    'GRANT SELECT ON TABLE private.tenant_tombstones, private.tenant_deletion_operations TO %I',
    guard_owner
  );
  EXECUTE format(
    'GRANT SELECT, INSERT, DELETE ON TABLE private.tenant_deletion_finalizers TO %I',
    purge_owner
  );

  -- CREATE OR REPLACE preserves a function's old ACL. Normalize every
  -- deletion entry point (and the trigger function) so a stale custom grant
  -- or service_role WITH GRANT OPTION cannot survive this upgrade.
  FOR deletion_function IN
    WITH required(signature,service_execute) AS (VALUES
      ('private.guard_tenant_lifecycle_write()',false),
      ('public.begin_tenant_repository_purge(uuid,bigint,uuid)',true),
      ('public.tenant_repository_deletion_status(uuid)',true),
      ('public.purge_tenant_repository(uuid,bigint,uuid)',true)
    )
    SELECT proc.oid,proc.proowner,owner_role.rolname AS owner_name,
           owner_role.rolsuper OR owner_role.rolbypassrls AS owner_trusted,
           required.service_execute
    FROM required
    JOIN pg_catalog.pg_proc AS proc ON proc.oid=required.signature::regprocedure
    JOIN pg_catalog.pg_roles AS owner_role ON owner_role.oid=proc.proowner
  LOOP
    IF NOT deletion_function.owner_trusted OR
       deletion_function.owner_name IN ('anon','authenticated','service_role') THEN
      RAISE EXCEPTION 'Deletion functions must be owned by trusted non-runtime migration roles';
    END IF;
    FOR function_grantee IN
      SELECT DISTINCT grantee_role.rolname
      FROM pg_catalog.pg_proc AS proc
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(proc.proacl,pg_catalog.acldefault('f',proc.proowner))
      ) AS acl
      JOIN pg_catalog.pg_roles AS grantee_role ON grantee_role.oid=acl.grantee
      WHERE proc.oid=deletion_function.oid
        AND acl.privilege_type='EXECUTE'
        AND grantee_role.oid<>deletion_function.proowner
        AND NOT (deletion_function.service_execute AND grantee_role.rolname='service_role')
    LOOP
      EXECUTE format(
        'REVOKE ALL PRIVILEGES ON FUNCTION %s FROM %I',
        deletion_function.oid::regprocedure,
        function_grantee.rolname
      );
    END LOOP;
    EXECUTE format(
      'REVOKE ALL PRIVILEGES ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role',
      deletion_function.oid::regprocedure
    );
    IF deletion_function.service_execute THEN
      EXECUTE format(
        'GRANT EXECUTE ON FUNCTION %s TO service_role',
        deletion_function.oid::regprocedure
      );
    END IF;
    IF deletion_function.service_execute AND NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc AS proc
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(proc.proacl,pg_catalog.acldefault('f',proc.proowner))
      ) AS acl
      WHERE proc.oid=deletion_function.oid
        AND acl.grantee=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname='service_role')
        AND acl.privilege_type='EXECUTE'
        AND NOT acl.is_grantable
    ) THEN
      RAISE EXCEPTION 'service_role lacks direct non-grantable deletion RPC execution';
    END IF;
    IF EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc AS proc
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(proc.proacl,pg_catalog.acldefault('f',proc.proowner))
      ) AS acl
      WHERE proc.oid=deletion_function.oid
        AND acl.privilege_type='EXECUTE'
        AND (
          acl.is_grantable AND acl.grantee=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname='service_role') OR
          acl.grantee<>proc.proowner AND acl.grantee<>0 AND NOT (
            deletion_function.service_execute AND
            acl.grantee=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname='service_role')
          )
        )
    ) OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_roles AS candidate
      WHERE candidate.oid<>deletion_function.proowner
        AND NOT (
          deletion_function.service_execute AND
          candidate.rolname='service_role'
        )
        AND (
          candidate.rolname IN ('anon','authenticated','service_role') OR
          NOT (candidate.rolsuper OR candidate.rolbypassrls)
        )
        AND pg_catalog.has_function_privilege(candidate.oid,deletion_function.oid,'EXECUTE')
    ) THEN
      RAISE EXCEPTION 'An untrusted or runtime role retains deletion function execution';
    END IF;
  END LOOP;

  -- Effective privilege audit catches membership/inheritance, not only ACL
  -- rows. Superuser and trusted BYPASSRLS administration roles are inherently
  -- privileged in a managed Postgres installation; runtime roles are never
  -- exempt, even when a provider marks one BYPASSRLS. PostgreSQL's exact
  -- predefined NOLOGIN pg_read_all_data/pg_write_all_data principals are the
  -- sole direct-role exception because their system-wide privileges cannot be
  -- revoked. Any login or custom role inheriting either remains its own
  -- candidate here and is rejected through has_table_privilege below.
  IF EXISTS (
    WITH allowed(role_name) AS (
      VALUES (finalizer_owner),(guard_owner),(purge_owner)
    )
    SELECT 1
    FROM pg_catalog.pg_roles AS candidate
    WHERE candidate.rolname NOT IN (SELECT role_name FROM allowed)
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
        pg_catalog.has_table_privilege(candidate.oid,'private.tenant_deletion_finalizers'::regclass,'SELECT') OR
        pg_catalog.has_table_privilege(candidate.oid,'private.tenant_deletion_finalizers'::regclass,'INSERT') OR
        pg_catalog.has_table_privilege(candidate.oid,'private.tenant_deletion_finalizers'::regclass,'UPDATE') OR
        pg_catalog.has_table_privilege(candidate.oid,'private.tenant_deletion_finalizers'::regclass,'DELETE')
      )
  ) THEN
    RAISE EXCEPTION 'An untrusted or runtime role retains effective access to the deletion finalizer capability';
  END IF;
END;
$$;

NOTIFY pgrst, 'reload schema';
COMMIT;

-- Deployment evidence: this must return 45 enabled event rows (15 tables ×
-- INSERT/UPDATE/DELETE). A disabled or replica-only trigger is not accepted.
SELECT
  event.event_object_table,
  event.event_manipulation,
  trigger.tgenabled
FROM information_schema.triggers AS event
JOIN pg_catalog.pg_namespace AS namespace
  ON namespace.nspname=event.event_object_schema
JOIN pg_catalog.pg_class AS relation
  ON relation.relnamespace=namespace.oid
 AND relation.relname=event.event_object_table
JOIN pg_catalog.pg_trigger AS trigger
  ON trigger.tgrelid=relation.oid
 AND trigger.tgname=event.trigger_name
 AND NOT trigger.tgisinternal
WHERE event.event_object_schema='public'
  AND event.trigger_name='guard_tenant_lifecycle_write'
ORDER BY event.event_object_table,event.event_manipulation;

-- Deployment evidence: this must return zero rows. Runtime roles cannot mint
-- the transaction-bound capability checked by the lifecycle guard.
SELECT grantee,privilege_type
FROM information_schema.role_table_grants
WHERE table_schema='private'
  AND table_name='tenant_deletion_finalizers'
  AND grantee IN ('PUBLIC','anon','authenticated','service_role');

-- Deployment evidence: this must also return zero rows. Unlike
-- information_schema.role_table_grants, this checks effective privileges
-- inherited through role membership. The allowlist contains the table owner
-- and the two trusted SECURITY DEFINER function owners. The exact predefined
-- NOLOGIN system principals pg_read_all_data and pg_write_all_data are ignored
-- as direct candidates only; a login or custom member inheriting either is
-- still checked independently and must appear as a violation.
WITH finalizer AS (
  SELECT relation.oid,relation.relowner
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid=relation.relnamespace
  WHERE namespace.nspname='private'
    AND relation.relname='tenant_deletion_finalizers'
), allowed(role_oid) AS (
  SELECT relowner FROM finalizer
  UNION
  SELECT proc.proowner FROM pg_catalog.pg_proc AS proc
  WHERE proc.oid IN (
    'private.guard_tenant_lifecycle_write()'::regprocedure,
    'public.purge_tenant_repository(uuid,bigint,uuid)'::regprocedure
  )
)
SELECT candidate.rolname
FROM pg_catalog.pg_roles AS candidate
CROSS JOIN finalizer
WHERE candidate.oid NOT IN (SELECT role_oid FROM allowed)
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
    pg_catalog.has_table_privilege(candidate.oid,finalizer.oid,'DELETE')
  )
ORDER BY candidate.rolname;

-- Deployment evidence: browser roles must not appear. service_role should
-- have EXECUTE on exactly the three reviewed deletion RPCs.
SELECT routine_name,grantee,privilege_type
FROM information_schema.role_routine_grants
WHERE specific_schema='public'
  AND routine_name IN (
    'begin_tenant_repository_purge',
    'tenant_repository_deletion_status',
    'purge_tenant_repository'
  )
  AND grantee IN ('PUBLIC','anon','authenticated','service_role')
ORDER BY routine_name,grantee;

-- Deployment evidence: this must return zero rows. It audits preserved
-- explicit ACLs, inherited effective EXECUTE, and grant options. Owners are
-- implicit; service_role receives direct non-grantable EXECUTE only on the
-- three reviewed public RPCs.
WITH required(signature,service_execute) AS (VALUES
  ('private.guard_tenant_lifecycle_write()',false),
  ('public.begin_tenant_repository_purge(uuid,bigint,uuid)',true),
  ('public.tenant_repository_deletion_status(uuid)',true),
  ('public.purge_tenant_repository(uuid,bigint,uuid)',true)
), functions AS (
  SELECT required.signature,required.service_execute,proc.oid,proc.proowner,proc.proacl,
         (SELECT oid FROM pg_catalog.pg_roles WHERE rolname='service_role') AS service_oid
  FROM required
  JOIN pg_catalog.pg_proc AS proc ON proc.oid=required.signature::regprocedure
), violations AS (
  SELECT functions.signature,COALESCE(grantee_role.rolname,'PUBLIC') AS role_name,
         'unexpected explicit EXECUTE' AS violation
  FROM functions
  CROSS JOIN LATERAL pg_catalog.aclexplode(
    COALESCE(functions.proacl,pg_catalog.acldefault('f',functions.proowner))
  ) AS acl
  LEFT JOIN pg_catalog.pg_roles AS grantee_role ON grantee_role.oid=acl.grantee
  WHERE acl.privilege_type='EXECUTE'
    AND acl.grantee<>functions.proowner
    AND NOT (functions.service_execute AND acl.grantee=functions.service_oid)
  UNION ALL
  SELECT functions.signature,'service_role','grantable EXECUTE'
  FROM functions
  CROSS JOIN LATERAL pg_catalog.aclexplode(
    COALESCE(functions.proacl,pg_catalog.acldefault('f',functions.proowner))
  ) AS acl
  WHERE acl.grantee=functions.service_oid
    AND acl.privilege_type='EXECUTE'
    AND acl.is_grantable
  UNION ALL
  SELECT functions.signature,'service_role','missing direct EXECUTE'
  FROM functions
  WHERE functions.service_execute
    AND NOT EXISTS (
      SELECT 1
      FROM pg_catalog.aclexplode(
        COALESCE(functions.proacl,pg_catalog.acldefault('f',functions.proowner))
      ) AS acl
      WHERE acl.grantee=functions.service_oid
        AND acl.privilege_type='EXECUTE'
    )
  UNION ALL
  SELECT functions.signature,candidate.rolname,'unexpected effective EXECUTE'
  FROM functions
  JOIN pg_catalog.pg_roles AS candidate ON true
  WHERE candidate.oid<>functions.proowner
    AND NOT (functions.service_execute AND candidate.oid=functions.service_oid)
    AND (
      candidate.rolname IN ('anon','authenticated','service_role') OR
      NOT (candidate.rolsuper OR candidate.rolbypassrls)
    )
    AND pg_catalog.has_function_privilege(candidate.oid,functions.oid,'EXECUTE')
)
SELECT signature,role_name,violation
FROM violations
ORDER BY signature,role_name,violation;

-- Deployment evidence: service_role must be able to resolve the reviewed
-- public RPCs through PostgREST, not merely hold function EXECUTE.
SELECT pg_catalog.has_schema_privilege('service_role','public','USAGE')
  AS service_role_public_schema_usage;

-- Deployment evidence: every SECURITY DEFINER owner involved in deletion must
-- be a trusted migration role. The guard owner needs SELECT on the capability
-- table and the purge owner needs SELECT/INSERT/DELETE; every row below must
-- report owner_trusted=true and the applicable *_allowed columns=true.
WITH required(signature) AS (VALUES
  ('private.guard_tenant_lifecycle_write()'),
  ('public.begin_tenant_repository_purge(uuid,bigint,uuid)'),
  ('public.tenant_repository_deletion_status(uuid)'),
  ('public.purge_tenant_repository(uuid,bigint,uuid)')
)
SELECT
  required.signature,
  owner_role.rolname AS owner_name,
  owner_role.rolsuper OR owner_role.rolbypassrls AS owner_trusted,
  pg_catalog.has_schema_privilege(proc.proowner,'private','USAGE') AS private_schema_usage,
  CASE WHEN required.signature IN (
    'private.guard_tenant_lifecycle_write()',
    'public.purge_tenant_repository(uuid,bigint,uuid)'
  ) THEN pg_catalog.has_table_privilege(
    proc.proowner,
    'private.tenant_deletion_finalizers'::regclass,
    'SELECT'
  ) ELSE true END AS select_allowed,
  CASE WHEN required.signature='private.guard_tenant_lifecycle_write()'
    THEN pg_catalog.has_table_privilege(
      proc.proowner,
      'private.tenant_tombstones'::regclass,
      'SELECT'
    ) ELSE true END AS tombstone_select_allowed,
  CASE WHEN required.signature='private.guard_tenant_lifecycle_write()'
    THEN pg_catalog.has_table_privilege(
      proc.proowner,
      'private.tenant_deletion_operations'::regclass,
      'SELECT'
    ) ELSE true END AS operation_select_allowed,
  CASE WHEN required.signature='public.purge_tenant_repository(uuid,bigint,uuid)'
    THEN pg_catalog.has_table_privilege(
      proc.proowner,
      'private.tenant_deletion_finalizers'::regclass,
      'INSERT'
    ) ELSE true END AS insert_allowed,
  CASE WHEN required.signature='public.purge_tenant_repository(uuid,bigint,uuid)'
    THEN pg_catalog.has_table_privilege(
      proc.proowner,
      'private.tenant_deletion_finalizers'::regclass,
      'DELETE'
    ) ELSE true END AS delete_allowed
FROM required
JOIN pg_catalog.pg_proc AS proc
  ON proc.oid=required.signature::regprocedure
JOIN pg_catalog.pg_roles AS owner_role
  ON owner_role.oid=proc.proowner
ORDER BY required.signature;
